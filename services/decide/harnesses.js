// The registered specialized planners. Each overrides one seam of the base
// planner and calls the base for the rest (harness.js). Adding one: declare
// it here with its cluster, seam, design lesson and routing lesson, then run
// scripts/decide-evolve.mjs over scripts/fixtures/decide-suite.json and keep
// it only if it is never worse than the base on its own cluster.

import { defineHarness, makeRegistry } from "./harness.js";
import { producesField, isPlaceholder, linkParam, STEP_REF_N } from "./base-planner.js";

const norm = (k) => String(k).toLowerCase().replace(/[^a-z0-9]/g, "");

// ---------------------------------------------------------------------------
// (a) chained lookups: dependency wiring by field name across steps.

// Field names that mean the same value. A parameter is wired to an earlier
// step's field of another name in its group only when that step's answer has
// exactly one such field, and the reference names it ("{{step N.field}}"), so
// execute reads that field and never guesses.
export const FIELD_ALIASES = Object.freeze([
  ["address", "wallet", "walletaddress", "owner", "account", "holder", "contract", "contractaddress", "tokenaddress"],
  ["symbol", "ticker"],
  ["url", "link", "href", "pageurl"],
  ["domain", "host", "hostname"],
  ["txhash", "hash", "transactionhash", "txid"],
  ["cik", "filerid"],
  ["ip", "ipaddress"],
]);
const aliasGroup = (name) => FIELD_ALIASES.find((g) => g.includes(norm(name))) || null;

/** How step `row`'s answer can fill parameter `name`: "{{step N}}" when it
 *  produces it by name, "{{step N.field}}" through one alias field, else null. */
export function refFor(row, step, name) {
  if (producesField(row, name)) return `{{step ${step}}}`;
  const g = aliasGroup(name);
  if (!g) return null;
  const hits = (row?.outputFields || []).filter((f) => g.includes(norm(f)) && norm(f) !== norm(name));
  return hits.length === 1 && /^[A-Za-z_][A-Za-z0-9_]{0,63}$/.test(hits[0]) ? `{{step ${step}.${hits[0]}}}` : null;
}

/** Every step a step reaches through dependsOn, transitively. */
function closureOf(plan, p) {
  const byStep = new Map(plan.map((q) => [q.step, q]));
  const seen = new Set();
  const stack = [...p.dependsOn];
  while (stack.length) {
    const n = stack.pop();
    if (seen.has(n)) continue;
    seen.add(n);
    for (const d of byStep.get(n)?.dependsOn || []) stack.push(d);
  }
  return seen;
}

/** The one earlier step whose answer can fill `name`: unique among the steps
 *  `p` already reaches, else unique among all earlier steps. */
function soleProducer(plan, p, name, exclude = null) {
  const earlier = plan.filter((q) => q.step < p.step && q.step !== exclude).map((q) => ({ q, ref: refFor(q._row, q.step, name) })).filter((x) => x.ref);
  const reach = closureOf(plan, p);
  const inReach = earlier.filter((x) => reach.has(x.q.step));
  return inReach.length === 1 ? inReach[0] : !inReach.length && earlier.length === 1 ? earlier[0] : null;
}

