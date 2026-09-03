// agent402-tollbooth CLI mode (`npx agent402-tollbooth`) settles x402 AND MPP
// from env alone: TOLLBOOTH_PAYTO + TOLLBOOTH_FACILITATOR_URL build a real
// @x402/express v2 middleware inside the CLI (tollbooth/index.js
// buildCliX402Middleware) and hand it to createTollbooth({ x402 }).
//
// Why this test exists: before 0.8.0 the CLI with TOLLBOOTH_PAYTO ADVERTISED
// a quote and refused every payment (no verifier in that mode) - a price
// nobody could pay, silently. This drives the REAL CLI process (spawned, env
// only, no upstream so the bare gate answers) against a stub facilitator and
// proves, with a stock mppx client and a stock @x402/fetch client:
//   - the 402 carries the middleware's PAYMENT-REQUIRED and an MPP challenge;
//   - each buy is served AND settled exactly once (settle-after-handler);
//   - PoW is still checked first and never touches the facilitator;
//   - misconfiguration fails CLOSED and loudly (non-USDC asset, unknown
//     network, PAYTO without a facilitator = quote-only with a warning).
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { Receipt } from "mppx";
import { Fetch as MppFetch, evm } from "mppx/client";
import { x402Client } from "@x402/core/client";
import { registerExactEvmScheme } from "@x402/evm/exact/client";
import { wrapFetchWithPayment } from "@x402/fetch";
import { privateKeyToAccount, generatePrivateKey } from "viem/accounts";
import { buildCliX402Middleware, CLI_NETWORKS } from "../tollbooth/index.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
let pass = 0;
let facilitator = null; let child = null;
const fail = (m) => { console.error("FAIL:", m); try { facilitator?.close(); child?.kill("SIGKILL"); } catch {} process.exit(1); };
const ok = (c, m) => { if (c) { pass++; console.log(`ok - ${m}`); } else fail(m); };

const PAYTO = "0x000000000000000000000000000000000000dEaD";
const TX = `0x${"cd".repeat(32)}`;
const SECRET = "tollbooth-cli-test-secret";

// ---- stub facilitator: exact USDC on Base + Polygon ----
const facCalls = { verify: [], settle: [], supported: 0, headers: [] };
facilitator = createServer((req, res) => {
  let body = ""; req.on("data", (c) => { body += c; });
  req.on("end", () => {
    const reply = (obj) => { res.writeHead(200, { "Content-Type": "application/json" }); res.end(JSON.stringify(obj)); };
    facCalls.headers.push(req.headers["x-test-key"] || null);
    if (req.url === "/supported") { facCalls.supported++; return reply({ kinds: [{ x402Version: 2, scheme: "exact", network: "eip155:8453" }, { x402Version: 2, scheme: "exact", network: "eip155:137" }], extensions: [], signers: {} }); }
    const parsed = body ? JSON.parse(body) : {};
    if (req.url === "/verify") { facCalls.verify.push(parsed); return reply({ isValid: true, payer: parsed.paymentPayload?.payload?.authorization?.from }); }
    if (req.url === "/settle") { facCalls.settle.push(parsed); return reply({ success: true, transaction: TX, network: parsed.paymentRequirements?.network, payer: parsed.paymentPayload?.payload?.authorization?.from }); }
    res.writeHead(404); res.end();
  });
});
await new Promise((r) => facilitator.listen(0, r));
const FAC = `http://127.0.0.1:${facilitator.address().port}`;

