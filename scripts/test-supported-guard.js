// Boot-time /supported guard (src/payments.js), fully offline: boots the real
// server with the x402 paywall ACTIVE against TWO local stub facilitators and
// pins the 2026-08-01 Celo-outage class of failure:
//
//   a facilitator that is configured but FAILING /supported never delivers its
//   kinds, and @x402's route validation then 500s EVERY paid route — because
//   every route's accepts advertise every offered network. The guard probes
//   each facilitator at boot and drops the networks nobody reachable
//   advertises, so one dead facilitator costs ONE rail, not all of them.
//
// Five legs, each a fresh server boot:
//   1. INCIDENT  — PayAI stub healthy (base), Celo stub 500ing: unpaid request
//                  must 402, accepts must carry base and NOT celo, and the
//                  boot log must name the drop (probe-driven, not hardcoded).
//   2. CONTROL   — both stubs healthy: accepts carry BOTH networks, proving
//                  the filter answers the probe rather than always dropping.
//   3. FAIL-OPEN — both stubs 500ing: the guard must REFUSE to filter (this
//                  shape is indistinguishable from our own egress being down,
//                  and wiping the whole offer on a local blip would make a
//                  transient self-inflicted). Free surfaces stay up.
//   4. ESCAPE    — X402_SUPPORTED_GUARD=off with the incident stubs restores
//                  prior behavior outright, pinning the operator hatch.
//   5. RUNTIME   — a facilitator dying AFTER a healthy boot must cost only
//                  its own rail's settles, never the offer: @x402/express
//                  latches isInitialized on the first successful init and
//                  never re-fetches /supported, so the map cannot be wiped
//                  mid-run. That latch is VENDOR behavior the no-single-
//                  load-bearing-network architecture depends on — if a
//                  future @x402 bump moves to TTL re-init (initialize()
//                  clear()s the map before refilling), this leg fails and
//                  the bump must not ship until the guard grows a runtime
//                  layer.
//
// The stubs never see a verify/settle — this is a 402-negotiation test, so no
// signature machinery is needed and the whole thing runs with no egress.
import { spawn } from "node:child_process";
import { createServer } from "node:http";

const TREASURY = "0x000000000000000000000000000000000000dEaD";
const KINDS_BASE = [{ x402Version: 2, scheme: "exact", network: "eip155:8453" }];
const KINDS_CELO = [{ x402Version: 2, scheme: "exact", network: "eip155:42220" }];

