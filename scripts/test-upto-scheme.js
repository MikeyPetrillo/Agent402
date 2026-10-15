#!/usr/bin/env node
// `upto` (variable-amount settlement) must ship DARK and must never break the
// payment negotiation every existing buyer already uses.
//
//   node scripts/test-upto-scheme.js
//
// WHY THIS IS GATED AT ALL: registering a scheme adds an accepts entry to EVERY
// 402 on that network. On a service where a malformed or unsettleable 402 means
// nobody can pay, that is not a change to make implicitly - so the default must
// be byte-identical to today, and turning it on must require both an operator
// opt-in AND a facilitator that actually advertises the scheme.
//
// The second gate is the one with teeth. Advertising a scheme nobody can settle
// is WORSE than not offering it: the buyer signs an authorization, the settle
// fails, and they are refused a service they tried to pay for. @x402/core also
// refuses to BUILD a 402 for a scheme/network pair no facilitator advertises,
// which turns every unpaid request into a 500 - measured directly while
// building the trial test, where X402_SYNC_ON_START=false produced exactly that.
//
// Each server here runs against a LOCAL STUB facilitator, so nothing is settled
// and no network is required.
import { spawn } from "node:child_process";
import { createServer } from "node:http";

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log(`ok - ${m}`); } else { fail++; console.error(`FAIL - ${m}`); } };
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

const BASE_CAIP2 = "eip155:8453";
const kind = (scheme) => ({ x402Version: 2, scheme, network: BASE_CAIP2 });

/** A stub facilitator advertising exactly the kinds it is told to. */
function stubFacilitator(port, kinds, signers = {}) {
  const srv = createServer((req, res) => {
    let body = "";
    req.on("data", (c) => { body += c; });
    req.on("end", () => {
      if (req.url === "/supported") {
        res.writeHead(200, { "Content-Type": "application/json" });
        return res.end(JSON.stringify({ kinds: typeof kinds === "function" ? kinds() : kinds, extensions: [], signers }));
      }
      res.writeHead(404); res.end();
    });
  });
  return new Promise((r) => srv.listen(port, () => r(srv)));
}

