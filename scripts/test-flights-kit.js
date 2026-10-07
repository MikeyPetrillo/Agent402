#!/usr/bin/env node
// Flight search and flight status (src/tools/flights-kit.js), offline.
//
// The kit pays outside sellers from our wallet before the buyer's payment
// settles, so what is pinned is the money path first:
//  - the seller list is configuration, refused when malformed or when a
//    seller's cap leaves no margin under the route price;
//  - every payment carries the seller's cap and its pinned payTo;
//  - the next seller is tried only when the failed attempt never sent our
//    authorization; one that may have collected ends the call;
//  - the spend guard is consulted first, and the booked amount is what was
//    actually signed;
// then the shapes: inputs are validated before any spend, both answer formats
// normalize, and the answer names which seller served it.
import { parseFlightSellers, buildFlightTools, fillTemplate, validateSearch, validateStatus, normalizeFareSearch, normalizeFlightTrack } from "../src/tools/flights-kit.js";

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log(`ok - ${m}`); } else { fail++; console.log(`FAIL - ${m}`); } };
const throws = async (fn, re, m) => { try { await fn(); ok(false, `${m} (did not throw)`); } catch (e) { ok(re.test(String(e?.message)), `${m}${re.test(String(e?.message)) ? "" : ` (got ${e?.statusCode} ${e?.message})`}`); return e; } };

const NOW = Date.parse("2026-10-07T14:00:00Z");
const A = "0x" + "a1".repeat(20), B = "0x" + "b2".repeat(20), C = "0x" + "c3".repeat(20);
const config = JSON.stringify({
  search: [
    { url: "https://fares-one.example.invalid/search?dep={from}&arr={to}&d={date}&r={return}&cls={travelClassCode}&type={tripType}&adults={adults}", method: "GET", format: "fare-search-v1", maxUsd: 0.02, payTo: A },
    { url: "https://fares-two.example.invalid/flights?origin={from}&destination={to}&departureDate={date}", method: "GET", format: "fare-search-v1", maxUsd: 0.02, payTo: B },
  ],
  status: [{ url: "https://track.example.invalid/flights/{flight}?ident_type=designator", method: "GET", format: "flight-track-v1", maxUsd: 0.01, payTo: C }],
});

// ---- configuration
ok(parseFlightSellers(undefined) === null && parseFlightSellers("") === null, "unset config: the feature is off");
const sellers = parseFlightSellers(config);
ok(sellers.search.length === 2 && sellers.status.length === 1, "a valid config parses both lists");
for (const [bad, re, m] of [
  ["{not json", /not valid JSON/, "malformed JSON fails the boot"],
  [JSON.stringify({ search: [{ url: "http://x.example.invalid/{from}", format: "fare-search-v1", maxUsd: 0.02, payTo: A }] }), /https/, "an http seller is refused"],
  [JSON.stringify({ search: [{ url: "https://x.example.invalid/", format: "other", maxUsd: 0.02, payTo: A }] }), /format/, "an unknown answer format is refused"],
  [JSON.stringify({ search: [{ url: "https://x.example.invalid/", format: "fare-search-v1", maxUsd: 0.02, payTo: "0x12" }] }), /payTo/, "a seller without a pinned Base address is refused"],
  [JSON.stringify({ search: [{ url: "https://x.example.invalid/", format: "fare-search-v1", maxUsd: 0.025, payTo: A }] }), /no margin/, "a seller cap that leaves no margin under the route price is refused"],
]) await throws(() => parseFlightSellers(bad), re, m);
ok(buildFlightTools({ sellers: null }).length === 0, "no config: no routes registered");

// ---- templates and inputs
ok(fillTemplate("https://h.example.invalid/s?a={from}&r={return}", { from: "BER", return: null }) === "https://h.example.invalid/s?a=BER", "an unset optional placeholder drops its query parameter");
ok(fillTemplate("https://h.example.invalid/s?a={from}&q={from}-{return}", { from: "BER", return: null }) === "https://h.example.invalid/s?a=BER", "a query value carrying an unset placeholder anywhere is dropped whole, never sent as __unset__");
ok(!/function|Object/.test(fillTemplate("https://h.example.invalid/s?c={constructor}", { from: "BER" })), "a placeholder named like a prototype member reads as unset, not as the prototype");
await throws(() => fillTemplate("https://h.example.invalid/f/{flight}", {}), /required value is missing/, "an unset path placeholder refuses rather than calling a broken URL");
await throws(() => validateSearch({ from: "BER", to: "BCN", date: "2026-10-01" }, NOW), /in the past/, "a past date is refused");
await throws(() => validateSearch({ from: "BERLIN", to: "BCN", date: "2026-11-12" }, NOW), /IATA/, "a city name instead of an airport code is refused");
await throws(() => validateSearch({ from: "BER", to: "BER", date: "2026-11-12" }, NOW), /same airport/, "same origin and destination is refused");
await throws(() => validateSearch({ from: "BER", to: "BCN", date: "2026-11-12", return: "2026-11-10" }, NOW), /before/, "a return before the outbound is refused");
ok(validateSearch({ from: "ber", to: "bcn", date: "2026-11-12" }, NOW).from === "BER", "airport codes are uppercased");
ok(validateStatus({ flight: "lh 400" }, NOW).flight === "LH400", "a flight number with a space normalizes");
await throws(() => validateStatus({ flight: "Lufthansa" }, NOW), /flight number/, "a name instead of a flight number is refused");
await throws(() => validateStatus({ flight: "LH400", date: "2026-12-30" }, NOW), /14 days/, "a status date far out is refused");

