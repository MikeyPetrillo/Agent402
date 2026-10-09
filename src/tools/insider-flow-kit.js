// insider-flow-kit — INSIDER FLOW REPORT for a US public company: every Form 4
// filed against it in a window, with the actual TRANSACTIONS parsed from each
// filing's XML (open-market buys and sells vs awards, option exercises, tax
// withholding, gifts), aggregated per insider and as a net flow, then explained
// in a grounding-strict cited report. The dossier shows Form 4 filing METADATA;
// this product reads the transactions themselves - the thing a buyer actually
// wants to know ("who is buying, who is selling, how much, at what price").
// Same skeleton as fund-report: deterministic data -> Opus synthesis ->
// numbered sources -> data appendix. Settlement-safe (throws >= 400 on
// failure), WALLET_ONLY, composite-guarded, not cached. 503 without
// OPENROUTER_API_KEY.
//
// `probeInsiderFilings()` is exported for the monitor scheduler: the cheap
// daily probe (one EDGAR full-text query, no XML fetch) whose fingerprint is
// the set of Form 4 accession numbers - a new one = paid re-run + email.
import { completeSynthesis, proseOf } from "../report-synthesis.js";
import { fetchOpenRouter, throwUpstreamError, bad, upstreamUserId } from "./llm-gateway-kit.js";
import { resolveCompany, eftsSearch, fetchXmlText } from "./edgar-kit.js";
import { recordCompositeUsage } from "../composite-spend-guard.js";

function safeUser(req) { try { return req ? upstreamUserId(req) : undefined; } catch { return undefined; } }

const SYNTH = "anthropic/claude-opus-5";
export const INSIDER_MODELS = [SYNTH];
export const INSIDER_TIERS = {
  // maxFilings 100 = one EDGAR full-text page; the reads are XML only (no LLM
  // cost), and 40 read the newest 40 of META's 172 in a 365-day window while
  // the header labelled the whole year.
  "insider-report": { price: "$0.60", maxUpstreamUsd: 0.35, maxFilings: 100, synthMaxTokens: 4500, words: "~1,500" },
};
const SYNTH_TIMEOUT_MS = 120_000;
// The lookback a call without "days" reads; the card storefront sends it too.
export const INSIDER_DEFAULT_DAYS = 90;
const XML_CONCURRENCY = 4;
const XML_TIMEOUT_MS = 20_000;

const CODES = {
  P: "open-market purchase", S: "open-market sale", A: "grant/award", M: "option exercise / conversion",
  F: "tax withholding (shares surrendered)", G: "gift", D: "disposition to issuer", C: "conversion of derivative",
  X: "exercise of in-the-money derivative", J: "other (see filing)", W: "acquired by will/inheritance", I: "discretionary transaction",
};

async function chat(body, timeoutMs, user) {
  const res = await fetchOpenRouter({ ...body, ...(user ? { user } : {}), usage: { include: true } }, { timeoutMs });
  if (!res.ok) await throwUpstreamError(res);
  return res.json();
}
const costOf = (d) => Number(d?.usage?.cost) || 0;
const textOf = (d) => (d?.choices?.[0]?.message?.content || "").trim();
const clampInt = (v, d, lo, hi) => { const n = parseInt(v, 10); return Number.isFinite(n) ? Math.min(Math.max(n, lo), hi) : d; };
const isoDate = (ms) => new Date(ms).toISOString().slice(0, 10);
const TICKER_RE = /^[A-Z][A-Z0-9.\-]{0,9}$/;

// --- Form 4 XML parsing (regex over a small, fixed vocabulary; the ownership
// schema is stable and our needs are a handful of leaf values) ---------------
const tag = (xml, name) => { const m = xml.match(new RegExp(`<${name}>([\\s\\S]*?)</${name}>`)); return m ? m[1].trim() : ""; };
// Nested tags inside a value (a <footnoteId/> in expirationDate) are dropped by
// stripXmlTags - the split-on-"<" walk, not a regex (CodeQL js/incomplete-
// multi-character-sanitization); it is a function declaration, so hoisted.
const val = (xml, name) => { const inner = tag(xml, name); const v = inner ? (tag(inner, "value") || inner) : ""; return stripXmlTags(v).replace(/\s+/g, " ").trim(); };
// Opening tag may carry attributes (Form 4 footnotes are `<footnote id="F1">`).
const blocks = (xml, name) => [...xml.matchAll(new RegExp(`<${name}(?:\\s[^>]*)?>([\\s\\S]*?)</${name}>`, "g"))].map((m) => m[1]);