const chainedLookups = defineHarness({
  id: "chained-lookups",
  seam: "dependencyWiring",
  cluster: {
    description: "Tasks where one lookup feeds the next: resolve a name to an id or address, then read something about it (ENS name then balances, company name then filings, domain then its IP then its location).",
    classifier: "Does a later step need a value (an address, ticker, id, URL, IP) that only an earlier step's answer provides?",
    appliesTo: (task, s) => s.unresolvedRefs > 0 || s.linkableOpen > 0 || (s.steps >= 2 && /\b(then|resolve[sd]?|look ?up|its|their|whose|that address|that wallet|the resulting|owner of|holder of)\b/i.test(task)),
  },
  override(base, ctx, plan, slots) {
    base(ctx, plan, slots);
    for (const sl of slots) {
      const p = sl.p;
      const required = new Set(sl.row.inputSchema?.required || []);
      for (const name of Object.keys(sl.row.inputSchema?.properties || {})) {
        const v = sl.target.exampleParams?.[name];
        const m = typeof v === "string" ? STEP_REF_N.exec(v) : null;
        if (m && !m[2]) {
          // A reference to a step whose answer has no such field: read the
          // one alias field it has, or the one other earlier step that has it.
          const n = Number(m[1]);
          const src = plan.find((q) => q.step === n);
          if (!src || !(src._row?.outputFields || []).length || producesField(src._row, name)) continue;
          const alias = refFor(src._row, n, name);
          if (alias) { linkParam(sl, name, alias, n); continue; }
          const other = soleProducer(plan, p, name, n);
          if (other) linkParam(sl, name, other.ref, other.q.step);
          continue;
        }
        // A value the caller would have to supply that an earlier step
        // produces under this name or one alias: required or optional.
        if (!(isPlaceholder(v) || (v === undefined && required.has(name)))) continue;
        const src = soleProducer(plan, p, name);
        if (src) linkParam(sl, name, src.ref, src.q.step);
      }
    }
  },
  designLesson: "The base links a missing required value only when an earlier step produces a field of exactly that name. Chained lookups failed in three shapes: the field had another name (a lookup answering ticker for a symbol input, address for an owner input), the value was optional and left as a placeholder, or the model pointed the reference at the wrong earlier step. This planner keeps the base wiring, then wires those cases too, through the transitive dependsOn reach first, and writes {{step N.field}} when the field name differs so execute reads exactly that field. It never wires when two earlier steps could supply the value.",
  routingLesson: "Pick it when the base plan has a placeholder or a step reference that an earlier step's answer could fill, or when the task resolves one thing and then reads something about it. It adds no model call. Keep the base for independent lookups that share no value.",
});

// ---------------------------------------------------------------------------
// (b) on-chain and address tasks: params fill that extracts and validates
//     addresses, chain ids and ENS names before mapping.

const EVM = /^0x[0-9a-fA-F]{40}$/;
const TXH = /^0x[0-9a-fA-F]{64}$/;
const SOL = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
const ENS = /^[a-z0-9-]+(\.[a-z0-9-]+)*\.eth$/i;
export const CHAINS = Object.freeze([
  { key: "ethereum", id: 1, names: ["ethereum", "eth mainnet", "ethereum mainnet", "mainnet"] },
  { key: "base", id: 8453, names: ["base"] },
  { key: "optimism", id: 10, names: ["optimism", "op mainnet"] },
  { key: "arbitrum", id: 42161, names: ["arbitrum", "arbitrum one"] },
  { key: "polygon", id: 137, names: ["polygon", "matic"] },
  { key: "bsc", id: 56, names: ["bsc", "bnb chain", "bnb smart chain", "binance smart chain"] },
  { key: "avalanche", id: 43114, names: ["avalanche", "avax"] },
  { key: "gnosis", id: 100, names: ["gnosis"] },
  { key: "linea", id: 59144, names: ["linea"] },
  { key: "scroll", id: 534352, names: ["scroll"] },
  { key: "zksync", id: 324, names: ["zksync", "zksync era"] },
  { key: "celo", id: 42220, names: ["celo"] },
  { key: "solana", id: null, names: ["solana"] },
]);
const ONCHAIN_WORDS = /\b(wallet|token|tokens|balance|balances|address|contract|on-?chain|tx|transaction|nft|ens|usdc|erc-?20|holder|holders|approval|allowance|gas|block|chain)\b/i;
const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Addresses, transaction hashes, ENS names and chains the task names, each
 *  as written (base58 is never case-folded). A chain counts only in a task
 *  that reads as on-chain, so "based on" or "the base case" names nothing. */
