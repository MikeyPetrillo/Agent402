// SQL execution-certificate firewall — the deterministic core.
//
// Built for the 2026-07-28 demand cluster: "agents that write mutating SQL to
// production postgres need an execution certificate firewall: ed25519 pass
// before execute". The shape of the need: an agent (or its DB proxy) submits
// the EXACT statement it is about to run, gets a policy verdict, and — when it
// passes — a signed certificate binding that verdict to the statement's hash.
// The execution layer then refuses any statement without a valid certificate,
// so the check cannot be skipped by a confused or compromised agent.
//
// HONEST SCOPE (stated in the tool description too, and the reason this is
// safe to ship deterministically): this is a LEXICAL guard, not a SQL parser
// and not a semantic authorizer. It scrubs literals/comments, splits
// statements, classifies the verb, and matches a fixed catalogue of dangerous
// shapes. It cannot know that `WHERE tenant_id = 7` is the wrong tenant, and a
// determined author can express a dangerous statement in a form it does not
// recognise. It catches the accident classes that actually destroy production
// data (unbounded UPDATE/DELETE, DROP/TRUNCATE, statement stacking, trigger
// and FK bypass, COPY ... FROM PROGRAM) and it never claims more.
//
// No LLM, no network, no clock-dependent logic except the certificate's
// issued-at/expiry. Covered by scripts/test-sql-guard.js.
import { createHash, sign as edSign, verify as edVerify, createPrivateKey, createPublicKey } from "node:crypto";

// ---------------------------------------------------------------------------
// Scrubbing: literals and comments become same-length filler (a SPACE - which
// is also exactly what postgres does with a comment, so comment-splitting like
// `DR/**/OP TABLE` cannot evade this guard) so every offset
// stays meaningful and no keyword INSIDE a string is ever matched. A guard
// that flags `INSERT INTO log (msg) VALUES ('drop table users')` as a DROP is
// worse than useless — it trains agents to ignore it.
// ---------------------------------------------------------------------------
const FILL = " ";

export function scrubSql(sql) {
  const src = String(sql);
  let out = "";
  let i = 0;
  let hadComment = false;
  let unterminated = null;
  while (i < src.length) {
    const c = src[i];
    const two = src.slice(i, i + 2);
    // line comment
    if (two === "--") {
      hadComment = true;
      const nl = src.indexOf("\n", i);
      const end = nl === -1 ? src.length : nl;
      out += FILL.repeat(end - i);
      i = end;
      continue;
    }
    // block comment (postgres nests them)
    if (two === "/*") {
      hadComment = true;
      let depth = 1;
      let j = i + 2;
      while (j < src.length && depth > 0) {
        if (src.slice(j, j + 2) === "/*") { depth++; j += 2; continue; }
        if (src.slice(j, j + 2) === "*/") { depth--; j += 2; continue; }
        j++;
      }
      if (depth > 0) unterminated = unterminated || "block comment";
      out += FILL.repeat(j - i);
      i = j;
      continue;
    }
    // dollar-quoted string: $tag$ ... $tag$
    if (c === "$") {
      const m = /^\$[A-Za-z_][A-Za-z0-9_]*\$|^\$\$/.exec(src.slice(i));
      if (m) {
        const tag = m[0];
        const close = src.indexOf(tag, i + tag.length);
        const end = close === -1 ? src.length : close + tag.length;
        if (close === -1) unterminated = unterminated || "dollar-quoted string";
        out += FILL.repeat(end - i);
        i = end;
        continue;
      }
    }
    // single/double-quoted (double = identifier in postgres, still scrubbed:
    // a quoted identifier cannot carry a keyword we need to see)
    if (c === "'" || c === '"') {
      let j = i + 1;
      let closed = false;
      const eLiteral = c === "'" && /[eE]/.test(src[i - 1] || "") && !/[A-Za-z0-9_$]/.test(src[i - 2] || "");
      while (j < src.length) {
        if (src[j] === c) {
          if (src[j + 1] === c) { j += 2; continue; } // escaped by doubling
          closed = true;
          j++;
          break;
        }
        // A backslash escapes only inside an E'...' literal (standard_conforming_strings
        // is on by default since PostgreSQL 9.1). Treating it as an escape everywhere let
        // SELECT '\'; DELETE FROM users; --' certify as one read statement (2026-08-28).
        if (src[j] === "\\" && c === "'" && eLiteral) { j += 2; continue; }
        j++;
      }
      if (!closed) unterminated = unterminated || `${c === "'" ? "string" : "quoted identifier"} literal`;
      out += FILL.repeat(j - i);
      i = j;
      continue;
    }
    out += c;
    i++;
  }
  return { scrubbed: out, hadComment, unterminated };
}

