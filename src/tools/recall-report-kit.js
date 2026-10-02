// recall-report-kit — FDA RECALL REPORT for a product, drug, brand or ingredient.
// Composes the free openFDA enforcement feeds (drug / food / medical device,
// src/tools/gov-kit.js) into one cited, graded-by-class report: what is
// recalled, by whom, why, how widely, and what is still ongoing. Every fact
// comes from the FDA records (deterministic probes); the synthesis only
// organizes and explains them. Same skeleton as fund-report / domain-audit:
// settle() fan-out -> grounding-strict Opus synthesis -> numbered sources ->
// data appendix. Settlement-safe (throws >= 400 on failure), WALLET_ONLY, not
// cached. Gated on OPENROUTER_API_KEY (503 without it).
//
// `probeRecalls()` is exported for the monitor scheduler: the same probes,
// no LLM, with a fingerprint of the recall numbers seen - a NEW recall number
// for the subscriber's query is what triggers a paid re-run + alert.
import { fetchOpenRouter, throwUpstreamError, bad, upstreamUserId } from "./llm-gateway-kit.js";
import { GOV_TOOLS } from "./gov-kit.js";
import { recordCompositeUsage } from "../composite-spend-guard.js";

function safeUser(req) { try { return req ? upstreamUserId(req) : undefined; } catch { return undefined; } }

const SYNTH = "anthropic/claude-opus-5";
export const RECALL_MODELS = [SYNTH];
export const RECALL_TIERS = {
  "recall-report": { price: "$0.60", maxUpstreamUsd: 0.35, perFeed: 20, synthMaxTokens: 3200, words: "~1,100" },
};
const SYNTH_TIMEOUT_MS = 120_000;
const PROBE_TIMEOUT_MS = 25_000;
const MAX_QUERY_CHARS = 80;

const FEEDS = [
  { kind: "drug", slug: "drug-recalls", label: "FDA drug recalls", source: "https://api.fda.gov/drug/enforcement.json" },
  { kind: "food", slug: "food-recalls", label: "FDA food recalls", source: "https://api.fda.gov/food/enforcement.json" },
  { kind: "device", slug: "device-recalls", label: "FDA medical device recalls", source: "https://api.fda.gov/device/enforcement.json" },
];

let _gov = null;
function H(slug) {
  const t = (_gov ||= GOV_TOOLS).find((x) => x.slug === slug);
  if (!t) throw bad(`recall-report: missing dependency '${slug}'`, 500);
  return t.handler;
}
async function chat(body, timeoutMs, user) {
  const res = await fetchOpenRouter({ ...body, ...(user ? { user } : {}), usage: { include: true } }, { timeoutMs });
  if (!res.ok) await throwUpstreamError(res);
  return res.json();
}
const costOf = (d) => Number(d?.usage?.cost) || 0;
const textOf = (d) => (d?.choices?.[0]?.message?.content || "").trim();
async function settle(p, timeoutMs) {
  try {
    const data = timeoutMs ? await Promise.race([p, new Promise((_, r) => setTimeout(() => r(bad("timeout", 504)), timeoutMs))]) : await p;
    return { ok: true, data };
  } catch (e) { return { ok: false, error: e?.message || String(e) }; }
}

