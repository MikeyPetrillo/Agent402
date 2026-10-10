// Flight search and flight status, bought from outside x402 sellers.
//
// WHY. Agents asked /api/find to "book a flight" and got order-book tools on the
// word "book"; the router already knows sellers that answer flight questions.
// These two routes give that demand a stable catalog shape: one request format,
// one answer format, whichever seller served it. Booking is out of scope on
// purpose (passenger data, fare rules, refunds); these routes only read.
//
// SELLERS ARE CONFIGURATION, NOT CODE. The house rule is that no third-party
// seller is named in a tracked file, so the list lives in FLIGHT_SELLERS_JSON
// (Railway) and the routes exist only while it is set (key present = feature
// on). Each entry carries the seller's URL template, the Base address it is paid
// at (pinned: a 402 naming any other address is refused before signing), a cap
// on its price, and which answer format to translate:
//
//   {"search": [{"url": "https://host/path?a={from}&b={to}&d={date}", "method": "GET",
//                "format": "fare-search-v1", "maxUsd": 0.001, "payTo": "0x..."}],
//    "status": [{"url": "https://host/flights/{flight}?x=1", "method": "GET",
//                "format": "flight-track-v1", "maxUsd": 0.001, "payTo": "0x..."}]}
//
// MONEY. The seller is paid from our Base spending wallet BEFORE the buyer's own
// payment settles, the same exposure as seller-payability, bounded the same way:
// the settle-failure breaker for wallet-only slugs, the wallet's daily ceiling
// and per-payer unsettled ceiling (external-spend-guard.js), the per-seller cap
// checked against the accept actually signed, and a deadline inside the buyer's
// EVM authorization (EVM-exact only via LONG_RUNNING_SLUGS). An x402 seller that
// fails is not paid, so the next seller is tried only when the failed attempt
// never committed a payment; one that took the money and then failed ends the
// call (uncharged to the buyer) rather than paying a second seller.
import { markUntrusted } from "./provenance.js";
import { evmCredentialBudgetMs, evmCredentialSettleableMs, evmSellerSignBy, EVM_SELLER_ALLOWANCE_MS } from "../evm-validity.js";
import { maySpend as realMaySpend, noteSpend as realNoteSpend, adjustSpend as realAdjustSpend, reserveSpend as realReserveSpend, composeReserve } from "../external-spend-guard.js";
import { payerFromRequest } from "../payer.js";

function bad(message, statusCode = 400) {
  return Object.assign(new Error(message), { statusCode });
}

export const FLIGHT_SEARCH_PRICE_USD = 0.03;
export const FLIGHT_STATUS_PRICE_USD = 0.015;
const PAY_TIMEOUT_MS = 30_000;
const DEADLINE_MS = 50_000;
const MAX_OFFERS = 12;
const FORMATS = new Set(["fare-search-v1", "flight-track-v1"]);
const IATA = /^[A-Z]{3}$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const FLIGHT = /^([A-Z][A-Z0-9]|[A-Z0-9][A-Z])(\d{1,4})([A-Z]?)$/;
const CLASSES = { economy: "1", premium_economy: "2", business: "3", first: "4" };

/** The configured sellers, or null when the feature is off. Throws on a
 *  malformed config so a bad Railway value fails the boot loudly. */
