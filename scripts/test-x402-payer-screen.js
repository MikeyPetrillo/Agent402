// The x402 payer screen (src/x402-payer-screen.js), driven through the REAL
// paid server: a stub facilitator verifies every payment and counts each
// verify and settle per payer, so the counts prove where the screen sits
// (after verify, before settle) and that a refusal settles nothing.
//
//   - a payer on the screen's EVM set (EIP-3009, or a Permit2 signer, or a
//     Permit2 payment carrying a different unsigned authorization block) is
//     refused 403 after verification, and nothing settles;
//   - a clean payer on the same route is served and settles once, before and
//     after the refusals (the live control);
//   - the refused write never ran: in a second boot with no list loaded the
//     listed payer's namespace is empty, while the clean payer's write from
//     the first boot reads back; and that boot serves the listed payer (fail
//     open, status "missing");
//   - an async job and an Idempotency-Key retry stay refused for a listed
//     payer, while the same calls for a clean payer complete;
//   - /api/gateway-status reports the screen's word under x402 alone (no
//     Tempo direct mode), and the server log masks the address.
// Non-EVM payloads (Solana, Stellar, Algorand) name no EVM address: covered
// by the pure extractor checks at the top (this harness offers Base only).
import "./lib/file-mode.js";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getFreePorts } from "./lib/free-port.js";
import { x402ScreenedAddressesOf } from "../src/x402-payer-screen.js";
import { payerFromRequest } from "../src/payer.js";

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log(`ok - ${m}`); } else { fail++; console.error(`FAIL - ${m}`); } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const b64 = (o) => Buffer.from(JSON.stringify(o)).toString("base64");

const LISTED = "0x" + "5a".repeat(20);       // on the stored set below
const LISTED_MIXED = "0x" + "5A".repeat(20); // the same address, other case
const CLEAN = "0x" + "c1".repeat(20);
const CLEAN_2 = "0x" + "c2".repeat(20);
const OTHER_LISTED = "0x" + "77".repeat(20);

// ---------------------------------------------------------------------------
// 1. The extractor: which addresses a request's payment names.
{
  const req = (headers) => ({ header: (k) => headers[String(k).toLowerCase()] ?? null });
  const eip3009 = (from) => b64({ x402Version: 2, payload: { signature: "0x", authorization: { from, nonce: "0x01" } } });
  const permit2 = (from, authFrom) => b64({ x402Version: 2, payload: { signature: "0x", permit2Authorization: { from, nonce: "1" }, ...(authFrom ? { authorization: { from: authFrom } } : {}) } });
  ok(x402ScreenedAddressesOf(req({ "payment-signature": eip3009(LISTED_MIXED) })).join() === LISTED, "EIP-3009: authorization.from, lowercased");
  ok(x402ScreenedAddressesOf(req({ "x-payment": eip3009(CLEAN) })).join() === CLEAN, "the x-payment spelling is read too");
  ok(x402ScreenedAddressesOf(req({ "payment-signature": eip3009(LISTED), "x-payment": eip3009(CLEAN) })).join() === LISTED, "payment-signature wins over x-payment, as in the middleware");
  ok(x402ScreenedAddressesOf(req({ "payment-signature": permit2(LISTED) })).join() === LISTED, "Permit2: permit2Authorization.from");
  const both = x402ScreenedAddressesOf(req({ "payment-signature": permit2(LISTED, CLEAN) }));
  ok(both.length === 2 && both.includes(LISTED) && both.includes(CLEAN), "Permit2 beside a different authorization block: both screened");
  ok(payerFromRequest(req({ "payment-signature": permit2(LISTED, CLEAN) })) === null, "(why the screen has its own reader: identity attribution answers null for that shape)");
  ok(x402ScreenedAddressesOf(req({ "payment-signature": b64({ x402Version: 2, accepted: { network: "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp" }, payload: { transaction: "AQAB" } }) })).length === 0, "a Solana payload names no EVM address");
  ok(x402ScreenedAddressesOf(req({ "payment-signature": b64({ x402Version: 2, accepted: { network: "stellar:pubnet" }, payload: { transaction: "AAAA" } }) })).length === 0, "a Stellar payload names no EVM address");
  ok(x402ScreenedAddressesOf(req({ "payment-signature": b64({ x402Version: 2, accepted: { network: "algorand:mainnet" }, payload: { paymentGroup: ["gqNzaWc="], paymentIndex: 0 } }) })).length === 0, "an Algorand payload names no EVM address");
  ok(x402ScreenedAddressesOf(req({})).length === 0 && x402ScreenedAddressesOf(req({ "payment-signature": "not-json!" })).length === 0, "no header, or an unreadable one: nothing to screen");
  ok(x402ScreenedAddressesOf(req({ "payment-signature": b64({ payload: { authorization: { from: "0xNOTHEX" } }, from: LISTED }) })).length === 0, "a malformed from, or an address outside the payload, is not read");
}

