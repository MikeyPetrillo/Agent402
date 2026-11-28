#!/usr/bin/env node
// The ticker pack under a busy EDGAR pace, on a run armed to settle first.
//
//   node scripts/test-ticker-pack-pace.js      (offline: SEC and model stand-ins)
//
// The pack runs its two report legs in parallel, and each leg reads EDGAR
// through the one pace (src/tools/sec-rate.js) before its first model call,
// which is the run's settle point (src/settle-first.js). A leg whose reads
// were answered the pace's 503 before the OTHER leg reached the settle point
// failed a pack whose payment was then settled: a charge with no answer,
// caused by our own pace.
//
// This suite drives the REAL pack handler with its REAL dossier and insider
// legs (only the pack's cheap probes are fixtures), the real EDGAR handlers
// and the process's own pace, over stand-ins for the SEC's hosts and the
// model. It proves:
//   - an armed run whose dossier leg meets a full pace is held, not refused:
//     the pack is served, the payment settles once, and no read was refused;
//   - starts to the SEC's hosts stay at eight to a rolling second throughout;
//   - CONTROL: a run that is not armed (every run served before it is
//     charged) is answered exactly as before: the same pack fails, uncharged,
//     with the pace's refusals counted;
//   - the server names the armed request from the request's own scope.
import "./lib/offline-stores.js"; // per-process and file backends whatever the caller exports (see the file)
import "./lib/guard-dns-offline.js"; // the guard's name lookups answer here, not from the machine's resolver (see the file)
import { AsyncLocalStorage } from "node:async_hooks";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

process.env.OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY || "test-key-not-real";
const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const { makeTickerPackHandler } = await import("../src/tools/ticker-pack-kit.js");
const { secPaced, secPaceStatus, isSecHost, SEC_STARTS_PER_SECOND_TOTAL, SEC_READ_RESERVE_MS, SEC_WINDOW_MS, _resetSecPaceForTests } = await import("../src/tools/sec-rate.js");
const sf = await import("../src/settle-first.js");

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log(`ok - ${m}`); } else { fail++; console.log(`FAIL - ${m}`); } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const mostPerWindow = (times, windowMs = 1000) => {
  const t = [...times].sort((a, b) => a - b);
  let most = 0;
  for (let i = 0, j = 0; i < t.length; i++) { while (t[i] - t[j] >= windowMs) j++; most = Math.max(most, i - j + 1); }
  return most;
};

// ---- stand-ins: the SEC's hosts and the model ----
const CIK = "0000320193";
const FORM4 = `<ownershipDocument><issuer><issuerCik>${CIK}</issuerCik><issuerName>Apple Inc.</issuerName><issuerTradingSymbol>AAPL</issuerTradingSymbol></issuer><periodOfReport>2026-08-10</periodOfReport><reportingOwner><reportingOwnerId><rptOwnerCik>77</rptOwnerCik><rptOwnerName>Pat Example</rptOwnerName></reportingOwnerId><reportingOwnerRelationship><isDirector>1</isDirector><isOfficer>0</isOfficer></reportingOwnerRelationship></reportingOwner><nonDerivativeTable><nonDerivativeTransaction><securityTitle><value>Common Stock</value></securityTitle><transactionDate><value>2026-08-10</value></transactionDate><transactionCoding><transactionCode>S</transactionCode></transactionCoding><transactionAmounts><transactionShares><value>1500</value></transactionShares><transactionPricePerShare><value>42.1</value></transactionPricePerShare><transactionAcquiredDisposedCode><value>D</value></transactionAcquiredDisposedCode></transactionAmounts><postTransactionAmounts><sharesOwnedFollowingTransaction><value>20000</value></sharesOwnedFollowingTransaction></postTransactionAmounts><ownershipNature><directOrIndirectOwnership><value>D</value></directOrIndirectOwnership></ownershipNature></nonDerivativeTransaction></nonDerivativeTable></ownershipDocument>`;
const submissions = { cik: CIK, name: "Apple Inc.", filings: { recent: { form: ["10-K", "10-Q", "8-K"], filingDate: ["2026-01-02", "2026-05-02", "2026-02-03"], reportDate: ["2025-12-31", "2026-03-31", ""], accessionNumber: ["0000320193-26-000001", "0000320193-26-000003", "0000320193-26-000002"], primaryDocument: ["a.htm", "q.htm", "b.htm"], primaryDocDescription: ["10-K", "10-Q", "8-K"], isXBRL: [1, 1, 0] }, files: [] } };
const efts = { hits: { total: { value: 2 }, hits: [1, 2].map((i) => ({ _id: `0000000077-26-00000${i}:form4.xml`, _source: { ciks: ["0000000077", CIK], file_date: `2026-08-1${i}`, display_names: ["Pat Example (CIK 0000000077)"], form: "4", root_forms: ["4"] } })) } };
const secStarts = []; // when the stand-in got each request
let modelCalls = 0;
const realFetch = globalThis.fetch;
const json = (o) => new Response(JSON.stringify(o), { status: 200, headers: { "content-type": "application/json" } });
const reply = (content, extra = {}) => ({ choices: [{ message: { content, ...extra }, finish_reason: "stop" }], usage: { cost: 0 } });
globalThis.fetch = async (input, init = {}) => {
  const u = new URL(typeof input === "string" ? input : input.url ?? String(input));
  if (/openrouter\.ai$/.test(u.hostname)) {
    modelCalls++;
    const body = JSON.parse(init.body || "{}");
    return json(body.plugins
      ? reply("Apple shipped a product.", { annotations: [{ type: "url_citation", url_citation: { url: "https://web.example/a", title: "Apple news", content: "Apple shipped a product." } }] })
      : reply("## Snapshot\nThe material is summarized here [1].\n===NEXT===\n- Read the newest filing."));
  }
  if (!isSecHost(u)) throw new Error(`unexpected egress in an offline suite: ${u.host}`);
  secStarts.push(performance.now());
  await sleep(10);
  if (init.signal?.aborted) throw init.signal.reason;
  if (u.pathname.endsWith("company_tickers.json")) return json({ 0: { cik_str: 320193, ticker: "AAPL", title: "Apple Inc." } });
  if (u.pathname.startsWith("/submissions/")) return json(submissions);
  if (u.hostname === "efts.sec.gov") return json(efts);
  if (u.pathname.endsWith("form4.xml")) return new Response(FORM4, { status: 200, headers: { "content-type": "text/xml" } });
  if (u.pathname.includes("/api/xbrl/")) return new Response("{}", { status: 404, headers: { "content-type": "application/json" } });
  return new Response("<html><body>Quarterly report text.</body></html>", { status: 200, headers: { "content-type": "text/html" } });
};

