// Operator-published /.well-known documents (src/well-known-store.js + the
// server wiring) — the runtime path for domain-verification files like
// a directory's 15-minute challenge. Invariants:
//   - path traversal is structurally impossible (segment allowlist, no
//     dot-prefixed segments, bounded depth/length)
//   - reserved names (x402, security.txt, glama.json) are refused at write
//     time AND never shadowed at serve time (catch-all falls through on miss)
//   - registration is operator-gated (unauth = 404, the operator posture)
//   - the caller path is proven on a booted server, not just the module
//
//   node scripts/test-well-known-store.js
import { spawn } from "node:child_process";
import { registerWellKnown, removeWellKnown, getWellKnown, validWellKnownPath, listWellKnown } from "../src/well-known-store.js";

let passed = 0, failed = 0;
const ok = (cond, msg) => {
  if (cond) { passed++; console.log(`ok - ${msg}`); }
  else { failed++; console.error(`FAIL - ${msg}`); }
};
const throws = (fn, substr, msg) => {
  try { fn(); ok(false, `${msg} (did not throw)`); }
  catch (e) { ok(String(e.message).includes(substr), `${msg} (got: ${String(e.message).slice(0, 80)})`); }
};

// --- module invariants -----------------------------------------------------
ok(validWellKnownPath("example-verification/2e6dd987-f1d5-4c3c-936d-e5aa5f802d90"), "challenge-shaped path accepted");
ok(!validWellKnownPath("../etc/passwd"), "dot-dot segment rejected");
ok(!validWellKnownPath("a/../b"), "embedded dot-dot rejected");
ok(!validWellKnownPath(".hidden"), "dot-prefixed segment rejected");
ok(!validWellKnownPath("a//b"), "empty segment rejected");
ok(!validWellKnownPath("a/" + "b".repeat(200)), "over-long segment rejected");
ok(!validWellKnownPath("a/b/c/d/e"), "depth beyond 4 segments rejected");
ok(!validWellKnownPath("a b"), "space rejected");

throws(() => registerWellKnown("x402", { a: 1 }), "dedicated route", "reserved name x402 refused at write time");
throws(() => registerWellKnown("security.txt", "x"), "dedicated route", "reserved name security.txt refused");
throws(() => registerWellKnown("ok-path", "x".repeat(17 * 1024)), "max", "byte cap enforced");
throws(() => registerWellKnown("ok-path", { a: 1 }, "text/html; charset=utf-8"), "application/json", "parameterized content type refused");
throws(() => registerWellKnown("ok-path", "<script>x</script>", "text/html"), "application/json", "text/html refused outright - markup is structurally unservable");
ok(registerWellKnown("ok-plain", "hello", "text/plain").path === "ok-plain", "text/plain accepted");
removeWellKnown("ok-plain");

const reg = registerWellKnown("t/one", { service: "directory.example", challenge: "abc" });
ok(reg.path === "t/one" && reg.bytes > 0, "registration returns path + bytes");
ok(getWellKnown("t/one").body.includes('"challenge":"abc"'), "stored body readable");
ok(getWellKnown("missing") === null, "miss returns null");
ok(removeWellKnown("t/one") === true && getWellKnown("t/one") === null, "remove works");
for (let i = 0; i < 16; i++) registerWellKnown(`fill/${i}`, "x");
throws(() => registerWellKnown("overflow", "x"), "store full", "entry cap enforced");
for (let i = 0; i < 16; i++) removeWellKnown(`fill/${i}`);
ok(listWellKnown().length === 0, "store drains clean");

// --- caller path: booted server --------------------------------------------
const PORT = 3187, B = `http://127.0.0.1:${PORT}`, OP = "test-operator-token";
const proc = spawn("node", ["src/server.js"], {
  env: { ...process.env, FREE_MODE: "true", PORT: String(PORT), X402_INDEX_CRAWL: "off", AGENT402_OPERATOR_TOKEN: OP },
  stdio: ["ignore", "pipe", "pipe"],
});
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
try {
  let up = false;
  for (let i = 0; i < 120; i++) { try { if ((await fetch(`${B}/health`)).ok) { up = true; break; } } catch {} await sleep(500); }
  ok(up, "free-mode server booted");

  const doc = { service: "directory.example", challenge_id: "test-123", challenge: "directory-domain-test", domain: "agent402.tools", agent_name: "agent402" };
  const unauth = await fetch(`${B}/__operator/well-known`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ path: "example-verification/test-123", body: doc }) });
  ok(unauth.status === 404, `unauthenticated publish is a 404, the operator posture (got ${unauth.status})`);

  const pub = await fetch(`${B}/__operator/well-known`, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${OP}` }, body: JSON.stringify({ path: "example-verification/test-123", body: doc }) });
  ok(pub.status === 200 && (await pub.json()).ok === true, `operator publish accepted (got ${pub.status})`);

  const read = await fetch(`${B}/.well-known/example-verification/test-123`);
  const readBody = await read.json();
  ok(read.status === 200 && readBody.challenge === "directory-domain-test", "published document served publicly at the exact URL");
  ok((read.headers.get("content-type") || "").includes("application/json"), "served as JSON");
  ok(read.headers.get("x-content-type-options") === "nosniff", "served with nosniff");

  const x402 = await fetch(`${B}/.well-known/x402`);
  const manifest = await x402.json();
  ok(x402.status === 200 && String(manifest.spec).includes("service-manifest") && Array.isArray(manifest.resources),
    "/.well-known/x402 still serves through the catch-all (no shadowing)");
  const sec = await fetch(`${B}/.well-known/security.txt`);
  ok(sec.status === 200 && (await sec.text()).includes("Canonical"), "security.txt untouched");
  const miss = await fetch(`${B}/.well-known/never-registered`);
  ok(miss.status === 404, `unregistered path stays 404 (got ${miss.status})`);

  const rm = await fetch(`${B}/__operator/well-known`, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${OP}` }, body: JSON.stringify({ path: "example-verification/test-123", remove: true }) });
  ok(rm.status === 200 && (await rm.json()).removed === true, "operator remove works");
  const gone = await fetch(`${B}/.well-known/example-verification/test-123`);
  ok(gone.status === 404, "removed document stops serving");
} catch (e) {
  ok(false, `booted-server leg threw: ${e.message}`);
} finally {
  proc.kill("SIGKILL");
}

console.log(`\n${failed ? "FAILED" : "OK"}: ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
