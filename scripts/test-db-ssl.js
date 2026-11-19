// Postgres TLS policy by route (audit F11). Private Railway mesh keeps the
// working relaxed setting (no MITM position); any public/proxied host verifies
// the certificate and fails closed. Offline unit test.
//
//   node scripts/test-db-ssl.js
import "./lib/offline-stores.js"; // per-process and file backends whatever the caller exports (see the file)
import { dbSsl } from "../src/db-ssl.js";

let pass = 0, fail = 0;
const ok = (c, m) => { c ? pass++ : fail++; console.log(`${c ? "ok" : "FAIL"} - ${m}`); };

// Private Railway networking (the actual prod route): unchanged behaviour.
ok(dbSsl("postgresql://u:p@postgres.railway.internal:5432/db")?.rejectUnauthorized === false,
  "private *.railway.internal keeps rejectUnauthorized:false (prod route, unchanged)");
ok(dbSsl("postgresql://u:p@postgres-pvfe.railway.internal:5432/railway")?.rejectUnauthorized === false,
  "the analytics private host is treated the same");

// Public proxy: verify the cert, fail closed on a self-signed / MITM cert.
ok(dbSsl("postgresql://u:p@monorail.proxy.rlwy.net:41234/db")?.rejectUnauthorized === true,
  "public *.proxy.rlwy.net REQUIRES a verified cert (rejectUnauthorized:true)");
ok(dbSsl("postgresql://u:p@some-external-db.example.com:5432/db")?.rejectUnauthorized === true,
  "any other public host also requires a verified cert");
ok(dbSsl("not a url")?.rejectUnauthorized === true,
  "an unparseable URL defaults to verify (fail closed), not relaxed");

// Explicit opt-out still honoured (a self-hoster with sslmode=disable).
ok(dbSsl("postgresql://u:p@localhost:5432/db?sslmode=disable") === false,
  "sslmode=disable turns SSL off explicitly");

// Every Postgres pool the server opens takes its TLS setting from dbSsl().
{
  const { readdirSync, readFileSync, statSync } = await import("node:fs");
  const { join } = await import("node:path");
  const root = new URL("../src/", import.meta.url).pathname;
  const files = [];
  const walk = (d) => { for (const f of readdirSync(d)) { const p = join(d, f); if (statSync(p).isDirectory()) walk(p); else if (/\.(?:c|m)?js$/.test(f)) files.push(p); } };
  walk(root);
  const POOL = /new\s+(?:pg\.)?(?:Pool|Client)\s*\(\s*\{([\s\S]*?)\}\s*\)/g;
  const pools = [], bare = [];
  for (const f of files) {
    for (const m of readFileSync(f, "utf8").matchAll(POOL)) {
      pools.push(f);
      if (!/\bssl\s*:\s*dbSsl\(/.test(m[1])) bare.push(f.slice(root.length));
    }
  }
  ok(pools.length >= 3, `the scan sees the server's Postgres pools (${pools.length})`);
  ok(bare.length === 0, `every Postgres pool in src/ sets ssl: dbSsl(...)${bare.length ? `: ${bare.join(", ")}` : ""}`);
  const planted = "pool = new Pool({ connectionString: url, max: 2 });";
  ok([...planted.matchAll(POOL)].length === 1 && ![...planted.matchAll(POOL)].some((m) => /\bssl\s*:\s*dbSsl\(/.test(m[1])), "control: a pool without the TLS setting is seen and flagged");
}

console.log(`\n${fail ? "FAILED" : "OK"}: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
