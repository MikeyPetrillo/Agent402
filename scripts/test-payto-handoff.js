// Base payTo handoff (src/payto-handoff.js): a seller's old wallet's history
// counts for its new wallet on its own origin only when the origin serves a
// handoff document, the old wallet signed it for this origin, and the origin's
// 402 already asks for the new wallet. Offline: real signatures from local
// keys, no network.
import { privateKeyToAccount } from "viem/accounts";
import { verifyMessage } from "viem";
import { parseHandoff, handoffMessage, verifyHandoff, createHandoffStore, attachHandoffs, HANDOFF_NETWORK } from "../src/payto-handoff.js";
import { evidencePayToVerdict, dispatchEligibility } from "../src/dispatch-eligibility.js";
import { baseLiveGate } from "../src/evidence-binding.js";

let failed = 0;
const ok = (c, m) => { if (c) console.log("ok - " + m); else { failed++; console.log("FAIL - " + m); } };

const OLD = privateKeyToAccount("0x" + "11".repeat(32));
const NEW = privateKeyToAccount("0x" + "22".repeat(32));
const OTHER = privateKeyToAccount("0x" + "33".repeat(32));
const A = OLD.address.toLowerCase(), B = NEW.address.toLowerCase(), C = OTHER.address.toLowerCase();
const ORIGIN = "https://pay.example.com";
const NOW = Date.parse("2026-10-28T12:00:00Z");
const issuedAt = "2026-10-28T11:00:00Z";
const sign = (acct, fields) => acct.signMessage({ message: handoffMessage(fields) });
const docFor = async ({ signer = OLD, origin = ORIGIN, from = A, to = B, at = issuedAt, extra = {} } = {}) =>
  ({ version: 1, network: HANDOFF_NETWORK, from, to, issuedAt: at, signature: await sign(signer, { origin, from, to, issuedAt: at }), ...extra });
const localVerify = ({ address, message, signature }) => verifyMessage({ address, message, signature });
const run = (doc, over = {}) => verifyHandoff({ origin: ORIGIN, readDocument: async () => doc, livePayTo: () => B, verifySignature: localVerify, now: NOW, ...over });

// ---- the message ----
ok(handoffMessage({ origin: ORIGIN, from: A.toUpperCase().replace("0X", "0x"), to: B, issuedAt }) === `Agent402 payTo handoff\norigin: ${ORIGIN}\nnetwork: eip155:8453\nfrom: ${A}\nto: ${B}\nissued: ${issuedAt}`, "the signed message is six fixed lines with lowercase wallets");

// ---- document parsing: only validated fields are read ----
{
  const good = await docFor();
  ok(parseHandoff(good, { now: NOW }).ok, "a well-formed document parses");
  ok(parseHandoff({ ...good, note: "<script>", origin: "https://evil.example" }, { now: NOW }).ok, "unknown fields are ignored, never used");
  const reject = [
    [null, "not an object"], [[good], "an array"], ["text", "a string"],
    [{ ...good, version: 2 }, "another version"], [{ ...good, network: "eip155:1" }, "another network"],
    [{ ...good, from: "0x123" }, "a short address"], [{ ...good, to: `${B}\norigin: https://evil.example` }, "a newline smuggled into an address"],
    [{ ...good, from: B }, "from equal to to"], [{ ...good, to: "0x" + "0".repeat(40) }, "the zero address"],
    [{ ...good, issuedAt: `${issuedAt}\nto: ${C}` }, "a newline smuggled into issuedAt"], [{ ...good, issuedAt: "yesterday" }, "a non-ISO time"],
    [{ ...good, issuedAt: "2026-10-29T12:00:00Z" }, "a future time"], [{ ...good, issuedAt: "2026-09-01T12:00:00Z" }, "a time older than 30 days"],
    [{ ...good, signature: "not-hex" }, "a non-hex signature"], [{ ...good, signature: "0x" + "ab".repeat(7000) }, "an oversized signature"],
    [{ ...good, from: { toString: () => A } }, "an object in place of an address"],
  ];
  for (const [d, why] of reject) ok(parseHandoff(d, { now: NOW }).ok === false, `rejected: ${why}`);
}

