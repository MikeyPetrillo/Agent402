// Coverage lock for The 500's new tools (v2.0.0 overhaul) — offline, no server.
//
// scripts/test-all.js sweeps every catalog entry it finds in /openapi.json, so a
// tool is only ever silently untested if (a) it lost its discovery example (the
// sweep would call it with an empty body) or (b) its route sits in a skip set
// (BRAVE_ROUTES) that excludes it from the run entirely. This test pins both
// for the 30 tools built in the overhaul (plus evm-rpc from the same era):
//
//   1. each slug still exists in its kit export with a discovery example, so
//      the answers-own-example assertion is real;
//   2. no new-tool route is in test-all.js's BRAVE_ROUTES skip set, except the
//      single documented exception below;
//   3. the paid-canary legs stay honest: every leg is well-shaped, the
//      finance legs exist, and their display priceUsd matches the kit's
//      advertised price (guards the stale-price drift found in the audit).
//
// Run: node scripts/test-canary-coverage.js  (pure imports + source parsing)
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { CONTRACT_TOOLS } from "../src/tools/contract-kit.js";
const { requireUpstreamCosts } = await import("./lib/require-upstream-costs.js");
requireUpstreamCosts("test-canary-coverage");
import { CRYPTO_TOOLS } from "../src/tools/crypto-kit.js";
import { FINANCE_TOOLS } from "../src/tools/finance-kit.js";
import { STT_TOOLS } from "../src/tools/stt-kit.js";
import { ENRICH_TOOLS } from "../src/tools/enrich-kit.js";
import { SEARCH_TOOLS } from "../src/tools/search.js";
import { X_DATA_TOOLS } from "../src/tools/x-data-kit.js";
import { WEB_TOOLS } from "../src/tools/web-kit.js";
import { IMAGE_TOOLS } from "../src/tools/image-kit.js";
import { KIT2 } from "../src/tools/kit2.js";
import { DATA_TOOLS } from "../src/tools/data-kit.js";
import { CHAIN_TOOLS } from "../src/tools/chain-kit.js";
import { TOOLS as CANARY_LEGS } from "./paid-canary.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log(`ok - ${m}`); } else { fail++; console.error(`FAIL - ${m}`); } };

// The 30 tools of The 500 phase 2 (t1 contract ×7, t2 market feeds ×6,
// t3 enrich ×5, t4 web/content ×4, t5 media/format ×5, t6 locale/time ×3),
// plus evm-rpc (demand batch, same launch window). slug → hosting kit export.
const NEW_TOOLS = [
  ...["contract-source", "contract-abi", "solidity-scan", "calldata-decode", "selector-lookup", "tx-simulate", "address-label"].map((s) => [s, CONTRACT_TOOLS, "contract-kit"]),
  ...["crypto-orderbook", "stablecoin-peg"].map((s) => [s, CRYPTO_TOOLS, "crypto-kit"]),
  ...["lei-lookup", "wikidata-entity", "gravatar-check", "github-repo", "favicon-grab"].map((s) => [s, ENRICH_TOOLS, "enrich-kit"]),
  ...["search-videos"].map((s) => [s, SEARCH_TOOLS, "search-kit"]),
  ...["archive-snapshot", "feed-parse", "unshorten-url"].map((s) => [s, WEB_TOOLS, "web-kit"]),
  ...["image-exif", "image-dominant-color", "image-crop"].map((s) => [s, IMAGE_TOOLS, "image-kit"]),
  ...["srt-convert", "json-schema-infer", "ics-parse"].map((s) => [s, KIT2, "kit2"]),
  ...["public-holidays", "country-info"].map((s) => [s, DATA_TOOLS, "data-kit"]),
  ...["evm-rpc"].map((s) => [s, CHAIN_TOOLS, "chain-kit"]),
];