// ---- answers
const leg = (from, to, t1, t2, fn) => ({ departure_airport: { id: from, time: t1 }, arrival_airport: { id: to, time: t2 }, duration: 155, airplane: "Boeing 737", airline: "Example Air", travel_class: "Economy", flight_number: fn });
const fares = { search_parameters: { currency: "USD" }, best_flights: [{ flights: [leg("BER", "BCN", "2026-11-12 21:20", "2026-11-12 23:55", "XA 1")], total_duration: 155, price: 53 }],
  other_flights: [{ flights: [leg("BER", "MUC", "2026-11-12 07:00", "2026-11-12 08:10", "XA 2"), leg("MUC", "BCN", "2026-11-12 09:00", "2026-11-12 11:00", "XA 3")], total_duration: 240, price: 85 }],
  price_insights: { lowest_price: 53, typical_price_range: [50, 90], price_level: "low" } };
const norm = normalizeFareSearch(fares, validateSearch({ from: "BER", to: "BCN", date: "2026-11-12" }, NOW));
ok(norm.offerCount === 2 && norm.offers[0].best && norm.offers[1].stops === 1 && norm.lowestPrice === 53, "fares normalize: best first, stops counted, lowest price kept");
const track = { flights: [
  { ident_iata: "LH400", status: "Arrived", origin: { code_iata: "FRA" }, destination: { code_iata: "JFK" }, scheduled_out: "2026-10-06T08:55:00Z", actual_out: "2026-10-06T09:05:00Z", actual_in: "2026-10-06T17:40:00Z", departure_delay: 600 },
  { ident_iata: "LH400", status: "Scheduled", origin: { code_iata: "FRA" }, destination: { code_iata: "JFK" }, scheduled_out: "2026-10-09T08:55:00Z" },
  { ident_iata: "LH400", status: "Scheduled", origin: { code_iata: "FRA" }, destination: { code_iata: "JFK" }, scheduled_out: "2026-10-08T08:55:00Z" },
] };
ok(normalizeFlightTrack(track, { flight: "LH400", date: null }, NOW).scheduledDeparture === "2026-10-08T08:55:00Z", "no date: the next flight to depart is chosen");
ok(normalizeFlightTrack(track, { flight: "LH400", date: "2026-10-06" }, NOW).departureDelayMin === 10, "a date picks that day's flight, delay in minutes");
{
  // After the seller is paid, "not found" must be a charged answer, never a 4xx:
  // a 4xx cancels the buyer's settlement (security review 2026-10-07).
  const nf = normalizeFlightTrack(track, { flight: "LH400", date: "2026-10-10" }, NOW);
  ok(nf.found === false && /no departure scheduled/.test(nf.reason) && nf.otherDays.length === 3, "a date with no flight is a found:false answer listing the days that do fly, not another day's flight");
  const none = normalizeFlightTrack({ flights: [] }, { flight: "LH400", date: null }, NOW);
  ok(none.found === false, "no tracked flight at all is also a found:false answer");
  ok(normalizeFlightTrack(track, { flight: "LH400", date: null }, NOW).found === true, "a matched flight says found:true");
}

// ---- the money path
function harness({ script, guard = { ok: true } } = {}) {
  const calls = [], booked = [];
  const pay = async (url, opts) => {
    calls.push({ url, opts });
    const step = script(url, calls.length);
    if (step instanceof Error) throw step;
    return step;
  };
  const tools = buildFlightTools({ sellers, pay, now: () => NOW,
    maySpend: () => guard, noteSpend: (payer, usd) => ({ payer, usd }), adjustSpend: (h, usd) => booked.push(usd) });
  return { calls, booked, search: tools.find((t) => t.slug === "flight-search"), status: tools.find((t) => t.slug === "flight-status") };
}
const req = { ip: "203.0.113.9", header: () => undefined };
const precommit = () => Object.assign(new Error("Seller unreachable: ECONNRESET"), { statusCode: 502 });
const committed = () => Object.assign(new Error("seller returned 500 after payment"), { statusCode: 502, committed: true, signedUsd: 0.02 });

