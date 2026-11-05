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

console.log(`\n${fail ? "FAILED" : "OK"}: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
