// Capability gaps: tasks this host's own catalog does not do, for which a
// near-named tool would otherwise be picked. One explicit list, read by
// /api/find (src/find.js), /api/route (src/x402-index.js) and route-and-execute
// (src/tools/route-execute.js), so the three agree.
//
// A gap is narrow on purpose. A query is in a family only when it asks for
// that capability in so many words; every other query is ranked and served
// exactly as before. A query in a family is a miss ONLY when no candidate row
// is NAMED for the capability (its slug or name; a description never clears
// it, so text a listing adds to its description cannot take the pick). A row
// that is named for it, an outside seller's included, is the pick.
//
// Adding a family: an `asks` that reads the query, a `covers` that reads a
// row's slug and its name (each alone), `terms` the ranking also looks rows up by, and a case
// with controls in scripts/test-capability-gaps.js. Deterministic, bounded
// patterns over bounded text; no model, no network.

const TEXT_MAX = 500;
// Lowercase, every run of other characters one space, padded with a space at
// each end so a pattern can ask for whole words.
const norm = (s) => ` ${String(s ?? "").slice(0, TEXT_MAX).toLowerCase().replace(/[^a-z0-9]+/g, " ").trim()} `;

// An IPv4 literal in the raw text reads as one word, so "where is 8.8.8.8"
// and "where is this IP" are one shape.
const IP_LITERAL_RE = /(?<![\d.])(?:\d{1,3}\.){3}\d{1,3}(?![\d.])/g;
const LIT = "ipaddrlit";
const normQuery = (raw) => norm(String(raw ?? "").slice(0, TEXT_MAX).replace(IP_LITERAL_RE, ` ${LIT} `));

const IP_WORD = "(?:ip|ips|ipv4|ipv6)";
const ANY_IP_RE = new RegExp(` (?:${IP_WORD}|${LIT}) `);
// The thing asked about: "ip", "this IP address", "the ip 8.8.8.8", a literal.
// It ends the phrase or is followed by a word that keeps it the subject, so
// "ip camera", "ip whitelist", "ipv6 prefix" and "ip-info" are other things.
const DET = "(?:(?:an?|the|this|that|these|those|any|given|some|my|your|its) )?";
const IP_NOUN = `(?:${IP_WORD} (?:(?:address|addresses|addr) )?(?:${LIT} )?|${LIT} )`;
const AFTER = `(?=$|(?:${LIT}|lookup|lookups|is|are|was|in|on|by|with|using|via|from|and|or|to|located|location|geolocation|api|tool|service|please|now|come|comes|originate|originates|belong|belongs|based|geographically|physically|country|city|region|coordinates) )`;
const TARGET = `${DET}${IP_NOUN}${AFTER}`;
// What IP geolocation answers with (and, below, the time zone it implies).
const ATTR = "(?:country|countries|city|cities|region|continent|coordinates|coords|latitude|longitude|lat|latlong|latlng|lat long|lat lon|lat lng)";
const LOCATE = "(?:location|locations|locate|locating|locator|whereabouts)";
// The time zone or local time of an IP is read off its location: the same
// lookup. Asked of a place ("local time in Tokyo") or converted, it is not.
const TZ = "(?:time ?zones?|local time)";