{
  const h = harness({ script: () => ({ result: fares, quote: { usd: 0.02 }, receipt: { success: true } }) });
  const out = await h.search.handler({ from: "BER", to: "BCN", date: "2026-11-12" }, req);
  ok(out.offerCount === 2 && out.servedBy === "fares-one.example.invalid", "search is served by the first seller and names it");
  ok(h.calls[0].opts.provenPayTo === A && h.calls[0].opts.maxAtomic === 20000n && h.calls[0].opts.chain === "base", "the payment carries the seller's pinned payTo and its cap");
  ok(/dep=BER&arr=BCN&d=2026-11-12/.test(h.calls[0].url) && !/[?&]r=/.test(h.calls[0].url), "the URL is filled from the request; the unset return date is dropped");
  ok(h.booked.at(-1) === 0.02, "the booked spend is the signed amount");
  ok(out._untrusted !== undefined || out.untrustedContent !== undefined || Object.keys(out).some((k) => /untrusted/i.test(k)), "the answer is marked as third-party content");
}
{
  const h = harness({ script: (url, n) => (n === 1 ? precommit() : { result: fares, quote: { usd: 0.02 } }) });
  const out = await h.search.handler({ from: "BER", to: "BCN", date: "2026-11-12" }, req);
  ok(h.calls.length === 2 && out.servedBy === "fares-two.example.invalid", "a seller that failed before our payment went out falls through to the next");
  ok(h.calls[1].opts.provenPayTo === B, "...paid to the second seller's own pinned address");
}
{
  const h = harness({ script: () => committed() });
  await throws(() => h.search.handler({ from: "BER", to: "BCN", date: "2026-11-12" }, req), /did not deliver after our payment went out/, "a seller that may have collected ends the call");
  ok(h.calls.length === 1, "...and no second seller is paid");
  ok(h.booked.at(-1) === 0.02, "...and the possible spend is booked, not released");
}
{
  const h = harness({ script: () => Object.assign(new Error("Seller quote 30000 atomic exceeds the 20000 cap (payTo 0xabc)"), { statusCode: 502 }) });
  const e = await throws(() => h.search.handler({ from: "BER", to: "BCN", date: "2026-11-12" }, req), /no flight data seller could answer/, "every seller failing before payment is a 503");
  ok(e?.statusCode === 503 && h.booked.at(-1) === 0, "...uncharged, with nothing booked");
  ok(!/30000|20000|cap|0xabc/.test(e?.message), "...and the buyer's message carries no quote, cap or address");
}
{
  // Status for a day the flight does not fly: the seller was paid, so the answer is a charged 200.
  const h = harness({ script: () => ({ result: track, quote: { usd: 0.01 } }) });
  const out = await h.status.handler({ flight: "LH400", date: "2026-10-12" }, req);
  ok(out.found === false && h.calls.length === 1 && h.booked.at(-1) === 0.01, "status: a paid lookup for a non-flying day returns found:false (charged), not a 404");
}
{
  // A garbled body after a successful payment: booked once, not twice, and no second seller.
  const h = harness({ script: () => ({ result: "<html>oops</html>", quote: { usd: 0.02 } }) });
  const out = await h.search.handler({ from: "BER", to: "BCN", date: "2026-11-12" }, req);
  ok(out.unreadable === true && out.offerCount === 0, "a non-JSON answer after payment is a 200 saying so, never a 5xx that leaves the buyer unbilled for a paid seller");
  ok(h.calls.length === 1 && h.booked.at(-1) === 0.02, "...booked once at the signed amount, and no second seller is paid");
}
{
  // Paid, then a JSON body in a shape neither normalizer reads (e.g. an error object).
  const hs = harness({ script: () => ({ result: ["not", "an", "object"], quote: { usd: 0.02 } }) });
  const fs = await hs.search.handler({ from: "BER", to: "BCN", date: "2026-11-12" }, req);
  ok(fs.unreadable === true && fs.offerCount === 0, "search: an unreadable paid answer is a 200 with no offers");
  const ht = harness({ script: () => ({ result: { error: "unknown flight" }, quote: { usd: 0.01 } }) });
  const ts = await ht.status.handler({ flight: "LH400", date: "2026-10-12" }, req);
  ok(ts.found === false && ts.unreadable === true && ht.calls.length === 1, "status: a paid answer with no flights list is found:false, a 200, one seller paid");
}
{
  const h = harness({ script: () => ({ result: fares }), guard: { ok: false, code: "wallet_daily_ceiling" } });
  const e = await throws(() => h.search.handler({ from: "BER", to: "BCN", date: "2026-11-12" }, req), /today's ceiling/, "the spend guard refuses before any seller is called");
  ok(e?.statusCode === 429 && h.calls.length === 0, "...a 429 with no payment");
}
{
  const h = harness({ script: () => ({ result: fares }) });
  await throws(() => h.search.handler({ from: "BER", to: "BCN", date: "2020-01-01" }, req), /in the past/, "bad input is refused before the guard or any payment");
  ok(h.calls.length === 0, "...no seller called");
}
{
  const h = harness({ script: () => ({ result: JSON.stringify(track), quote: { usd: 0.01 } }) });
  const out = await h.status.handler({ flight: "LH400", date: "2026-10-09" }, req);
  ok(out.scheduledDeparture === "2026-10-09T08:55:00Z" && out.servedBy === "track.example.invalid", "status: a JSON string answer parses and the requested day is returned");
  ok(/flights\/LH400\?/.test(h.calls[0].url) && h.calls[0].opts.provenPayTo === C && h.calls[0].opts.maxAtomic === 10000n, "status: the flight fills the path, paid to its pinned address at its cap");
}

console.log(`\n${fail ? "FAILED" : "OK"}: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