// ---------------------------------------------------------------------------
// 2. The real paid server.
const TMP = mkdtempSync(join(tmpdir(), "x402-payer-screen-"));
const [PORT_A, PORT_B, FAC_PORT, UP_PORT] = await getFreePorts(4);
let proc = null;
const serverLog = [];
setTimeout(() => { console.error("FAIL - timed out"); for (const l of serverLog.slice(-25)) console.error("  server:", l); proc?.kill("SIGKILL"); process.exit(1); }, 180_000).unref();

const fac = { verify: {}, settle: {} };
const bump = (m, k) => { m[k] = (m[k] || 0) + 1; };
const facilitator = createServer((req, res) => {
  let b = ""; req.on("data", (c) => { b += c; });
  req.on("end", () => {
    const reply = (o, s = 200) => { res.writeHead(s, { "Content-Type": "application/json" }); res.end(JSON.stringify(o)); };
    if (req.url === "/supported") return reply({ kinds: [{ x402Version: 2, scheme: "exact", network: "eip155:8453" }], extensions: [], signers: {} });
    if (req.url === "/rpc") {
      let rpc = {}; try { rpc = JSON.parse(b || "{}"); } catch { /* ignore */ }
      const balanceOf = rpc.method === "eth_call" && String(rpc.params?.[0]?.data || "").startsWith("0x70a08231");
      return reply({ jsonrpc: "2.0", id: rpc.id ?? 1, result: balanceOf ? "0x" + (1_000_000_000).toString(16).padStart(64, "0") : "0x0" });
    }
    if (req.url === "/SDN.XML") return reply({}, 503); // the list source stays down: only the stored set is ever loaded
    let p = {}; try { p = JSON.parse(b || "{}"); } catch { /* ignore */ }
    const inner = p.paymentPayload?.payload || {};
    const payer = String(inner.permit2Authorization?.from || inner.authorization?.from || "").toLowerCase();
    if (req.url === "/verify") { bump(fac.verify, payer); return reply({ isValid: true, payer }); }
    if (req.url === "/settle") { bump(fac.settle, payer); return reply({ success: true, transaction: `0x${String(Object.values(fac.settle).reduce((a, n) => a + n, 0)).padStart(64, "0")}`, network: "eip155:8453", payer }); }
    reply({});
  });
});
await new Promise((r) => facilitator.listen(FAC_PORT, "127.0.0.1", r));
const FAC = `http://127.0.0.1:${FAC_PORT}`;