// ---- verification: both proofs and the live payTo ----
{
  const r = await run(await docFor());
  ok(r.ok && r.record.from === A && r.record.to === B && r.record.origin === ORIGIN, "old wallet's signature + live payTo at the new wallet -> verified");
  ok(!(await run(await docFor({ signer: OTHER }))).ok, "a signature by any other wallet is refused");
  ok(!(await run(await docFor({ signer: NEW }))).ok, "a signature by the NEW wallet is refused (only the old wallet can hand off)");
  ok(!(await run(await docFor({ origin: "https://other.example.com" }))).ok, "a signature made for another origin is refused here");
  const tampered = await docFor(); tampered.to = C;
  ok(!(await run(tampered, { livePayTo: () => C })).ok, "changing `to` after signing is refused");
  ok(!(await run(await docFor(), { livePayTo: () => C })).ok, "refused while the origin's 402 asks for a different wallet");
  ok(!(await run(await docFor(), { livePayTo: () => null })).ok, "refused while the origin's Base payTo is unknown");
  ok(!(await run(null)).ok, "refused when the origin serves no document");
  ok(!(await run(await docFor(), { isExcludedWallet: (w) => w === A })).ok, "refused when the old wallet is shared or self-funded");
  ok(!(await run(await docFor(), { isExcludedWallet: (w) => w === B })).ok, "refused when the new wallet is shared or self-funded");
  const flaky = await run(await docFor(), { verifySignature: async () => { throw new Error("rpc down"); } });
  ok(!flaky.ok && flaky.retry === true, "a failed chain read is a retryable refusal, never a pass");
  ok(!(await run(await docFor(), { verifySignature: async () => "true" })).ok, "only a boolean true from the verifier passes");
  // The old wallet must be this origin's own, and no other payee may still use it.
  let asked = null;
  const own = await run(await docFor(), { oldWalletProblem: (r) => { asked = r; return "another listed origin is still paid at the old wallet"; } });
  ok(!own.ok && /still paid at the old wallet/.test(own.reason) && asked?.origin === ORIGIN && asked?.from === A && asked?.to === B, "refused when the old wallet is not this origin's own or still pays another origin (the check sees origin, from and to)");
  // Wrapped signatures (ERC-6492 counterfactual, ERC-8010) are refused before any chain read.
  let reads = 0;
  const wrapped = await docFor(); wrapped.signature = wrapped.signature + "6492".repeat(16);
  ok(!(await run(wrapped, { verifySignature: async () => { reads++; return true; } })).ok && reads === 0, "an ERC-6492 wrapped signature is refused without a chain read");
  const wrapped8010 = await docFor(); wrapped8010.signature = wrapped8010.signature + "8010".repeat(16);
  ok(!(await run(wrapped8010, { verifySignature: async () => { reads++; return true; } })).ok && reads === 0, "an ERC-8010 wrapped signature is refused without a chain read");
}

// ---- store: one origin per old wallet ----
{
  const s = createHandoffStore();
  const rec = { origin: ORIGIN, network: HANDOFF_NETWORK, from: A, to: B, issuedAt, verifiedAt: issuedAt };
  ok((await s.put(rec)).ok && s.get(ORIGIN)?.to === B, "a verified record is stored");
  ok((await s.put({ ...rec, to: C })).ok && s.get(ORIGIN)?.to === C, "the same origin can replace its handoff");
  const clash = await s.put({ ...rec, origin: "https://second.example.com" });
  ok(!clash.ok && clash.conflict === true, "a second origin cannot hand off from the same old wallet");
  ok(!(await s.put({ ...rec, origin: "https://x.example", from: "nope" })).ok, "a malformed record is not stored");
}