// ---- 1. the builder alone: quote-only, misconfig, network mapping ----
ok((await buildCliX402Middleware({})) === null, "no TOLLBOOTH_PAYTO -> no middleware (proof-of-work only, as before)");
ok((await buildCliX402Middleware({ TOLLBOOTH_PAYTO: PAYTO })) === null, "PAYTO without a facilitator -> null (quote-only) with a loud warning, never a silent settling claim");
{
  // Coinbase Business path: CDP keys and NO facilitator URL -> the CLI settles
  // through Coinbase's facilitator (createFacilitatorConfig mints the JWTs),
  // so a middleware is built where the URL-less env used to yield null.
  // The key is GENERATED here (never committed): the CLI now proves the key
  // parses by minting one JWT at boot, so the fixture must be a real EC key.
  const { generateKeyPairSync } = await import("node:crypto");
  const pem = generateKeyPairSync("ec", { namedCurve: "prime256v1" }).privateKey.export({ type: "pkcs8", format: "pem" });
  const mw = await buildCliX402Middleware({ TOLLBOOTH_PAYTO: PAYTO, TOLLBOOTH_CDP_API_KEY_ID: "organizations/test/apiKeys/test", TOLLBOOTH_CDP_API_KEY_SECRET: pem });
  ok(typeof mw === "function", "TOLLBOOTH_CDP_API_KEY_ID/SECRET without a facilitator URL -> a settling middleware via Coinbase's facilitator (the Coinbase Business path)");
  const bad = await new Promise((resolve) => {
    const c = spawn(process.execPath, ["-e", `import("${join(ROOT, "tollbooth/index.js").replace(/\\/g, "/")}").then(m => m.buildCliX402Middleware(process.env)).then(x => { console.log(x ? "MW" : "NULL"); })`], { env: { ...process.env, TOLLBOOTH_PAYTO: PAYTO, TOLLBOOTH_CDP_API_KEY_ID: "organizations/test/apiKeys/test", TOLLBOOTH_CDP_API_KEY_SECRET: "not-a-key" } });
    let out = ""; c.stdout.on("data", (d) => { out += d; }); c.stderr.on("data", (d) => { out += d; });
    c.on("exit", (code) => resolve({ code, out }));
  });
  ok(bad.code === 1 && /cannot sign|Invalid key|key format/i.test(bad.out) && !/not-a-key/.test(bad.out), "a CDP secret that cannot sign fails the boot (exit 1) with the reason, never the key itself, instead of booting 'settling' and answering 500s");
}
ok(CLI_NETWORKS.base === "eip155:8453" && CLI_NETWORKS.polygon === "eip155:137" && CLI_NETWORKS.celo === "eip155:42220", "CLI network names map to CAIP-2");
{
  const mw = await buildCliX402Middleware({ TOLLBOOTH_PAYTO: PAYTO, TOLLBOOTH_FACILITATOR_URL: FAC, TOLLBOOTH_NETWORK: "polygon", TOLLBOOTH_PRICE: "$0.005", TOLLBOOTH_FACILITATOR_HEADERS: JSON.stringify({ "X-Test-Key": "k1" }) });
  ok(typeof mw === "function", "PAYTO + facilitator -> a middleware function");
  // Drive it in-process to read the quote it would advertise.
  const { default: express } = await import("express");
  const e = express(); e.use(mw); e.get("/x", (_q, r) => r.json({ ok: 1 }));
  const srv = e.listen(0); await new Promise((r) => srv.once("listening", r));
  const r = await fetch(`http://127.0.0.1:${srv.address().port}/x`);
  const req = JSON.parse(Buffer.from(r.headers.get("payment-required") || "", "base64").toString("utf8"));
  ok(r.status === 402 && req.accepts?.[0]?.network === "eip155:137" && req.accepts[0].payTo === PAYTO && req.accepts[0].amount === "5000", `TOLLBOOTH_NETWORK=polygon, PRICE=$0.005 -> accepts eip155:137, 5000 base units, our payTo (got ${r.status} ${req.accepts?.[0]?.network} ${req.accepts?.[0]?.amount})`);
  ok(facCalls.headers.includes("k1"), "TOLLBOOTH_FACILITATOR_HEADERS ride the facilitator calls (/supported saw X-Test-Key)");
  srv.close();
}
// Misconfiguration fails closed: run the builder in a child so process.exit is observable.
{
  const runBuilder = (env) => new Promise((resolve) => {
    const c = spawn(process.execPath, ["-e", `import("${join(ROOT, "tollbooth/index.js").replace(/\\\\/g, "/")}").then(m => m.buildCliX402Middleware(process.env)).then(x => { console.log(x ? "MW" : "NULL"); process.exit(0); })`], { env: { ...env, PATH: process.env.PATH }, cwd: ROOT });
    let out = ""; c.stdout.on("data", (d) => { out += d; }); c.stderr.on("data", (d) => { out += d; });
    c.on("exit", (code) => resolve({ code, out }));
  });
  const a = await runBuilder({ TOLLBOOTH_PAYTO: PAYTO, TOLLBOOTH_FACILITATOR_URL: FAC, TOLLBOOTH_ASSET: "USDG" });
  ok(a.code === 1 && /TOLLBOOTH_ASSET=USDG/.test(a.out) && /Refusing to start/.test(a.out), "non-USDC asset with a facilitator: refuses to start (would advertise a quote it cannot settle)");
  const b = await runBuilder({ TOLLBOOTH_PAYTO: PAYTO, TOLLBOOTH_FACILITATOR_URL: FAC, TOLLBOOTH_NETWORK: "solana" });
  ok(b.code === 1 && /TOLLBOOTH_NETWORK=solana/.test(b.out), "unknown network: refuses to start, names the known ones");
  const c = await runBuilder({ TOLLBOOTH_PAYTO: PAYTO, TOLLBOOTH_FACILITATOR_URL: FAC, TOLLBOOTH_FACILITATOR_HEADERS: "not json" });
  ok(c.code === 1 && /TOLLBOOTH_FACILITATOR_HEADERS/.test(c.out), "malformed facilitator headers: refuses to start");
}