// A stub over api.openai.com for the async route (a test boot can never spend).
const up = { calls: 0 };
const PNG_B64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=";
const upstream = createServer((req, res) => {
  req.resume();
  req.on("end", () => { up.calls++; setTimeout(() => { res.writeHead(200, { "Content-Type": "application/json" }); res.end(JSON.stringify({ created: 1, data: [{ b64_json: PNG_B64 }], usage: { input_tokens: 1, output_tokens: 1 } })); }, 200); });
});
await new Promise((r) => upstream.listen(UP_PORT, "127.0.0.1", r));
const preload = join(TMP, "openai-stub.mjs");
writeFileSync(preload, `
const STUB = ${JSON.stringify(`http://127.0.0.1:${UP_PORT}`)};
const real = globalThis.fetch;
globalThis.fetch = function (input, init) {
  const url = typeof input === "string" ? input : input instanceof URL ? input.href : input?.url;
  if (typeof url === "string" && url.startsWith("https://api.openai.com/")) return real.call(this, STUB + url.slice("https://api.openai.com".length), init);
  return real.call(this, input, init);
};
`);

// The stored set the screen reads at boot (the shape src/sanctions-screen.js saves).
const STORE = join(TMP, "screen.json");
writeFileSync(STORE, JSON.stringify({ v: 1, loadedAt: Date.now(), publishDate: "01/01/2026", perAsset: { ETH: 2 }, addresses: [LISTED, OTHER_LISTED] }));

const boot = async (port, storeFile) => {
  const env = { ...process.env, PORT: String(port), FREE_MODE: "", WALLET_ADDRESS: "0x000000000000000000000000000000000000dEaD", NETWORK: "base",
    FACILITATOR_URL: FAC, AGENT402_BASE_RPC: `${FAC}/rpc`, PAYMENT_NETWORKS: "base",
    CDP_API_KEY_ID: "", CDP_API_KEY_SECRET: "", MPP_SECRET_KEY: "", TEMPO_API_KEY: "", TEMPO_RELAY: "", STRIPE_SECRET_KEY: "", POSTHOG_API_KEY: "",
    OPENAI_API_KEY: "sk-test-never-used", OPENROUTER_API_KEY: "", AGENT402_OPERATOR_TOKEN: "payer-screen-test-operator-token-0123456789",
    X402_INDEX_CRAWL: "off", MPP_INDEX_CRAWL: "off", MONITOR_SCHEDULER: "off", FREE_ALERTS: "off", FOLLOWUPS: "off",
    AGENT402_TASK_DATA_DIR: join(TMP, `tasks-${port}`), REFUND_DB_DIR: TMP, SALES_LEDGER_DB: join(TMP, `sales-${port}.db`), HANGUP_FORGIVE_FILE: join(TMP, `hangup-${port}.json`),
    MEMORY_DB_FILE: join(TMP, "memory.db"),
    SANCTIONS_SCREEN_FILE: storeFile, SANCTIONS_LIST_URL: `${FAC}/SDN.XML` };
  proc = spawn(process.execPath, ["--import", preload, "src/server.js"], { env, stdio: ["ignore", "pipe", "pipe"] });
  const keep = (c) => { for (const l of String(c).split("\n")) if (l.trim()) serverLog.push(l.slice(0, 400)); };
  proc.stdout.on("data", keep); proc.stderr.on("data", keep);
  const base = `http://127.0.0.1:${port}`;
  for (let i = 0; i < 160; i++) { try { if ((await fetch(`${base}/health`)).ok) return base; } catch { /* booting */ } await sleep(500); }
  throw new Error("server did not boot");
};
const stop = async () => { if (!proc) return; const p = proc; proc = null; p.kill("SIGTERM"); await new Promise((r) => { const t = setTimeout(() => { p.kill("SIGKILL"); r(); }, 8000); p.once("exit", () => { clearTimeout(t); r(); }); }); };

let nonce = 0;
const acceptedCache = new Map();
const acceptedFor = async (B, method, url, body) => {
  const k = `${method} ${url}`;
  if (!acceptedCache.has(k)) {
    const r = await fetch(`${B}${url}`, { method, headers: body ? { "content-type": "application/json" } : {}, body });
    const pr = r.headers.get("payment-required");
    const a = pr ? (JSON.parse(Buffer.from(pr, "base64").toString("utf8")).accepts || []).find((x) => x.network === "eip155:8453" && x.scheme === "exact") : null;
    acceptedCache.set(k, a || null);
  }
  return acceptedCache.get(k);
};
const credential = (accepted, { from, permit2From, both } = {}) => {
  const n = "0x" + (0x7000 + ++nonce).toString(16).padStart(64, "0");
  const authorization = { from, to: accepted.payTo, value: accepted.amount, validAfter: "0", validBefore: "9999999999", nonce: n };
  const p2 = permit2From ? { from: permit2From, permitted: { token: accepted.asset, amount: accepted.amount }, spender: "0x" + "02".repeat(20), nonce: String(BigInt(n)), deadline: "9999999999", witness: { to: accepted.payTo, validAfter: "0", extra: "0x" } } : null;
  const payload = p2 ? { signature: "0x" + "22".repeat(65), permit2Authorization: p2, ...(both ? { authorization } : {}) } : { signature: "0x" + "11".repeat(65), authorization };
  return b64({ x402Version: 2, resource: accepted.resource, accepted, payload });
};
const paid = async (B, method, url, body, who, extra = {}) => {
  const accepted = await acceptedFor(B, method, url, body);
  if (!accepted) return { status: -1, json: {} };
  const r = await fetch(`${B}${url}`, { method, headers: { ...(body ? { "content-type": "application/json" } : {}), "payment-signature": credential(accepted, who), ...extra }, body });
  const text = await r.text();
  let json = {}; try { json = JSON.parse(text); } catch { /* not json */ }
  return { status: r.status, json, headers: r.headers };
};
const settles = (a) => fac.settle[a] || 0;
const verifies = (a) => fac.verify[a] || 0;
const status = async (B, auth) => (await (await fetch(`${B}/api/gateway-status`, auth ? { headers: { "X-Operator-Token": "payer-screen-test-operator-token-0123456789" } } : {})).json()).sanctionsScreen;