// One word says both halves: geoip, geo ip, ip geo, ipgeo, ip2location.
const GEOIP_RE = / (?:geo ?ips?|geoip2|ip ?geo|ip2location|ip2geo|ip2country|ip2city) /;
// Geolocation in so many words (and its spelling in other languages), read
// with an IP word or literal anywhere in the query.
const GEOLOCATE_RE = / (?:geolocat[a-z]{1,8}|geo locat[a-z]{1,8}|geolo[ck]ali[sz][a-z]{0,10}) /;
const ASK_RES = [
  // "ip location", "ip address location", "ip lookup location", "ip based location"; never "ip location header".
  new RegExp(` ${IP_NOUN}(?:(?:based|lookup|to|physical|geographic|geographical|approximate) )?(?:geo )?(?:location|locations|locator) (?!headers? )`),
  // "location of an ip address", "locate this ip", "locate 8.8.8.8".
  new RegExp(` ${LOCATE} (?:(?:of|for|from|by) )?${TARGET}`),
  // "where is this IP", "where is 8.8.8.8", "where's this ip address from".
  new RegExp(` where (?:is|are|s|was|does|do) (?:(?:an?|the|this|that|these|those|any|given|some) )?${IP_NOUN}${AFTER}`),
  // "this ip is located", "ip addresses located in".
  new RegExp(` ${IP_NOUN}(?:(?:is|are|was) )?(?:(?:physically|geographically) )?(?:located|geolocated|situated) `),
  // "ip to city", "ip address to country code", "map an ip to coordinates".
  new RegExp(` ${IP_NOUN}(?:to|into|2) (?:(?:a|the|its) )?${ATTR} `),
  // "country of an ip", "lat long for an ip address", "latitude and longitude of ip".
  new RegExp(` ${ATTR} (?:(?:code|name|codes|names) )?(?:of|for|from|by) ${TARGET}`),
  // "which country is this IP in", "what city is 1.1.1.1 in".
  new RegExp(` (?:which|what) ${ATTR} (?:is|are|s|does|do|did) ${TARGET}`),
  // "ip country lookup", "ip city".
  new RegExp(` ${IP_NOUN}${ATTR} (?=$|(?:lookup|lookups|code|codes|name|finder|detection|check|api|and|or) )`),
  // "timezone of an ip address", "local time for ip 8.8.8.8", "time zone of 1.1.1.1".
  new RegExp(` ${TZ} (?:of|for|from|by|at) ${TARGET}`),
  // "what timezone is this ip in".
  new RegExp(` (?:which|what) ${TZ} (?:is|are|s|does|do|did) ${TARGET}`),
  // "ip to timezone", "ip timezone lookup".
  new RegExp(` ${IP_NOUN}(?:(?:to|into|2) (?:(?:a|the|its) )?)?${TZ} (?=$|(?:lookup|lookups|finder|detection|check|api|and|or) )`),
];
// A row named for it, slug or name each read alone: any wording above, or
// the short forms a slug takes ("ip-geo", "ip-to-country", "country-by-ip").
const NAMED_RES = [
  new RegExp(` ${IP_WORD} (?:(?:address|addr) )?(?:(?:to|2) )?(?:geo|location|locations|locator|locate|${ATTR}) (?!headers? )`),
  new RegExp(` (?:geo|${LOCATE}|${ATTR}) (?:of|for|from|by) (?:(?:an?|the) )?${IP_WORD} (?:(?:address|addresses|addr) )?$`),
  new RegExp(` (?:geo|locate) ${IP_WORD} (?:(?:address|addresses|addr) )?$`),
];
const asksIpGeolocation = (n) => GEOIP_RE.test(n) || (GEOLOCATE_RE.test(n) && ANY_IP_RE.test(n)) || ASK_RES.some((re) => re.test(n));