/** Text content of an XML fragment: drops every tag by splitting on "<" and
 *  keeping what follows each tag's closing ">" (no regex, so there is nothing a
 *  nested "<scr<script>ipt>" can survive), then removes any stray angle bracket. */
function stripXmlTags(fragment) {
  const parts = String(fragment).split("<");
  let out = parts[0];
  for (let i = 1; i < parts.length; i++) {
    const seg = parts[i], gt = seg.indexOf(">");
    out += " " + (gt >= 0 ? seg.slice(gt + 1) : "");
  }
  return out.replace(/[<>]/g, "");
}

export function parseForm4(xml) {
  const owners = blocks(xml, "reportingOwner").map((o) => {
    const rel = tag(o, "reportingOwnerRelationship");
    return {
      name: tag(o, "rptOwnerName").replace(/\s+/g, " "),
      cik: tag(o, "rptOwnerCik"),
      isDirector: /<isDirector>\s*(1|true)\s*</i.test(rel), isOfficer: /<isOfficer>\s*(1|true)\s*</i.test(rel),
      isTenPct: /<isTenPercentOwner>\s*(1|true)\s*</i.test(rel), title: tag(rel, "officerTitle").replace(/\s+/g, " "),
    };
  });
  const tx = blocks(xml, "nonDerivativeTransaction").map((t) => ({
    security: val(t, "securityTitle"), date: val(t, "transactionDate"), code: tag(tag(t, "transactionCoding"), "transactionCode").trim(),
    shares: Number(val(t, "transactionShares")) || 0, price: Number(val(t, "transactionPricePerShare")) || 0,
    acqDisp: val(t, "transactionAcquiredDisposedCode"), ownedAfter: Number(val(t, "sharesOwnedFollowingTransaction")) || null,
    ownership: val(t, "directOrIndirectOwnership") || "",
  }));
  // Derivative transactions (RSU/option awards, exercises): 11 of META's 41
  // Form 4s in a 90-day window were derivative-only, and parsing only the
  // non-derivative table made those directors vanish from the report while
  // "41 filings read" stood in the header.
  const dtx = blocks(xml, "derivativeTransaction").map((t) => ({
    security: val(t, "securityTitle"), date: val(t, "transactionDate"), code: tag(tag(t, "transactionCoding"), "transactionCode").trim(),
    shares: Number(val(t, "transactionShares")) || 0, price: Number(val(t, "transactionPricePerShare")) || 0,
    exercisePrice: Number(val(t, "conversionOrExercisePrice")) || 0, underlying: val(t, "underlyingSecurityTitle"), underlyingShares: Number(val(t, "underlyingSecurityShares")) || 0,
    expires: val(t, "expirationDate"), acqDisp: val(t, "transactionAcquiredDisposedCode"), ownedAfter: Number(val(t, "sharesOwnedFollowingTransaction")) || null,
    ownership: val(t, "directOrIndirectOwnership") || "", derivative: true,
  }));
  // Holdings the filer reports without a transaction (indirect vehicles,
  // trusts): the "how much does this insider hold" answer, in the XML already
  // downloaded and never read before.
  const holdings = blocks(xml, "nonDerivativeHolding").map((h) => ({
    security: val(h, "securityTitle"), shares: Number(val(h, "sharesOwnedFollowingTransaction")) || 0,
    ownership: val(h, "directOrIndirectOwnership") || "", nature: val(h, "natureOfOwnership"),
  }));
  const derivativeCount = dtx.length;
  const footnotes = blocks(xml, "footnote").map((f) => stripXmlTags(f).replace(/\s+/g, " ").trim()).filter(Boolean).slice(0, 12);
  const plan10b5 = footnotes.some((f) => /10b5-1/i.test(f));
  return { issuer: tag(xml, "issuerName"), symbol: tag(xml, "issuerTradingSymbol"), period: tag(xml, "periodOfReport"), owners, transactions: tx, derivativeTransactions: dtx, holdings, derivativeCount, footnotes, plan10b5 };
}

