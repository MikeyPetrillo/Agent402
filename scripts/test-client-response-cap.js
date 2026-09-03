// The response-size ceiling in agent402-client.
//
// WHY THIS ONE LIVES IN THE SDK AND ALMOST NOTHING ELSE DOES. Nearly everything
// a buyer might want to check about a response, they can check themselves once
// they hold it, in three lines of their own code. Not this: by the time
// `r.json()` resolves, a hostile or broken seller's multi-gigabyte body is
// already in the agent's memory. The SDK owns the fetch, so it is the only
// place the check can happen in time.
//
// It matters here more than in an ordinary HTTP client because this SDK calls
// STRANGERS and pays them, and the seller chooses the response.
import { Agent402, ResponseTooLargeError } from "../client/index.js";

let pass = 0, fail = 0;
const ok = (c, m) => { c ? pass++ : fail++; console.log(`${c ? "ok" : "FAIL"} - ${m}`); };

const PRICING = { endpoints: [{ slug: "hash", method: "POST", path: "/api/hash", computePayable: true, price: "$0.001" }] };

// A fetch stub whose body is a REAL stream, so the streaming path is exercised
// rather than the text fallback.
function stubFetch({ bytes, declare, chunks = 4 }) {
  return async (url) => {
    if (String(url).includes("/api/pricing")) {
      return new Response(JSON.stringify(PRICING), { status: 200, headers: { "content-type": "application/json" } });
    }
    const payload = JSON.stringify({ pad: "x".repeat(Math.max(0, bytes - 12)) });
    const buf = Buffer.from(payload, "utf8");
    let sent = 0;
    const size = Math.ceil(buf.length / chunks);
    const stream = new ReadableStream({
      pull(c) {
        if (sent >= buf.length) return c.close();
        c.enqueue(new Uint8Array(buf.subarray(sent, sent + size)));
        sent += size;
      },
    });
    const headers = { "content-type": "application/json" };
    if (declare != null) headers["content-length"] = String(declare);
    return new Response(stream, { status: 200, headers });
  };
}

// --- a normal response is unaffected ---------------------------------------
{
  const c = new Agent402({ fetchImpl: stubFetch({ bytes: 500 }) });
  const r = await c.call("hash", {});
  ok(typeof r === "object" && typeof r.pad === "string", "an ordinary response still comes back parsed");
}

// --- the stream is CUT, not measured after the fact -------------------------
{
  const c = new Agent402({ fetchImpl: stubFetch({ bytes: 200_000 }), maxResponseBytes: 1000 });
  let err = null;
  try { await c.call("hash", {}); } catch (e) { err = e; }
  ok(err instanceof ResponseTooLargeError, "an oversized body is refused");
  ok(err && err.source === "stream", `and refused from the STREAM, so the rest was never pulled (got ${err && err.source})`);
  ok(err && err.cap === 1000 && err.size > 1000, "the error carries what arrived and what the ceiling was");
}

// --- a declared content-length is refused before a byte is read -------------
{
  const c = new Agent402({ fetchImpl: stubFetch({ bytes: 500, declare: 99_000_000 }), maxResponseBytes: 1000 });
  let err = null;
  try { await c.call("hash", {}); } catch (e) { err = e; }
  ok(err instanceof ResponseTooLargeError && err.source === "content-length",
    "a body that DECLARES itself oversized is refused before reading");
}

// --- a lying content-length does not get through ----------------------------
{
  // Declares 10 bytes, sends 200k. content-length is the seller's claim about
  // their own body; the stream count is what actually protects the agent.
  const c = new Agent402({ fetchImpl: stubFetch({ bytes: 200_000, declare: 10 }), maxResponseBytes: 1000 });
  let err = null;
  try { await c.call("hash", {}); } catch (e) { err = e; }
  ok(err instanceof ResponseTooLargeError && err.source === "stream",
    "a LYING content-length is caught by the stream count, which is why both gates exist");
}

// --- the default is on ------------------------------------------------------
{
  const c = new Agent402({ fetchImpl: stubFetch({ bytes: 100 }) });
  ok(c.maxResponseBytes === 32 * 1024 * 1024,
    `the ceiling is ON by default (got ${c.maxResponseBytes}) - one that is off protects nobody`);
  const off = new Agent402({ fetchImpl: stubFetch({ bytes: 100 }), maxResponseBytes: null });
  ok(off.maxResponseBytes === null, "and null disables it for a caller who genuinely wants unlimited");
}

// --- per-call override ------------------------------------------------------
{
  const c = new Agent402({ fetchImpl: stubFetch({ bytes: 50_000 }), maxResponseBytes: null });
  let err = null;
  try { await c.call("hash", {}, { maxResponseBytes: 1000 }); } catch (e) { err = e; }
  ok(err instanceof ResponseTooLargeError, "a per-call ceiling overrides a disabled default");

  const c2 = new Agent402({ fetchImpl: stubFetch({ bytes: 50_000 }), maxResponseBytes: 1000 });
  const r2 = await c2.call("hash", {}, { maxResponseBytes: null });
  ok(typeof r2 === "object", "...and a per-call null overrides a set default");
}

// --- PAID vs NOT is on the error -------------------------------------------
{
  // The free/PoW path: nothing was charged.
  const c = new Agent402({ fetchImpl: stubFetch({ bytes: 200_000 }), maxResponseBytes: 1000 });
  let err = null;
  try { await c.call("hash", {}); } catch (e) { err = e; }
  ok(err && err.paid === false && !/WAS paid/.test(err.message),
    "a free call that oversizes says so - nothing was charged");
  // On a wallet-only tool the money has already moved by the time the body
  // arrives. Losing that distinction turns a refused response into a silently
  // forgotten spend.
  const walletPricing = { endpoints: [{ slug: "paid", method: "POST", path: "/api/paid", computePayable: false, price: "$0.01" }] };
  const payFetch = async (url) => {
    const payload = JSON.stringify({ pad: "x".repeat(200_000) });
    return new Response(payload, { status: 200, headers: { "content-type": "application/json" } });
  };
  const c2 = new Agent402({
    fetchImpl: async (url) => (String(url).includes("/api/pricing")
      ? new Response(JSON.stringify(walletPricing), { status: 200, headers: { "content-type": "application/json" } })
      : new Response("{}", { status: 200 })),
    fetch: payFetch,
    maxResponseBytes: 1000,
  });
  let perr = null;
  try { await c2.call("paid", {}); } catch (e) { perr = e; }
  ok(perr instanceof ResponseTooLargeError && perr.paid === true,
    "a PAID call that oversizes records that it was paid");
  ok(perr && /WAS paid/.test(perr.message),
    "...and says so in the message, so a refused response is never a silently forgotten spend");
  ok(c2.spendingSummary().dailyUsd === 0.01 && c2.spendingSummary().calls === 1,
    "...and the settled payment remains in spend accounting despite failed delivery");
}

// --- nothing is cached when the body is refused -----------------------------
{
  const c = new Agent402({ fetchImpl: stubFetch({ bytes: 200_000 }), maxResponseBytes: 1000 });
  try { await c.call("hash", {}); } catch { /* expected */ }
  let second = null;
  try { await c.call("hash", {}); } catch (e) { second = e; }
  ok(second instanceof ResponseTooLargeError,
    "a refused response is not cached, so the next call is refused again rather than served a partial");
}

console.log(`\n${fail ? "FAILED" : "OK"}: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
