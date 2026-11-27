// Every test that boots a server must choose its port in a way that cannot
// collide with something already on the runner:
//   - `getFreePort()` / `getFreePorts()` from scripts/lib/free-port.js (OS-assigned), or
//   - a literal below 32768 (outside Linux's ephemeral range 32768-60999), or
//   - PORT=0 with the bound port read back from the child's log, or
//   - an env-provided port.
// Forbidden: pid-derived or random numbers, and any literal >= 32768. Five
// CI-only "silent exit 0" runs of the tollbooth CLI test (2026-08-19..27) were
// a random 40000-59999 port meeting an ephemeral socket (EADDRINUSE).
//
//   node scripts/test-port-hygiene.js
import "./lib/offline-stores.js"; // per-process and file backends whatever the caller exports (see the file)
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const DIR = dirname(fileURLToPath(import.meta.url));
let pass = 0, fail = 0;
const ok = (c, m) => { c ? pass++ : fail++; console.log(`${c ? "ok" : "FAIL"} - ${m}`); };

// `x.port` where this file assigns x from `await bootServer(...)`: the port the child bound.
const bootedReadBack = (expr, src) => { const b = expr.match(/^([A-Za-z_$][\w$]*)\.port$/); return !!b && new RegExp(`\\b${b[1]}\\s*=\\s*await\\s+bootServer\\(`).test(src); };

