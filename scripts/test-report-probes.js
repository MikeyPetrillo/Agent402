// Drive every report kit's FREE probe stage against live inputs.
//
// WHY THIS LANE EXISTS. `METERED_SLUGS` holds 147 slugs - every LLM tier, every
// search tool and every paid report product - and both catalog sweeps skip them,
// because CI has no third-party keys and must not spend on upstreams. That is
// the right call and it leaves the tools that cost the most, and that humans
// actually buy, driven by nothing on a schedule. It is where the last
// outsider-found defect lived: on 2026-08-29 `domain-audit` ($0.60 agent, a card
// product and a $5/mo monitor) answered HTTP 500 for EVERY domain publishing a
// DMARC rua, because `reportingUris` is an object and the new mailbox block
// spread it as an array.
//
// A local keyless boot cannot find that: the route checks OPENROUTER_API_KEY and
// answers 503 BEFORE running its input probes. But the probes themselves need no
// paid key at all - the monitors already call them free every day - so they can
// be driven directly, here, for nothing.
//
// DRIVING THE PROBES ALONE IS NOT ENOUGH, and the domain-audit outage is the
// proof: `probeDomain` never threw. The crash was one layer further in, in the
// handler's prompt-building stage, where `reportMailboxesFrom` spread the
// probe's `reportingUris` object as an array - a fixture-based unit test said
// "object" and passed, and the live probe said object too, but nothing had ever
// put the two together. So each leg also feeds its LIVE probe output into the
// pure functions the handler feeds it into. That pairing is the part with
// teeth: `CONSUMERS` below is checked to reproduce the real 08-29 failure.
//
// WHAT FAILS THE RUN. Only our own code being broken. Every leg is retried once
// (the heartbeat's single-retry doctrine) and only what SURVIVES is classified by
// scripts/probe-classify.js: a programming error, or our own 4xx/500, fails; a
// third party being down is reported loudly and never fatal. A CONTROL leg with
// a planted bug runs first, so a clean sweep is only believed once the harness
// has been shown to catch one.
import { classifyProbeFailure } from "./probe-classify.js";

const BRETT = "0x532f27101965dd16442E59d40670FaF5eBB142E4"; // Base, a real token with holders
const JUP = "JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN";  // Solana, a real mint
const MSFT_CIK = "789019";

/** `expect` returns a complaint string, or null when the shape is sound. It
 *  asserts only what CANNOT legitimately be empty - a quiet week at the SEC or
 *  a token with no recent pairs is data, not a defect. */