// ---- a coin's price on a past date ----
// The look-back tools here answer computed statistics (a return, a drawdown,
// a volatility) and never a past price itself, so a task that asks what a
// coin cost on a date has no tool.
//
// THE QUERY IS READ AS A POSITIVE SHAPE, word by word: one coin word, a price
// word, a past date (or "historical"), and the few function words in
// ASK_WORDS. ANY other word means the task is another job (a gas price, a
// peg, a chart, candles, a price history, a search, filings, news, SQL, a
// comparison, a token on a named chain) and it is ranked and served exactly
// as before. A missed gap is acceptable; a served task read as a gap is not,
// so a word is added to these lists only with controls in
// scripts/test-capability-gaps.js.
const COIN = "(?:coins?|crypto|cryptos|cryptocurrency|cryptocurrencies|altcoins?|tokens?|bitcoin|btc|ethereum|eth|ether|solana|sol|dogecoin|doge|litecoin|ltc|xrp|cardano|ada|bnb|usdc|usdt)";
const COIN_RE = new RegExp(` ${COIN} `);
const COIN_PRICE_RE = / (?:price|prices|priced|snapshot|snapshots) /;
const MONTH = "(?:january|february|march|april|may|june|july|august|september|october|november|december)";
const YEAR = "(?:19|20)\\d\\d";
const COIN_WORD_RE = new RegExp(`^${COIN}$`);
const PRICE_WORD_RE = /^(?:price|prices|priced|snapshot|snapshots)$/;
const HISTORICAL_WORD_RE = /^(?:historical|historic)$/;
const MONTH_WORD_RE = new RegExp(`^${MONTH}$`);
const YEAR_WORD_RE = new RegExp(`^${YEAR}$`);
const DAY_NUM_RE = /^\d{1,2}$/;
const COUNT_RE = /^\d{1,4}$/;
const SPAN_RE = /^(?:days?|weeks?|months?|years?)$/;
// "on a date", "at a given date", "of a specific day", "on date" (a slug).
// "the" is not one of these: "price of the day" is today's price.
const DATE_PREP = new Set(["on", "at", "of", "for"]);
const DATE_DET = new Set(["a", "an", "any", "given", "specific", "certain", "particular", "past", "that"]);
// The function words a past-price question is written with. Nothing else.
const ASK_WORDS = new Set(["a", "an", "the", "of", "for", "on", "at", "in", "as", "what", "was", "is", "were", "s", "did", "back", "get", "give", "me", "show", "find", "lookup", "usd"]);
const ASK_MAX_WORDS = 16;
/** How many words a past date takes at `i`, or 0 when none starts there.
 *  A date that names year `thisYear` or a later one is not read as past
 *  ("eth price in <this year>" asks about now, or about what is to come). */
function pastDateAt(w, i, thisYear) {
  const at = (k) => w[i + k] ?? "";
  const pastYear = (t) => YEAR_WORD_RE.test(t) && Number(t) < thisYear;
  const span = pastDateSpanAt(w, i, at);
  for (let k = 0; k < span; k++) if (YEAR_WORD_RE.test(at(k)) && !pastYear(at(k))) return 0;
  return span;
}
function pastDateSpanAt(w, i, at) {
  // A written date: 2021-01-01, 01/02/2021.
  if (YEAR_WORD_RE.test(at(0)) && DAY_NUM_RE.test(at(1)) && DAY_NUM_RE.test(at(2))) return 3;
  if (DAY_NUM_RE.test(at(0)) && DAY_NUM_RE.test(at(1)) && YEAR_WORD_RE.test(at(2))) return 3;
  // "June 2021", "June 5 2021".
  if (MONTH_WORD_RE.test(at(0))) {
    if (YEAR_WORD_RE.test(at(1))) return 2;
    if (DAY_NUM_RE.test(at(1)) && YEAR_WORD_RE.test(at(2))) return 3;
    return 0;
  }
  // "last June", "in June", "in June 2021", "in 2021", "during 2021".
  if (at(0) === "last" || at(0) === "in" || at(0) === "during") {
    if (MONTH_WORD_RE.test(at(1))) return 1 + (pastDateSpanAt(w, i + 1, (k) => w[i + 1 + k] ?? "") || 1);
    if (at(0) !== "last" && YEAR_WORD_RE.test(at(1))) return 2;
    // "last year", "last month", "last week".
    if (at(0) === "last" && /^(?:year|month|week)$/.test(at(1))) return 2;
    return 0;
  }
  // "3 months ago", "yesterday".
  if (COUNT_RE.test(at(0)) && SPAN_RE.test(at(1)) && at(2) === "ago") return 3;
  if (at(0) === "yesterday") return 1;
  // "on a date", "at a given date", "for a specific day".
  if (DATE_PREP.has(at(0))) {
    let k = 1;
    while (k <= 3 && DATE_DET.has(at(k))) k++;
    if (at(k) === "date" || at(k) === "day") return k + 1;
  }
  return 0;
}
function asksPastCoinPrice(n, now = Date.now()) {
  const thisYear = new Date(now).getUTCFullYear();
  const w = n.trim().split(" ");
  if (w.length < 2 || w.length > ASK_MAX_WORDS) return false;
  let coins = 0, prices = 0, past = 0;
  for (let i = 0; i < w.length;) {
    const span = pastDateAt(w, i, thisYear);
    if (span) { past++; i += span; continue; }
    const t = w[i++];
    if (COIN_WORD_RE.test(t)) coins++;
    else if (PRICE_WORD_RE.test(t)) prices++;
    else if (HISTORICAL_WORD_RE.test(t)) past++;
    else if (!ASK_WORDS.has(t)) return false; // any other word: another job
  }
  // One coin word: "token price on solana yesterday" names a token on a chain.
  return coins === 1 && prices >= 1 && past >= 1;
}

