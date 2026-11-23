// search-suggest's source: English Wikipedia's opensearch API (article titles
// that complete a partial input). Keyless and shared, so it is read the way
// the Wikimedia API etiquette and User-Agent policy ask
// (mediawiki.org/wiki/API:Etiquette, foundation.wikimedia.org's User-Agent
// policy and API usage guidelines, mediawiki.org/wiki/Wikimedia_APIs/Rate_limits):
//   - a User-Agent that names the client, says it is a bot and gives contact
//     details (an identified bot may make 200 requests a minute);
//   - requests made one after another, never in parallel;
//   - a per-minute ceiling under that limit for this process, so a burst
//     waits briefly or is answered busy (503, before any payment is taken),
//     and never reaches the source as a spike;
//   - the source is named on every answer (the tool's credit).
import { upstreamFetch, bodyUnderDeadline } from "../upstream-deadline.js";
import { settleBeforeUpstream } from "../settle-first.js";

export const WIKIPEDIA_OPENSEARCH_URL = "https://en.wikipedia.org/w/api.php";
export const SUGGEST_USER_AGENT = "Agent402SuggestBot/1.0 (https://agent402.tools/crawler; help@agent402.tools) search-suggest";
/** Reads per rolling minute this process sends, under the source's 200. */
export const SUGGEST_MAX_PER_MINUTE = 150;
/** Callers that may wait for their turn at once; one more is answered busy. */
export const SUGGEST_MAX_WAITING = 20;
/** The longest a caller waits for room in the minute before it is answered busy. */
export const SUGGEST_MAX_WAIT_MS = 2000;
const TIMEOUT_MS = 8000;
const WINDOW_MS = 60_000;

function bad(message, statusCode = 400) {
  return Object.assign(new Error(message), { statusCode });
}
const busy = () => bad("Search suggestions are busy - retry shortly", 503);

// One read at a time: each caller's turn starts when the previous read ends.
let tail = Promise.resolve();
let waiting = 0;
const sent = []; // send times inside the rolling minute
let now = () => Date.now();
let sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Test hook: a clock and a sleep of the caller's, and an empty window. */
export function _setSuggestClockForTest(clock, sleeper) {
  now = clock || (() => Date.now());
  sleep = sleeper || ((ms) => new Promise((r) => setTimeout(r, ms)));
  sent.length = 0; waiting = 0; tail = Promise.resolve();
}

function roomAfterMs() {
  const t = now();
  while (sent.length && t - sent[0] >= WINDOW_MS) sent.shift();
  return sent.length < SUGGEST_MAX_PER_MINUTE ? 0 : sent[0] + WINDOW_MS - t;
}

/** Run `read` in this process's turn order, under the per-minute ceiling. */
async function inTurn(read) {
  if (waiting >= SUGGEST_MAX_WAITING) throw busy();
  waiting++;
  let release;
  const prev = tail;
  tail = new Promise((r) => { release = r; });
  try {
    await prev;
    const wait = roomAfterMs();
    if (wait > SUGGEST_MAX_WAIT_MS) throw busy();
    if (wait > 0) await sleep(wait);
    sent.push(now());
    return await read();
  } finally {
    waiting--;
    release();
  }
}

/** Up to `count` Wikipedia article titles completing `q`, in the source's order. */
export async function wikipediaSuggestions(q, count) {
  return inTurn(async () => {
    // The settle point (src/settle-first.js), after our own checks and the
    // turn, before the read.
    await settleBeforeUpstream();
    const url = new URL(WIKIPEDIA_OPENSEARCH_URL);
    url.search = new URLSearchParams({ action: "opensearch", format: "json", formatversion: "2", namespace: "0", limit: String(count), search: q }).toString();
    const ctx = { label: "Search suggestions", step: "opensearch", timeoutMs: TIMEOUT_MS, tag: "[search-suggest]" };
    const res = await upstreamFetch(url, { headers: { "User-Agent": SUGGEST_USER_AGENT, "Api-User-Agent": SUGGEST_USER_AGENT, Accept: "application/json" } }, ctx);
    if (res.status === 429) throw busy();
    if (!res.ok) throw bad(`Search suggestions upstream error (HTTP ${res.status})`, 502);
    let data;
    try { data = await bodyUnderDeadline(res.json(), ctx); }
    catch (err) { if (err?.statusCode) throw err; throw bad("Search suggestions upstream returned non-JSON", 502); }
    const titles = Array.isArray(data) && Array.isArray(data[1]) ? data[1] : [];
    return titles.filter((s) => typeof s === "string").slice(0, count);
  });
}