const LEGS = [
  {
    name: "domain-audit  probeDomain",
    run: () => import("../src/tools/domain-audit-kit.js").then((m) => m.probeDomain("github.com")),
    // github.com publishes a DMARC rua, which is the exact input that made
    // every domain-audit answer 500 on 2026-08-29.
    expect: (r) => (r && typeof r === "object" ? null : "no object returned"),
    consumers: [
      async (r) => {
        const m = await import("../src/tools/domain-audit-kit.js");
        const boxes = m.reportMailboxesFrom(r?.email?.dmarc?.reportingUris, r?.dnsx?.caa);
        if (!Array.isArray(boxes)) throw new TypeError("reportMailboxesFrom did not return an array");
        m.tlsScoreOf(r?.tls, "github.com");
        m.certCoversHost(r?.tls, "github.com");
        m.dnsHostFor(r?.dnsx?.ns);
      },
    ],
  },
  {
    name: "domain-audit  probeDomain (pro)",
    run: () => import("../src/tools/domain-audit-kit.js").then((m) => m.probeDomain("stripe.com", { pro: true })),
    expect: (r) => (r && typeof r === "object" ? null : "no object returned"),
    consumers: [
      async (r) => {
        const m = await import("../src/tools/domain-audit-kit.js");
        m.reportMailboxesFrom(r?.email?.dmarc?.reportingUris, r?.dnsx?.caa);
        m.tlsScoreOf(r?.tls, "stripe.com");
      },
    ],
  },
  {
    name: "domain-audit  probeDnsPosture",
    run: () => import("../src/tools/domain-audit-kit.js").then((m) => m.probeDnsPosture("cloudflare.com")),
    expect: (r) => (r && typeof r === "object" ? null : "no object returned"),
  },
  {
    name: "ipo-report    probeIpos",
    run: () => import("../src/tools/ipo-report-kit.js").then((m) => m.probeIpos({ days: 7, limit: 20 })),
    expect: (r) => (r && typeof r === "object" ? null : "no object returned"),
  },
  {
    name: "insider       probeInsiderFilings",
    run: () => import("../src/tools/insider-flow-kit.js").then((m) => m.probeInsiderFilings({ ticker: "NVDA", days: 90 })),
    expect: (r) => (r && typeof r === "object" ? null : "no object returned"),
  },
  {
    name: "filing-watch  probeCompanyFilings",
    run: () => import("../src/tools/filing-watch-kit.js").then((m) => m.probeCompanyFilings("AAPL")),
    expect: (r) => (r && typeof r === "object" ? null : "no object returned"),
  },
  {
    name: "recall        probeRecalls",
    run: () => import("../src/tools/recall-report-kit.js").then((m) => m.probeRecalls("losartan")),
    expect: (r) => (r && typeof r === "object" ? null : "no object returned"),
  },
  {
    name: "token-risk    probeGoPlus",
    run: () => import("../src/tools/token-risk-kit.js").then((m) => m.probeGoPlus({ chain: "base", address: BRETT })),
    expect: (r) => (r && typeof r === "object" ? null : "no object returned"),
    consumers: [async (r) => { const m = await import("../src/tools/token-risk-kit.js"); m.shapeGoPlus(r); }],
  },
  {
    name: "token-risk    probeDexPairs",
    run: () => import("../src/tools/token-risk-kit.js").then((m) => m.probeDexPairs({ chain: "base", address: BRETT })),
    expect: (r) => (r && typeof r === "object" ? null : "no object returned"),
  },
  {
    name: "token-brief   probeTokenBrief",
    run: () => import("../src/tools/token-brief-kit.js").then((m) => m.probeTokenBrief(JUP)),
    expect: (r) => (r && typeof r === "object" ? null : "no object returned"),
  },
  {
    name: "ticker-pack   probeHolders",
    run: () => import("../src/tools/ticker-pack-kit.js").then((m) => m.probeHolders({ ticker: "MSFT", name: "MICROSOFT CORP", maxFilings: 4 })),
    expect: (r) => (Array.isArray(r?.managers) ? null : "managers is not an array"),
    consumers: [async (r) => { const m = await import("../src/tools/ticker-pack-kit.js"); m.summarizeIssuerRows(r?.managers || []); }],
  },
  {
    name: "ticker-pack   probe13G",
    run: () => import("../src/tools/ticker-pack-kit.js").then((m) => m.probe13G({ cik: MSFT_CIK, maxFilers: 3 })),
    expect: (r) => (r && typeof r === "object" ? null : "no object returned"),
  },
];

/** The planted defect: the harness must catch this or a clean sweep proves
 *  nothing. Deliberately the SHAPE of the real 08-29 bug. */
const CONTROL = {
  name: "CONTROL       planted defect",
  run: async () => { const reportingUris = { aggregate: [], failure: [] }; return [...reportingUris]; },
  expect: () => null,
};