// A ROW'S NAME IS READ LOOSELY, the other way round: a row clears the miss
// when its slug or its name holds a coin word, a price word and a past date
// (or "historical") and names no statistic, forecast or alert, whatever
// other words it carries ("Historical coin price API"). Reading a name
// loosely can only serve a task; it never makes one a miss.
const OTHER_JOB_RE = / (?:statistic|statistics|stats|volatility|drawdown|change|changes|changed|return|returns|performance|trend|trends|since|gain|gains|loss|losses|average|indicator|indicators|prediction|predictions|predict|forecast|forecasts|target|targets|alert|alerts|webhook|convert|conversion) /;
const PAST_RES = [
  / (?:on|at|of|for) (?:(?:a|an|any|given|specific|certain|particular|past|that) ){0,3}(?:date|day) /,
  new RegExp(` (?:${YEAR} \\d{1,2} \\d{1,2}|\\d{1,2} \\d{1,2} ${YEAR}) `),
  new RegExp(` (?:last|in|during) ${MONTH} | ${MONTH} (?:\\d{1,2} )?${YEAR} | (?:in|during) ${YEAR} `),
  / (?:last (?:year|month|week)|\d{1,4} (?:days?|weeks?|months?|years?) ago|yesterday) /,
];
const HISTORICAL_RE = / (?:historical|historic) /;
const namedForPastCoinPrice = (n) => COIN_RE.test(n) && COIN_PRICE_RE.test(n) && !OTHER_JOB_RE.test(n) && (HISTORICAL_RE.test(n) || PAST_RES.some((re) => re.test(n)));

export const CAPABILITY_GAPS = Object.freeze([
  Object.freeze({
    id: "ip-geolocation",
    label: "IP geolocation",
    // Words the ranking also looks rows up by, so a row named for the
    // capability is a candidate however the query worded it ("geolocate
    // 8.8.8.8" writes neither "geolocation" nor an IP word).
    terms: Object.freeze(["geolocat", "geolocation", "geoip", "ip"]),
    asks: asksIpGeolocation,
    covers(n) {
      return asksIpGeolocation(n) || NAMED_RES.some((re) => re.test(n));
    },
  }),
  Object.freeze({
    id: "coin-price-on-date",
    label: "a coin's price on a past date",
    terms: Object.freeze(["historical", "price"]),
    asks: asksPastCoinPrice,
    // A row's slug or name ("historical-coin-price", "Coin price on a date");
    // a row named for statistics never covers it.
    covers: namedForPastCoinPrice,
  }),
]);

/** The gap family a query asks for, or null (nearly every query). `now` is
 *  the clock a date in the query is read against (a test passes its own). */
export function capabilityGap(query, now = Date.now()) {
  const n = normQuery(query);
  for (const gap of CAPABILITY_GAPS) if (gap.asks(n, now)) return gap;
  return null;
}

/** Whether a row is named for the gap's capability: slug and name only. */
export function gapNamedBy(gap, slug, name) {
  return !!gap && (gap.covers(norm(String(slug ?? "").slice(0, 120))) || gap.covers(norm(String(name ?? "").slice(0, 200))));
}

/** The words a refusal names a gap by (its label), from the id an answer carries. */
export function capabilityGapLabel(id) {
  return CAPABILITY_GAPS.find((g) => g.id === id)?.label || "that capability";
}