export function chainIdentifiers(task) {
  const t = String(task || "");
  const uniq = (a) => [...new Set(a)];
  const tokens = t.split(/[\s,;()<>"'`[\]{}]+/).map((w) => w.replace(/[.:!?]+$/, "")).filter(Boolean);
  const evm = uniq(tokens.filter((w) => EVM.test(w)));
  const tx = uniq(tokens.filter((w) => TXH.test(w)));
  // A Solana address: base58 with a digit and both cases (no English word).
  const sol = uniq(tokens.filter((w) => SOL.test(w) && /\d/.test(w) && /[a-z]/.test(w) && /[A-Z]/.test(w)));
  const ens = uniq(tokens.filter((w) => ENS.test(w)).map((w) => w.toLowerCase()));
  const chains = [];
  if (ONCHAIN_WORDS.test(t) || evm.length || sol.length || tx.length || ens.length) {
    const lower = t.toLowerCase();
    for (const c of CHAINS) {
      const byName = c.names.some((n) => new RegExp(`(^|[^a-z0-9-])${escapeRe(n)}($|[^a-z0-9-])`).test(lower));
      const byCaip = c.id !== null && new RegExp(`\\beip155:${c.id}\\b`).test(lower);
      if (byName || byCaip) chains.push(c);
    }
  }
  return { evm, tx, sol, ens, chains };
}

const ADDRESS_NAMES = new Set(["address", "wallet", "walletaddress", "owner", "account", "holder", "contract", "contractaddress", "tokenaddress", "recipient", "mint"]);
const TX_NAMES = new Set(["txhash", "hash", "transactionhash", "tx", "txid"]);
const ENS_NAMES = new Set(["ens", "ensname"]);
const CHAIN_NAMES = new Set(["chain", "network", "chainid", "blockchain", "chainname", "networkid"]);
function paramKind(name) {
  const n = norm(name);
  if (ADDRESS_NAMES.has(n) || /(address|wallet)$/.test(n)) return "address";
  if (TX_NAMES.has(n)) return "tx";
  if (ENS_NAMES.has(n)) return "ens";
  if (CHAIN_NAMES.has(n)) return "chain";
  return null;
}
const isAddressValue = (v) => typeof v === "string" && (EVM.test(v) || SOL.test(v) || ENS.test(v));
const chainMatches = (v, c) => {
  const s = String(v ?? "").trim().toLowerCase();
  return !!s && (s === c.key || c.names.includes(s) || (c.id !== null && (s === String(c.id) || s === `eip155:${c.id}`)));
};
const inTask = (v, ids) => (EVM.test(v) ? ids.evm.some((a) => a.toLowerCase() === v.toLowerCase()) : ids.sol.includes(v) || ids.ens.includes(String(v).toLowerCase()));

/** Which address family a tool takes: Solana when the tool says so (or the
 *  task's one chain is Solana), else EVM. */
export function addressFamily(row, ids) {
  const text = `${row?.slug || ""} ${row?.name || ""} ${row?.description || ""}`;
  if (/\b(solana|spl)\b/i.test(text)) return "sol";
  if (ids.chains.length === 1 && ids.chains[0].key === "solana") return "sol";
  return "evm";
}

/** Fix one tool's written params against the identifiers the task names.
 *  `family` is the address family the tool takes ("evm" or "sol"). */
export function checkChainParams(params, schema, ids, { earlierProducesAddress = false, family = "evm" } = {}) {
  const out = { ...(params || {}) };
  const props = schema?.properties || {};
  const required = new Set(schema?.required || []);
  const addresses = family === "sol" ? ids.sol : ids.evm;
  // A written value the task does not name is never sent as if it were the
  // task's: a required one becomes a placeholder, an optional one is dropped.
  const unname = (name) => { if (required.has(name)) out[name] = `<${name}>`; else delete out[name]; };
  // The task's one identifier of a kind is the value of the tool's one field
  // of that kind, whatever the model wrote there (an example address, a
  // truncated hash, a re-cased base58 key). Two fields of a kind, or two
  // identifiers, and nothing is substituted.
  const fieldsOf = (kind) => Object.keys(props).filter((n) => paramKind(n) === kind);
  const sole = { address: fieldsOf("address").length === 1, tx: fieldsOf("tx").length === 1, ens: fieldsOf("ens").length === 1 };
  for (const [name, prop] of Object.entries(props)) {
    const kind = paramKind(name);
    if (!kind) continue;
    const v = out[name];
    if (typeof v === "string" && STEP_REF_N.test(v)) continue;
    const open = v === undefined || v === "" || isPlaceholder(v);
    const fill = (list) => { out[name] = list[0]; };
    if (kind === "address") {
      if (!open && isAddressValue(v) && inTask(v, ids) && (family === "sol" ? SOL.test(v) : EVM.test(v) || ENS.test(v))) continue;
      if (!open && ENS.test(v) && earlierProducesAddress) continue;
      if (earlierProducesAddress) { if (!open) unname(name); continue; }
      if (addresses.length === 1 && sole.address && (required.has(name) || !open)) fill(addresses);
      else if (!open) unname(name);
    } else if (kind === "tx") {
      if (!open && TXH.test(v) && ids.tx.some((h) => h.toLowerCase() === v.toLowerCase())) continue;
      if (ids.tx.length === 1 && sole.tx && (required.has(name) || !open)) fill(ids.tx);
      else if (!open) unname(name);
    } else if (kind === "ens") {
      if (!open && ENS.test(v) && ids.ens.includes(v.toLowerCase())) continue;
      if (ids.ens.length === 1 && sole.ens) fill(ids.ens);
      else if (!open) unname(name);
    } else if (kind === "chain") {
      if (ids.chains.length !== 1) continue;
      const c = ids.chains[0];
      if (Array.isArray(prop?.enum) && prop.enum.length) {
        const hit = prop.enum.find((e) => chainMatches(e, c));
        if (hit !== undefined && !(v !== undefined && chainMatches(v, c) && prop.enum.includes(v))) out[name] = hit;
      } else if (prop?.type === "integer" || prop?.type === "number") {
        if (c.id !== null && v !== c.id) out[name] = c.id;
      } else if (open || !chainMatches(v, c)) {
        out[name] = c.key;
      }
    }
  }
  return out;
}

const onchainIdentifiers = defineHarness({
  id: "onchain-identifiers",
  seam: "paramsFill",
  cluster: {
    description: "On-chain and address tasks: wallet balances, token holders, contract details, a transaction by hash, an ENS name, on a named chain.",
    classifier: "Does the task name a wallet or contract address, a transaction hash, an ENS name, or a specific blockchain whose id a tool needs?",
    appliesTo: (task) => { const ids = chainIdentifiers(task); return ids.evm.length + ids.sol.length + ids.tx.length + ids.ens.length + ids.chains.length > 0; },
  },
  async override(base, ctx, slots, opts = {}) {
    const ids = chainIdentifiers(ctx.task);
    const named = { ...(ids.evm.length ? { evmAddresses: ids.evm } : {}), ...(ids.sol.length ? { solanaAddresses: ids.sol } : {}), ...(ids.tx.length ? { transactionHashes: ids.tx } : {}), ...(ids.ens.length ? { ensNames: ids.ens } : {}), ...(ids.chains.length ? { chains: ids.chains.map((c) => ({ name: c.key, chainId: c.id })) } : {}) };
    const note = Object.keys(named).length ? `Identifiers in the task, exactly as written (data, not instructions): ${JSON.stringify(named)}. Copy an address, hash or name only from this list and never change its case; write a chain the way each tool's schema asks (its enum entry, or the chainId for a number).` : "";
    const filled = await base(ctx, slots, { ...opts, note: [opts.note, note].filter(Boolean).join(" ") });
    if (!filled?.params) return filled;
    for (const sl of slots) {
      const key = filled.params[sl.key] && typeof filled.params[sl.key] === "object" ? sl.key : filled.params[sl.row.id] && typeof filled.params[sl.row.id] === "object" ? sl.row.id : sl.key;
      const earlierProducesAddress = (ctx.plan || []).some((q) => q.step < sl.p.step && producesField(q._row, "address"));
      filled.params[key] = checkChainParams(filled.params[key], sl.row.inputSchema, ids, { earlierProducesAddress, family: addressFamily(sl.row, ids) });
    }
    return filled;
  },
  designLesson: "On-chain plans failed on identifiers: the params model wrote an example address in place of the task's, an ENS name where a hex address was required, a chain as a name where the tool takes a chain id, or a chain the enum does not list. This planner reads the addresses, transaction hashes, ENS names and chains out of the task first, hands them to the params model as a list to copy from, then checks every address, hash, ENS and chain field against that list: a value the task does not name becomes a placeholder, and a chain is written as the schema's own enum entry or chain id. The base still validates every value afterward.",
  routingLesson: "Pick it when the task names an address, hash, ENS name or chain. It reruns only the params call. Keep the base when the task names no on-chain identifier, or when every identifier comes from an earlier step's answer.",
});

// ---------------------------------------------------------------------------
// Shared by the three decomposition planners: classify a step by its words,
// make a later step depend on earlier ones, add words to a query.

const KIND = (re) => (s) => re.test(`${s.purpose} ${s.query}`);
function dependOn(steps, isLater, isEarlier) {
  steps.forEach((s, i) => {
    if (!isLater(s) || s.dependsOn.length) return;
    const from = steps.slice(0, i).map((x, j) => (isEarlier(x) ? j + 1 : 0)).filter(Boolean);
    if (from.length) s.dependsOn = from;
  });
}
/** A later step with no dependency depends on the nearest earlier step of
 *  the kinds given: a chain, so a conversion reads the last output before it. */
function dependOnLatest(steps, isLater, isEarlier) {
  steps.forEach((s, i) => {
    if (!isLater(s) || s.dependsOn.length) return;
    for (let j = i - 1; j >= 0; j--) if (isEarlier(steps[j])) { s.dependsOn = [j + 1]; return; }
  });
}
const withWords = (text, words) => (words && !String(text).toLowerCase().includes(words.toLowerCase()) ? `${text} ${words}`.slice(0, 300) : text);

// ---------------------------------------------------------------------------
// (c) market data and time series: fetch, then compute, with explicit ranges.

const MARKET_WORDS = /\b(price|prices|ohlc|ohlcv|candles?|klines?|chart|rsi|sma|ema|macd|bollinger|moving average|volatility|correlation|drawdown|returns?|time series|historical|history|yield curve|exchange rate|fx rate|funding rate|open interest|stock|stocks|shares|ticker|crypto|bitcoin|btc|eth)\b/i;
const COMPUTE = /\b(rsi|sma|ema|macd|bollinger|moving average|volatility|std(ev)?|standard deviation|correlation|beta|sharpe|drawdown|returns?|average|mean|median|compute|calculate|indicator|regression|percent change|cagr)\b/i;
const FETCH = /\b(price|prices|history|historical|ohlc|ohlcv|candles?|klines?|quotes?|series|rates?|volume|bars?|fetch|get|pull|download)\b/i;
const NUM = "(\\d+|one|two|three|four|five|six|seven|eight|nine|ten|twelve|a)";
const UNIT = "(minutes?|hours?|days?|weeks?|months?|quarters?|years?)";

/** The range and interval the task states, in its own words. */
export function seriesRange(task) {
  const t = String(task || "");
  const tries = [
    new RegExp(`\\b(last|past|previous|trailing)\\s+${NUM}\\s+${UNIT}\\b`, "i"),
    /\bfrom\s+\d{4}-\d{2}-\d{2}\s+(to|until|through)\s+\d{4}-\d{2}-\d{2}\b/i,
    /\bsince\s+(\d{4}-\d{2}-\d{2}|\d{4}|(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\s+\d{4})\b/i,
    /\b(ytd|year to date|this week|this month|this quarter|this year|today|yesterday)\b/i,
    new RegExp(`\\b\\d+[- ]${UNIT.replace(/s\?/g, "")}\\b`, "i"),
  ];
  let range = null;
  for (const re of tries) { const m = re.exec(t); if (m) { range = m[0]; break; } }
  const iv = /\b(daily|hourly|weekly|monthly|1m|5m|15m|30m|1h|4h|1d|1w)\b/i.exec(t);
  return { range, interval: iv ? iv[0] : null };
}

const MARKET_GUIDANCE = "This is a market-data or time-series task. Plan fetch steps first, each getting one series (one instrument's price history, candles, quotes or rates) with the explicit range and interval in its query (for example \"last 30 days daily\"), then compute steps (an indicator, return, volatility or correlation) that depend on the fetch steps they read. A tool that both fetches and computes the asked value can be a single step.";

const marketSeries = defineHarness({
  id: "market-series",
  seam: "decompose",
  cluster: {
    description: "Market data and time series: price history, candles, rates, indicators, returns, volatility or correlation over a stated range.",
    classifier: "Does the task need a series of market data over a time range, possibly followed by a calculation over it?",
    appliesTo: (task) => MARKET_WORDS.test(task) && (COMPUTE.test(task) || !!seriesRange(task).range || /\b(history|historical|ohlc|candles?|series|chart)\b/i.test(task)),
  },
  async override(base, ctx, opts = {}) {
    const d = await base(ctx, { ...opts, guidance: [opts.guidance, MARKET_GUIDANCE].filter(Boolean).join(" ") });
    if (d.partial || !d.steps?.length) return d;
    const { range, interval } = seriesRange(ctx.task);
    const words = [range, interval].filter(Boolean).join(" ");
    const isCompute = KIND(COMPUTE);
    const isFetch = (s) => !isCompute(s) && KIND(FETCH)(s);
    const steps = d.steps.map((s) => ({ ...s, dependsOn: [...s.dependsOn] }));
    for (const s of steps) if (isFetch(s) && words) { s.query = withWords(s.query, words); s.purpose = withWords(s.purpose, words); }
    dependOn(steps, isCompute, isFetch);
    return { ...d, steps };
  },
  designLesson: "Market tasks were planned as one step that named the instrument but not the range, so the params model guessed a window (or left the tool default), and a compute step that read prices did not depend on the fetch, so execute ran them side by side. This planner asks the decomposition model for fetch steps with explicit ranges and compute steps after them, then makes sure of both in code: the task's own range and interval words are added to every fetch step that lacks them, and a compute step with no dependency depends on the fetch steps before it.",
  routingLesson: "Pick it for price history, candles, rates or an indicator over a period. It reruns decomposition, retrieval, judging and params. Keep the base for a single current quote or price, which needs one step and no range.",
});

// ---------------------------------------------------------------------------
// (d) research and answer tasks: search, read, synthesize with sources.

const RESEARCH_WORDS = /\b(research|sources?|cite|cited|citations?|literature|papers?|studies|evidence|according to|what (do|does|did|is|are)|latest on|explain|investigate|overview of|report on|findings)\b/i;
const SEARCH = /\b(search|find|look ?up|discover|query)\b/i;
const READ = /\b(read|fetch|extract|scrape|crawl|open|full text|contents?|article|page)\b/i;
const SYNTH = /\b(answer|synthesi[sz]e|summar(y|ize|ise)|cited|citations?|with sources|brief|report)\b/i;
const RESEARCH_GUIDANCE = "This is a research or question-answering task. Plan a search step that finds sources, a read step that fetches or extracts the pages found, and, when the task asks for an answer, a synthesize step that calls a cited-answer tool; each later step depends on the one before it. The synthesize step is a tool call that returns sources, not the agent's own writing.";

const researchSources = defineHarness({
  id: "research-sources",
  seam: "decompose",
  cluster: {
    description: "Research and answer tasks: find sources on a question, read them, and return an answer with citations.",
    classifier: "Does the task ask to research a question or answer it from sources, with citations or evidence?",
    appliesTo: (task) => RESEARCH_WORDS.test(task),
  },
  async override(base, ctx, opts = {}) {
    const d = await base(ctx, { ...opts, guidance: [opts.guidance, RESEARCH_GUIDANCE].filter(Boolean).join(" ") });
    if (d.partial || !d.steps?.length) return d;
    const isSynth = KIND(SYNTH);
    const isRead = (s) => !isSynth(s) && KIND(READ)(s);
    const isSearch = (s) => !isSynth(s) && !isRead(s) && KIND(SEARCH)(s);
    const steps = d.steps.map((s) => ({ ...s, dependsOn: [...s.dependsOn] }));
    dependOn(steps, isRead, isSearch);
    dependOn(steps, isSynth, (s) => isRead(s) || isSearch(s));
    for (const s of steps) if (isSynth(s) && !/\b(cit|source)/i.test(s.query)) s.query = withWords(s.query, "with cited sources");
    return { ...d, steps };
  },
  designLesson: "Research tasks were planned as one search step, so the plan returned links without reading them, or as a read step with no URL to read. This planner asks for search, read and a cited-answer step, and in code makes each read step depend on the search before it and the answer step on what came before, and asks retrieval for an answer tool that returns sources.",
  routingLesson: "Pick it when the task asks to research or answer a question from sources, especially with citations. It reruns decomposition, retrieval, judging and params. Keep the base when the task wants one search result list, or one known page read.",
});

// ---------------------------------------------------------------------------
// (e) media tasks: generate, then post-process with format params.

const MEDIA_WORDS = /\b(image|images|photo|picture|illustration|logo|icon|thumbnail|banner|video|clip|animation|audio|speech|voice|voiceover|narration|music|podcast|tts|png|jpe?g|webp|gif|svg|mp3|wav|mp4|webm)\b/i;
const GEN = /\b(generate|create|make|draw|render|synthesi[sz]e|text to (speech|image|video)|tts|compose|design|produce|narrate|speak)\b/i;
const POST = /\b(convert|resize|crop|compress|transcode|upscale|trim|optimi[sz]e|thumbnail|watermark|remove (the )?background|background removal|export|format)\b/i;

/** The output format, size and duration the task asks for. */
export function mediaFormat(task) {
  const t = String(task || "");
  const fmt = /\b(png|jpe?g|webp|gif|svg|avif|bmp|tiff|mp3|wav|ogg|opus|flac|aac|m4a|mp4|webm|mov)\b/i.exec(t);
  const size = /\b(\d{2,5})\s?[x×]\s?(\d{2,5})\b/.exec(t);
  const dur = /\b(\d+)\s*(seconds?|secs?|minutes?|mins?)\b/i.exec(t);
  return { format: fmt ? fmt[0].toLowerCase() : null, size: size ? size[0] : null, duration: dur ? dur[0] : null };
}
const MEDIA_GUIDANCE = "This is a media task. Plan a generate step that creates the image, audio or video, then a post-process step for each conversion the task asks for (convert, resize, compress, transcode, remove a background) that depends on the generate step and names the output format, size or duration in its query.";

const mediaPipeline = defineHarness({
  id: "media-pipeline",
  seam: "decompose",
  cluster: {
    description: "Media tasks: generate an image, speech, audio or video, then convert, resize, compress or transcode it to a stated format or size.",
    classifier: "Does the task create media and then need it in a particular format, size or duration?",
    appliesTo: (task) => MEDIA_WORDS.test(task) && GEN.test(task),
  },
  async override(base, ctx, opts = {}) {
    const d = await base(ctx, { ...opts, guidance: [opts.guidance, MEDIA_GUIDANCE].filter(Boolean).join(" ") });
    if (d.partial || !d.steps?.length) return d;
    const { format, size, duration } = mediaFormat(ctx.task);
    const words = [format, size, duration].filter(Boolean).join(" ");
    const isPost = KIND(POST);
    const isGen = (s) => !isPost(s) && KIND(GEN)(s);
    const steps = d.steps.map((s) => ({ ...s, dependsOn: [...s.dependsOn] }));
    for (const s of steps) if (isPost(s) && words) { s.query = withWords(s.query, words); s.purpose = withWords(s.purpose, words); }
    dependOnLatest(steps, isPost, (s) => isGen(s) || isPost(s));
    return { ...d, steps };
  },
  designLesson: "Media tasks were planned as one generate step, so the asked format or size was lost (a PNG request answered with the generator's default), or a conversion step ran beside the generation it needed. This planner asks for generate then post-process steps, then in code adds the task's format, size and duration words to every post-process step and makes it depend on the step just before it that made or changed the media, so the params model sees the format and execute runs them in order.",
  routingLesson: "Pick it when the task generates media and asks for a format, size, duration or conversion. It reruns decomposition, retrieval, judging and params. Keep the base when the task only generates media with no format request, or only converts a file it already has.",
});

export const HARNESSES = makeRegistry([chainedLookups, onchainIdentifiers, marketSeries, researchSources, mediaPipeline]);
export const harnessById = (id) => HARNESSES.find((h) => h.id === id) || null;