const PUT = (key, value) => JSON.stringify({ key, value });
try {
  // ---- Boot A: the stored list is loaded ----
  let B = await boot(PORT_A, STORE);
  const pub = await status(B);
  ok(pub?.status === "fresh" && Object.keys(pub).join() === "status", `x402 alone (no Tempo direct mode) publishes the screen's one word: ${JSON.stringify(pub)}`);

  // Live control first.
  let r = await paid(B, "POST", "/api/memory", PUT("k", "clean-value"), { from: CLEAN });
  ok(r.status === 200 && settles(CLEAN) === 1, `control: a clean payer's paid write is served and settles once (got ${r.status}, settles ${settles(CLEAN)})`);

  // A listed EIP-3009 payer, mixed case: verified, refused, nothing settles.
  r = await paid(B, "POST", "/api/memory", PUT("k", "listed-value"), { from: LISTED_MIXED });
  ok(r.status === 403, `a listed payer is refused 403 (got ${r.status})`);
  ok(r.json?.error === "This server cannot accept a payment from this address (sanctions screening). Nothing was charged for this request." && r.json?.reason === "payer-not-accepted" && r.json?.charged === false, `the refusal body is the neutral text (${JSON.stringify(r.json)})`);
  ok(!JSON.stringify(r.json).toLowerCase().includes(LISTED.slice(2)), "the refusal body does not echo the address");
  ok(verifies(LISTED) === 1 && settles(LISTED) === 0, `the payment verified first and nothing settled (verify ${verifies(LISTED)}, settle ${settles(LISTED)})`);

  // Permit2 from a listed signer, and a Permit2 whose unsigned authorization block names a clean wallet.
  r = await paid(B, "POST", "/api/memory", PUT("k2", "p2"), { permit2From: LISTED });
  ok(r.status === 403 && settles(LISTED) === 0, `a Permit2 payment from a listed signer is refused, nothing settles (got ${r.status})`);
  // On a route with no payer identity of its own (memory would refuse this
  // shape anyway), so only the screen can refuse it.
  const cleanSettlesBefore = settles(CLEAN);
  r = await paid(B, "POST", "/api/hash", JSON.stringify({ text: "hello" }), { from: CLEAN, permit2From: LISTED, both: true });
  ok(r.status === 403 && settles(LISTED) === 0 && settles(CLEAN) === cleanSettlesBefore, `a Permit2 signer that is listed is refused even beside a clean authorization block (got ${r.status})`);
  r = await paid(B, "POST", "/api/hash", JSON.stringify({ text: "hello" }), { from: CLEAN });
  ok(r.status === 200 && settles(CLEAN) === cleanSettlesBefore + 1, `control: the same route serves a clean payer (got ${r.status})`);
  // Permit2 control: a clean Permit2 signer on the same route.
  r = await paid(B, "POST", "/api/memory", PUT("k4", "p2-clean"), { permit2From: CLEAN_2 });
  ok(r.status === 200 && settles(CLEAN_2) === 1, `control: a clean Permit2 signer is served and settles (got ${r.status})`);

  // A GET route is screened the same way.
  r = await paid(B, "GET", "/api/memory?key=k", null, { from: LISTED });
  ok(r.status === 403 && settles(LISTED) === 0, `a listed payer's paid read is refused too (got ${r.status})`);

  // Idempotency-Key: a refusal is never cached, so the retry is verified and screened again.
  const v0 = verifies(LISTED);
  const idem = { "idempotency-key": "screen-idem-1" };
  const accW = await acceptedFor(B, "POST", "/api/memory", PUT("k5", "x"));
  const credL = credential(accW, { from: LISTED });
  const send = (cred, key) => fetch(`${B}/api/memory`, { method: "POST", headers: { "content-type": "application/json", "payment-signature": cred, "idempotency-key": key }, body: PUT("k5", "x") });
  const i1 = await send(credL, idem["idempotency-key"]);
  const i2 = await send(credL, idem["idempotency-key"]);
  ok(i1.status === 403 && i2.status === 403 && i2.headers.get("x-idempotent-replay") !== "true" && verifies(LISTED) === v0 + 2 && settles(LISTED) === 0, `a keyed retry of a refused payment is refused again, never replayed (${i1.status}/${i2.status}, verifies +${verifies(LISTED) - v0})`);
  const credC = credential(accW, { from: CLEAN });
  const c1 = await send(credC, "screen-idem-2");
  const c2 = await send(credC, "screen-idem-2");
  ok(c1.status === 200 && c2.status === 200 && c2.headers.get("x-idempotent-replay") === "true", `control: a clean keyed retry replays the settled answer (${c1.status}/${c2.status})`);

  // Async job (Prefer: respond-async): the loopback replay is screened.
  const ASYNC = "/api/image-gen-premium", ABODY = JSON.stringify({ prompt: "a red fox in the snow" });
  const accA = await acceptedFor(B, "POST", ASYNC, ABODY);
  ok(!!accA, "the async route offers exact on Base");
  if (accA) {
    const job = async (headers) => {
      const j = await (await fetch(`${B}${ASYNC}`, { method: "POST", headers: { "content-type": "application/json", prefer: "respond-async", ...headers }, body: ABODY })).json();
      let g = {};
      for (let i = 0; i < 200; i++) { g = await (await fetch(`${B}${j.statusUrl}`)).json(); if (["completed", "failed"].includes(g.status)) break; await sleep(100); }
      return { j, g };
    };
    const calls0 = up.calls;
    const L = await job({ "x-forwarded-for": "10.7.0.1", "payment-signature": credential(accA, { from: LISTED }) });
    ok(/^[0-9a-f]{48}$/.test(L.j.jobId || "") && L.g.status === "failed" && L.g.error?.httpStatus === 403, `a listed payer's async job ends failed with the 403 (job ${L.g.status}, HTTP ${L.g.error?.httpStatus})`);
    ok(up.calls === calls0 && settles(LISTED) === 0, "the async replay never reached the upstream and settled nothing");
    const s0 = settles(CLEAN);
    const C = await job({ "x-forwarded-for": "10.7.0.2", "payment-signature": credential(accA, { from: CLEAN }) });
    ok(C.g.status === "completed" && C.g.result?.httpStatus === 200 && settles(CLEAN) === s0 + 1 && up.calls === calls0 + 1, `control: a clean payer's async job completes and settles once (job ${C.g.status})`);
  }

  // Trailing control, after every refusal.
  r = await paid(B, "POST", "/api/memory", PUT("k6", "still"), { from: CLEAN });
  ok(r.status === 200, `trailing control: the clean payer is still served (got ${r.status})`);

  const op = await status(B, true);
  ok(op?.status === "fresh" && op?.evmAddresses === 2 && op?.x402?.refused >= 6 && op?.x402?.servedUnscreened === 0, `the operator view counts the x402 refusals (${JSON.stringify(op?.x402)})`);
  const logText = serverLog.join("\n").toLowerCase();
  ok(/x402 payer 0x5a5a\.\.\.5a5a refused before the handler/.test(logText), "the server log names the refusal with the address masked");
  ok(!logText.includes(LISTED.slice(2)), "the server log never carries the full address");
  await stop();

  // ---- Boot B: no list loaded (fail open), same memory store ----
  B = await boot(PORT_B, join(TMP, "no-such-store.json"));
  ok((await status(B))?.status === "missing", "with no list loaded the status word reads missing");
  // The memory handler itself answers this read (the screen let it through),
  // and it finds nothing: the refused write in the first boot never ran.
  r = await paid(B, "GET", "/api/memory?key=k", null, { from: LISTED });
  ok(r.status === 404 && r.json?.error === "Key not found" && !JSON.stringify(r.json).includes("listed-value"), `the refused write never ran: the listed payer's namespace is empty (${r.status} ${JSON.stringify(r.json).slice(0, 120)})`);
  const settledBefore = settles(LISTED);
  r = await paid(B, "POST", "/api/memory", PUT("k", "unscreened"), { from: LISTED });
  ok(r.status === 200 && settles(LISTED) === settledBefore + 1, `a listed payer is served while no list is loaded (fail open; got ${r.status}, settles +${settles(LISTED) - settledBefore})`);
  r = await paid(B, "GET", "/api/memory?key=k", null, { from: CLEAN });
  ok(r.status === 200 && JSON.stringify(r.json).includes("clean-value"), `control: the clean payer's write from the first boot reads back (${JSON.stringify(r.json).slice(0, 120)})`);
  const opB = await status(B, true);
  ok(opB?.status === "missing" && opB?.x402?.servedUnscreened >= 1, `the operator view counts payments served unscreened (${JSON.stringify(opB?.x402)})`);
  ok(/serving x402 payments unscreened/.test(serverLog.join("\n")), "the unscreened state is logged");
} finally {
  await stop();
  facilitator.close(); upstream.close();
  rmSync(TMP, { recursive: true, force: true });
}
if (fail) for (const l of serverLog.slice(-30)) console.error("  server:", l);
console.log(`\ntest-x402-payer-screen: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