export function parseFlightSellers(raw) {
  if (raw == null || String(raw).trim() === "") return null;
  let cfg;
  try { cfg = JSON.parse(String(raw)); } catch { throw new Error("FLIGHT_SELLERS_JSON is not valid JSON"); }
  const out = {};
  for (const kind of ["search", "status"]) {
    const list = Array.isArray(cfg?.[kind]) ? cfg[kind] : [];
    out[kind] = list.map((s, i) => {
      const where = `FLIGHT_SELLERS_JSON.${kind}[${i}]`;
      let u;
      try { u = new URL(String(s?.url || "").replace(/\{[a-z]+\}/gi, "x")); } catch { throw new Error(`${where}.url is not a URL`); }
      if (u.protocol !== "https:") throw new Error(`${where}.url must be https`);
      const method = String(s?.method || "GET").toUpperCase();
      if (method !== "GET" && method !== "POST") throw new Error(`${where}.method must be GET or POST`);
      if (!FORMATS.has(s?.format)) throw new Error(`${where}.format must be one of ${[...FORMATS].join(", ")}`);
      const maxUsd = Number(s?.maxUsd);
      if (!(maxUsd > 0)) throw new Error(`${where}.maxUsd must be a positive number`);
      if (!/^0x[0-9a-fA-F]{40}$/.test(String(s?.payTo || ""))) throw new Error(`${where}.payTo must be the seller's Base address`);
      return { url: String(s.url), method, format: s.format, maxUsd, payTo: String(s.payTo), body: s.body && typeof s.body === "object" ? s.body : null };
    });
  }
  const price = { search: FLIGHT_SEARCH_PRICE_USD, status: FLIGHT_STATUS_PRICE_USD };
  for (const kind of ["search", "status"]) {
    for (const s of out[kind]) {
      // Every seller in a chain must fit under the route's seller ceiling.
      if (s.maxUsd > price[kind] * 0.7 + 1e-9) throw new Error(`FLIGHT_SELLERS_JSON.${kind}: a seller cap of $${s.maxUsd} exceeds the route's seller ceiling`);
    }
  }
  return out;
}

/** Fill a URL or body template from validated params; an unset optional
 *  placeholder drops its query parameter. */
const param = (params, k) => (Object.hasOwn(params, k) ? params[k] : null);
export function fillTemplate(template, params) {
  const u = new URL(template.replace(/\{([a-z]+)\}/gi, (_, k) => (param(params, k) == null ? `__unset_${k}__` : encodeURIComponent(String(param(params, k))))));
  // A query value that names an unset optional placeholder anywhere is dropped
  // whole, so "__unset_x__" never reaches a seller.
  for (const [k, v] of [...u.searchParams.entries()]) if (/__unset_[a-z]+__/i.test(v)) u.searchParams.delete(k);
  if (/__unset_/.test(u.pathname)) throw bad("a required value is missing for this flight seller", 500);
  return u.toString();
}
function fillBody(body, params) {
  if (!body) return null;
  return JSON.parse(JSON.stringify(body).replace(/"\{([a-z]+)\}"/gi, (_, k) => JSON.stringify(param(params, k))));
}

const todayUtc = (now) => new Date(now).toISOString().slice(0, 10);

export function validateSearch(input, now = Date.now()) {
  const from = String(input?.from ?? "").trim().toUpperCase();
  const to = String(input?.to ?? "").trim().toUpperCase();
  if (!IATA.test(from) || !IATA.test(to)) throw bad('"from" and "to" are 3-letter IATA airport codes, e.g. {"from":"BER","to":"BCN"}');
  if (from === to) throw bad('"from" and "to" are the same airport');
  const date = String(input?.date ?? "").trim();
  if (!DATE.test(date) || Number.isNaN(Date.parse(`${date}T00:00:00Z`))) throw bad('"date" is the outbound date as YYYY-MM-DD');
  if (date < todayUtc(now)) throw bad('"date" is in the past');
  if (Date.parse(`${date}T00:00:00Z`) - now > 330 * 86_400_000) throw bad('"date" is more than 330 days out; airlines do not sell that far ahead');
  let ret = null;
  if (input?.return != null && input.return !== "") {
    ret = String(input.return).trim();
    if (!DATE.test(ret) || Number.isNaN(Date.parse(`${ret}T00:00:00Z`))) throw bad('"return" is the return date as YYYY-MM-DD');
    if (ret < date) throw bad('"return" is before "date"');
  }
  const adults = input?.adults == null ? 1 : Number(input.adults);
  if (!Number.isInteger(adults) || adults < 1 || adults > 9) throw bad('"adults" is a whole number from 1 to 9');
  const cls = input?.travelClass == null ? "economy" : String(input.travelClass);
  if (!Object.hasOwn(CLASSES, cls)) throw bad(`"travelClass" is one of ${Object.keys(CLASSES).join(", ")}`);
  return { from, to, date, return: ret, adults, travelClass: cls, travelClassCode: CLASSES[cls], tripType: ret ? "1" : "2" };
}

