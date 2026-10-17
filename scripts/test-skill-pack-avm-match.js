#!/usr/bin/env node
// The Algorand accept on every skill pack, and what a refusal for the BUYER'S
// balance looks like to the buyer and to the weekly sweep.
//
//   node scripts/test-skill-pack-avm-match.js      (offline: stub facilitator kinds, no chain)
//
// Pins:
//   - every skill pack's 402 is built the way the paid request rebuilds it,
//     through the real resource server and the real AVM scheme, and a payment
//     that echoes the Algorand accept matches (the amount is the pack price in
//     micro-USDC; an echo that differs by one unit or by the fee payer does not);
//   - the five routes that offer no Algorand accept are the long-running media
//     tiers and the identity-bound attest route, the two reasons the sweep
//     imports from the server rather than restating;
//   - a facilitator VERIFY refusal for the buyer's balance ("underflow on
//     subtracting <price> from sender amount <held>", the AVM simulation's
//     words) answers the buyer as insufficient-funds with a fund-wallet retry,
//     for a credential that carries no EVM payer, and the sweep reads that 402
//     as its own wallet being unfunded, never as a rail failure.
import { readFileSync } from "node:fs";

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log(`ok - ${m}`); } else { fail++; console.error(`FAIL - ${m}`); } };

const ALGO = "algorand:wGHE2Pwdvd7S12BL5FaOP20EGYesN73ktiC1qzkkit8=";
const PAYTO = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAY5HFKQ";
const FEE_PAYER = "BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB";
const TREASURY = "0x" + "ab".repeat(20);

const { x402ResourceServer } = await import("@x402/core/server");
const { ExactAvmScheme } = await import("@x402/avm/exact/server");
const { acceptsForItem, isIdentityBoundRoute } = await import("../src/payments.js");
const { isLongRunningSlug } = await import("../src/composite-spend-guard.js");
const { buildSkillTools } = await import("../src/tools/skill-runner.js");
const { PACK_PRICES } = await import("../src/skills.js");

// A facilitator that supports exactly the live Algorand kind, fee payer included.
const facilitator = { getSupported: async () => ({ kinds: [{ x402Version: 2, scheme: "exact", network: ALGO, extra: { feePayer: FEE_PAYER } }] }) };
const server = new x402ResourceServer([facilitator]).register(ALGO, new ExactAvmScheme());
await server.initialize();

const rails = { evmCaip2: ["eip155:8453"], svmCaip2: [], stellarCaip2: [], avmCaip2: [ALGO], walletAddress: TREASURY, solanaWallet: "", stellarWallet: "", algorandWallet: PAYTO, uptoCaip2: [] };
const packs = buildSkillTools({ getCatalog: () => ({}) });
ok(packs.length >= 60, `the skill packs are built (${packs.length})`);

// ---- every pack: the 402's Algorand accept and a payment that echoes it ----
{
  let matched = 0, priced = 0, controls = 0;
  const unmatched = [];
  for (const pack of packs) {
    const options = acceptsForItem(pack, rails).filter((o) => o.network === ALGO);
    if (options.length !== 1) { unmatched.push(`${pack.slug}: ${options.length} Algorand options`); continue; }
    const requirements = await server.buildPaymentRequirementsFromOptions(options, { adapter: { req: {} } });
    const req = requirements.find((r) => r.network === ALGO);
    if (!req) { unmatched.push(`${pack.slug}: no Algorand requirement built`); continue; }
    const slug = pack.slug.replace(/^skill-/, "");
    if (req.amount === String(Math.round(PACK_PRICES[slug] * 1e6)) && req.asset === "31566704" && req.payTo === PAYTO && req.extra?.feePayer === FEE_PAYER) priced++;
    // The buyer echoes the accept it was given, exactly.
    const payment = { x402Version: 2, scheme: "exact", network: ALGO, accepted: structuredClone(req), payload: { transaction: "AAAA" } };
    if (server.findMatchingRequirements(requirements, payment) === req) matched++;
    else unmatched.push(`${pack.slug}: echoed accept matched nothing`);
    // Controls: one micro-unit off, or another fee payer, matches nothing.
    const offByOne = { ...payment, accepted: { ...payment.accepted, amount: String(Number(req.amount) + 1) } };
    const otherPayer = { ...payment, accepted: { ...payment.accepted, extra: { ...payment.accepted.extra, feePayer: PAYTO } } };
    if (!server.findMatchingRequirements(requirements, offByOne) && !server.findMatchingRequirements(requirements, otherPayer)) controls++;
  }
  ok(unmatched.length === 0, `every pack's echoed Algorand accept matches the requirement the paid request rebuilds (${matched}/${packs.length})${unmatched.length ? `: ${unmatched.slice(0, 5).join("; ")}` : ""}`);
  ok(priced === packs.length, `...each at the pack price in micro-USDC, to our payTo, with the facilitator's fee payer (${priced}/${packs.length})`);
  ok(controls === packs.length, `...and an echo one unit off or naming another fee payer matches nothing (${controls}/${packs.length})`);
}

