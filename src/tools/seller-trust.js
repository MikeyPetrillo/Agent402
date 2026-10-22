// Seller trust check — the evidence our OWN router uses before it spends buyer
// money on an external x402 seller, served as a tool.
//
// Inputs, both already maintained continuously for the router: the seller crawl
// (manifest validity, tool count, advertised chains, health) and observed
// on-chain settlement counts from the leaderboard. This tool reads those two
// sources and reports the router's gate; it computes no new evidence.
//
// TWO LANES, ONE SET OF VERDICTS. The router pays a seller as PROVEN (Base
// verdict eligible) or, below the settlement floor with nothing else wrong and
// at a price within the unproven ceiling, through the Base UNPROVEN tier
// (src/base-unproven.js). Both are read off the per-route verdicts the server
// injects (getToolVerdicts: the same rows /api/index?seller= publishes), never
// re-derived here, and summarised by src/router-lanes.js.
//
// DETERMINISTIC AND OFFLINE BY CONSTRUCTION: it never fetches the seller at
// call time. A paid handler that dials a third party would add an SSRF surface,
// unbounded latency, and a verdict that changes with the seller's uptime rather
// than with the evidence. Everything here comes from the crawler cache and the
// leaderboard snapshot, both refreshed on their own schedules.
//
// HONEST ABOUT LIMITS: "unknown" is a first-class answer. An origin we have
// never crawled returns listed:false with a stated reason, never a low score
// that reads like a bad verdict. Absence of evidence is reported as absence,
// the same rule /status follows for uptime gaps.

// A crawled row's price is a label ("$0.01"), a number or an object: one reader.
import { priceUsdOf, isPricedAboveZero } from "../price-usd.js";
import { routerLanes } from "../router-lanes.js";
import { baseUnprovenAllowanceUsd } from "../base-unproven.js";
// The served display name is cleaned and capped like every agent-read seller
// surface; the assessment below reads the detail as written.
import { servedSellerName } from "../x402-index.js";

/** Advertised-vs-settling summary for one origin. Pure; all state injected. */
export function assessSeller({ origin, detail, settledCalls, sorThreshold, sorCap, requireNetwork }) {
  const advertisedNetworks = [...new Set((detail?.tools || []).flatMap((t) => t.networks || []))];
  const paidTools = (detail?.tools || []).filter((t) => t.paid !== false && isPricedAboveZero(t.price));
  const prices = paidTools.map((t) => priceUsdOf(t.price)).sort((a, b) => a - b);
  const advertisesRequired = requireNetwork ? advertisedNetworks.includes(requireNetwork) : true;
  const meetsThreshold = settledCalls >= sorThreshold;
  const withinCap = prices.length > 0 && prices[0] <= sorCap;
  // The router's own gate, reported field by field so a "no" is explainable
  // rather than a verdict the buyer has to take on faith.
  const gate = {
    settledCalls,
    settlementThreshold: sorThreshold,
    meetsSettlementThreshold: meetsThreshold,
    advertisesSettlementNetwork: advertisesRequired,
    cheapestPaidToolUsd: prices.length ? prices[0] : null,
    routerUnderlyingCapUsd: sorCap,
    hasToolWithinRouterCap: withinCap,
  };
  const blockers = [];
  if (!meetsThreshold) blockers.push(`fewer than ${sorThreshold} settled calls observed on-chain`);
  if (!advertisesRequired) blockers.push(`does not advertise ${requireNetwork} on any indexed resource`);
  if (!withinCap) blockers.push(`no paid resource at or under the router's $${sorCap} underlying cap`);
  return {
    advertisedNetworks,
    paidToolCount: paidTools.length,
    priceRangeUsd: prices.length ? { min: prices[0], max: prices[prices.length - 1] } : null,
    gate,
    routableByOurRouter: blockers.length === 0,
    blockers,
  };
}