/** Split on top-level semicolons using the scrubbed text, returning slices of
 *  the ORIGINAL so reported statements read as the author wrote them. */
export function splitStatements(sql, scrubbed) {
  const parts = [];
  let start = 0;
  for (let i = 0; i < scrubbed.length; i++) {
    if (scrubbed[i] === ";") {
      parts.push({ raw: sql.slice(start, i), scrub: scrubbed.slice(start, i) });
      start = i + 1;
    }
  }
  parts.push({ raw: sql.slice(start), scrub: scrubbed.slice(start) });
  return parts.filter((p) => p.scrub.trim().length > 0);
}

const norm = (s) => s.replace(/\s+/g, " ").trim();
const words = (s) => norm(s).toUpperCase();

/** Leading verb + whether the statement writes. */
export function classifyStatement(scrub) {
  const u = words(scrub);
  const first = (/^[A-Z]+/.exec(u) || [""])[0];
  const DDL = new Set(["CREATE", "ALTER", "DROP", "TRUNCATE", "COMMENT", "RENAME"]);
  const WRITE = new Set(["INSERT", "UPDATE", "DELETE", "MERGE", "UPSERT", "REPLACE"]);
  const kind =
    WRITE.has(first) ? "dml-write"
    : DDL.has(first) ? "ddl"
    : first === "SELECT" || first === "WITH" || first === "SHOW" || first === "EXPLAIN" ? "read"
    : first === "GRANT" || first === "REVOKE" ? "privilege"
    : first === "COPY" ? "copy"
    : first === "SET" ? "session"
    : first === "" ? "empty" : "other";
  // WITH ... UPDATE/DELETE/INSERT is a write wearing a read's hat.
  const cteWrite = first === "WITH" && /\b(INSERT\s+INTO|UPDATE\s|DELETE\s+FROM|MERGE\s+INTO)\b/.test(u);
  // Writes wearing other hats (review 2026-08-28): EXPLAIN ANALYZE executes the
  // statement; SELECT ... INTO creates a table; DO / CALL run arbitrary code.
  const explainWrite = first === "EXPLAIN" && /\bANALYZE\b/.test(u) && /\b(INSERT|UPDATE|DELETE|MERGE|TRUNCATE|DROP|ALTER|CREATE)\b/.test(u);
  const selectInto = first === "SELECT" && /\bINTO\s+(?:TEMP(?:ORARY)?\s+|UNLOGGED\s+)?[A-Z_"]/.test(u);
  const procedural = first === "DO" || first === "CALL";
  return {
    verb: first || null,
    kind: cteWrite ? "dml-write" : kind,
    mutating: cteWrite || explainWrite || selectInto || procedural || kind === "dml-write" || kind === "ddl" || kind === "privilege" || kind === "copy",
  };
}

// Every risk this guard knows how to see. `severity` is the DEFAULT; a policy
// can downgrade an id to a warning via `allow`. Keeping the catalogue explicit
// (rather than inline regexes) is what makes the "we never claim more than we
// check" promise auditable — this list IS the coverage.
export const RISK_CATALOGUE = {
  "multi-statement": { severity: "block", why: "more than one statement in a single submission - the classic injection shape, and only the first is ever reviewed by eye" },
  "unbounded-update": { severity: "block", why: "UPDATE with no WHERE clause rewrites every row in the table" },
  "unbounded-delete": { severity: "block", why: "DELETE with no WHERE clause empties the table" },
  "tautological-where": { severity: "block", why: "the WHERE clause is always true, so the statement is unbounded in effect" },
  "drop-object": { severity: "block", why: "DROP destroys a table, schema or database outright" },
  "truncate": { severity: "block", why: "TRUNCATE empties a table and usually cannot be rolled back into an undo log you can read" },
  "copy-from-program": { severity: "block", why: "COPY ... FROM PROGRAM executes a shell command on the database host" },
  "privilege-change": { severity: "block", why: "grants, revokes or role changes alter who can do this again later" },
  "replication-role-bypass": { severity: "block", why: "SET session_replication_role disables triggers and foreign keys for the session" },
  "disable-trigger-or-constraint": { severity: "block", why: "disabling triggers or constraints removes the integrity checks the schema relies on" },
  "system-catalog-write": { severity: "block", why: "writing to pg_catalog / information_schema corrupts the database's own metadata" },
  "drop-column": { severity: "block", why: "DROP COLUMN destroys the data in that column" },
  "ddl": { severity: "warn", why: "schema change - review that a migration path exists" },
  "unterminated-literal": { severity: "block", why: "an unterminated string or comment means the statement does not parse as submitted" },
};

const RE = {
  where: /\bWHERE\b/,
  tautology: /\bWHERE\b[\s(]*(1\s*=\s*1|TRUE\b|'?1'?\s*=\s*'?1'?)|\bOR\s+1\s*=\s*1\b|\bOR\s+TRUE\b/,
  dropObject: /\bDROP\s+(TABLE|DATABASE|SCHEMA|TABLESPACE|VIEW|MATERIALIZED\s+VIEW|INDEX|SEQUENCE|TYPE|FUNCTION|TRIGGER)\b/,
  dropColumn: /\bDROP\s+(COLUMN\b|CONSTRAINT\b)/,
  truncate: /^\s*TRUNCATE\b/,
  copyProgram: /\bCOPY\b[\s\S]*\bFROM\s+PROGRAM\b|\bCOPY\b[\s\S]*\bTO\s+PROGRAM\b/,
  privilege: /^\s*(GRANT|REVOKE)\b|\b(CREATE|ALTER|DROP)\s+(ROLE|USER|GROUP)\b|\bWITH\s+SUPERUSER\b/,
  replicationRole: /\bSET\b[\s\S]*\bSESSION_REPLICATION_ROLE\b/,
  disableTrigger: /\b(DISABLE|ENABLE\s+REPLICA)\s+TRIGGER\b|\bALTER\s+TABLE\b[\s\S]*\bNOT\s+VALID\b|\bDROP\s+CONSTRAINT\b/,
  systemCatalog: /\b(INSERT\s+INTO|UPDATE|DELETE\s+FROM)\s+"?(PG_CATALOG|INFORMATION_SCHEMA)"?\./,
};

/**
 * Analyze one statement. Returns { statement, verb, kind, mutating, risks[] }.
 * `risks` carry { id, severity, why } straight from RISK_CATALOGUE.
 */
export function analyzeStatement(part) {
  const u = words(part.scrub);
  const cls = classifyStatement(part.scrub);
  const ids = [];
  if (cls.kind === "dml-write") {
    const isUpdate = /^UPDATE\b/.test(u) || /\bUPDATE\s+\S+\s+SET\b/.test(u);
    const isDelete = /^DELETE\b/.test(u) || /\bDELETE\s+FROM\b/.test(u);
    if (!RE.where.test(u)) {
      if (isUpdate) ids.push("unbounded-update");
      else if (isDelete) ids.push("unbounded-delete");
    } else if (RE.tautology.test(u)) {
      ids.push("tautological-where");
    }
  }
  if (RE.tautology.test(u) && !ids.includes("tautological-where") && cls.mutating) ids.push("tautological-where");
  if (RE.dropObject.test(u)) ids.push("drop-object");
  if (RE.dropColumn.test(u)) ids.push("drop-column");
  if (RE.truncate.test(u)) ids.push("truncate");
  if (RE.copyProgram.test(u)) ids.push("copy-from-program");
  if (RE.privilege.test(u)) ids.push("privilege-change");
  if (RE.replicationRole.test(u)) ids.push("replication-role-bypass");
  if (RE.disableTrigger.test(u)) ids.push("disable-trigger-or-constraint");
  if (RE.systemCatalog.test(u)) ids.push("system-catalog-write");
  if (cls.kind === "ddl" && !ids.some((id) => id === "drop-object" || id === "truncate" || id === "drop-column")) ids.push("ddl");
  return {
    statement: norm(part.raw),
    verb: cls.verb,
    kind: cls.kind,
    mutating: cls.mutating,
    riskIds: [...new Set(ids)],
  };
}

/**
 * Full analysis of a submission (one or more statements).
 *
 * @param {string} sql              exactly the text the caller will execute
 * @param {object} [opts]
 * @param {string[]} [opts.allow]   risk ids downgraded from block to warn
 * @param {boolean} [opts.allowMultiStatement]
 * @returns {{ sha256, statementCount, statements, risks, verdict, blocked, policy }}
 */
export function analyzeSql(sql, opts = {}) {
  const text = String(sql);
  const { scrubbed, unterminated } = scrubSql(text);
  const parts = splitStatements(text, scrubbed);
  const allow = new Set((opts.allow || []).map((a) => String(a)));
  const statements = parts.map(analyzeStatement);

  const collected = [];
  const push = (id, statementIndex) => {
    const meta = RISK_CATALOGUE[id];
    if (!meta) return;
    const severity = meta.severity === "block" && allow.has(id) ? "warn" : meta.severity;
    collected.push({ id, severity, why: meta.why, ...(statementIndex == null ? {} : { statement: statementIndex }) });
  };

  if (unterminated) push("unterminated-literal");
  if (parts.length > 1 && !opts.allowMultiStatement) push("multi-statement");
  statements.forEach((s, idx) => s.riskIds.forEach((id) => push(id, idx)));

  const blocked = collected.filter((r) => r.severity === "block");
  const mutating = statements.some((s) => s.mutating);
  const verdict = blocked.length ? "block" : collected.length ? "warn" : "pass";
  return {
    sha256: createHash("sha256").update(text, "utf8").digest("hex"),
    statementCount: statements.length,
    mutating,
    statements,
    risks: collected,
    verdict,
    blocked: blocked.map((r) => r.id),
    policy: { allow: [...allow].sort(), allowMultiStatement: !!opts.allowMultiStatement },
  };
}

// ---------------------------------------------------------------------------
// Certificates. A certificate is a compact `base64url(payload).base64url(sig)`
// pair — deliberately NOT a JWT: there is no alg field to confuse, only
// Ed25519, so an attacker cannot downgrade it to "none". The payload binds the
// statement HASH (never the statement itself: SQL can carry customer data, and
// a certificate travels through logs).
// ---------------------------------------------------------------------------
const b64u = (buf) => Buffer.from(buf).toString("base64url");
const unb64u = (s) => Buffer.from(String(s), "base64url");

export function canonicalPayload(p) {
  // Fixed key order — the signature covers these bytes exactly.
  return JSON.stringify({ v: p.v, sha256: p.sha256, verdict: p.verdict, policy: p.policy, iat: p.iat, exp: p.exp });
}

/** Sign a passing analysis. Returns null when no key is configured — the
 *  caller reports that honestly rather than shipping an unsigned "certificate". */
export function issueCertificate(analysis, { privateKeyPem, ttlSeconds = 300, now = Date.now() }) {
  if (!privateKeyPem) return null;
  const iat = Math.floor(now / 1000);
  const payload = {
    v: 1,
    sha256: analysis.sha256,
    verdict: analysis.verdict,
    policy: createHash("sha256").update(JSON.stringify(analysis.policy)).digest("hex").slice(0, 16),
    iat,
    exp: iat + Math.max(30, Math.min(3600, ttlSeconds)),
  };
  const canonical = canonicalPayload(payload);
  const key = typeof privateKeyPem === "string" ? createPrivateKey(privateKeyPem) : privateKeyPem;
  const sig = edSign(null, Buffer.from(canonical, "utf8"), key);
  return { token: `${b64u(canonical)}.${b64u(sig)}`, payload };
}

/**
 * Verify a certificate against the statement the caller is about to run.
 * Returns { valid, reason, payload } — never throws on a malformed token, so
 * an execution layer gets one uniform answer to "may I run this".
 */
export function verifyCertificate(sql, token, { publicKeyPem, now = Date.now() } = {}) {
  const fail = (reason, payload = null) => ({ valid: false, reason, payload });
  if (!publicKeyPem) return fail("no public key available to verify against");
  const parts = String(token || "").split(".");
  if (parts.length !== 2) return fail("malformed certificate (expected payload.signature)");
  let canonical;
  let payload;
  try {
    canonical = unb64u(parts[0]).toString("utf8");
    payload = JSON.parse(canonical);
  } catch { return fail("malformed certificate payload"); }
  let ok = false;
  try {
    const key = typeof publicKeyPem === "string" ? createPublicKey(publicKeyPem) : publicKeyPem;
    ok = edVerify(null, Buffer.from(canonical, "utf8"), key, unb64u(parts[1]));
  } catch { return fail("signature could not be checked", payload); }
  if (!ok) return fail("signature does not verify", payload);
  if (payload.v !== 1) return fail(`unsupported certificate version ${payload.v}`, payload);
  const nowSec = Math.floor(now / 1000);
  if (typeof payload.exp !== "number" || nowSec > payload.exp) return fail("certificate expired", payload);
  if (typeof payload.iat === "number" && payload.iat > nowSec + 60) return fail("certificate issued in the future", payload);
  if (payload.verdict !== "pass") return fail(`certificate records verdict "${payload.verdict}", not pass`, payload);
  const digest = createHash("sha256").update(String(sql), "utf8").digest("hex");
  if (digest !== payload.sha256) return fail("certificate is for a different statement (hash mismatch)", payload);
  return { valid: true, reason: null, payload };
}

// A committed sample keypair + certificate so the verify tool has a worked
// example that genuinely verifies, forever, on any deployment. THIS KEY IS
// PUBLIC AND SIGNS NOTHING REAL — the sample certificate's expiry is in 2099
// precisely so the example is stable; production certificates live 5 minutes.
export const SAMPLE_PUBLIC_KEY =
  "-----BEGIN PUBLIC KEY-----\nMCowBQYDK2VwAyEA+dgN+1FKr9VoA3fbT4bimUF4W8ORBYKwR6XiZldGxgw=\n-----END PUBLIC KEY-----\n";
export const SAMPLE_SQL = "UPDATE users SET plan = 'pro' WHERE id = 42";
export const SAMPLE_CERTIFICATE =
  "eyJ2IjoxLCJzaGEyNTYiOiI2MzVjZjIwYTdhMzM3NzFjOGJiZjY3OTljOTJlNTdkOTRiNGY0MmFjMTYzMzkyMTg3MTg1Zjc5OWE4OGFjYTAyIiwidmVyZGljdCI6InBhc3MiLCJwb2xpY3kiOiI1MzljNzhjZDhiZTZjMzUwIiwiaWF0IjoxNzg1MDAwMDAwLCJleHAiOjQwNzA5MDg4MDB9.iOLcl81N_N2-b3Tq1YdLCbRkmgQB8fWG9TA0oRQG81CgXtLrvBi4dsk6Oww-FR3mWqtDmLxT0TZLbDxbBo5dBw";