// ---- the five routes with no Algorand accept are expected by design ----
{
  for (const slug of ["image-gen-premium", "v1-images-fast", "v1-images-pro", "v1-images-edit", "v1-videos"]) ok(isLongRunningSlug(slug), `${slug} is long-running (EVM exact only: settlement runs after a handler that outlives an AVM validity window)`);
  ok(isIdentityBoundRoute({ slug: "attest" }) && !isLongRunningSlug("attest"), "attest is identity-bound (the handler needs the signed EIP-3009 payer)");
  const canary = readFileSync(new URL("./algorand-rail-canary.js", import.meta.url), "utf8");
  ok(/const expectedNoAvm = isIdentityBoundRoute\(t\) \|\| isLongRunningSlug\(t\.slug\);/.test(canary), "the sweep expects a missing Algorand accept from exactly those two server rules");
  ok(/EXIT_UNFUNDED = 3/.test(canary) && /if \(out === "unfunded"\) \{ unfunded\(\); break; \}/.test(canary) && /process\.exit\(EXIT_UNFUNDED\)/.test(canary), "...and stops with the funding exit code when its own wallet cannot pay");
}

// ---- a refusal for the buyer's balance: the hint, the credential, the sweep ----
{
  const vh = await import("../src/verify-hint.js");
  const { outcomeOf, isBuyerUnfunded, isGateRefusal } = await import("./avm-canary-classify.js");
  const { REJECTION_REASONS } = await import("../src/payment-reject.js");
  const reason = "Transaction simulation failed: transaction D37KIHORSUGGXXIFP5SEBNUBK2YZAEVCA7X5HAPCUCCFAGUND5XA: underflow on subtracting 15000 from sender amount 9135";
  const h = vh.hintFor({ reason, balanceUsd: null, priceUsd: 0.015, network: ALGO, payer: null });
  ok(h.reason === "insufficient-funds" && h.retry === "fund-wallet", `the AVM simulation's underflow is insufficient-funds with a fund-wallet retry (${h.reason}, ${h.retry})`);
  ok(/holds less of the asset than this call costs \(\$0\.015\) on algorand/.test(h.hint) && !/9135|15000/.test(h.hint), "...the hint names the price and the rail, never the facilitator's figures");
  ok(REJECTION_REASONS.some((r) => r.reason === "insufficient-funds"), "...and the class is documented with the other refusal classes");
  const control = vh.hintFor({ reason: "invalid_payload: contract call failed: execution reverted", balanceUsd: null, priceUsd: 0.01, network: "eip155:8453", payer: "0x" + "cd".repeat(20) });
  ok(control.reason === undefined && control.retry === "fresh-authorization", "control: a plain revert with no balance reading keeps its fresh-authorization hint and no class");
  // An AVM credential carries no authorization.from: the hint is still recorded, under the credential itself.
  const payload = { x402Version: 2, scheme: "exact", network: ALGO, accepted: { scheme: "exact", network: ALGO, amount: "15000", asset: "31566704", payTo: PAYTO }, payload: { transaction: "AAAA" } };
  const noted = await vh.noteVerifyFailure({ paymentPayload: payload, network: ALGO, reason, priceUsd: 0.015, balanceReader: async () => { throw new Error("must not read Base for an Algorand credential"); } });
  ok(noted && noted.reasonClass === "insufficient-funds" && noted.reason === reason && noted.bucket === "unknown", `a credential with no EVM payer still records its hint, class apart from the facilitator's text (bucket ${noted?.bucket})`);
  const remembered = vh.hintForCredential(vh.credentialKeyOf(payload));
  ok(remembered && remembered.reasonClass === "insufficient-funds" && remembered.retry === "fund-wallet", "...retrievable by the credential key the middleware derives from the header");
  // The middleware puts the class on the 402 body as `reason`, beside the hint.
  const header = Buffer.from(JSON.stringify(payload)).toString("base64");
  const req = { headers: { "payment-signature": header } };
  let sent = null;
  const res = { statusCode: 402, headersSent: false, setHeader() {}, getHeader: () => null, json(b) { sent = b; return this; } };
  vh.verifyHintMiddleware()(req, res, () => {});
  res.json({ error: "Payment rejected" });
  ok(sent && sent.reason === "insufficient-funds" && sent.retry === "fund-wallet" && /holds less of the asset/.test(sent.hint) && req.__paymentRejectReason === "insufficient-funds", `the 402 body carries reason insufficient-funds with the hint (${JSON.stringify(sent).slice(0, 80)})`);
  // The sweep's reading of that 402.
  const body = JSON.stringify({ reason: "insufficient-funds", hint: h.hint, retry: "fund-wallet", x402Version: 2, accepts: [] });
  ok(outcomeOf({ status: 402, body, elapsedMs: 300 }) === "unfunded" && outcomeOf({ status: 402, body, elapsedMs: 6000 }) === "unfunded", "a 402 naming insufficient-funds is the sweep's own wallet, fast or slow");
  ok(isBuyerUnfunded(402, body) && !isGateRefusal(402, body), "...never a gate refusal, so never a rail verdict");
  ok(outcomeOf({ status: 402, body: JSON.stringify({ reason: "requirements-mismatch", hint: "x" }), elapsedMs: 300 }) === "slow-402", "control: a named gate refusal is still a rail verdict");
  ok(!isBuyerUnfunded(402, JSON.stringify({ x402Version: 2, accepts: [], extensions: { bazaar: { info: { output: { example: { reason: "insufficient-funds" } } } } } })), "control: a reason nested in an extension example is not a refusal");
}

console.log(`\ntest-skill-pack-avm-match: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