// ---- the router's verdict ----
const clears = { settled: 80, payers: 5 };
const thin = { settled: 5, payers: 1 };
const bindingFor = ({ handoff = { from: A, to: B }, a = clears, b = thin } = {}) => ({ byWallet: new Map([[A, a], [B, b]]), settled: 80, payers: 5, ...(handoff ? { handoff } : {}) });
{
  ok(evidencePayToVerdict({ evidence: bindingFor({ handoff: null }), livePayTo: B }).verdict === "evidence_payto_mismatch", "without a handoff, history at the old wallet does not count for the new one");
  const v = evidencePayToVerdict({ evidence: bindingFor(), livePayTo: B });
  ok(v.ok && v.verdict === "evidence_payto_handoff" && v.payTos.includes(B), "with a handoff, the new wallet stands where the old one did");
  ok(!evidencePayToVerdict({ evidence: bindingFor({ a: thin }), livePayTo: B }).ok, "a handoff carries nothing when the old wallet's history does not clear the floor");
  ok(!evidencePayToVerdict({ evidence: bindingFor(), livePayTo: C }).ok, "a handoff does not let the origin be paid at a third wallet");
  ok(!evidencePayToVerdict({ evidence: bindingFor({ handoff: { from: C, to: B } }), livePayTo: B }).ok, "a handoff from a wallet with no history on this origin carries nothing");
  const d = dispatchEligibility({ routable: true, networks: ["eip155:8453"], settled: 80, payers: 5, spendChains: ["base"], evidence: bindingFor(), livePayTo: B });
  ok(d.chains?.base?.eligible === true, "dispatchEligibility: eligible on Base after the handoff");
  const g = baseLiveGate({ networks: ["eip155:8453"], settled: 80, payers: 5, priceUsd: 0.01, minSettled: 50, minPayers: 3, binding: bindingFor(), livePayTo: B });
  ok(g.ok && g.evidenceWallets.includes(B), "the resolver's live gate pays the new wallet");
}

// ---- attaching stored records to the binding ----
{
  const binding = new Map([[ORIGIN, { byWallet: new Map([[A, clears]]) }], ["https://other.example.com", { byWallet: new Map([[A, clears]]) }]]);
  attachHandoffs(binding, [{ origin: ORIGIN, from: A, to: B }, { origin: "https://unlisted.example", from: A, to: C }]);
  ok(binding.get(ORIGIN).handoff?.to === B, "a record attaches to its own origin");
  ok(!binding.get("https://other.example.com").handoff, "a record never attaches to another origin paid at the same old wallet");
  const b2 = new Map([[ORIGIN, { byWallet: new Map([[A, clears]]) }]]);
  attachHandoffs(b2, [{ origin: ORIGIN, from: A, to: B }], { isExcludedWallet: (w) => w === B });
  ok(!b2.get(ORIGIN).handoff, "a record naming an excluded wallet is not attached");
  const b3 = new Map([[ORIGIN, { byWallet: new Map([[A, clears]]) }]]);
  attachHandoffs(b3, [{ origin: ORIGIN, from: A, to: B }], { oldWalletProblem: () => "another listed origin is still paid at the old wallet" });
  ok(!b3.get(ORIGIN).handoff, "a stored record stops applying once another origin is paid at the old wallet");
  const b4 = new Map([[ORIGIN.toLowerCase(), { byWallet: new Map([[A, clears]]) }]]);
  attachHandoffs(b4, [{ origin: "https://Pay.Example.com", from: A, to: B }], { keyOf: (o) => o.toLowerCase() });
  ok(b4.get(ORIGIN.toLowerCase()).handoff?.to === B, "records attach through the binding's own key normalization");
}