// The classifier's own rules, pinned. Getting 500-vs-502 backwards would
// silently disarm this whole lane: every real defect would be filed as
// "upstream, not our defect" and the run would stay green.
const CLASSIFIER_CASES = [
  [new TypeError("reportingUris is not iterable"), "our-bug", "the real 08-29 shape"],
  [new TypeError("Cannot read properties of undefined"), "our-bug", "programming error"],
  [Object.assign(new Error("probe needs an issuer name"), { statusCode: 500 }), "our-bug", "our own 500"],
  [Object.assign(new Error("GoPlus does not cover foo"), { statusCode: 422 }), "our-bug", "our own 4xx: the probe refused its input"],
  [Object.assign(new Error("upstream error"), { statusCode: 502 }), "upstream", "502 is the house definition of a third party failing"],
  [Object.assign(new Error("gateway busy"), { statusCode: 503 }), "upstream", "503"],
  [Object.assign(new Error("slow down"), { statusCode: 429 }), "upstream", "429 is throttling, not a defect"],
  [new Error("fetch failed"), "upstream", "network"],
  [new TypeError("fetch failed"), "our-bug", "a TypeError is ours even when it says network"],
];
for (const [err, want, why] of CLASSIFIER_CASES) {
  const got = classifyProbeFailure(err);
  if (got !== want) {
    console.error(`FAIL: classifier said "${got}" for ${why} (${err.message}), want "${want}"`);
    process.exit(1);
  }
}
console.log(`ok   classifier${" ".repeat(24)} ${CLASSIFIER_CASES.length} rules pinned`);

const ourBugs = [];
const upstream = [];

async function attempt(leg) {
  const started = Date.now();
  try {
    const value = await leg.run();
    const complaint = leg.expect ? leg.expect(value) : null;
    if (complaint) return { verdict: "our-bug", detail: complaint, ms: Date.now() - started };
    // The layer the probe hands its output to. A throw here is the 08-29 class.
    for (const consume of leg.consumers || []) await consume(value);
    return { verdict: "ok", bytes: JSON.stringify(value ?? null).length, ms: Date.now() - started };
  } catch (err) {
    return { verdict: classifyProbeFailure(err), detail: `${err?.constructor?.name || "Error"}: ${err?.message || err}`, ms: Date.now() - started };
  }
}

/** One retry before anything is believed: these are third-party APIs and a
 *  single bad minute must not fail a build. A real defect fails both times. */
async function drive(leg) {
  let r = await attempt(leg);
  if (r.verdict !== "ok") {
    await new Promise((res) => setTimeout(res, 2000));
    r = await attempt(leg);
  }
  return r;
}

// --- control first: prove the harness can see a defect at all ---
const control = await drive(CONTROL);
if (control.verdict !== "our-bug") {
  console.error(`FAIL: the control defect was classified "${control.verdict}", not "our-bug" - this sweep cannot see a broken probe, so a clean run would prove nothing.`);
  process.exit(1);
}
console.log(`ok   ${CONTROL.name.padEnd(34)} caught (${control.detail})`);

for (const leg of LEGS) {
  const r = await drive(leg);
  if (r.verdict === "ok") {
    console.log(`ok   ${leg.name.padEnd(34)} ${String(r.ms).padStart(6)}ms  ${r.bytes} bytes`);
  } else if (r.verdict === "upstream") {
    upstream.push(`${leg.name}: ${r.detail}`);
    console.log(`UP   ${leg.name.padEnd(34)} ${String(r.ms).padStart(6)}ms  upstream, not our defect: ${r.detail}`);
  } else {
    ourBugs.push(`${leg.name}: ${r.detail}`);
    console.log(`BUG  ${leg.name.padEnd(34)} ${String(r.ms).padStart(6)}ms  ${r.detail}`);
  }
}

console.log(`\n${LEGS.length} probe legs: ${LEGS.length - ourBugs.length - upstream.length} ok, ${ourBugs.length} broken in OUR code, ${upstream.length} upstream`);
if (upstream.length) console.log(`upstream (reported, not fatal):\n  ${upstream.join("\n  ")}`);
if (ourBugs.length) {
  console.error(`\nFAIL - a report product's free probe stage is broken:\n  ${ourBugs.join("\n  ")}`);
  process.exit(1);
}
console.log("OK - every report product's input stage answers");