export function validateStatus(input, now = Date.now()) {
  const raw = String(input?.flight ?? "").replace(/\s+/g, "").toUpperCase();
  const m = FLIGHT.exec(raw);
  if (!m) throw bad('"flight" is an airline flight number as printed on the ticket, e.g. "LH400" or "BA 117"');
  let date = null;
  if (input?.date != null && input.date !== "") {
    date = String(input.date).trim();
    if (!DATE.test(date) || Number.isNaN(Date.parse(`${date}T00:00:00Z`))) throw bad('"date" is the scheduled departure date as YYYY-MM-DD');
    const day = Date.parse(`${date}T00:00:00Z`);
    if (Math.abs(day - now) > 14 * 86_400_000) throw bad('"date" must be within 14 days of today; flight tracking covers recent and upcoming flights');
  }
  return { flight: `${m[1]}${m[2]}${m[3]}`, airline: m[1], number: m[2], date };
}

const n = (v) => (Number.isFinite(Number(v)) ? Number(v) : null);
const s = (v, max = 120) => (typeof v === "string" ? v.slice(0, max) : null);

/** The fare-search answer format: best and other itineraries with legs. */
// Both normalizers mark an answer they cannot read (unreadable:true); the
// handler turns that into an uncharged 502. The seller was already paid, and
// that cost is ours: a buyer never pays for an answer we could not read.
export function normalizeFareSearch(data, params) {
  if (!data || typeof data !== "object" || Array.isArray(data) || (!Array.isArray(data.best_flights) && !Array.isArray(data.other_flights))) data = { unreadable: true };
  const pick = (list, best) => (Array.isArray(list) ? list : []).map((o) => {
    const legs = (Array.isArray(o?.flights) ? o.flights : []).map((l) => ({
      airline: s(l?.airline, 60),
      flightNumber: s(l?.flight_number, 16),
      from: s(l?.departure_airport?.id, 4),
      departs: s(l?.departure_airport?.time, 20),
      to: s(l?.arrival_airport?.id, 4),
      arrives: s(l?.arrival_airport?.time, 20),
      durationMin: n(l?.duration),
      aircraft: s(l?.airplane, 60),
      cabin: s(l?.travel_class, 30),
    }));
    return { price: n(o?.price), totalDurationMin: n(o?.total_duration), stops: Math.max(0, legs.length - 1), best, legs };
  }).filter((o) => o.price != null && o.legs.length);
  const offers = [...pick(data.best_flights, true), ...pick(data.other_flights, false)].slice(0, MAX_OFFERS);
  const insights = data.price_insights && typeof data.price_insights === "object" ? data.price_insights : {};
  return {
    from: params.from, to: params.to, date: params.date, return: params.return, adults: params.adults, travelClass: params.travelClass,
    currency: s(data?.search_parameters?.currency, 8) || "USD",
    offerCount: offers.length,
    offers,
    lowestPrice: n(insights.lowest_price) ?? (offers.length ? Math.min(...offers.map((o) => o.price)) : null),
    typicalPriceRange: Array.isArray(insights.typical_price_range) ? insights.typical_price_range.map(n).filter((x) => x != null).slice(0, 2) : null,
    priceLevel: s(insights.price_level, 20),
    ...(data.unreadable ? { unreadable: true, note: "the flight data seller's answer could not be read" } : {}),
  };
}

const stamp = (v) => s(v, 25);
/** The flight-track answer format: one flight per scheduled day. Picks the
 *  requested day, else the flight in the air now, else the next to depart,
 *  else the most recent. */