export function buildSellerTrustTool({ getSellerDetail, getSettledCalls, getPayToEvidence, getToolVerdicts, getUnprovenMaxUsd = baseUnprovenAllowanceUsd, execTiers, sorThreshold = 50, sorCap = 0.005, settlementNetwork = "eip155:8453", selfHost = "" }) {
  // Without the router's own per-route verdicts this tool could only guess at
  // the lanes, so the wiring has to hand them in.
  if (typeof getToolVerdicts !== "function") throw new Error("seller-trust needs getToolVerdicts (the router's per-route dispatch verdicts)");
  // ...and route-execute's own tier table, so "a tier can pay it" is read off
  // the tiers the router sells rather than a copy of their caps.
  if (!Array.isArray(execTiers) || !execTiers.length) throw new Error("seller-trust needs execTiers (route-execute's EXEC_TIERS)");
  return {
    route: "GET /api/x402/seller-trust",
    name: "Check an x402 seller's trust evidence",
    slug: "seller-trust",
    category: "x402",
    price: "$0.005",
    description:
      "Trust evidence for any x402 seller origin: is it indexed, does its manifest parse, how many tools does it publish, which chains does it actually advertise, how many settled calls has it been observed receiving on-chain, and would our own Smart Order Router spend buyer money on it, in either of its two lanes: as a proven seller, or through the Base unproven lane (a seller below the settlement floor, tried after every proven candidate under a small per-call ceiling, paid only at the wallet its own live 402 names and flagged unproven on the receipt). routableByOurRouter is true when either lane can pay; routableAsProven is true when some route-execute tier pays it as a proven seller. Each lane names the route-execute tiers whose underlying cap covers its routes (lanes.proven.tiers, cheapestTier), with its blockers, so a refusal is explainable. Never fetches the seller at call time - this is our accumulated crawl and settlement evidence, not a liveness probe.",
    tags: ["x402", "seller", "trust", "reputation", "verify", "due-diligence", "counterparty",
      "safety", "policy", "allowlist", "settled", "proven", "index", "discovery",
      "is this seller real", "has anyone paid this seller", "check a seller before paying",
      "seller reputation", "counterparty risk", "vet an api", "payment policy input"],
    discovery: {
      inputSchema: {
        type: "object",
        properties: {
          origin: { type: "string", description: "Seller origin or bare host, e.g. https://example.com or example.com" },
        },
        required: ["origin"],
      },
      input: { origin: "agent402.tools" },
      example: { origin: "agent402.tools" },
      // An indexed seller below the settlement floor with a route inside the
      // unproven ceiling: not proven, still routable through the unproven lane.
      output: {
        example: {
          origin: "https://seller.example",
          listed: true,
          displayName: "Example Seller",
          manifestParsed: true,
          crawlError: null,
          healthScore: 1,
          paywall: { ok: true, status: 402, url: "https://seller.example/api/x", at: 1789000000000 },
          lastCrawledAt: "2026-10-16T00:00:00.000Z",
          toolCount: 2,
          paidToolCount: 2,
          priceRangeUsd: { min: 0.005, max: 0.02 },
          advertisedNetworks: ["eip155:8453"],
          settledCallsObserved: 3,
          routerGate: { settledCalls: 3, settlementThreshold: 50, meetsSettlementThreshold: false, advertisesSettlementNetwork: true, cheapestPaidToolUsd: 0.005, routerUnderlyingCapUsd: 0.005, hasToolWithinRouterCap: true },
          lanes: {
            proven: { eligible: false, chain: "base", toolCount: 0, cheapestUsd: null, cheapestTier: null, tiers: [], blockers: ["fewer than 50 settled calls observed on-chain"] },
            unproven: { eligible: true, chain: "base", maxUsd: 0.01, toolCount: 1, cheapestUsd: 0.005, cheapestTier: "route-execute", note: "On Base the router may still pay the seller, but only after every proven seller for the task, only at the wallet its own live 402 names, never above that ceiling, and flagged unproven on the buyer's receipt ($0.01 per call)." },
          },
          routableByOurRouter: true,
          routableAsProven: false,
          routableVia: "unproven",
          blockers: [],
          provenBlockers: ["fewer than 50 settled calls observed on-chain"],
          caveats: ["settledCallsObserved counts on-chain payments we have observed to this seller's payTo; it is a floor, not a total"],
          evidenceSource: "x402 seller crawl + on-chain settlement counts + the router's per-route dispatch verdicts",
        },
      },
    },
    handler(input) {
      const raw = String(input?.origin || input?.host || input?.seller || "").trim();
      if (!raw) {
        const e = new Error("`origin` is required - pass a seller origin or bare host, e.g. example.com");
        e.statusCode = 400;
        throw e;
      }
      // Accept a URL or a bare host; never fetch either.
      let host = raw.toLowerCase().replace(/^https?:\/\//, "").replace(/\/.*$/, "").slice(0, 253);
      if (!host.includes(".")) {
        const e = new Error("`origin` must be a public host, e.g. example.com");
        e.statusCode = 400;
        throw e;
      }
      const detail = getSellerDetail(host);
      const settledCalls = getSettledCalls(detail?.origin || `https://${host}`);
      if (!detail) {
        // Absence of evidence, stated as such. A never-crawled origin is not a
        // bad seller; conflating the two would make this tool a slander engine.
        return {
          origin: `https://${host}`,
          listed: false,
          reason: "not in our index - never crawled, so we hold no evidence either way",
          settledCallsObserved: settledCalls || 0,
          routableByOurRouter: false,
          routableAsProven: false,
          routableVia: null,
          blockers: ["origin is not indexed"],
          howToList: "POST /api/index/register with {\"origin\":\"https://<host>\"} (free, self-serve)",
          evidenceSource: "x402 seller crawl + on-chain settlement counts",
        };
      }
      const a = assessSeller({
        origin: detail.origin, detail, settledCalls: settledCalls || 0,
        sorThreshold, sorCap, requireNetwork: settlementNetwork,
      });
      // Asking about US: the router deliberately never routes to itself (paying
      // our own endpoint over x402 is pure fee loss), so a bare "not routable"
      // here would read as a bad verdict on a healthy catalog. Say why.
      const isSelf = Boolean(selfHost) && host === String(selfHost).toLowerCase();
      // Both lanes, read off the router's own per-route verdicts.
      const lanes = routerLanes({ toolVerdicts: getToolVerdicts(detail) || [], unprovenMaxUsd: getUnprovenMaxUsd(), execTiers });
      // Proven = the router's verdict says eligible AND some route-execute
      // tier's underlying cap covers the route (lanes.proven.tiers). The old
      // gate's numbers still explain a refusal, except its cap line: that cap
      // is the cheapest tier's only, and the tiers above it pay more.
      const asProven = !isSelf && lanes.proven.eligible;
      const gateBlockers = a.blockers.filter((b) => !b.startsWith("no paid resource at or under"));
      const provenBlockers = asProven ? [] : [...gateBlockers, ...lanes.proven.blockers.filter((b) => !gateBlockers.length || /route-execute tier/.test(b))];
      const viaUnproven = !isSelf && !asProven && lanes.unproven.eligible;
      const routable = asProven || viaUnproven;
      return {
        origin: detail.origin,
        listed: true,
        ...(isSelf ? { self: true, note: "this is the local catalog - our router never routes to itself, so the router gate below does not apply" } : {}),
        displayName: servedSellerName(detail.displayName, detail.origin),
        manifestParsed: !detail.error,
        crawlError: detail.error || null,
        healthScore: detail.health,
        // Crawl health only says the manifest parsed. A seller whose every paid
        // route 500s scores a perfect 1.0 on it, which is why paywall liveness
        // is reported separately rather than folded in. null = not probed.
        paywall: detail.paywall || null,
        lastCrawledAt: detail.fetchedAt ? new Date(detail.fetchedAt).toISOString() : null,
        toolCount: detail.toolCount,
        paidToolCount: a.paidToolCount,
        priceRangeUsd: a.priceRangeUsd,
        advertisedNetworks: a.advertisedNetworks,
        settledCallsObserved: a.gate.settledCalls,
        // What the seller CLAIMS as its payTo, against what we have observed
        // receiving money. A claim is not a receipt.
        ...(typeof getPayToEvidence === "function" ? { advertisedPayTo: getPayToEvidence(detail) } : {}),
        routerGate: a.gate,
        lanes: isSelf
          ? { proven: { ...lanes.proven, eligible: false, blockers: ["this host is the local catalog"] }, unproven: { ...lanes.unproven, eligible: false, reason: "this host is the local catalog" } }
          : { proven: { ...lanes.proven, eligible: asProven, blockers: provenBlockers }, unproven: lanes.unproven },
        // True when EITHER lane can pay (since the unproven lane shipped);
        // routableAsProven: some route-execute tier pays it as a proven seller.
        routableByOurRouter: routable,
        routableAsProven: asProven,
        routableVia: asProven ? "proven" : (viaUnproven ? "unproven" : null),
        blockers: isSelf
          ? ["this host is the local catalog - call its tools directly"]
          : (routable ? [] : [...provenBlockers, ...(lanes.unproven.reason ? [`unproven lane: ${lanes.unproven.reason}`] : [])]),
        // Never an empty list for us: the proven lane is closed to the local
        // catalog, and the lane object above already says why.
        provenBlockers: isSelf ? ["this host is the local catalog"] : provenBlockers,
        // Say plainly what this is and is not, so a policy engine consuming it
        // does not over-read a number we did not measure.
        caveats: [
          "settledCallsObserved counts on-chain payments we have observed to this seller's payTo; it is a floor, not a total",
          "advertisedNetworks is what the seller publishes, which is not proof it settles there",
          "no liveness probe is performed at call time - a listed seller can still be down right now; `paywall` is from the last crawl, and null means not yet probed rather than healthy",
          "healthScore measures whether the manifest parsed, NOT whether paid routes work - read it with `paywall`, never instead of it",
          "routableByOurRouter is true when either lane can pay; the unproven lane is Base only, tried after every proven seller for the task, and flagged unproven on the buyer's receipt - read routableAsProven for the proven-only answer",
          "routerGate.routerUnderlyingCapUsd is the cheapest route-execute tier's cap; lanes.proven.tiers lists every tier that can pay a proven route",
        ],
        evidenceSource: "x402 seller crawl + on-chain settlement counts + the router's per-route dispatch verdicts",
      };
    },
  };
}