// ---- the request scope, read as the server reads it ----
const als = new AsyncLocalStorage();
sf.setSettleFirstAmbient(() => als.getStore()?.settleFirstRequest || null);
sf.setPaidBeforeRunAmbient(() => sf.scopePaidBeforeRun(als.getStore()));
{
  const server = readFileSync(join(ROOT, "src/server.js"), "utf8");
  ok(/setSettleFirstAmbient\(\(\) => currentRequestScope\(\)\?\.settleFirstRequest \|\| null\);/.test(server) && /if \(state\) \{ const scope = currentRequestScope\(\); if \(scope\) scope\.settleFirstRequest = req; \}/.test(server)
    && /if \(settleFirst\) \{ disarmSettleFirst\(req\);/.test(server),
  "the server names a run's armed request from the request's own scope, set only where it armed one, and disarms it when the handler ends");
}

// The pack's cheap probes are fixtures (they run before the legs and are not
// what is under test); the two legs are the kit's own.
const FILINGS = { cik: CIK, name: "Apple Inc.", filings: [{ form: "10-Q", filed: "2026-08-01", period: "2026-06-27", description: "Quarterly report", accession: "0000320193-26-000077", url: "https://www.sec.gov/Archives/edgar/data/320193/000032019326000077/aapl-20260627.htm" }], browseUrl: `https://www.sec.gov/cgi-bin/browse-edgar?action=getcompany&CIK=${CIK}` };
const HOLDERS = { query: '"Apple Inc."', startDate: "2026-03-25", endDate: "2026-08-22", matchingFilings: 1, matchingRelation: "eq", cusipPrefix: "037833", candidates: 1, scanned: 1, failedScans: 0,
  managers: [{ manager: "EXAMPLE ASSET MANAGEMENT LLC", cik: "0000000001", period: "2026-06-30", filed: "2026-08-14", url: "https://www.sec.gov/Archives/edgar/data/1/000000000126000001/infotable.xml", shares: 1000, valueUsd: 290000, impliedPriceUsd: 290, optionRows: 0, optionShares: 0, principalRows: 0, rows: 1, classes: ["COM"], totalPositions: 10, truncated: false }],
  failures: [], searchUrl: "https://efts.sec.gov/LATEST/search-index?q=%22Apple%20Inc.%22&forms=13F-HR" };
const handler = makeTickerPackHandler("ticker-pack", {
  resolveCompany: async () => ({ cik: CIK, name: "Apple Inc." }),
  probeCompanyFilings: async () => FILINGS,
  probeInsiderFilings: async () => ({ cik: CIK, name: "Apple Inc.", days: 90, total: 2, filings: [{ accessionNumber: "0000000077-26-000001", filedDate: "2026-08-11", url: "https://www.sec.gov/Archives/edgar/data/77/000000007726000001/form4.xml" }] }),
  probeHolders: async () => HOLDERS,
  probe13G: async () => ({ cik: CIK, filers: [] }),
});

// A leg's read is "late" at the pace when the window is full and its handler
// budget leaves less wait than the next place needs. The EDGAR handlers the
// dossier leg calls run under a budget (src/upstream-deadline.js); the
// insider leg's own reads run under none and wait their turn. So with the
// window just filled and a second window's worth of reads standing in the
// line, and a handler budget that leaves less wait than two windows, the
// dossier leg's first reads are the ones the pace answers, while the insider
// leg reads on and reaches the settle point.
const BUDGET_MS = SEC_READ_RESERVE_MS + Math.round(1.7 * SEC_WINDOW_MS); // the wait a read has, against a place two windows away
/** Other work fills the window and leaves one more window's reads standing. */
async function busyPace() {
  await Promise.all(Array.from({ length: SEC_STARTS_PER_SECOND_TOTAL }, () => secPaced(async () => { secStarts.push(performance.now()); })));
  return Promise.all(Array.from({ length: SEC_STARTS_PER_SECOND_TOTAL }, () => secPaced(async () => { secStarts.push(performance.now()); }).catch(() => {})));
}
async function runPack({ armed }) {
  _resetSecPaceForTests();
  secStarts.length = 0;
  modelCalls = 0;
  const req = {};
  let settles = 0;
  if (armed) sf.armSettleFirst(req, { reason: "test", run: async () => { settles++; await sleep(20); } });
  const scope = armed ? { settleFirstRequest: req } : {};
  const standing = busyPace();
  await sleep(30); // the window is full and the line is standing
  process.env.UPSTREAM_HANDLER_BUDGET_MS = String(BUDGET_MS);
  const t0 = performance.now();
  let out = null, err = null;
  try { out = await als.run(scope, () => handler({ ticker: "AAPL" }, req)); } catch (e) { err = e; } finally {
    delete process.env.UPSTREAM_HANDLER_BUDGET_MS;
    sf.disarmSettleFirst(req); // as the server does when the handler ends
  }
  await standing;
  return { out, err, settles, ms: performance.now() - t0, refused: secPaceStatus().refused, waiting: secPaceStatus().waiting, most: mostPerWindow(secStarts, SEC_WINDOW_MS - 60), secReads: secStarts.length, modelCalls };
}
const say = (r) => (r.err ? `${r.err.statusCode} ${String(r.err.message).slice(0, 140)}` : `served, dossier ${r.out?.evidence?.dossier?.ok}, insider ${r.out?.evidence?.insider?.ok}`);

try {
  // ---- an armed run: the pace holds the dossier leg's reads ----
  const a = await runPack({ armed: true });
  ok(!a.err && a.out?.evidence?.dossier?.ok === true && a.out?.evidence?.insider?.ok === true, `an armed run whose dossier leg meets a full pace before any settle point is served with both legs (${say(a)}; ${Math.round(a.ms)} ms)`);
  ok(a.settles === 1, `its payment is settled once, at the settle point (${a.settles})`);
  ok(!(a.err && a.settles > 0), `and never settled for a pack that then failed on the pace's own refusal (${a.err ? `failed ${a.err.statusCode}` : "served"}, settled ${a.settles})`);
  ok(a.refused === 0 && a.waiting === 0, `no read of the run was answered the pace's 503, and none is left waiting (refused ${a.refused}, waiting ${a.waiting})`);
  ok(a.most <= SEC_STARTS_PER_SECOND_TOTAL && a.secReads > SEC_STARTS_PER_SECOND_TOTAL, `starts to the SEC's hosts stay at ${SEC_STARTS_PER_SECOND_TOTAL} to a rolling window, the held reads counted (most ${a.most} of ${a.secReads} starts)`);

  // ---- CONTROL: a run that is not armed is answered exactly as before ----
  const c = await runPack({ armed: false });
  ok(c.err?.statusCode === 502 && /dossier leg failed/.test(c.err.message) && c.settles === 0 && c.refused > 0, `CONTROL: the same pack on a run served before it is charged still fails on the pace's refusals, with nothing settled (${say(c)}; refused ${c.refused}, settled ${c.settles})`);
  ok(c.most <= SEC_STARTS_PER_SECOND_TOTAL, `CONTROL: and its starts stay at ${SEC_STARTS_PER_SECOND_TOTAL} to a rolling window (most ${c.most})`);

  // ---- an armed run whose settlement fails is not served by the hold ----
  {
    _resetSecPaceForTests();
    const req = {};
    sf.armSettleFirst(req, { reason: "test", run: async () => { await sleep(20); throw sf.settleFirstRefusal({ status: 402, body: {} }); } });
    const standing = busyPace();
    await sleep(30);
    process.env.UPSTREAM_HANDLER_BUDGET_MS = String(BUDGET_MS);
    let err = null;
    try { await als.run({ settleFirstRequest: req }, () => handler({ ticker: "AAPL" }, req)); } catch (e) { err = e; } finally { delete process.env.UPSTREAM_HANDLER_BUDGET_MS; sf.disarmSettleFirst(req); }
    await standing;
    ok(err && err.statusCode >= 400 && sf.settleFirstSucceeded(req) === false && secPaceStatus().waiting === 0, `an armed run whose payment does not settle is not served, and leaves nothing waiting (${err?.statusCode}, waiting ${secPaceStatus().waiting})`);
  }
} finally {
  globalThis.fetch = realFetch;
  sf.setSettleFirstAmbient(null);
  sf.setPaidBeforeRunAmbient(null);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