export function normalizeFlightTrack(data, params, now = Date.now()) {
  const list = Array.isArray(data?.flights) ? data.flights : null;
  if (!list) return { found: false, flight: params.flight, date: params.date, reason: "the flight data seller's answer could not be read", otherDays: [], unreadable: true };
  const rows = list.map((f) => ({
    flight: s(f?.ident_iata, 10) || params.flight,
    operator: s(f?.operator_iata || f?.operator, 10),
    status: s(f?.status, 80),
    from: s(f?.origin?.code_iata, 4), fromCity: s(f?.origin?.city, 60),
    to: s(f?.destination?.code_iata, 4), toCity: s(f?.destination?.city, 60),
    scheduledDeparture: stamp(f?.scheduled_out), estimatedDeparture: stamp(f?.estimated_out), actualDeparture: stamp(f?.actual_out),
    scheduledArrival: stamp(f?.scheduled_in), estimatedArrival: stamp(f?.estimated_in), actualArrival: stamp(f?.actual_in),
    departureDelayMin: n(f?.departure_delay) != null ? Math.round(n(f.departure_delay) / 60) : null,
    arrivalDelayMin: n(f?.arrival_delay) != null ? Math.round(n(f.arrival_delay) / 60) : null,
    progressPercent: n(f?.progress_percent),
    cancelled: f?.cancelled === true, diverted: f?.diverted === true,
    gateDeparture: s(f?.gate_origin, 10), terminalDeparture: s(f?.terminal_origin, 10),
    gateArrival: s(f?.gate_destination, 10), terminalArrival: s(f?.terminal_destination, 10),
    aircraft: s(f?.aircraft_type, 10),
  })).filter((r) => r.scheduledDeparture);
  // This runs after the seller was paid, so "not found" is an answer with
  // found:false, the same as any other answer the seller gave.
  const notFound = (why) => ({ found: false, flight: params.flight, date: params.date, reason: why, otherDays: rows.map((r) => r.scheduledDeparture).slice(0, 10) });
  if (!rows.length) return notFound(`no tracked flight ${params.flight} in the window the seller covers`);
  const t = (r) => Date.parse(r.scheduledDeparture);
  let chosen = null;
  if (params.date) chosen = rows.find((r) => r.scheduledDeparture.slice(0, 10) === params.date) || null;
  if (params.date && !chosen) return notFound(`flight ${params.flight} has no departure scheduled on ${params.date} in the seller's data`);
  chosen ||= rows.find((r) => r.actualDeparture && !r.actualArrival)
    || rows.filter((r) => t(r) >= now).sort((a, b) => t(a) - t(b))[0]
    || rows.sort((a, b) => t(b) - t(a))[0];
  return { found: true, ...chosen, otherDays: rows.filter((r) => r !== chosen).map((r) => r.scheduledDeparture).slice(0, 10) };
}

/** Pay the configured sellers in order until one answers. */
async function buyFirst(sellers, params, { req, pay, kind, spend, now }) {
  const t0 = now();
  const credentialMs = evmCredentialBudgetMs(req, { nowMs: t0 });
  const deadlineMs = credentialMs != null && credentialMs < DEADLINE_MS ? Math.max(0, credentialMs) : DEADLINE_MS;
  let lastErr = null;
  for (const seller of sellers) {
    if (now() - t0 > deadlineMs - 2_000) break;
    const settleableMs = evmCredentialSettleableMs(req, { nowMs: now() });
    if (settleableMs != null && settleableMs < EVM_SELLER_ALLOWANCE_MS) {
      throw bad("Too little of your payment authorization's life is left to buy the flight data and still settle (a stock client signs 300 s ahead). Nothing was charged.", 504);
    }
    const url = fillTemplate(seller.url, params);
    let paidOut = null;
    const body = seller.method === "POST" ? fillBody(seller.body, params) ?? {} : undefined;
    try {
      const signBy = evmSellerSignBy(req, { nowMs: now() });
      const out = await pay(url, {
        maxAtomic: BigInt(Math.round(seller.maxUsd * 1e6)),
        method: seller.method,
        ...(body ? { body } : {}),
        chain: "base",
        provenPayTo: seller.payTo,
        timeoutMs: Math.max(1_000, Math.min(PAY_TIMEOUT_MS, deadlineMs - (now() - t0))),
        refusalMaxWaitMs: Math.max(0, deadlineMs - (now() - t0)),
        slug: kind === "search" ? "flight-search" : "flight-status",
        ...(signBy != null ? { signBy } : {}),
      });
      // No quote means the seller answered without asking for payment: nothing spent.
      const signedUsd = out?.quote == null ? 0 : Number(out.quote.usd);
      spend.paid += Number.isFinite(signedUsd) ? signedUsd : seller.maxUsd;
      paidOut = out;
    } catch (e) {
      lastErr = e;
      if (e?.committed === true || e?.paidUnanswered === true) {
        // Our authorization went out (payX402's own stamp, which the seller cannot
        // influence), so the seller may have collected: never pay a second seller
        // for the same call (route-execute's rule). Booked at the signed amount, or
        // the cap when unknown. The buyer is not charged (>= 400 cancels settlement).
        const signed = Number(e?.signedUsd);
        spend.paid += Number.isFinite(signed) && signed >= 0 ? signed : seller.maxUsd;
        throw bad("the flight data seller did not deliver after our payment went out; nothing was charged to you", 502);
      }
      // A 404 from the seller is an answer about the flight, not an outage.
      if (e?.statusCode === 404) throw bad("the flight data seller has no record for that request; nothing was charged", 404);
      continue;
    }
    // Paid and answered. Outside the try: a garbled body here was paid once and
    // is booked once; it never falls through to a second seller.
    let data = paidOut?.result;
    if (typeof data === "string") { try { data = JSON.parse(data); } catch { data = null; } }
    return { data, servedBy: new URL(url).host, format: seller.format };
  }
  // The cause stays in our log: payX402's messages can carry the seller's quote,
  // our per-seller cap and its pinned address, which are not the buyer's to read.
  if (lastErr) console.warn(`[flights] ${kind}: every seller failed before payment: ${String(lastErr.message || lastErr).slice(0, 200)}`);
  throw bad("no flight data seller could answer right now; nothing was charged", 503);
}

