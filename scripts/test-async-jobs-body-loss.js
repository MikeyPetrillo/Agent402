// A settled 200 on the async-job loopback whose body is then lost (the read
// fails or times out after the headers arrived) is booked as owed through
// onChargedFailure, on the receipt's proof of charge, and the job's message
// says so; without that proof nothing is booked and the message does not
// claim a debt. A loopback that fails before any answer books nothing here
// (the hang-up hook owns that case). Offline: a stub fetch and a stub store.
import { createAsyncJobs, LOOPBACK_HEADER } from "../src/async-jobs.js";
import { DOSSIER_TOOLS } from "../src/tools/dossier-kit.js";
import { readFileSync } from "node:fs";

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log(`ok - ${m}`); } else { fail++; console.error(`FAIL - ${m}`); } };
const b64 = (o) => Buffer.from(JSON.stringify(o)).toString("base64");
const PROOF = { success: true, transaction: `0x${"ab".repeat(32)}`, network: "eip155:8453", payer: `0x${"12".repeat(20)}` };
// A real catalog def: it lists `price` ("$x") and carries no priceUsd field,
// which is what the booked debt has to be derived from.
const DEF = DOSSIER_TOOLS.find((d) => d.slug === "dossier");
const LIST_USD = Number(String(DEF.price).replace(/[^0-9.]/g, ""));
if (!(LIST_USD > 0) || "priceUsd" in DEF) { console.error("FAIL - the catalog def under test must list a price and no priceUsd"); process.exit(1); }

function stubStore() {
  const s = { RUN_TIMEOUT_MS: 5000, POLL_MS: 1000, completed: [], failed: [], atCapacity: () => false };
  s.create = async ({ slug }) => ({ taskId: "a".repeat(48), status: "working", slug, createdAt: new Date().toISOString() });
  s.complete = async (id, result, opts) => { s.completed.push({ id, result, opts }); };
  s.fail = async (id, error, message) => { s.failed.push({ id, error, message }); };
  return s;
}
// A response whose headers arrive and whose body stream then errors.
function brokenBody(status, headers) {
  const body = new ReadableStream({ start(c) { c.enqueue(new TextEncoder().encode('{"partial":')); c.error(new Error("socket hang up")); } });
  return new Response(body, { status, headers: { "content-type": "application/json", ...headers } });
}
async function run(fetchImpl, wiring = {}) {
  const store = stubStore();
  const booked = [];
  const jobs = createAsyncJobs({
    port: 1, store, fetchImpl, log: () => {},
    asyncRouteOf: () => DEF,
    onChargedFailure: async (info) => { booked.push(info); return true; },
    ...wiring,
  });
  const req = { method: "POST", headers: { prefer: "respond-async", "payment-signature": "x" }, body: {}, ip: "1.2.3.4", originalUrl: "/api/slow" };
  const res = { statusCode: 0, status(c) { this.statusCode = c; return this; }, set() { return this; }, json(b) { this.body = b; return this; } };
  await jobs.middleware(req, res, () => {});
  for (let i = 0; i < 100 && !store.failed.length && !store.completed.length; i++) await new Promise((r) => setTimeout(r, 10));
  return { res, store, booked };
}

{
  const { res, store, booked } = await run(async () => brokenBody(200, { "payment-response": b64(PROOF) }));
  ok(res.statusCode === 202, "the job is accepted (202)");
  ok(booked.length === 1 && booked[0].receipt?.transaction === PROOF.transaction && booked[0].slug === "dossier" && booked[0].priceUsd === LIST_USD,
    `a settled 200 whose body is lost is booked as owed with its receipt, at the def's listed price (${JSON.stringify(booked)})`);
  ok(store.failed.length === 1 && /recorded as owed/.test(store.failed[0].message) && !/otherwise nothing was charged/.test(store.failed[0].message),
    `...and the job says the charge is recorded as owed (${store.failed[0]?.message})`);
}
{
  const { store, booked } = await run(async () => brokenBody(200, {}));
  ok(booked.length === 0 && store.failed.length === 1 && !/recorded as owed/.test(store.failed[0].message),
    `a 200 without a proving receipt books nothing and does not claim a debt (${store.failed[0]?.message})`);
}
{
  const { store, booked } = await run(async () => brokenBody(200, { "payment-response": b64({ ...PROOF, success: false }) }));
  ok(booked.length === 0 && !/recorded as owed/.test(store.failed[0]?.message || ""), "a receipt with success false books nothing");
}
{
  const { store, booked } = await run(async () => { throw Object.assign(new Error("timed out"), { name: "TimeoutError" }); });
  ok(booked.length === 0 && store.failed.length === 1, "a loopback with no answer books nothing here (the hang-up hook owns it)");
}
{
  const { store, booked } = await run(async () => new Response(JSON.stringify({ ok: true }), { status: 200, headers: { "content-type": "application/json", "payment-response": b64(PROOF) } }));
  ok(booked.length === 0 && store.completed.length === 1 && store.failed.length === 0, "control: a 200 read in full completes the job and books nothing");
  ok(store.completed[0].opts?.priceUsd === LIST_USD, `a completed job hands the store the same paid price (${store.completed[0].opts?.priceUsd})`);
}
{
  // The server's wiring: the quote read at job creation, then the chain's
  // premium once the receipt names the network (src/paid-price.js).
  process.env.NETWORK_PRICE_PREMIUMS = "eip155:10=0.001";
  const { paidPriceUsd } = await import("../src/paid-price.js");
  const wiring = {
    quoteOf: (def, req) => (req.__quoteUsd = LIST_USD * 2),
    paidOf: ({ basePriceUsd, receipt, meteredUsd }) => paidPriceUsd({ basePriceUsd, caip2: receipt?.network ?? null, meteredUsd }),
  };
  const { booked } = await run(async () => brokenBody(200, { "payment-response": b64({ ...PROOF, network: "eip155:10" }) }), wiring);
  ok(booked.length === 1 && Math.abs(booked[0].priceUsd - (LIST_USD * 2 + 0.001)) < 1e-9,
    `the debt books the request's quote raised by the receipt chain's premium (${booked[0]?.priceUsd})`);
  const metered = await run(async () => brokenBody(200, { "payment-response": b64(PROOF), "x-metered-usd": "0.0123" }), wiring);
  ok(metered.booked.length === 1 && metered.booked[0].priceUsd === 0.0123, `a metered settle books the meter's amount (${metered.booked[0]?.priceUsd})`);
}
ok(typeof LOOPBACK_HEADER === "string", "module loads");
const src = readFileSync(new URL("../src/server.js", import.meta.url), "utf8");
ok(/createAsyncJobs\(\{[\s\S]{0,120}onChargedFailure: bookAsyncChargedFailure/.test(src) && /createTaskStore\(\{[\s\S]{0,120}onChargedFailure: bookAsyncChargedFailure/.test(src),
  "server.js books both async-job charged failures through the same refund-ledger hook");
ok(/createAsyncJobs\(\{[\s\S]{0,600}quoteOf: quotedPriceUsd,\s*paidOf: \(\{ basePriceUsd, receipt, meteredUsd, req \}\) => paidPriceUsd\(\{ basePriceUsd, caip2: receipt\?\.network/.test(src),
  "server.js prices a job at the request's quote and books it on the receipt's chain");

console.log(`\ntest-async-jobs-body-loss: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