let pass = 0;
let proc = null;
const stubs = [];
const cleanup = () => { proc?.kill("SIGKILL"); for (const s of stubs) s.close(); };
const fail = (m) => { console.error("FAIL:", m); cleanup(); process.exit(1); };
const ok = (c, m) => { if (c) { pass++; console.log(`ok - ${m}`); } else fail(m); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// A stub facilitator whose /supported behavior can be swapped between legs.
// mode: array of kinds → 200 {kinds}; "die" → 500 (the incident shape).
function stubFacilitator(port) {
  const state = { mode: "die", hits: [] };
  const srv = createServer((req, res) => {
    state.hits.push(req.url);
    // Connection: close on every reply — the guard's probe and @x402's own
    // sync fetch the same origin seconds apart, and a bare node stub's 5s
    // keep-alive closing between them turns the second fetch into a flaky
    // "TypeError: fetch failed" that looks like a guard bug and is not.
    if (req.url === "/supported") {
      if (state.mode === "die") { res.writeHead(500, { Connection: "close" }); return res.end("Internal Server Error"); }
      res.writeHead(200, { "Content-Type": "application/json", Connection: "close" });
      return res.end(JSON.stringify({ kinds: state.mode, extensions: [], signers: {} }));
    }
    if (req.url === "/verify") {
      req.resume();
      res.writeHead(200, { "Content-Type": "application/json", Connection: "close" });
      return res.end(JSON.stringify({ isValid: false, invalidReason: "invalid_exact_evm_payload_signature" }));
    }
    res.writeHead(404, { Connection: "close" }); res.end();
  });
  stubs.push(srv);
  return new Promise((r) => srv.listen(port, () => r(state)));
}

const payai = await stubFacilitator(3962);
const celo = await stubFacilitator(3963);

async function bootServer(port, extraEnv = {}) {
  const log = { text: "" };
  proc = spawn("node", ["src/server.js"], {
    env: {
      ...process.env, PORT: String(port), FREE_MODE: "",
      WALLET_ADDRESS: TREASURY, NETWORK: "base", PAYMENT_NETWORKS: "base,celo",
      CDP_API_KEY_ID: "", CDP_API_KEY_SECRET: "", FACILITATOR_URL: "",
      PAYAI_FACILITATOR_URL: "http://127.0.0.1:3962",
      CELO_FACILITATOR_URL: "http://127.0.0.1:3963", CELO_FACILITATOR_KEY: "test-key",
      // Hermetic boot: nothing below may add a client that probes a real host.
      PAYAI_API_KEY_ID: "", PAYAI_API_KEY_SECRET: "", SOLVADOR_KEY: "",
      PAYMENT_SETTLE_FALLBACK: "", X402_UPTO_NETWORKS: "", POSTHOG_API_KEY: "",
      X402_INDEX_CRAWL: "off",
      ...extraEnv,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  proc.stdout.on("data", (c) => { log.text += c; });
  proc.stderr.on("data", (c) => { log.text += c; });
  const base = `http://127.0.0.1:${port}`;
  for (let i = 0; i < 80; i++) {
    try { if ((await fetch(`${base}/health`)).ok) return { base, log }; } catch {}
    await sleep(500);
  }
  fail(`server on :${port} never became healthy; log tail: ${log.text.slice(-800)}`);
}

const acceptsNetworks = (prHeader) => {
  const envelope = JSON.parse(Buffer.from(prHeader, "base64").toString("utf8"));
  return new Set((envelope.accepts || []).map((a) => a.network));
};

// ---- 1. INCIDENT: dead Celo facilitator costs the Celo rail, nothing else ----
payai.mode = KINDS_BASE;
celo.mode = "die";
{
  const { base, log } = await bootServer(3964);
  const r = await fetch(`${base}/api/uuid`);
  ok(r.status === 402, `dead Celo facilitator: unpaid catalog GET still 402s (got ${r.status})`);
  const nets = acceptsNetworks(r.headers.get("payment-required") || "");
  ok(nets.has("eip155:8453"), "base survives in accepts");
  ok(!nets.has("eip155:42220"), "celo is dropped from accepts");
  ok(/failed \/supported at boot/.test(log.text), "boot log names the failing facilitator");
  ok(/dropping eip155:42220/.test(log.text), "boot log names the dropped network");
  proc.kill("SIGKILL"); await sleep(300);
}

// ---- 2. CONTROL: probe-driven, not always-drop ----
payai.mode = KINDS_BASE;
celo.mode = KINDS_CELO;
{
  const { base } = await bootServer(3965);
  const r = await fetch(`${base}/api/uuid`);
  ok(r.status === 402, `both facilitators healthy: 402 (got ${r.status})`);
  const nets = acceptsNetworks(r.headers.get("payment-required") || "");
  ok(nets.has("eip155:8453") && nets.has("eip155:42220"),
    "healthy probe keeps BOTH networks in accepts (filter answers the probe)");
  proc.kill("SIGKILL"); await sleep(300);
}

// ---- 3. FAIL-OPEN: every facilitator dead -> refuse to filter ----
payai.mode = "die";
celo.mode = "die";
{
  const { base, log } = await bootServer(3966);
  ok(/REFUSING to filter/.test(log.text), "all-probes-dead boot logs the loud refusal");
  const h = await fetch(`${base}/health`);
  ok(h.ok, "free surfaces stay up when every facilitator is dead");
  const r = await fetch(`${base}/api/uuid`);
  ok(r.status >= 500, `paid route answers 5xx, not a free 200, when nothing can settle (got ${r.status})`);
  proc.kill("SIGKILL"); await sleep(300);
}

// ---- 4. ESCAPE HATCH: X402_SUPPORTED_GUARD=off restores prior behavior ----
payai.mode = KINDS_BASE;
celo.mode = "die";
{
  const { base, log } = await bootServer(3967, { X402_SUPPORTED_GUARD: "off" });
  ok(!/dropping eip155:42220/.test(log.text), "guard off: nothing is dropped");
  const r = await fetch(`${base}/api/uuid`);
  ok(r.status >= 500, `guard off: the incident behavior returns (got ${r.status}) — the hatch really disables it`);
  proc.kill("SIGKILL"); await sleep(300);
}

// ---- 5. RUNTIME death: dying after a healthy boot never wipes the offer ----
payai.mode = KINDS_BASE;
celo.mode = KINDS_CELO;
{
  const { base } = await bootServer(3968);
  const before = await fetch(`${base}/api/uuid`);
  ok(before.status === 402, `healthy boot: 402 (got ${before.status})`);
  ok(acceptsNetworks(before.headers.get("payment-required") || "").has("eip155:42220"),
    "healthy boot advertises celo");
  // The first paid request above forced init to complete and latch. NOW the
  // facilitator dies — past the memo TTL this would refetch if anything
  // re-initialized, so a wiped map shows up as a 500 here.
  celo.mode = "die";
  await sleep(500);
  const after = await fetch(`${base}/api/uuid`);
  ok(after.status === 402, `facilitator died mid-run: offer intact, still 402 (got ${after.status})`);
  const nets = acceptsNetworks(after.headers.get("payment-required") || "");
  ok(nets.has("eip155:8453") && nets.has("eip155:42220"),
    "mid-run death does not rebuild accepts — both rails still advertised (dead rail degrades at verify/settle only, buyer never charged)");
  proc.kill("SIGKILL"); await sleep(300);
}

// ---- 6/7. SOLVADOR_CELO_PRIMARY: the switch decides who verifies Celo ----
// A Celo payment is verified by the facilitator that won the Celo route, so
// the stub that sees /verify is the one that would settle it.
const solvador = await stubFacilitator(3969);
const KINDS_SOLVADOR = [...KINDS_BASE, ...KINDS_CELO];
async function celoVerifiedBy(port, extraEnv) {
  for (const s of [payai, celo, solvador]) s.hits.length = 0;
  const { base, log } = await bootServer(port, { SOLVADOR_KEY: "test-solvador", SOLVADOR_FACILITATOR_URL: "http://127.0.0.1:3969", ...extraEnv });
  const r = await fetch(`${base}/api/uuid`);
  const env = JSON.parse(Buffer.from(r.headers.get("payment-required") || "", "base64").toString("utf8"));
  const accepted = (env.accepts || []).find((a) => a.network === "eip155:42220");
  const now = Math.floor(Date.now() / 1000);
  const payload = { x402Version: 2, resource: env.resource, accepted, payload: { signature: "0x" + "11".repeat(65), authorization: { from: "0x00000000000000000000000000000000000000aa", to: accepted?.payTo, value: accepted?.amount, validAfter: String(now - 60), validBefore: String(now + 600), nonce: "0x" + "22".repeat(32) } } };
  const paid = await fetch(`${base}/api/uuid`, { headers: { "PAYMENT-SIGNATURE": Buffer.from(JSON.stringify(payload)).toString("base64") } });
  await paid.arrayBuffer();
  proc.kill("SIGKILL"); await sleep(300);
  return { accepted: !!accepted, solvador: solvador.hits.filter((h) => h === "/verify").length, celo: celo.hits.filter((h) => h === "/verify").length, payai: payai.hits.filter((h) => h === "/verify").length, log: log.text, status: paid.status };
}
payai.mode = KINDS_BASE; celo.mode = KINDS_CELO; solvador.mode = KINDS_SOLVADOR;
{
  const on = await celoVerifiedBy(3970, { SOLVADOR_CELO_PRIMARY: "on" });
  ok(on.accepted && on.status === 402, `switch on: Celo is offered and the refused payment answers 402 (got ${on.status})`);
  ok(on.solvador === 1 && on.celo === 0 && on.payai === 0, `switch on: Solvador verifies the Celo payment (solvador ${on.solvador}, celo ${on.celo}, payai ${on.payai})`);
  ok(/Solvador is primary/.test(on.log), "switch on: the boot log names Solvador as Celo's primary");
  const off = await celoVerifiedBy(3971, {});
  ok(off.solvador === 0 && off.celo === 1, `switch off: the Celo facilitator verifies it (solvador ${off.solvador}, celo ${off.celo})`);
  celo.mode = "die";
  const dead = await celoVerifiedBy(3972, { SOLVADOR_CELO_PRIMARY: "on" });
  ok(dead.accepted && dead.solvador === 1, "switch on: Celo stays offered through Solvador while the Celo facilitator is down");
}

cleanup();
console.log(`\ntest-supported-guard: ${pass} assertions passed`);
process.exit(0);