/** The cheap probe: Form 4 filings against the issuer in the window (ONE EDGAR
 *  full-text query, no XML). Fingerprint = sorted accession numbers. */
export async function probeInsiderFilings({ ticker, cik, days = 90, limit = 40 }) {
  const resolved = await resolveCompany({ ticker, cik });
  const enddt = isoDate(Date.now()), startdt = isoDate(Date.now() - days * 86400 * 1000);
  const j = await eftsSearch({ forms: "4", ciks: resolved.cik, startdt, enddt });
  const hits = (j?.hits?.hits ?? []).slice(0, limit);
  const filings = hits.map((h) => {
    const s = h?._source || {};
    const id = String(h?._id || "");
    const [acc, doc] = id.split(":");
    const ownerCik = (s.ciks || []).find((c) => String(c).padStart(10, "0") !== resolved.cik) || s.ciks?.[0] || "";
    const accDir = String(acc || "").replace(/-/g, "");
    const rawDoc = String(doc || "").replace(/^xslF345X\d+\//, ""); // the raw XML, not the rendered view
    return { accessionNumber: acc || "", filedDate: s.file_date || "", ownerCik: String(ownerCik).padStart(10, "0"), displayNames: s.display_names || [], url: accDir && rawDoc ? `https://www.sec.gov/Archives/edgar/data/${parseInt(ownerCik || "0", 10)}/${accDir}/${rawDoc}` : "" };
  }).filter((f) => f.accessionNumber);
  const ids = [...new Set(filings.map((f) => f.accessionNumber))].sort();
  return { cik: resolved.cik, name: resolved.name, days, startDate: startdt, endDate: enddt, total: j?.hits?.total?.value ?? filings.length, filings, ids, fingerprint: JSON.stringify(ids) };
}

async function mapLimit(items, n, fn) {
  const out = new Array(items.length); let i = 0;
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => { while (i < items.length) { const k = i++; out[k] = await fn(items[k], k); } }));
  return out;
}
const withTimeout = (p, ms) => Promise.race([p, new Promise((_, r) => setTimeout(() => r(new Error("timeout")), ms))]);
const fmtUsd = (v) => `$${Math.round(v).toLocaleString("en-US")}`;
const priceUsdOf = (t) => Number(String(t?.price ?? "").replace(/[^0-9.]/g, "")) || null;