/** Deps are injectable so the whole flow is testable offline with a stub
 *  seller; the defaults are the real spend guard and payer. */
export function buildFlightTools({ sellers, pay, now = () => Date.now(), maySpend = realMaySpend, noteSpend = realNoteSpend, adjustSpend = realAdjustSpend, reserveSpend = null } = {}) {
  if (!sellers) return [];
  // Check and book in one step; injected maySpend/noteSpend (tests) compose into the same shape.
  const reserve = reserveSpend || (maySpend === realMaySpend && noteSpend === realNoteSpend ? realReserveSpend : composeReserve(maySpend, noteSpend));
  function make(kind) {
    const list = sellers[kind] || [];
    if (!list.length) return null;
    const worst = Math.max(...list.map((x) => x.maxUsd));
    return async (input, req) => {
      const params = kind === "search" ? validateSearch(input, now()) : validateStatus(input, now());
      const spendPayer = payerFromRequest(req) || (req?.mppTempoSender ? `tempo:${req.mppTempoSender}` : null) || (req?.ip ? `ip:${req.ip}` : null);
      const allowed = await reserve(spendPayer, worst, { chain: "base" });
      if (!allowed?.ok) {
        throw bad(allowed?.code === "wallet_daily_ceiling"
          ? "Flight data purchases have reached today's ceiling; they resume tomorrow (nothing was charged)"
          : "Flight data purchases are paused right now; try again shortly (nothing was charged)", 429);
      }
      const handle = allowed.handle ?? null;
      if (handle && req && typeof req === "object") req.__externalSpend = handle;
      const spend = { paid: 0 };
      try {
        const got = await buyFirst(list, params, { req, pay, kind, spend, now });
        const answer = got.format === "fare-search-v1" ? normalizeFareSearch(got.data, params) : normalizeFlightTrack(got.data, params, now());
        if (answer.unreadable) throw bad("the flight data seller's answer could not be read; nothing was charged to you", 502);
        return markUntrusted({ ...answer, servedBy: got.servedBy, fetchedAt: new Date(now()).toISOString() });
      } finally {
        adjustSpend(handle, spend.paid);
      }
    };
  }
  const tools = [];
  // The search example is dated five weeks ahead of boot, so it never falls
  // into the past that validateSearch refuses.
  const exampleDate = todayUtc(Date.now() + 35 * 86_400_000);
  const search = make("search");
  if (search) tools.push({
    route: "POST /api/flight-search",
    name: "Flight search",
    slug: "flight-search",
    aliases: ["flights", "search-flights", "flight-prices", "airfare", "cheap-flights"],
    category: "travel",
    spendsOwnWallet: true,
    price: `$${FLIGHT_SEARCH_PRICE_USD}`,
    description: "Flight offers between two airports on a date: price, total duration, stops and each leg (airline, flight number, times, aircraft, cabin), plus the lowest and typical price for the route. Bought live per request from an outside flight data seller and returned in one stable shape; the answer names which seller served it. Searches only: it does not book or hold seats.",
    tags: ["travel", "flights", "flight search", "airfare", "fares", "airline", "itinerary", "book a flight", "cheap flights", "plane tickets"],
    discovery: {
      bodyType: "json",
      inputSchema: {
        type: "object",
        properties: {
          from: { type: "string", description: "Departure airport, 3-letter IATA code (e.g. BER)" },
          to: { type: "string", description: "Arrival airport, 3-letter IATA code (e.g. BCN)" },
          date: { type: "string", description: "Outbound date, YYYY-MM-DD" },
          return: { type: "string", description: "Optional return date, YYYY-MM-DD (round trip)" },
          adults: { type: "number", description: "Optional passengers, 1 to 9 (default 1)" },
          travelClass: { type: "string", description: "Optional economy, premium_economy, business or first (default economy)" },
        },
        required: ["from", "to", "date"],
      },
      input: { from: "BER", to: "BCN", date: exampleDate },
      output: { example: { from: "BER", to: "BCN", date: exampleDate, return: null, adults: 1, travelClass: "economy", currency: "USD", offerCount: 1, offers: [{ price: 53, totalDurationMin: 155, stops: 0, best: true, legs: [{ airline: "Ryanair", flightNumber: "FR 132", from: "BER", departs: `${exampleDate} 21:20`, to: "BCN", arrives: `${exampleDate} 23:55`, durationMin: 155, aircraft: "Boeing 737MAX 8 Passenger", cabin: "Economy" }] }], lowestPrice: 53, typicalPriceRange: [50, 90], priceLevel: "low", servedBy: "flights.example.invalid", fetchedAt: "2026-10-07T14:00:00.000Z" } },
    },
    handler: search,
  });
  const status = make("status");
  if (status) tools.push({
    route: "POST /api/flight-status",
    name: "Flight status",
    slug: "flight-status",
    aliases: ["flight-tracker", "track-flight", "is-my-flight-delayed", "flight-delay"],
    category: "travel",
    spendsOwnWallet: true,
    price: `$${FLIGHT_STATUS_PRICE_USD}`,
    description: "Live status of one flight by its number: scheduled, estimated and actual departure and arrival, delay in minutes, gates and terminals, progress, cancelled or diverted. Give a date to pick that day's flight; otherwise the flight in the air now or the next to depart. A day the flight does not fly answers found:false with the days it does. Bought live per request from an outside flight data seller; the answer names which seller served it.",
    tags: ["travel", "flights", "flight status", "flight tracker", "delay", "departure", "arrival", "gate", "is my flight on time"],
    discovery: {
      bodyType: "json",
      inputSchema: {
        type: "object",
        properties: {
          flight: { type: "string", description: "Flight number as printed on the ticket, e.g. LH400" },
          date: { type: "string", description: "Optional scheduled departure date, YYYY-MM-DD, within 14 days" },
        },
        required: ["flight"],
      },
      input: { flight: "LH400" },
      output: { example: { found: true, flight: "LH400", operator: "LH", status: "Scheduled", from: "FRA", fromCity: "Frankfurt am Main", to: "JFK", toCity: "New York", scheduledDeparture: "2026-10-09T08:55:00Z", estimatedDeparture: "2026-10-09T08:55:00Z", actualDeparture: null, scheduledArrival: "2026-10-09T17:35:00Z", estimatedArrival: "2026-10-09T17:35:00Z", actualArrival: null, departureDelayMin: 0, arrivalDelayMin: 0, progressPercent: 0, cancelled: false, diverted: false, gateDeparture: null, terminalDeparture: null, gateArrival: null, terminalArrival: null, aircraft: "B748", otherDays: ["2026-10-08T08:55:00Z"], servedBy: "flights.example.invalid", fetchedAt: "2026-10-07T14:00:00.000Z" } },
    },
    handler: status,
  });
  return tools;
}