// ---- the reviewer's attacks, against the functions the route and the evidence build call ----
{
  const { oldWalletProblem, findListedSeller } = await import("../src/payto-handoff.js");
  const n = (u) => String(u || "").replace(/\/+$/, "").toLowerCase();
  const V = "https://busy-seller.example", X = "https://stranger.example";
  // A busy seller V is paid at W=A; a stranger X once named A (so A is in X's list) and now asks for B.
  const ctxFor = (vPrimary) => ({
    summaries: new Map([
      [n(V), { origin: V, payToByNetwork: { [HANDOFF_NETWORK]: vPrimary }, payTosByNetwork: { [HANDOFF_NETWORK]: [vPrimary] } }],
      [n(X), { origin: X, payToByNetwork: { [HANDOFF_NETWORK]: B }, payTosByNetwork: { [HANDOFF_NETWORK]: [B, A] } }],
    ]),
    byPayTo: new Map([[A, new Set([V, X])], [B, new Set([X])]]),
    norm: n,
  });
  ok(/still paid at the old wallet/.test(oldWalletProblem({ origin: X, from: A, to: B }, ctxFor(A)) || ""), "attack 1: a wallet still paying another seller cannot be handed to a stranger's origin");
  ok(oldWalletProblem({ origin: X, from: A, to: B }, ctxFor(B)) === null, "the same operator moving two origins to one new wallet is allowed");
  ok(/not a Base payTo this origin advertised/.test(oldWalletProblem({ origin: X, from: C, to: B }, ctxFor(B)) || ""), "an old wallet the origin never advertised is refused");
  const brian = { summaries: new Map([[n(ORIGIN), { origin: ORIGIN, payToByNetwork: { [HANDOFF_NETWORK]: B }, payTosByNetwork: { [HANDOFF_NETWORK]: [B, A.toUpperCase().replace("0X", "0x")] } }]]), byPayTo: new Map([[A, new Set([ORIGIN])]]), norm: n };
  ok(oldWalletProblem({ origin: ORIGIN, from: A, to: B }, brian) === null, "an origin that rotated its own wallet (checksummed in the listing) qualifies");
  // Attack 2: a different-case path on the same host must not stand for the listed seller.
  const sellers = [{ origin: "https://host.example/foo" }];
  const r = findListedSeller(sellers, "https://host.example/FOO", n);
  ok(!r.listed && r.near?.origin === "https://host.example/foo", "attack 2: a case-variant path does not match the listed seller (the answer names the exact spelling)");
  ok(findListedSeller(sellers, "https://host.example/foo", n).listed?.origin === "https://host.example/foo", "the exact listed spelling matches");
}

// ---- booted: the route takes only an origin and refuses before any fetch ----
{
  const { spawn } = await import("node:child_process");
  const { getFreePort } = await import("./lib/free-port.js");
  const { mkdtempSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const dir = mkdtempSync(join(tmpdir(), "handoff-"));
  const PORT = await getFreePort();
  const base = `http://127.0.0.1:${PORT}`;
  const child = spawn(process.execPath, ["src/server.js"], {
    env: { ...process.env, FREE_MODE: "true", PORT: String(PORT), X402_INDEX_CRAWL: "off", X402_SYNC_ON_START: "false", SOR_PAYTO_HANDOFFS_FILE: join(dir, "handoffs.json"), MEMORY_DB_FILE: join(dir, "mem.db") },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let log = "";
  child.stdout.on("data", (d) => { log += d; });
  child.stderr.on("data", (d) => { log += d; });
  try {
    let up = false;
    for (let i = 0; i < 120 && !up; i++) {
      try { up = (await fetch(`${base}/health`)).ok; } catch { /* booting */ }
      if (!up) await new Promise((r) => setTimeout(r, 500));
    }
    if (!up) console.error(log.slice(-800));
    ok(up, "booted: server up");
    const post = (body) => fetch(`${base}/api/index/payto-handoff`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    ok((await post({ origin: "http://127.0.0.1:1/" })).status === 400, "booted: a non-https or private origin is a 400");
    ok((await post({ origin: "not a url" })).status === 400, "booted: a malformed origin is a 400");
    ok((await post({})).status === 400, "booted: a missing origin is a 400");
    const unlisted = await post({ origin: "https://unlisted-handoff.example.com" });
    ok(unlisted.status === 404 && /register it first/.test((await unlisted.json()).error || ""), "booted: an origin the index does not list is a 404 naming registration");
    ok(!/handoff document|safeFetch|fetch failed/.test(log), "booted: nothing was fetched for refused calls");
  } finally {
    try { child.kill("SIGKILL"); } catch { /* gone */ }
  }
}

console.log(failed ? `${failed} failed` : "all passed");
process.exit(failed ? 1 : 0);