function makeInsiderHandlerInner(tierSlug) {
  const t = INSIDER_TIERS[tierSlug];
  return async (input, req) => {
    if (!input || typeof input !== "object") throw bad('Body must be a JSON object: {"ticker": "AAPL"}');
    const ticker = typeof input.ticker === "string" ? input.ticker.trim().toUpperCase() : "";
    const cikIn = input.cik != null ? String(input.cik).trim() : "";
    if (!ticker && !cikIn) throw bad('"ticker" (US stock ticker) or "cik" is required');
    if (ticker && !TICKER_RE.test(ticker)) throw bad(`"${ticker}" is not a valid US ticker`);
    const days = clampInt(input.days, INSIDER_DEFAULT_DAYS, 7, 365);
    const user = safeUser(req);

    // 1) FILINGS (cheap) -> 2) XML per filing (bounded concurrency).
    const pf = await probeInsiderFilings({ ticker: ticker || undefined, cik: cikIn || undefined, days, limit: t.maxFilings });
    if (!pf.filings.length) throw bad(`No Form 4 filings against ${ticker || pf.name || pf.cik} in the last ${days} days. Not charged - widen "days" (max 365) or check the ticker.`, 422);
    const parsed = await mapLimit(pf.filings, XML_CONCURRENCY, async (f) => {
      if (!f.url) return { f, err: "no-url" };
      try { const xml = await withTimeout(fetchXmlText(f.url), XML_TIMEOUT_MS); return { f, p: parseForm4(xml) }; }
      catch (e) { return { f, err: String(e?.message || e).slice(0, 100) }; }
    });
    const good = parsed.filter((x) => x.p);
    // Minimum evidence: at least half the filings in the window must have been
    // read, else this is an EDGAR incident and the report is not charged.
    if (!good.length || good.length < Math.ceil(pf.filings.length / 2)) throw bad(`Could only read ${good.length} of ${pf.filings.length} Form 4 filings from EDGAR (upstream). Not charged - please retry.`, 502);

    // 3) AGGREGATE (deterministic).
    const rows = [], drows = [], holdRows = [];
    const latestOwned = new Map();
    for (const { f, p } of good) {
      const who = p.owners[0] || {};
      const role = [who.isOfficer ? (who.title || "officer") : null, who.isDirector ? "director" : null, who.isTenPct ? "10% owner" : null].filter(Boolean).join(", ") || "reporting person";
      const insiderName = who.name || (f.displayNames?.[0] || "").replace(/\s*\(CIK[^)]*\)\s*$/i, "");
      for (const x of p.transactions) {
        rows.push({ accession: f.accessionNumber, filedDate: f.filedDate, insider: insiderName, role, security: x.security, date: x.date, code: x.code, kind: CODES[x.code] || x.code, shares: x.shares, price: x.price, valueUsd: x.shares * x.price, acqDisp: x.acqDisp, ownedAfter: x.ownedAfter, plan10b5: p.plan10b5, url: f.url, derivative: false });
      }
      for (const x of (p.derivativeTransactions || [])) {
        drows.push({ accession: f.accessionNumber, filedDate: f.filedDate, insider: insiderName, role, security: x.security, underlying: x.underlying, underlyingShares: x.underlyingShares, exercisePrice: x.exercisePrice, expires: x.expires, date: x.date, code: x.code, kind: CODES[x.code] || x.code, shares: x.shares, price: x.price, acqDisp: x.acqDisp, ownedAfter: x.ownedAfter, url: f.url, derivative: true });
      }
      for (const h of (p.holdings || [])) holdRows.push({ insider: insiderName, role, security: h.security, shares: h.shares, ownership: h.ownership, nature: h.nature, filedDate: f.filedDate, url: f.url });
      // The latest reported "owned after" per insider is their holding as of
      // that filing (direct only; indirect vehicles are listed separately).
      const lastTx = [...p.transactions].sort((a, b) => String(b.date).localeCompare(String(a.date)))[0];
      if (lastTx && lastTx.ownedAfter != null) { const prev = latestOwned.get(insiderName); if (!prev || f.filedDate >= prev.filedDate) latestOwned.set(insiderName, { shares: lastTx.ownedAfter, filedDate: f.filedDate, date: lastTx.date }); }
    }
    rows.sort((a, b) => String(b.date).localeCompare(String(a.date)) || String(b.filedDate).localeCompare(String(a.filedDate)));
    const buys = rows.filter((r) => r.code === "P"), sells = rows.filter((r) => r.code === "S");
    const sum = (xs, k) => xs.reduce((a, r) => a + (Number(r[k]) || 0), 0);
    const byInsider = {};
    for (const r of drows) { const b = (byInsider[r.insider] ||= { insider: r.insider, role: r.role, buyShares: 0, buyUsd: 0, sellShares: 0, sellUsd: 0, other: 0, derivative: 0, filings: new Set(), plan10b5: false }); b.derivative++; b.filings.add(r.accession); }
    for (const r of rows) {
      const b = (byInsider[r.insider] ||= { insider: r.insider, role: r.role, buyShares: 0, buyUsd: 0, sellShares: 0, sellUsd: 0, other: 0, derivative: 0, filings: new Set(), plan10b5: false });
      if (r.code === "P") { b.buyShares += r.shares; b.buyUsd += r.valueUsd; } else if (r.code === "S") { b.sellShares += r.shares; b.sellUsd += r.valueUsd; } else b.other++;
      b.filings.add(r.accession); if (r.plan10b5) b.plan10b5 = true;
    }
    const insiders = Object.values(byInsider).map((b) => ({ ...b, filings: b.filings.size, netUsd: b.buyUsd - b.sellUsd })).sort((a, b) => Math.abs(b.netUsd) - Math.abs(a.netUsd));
    const distinctBuyers = new Set(buys.map((r) => r.insider)).size, distinctSellers = new Set(sells.map((r) => r.insider)).size;
    const awards = rows.filter((r) => r.code === "A").length, exercises = rows.filter((r) => r.code === "M").length, withheld = rows.filter((r) => r.code === "F").length;
    const name = good[0]?.p?.issuer || pf.name || ticker;
    const symbol = good[0]?.p?.symbol || ticker;

    // 4) SOURCES: each filing (numbered), then the EDGAR search.
    const numbered = [];
    const seenUrl = new Set();
    for (const { f, p } of good) { if (f.url && !seenUrl.has(f.url)) { seenUrl.add(f.url); numbered.push({ n: numbered.length + 1, title: `Form 4 filed ${f.filedDate} by ${(p.owners[0]?.name || "reporting person")} - SEC EDGAR`, url: f.url }); } }
    numbered.push({ n: numbered.length + 1, title: `SEC EDGAR full-text search, Form 4 against CIK ${pf.cik}, ${pf.startDate} to ${pf.endDate}`, url: `https://efts.sec.gov/LATEST/search-index?q=&forms=4&ciks=${pf.cik}` });
    const srcNumOf = new Map(numbered.map((s) => [s.url, s.n]));

    // 5) GROUNDING BLOCKS.
    const txLines = rows.slice(0, 80).map((r) => `${r.date} · ${r.insider} (${r.role}) · ${r.kind} [${r.code}] · ${r.shares.toLocaleString("en-US")} sh @ $${r.price || 0} = ${fmtUsd(r.valueUsd)} · owns after: ${r.ownedAfter == null ? "?" : r.ownedAfter.toLocaleString("en-US")}${r.plan10b5 ? " · 10b5-1 plan noted" : ""} · [${srcNumOf.get(r.url) || "?"}]`).join("\n");
    const insiderLines = insiders.slice(0, 25).map((b) => `${b.insider} (${b.role}): bought ${b.buyShares.toLocaleString("en-US")} sh / ${fmtUsd(b.buyUsd)}; sold ${b.sellShares.toLocaleString("en-US")} sh / ${fmtUsd(b.sellUsd)}; other events ${b.other}; derivative events ${b.derivative}; net ${fmtUsd(b.netUsd)}; filings ${b.filings}${b.plan10b5 ? "; 10b5-1 plan referenced" : ""}${latestOwned.has(b.insider) ? `; direct holding after latest transaction ${latestOwned.get(b.insider).shares.toLocaleString("en-US")} sh (as of ${latestOwned.get(b.insider).date})` : ""}`).join("\n");
    const dLines = drows.sort((a, b) => String(b.date).localeCompare(String(a.date))).slice(0, 40).map((r) => `${r.date} · ${r.insider} (${r.role}) · ${r.kind} [${r.code}] · ${r.security}${r.underlying ? ` on ${r.underlyingShares.toLocaleString("en-US")} ${r.underlying}` : ""} · ${r.shares.toLocaleString("en-US")} units${r.exercisePrice ? ` @ exercise $${r.exercisePrice}` : ""}${r.expires ? ` · expires ${r.expires}` : ""} · owns after: ${r.ownedAfter == null ? "?" : r.ownedAfter.toLocaleString("en-US")} · [${srcNumOf.get(r.url) || "?"}]`).join("\n");
    const hLines = holdRows.slice(0, 40).map((h) => `${h.insider} (${h.role}) · ${h.shares.toLocaleString("en-US")} sh ${h.security}${h.ownership === "I" ? ` held indirectly${h.nature ? ` (${h.nature})` : ""}` : " held directly"} · reported ${h.filedDate} · [${srcNumOf.get(h.url) || "?"}]`).join("\n");
    const readOldest = good.map((x) => x.f.filedDate).filter(Boolean).sort()[0] || pf.startDate;
    const totals = `filings read: ${good.length} of ${pf.filings.length} fetched (${pf.total} in the window${pf.total > pf.filings.length ? ` - the NEWEST ${pf.filings.length} were fetched, so filings from ${pf.startDate} to ${readOldest} are NOT covered; say so` : ""}); transactions: ${rows.length}; derivative transactions: ${drows.length}; reported holdings rows: ${holdRows.length}; open-market BUYS: ${buys.length} (${sum(buys, "shares").toLocaleString("en-US")} sh, ${fmtUsd(sum(buys, "valueUsd"))}, ${distinctBuyers} distinct insiders); open-market SELLS: ${sells.length} (${sum(sells, "shares").toLocaleString("en-US")} sh, ${fmtUsd(sum(sells, "valueUsd"))}, ${distinctSellers} distinct insiders); awards: ${awards}; option exercises: ${exercises}; tax-withholding dispositions: ${withheld}; net open-market flow: ${fmtUsd(sum(buys, "valueUsd") - sum(sells, "valueUsd"))}`;

    const synthPrompt = `You are an equity analyst writing an INSIDER FLOW REPORT on ${name} (${symbol}, CIK ${pf.cik}) covering Form 4 filings from ${pf.startDate} to ${pf.endDate}. It will be SOLD to a paying customer; a fabricated trade, name, price or interpretation fails the whole report.

=== ABSOLUTE GROUNDING RULES ===
1. Use ONLY the TRANSACTIONS, PER-INSIDER TOTALS and TOTALS below (parsed from the filings). NEVER introduce a trade, a person, a price, a share count, a date or a market fact from memory.
2. Distinguish clearly between OPEN-MARKET purchases [P] and sales [S] (the informative signal) and the mechanical events - awards [A], option exercises [M], tax withholding [F], gifts [G], and every DERIVATIVE TRANSACTION (RSU/option grants and exercises) - which are NOT buying or selling conviction. An insider who appears only in the derivative table received or exercised equity awards; say that, never that they bought or sold. Say when a sale is under a 10b5-1 plan (pre-scheduled) where the material notes it, and that plans may exist even where no footnote says so.
3. CITATIONS: each transaction line ends with [n], the filing it came from. Cite that [n] when you describe the transaction. The EDGAR search is [${numbered.length}]. A citation is ONLY a bracketed number. Do NOT write a "Sources" section - it is appended.
4. Interpretation must be proportionate: insider selling is common and often liquidity or tax driven; clustered open-market BUYING by several insiders is the stronger signal. State the limits: Form 4 covers officers, directors and 10% holders; it is filed within two business days; it says nothing about intent. This is not investment advice.
5. Prioritize COMPLETING the report over length. If the material is thin (few trades, only awards), say so plainly and keep it short.

Write a well-structured report of up to ${t.words} words with these sections where the material supports them: SNAPSHOT (the window, how many filings/transactions, the net open-market flow), OPEN-MARKET BUYS (who, when, how much, at what price; cluster or lone), OPEN-MARKET SALES (same; note 10b5-1 where given), AWARDS, EXERCISES AND WITHHOLDING (briefly, as context), WHO IS TRADING (by role: executives vs directors vs 10% holders), and SIGNAL READ (a cautious, grounded interpretation plus the caveats in rule 4).

=== TOTALS ===\n${totals}
=== PER-INSIDER TOTALS ===\n${insiderLines || "(none)"}
=== TRANSACTIONS (newest first, max 80 shown) ===\n${txLines || "(no non-derivative transactions parsed - filings may be derivative-only or amendments)"}
=== DERIVATIVE TRANSACTIONS (RSU/option awards, exercises, conversions; newest first, max 40) ===\n${dLines || "(none)"}
=== REPORTED HOLDINGS (positions listed without a transaction; direct and indirect) ===\n${hLines || "(none)"}
NOTE: a gap in this material is never a finding about the company or an insider - if a filing was not fetched or a table is empty, say the material does not cover it.`;

    let spent = 0;
    const { sd, calls: synthCalls, cutShort } = await completeSynthesis((note) => chat({ model: SYNTH, messages: [{ role: "user", content: synthPrompt + note }], max_tokens: t.synthMaxTokens, reasoning: { enabled: false } }, SYNTH_TIMEOUT_MS, user), t.words);
    spent += synthCalls.reduce((a, c) => a + costOf(c), 0);
    const prose = proseOf(sd, cutShort);
    if (!prose) throw bad("Insider report synthesis produced nothing - not charged", 502);
    const header = `# Insider Flow Report: ${name} (${symbol})\n\n**${pf.total > pf.filings.length ? `${readOldest} to ${pf.endDate} (the newest ${good.length} of ${pf.total} filings in the ${days}-day window)` : `${pf.startDate} to ${pf.endDate}`}** · ${good.length} Form 4 filing${good.length === 1 ? "" : "s"} read · ${buys.length} open-market buy${buys.length === 1 ? "" : "s"} (${fmtUsd(sum(buys, "valueUsd"))}) · ${sells.length} open-market sale${sells.length === 1 ? "" : "s"} (${fmtUsd(sum(sells, "valueUsd"))})\n`;
    const sourceList = numbered.map((s) => `[${s.n}] ${s.title} - ${s.url}`).join("\n");
    const report = `${header}\n${prose}\n\n## Sources\n${sourceList}`;

    const tables = [
      { name: "transactions", label: "Form 4 transactions", columns: ["Date", "Filed", "Insider", "Role", "Security", "Code", "Kind", "Shares", "Price", "Value (USD)", "Owned after", "10b5-1", "Filing"],
        rows: rows.map((r) => [r.date, r.filedDate, r.insider, r.role, r.security, r.code, r.kind, String(r.shares), String(r.price), String(Math.round(r.valueUsd)), r.ownedAfter == null ? "" : String(r.ownedAfter), r.plan10b5 ? "noted" : "", r.url]) },
      { name: "insiders", label: "Per-insider totals", columns: ["Insider", "Role", "Bought (sh)", "Bought (USD)", "Sold (sh)", "Sold (USD)", "Other events", "Derivative events", "Net (USD)", "Filings", "Direct holding after latest tx"],
        rows: insiders.map((b) => [b.insider, b.role, String(b.buyShares), String(Math.round(b.buyUsd)), String(b.sellShares), String(Math.round(b.sellUsd)), String(b.other), String(b.derivative), String(Math.round(b.netUsd)), String(b.filings), latestOwned.has(b.insider) ? String(latestOwned.get(b.insider).shares) : ""]) },
      { name: "derivatives", label: "Derivative transactions", columns: ["Date", "Filed", "Insider", "Role", "Security", "Underlying", "Underlying shares", "Code", "Kind", "Units", "Exercise price", "Expires", "Owned after", "Filing"],
        rows: drows.map((r) => [r.date, r.filedDate, r.insider, r.role, r.security, r.underlying, String(r.underlyingShares), r.code, r.kind, String(r.shares), String(r.exercisePrice), r.expires, r.ownedAfter == null ? "" : String(r.ownedAfter), r.url]) },
      { name: "holdings", label: "Reported holdings (no transaction)", columns: ["Insider", "Role", "Security", "Shares", "Ownership", "Nature", "Reported", "Filing"],
        rows: holdRows.map((h) => [h.insider, h.role, h.security, String(h.shares), h.ownership, h.nature, h.filedDate, h.url]) },
    ];
    const meta = { tier: tierSlug, company: name, ticker: symbol, cik: pf.cik, window_days: days, start: pf.startDate, end: pf.endDate, filings_in_window: pf.total, filings_fetched: pf.filings.length, filings_read: good.length, coverage_from: readOldest, transactions: rows.length, derivative_transactions: drows.length, holdings_rows: holdRows.length,
      open_market_buys: buys.length, buy_usd: Math.round(sum(buys, "valueUsd")), distinct_buyers: distinctBuyers, open_market_sells: sells.length, sell_usd: Math.round(sum(sells, "valueUsd")), distinct_sellers: distinctSellers,
      net_open_market_usd: Math.round(sum(buys, "valueUsd") - sum(sells, "valueUsd")), awards, option_exercises: exercises, tax_withholding: withheld, sources_cited: numbered.length, synthesis_model: SYNTH,
      disclaimer: "Form 4 data as filed with the SEC; not investment advice." };
    const out = { report, company: name, ticker: symbol, cik: pf.cik, sources: numbered, tables, meta };
    // A composite that CALLS this one in-process passes `accountAs`, so the sale is
    // booked once against the product the buyer actually paid for; the caller folds
    // this leg's spend into its own. Direct callers are unaffected.
    if (input?.accountAs) input.accountAs(spent);
    else recordCompositeUsage({ slug: tierSlug, upstreamUsd: spent, ok: true, priceUsd: priceUsdOf(INSIDER_TIERS[tierSlug]) });
    return out;
  };
}

