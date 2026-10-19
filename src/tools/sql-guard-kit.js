// SQL execution-certificate firewall — the two paid tools over the analyzer in
// ./sql-guard.js. Built for the 2026-07-28 wish cluster (an agent asked, twice
// and in its own words, for "an execution certificate firewall for mutating
// production SQL: ed25519 pass before execute").
//
// The pair is deliberate: `sql-guard` is the checkpoint an agent calls before
// it executes, and `sql-cert-verify` is what the thing holding the database
// connection calls before it obeys. Splitting them is the entire security
// value — the executor never has to trust the agent's word that a check
// happened, because the certificate binds a pass verdict to the exact
// statement hash.
//
// Pure CPU, no network, no LLM: proof-of-work eligible like the rest of the
// deterministic catalogue. Covered by scripts/test-sql-guard.js.
import {
  analyzeSql, issueCertificate, verifyCertificate,
  RISK_CATALOGUE, SAMPLE_SQL, SAMPLE_CERTIFICATE, SAMPLE_PUBLIC_KEY,
} from "./sql-guard.js";
import { createPublicKey, createPrivateKey } from "node:crypto";

function bad(message) {
  const err = new Error(message);
  err.statusCode = 400;
  return err;
}

const MAX_SQL = 100_000;

// The deployment's signing identity. Env-gated no-op: with no key configured
// the tool still returns the full verdict and says plainly that it cannot
// certify — it never returns an unsigned object shaped like a certificate.
let cached = null;
function signingKeys() {
  const pem = (process.env.SQL_CERT_SIGNING_KEY || "").trim().replace(/\\n/g, "\n");
  if (!pem) return { configured: false };
  if (cached && cached.pem === pem) return cached;
  try {
    const priv = createPrivateKey(pem);
    const pub = createPublicKey(priv);
    cached = { configured: true, pem, priv, publicKeyPem: pub.export({ type: "spki", format: "pem" }) };
    return cached;
  } catch (e) {
    console.warn(`[sql-guard] SQL_CERT_SIGNING_KEY is set but unusable (${e.message}) - serving verdicts without certificates`);
    return { configured: false };
  }
}

const readSql = (i) => {
  const sql = i?.sql;
  if (typeof sql !== "string" || !sql.trim()) throw bad('Missing or invalid "sql" (the exact statement you are about to execute)');
  if (sql.length > MAX_SQL) throw bad(`"sql" exceeds ${MAX_SQL} characters`);
  return sql;
};