export function normRecallQuery(input) {
  const q = String(typeof input === "string" ? input : input?.query ?? input?.q ?? "").replace(/\s+/g, " ").trim();
  if (!q) throw bad('"query" is required - a drug, food, ingredient, brand or device, e.g. "losartan", "peanut butter", "insulin pump"');
  if (q.length < 2 || q.length > MAX_QUERY_CHARS) throw bad(`"query" must be 2-${MAX_QUERY_CHARS} characters`);
  if (!/^[\p{L}\p{N} .,'()&+/-]+$/u.test(q)) throw bad('"query" contains unsupported characters');
  return q;
}

/** The probe stage (no LLM): every FDA enforcement feed for the query.
 *  Returns the normalized recall rows, per-feed status, the sorted recall
 *  numbers and a fingerprint of them (what the monitor compares). */
export async function probeRecalls(query, { perFeed = 20, scope = "all" } = {}) {
  const feeds = FEEDS.filter((f) => scope === "all" || f.kind === scope);
  // `full: true` lifts the public tools' field caps (a report must not quote a
  // reason cut mid-sentence as if complete); rows come back NEWEST FIRST with
  // the feed's TOTAL so the report can say "showing N of TOTAL".
  const legs = await Promise.all(feeds.map((f) => settle(H(f.slug)({ q: query, limit: perFeed, full: true }), PROBE_TIMEOUT_MS)));
  const items = [];
  const status = {};
  const totals = {};
  feeds.forEach((f, i) => {
    const r = legs[i];
    status[f.kind] = r.ok ? "ok" : `failed: ${String(r.error).slice(0, 120)}`;
    if (!r.ok) return;
    const rows = r.data?.recalls || [];
    totals[f.kind] = Number.isFinite(Number(r.data?.total)) ? Number(r.data.total) : rows.length;
    for (const x of rows) {
      items.push({
        kind: f.kind, recallNumber: x.recallNumber || null, firm: x.firm || null, classification: x.classification || null,
        status: x.status || null, reason: x.reason || "", product: x.product || "", distribution: x.distribution || null,
        recallInitiated: x.recallInitiated || null, eventId: x.eventId || null, terminated: x.terminated || null,
        lots: x.lots || null, quantity: x.quantity || null, voluntary: x.voluntary || null,
      });
    }
  });
  const okFeeds = feeds.filter((f) => status[f.kind] === "ok").length;
  // Minimum evidence: a report sold as "drug, food and device" must have read
  // at least two of the three feeds (or the single feed of a narrowed scope).
  if (okFeeds < Math.min(2, feeds.length)) throw bad(`Could not read enough FDA enforcement feeds (openFDA: ${Object.entries(status).map(([k, v]) => `${k} ${v}`).join("; ")}) - not charged; please retry.`, 502);
  // Newest first; stable on recall number so the fingerprint is deterministic.
  items.sort((a, b) => String(b.recallInitiated || "").localeCompare(String(a.recallInitiated || "")) || String(a.recallNumber || "").localeCompare(String(b.recallNumber || "")));
  const ids = [...new Set(items.map((x) => x.recallNumber).filter(Boolean))].sort();
  const totalAll = Object.values(totals).reduce((a, b) => a + b, 0);
  const events = new Set(items.map((x) => x.eventId).filter(Boolean)).size;
  return { query, items, status, totals, totalAll, events, ids, fingerprint: JSON.stringify(ids), sources: feeds.map((f) => ({ title: `${f.label} matching "${query}" - openFDA enforcement (newest first)`, url: `${f.source}?search=${encodeURIComponent(`product_description:"${query}"`)}&sort=recall_initiation_date:desc&limit=${perFeed}` })) };
}

const byKindCount = (items, kind) => items.filter((x) => x.kind === kind).length;
const priceUsdOf = (t) => Number(String(t?.price ?? "").replace(/[^0-9.]/g, "")) || null;

function makeRecallHandlerInner(tierSlug) {
  const t = RECALL_TIERS[tierSlug];
  return async (input, req) => {
    if (!input || typeof input !== "object") throw bad('Body must be a JSON object: {"query": "losartan"}');
    const query = normRecallQuery(input);
    const scope = ["drug", "food", "device"].includes(input.scope) ? input.scope : "all";
    // The monitor's welcome report may legitimately find nothing yet - that is
    // honoured ONLY for the scheduler's own calls (its pseudo-request carries a
    // "sub:<id>" buyer key), never for a paying buyer (who would get an empty
    // paid report).
    const allowEmpty = input.allowEmpty === true && /^sub:/.test(String(req?.headers?.authorization || ""));
    const user = safeUser(req);

    // 1) PROBES (free, deterministic).
    const pr = await probeRecalls(query, { perFeed: t.perFeed, scope });
    if (!pr.items.length && !allowEmpty) throw bad(`No FDA recall records match "${query}" across drug, food and device enforcement feeds (as of today). Not charged - try a broader term (brand, ingredient, generic name).`, 422);

    // 2) GROUNDING BLOCK.
    const byClass = {};
    for (const x of pr.items) byClass[x.classification || "Unclassified"] = (byClass[x.classification || "Unclassified"] || 0) + 1;
    const byKind = {};
    for (const x of pr.items) byKind[x.kind] = (byKind[x.kind] || 0) + 1;
    const ongoing = pr.items.filter((x) => /ongoing/i.test(String(x.status || ""))).length;
    // Every fetched row is spelled out (<= 3 feeds x perFeed); a silent slice
    // under a "records: N" total misstated the universe.
    const lines = pr.items.map((x, i) => `${i + 1}. [${x.kind}] ${x.recallInitiated || "?"}${x.terminated ? ` (terminated ${x.terminated})` : ""} · ${x.classification || "?"} · ${x.status || "?"} · ${x.firm || "?"} · PRODUCT: ${x.product || "?"} · REASON: ${x.reason || "?"} · DISTRIBUTION: ${x.distribution || "?"}${x.quantity ? ` · QUANTITY: ${x.quantity}` : ""}${x.lots ? ` · LOTS: ${x.lots}` : ""} · ${x.recallNumber || ""}${x.eventId ? ` (event ${x.eventId})` : ""}`).join("\n");
    const shown = Object.entries(pr.totals || {}).map(([k, total]) => `${k}: ${byKindCount(pr.items, k)} of ${total}`).join(", ");
    const feedStatus = Object.entries(pr.status).map(([k, v]) => `${k}: ${v}`).join("; ");
    const numbered = pr.sources.map((s, i) => ({ n: i + 1, ...s }));

    // 3) SYNTHESIZE - grounding-strict.
    const synthPrompt = `You are a product-safety analyst writing an FDA RECALL REPORT on "${query}" that will be SOLD to a paying customer. Accuracy is paramount: every fact must come from the FDA RECORDS below; a fabricated recall, firm, date or reason fails the whole report.

=== ABSOLUTE GROUNDING RULES ===
1. Use ONLY the FDA RECORDS listed below (openFDA enforcement feeds for drugs, foods and medical devices). Treat them as your only knowledge. NEVER introduce a recall, a company, a date, a lot number or a statistic from memory.
2. Reproduce classifications, statuses, firms, dates and reasons exactly as given. Class I = reasonable probability of serious adverse health consequences or death; Class II = temporary or medically reversible consequences; Class III = not likely to cause adverse health consequences - you may explain these definitions.
3. CITATIONS: the FDA feeds are numbered [1] to [${numbered.length}] (one per feed). Cite the feed a record came from as [n] - drug = [1]${numbered.length > 1 ? ", food = [2]" : ""}${numbered.length > 2 ? ", device = [3]" : ""}. A citation is ONLY a bracketed number. Do NOT write a "Sources" section - it is appended automatically.
4. This is NOT medical or legal advice. Where you suggest action, keep it to: check the named product/lot against the FDA record, contact the recalling firm or a pharmacist/physician, and monitor for updates. Never tell a reader to stop or start a medication.
5. If the records are few or zero, SAY SO plainly and do not pad. Prioritize COMPLETING the report over length.
6. THE RECORDS BELOW ARE THE NEWEST N PER FEED, NOT THE UNIVERSE: the TOTALS line says how many records each feed holds in total. When a feed's total exceeds the rows shown, say "the N most recent of TOTAL" and never present the shown set as complete or its oldest row as the earliest recall. A record is one product line; several records share one recall EVENT (event id) - count events when you say how many recalls there were. A gap in this material is never a finding about the product or the firm: if something is not in the records shown, say the records shown do not include it.

Write a clear, well-structured report of up to ${t.words} words with these sections where the material supports them: SNAPSHOT (how many records, by feed and by class, how many ongoing, the date range), WHAT IS RECALLED (products and firms, grouped sensibly), WHY (the reasons, grouped - contamination, labeling, impurity, defect, etc.), HOW WIDE (distribution patterns), STATUS & TIMELINE (ongoing vs terminated/completed, the most recent actions), and WHAT TO DO (per rule 4). Be specific; quote the FDA reason wording where useful.

=== QUERY ===\n"${query}" (scope: ${scope}). Feeds probed: ${feedStatus}.
=== TOTALS ===\nrecords shown: ${pr.items.length} of ${pr.totalAll} matching records in openFDA (${shown || "per-feed totals unavailable"}); distinct recall events among the shown records: ${pr.events}; by class (shown): ${JSON.stringify(byClass)}; ongoing (shown): ${ongoing}.
=== FDA RECORDS (newest first per feed; ${pr.items.length} of ${pr.totalAll}) ===\n${lines || "(no records matched)"}`;

    let spent = 0;
    const sd = await chat({ model: SYNTH, messages: [{ role: "user", content: synthPrompt }], max_tokens: t.synthMaxTokens, reasoning: { enabled: false } }, SYNTH_TIMEOUT_MS, user);
    spent += costOf(sd);
    const prose = textOf(sd);
    if (!prose) throw bad("Recall report synthesis produced nothing - not charged", 502);
    const header = `# FDA Recall Report: ${query}\n\n**${pr.items.length} most recent of ${pr.totalAll} record${pr.totalAll === 1 ? "" : "s"}** (${pr.events} recall event${pr.events === 1 ? "" : "s"} among those shown) across ${Object.keys(pr.status).length} FDA enforcement feed${Object.keys(pr.status).length === 1 ? "" : "s"} · ${ongoing} of the shown records ongoing\n`;
    const sourceList = numbered.map((s) => `[${s.n}] ${s.title} - ${s.url}`).join("\n");
    const report = `${header}\n${prose}\n\n## Sources\n${sourceList}`;

    // 4) DATA APPENDIX.
    const tables = [{
      name: "recalls", label: "FDA recall records",
      columns: ["Feed", "Initiated", "Terminated", "Class", "Status", "Firm", "Product", "Reason", "Distribution", "Quantity", "Lots", "Recall number", "Event"],
      rows: pr.items.map((x) => [x.kind, x.recallInitiated || "", x.terminated || "", x.classification || "", x.status || "", x.firm || "", x.product || "", x.reason || "", x.distribution || "", x.quantity || "", x.lots || "", x.recallNumber || "", x.eventId || ""]),
    }];
    const meta = { disclaimer: "A summary of public FDA enforcement records. Not medical advice and not a safety determination. Check the FDA record and the manufacturer before acting on it.", tier: tierSlug, query, scope, records: pr.items.length, records_total: pr.totalAll, totals_by_feed: pr.totals, events_shown: pr.events, by_feed: byKind, by_class: byClass, ongoing, feeds: pr.status, recall_numbers: pr.ids.length, sources_cited: numbered.length, synthesis_model: SYNTH,
      disclaimer: "FDA enforcement records as published by openFDA; not medical or legal advice. Verify the named product and lot against the FDA record." };
    const out = { report, query, sources: numbered, tables, meta };
    recordCompositeUsage({ slug: tierSlug, upstreamUsd: spent, ok: true, priceUsd: priceUsdOf(RECALL_TIERS[tierSlug]) });
    return out;
  };
}

export function makeRecallHandler(tierSlug) {
  const run = makeRecallHandlerInner(tierSlug);
  return async (input, req) => {
    try { return await run(input, req); }
    catch (e) { try { recordCompositeUsage({ slug: tierSlug, upstreamUsd: 0, ok: false, priceUsd: priceUsdOf(RECALL_TIERS[tierSlug]) }); } catch { /* never mask */ } throw e; }
  };
}

const SCHEMA = {
  type: "object",
  required: ["query"],
  properties: {
    query: { type: "string", description: "A drug, food, ingredient, brand or medical device to search FDA recalls for, e.g. \"losartan\", \"peanut butter\", \"insulin pump\"." },
    scope: { type: "string", enum: ["all", "drug", "food", "device"], description: "Which FDA enforcement feeds to search (default all)." },
  },
};
const OUT_EXAMPLE = {
  report: "# FDA Recall Report: losartan\n\n**7 records** across 3 FDA enforcement feeds · 2 ongoing\n\n## Snapshot\n...\n\n## Sources\n[1] FDA drug recalls matching \"losartan\" - openFDA enforcement - https://api.fda.gov/drug/enforcement.json?...",
  query: "losartan",
  sources: [{ n: 1, title: "FDA drug recalls matching \"losartan\" - openFDA enforcement", url: "https://api.fda.gov/drug/enforcement.json?search=product_description%3A%22losartan%22&limit=20" }],
  tables: [{ name: "recalls", label: "FDA recall records", columns: ["Feed", "Initiated", "Class", "Status", "Firm", "Product", "Reason", "Distribution", "Recall number"], rows: [["drug", "2019-11-08", "Class II", "Terminated", "Torrent Pharmaceuticals", "Losartan Potassium Tablets", "Presence of an impurity", "Nationwide", "D-123-2020"]] }],
  meta: { tier: "recall-report", query: "losartan", scope: "all", records: 7, ongoing: 2, sources_cited: 3, synthesis_model: "anthropic/claude-opus-5" },
};

export const RECALL_TOOLS = [
  {
    route: "POST /v1/recall-report", name: "FDA recall report (drug, food, device)", slug: "recall-report", category: "llm", price: RECALL_TIERS["recall-report"].price,
    description: "Name a drug, food, ingredient, brand or medical device and get one cited FDA recall report: every matching enforcement record across the drug, food and device feeds (firm, class I/II/III, status, reason, distribution, date), organized and explained, with a downloadable records appendix. Live openFDA data, not medical advice. USDC (x402/MPP) or card (Stripe). Not cached.",
    tags: ["fda", "recall", "drug", "food", "device", "safety", "report", "openfda", "research", "agentic-finance", "x402", "mpp"],
    discovery: { bodyType: "json", input: { query: "losartan" }, inputSchema: SCHEMA, output: { example: OUT_EXAMPLE } },
    handler: makeRecallHandler("recall-report"),
  },
];