/** Boot a paid-mode server and return the decoded accepts for one route. */
async function acceptsFor(env, port, facPort, kinds, signers) {
  const fac = await stubFacilitator(facPort, kinds, signers);
  let log = "";
  const child = spawn(process.execPath, ["src/server.js"], {
    env: {
      ...process.env, PORT: String(port), FREE_MODE: "", NETWORK: "base",
      PAYMENT_NETWORKS: "base", FACILITATOR_URL: `http://127.0.0.1:${facPort}`,
      CDP_API_KEY_ID: "", CDP_API_KEY_SECRET: "",
      WALLET_ADDRESS: "0x000000000000000000000000000000000000dEaD",
      X402_INDEX_CRAWL: "off", STATS_ALLOW_EPHEMERAL: "true",
      ...env,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout.on("data", (d) => { log += d; });
  child.stderr.on("data", (d) => { log += d; });
  const base = `http://127.0.0.1:${port}`;
  let up = false;
  for (let i = 0; i < 240; i++) {
    try { if ((await fetch(`${base}/health`)).ok) { up = true; break; } } catch { /* booting */ }
    await wait(250);
  }
  let accepts = null, status = 0;
  if (up) {
    const r = await fetch(`${base}/api/uuid`);
    status = r.status;
    const hdr = r.headers.get("payment-required");
    if (hdr) { try { accepts = JSON.parse(Buffer.from(hdr, "base64").toString("utf8")).accepts || []; } catch { /* */ } }
  }
  try { child.kill("SIGKILL"); } catch { /* */ }
  try { fac.close(); } catch { /* */ }
  await wait(200);
  return { up, status, accepts, log };
}

const P = 3960 + (process.pid % 20);

// --- 1. DEFAULT: unset means byte-identical to today -------------------------
{
  const { up, status, accepts, log } = await acceptsFor({}, P, P + 40, [kind("exact"), kind("upto")]);
  ok(up, "server booted with upto unset");
  if (!up) console.error(log.slice(-1200));
  ok(status === 402, `paywall active (got ${status})`);
  const schemes = [...new Set((accepts || []).map((a) => a.scheme))];
  ok(schemes.includes("exact"), "exact is offered");
  ok(!schemes.includes("upto"),
    `upto is NOT offered by default even when the facilitator advertises it (got ${schemes.join(",")})`);
}

// --- 2. OPT-IN + facilitator advertises it -> dual-advertised ---------------
// The upgrade must be ADDITIVE. An exact-only buyer has to keep negotiating
// exactly as before, which is why exact must still be present at the same
// amount rather than replaced.
{
  const { up, status, accepts } = await acceptsFor(
    { X402_UPTO_NETWORKS: BASE_CAIP2 }, P + 1, P + 41, [kind("exact"), kind("upto")]);
  ok(up && status === 402, "server booted with upto opted in");
  const schemes = (accepts || []).map((a) => a.scheme);
  ok(schemes.includes("upto"), `upto is offered when opted in (got ${schemes.join(",")})`);
  ok(schemes.includes("exact"), "exact is STILL offered — the change is additive, not a replacement");
  const ex = (accepts || []).find((a) => a.scheme === "exact");
  const up2 = (accepts || []).find((a) => a.scheme === "upto");
  ok(ex && up2 && ex.amount === up2.amount,
    `both schemes quote the same amount, so no buyer pays more than today (exact=${ex?.amount} upto=${up2?.amount})`);
  ok(ex && up2 && ex.payTo === up2.payTo, "and both settle to the same payTo");
}

// --- 2b. ONE SIGNER ON EVERY REPLICA ------------------------------------------
// A facilitator with several signers may name a different one on each
// /supported call. Two processes booted against it must still offer the same
// upto requirements, or a paid retry that lands on the other replica finds no
// match. Each boot here reads a stub that names a random signer per call.
{
  const SIGNERS = ["0x5555555555555555555555555555555555555555", "0x3333333333333333333333333333333333333333",
    "0x9999999999999999999999999999999999999999", "0x1111111111111111111111111111111111111111", "0x7777777777777777777777777777777777777777"];
  let calls = 0;
  const rotating = () => { calls++; return [kind("exact"), { ...kind("upto"), extra: { facilitatorAddress: SIGNERS[(calls + process.pid) % SIGNERS.length] } }]; };
  const named = [];
  for (const i of [0, 1, 2]) {
    const { up, accepts } = await acceptsFor({ X402_UPTO_NETWORKS: BASE_CAIP2 }, P + 6 + i, P + 46 + i, rotating, { "eip155:*": SIGNERS });
    ok(up, `replica ${i + 1} booted against a facilitator that rotates its signer`);
    named.push((accepts || []).find((a) => a.scheme === "upto")?.extra?.facilitatorAddress || null);
  }
  ok(calls >= 3, `the stub was read on every boot (${calls} reads), so each boot saw its own random signer`);
  ok(named.every((a) => a && a.toLowerCase() === SIGNERS[3]), `every replica offers the same upto signer, the lowest published (${named.join(", ")})`);
}
{
  const { pinUptoFacilitatorAddress: pin } = await import("../src/upto-signer.js");
  const sup = (addr, signers) => ({ kinds: [{ x402Version: 2, scheme: "upto", network: BASE_CAIP2, extra: { facilitatorAddress: addr, other: 1 } }, { x402Version: 2, scheme: "exact", network: BASE_CAIP2, extra: { facilitatorAddress: "0x9" } }], signers });
  const L = { "eip155:*": ["0xBB", "0xaa", "0xCc"] };
  const r = pin(sup("0xCc", L));
  ok(r.kinds[0].extra.facilitatorAddress === "0xaa" && r.kinds[0].extra.other === 1, "a listed signer is pinned to the lowest listed address, other extra fields kept");
  ok(r.kinds[1].extra.facilitatorAddress === "0x9", "an exact kind is never touched");
  ok(pin(sup("0xDD", L)).kinds[0].extra.facilitatorAddress === "0xDD", "an address outside the published list is left as the facilitator sent it");
  ok(pin(sup("0xCc", {})).kinds[0].extra.facilitatorAddress === "0xCc", "an answer with no signer list is left as sent");
  ok(pin(sup("0xCc", { [BASE_CAIP2]: ["0xCc", "0x0b"] })).kinds[0].extra.facilitatorAddress === "0x0b", "an exact-network signer list counts too");
  ok(pin(sup("0xCc", { "solana:*": ["0x01", "0xCc"] })).kinds[0].extra.facilitatorAddress === "0xCc", "another chain family's list does not count");
  const src = (await import("node:fs")).readFileSync(new URL("../src/payments.js", import.meta.url), "utf8");
  ok(/promise: orig\(\)\.then\(pinUptoFacilitatorAddress\)/.test(src), "every facilitator's /supported answer passes through the pin");
}

// --- 3. THE GATE WITH TEETH: opted in, facilitator does NOT advertise upto ---
// Offering it here would take a signature and then fail the buyer.
{
  const { up, status, accepts, log } = await acceptsFor(
    { X402_UPTO_NETWORKS: BASE_CAIP2 }, P + 2, P + 42, [kind("exact")]);
  ok(up, "server booted when the facilitator lacks upto");
  ok(status === 402, `and the paywall still builds a 402 rather than 500ing (got ${status})`);
  const schemes = [...new Set((accepts || []).map((a) => a.scheme))];
  ok(!schemes.includes("upto"),
    `upto is REFUSED when no facilitator advertises it (got ${schemes.join(",")})`);
  ok(schemes.includes("exact"), "exact is unaffected by the refusal");
  ok(/REFUSING to offer upto/.test(log), "and the refusal is logged loudly, not silently swallowed");
}

// --- 4. An unserved network in the opt-in list is ignored --------------------
{
  const { up, status, accepts } = await acceptsFor(
    { X402_UPTO_NETWORKS: "eip155:999999" }, P + 3, P + 43, [kind("exact"), kind("upto")]);
  ok(up && status === 402, "server booted with an unserved network opted in");
  const schemes = [...new Set((accepts || []).map((a) => a.scheme))];
  ok(!schemes.includes("upto"), "a network we do not serve never gains a scheme");
}

// --- 5. Identity-bound routes NEVER offer upto (security audit A402-03) -----
// Those handlers derive the caller from the signed EIP-3009 authorization.from;
// upto's payload is Permit2-shaped and payerFromRequest deliberately cannot read
// it. Advertising upto there offers a rail the route structurally cannot serve.
// The first version of this feature broke that invariant precisely because this
// suite only ever probed /api/uuid.
{
  const fac = await stubFacilitator(P + 45, [kind("exact"), kind("upto")]);
  const port = P + 5;
  const child = spawn(process.execPath, ["src/server.js"], {
    env: {
      ...process.env, PORT: String(port), FREE_MODE: "", NETWORK: "base",
      PAYMENT_NETWORKS: "base", FACILITATOR_URL: `http://127.0.0.1:${P + 45}`,
      CDP_API_KEY_ID: "", CDP_API_KEY_SECRET: "",
      WALLET_ADDRESS: "0x000000000000000000000000000000000000dEaD",
      X402_INDEX_CRAWL: "off", STATS_ALLOW_EPHEMERAL: "true",
      X402_UPTO_NETWORKS: BASE_CAIP2,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const base = `http://127.0.0.1:${port}`;
  let up = false;
  for (let i = 0; i < 240; i++) {
    try { if ((await fetch(`${base}/health`)).ok) { up = true; break; } } catch { /* booting */ }
    await wait(250);
  }
  ok(up, "server booted for the identity-bound check");
  const schemesOn = async (path) => {
    const r = await fetch(`${base}${path}`);
    const hdr = r.headers.get("payment-required");
    if (!hdr) return { status: r.status, schemes: [] };
    try { return { status: r.status, schemes: [...new Set((JSON.parse(Buffer.from(hdr, "base64").toString("utf8")).accepts || []).map((a) => a.scheme))] }; }
    catch { return { status: r.status, schemes: [] }; }
  };
  const mem = await schemesOn("/api/memory?key=k");
  ok(mem.status === 402, `an identity-bound route still demands payment (got ${mem.status})`);
  ok(!mem.schemes.includes("upto"),
    `an identity-bound route offers NO upto even with the gate on (got ${mem.schemes.join(",")})`);
  ok(mem.schemes.includes("exact"), "and still offers exact, so it remains payable");
  const norm = await schemesOn("/api/uuid");
  ok(norm.schemes.includes("upto"), "while an ordinary tool on the same server does offer upto");
  try { child.kill("SIGKILL"); } catch { /* */ }
  try { fac.close(); } catch { /* */ }
  await wait(200);
}

// --- 6. A chain we cannot PRICE is refused, not offered ---------------------
// A facilitator advertising upto says nothing about whether we can price the
// asset. The stock scheme has no money override for Celo/Robinhood/Optimism/
// Avalanche/Sei, so parsePrice throws while the 402 is built - and because one
// throwing option aborts the WHOLE accepts array, that 500s every paid route on
// every chain, not just the offending one. The gate must prove pricing, not
// trust the advertisement.
{
  const facPort = P + 46;
  const fac = await stubFacilitator(facPort, [
    kind("exact"), kind("upto"),
    { x402Version: 2, scheme: "exact", network: "eip155:42220" },
    { x402Version: 2, scheme: "upto", network: "eip155:42220" }, // Celo: unpriceable by the stock scheme
  ]);
  const port = P + 6;
  let log = "";
  const child = spawn(process.execPath, ["src/server.js"], {
    env: {
      ...process.env, PORT: String(port), FREE_MODE: "", NETWORK: "base",
      PAYMENT_NETWORKS: "base,celo", FACILITATOR_URL: `http://127.0.0.1:${facPort}`,
      CELO_FACILITATOR_URL: `http://127.0.0.1:${facPort}`, CELO_FACILITATOR_KEY: "test",
      CDP_API_KEY_ID: "", CDP_API_KEY_SECRET: "",
      WALLET_ADDRESS: "0x000000000000000000000000000000000000dEaD",
      X402_INDEX_CRAWL: "off", STATS_ALLOW_EPHEMERAL: "true",
      X402_UPTO_NETWORKS: "all",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout.on("data", (d) => { log += d; });
  child.stderr.on("data", (d) => { log += d; });
  const base = `http://127.0.0.1:${port}`;
  let up = false;
  for (let i = 0; i < 240; i++) {
    try { if ((await fetch(`${base}/health`)).ok) { up = true; break; } } catch { /* booting */ }
    await wait(250);
  }
  ok(up, "server booted with an unpriceable chain opted in");
  const r = await fetch(`${base}/api/uuid`);
  ok(r.status === 402,
    `THE SITE-WIDE GUARD: a Base route still returns 402, not 500, when an unpriceable chain was opted in (got ${r.status})`);
  ok(Boolean(r.headers.get("payment-required")), "and the 402 still carries a payable quote");
  try { child.kill("SIGKILL"); } catch { /* */ }
  try { fac.close(); } catch { /* */ }
  await wait(200);
}

console.log(`\n${fail ? "FAILED" : "OK"}: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