export const SQL_GUARD_TOOLS = [
  {
    route: "POST /api/sql-guard",
    name: "SQL statement guard with signed verdict",
    slug: "sql-guard",
    category: "validation",
    price: "$0.004",
    description:
      "Review a SQL statement an agent is about to run against production, and sign the verdict. Returns a policy verdict (pass / warn / block) with named risks - unbounded UPDATE or DELETE, tautological WHERE, DROP, TRUNCATE, DROP COLUMN, statement stacking, COPY ... FROM PROGRAM, GRANT/role changes, session_replication_role and trigger/constraint bypass, writes to pg_catalog - and, when the verdict is pass, an Ed25519 certificate binding that verdict to the SHA-256 of the exact statement. Your database layer verifies the certificate with sql-cert-verify before executing, so the check cannot be skipped by a confused or compromised agent. Literals and comments are scrubbed before analysis, so a keyword inside a string is never a false alarm. HONEST SCOPE: a lexical guard over a fixed, published risk catalog - it catches the shapes that destroy production data, it is not a SQL parser and cannot know that a WHERE clause names the wrong tenant.",
    tags: ["sql", "postgres", "firewall", "guard", "safety", "database", "certificate", "ed25519", "agents", "validation"],
    discovery: {
      bodyType: "json",
      input: { sql: "UPDATE users SET plan = 'pro' WHERE id = 42" },
      inputSchema: {
        properties: {
          sql: { type: "string", description: "the exact statement you are about to execute" },
          allow: { type: "array", description: "risk ids to downgrade from block to warn (see riskCatalogue in the response)" },
          allowMultiStatement: { type: "boolean", description: "permit more than one statement in the submission (default false)" },
          ttlSeconds: { type: "number", description: "certificate lifetime, 30-3600 (default 300)" },
        },
        required: ["sql"],
      },
      output: {
        example: {
          verdict: "pass", mutating: true, statementCount: 1,
          sha256: "635cf20a…", risks: [],
          certificate: { token: "eyJ2Ijox….signature", expiresAt: "2026-07-28T20:05:00Z" },
        },
      },
    },
    handler: (i) => {
      const sql = readSql(i);
      if (i.allow !== undefined && !Array.isArray(i.allow)) throw bad('"allow" must be an array of risk ids');
      const unknown = (i.allow || []).filter((id) => !(id in RISK_CATALOGUE));
      if (unknown.length) throw bad(`unknown risk id(s) in "allow": ${unknown.join(", ")} - see riskCatalogue`);
      const analysis = analyzeSql(sql, { allow: i.allow, allowMultiStatement: !!i.allowMultiStatement });
      const keys = signingKeys();
      let certificate = null;
      let certificateNote;
      if (analysis.verdict === "block") {
        certificateNote = "no certificate issued - the statement is blocked by policy";
      } else if (!keys.configured) {
        certificateNote = "this deployment has no signing key configured (SQL_CERT_SIGNING_KEY), so no certificate was issued - the verdict above still stands";
      } else {
        const ttl = Number.isFinite(Number(i.ttlSeconds)) ? Number(i.ttlSeconds) : 300;
        const issued = issueCertificate(analysis, { privateKeyPem: keys.priv, ttlSeconds: ttl });
        certificate = {
          token: issued.token,
          issuedAt: new Date(issued.payload.iat * 1000).toISOString(),
          expiresAt: new Date(issued.payload.exp * 1000).toISOString(),
          verifyWith: "POST /api/sql-cert-verify { sql, certificate }",
        };
      }
      return {
        verdict: analysis.verdict,
        mutating: analysis.mutating,
        statementCount: analysis.statementCount,
        sha256: analysis.sha256,
        risks: analysis.risks,
        blocked: analysis.blocked,
        statements: analysis.statements.map(({ statement, verb, kind, mutating }) => ({ statement, verb, kind, mutating })),
        policy: analysis.policy,
        certificate,
        ...(certificateNote ? { certificateNote } : {}),
        ...(keys.configured ? { publicKey: keys.publicKeyPem } : {}),
        riskCatalogue: Object.fromEntries(Object.entries(RISK_CATALOGUE).map(([id, v]) => [id, v.severity])),
      };
    },
  },
  {
    route: "POST /api/sql-cert-verify",
    name: "SQL execution certificate verify",
    slug: "sql-cert-verify",
    category: "validation",
    price: "$0.001",
    description:
      "Verify an Ed25519 execution certificate against the exact SQL statement you are about to run - the gate your database layer calls before it obeys an agent. Checks the signature, the certificate version, the expiry, and that the statement's SHA-256 matches the one certified, so a certificate for a different (or edited) statement is rejected. Returns { valid, reason, payload } and never throws on a malformed token, so the executor always gets one uniform answer. Pass publicKey to verify a certificate issued by another deployment; omit it to use this one's.",
    tags: ["sql", "postgres", "certificate", "verify", "ed25519", "firewall", "safety", "database", "agents"],
    discovery: {
      bodyType: "json",
      input: { sql: SAMPLE_SQL, certificate: SAMPLE_CERTIFICATE, publicKey: SAMPLE_PUBLIC_KEY },
      inputSchema: {
        properties: {
          sql: { type: "string", description: "the exact statement the certificate should cover" },
          certificate: { type: "string", description: "the token from sql-guard (payload.signature)" },
          publicKey: { type: "string", description: "PEM public key of the issuer (default: this deployment's)" },
        },
        required: ["sql", "certificate"],
      },
      output: { example: { valid: true, reason: null, payload: { v: 1, verdict: "pass", sha256: "635cf20a…", exp: 4070908800 } } },
    },
    handler: (i) => {
      const sql = readSql(i);
      if (typeof i.certificate !== "string" || !i.certificate.trim()) throw bad('Missing or invalid "certificate"');
      let publicKeyPem = typeof i.publicKey === "string" && i.publicKey.trim() ? i.publicKey.trim().replace(/\\n/g, "\n") : signingKeys().publicKeyPem;
      if (!publicKeyPem) {
        return { valid: false, reason: "no public key: this deployment has no signing key configured and none was supplied", payload: null };
      }
      try { createPublicKey(publicKeyPem); } catch { throw bad('"publicKey" is not a usable PEM public key'); }
      return verifyCertificate(sql, i.certificate, { publicKeyPem });
    },
  },
];