// The ONE documented sweep exception: search-videos sits in BRAVE_ROUTES
// (skipped unless BRAVE_LIVE_TEST=1 — a Brave-subscription budget decision).
// Its input validation runs on every CI pass via scripts/test-search-kit.js;
// the live answers-own-example path is opt-in there too. Any OTHER new tool
// landing in a skip set fails this test.
const DOCUMENTED_SKIPS = new Set(["/api/search-videos"]);

// --- parse test-all.js's skip/lenient sets from source (strip // comments
// first: NETWORK's inline comments contain quoted words that are not routes).
const testAllSrc = readFileSync(join(ROOT, "scripts", "test-all.js"), "utf8").replace(/\/\/[^\n]*/g, "");
function extractSet(name) {
  const m = testAllSrc.match(new RegExp(`const ${name} = new Set\\(\\[([\\s\\S]*?)\\]\\)`));
  if (!m) return null;
  return new Set([...m[1].matchAll(/"([^"]+)"/g)].map((x) => x[1]));
}
const BRAVE_ROUTES = extractSet("BRAVE_ROUTES");
const NETWORK = extractSet("NETWORK");
ok(BRAVE_ROUTES && BRAVE_ROUTES.size > 0, "parsed BRAVE_ROUTES skip set out of test-all.js");
ok(NETWORK && NETWORK.size > 50, "parsed NETWORK lenient set out of test-all.js");

// --- 1 + 2: every new tool is defined, example-backed, and actually swept ---
for (const [slug, kitTools, kitName] of NEW_TOOLS) {
  const t = kitTools.find((x) => x.slug === slug);
  ok(!!t, `${slug} is defined in ${kitName}`);
  if (!t) continue;
  ok(!!(t.discovery && (t.discovery.input || t.discovery.example)), `${slug} has a discovery example (answers-own-example is real)`);
  const path = (t.route || "").split(" ").pop();
  ok(path.startsWith("/"), `${slug} route parses to a path (${t.route})`);
  const skipped = BRAVE_ROUTES?.has(path);
  if (DOCUMENTED_SKIPS.has(path)) {
    ok(skipped, `${slug} documented exception still matches reality (in BRAVE_ROUTES; validation covered by test-search-kit.js)`);
    console.warn(`      NOTE: ${slug} is NOT swept by test-all.js in default CI (BRAVE_LIVE_TEST!=1) — known, documented skip`);
  } else {
    ok(!skipped, `${slug} is swept by test-all.js (not in a skip set) [${NETWORK?.has(path) ? "lenient/NETWORK" : "strict"}]`);
  }
}

// --- 3: paid-canary legs stay honest ---
const advertised = (kitTools, slug) => {
  const t = kitTools.find((x) => x.slug === slug);
  return t ? Number(String(t.price).replace(/[^0-9.]/g, "")) : NaN;
};
for (const leg of CANARY_LEGS) {
  const okShape = typeof leg.kit === "string" && typeof leg.path === "string" && leg.path.startsWith("/")
    && ["GET", "POST"].includes(leg.method) && typeof leg.priceUsd === "number" && typeof leg.check === "function";
  if (!okShape) { fail++; console.error(`FAIL - malformed canary leg: ${JSON.stringify({ kit: leg.kit, path: leg.path })}`); }
}
pass++; console.log(`ok - all ${CANARY_LEGS.length} canary legs are well-shaped (kit/path/method/priceUsd/check)`);

const legFor = (route) => CANARY_LEGS.find((l) => l.path === route || l.path.startsWith(`${route}?`));
const xt = legFor("/api/x-tweet");
ok(!!xt && xt.method === "POST" && xt.body?.id === "20", "canary has an x-tweet leg (POST, post 20) - the X bearer + prepaid balance are proven daily on prod, not by the first buyer");
if (xt) ok(Number.isInteger(xt.weekday) && xt.weekday >= 0 && xt.weekday <= 6, "x-tweet leg is weekly (weekday 0-6): it draws the prepaid X balance the announce posts share");
if (xt) ok(xt.priceUsd === advertised(X_DATA_TOOLS, "x-tweet"), `x-tweet leg priceUsd (${xt?.priceUsd}) matches the kit's advertised price ($${advertised(X_DATA_TOOLS, "x-tweet")})`);
const sq = legFor("/api/stock-quote");
ok(!!sq, "canary has a stock-quote leg");
if (sq) ok(sq.priceUsd === advertised(FINANCE_TOOLS, "stock-quote"), `stock-quote leg priceUsd (${sq?.priceUsd}) matches the kit's advertised price ($${advertised(FINANCE_TOOLS, "stock-quote")}) — no stale display price`);
const tr = CANARY_LEGS.find((l) => l.kit === "transcribe");
const STT_EXAMPLE_URL = STT_TOOLS.find((t) => t.slug === "transcribe")?.discovery?.input?.url;
const trExample = STT_EXAMPLE_URL;
ok(!!tr && tr.priceUsd === 0.03 && tr.body?.url === trExample, `transcribe leg exists at $0.03 and buys the tool's own documented example, a spoken clip (got ${tr ? `$${tr.priceUsd} ${tr.body?.url}` : "no leg"})`);

// The Ox leg is the only standing proof of two things a stub cannot show: that
// our `provider.max_price` bound admits a $0-priced endpoint (if it refused the
// bound, every call would 502), and that the stealth model is still listed at
// all. When the preview ends, this leg is the alarm.
// Ox Alpha: the stealth upstream model left OpenRouter's catalog (the route
// answers 503 "no longer served" and drops from /v1/models), so the canary
// carries NO leg for it any more - a leg that can only warn is noise, and
// its 2026-08-27 warning was one of five nobody read. Retiring the route
// itself (OX_ALPHA_ENABLED=off) is a Railway variable, the operator's call.
ok(!legFor("/v1/ox/chat/completions"), "no Ox Alpha leg while the stealth model is gone upstream");

// The render leg is the only one that exercises the secretless browser/media
// worker (F02/F04/F06) on the paid path — lock it so it can't silently drop.
// Its advertised price ($0.02) lives in src/server.js's catalog (not a *_TOOLS
// export this test imports), so the price is pinned as a literal here.
const rn = legFor("/api/render");
ok(!!rn, "canary has a render leg (exercises the secretless browser/media worker)");
if (rn) {
  ok(rn.method === "POST" && !!rn.body?.url, "render leg POSTs a { url } body to /api/render");
  ok(rn.priceUsd === 0.02, `render leg priceUsd (${rn?.priceUsd}) matches the advertised $0.02`);
  ok(rn.check({ rendered: true, title: "Example Domain", markdown: "# Example Domain\nThis domain is for use in illustrative examples." }) === true, "render leg check accepts the documented happy-path shape");
  ok(typeof rn.check({ rendered: false }) === "string", "render leg check rejects a non-rendered response");
  ok(typeof rn.check({ rendered: true, title: "Something Else", markdown: "x" }) === "string", "render leg check rejects an unexpected page (title mismatch)");
}

// The seller-dossier leg is the prod-side "non-empty for a real origin"
// assertion a board-backed tool needs (demand-radar sold an empty radar for
// six weeks because a keyless boot excused the empty shape). Its check must
// refuse the honest-unindexed shape and a hollow indexed one.
const sd = legFor("/api/seller-dossier");
ok(!!sd, "canary has a seller-dossier leg (proves the assembled answer on prod, where the index is warm)");
if (sd) {
  ok(sd.method === "POST" && typeof sd.body?.origin === "string" && sd.body.origin.includes("."), "seller-dossier leg POSTs a real { origin }");
  ok(sd.priceUsd === 0.05, `seller-dossier leg priceUsd (${sd?.priceUsd}) matches the advertised $0.05`);
  ok(sd.check({ listed: true, catalog: { paidToolCount: 3 }, flags: [], settlementEvidence: { base: { callsSettled: 12 }, bazaar: { observed: false } } }) === true, "seller-dossier check accepts an indexed dossier with evidence");
  ok(typeof sd.check({ listed: false, reason: "not in our index", flags: ["x"] }) === "string", "seller-dossier check refuses the unindexed shape (a cold index on prod would be a real defect)");
  ok(typeof sd.check({ listed: true, catalog: { paidToolCount: 0 }, flags: [], settlementEvidence: { base: { callsSettled: 1 } } }) === "string", "seller-dossier check refuses an indexed dossier with no priced catalog");
  ok(typeof sd.check({ listed: true, catalog: { paidToolCount: 3 }, flags: [], settlementEvidence: { base: { observed: false }, bazaar: { observed: false } } }) === "string", "seller-dossier check refuses a dossier with no observed settlement source");
}

// The metered leg proves the per-request exact quote end to end. Its priceUsd
// must equal what the kit quotes for ITS OWN body: the leg's display price is
// then the same number the 402 will carry, and a change to the quote
// arithmetic or the floor fails here instead of drifting silently.
{
  const { meteredQuoteUsd, TIERS } = await import("../src/tools/llm-gateway-kit.js");
  const leg = CANARY_LEGS.find((l) => l.kit === "llm-metered");
  ok(!!leg && leg.path === "/v1/metered/chat/completions", "canary has an llm-metered leg on the metered tier");
  if (leg) {
    const q = meteredQuoteUsd(leg.body);
    ok(!q.invalid && q.usd === leg.priceUsd, "llm-metered leg priceUsd equals the kit's quote for its own body");
    ok(leg.priceUsd > TIERS["v1-chat-metered"].price, "the leg's body quotes ABOVE the floor, so a quote collapsing to the floor is visible as a price change");
  }
  const { meteredMessagesQuoteUsd } = await import("../src/tools/llm-messages-kit.js");
  const mleg = CANARY_LEGS.find((l) => l.kit === "llm-metered-messages");
  ok(!!mleg && mleg.path === "/v1/metered/messages", "canary has an llm-metered-messages leg on the metered Messages route");
  if (mleg) {
    const q = meteredMessagesQuoteUsd(mleg.body);
    ok(!q.invalid && q.usd === mleg.priceUsd && mleg.priceUsd > TIERS["v1-chat-metered"].price, "llm-metered-messages leg priceUsd equals the Messages quote for its body and sits above the floor");
  }
  const { meteredResponsesQuoteUsd } = await import("../src/tools/llm-responses-kit.js");
  const rleg = CANARY_LEGS.find((l) => l.kit === "llm-metered-responses");
  ok(!!rleg && rleg.path === "/v1/metered/responses", "canary has an llm-metered-responses leg on the metered Responses route");
  if (rleg) {
    const q = meteredResponsesQuoteUsd(rleg.body);
    ok(!q.invalid && q.usd === rleg.priceUsd && rleg.priceUsd > TIERS["v1-chat-metered"].price, "llm-metered-responses leg priceUsd equals the Responses quote for its body and sits above the floor");
  }
}

// The MPP dual-stack legs prove the native Payment wire (WWW-Authenticate /
// Authorization: Payment via mppx), not the x402 PAYMENT-SIGNATURE path every
// other leg already covers. They used to console.warn and exit 0, so a dead
// shim or missing MPP_SECRET_KEY could sit green forever — same class as the
// Stellar rail before railFail(). Lock both the presence of the native buy
// AND that failures go through railFail().
{
  const canarySrc = readFileSync(join(ROOT, "scripts", "paid-canary.js"), "utf8");
  ok(/import\(["']mppx\/client["']\)/.test(canarySrc) && /import\(["']mppx["']\)/.test(canarySrc),
    "paid-canary imports mppx for a stock MPP client buy");
  ok(/WWW-Authenticate/.test(canarySrc) && /Authorization:\s*credential|Authorization:\s*celoCred/.test(canarySrc),
    "MPP legs drive the native WWW-Authenticate → Authorization: Payment wire");
  ok(/Payment-Receipt|payment-receipt/.test(canarySrc),
    "MPP legs assert the settled Payment-Receipt header");
  // The Algorand leg is QUOTA-AWARE (2026-09-22). The facilitator meters
  // sponsored sub-cent settlements per payTo per month; when the month's
  // allowance is spent the $0.001 leg fails every day until the reset and
  // says nothing true about the rail. It reads the live quota, proves the
  // rail at $0.01 when exhausted, says so, and still pages when that fails.
  ok(/sponsorship\/status\?wallet=\$\{payTo\}/.test(canarySrc), "the Algorand leg reads the facilitator's live sub-cent quota for our payTo");
  ok(/const exhausted = subcentWithdrawn \|\| \(!!quota && !quotaNotThisMonth && Number\(quota\.usedMonth\) >= Number\(quota\.quota\) && Number\(quota\.suBalance \|\| 0\) <= 0\)/.test(canarySrc), "...and treats the month as exhausted when used >= quota with no purchased SUs, or when the server itself has withdrawn Algorand from sub-cent routes");
  // The status row carries no month field: a row last written in an EARLIER
  // UTC month is last month's count, and taken at its word on the 1st it
  // routes the leg around a reset that never gets a sub-cent settle to happen
  // on; a row whose updatedTs is not a readable time cannot name its month
  // either. The leg applies the server's own rule (one definition), and says
  // so loudly when a pause outlives the reset instead of "resets on the 1st".
  ok(/import \{ isSponsorshipRowEvidence, sponsorshipRowMonth, sponsorshipRowUpdatedAt \} from "\.\.\/src\/avm-sponsorship\.js"/.test(canarySrc) && /const quotaNotThisMonth = !!quota && !isSponsorshipRowEvidence\(quota\)/.test(canarySrc),
    "a status row from an earlier UTC month, or with an unreadable updatedTs, is not read as this month's exhaustion (the server's own rule, imported)");
  ok(/const pauseOutlivedReset = exhausted && \(dayOfMonth === 2 \|\| dayOfMonth === 3 \|\| \(subcentWithdrawn && quotaMonth === "earlier-month"\)\)/.test(canarySrc) && /if \(pauseOutlivedReset\) console\.warn\(`\\nWARN  algorand leg: the sub-cent pause is \$\{resetNote\}/.test(canarySrc),
    "a pause still up on the 2nd or 3rd of the month (or held while the facilitator's row is last month's) is WARNed");
  ok(/noteRail\("algorand", true, exhausted \? `settled at \$0\.01; sub-cent sponsored quota exhausted this month \(\$\{quotaText\}\), \$\{resetNote\}`/.test(canarySrc),
    "...and the /status detail carries the same words instead of 'resets on the 1st'");
  // While the allowance is spent the server withdraws Algorand from sub-cent
  // 402s (src/avm-sponsorship.js), so the payTo must come from a one-cent route
  // or the leg reads nothing, takes the $0.001 path and pages on a rail that
  // is fine.
  ok(/const centAccept = await avmAccept\("\/api\/solidity-scan"\)/.test(canarySrc) && /const subcentAccept = centAccept \? await avmAccept\("\/api\/hash"\) : null/.test(canarySrc),
    "the Algorand payTo is read from the one-cent route, and the sub-cent route's offer beside it");
  // ...but a sub-cent 402 without Algorand counts as the server's own
  // exhausted verdict ONLY when GET /api/rails says the server withdrew it.
  // Anything else is the rail dropping out of the sub-cent offer, and pages.
  ok(/import \{ subcentAcceptVerdict \} from "\.\/avm-canary-classify\.js"/.test(canarySrc)
    && /rails = await \(await synthFetch\(`\$\{TARGET\}\/api\/rails`/.test(canarySrc)
    && /const offerVerdict = subcentAcceptVerdict\(\{ centAccept, subcentAccept, rails \}\)/.test(canarySrc)
    && /subcentWithdrawn = offerVerdict === "withdrawn"/.test(canarySrc)
    && /if \(offerVerdict === "missing"\) subcentMissing = /.test(canarySrc)
    && /if \(subcentMissing\) \{ railFail\("algorand", subcentMissing\); return; \}/.test(canarySrc),
    "a missing sub-cent Algorand accept is excused only when /api/rails reports the pause; otherwise railFail");
  {
    const { subcentAcceptVerdict } = await import("./avm-canary-classify.js");
    const acc = { network: "algorand:x", payTo: "P" };
    const paused = { restrictions: [{ network: "algorand", status: "paused" }] };
    ok(subcentAcceptVerdict({ centAccept: acc, subcentAccept: acc, rails: null }) === "offered", "sub-cent route offers Algorand: offered");
    ok(subcentAcceptVerdict({ centAccept: acc, subcentAccept: null, rails: paused }) === "withdrawn", "missing on the sub-cent route with /api/rails reporting the pause: withdrawn (excused)");
    ok(subcentAcceptVerdict({ centAccept: acc, subcentAccept: null, rails: { restrictions: [] } }) === "missing", "missing with /api/rails reporting NO pause: a rail failure");
    ok(subcentAcceptVerdict({ centAccept: acc, subcentAccept: null, rails: null }) === "missing", "missing with /api/rails unreadable: a rail failure, never excused");
    ok(subcentAcceptVerdict({ centAccept: acc, subcentAccept: null, rails: { restrictions: [{ network: "algorand", status: "open" }] } }) === "missing", "missing with a non-paused Algorand row: a rail failure");
    ok(subcentAcceptVerdict({ centAccept: null, subcentAccept: null, rails: paused }) === "no-rail", "no Algorand on the one-cent route either: nothing to compare");
  }
  ok(/exhausted\s*\?\s*\{ path: "\/api\/solidity-scan", usd: "0\.01"/.test(canarySrc), "when exhausted it proves the rail at $0.01 on the one pure-CPU tool at that price");
  ok(/: \{ path: "\/api\/hash", usd: "0\.001"/.test(canarySrc), "...and otherwise keeps the $0.001 sub-cent buy, which is the path real buyers take");
  ok(/sub-cent sponsored quota exhausted this month/.test(canarySrc), "the exhaustion is SAID, in the log and on the /status detail - re-routing must never hide it");
  ok(/railFail\(\s*["']algorand["']/.test(canarySrc), "a refusal of whichever buy it made still pages through railFail");
  ok(/railFail\(\s*["']mpp["']/.test(canarySrc),
    "Base MPP failures go through railFail (not WARN-only) so a dead shim fails the run");
  ok(/railFail\(\s*["']mpp-celo["']/.test(canarySrc),
    "Celo MPP failures go through railFail so a dropped challenge network fails the run");
  // Mutation lock: a WARN-only MPP block must not count as covered.
  const mppBlock = canarySrc.slice(canarySrc.indexOf("MPP dual-stack"), canarySrc.indexOf("Pinned EVM legs"));
  ok(mppBlock.length > 500, "located the MPP dual-stack block for scoped assertions");
  ok(!/console\.warn\(`\\nWARN  mpp/.test(mppBlock),
    "MPP block has no WARN-only failure paths left (those hid the Stellar-class green)");

  // Tempo is MPP's OWN native method, architecturally distinct from mpp/
  // mpp-celo above: it settles via Tempo's own relay, never @x402/express,
  // so it's the ONLY proof this repo has that the real relay wire format
  // works (the offline test suite proves our own logic against injected
  // stubs, by design). Same rigor as the evm-translated legs: real
  // railFail (not WARN-only), assert the receipt, assert it's a genuinely
  // separate try/catch so a Tempo failure can never be misattributed to
  // the "mpp" rail key.
  ok(/tempo:\s*mppTempo/.test(canarySrc),
    "paid-canary destructures mppx/client's tempo method for the native Tempo relay buy");
  ok(/railFail\(\s*["']mpp-tempo["']/.test(canarySrc),
    "Tempo failures go through railFail (not WARN-only) so a dead relay integration fails the run");
  ok(/mpp-tempo[\s\S]{0,400}Payment-Receipt/i.test(canarySrc),
    "the Tempo leg asserts the settled Payment-Receipt header, same as every other MPP leg");
  const tempoBlock = canarySrc.slice(canarySrc.indexOf("Tempo — MPP's OWN native method"), canarySrc.indexOf("Pinned EVM legs"));
  ok(tempoBlock.length > 500, "located the Tempo leg block for scoped assertions");
  ok(!/railFail\(\s*["']mpp["']/.test(tempoBlock),
    "the Tempo leg's own catch block never attributes a failure to the mpp key (own try/catch, own rail identity)");

  // Metered-upto: the settle-ACTUAL path. A leg that pays exact by accident
  // still gets a 200, so the pin is on the three things that distinguish it:
  // the outgoing credential's scheme, X-Metered-Usd under the quote, railFail.
  ok(/railFail\(\s*["']metered-upto["']/.test(canarySrc),
    "metered-upto failures go through railFail so a broken upto path fails the run");
  ok(/UptoEvmScheme/.test(canarySrc) && /sentScheme !== "upto"/.test(canarySrc),
    "the metered-upto leg registers the upto scheme AND asserts the credential it sent was upto");
  ok(/x-metered-usd/.test(canarySrc) && /metered >= quotedUsd/.test(canarySrc),
    "the metered-upto leg asserts X-Metered-Usd is strictly under the quote");
}

// --- the canary must actually RUN on the days it claims to ------------------
//
// A daily proof that buying works proves nothing if it silently skips a day,
// and the gap is invisible: a missing run looks exactly like a quiet day on the
// revenue page. Measured deliveries of the single 13:17 cron arrived at 15:27
// and 15:21 (two hours late), one arrived at 14:39 and was CANCELLED, and one
// never arrived at all - which is how 2026-08-02 ended up with no canary rows
// on any chain and read as "sei is missing".
{
  const wf = readFileSync(new URL("../.github/workflows/paid-canary.yml", import.meta.url), "utf8");
  const crons = [...wf.matchAll(/^\s*-\s*cron:\s*["']([^"']+)["']/gm)].map((m) => m[1]);
  ok(crons.length >= 2,
    `more than one scheduled attempt, so a missed or cancelled delivery cannot cost a day (${crons.length}: ${crons.join(", ")})`);

  // The redundancy must be free, and the guard must be at JOB level. A
  // step-level condition would have to be repeated on every step, and the one
  // that got forgotten would spend ~$1.50 of real USDC anyway.
  ok(/\n\s{2}gate:/.test(wf), "a gate JOB decides whether this attempt spends anything");
  const canaryIf = wf.split("\n").find((l) => l.includes("if:") && l.includes("needs.gate.outputs.skip")) || "";
  ok(/needs:\s*gate/.test(wf) && canaryIf !== "",
    "the buying job is gated at JOB level, not per step");

  // Fail toward RUNNING, asserted STRUCTURALLY rather than by polarity.
  //
  // The previous version checked only that the comparison reads `!= 'true'`
  // rather than `== 'false'`. That says nothing about a gate that FAILED: a
  // job-level `if` with no status check function still carries the implicit
  // success() on `needs`, so a failed gate SKIPS the canary. The assertion
  // passed for weeks against exactly that code, claiming a property it had no
  // way to see. What actually makes the claim true is a status function
  // overriding the implicit check.
  ok(/!=\s*'true'/.test(canaryIf) && !/==\s*'false'/.test(canaryIf),
    "the gate's skip is opt-IN: an empty or missing output leaves the canary running");
  ok(/!\s*cancelled\(\)|always\(\)/.test(canaryIf),
    `a FAILED gate cannot silently disable the canary - the if carries a status function (got: ${canaryIf.trim()})`);

  // The gate must ask PRODUCTION when a canary last BOUGHT, never GitHub when
  // this workflow last concluded green. A run whose gate skips the buy also
  // concludes green, so keying on run history makes every skip refresh the
  // window the next gate reads, and the gate ratchets itself permanently shut.
  // Measured: shipped 2026-08-02, and not one scheduled run bought afterwards.
  const gateJob = wf.slice(wf.indexOf("\n  gate:"), wf.indexOf("\n  canary:"));
  ok(/\/api\/status/.test(gateJob) && !/gh run list/.test(gateJob),
    "the gate keys on a real settlement observation, not on this workflow's own run history");
  const jqReads = gateJob.split("\n").filter((l) => l.includes("jq -r"));
  ok(jqReads.length > 0 && jqReads.every((l) => /\|\|\s*echo\s+none/.test(l)),
    `every jq read in the gate falls back instead of failing the step (jq exits non-zero on a non-JSON body) (${jqReads.length} read${jqReads.length === 1 ? "" : "s"})`);

  // A human asking for a buy - usually right after a deploy - must never be
  // suppressed by the freshness window.
  ok(/if:\s*github\.event_name\s*==\s*'schedule'/.test(wf),
    "the freshness skip applies to SCHEDULED runs only; a manual dispatch always buys");

  // 2026-08-10: a rail-only fail (tools settled) must not paint /status as a
  // buying outage. Exit 5 → partial-rail → settlement ok=true + rail detail;
  // alert title is rail-scoped, not "Paid-path canary FAILED".
  ok(/CODE.*=.*"5".*partial-rail|result=partial-rail/.test(wf.replace(/\s+/g, " ")),
    "exit 5 maps to result=partial-rail (tools settled, rail leg failed)");
  ok(/partial-rail\)[\s\S]*?OK=true/.test(wf) && /rail fail:/.test(wf),
    "partial-rail records settlement ok=true with a rail-named detail (underfunded doctrine)");
  ok(/Paid canary rail FAILED/.test(wf),
    "partial-rail pages a rail-scoped issue title, not the buying-broken title alone");
  // The buying-broken detail must stay on the fail branch only — not on partial-rail.
  const partialBlock = wf.match(/partial-rail\)[\s\S]*?;;/);
  ok(partialBlock && !/could not complete a real USDC purchase/.test(partialBlock[0]),
    "partial-rail detail must not claim buying could not complete a USDC purchase");
}

// The supply-chain leg (and its consecutive-failure paging rule) left with the
// five retired explorer tools on 2026-09-22. Nothing may bring the leg or its
// status row back half-wired: a leg with no catalog route buys a 410 daily.
{
  const canarySrc2 = readFileSync(join(ROOT, "scripts", "paid-canary.js"), "utf8");
  ok(!/"supply-chain"|\/api\/address-profile/.test(canarySrc2), "the canary carries no supply-chain leg for the retired address-profile route");
  const statusSrc = readFileSync(join(ROOT, "src", "status.js"), "utf8");
  ok(!/rail_supply-chain/.test(statusSrc), "status.js carries no rail_supply-chain component for a leg that no longer runs");
}

// The daily Algorand leg signs the sweep's 1000-round window (2026-09-22): ten
// rounds left ~20 s at our own validity guard and the leg flapped on latency.
{
  const psrc = readFileSync(new URL("../scripts/paid-canary.js", import.meta.url), "utf8");
  const leg = psrc.slice(psrc.indexOf("ALGORAND_ALGOD_URL"), psrc.indexOf("ALGORAND_ALGOD_URL") + 1600);
  ok(/setDefaultValidityWindow\(1000\)/.test(leg), "the daily Algorand leg signs a 1000-round validity window");
  ok(/new ExactAvmScheme\(signer, \{ algorandClient \}\)/.test(leg), "...through the algokit client that carries it");
  ok(/res\.status === 422[\s\S]{0,400}railFail\("algorand"/.test(psrc), "a 422 from our own validity guard pages instead of warning");
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