export function makeInsiderHandler(tierSlug) {
  const run = makeInsiderHandlerInner(tierSlug);
  return async (input, req) => {
    try { return await run(input, req); }
    catch (e) { try { recordCompositeUsage({ slug: tierSlug, upstreamUsd: 0, ok: false, priceUsd: priceUsdOf(INSIDER_TIERS[tierSlug]) }); } catch { /* never mask */ } throw e; }
  };
}

const SCHEMA = {
  type: "object",
  properties: {
    ticker: { type: "string", description: "US stock ticker, e.g. AAPL (or pass cik)." },
    cik: { type: "string", description: "SEC CIK of the company (alternative to ticker)." },
    days: { type: "number", description: "Lookback window in days, 7-365 (default 90)." },
  },
};
const OUT_EXAMPLE = {
  report: "# Insider Flow Report: Example Corp (EXMP)\n\n**2026-05-24 to 2026-08-22** · 6 Form 4 filings read · 1 open-market buy ($240,000) · 3 open-market sales ($1,850,000)\n\n## Snapshot\n...\n\n## Sources\n[1] Form 4 filed 2026-08-18 by Example Officer - SEC EDGAR - https://www.sec.gov/Archives/edgar/data/0000000000/000000000000000000/form4.xml",
  company: "Example Corp", ticker: "EXMP", cik: "0000000000",
  sources: [{ n: 1, title: "Form 4 filed 2026-08-18 by Example Officer - SEC EDGAR", url: "https://www.sec.gov/Archives/edgar/data/0000000000/000000000000000000/form4.xml" }],
  tables: [{ name: "transactions", label: "Form 4 transactions", columns: ["Date", "Filed", "Insider", "Role", "Security", "Code", "Kind", "Shares", "Price", "Value (USD)", "Owned after", "10b5-1", "Filing"], rows: [["2026-08-16", "2026-08-18", "Example Officer", "Chief Financial Officer", "Common Stock", "S", "open-market sale", "5000", "120.5", "602500", "41000", "noted", "https://www.sec.gov/Archives/edgar/data/0000000000/000000000000000000/form4.xml"]] }],
  meta: { tier: "insider-report", company: "Example Corp", ticker: "EXMP", window_days: 90, filings_read: 6, transactions: 9, open_market_buys: 1, buy_usd: 240000, open_market_sells: 3, sell_usd: 1850000, net_open_market_usd: -1610000, sources_cited: 7, synthesis_model: "anthropic/claude-opus-5" },
};

export const INSIDER_TOOLS = [
  {
    route: "POST /v1/insider-report", name: "Insider flow report (Form 4 transactions)", slug: "insider-report", category: "llm", price: INSIDER_TIERS["insider-report"].price,
    description: "Name a US ticker and get one cited insider-flow report: every Form 4 against the company in the window with the actual transactions parsed from the filings - open-market buys and sales (who, when, how much, at what price) separated from awards, option exercises and tax withholding - aggregated per insider and as a net flow, with a grounded signal read and a downloadable transactions appendix. SEC EDGAR data, not investment advice. USDC (x402/MPP) or card (Stripe). Not cached.",
    tags: ["insider", "form-4", "sec", "edgar", "trades", "officers", "directors", "report", "equity", "agentic-finance", "x402", "mpp"],
    discovery: { bodyType: "json", input: { ticker: "AAPL", days: 90 }, inputSchema: SCHEMA, output: { example: OUT_EXAMPLE } },
    handler: makeInsiderHandler("insider-report"),
  },
];