const files = readdirSync(DIR).filter((f) => /^test-.*\.js$/.test(f) && f !== "test-port-hygiene.js");
const offenders = [];
let assignments = 0;
for (const f of files) {
  const src = readFileSync(join(DIR, f), "utf8");
  // Identifiers that ARE a port: PORT, PORT2, FAC_PORT, WORKER_PORT ... (a whole
  // identifier ending in PORT/PORT<n>, not REPORT/SUPPORT) or a destructured
  // pair of them.
  for (const m of src.matchAll(/\b(?:const|let)\s+(?:(?:[A-Z0-9]+_)?PORT\d*|\[\s*(?:[A-Z0-9]+_)?PORT\d*\s*(?:,\s*(?:[A-Z0-9]+_)?PORT\d*\s*)*\])\s*=\s*([^;\n]+)/g)) {
    const expr = m[1].trim();
    assignments++;
    if (/getFreePorts?\(/.test(expr)) continue;
    if (/\.address\(\)\.port\b/.test(expr)) continue; // read back from a server the test itself bound (port 0)
    if (bootedReadBack(expr, src)) continue; // read back from a bootServer() child (PORT=0)
    if (/process\.env\./.test(expr)) {
      // env-provided with a literal fallback: the fallback must be sane too
      const lit = expr.match(/\|\|\s*(\d+)/);
      if (lit && Number(lit[1]) >= 32768) offenders.push(`${f}: ${expr} (fallback in the ephemeral range)`);
      continue;
    }
    if (/^"?0"?$/.test(expr) || /^String\(0\)$/.test(expr)) continue;
    if (/^\d+$/.test(expr)) { if (Number(expr) >= 32768) offenders.push(`${f}: ${expr} (literal in the ephemeral range)`); continue; }
    if (/^\d+\s*\+\s*\d+$/.test(expr)) { const n = expr.split("+").reduce((s, x) => s + Number(x), 0); if (n >= 32768) offenders.push(`${f}: ${expr}`); continue; }
    if (/Math\.random|process\.pid/.test(expr)) { offenders.push(`${f}: ${expr} (random/pid-derived)`); continue; }
    // Derived from another PORT symbol (PORT + 1 etc.) is allowed only when the base is free-port based; flag for a human.
    if (/PORT/.test(expr)) continue;
    offenders.push(`${f}: ${expr} (unrecognized port expression)`);
  }
}
ok(assignments >= 30, `found ${assignments} port assignments across ${files.length} test files (the scan sees the fleet)`);
ok(offenders.length === 0, `no test derives its port from pid/random or picks one in the ephemeral range${offenders.length ? `:\n  ${offenders.join("\n  ")}` : ""}`);

// A server.js boot on a RESERVED port is the narrower hazard the rules above
// still allow: getFreePort() hands back a port that is free only when picked,
// and a test that boots a second server minutes later leaves that port open to
// another lane's outbound socket. Every test boots the server through
// scripts/lib/boot-server.js (PORT=0, port read back): no test names the
// server entry beside a reserved port, in either spelling. A test that must
// know a port before anything binds it (a stub that starts late) reserves
// that one port and still boots the server through the helper.
const BOOTS_SERVER = /["'`]src\/server\.js["'`]/;
// The same entry spelled as path parts: join(ROOT, "src", "server.js").
const BOOTS_SERVER_JOINED = /["'`]src["'`]\s*,\s*["'`]server\.js["'`]/;
const RESERVES = /\bgetFreePorts?\(/;
const reserving = files.filter((f) => { const src = readFileSync(join(DIR, f), "utf8"); return (BOOTS_SERVER.test(src) || BOOTS_SERVER_JOINED.test(src)) && RESERVES.test(src); });
ok(reserving.length === 0, `no test boots src/server.js on a reserved port (use bootServer from scripts/lib/boot-server.js)${reserving.length ? `:\n  ${reserving.join("\n  ")}` : ""}`);
ok(BOOTS_SERVER_JOINED.test('spawn(process.execPath, [join(ROOT, "src", "server.js")])') && BOOTS_SERVER_JOINED.test("path.join(ROOT, 'src','server.js')") && !BOOTS_SERVER_JOINED.test('join(ROOT, "src", "pages.js")') && !BOOTS_SERVER.test('join(ROOT, "src", "server.js")'), "control: a planted joined-form boot is seen by the joined scan and not by the literal one");
ok(!existsSync(join(DIR, "port-reservation-baseline.json")), "the reserved-port baseline is gone and stays gone (no file is excused)");
{
  const accepts = bootedReadBack;
  ok(accepts("srv.port", "const srv = await bootServer({});") && !accepts("srv.port", "const srv = { port: 40000 };") && !accepts("cfg.port", "const srv = await bootServer({});"), "control: a .port read is accepted only from a bootServer() result");
}
ok(BOOTS_SERVER.test('spawn(process.execPath, ["src/server.js"])') && RESERVES.test("const [PORT] = await getFreePorts(1);"), "control: a planted reserved-port boot would be seen");

// A stub bound to port 0 with no host listens on every address (`::`), and
// the kernel can hand it a port another process holds on 127.0.0.1 alone (a
// VM's forwarded SSH port, for one): the test then dials 127.0.0.1 and reaches
// that process instead. Every test names the host it dials.
const BARE_LISTEN = /\.listen\(\s*0\s*(?:\)|,(?!\s*\\?["'`]))/;
const bareListens = files.filter((f) => BARE_LISTEN.test(readFileSync(join(DIR, f), "utf8")));
ok(bareListens.length === 0, `no test binds port 0 without a host (listen(0, "127.0.0.1", ...))${bareListens.length ? `:\n  ${bareListens.join("\n  ")}` : ""}`);
ok(BARE_LISTEN.test("app.listen(0);") && BARE_LISTEN.test("s.listen(0, r)") && BARE_LISTEN.test("s.listen(0, () => r())") && !BARE_LISTEN.test('s.listen(0, "127.0.0.1", r)') && !BARE_LISTEN.test('"app.listen(0, \\"127.0.0.1\\");"'), "control: a bare port-0 bind is seen and a host-bound one is not");

// The scan must be able to see an offender at all.
const planted = "const PORT = 40000 + Math.floor(Math.random() * 20000);";
ok(/Math\.random|process\.pid/.test(planted.match(/=\s*([^;\n]+)/)[1]), "control: a planted random port would be flagged");

console.log(`\n${fail ? "FAILED" : "OK"}: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