// ---- 2. the REAL CLI process, env only, no upstream ----
// PORT=0: the OS picks a free port and the CLI's banner names it. The test used
// to pick 40000-59999 at random, which sits INSIDE Linux's ephemeral range
// (32768-60999), so any outbound socket on the runner could already hold the
// number - the FIFTH occurrence (2026-08-27, run 33098814847) finally said so:
// "http server error: EADDRINUSE listen EADDRINUSE: address already in use
// :::42828", then "event loop drained ... listening=false". A bound listener
// cannot drain the loop; a listener that never bound can, which is the shape
// every earlier occurrence had and no earlier run recorded.
child = spawn(process.execPath, ["--trace-exit", join(ROOT, "tollbooth/index.js")], {
  cwd: ROOT,
  env: { PATH: process.env.PATH, PORT: "0", TOLLBOOTH_PAYTO: PAYTO, TOLLBOOTH_FACILITATOR_URL: FAC, TOLLBOOTH_SECRET: SECRET, TOLLBOOTH_MODE: "all", TOLLBOOTH_PRICE: "$0.001", TOLLBOOTH_ADMIN_TOKEN: "t" },
  stdio: ["ignore", "pipe", "pipe"],
});
let cliLog = "";
let childExit = null;
child.stdout.on("data", (d) => { cliLog += d; }); child.stderr.on("data", (d) => { cliLog += d; });
child.on("exit", (code, signal) => { childExit = { code, signal }; });
// `exit` fires BEFORE the child's stdio has drained; `close` fires after. The
// third CI-only occurrence (2026-08-26, run 32981192713) printed the banner and
// exited 0 with `--trace-exit` on and NO trace line in the log - consistent
// with the trace having been written to stderr after this test read the log
// at `exit`. Evidence is read at `close` now, so a fourth occurrence explains
// itself: an explicit process.exit() prints its stack, a drained loop prints
// nothing, and the two are finally distinguishable.
// FOURTH occurrence 2026-08-27 (run 33095727469): banner printed, exit 0, no
// signal, stdio drained, NO trace line - so it was a drained loop, not a
// process.exit(). The CLI now logs on `beforeExit` (the hook that fires exactly
// when the loop drains) with server.listening, its address and the live
// resource list, and on the server's own `close`/`error` events, so a fifth
// occurrence names which handle went away.
let childClosed = false;
child.on("close", () => { childClosed = true; });
const drained = async (ms = 3000) => { const t = Date.now() + ms; while (!childClosed && Date.now() < t) await new Promise((r) => setTimeout(r, 50)); };
let PORT = 0; // learned from the banner below
let B = "";
// SECOND OCCURRENCE 2026-08-22 (CI only, never locally): the child printed its
// boot banner - so `app.listen` had already called back - and then EXITED code=0
// with no signal, before the first stats fetch landed. A listening server keeps
// a ref'd handle, so a clean exit there is not an ordinary shutdown; the log
// below is the whole record we have. If this recurs, capture `child.pid`'s open
// handles (e.g. spawn with `--trace-exit`) rather than widening the timeout: the
// wait is not the problem, the child leaving is.
// Readiness is judged by an ANSWERED request, and an exhausted wait FAILS with
// evidence: the child's exit status and its full log. On 2026-08-19 a CI run
// died here with a bare `fetch failed ... ECONNREFUSED` two lines after the
// banner had been logged, and nothing recorded whether the child had exited,
// how, or what it printed - one occurrence, no mechanism. A test that can fail
// without evidence cannot be fixed; this one now names the child's fate.
let ready = false;
const deadline = Date.now() + 30_000;
while (Date.now() < deadline && !childExit) {
  if (!PORT) {
    const m = cliLog.match(/listening on :(\d+)/);
    if (m) { PORT = Number(m[1]); B = `http://127.0.0.1:${PORT}`; }
    else { await new Promise((r) => setTimeout(r, 100)); continue; }
  }
  try { await fetch(`${B}/__tollbooth/stats`); ready = true; break; } catch { await new Promise((r) => setTimeout(r, 100)); }
}
if (childExit) await drained();
const childState = () => `child ${childExit ? `EXITED code=${childExit.code} signal=${childExit.signal} (stdio ${childClosed ? "drained" : "NOT drained"})` : `alive pid=${child.pid}`}; log:\n${cliLog.trim() || "(empty)"}`;
ok(ready, `CLI answered /__tollbooth/stats on :${PORT} within 30s (${childState()})`);
ok(/x402 \+ MPP \(USDC, settling via/.test(cliLog), `boot banner says it settles both wires (log: ${cliLog.trim().split("\n").pop()})`);
// Any later network failure against the CLI reports the child's fate too.
process.on("unhandledRejection", (e) => { fail(`unhandled: ${e?.message || e} (${childState()})`); });

const r402 = await fetch(`${B}/page`);
ok(r402.status === 402, "unpaid GET -> 402");
const pr = r402.headers.get("payment-required");
ok(!!pr && JSON.parse(Buffer.from(pr, "base64").toString("utf8")).accepts?.[0]?.payTo === PAYTO, "402 carries the middleware's PAYMENT-REQUIRED (stock x402 v2 clients can pay)");
ok(/^Payment /i.test(r402.headers.get("www-authenticate") || ""), "402 carries WWW-Authenticate: Payment (MPP on by default with x402)");
ok(facCalls.settle.length === 0, "issuing a 402 settled nothing");

// mppx native buy
const account = privateKeyToAccount(generatePrivateKey());
const mppFetch = MppFetch.from({ methods: [evm.charge({ account, currencies: [evm.assets.base.USDC], maxAmount: "1.00" })] });
const paid = await mppFetch(`${B}/page`);
ok(paid.status === 200, `stock mppx client buys through the CLI -> 200 (got ${paid.status})`);
const paidBody = await paid.json();
ok(paidBody?.ok === true && /Bare tollbooth gate/.test(paidBody.note || ""), "the bare gate's real response reached the buyer (no upstream configured)");
ok(paid.headers.get("x-tollbooth-paid") === "mpp", "X-Tollbooth-Paid: mpp");
const rc = paid.headers.get("payment-receipt");
ok(!!rc && Receipt.deserialize(rc).reference === TX, "Payment-Receipt carries the settle tx");
ok(facCalls.verify.length === 1 && facCalls.settle.length === 1, `MPP buy: one verify + ONE settle (got ${facCalls.verify.length}/${facCalls.settle.length})`);

// x402 v2 buy
const x402c = new x402Client(); registerExactEvmScheme(x402c, { signer: privateKeyToAccount(generatePrivateKey()) });
const payFetch = wrapFetchWithPayment(fetch, x402c);
const paidX = await payFetch(`${B}/page`);
ok(paidX.status === 200 && paidX.headers.get("x-tollbooth-paid") === "x402", `stock @x402/fetch client buys through the CLI -> 200, X-Tollbooth-Paid: x402 (got ${paidX.status})`);
ok(facCalls.settle.length === 2, `x402 buy settled too (settles=${facCalls.settle.length})`);

// PoW first, facilitator untouched
const lz = (buf) => { let n = 0; for (const b of buf) { if (b === 0) { n += 8; continue; } let x = b; while ((x & 0x80) === 0) { n++; x <<= 1; } break; } return n; };
const solve = (chal, diff) => { let n = 0; while (lz(createHash("sha256").update(`${chal}:${n}`).digest()) < diff) n++; return n; };
const q = await (await fetch(`${B}/page`)).json();
const sol = `${q.proofOfWork.token}:${solve(q.proofOfWork.challenge, q.proofOfWork.difficulty)}`;
const before = { v: facCalls.verify.length, s: facCalls.settle.length };
const rp = await fetch(`${B}/page`, { headers: { "X-Pow-Solution": sol } });
ok(rp.status === 200 && rp.headers.get("x-tollbooth-paid") === "pow", "proof-of-work still passes free");
ok(facCalls.verify.length === before.v && facCalls.settle.length === before.s, "PoW never touches the facilitator");

// stats via the gated endpoint
const st = await (await fetch(`${B}/__tollbooth/stats`, { headers: { Authorization: "Bearer t" } })).json();
ok(st.mppPaid === 1 && st.x402Paid === 1 && st.powSolved === 1, `CLI stats attribute the wires: mppPaid=${st.mppPaid} x402Paid=${st.x402Paid} powSolved=${st.powSolved}`);

child.kill("SIGTERM"); facilitator.close();
console.log(`\n${pass} passed`);
process.exit(0);
