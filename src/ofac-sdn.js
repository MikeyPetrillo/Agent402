// The US Treasury OFAC Specially Designated Nationals (SDN) list: one
// download, one parser, for every reader in this process.
//
// READERS. src/tools/sanctions-kit.js (the sanctions-wallet and sanctions-name
// tools, and screenAddressForPayment, the router's check before it pays a
// seller) and src/sanctions-screen.js (the payment-party screen of Tempo
// direct mode and of x402 payers, which keeps only the EVM-format
// addresses). Both read the list through parseSdnXml below, so they can never
// read it differently, and both load it through loadSdnList, so one fetch
// feeds both.
//
// SOURCE. The SDN list in OFAC's legacy XML format, published by the Sanctions
// List Service:
//   https://sanctionslistservice.ofac.treas.gov/api/PublicationPreview/exports/SDN.XML
// (a 302 to a signed download of the current publication, about 30 MB; root
// <sdnList>, <publshInformation><Publish_Date>MM/DD/YYYY</Publish_Date>). Each
// <sdnEntry> carries <uid>, <lastName>, an optional <firstName>, <sdnType>,
// a <programList> of <program> rows, and an <idList> whose <id> rows hold
// <idType>Digital Currency Address - <ASSET></idType> and
// <idNumber><address></idNumber>. The XML is read rather than SDN.CSV because
// the CSV carries digital currency addresses inside its remarks column, which
// is cut at about a thousand characters, so an entry with many addresses
// loses every address past the cut. The regexes below do not depend on the
// namespace. A US government publication.
//
// SHARED LOAD. loadSdnList({ maxAgeMs }) answers the parse held in memory when
// it was fetched within maxAgeMs, joins a fetch already in flight, and only
// otherwise fetches. Every successful fetch is also handed to the readers
// registered with onSdnList: the sanctions tools adopt each list the screen
// fetched, so their own timer downloads only when nobody has fetched for a
// whole refresh period. The screen passes a window of a quarter of its period,
// so a refresh that comes due shortly after the tools' fetch takes that parse.
// The raw text is dropped after the parse; only the entries are held.
//
// FORMAT GUARD. A parse with no entry, or with no digital currency address at
// all, is a format change, not an empty list: loadSdnList throws and keeps
// nothing, and each reader keeps its previous good copy.
import { registerMemoryStore } from "./memory-stores.js";
import { envAtLeast as envMs } from "./env-num.js";

export const SDN_LIST_DEFAULT_URL = "https://sanctionslistservice.ofac.treas.gov/api/PublicationPreview/exports/SDN.XML";
export const SDN_MAX_BYTES = 96 * 1024 * 1024; // the export is ~30 MB; far past that is a surprise worth refusing
const EVM_RE = /^0x[0-9a-fA-F]{40}$/;

/** The download timeout: the whole export over a slow link takes minutes. */
export function sdnFetchTimeoutMs() { return envMs("SANCTIONS_LIST_TIMEOUT_MS", 10 * 60_000, 1000); }
export function sdnListUrl() { return String(process.env.SANCTIONS_LIST_URL || "").trim() || SDN_LIST_DEFAULT_URL; }

// A substring of the export can share the export's own memory, so one kept
// field would keep the whole ~30 MB text alive. Every held value is copied
// out first, which is what lets the raw text go after the parse.
const detach = (s) => Buffer.from(s, "utf8").toString("utf8");
const decodeXml = (s) => detach(String(s)
  .replace(/&#x([0-9a-fA-F]+);/g, (_, h) => String.fromCodePoint(parseInt(h, 16)))
  .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
  .replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, "\"").replace(/&apos;/g, "'").replace(/&amp;/g, "&")
  .trim());
const tag = (block, name) => { const m = new RegExp(`<${name}>([\\s\\S]*?)</${name}>`).exec(block); return m ? decodeXml(m[1]) : null; };
const CURRENCY_RE = /^Digital Currency Address\s*-\s*([A-Za-z0-9.]+)\s*$/i;

/** Every entry in an SDN.XML export. Pure; never throws.
 *  Returns { entries: [{ uid, lastName, firstName, name, sdnType, programs,
 *  addresses: [{ asset, address }] }], digitalCurrencyIds, publishDate }.
 *  `name` is the list's own display form: "LASTNAME, Firstname" for an
 *  individual, the last name alone otherwise (the same string SDN.CSV prints).
 *  `addresses` keeps every Digital Currency Address id of the entry, in list
 *  order, with its asset ticker uppercased and its value exactly as listed. */
export function parseSdnXml(xml) {
  return runWhole(sdnParseSteps(xml));
}

/** Run a step generator (one `yield` per unit of work) to its return value
 *  in one go. */
export function runWhole(steps) {
  let r;
  do r = steps.next(); while (!r.done);
  return r.value;
}

/** Run a step generator across event-loop turns: a setImmediate before each
 *  slice, each slice about `sliceMs` of loop time (measured, not counted), so
 *  the work never shares the caller's turn. Resolves its return value, the
 *  same one runWhole gives. */
export async function runSliced(steps, { sliceMs = SDN_PARSE_SLICE_MS } = {}) {
  for (;;) {
    await new Promise((resolve) => setImmediate(resolve));
    const until = performance.now() + sliceMs;
    let r;
    do r = steps.next(); while (!r.done && performance.now() < until);
    if (r.done) return r.value;
  }
}

// The export is about 30 MB and 19,000 entries: read in one turn it held the
// event loop 140 ms on a laptop and over 800 ms on a shared runner, every time
// a refresh landed. The steps below yield after each entry; parseSdnXmlAsync
// runs them in slices of SDN_PARSE_SLICE_MS of loop time with a setImmediate
// between slices (yielding on elapsed time, not on a count of entries), and
// parseSdnXml runs them in one go, so the two can never read the list
// differently.
export const SDN_PARSE_SLICE_MS = 8;
// One <sdnEntry> block (its inner text) into acc; shared by the string and
// the stream readers so the two can never read an entry differently.
function readSdnEntry(block, acc) {
    const programs = [];
    const pl = /<programList>([\s\S]*?)<\/programList>/.exec(block);
    if (pl) for (const p of pl[1].matchAll(/<program>([\s\S]*?)<\/program>/g)) { const v = decodeXml(p[1]); if (v) programs.push(v); }
    const addresses = [];
    const il = /<idList>([\s\S]*?)<\/idList>/.exec(block);
    if (il) for (const idm of il[1].matchAll(/<id>([\s\S]*?)<\/id>/g)) {
      const type = tag(idm[1], "idType");
      const t = type ? CURRENCY_RE.exec(type) : null;
      if (!t) continue;
      acc.digitalCurrencyIds++;
      const address = tag(idm[1], "idNumber") || "";
      if (!address || /\s/.test(address) || address.length > 200) continue;
      addresses.push({ asset: detach(t[1].toUpperCase()), address });
    }
    // The entry's own fields, read with every nested list (aka, address,
    // id, nationality, ...) removed, so an alias's lastName is never taken
    // for the entry's.
    const own = block.replace(/<(\w+List)>[\s\S]*?<\/\1>/g, "").replace(/<vesselInfo>[\s\S]*?<\/vesselInfo>/g, "");
    const uid = tag(own, "uid");
    const lastName = tag(own, "lastName");
    if (uid && lastName) {
      const firstName = tag(own, "firstName") || null;
      acc.entries.push({ uid, lastName, firstName, name: firstName ? `${lastName}, ${firstName}` : lastName, sdnType: tag(own, "sdnType") || null, programs, addresses });
    }
}

function* sdnParseSteps(xml) {
  const text = String(xml || "");
  const acc = { entries: [], digitalCurrencyIds: 0 };
  for (const m of text.matchAll(/<sdnEntry>([\s\S]*?)<\/sdnEntry>/g)) {
    readSdnEntry(m[1], acc);
    yield;
  }
  const pd = /<Publish_Date>([^<]*)<\/Publish_Date>/.exec(text);
  return { entries: acc.entries, digitalCurrencyIds: acc.digitalCurrencyIds, publishDate: pd ? detach(pd[1].trim()) : null };
}

/** parseSdnXml across event-loop turns: the same result, never more than
 *  about `sliceMs` of loop time per turn. */
export function parseSdnXmlAsync(xml, { sliceMs = SDN_PARSE_SLICE_MS } = {}) {
  return runSliced(sdnParseSteps(xml), { sliceMs });
}

/** The EVM-format addresses of a parse (0x + 40 hex, under any asset ticker),
 *  lowercased, with distinct-address counts per ticker. */
export function sdnEvmAddresses(parsed) { return runWhole(sdnEvmAddressSteps(parsed)); }
/** sdnEvmAddresses across event-loop turns (runSliced): the same result. */
export function sdnEvmAddressesAsync(parsed, opts) { return runSliced(sdnEvmAddressSteps(parsed), opts); }
function* sdnEvmAddressSteps(parsed) {
  const addresses = new Set();
  const perAssetSets = new Map();
  for (const e of parsed?.entries || []) {
    for (const { asset, address } of e.addresses) {
      if (!EVM_RE.test(address)) continue;
      const key = address.toLowerCase();
      addresses.add(key);
      if (!perAssetSets.has(asset)) perAssetSets.set(asset, new Set());
      perAssetSets.get(asset).add(key);
    }
    yield;
  }
  const perAsset = Object.fromEntries([...perAssetSets].sort(([a], [b]) => a.localeCompare(b)).map(([k, s]) => [k, s.size]));
  return { addresses, perAsset };
}

// ---------------------------------------------------------------------------
let held = null;     // { ...parse, fetchedAt, bytes } of the last good fetch
let inFlight = null; // the fetch in progress, joined by every caller
const listeners = new Set();

/** Call `fn(list)` after every successful fetch, whoever asked for it, so a
 *  reader adopts a list another reader fetched without waiting for its own
 *  timer. Each reader starts on a turn after the parse's last one and may
 *  return a promise (a reader that builds its own sets from the list slices
 *  that work with runSliced and swaps them in whole); the load resolves once
 *  every reader's promise has settled. Returns an unsubscribe function. */
export function onSdnList(fn) { listeners.add(fn); return () => listeners.delete(fn); }

// The export is tens of megabytes: decoding it, or holding it as one string,
// costs loop time in proportion to its size. The response is read as the
// stream delivers it, decoded at most DECODE_SLICE_BYTES per call, and each
// complete <sdnEntry> is read out of a small rolling buffer with the same
// readSdnEntry as the string parser; a turn is yielded once SDN_PARSE_SLICE_MS
// of work has run. Returns { parsed, chars } or throws past maxChars.
const DECODE_SLICE_BYTES = 1 << 20;
const OPEN = "<sdnEntry>", CLOSE = "</sdnEntry>";
// The longest real entry is a few KB; the header element is under 64 chars.
export const SDN_ENTRY_MAX_CHARS = 1 << 20;
const HEAD_KEEP = 256;
async function parseSdnResponse(res, maxChars) {
  if (!res.body || typeof res.body.getReader !== "function") {
    const xml = await res.text();
    if (xml.length > maxChars) throw new Error(`export is ${xml.length} bytes, over the ${maxChars} cap`);
    return { parsed: await parseSdnXmlAsync(xml), chars: xml.length };
  }
  const reader = res.body.getReader();
  const decoder = new TextDecoder("utf-8");
  const acc = { entries: [], digitalCurrencyIds: 0 };
  let buf = "", chars = 0, publishDate = null;
  // The first slice yields at once: started from the caller's turn, it would
  // otherwise share one loop pass with the next slice.
  let until = 0;
  const due = async () => {
    if (performance.now() >= until) { await new Promise((r) => setImmediate(r)); until = performance.now() + SDN_PARSE_SLICE_MS; }
  };
  const drain = async () => {
    if (publishDate === null) { const pd = /<Publish_Date>([^<]*)<\/Publish_Date>/.exec(buf); if (pd) publishDate = detach(pd[1].trim()); }
    let from = 0;
    for (;;) {
      const a = buf.indexOf(OPEN, from);
      // Keep a tail long enough for a split <sdnEntry> tag, and, until the
      // header is read, for a split <Publish_Date> element.
      if (a < 0) { from = Math.max(from, buf.length - (publishDate === null ? HEAD_KEEP : OPEN.length)); break; }
      const b = buf.indexOf(CLOSE, a + OPEN.length);
      if (b < 0) {
        // An entry this long is not an SDN entry: a malformed export would
        // otherwise make every chunk rescan a growing buffer.
        if (buf.length - a > SDN_ENTRY_MAX_CHARS) throw new Error(`an entry runs past ${SDN_ENTRY_MAX_CHARS} characters; treated as a malformed export`);
        from = a; break;
      }
      readSdnEntry(buf.slice(a + OPEN.length, b), acc);
      from = b + CLOSE.length;
      await due();
    }
    buf = buf.slice(from);
  };
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    for (let off = 0; off < value.byteLength; off += DECODE_SLICE_BYTES) {
      const part = decoder.decode(value.subarray(off, Math.min(value.byteLength, off + DECODE_SLICE_BYTES)), { stream: true });
      chars += part.length;
      if (chars > maxChars) { try { await reader.cancel(); } catch { /* already closed */ } throw new Error(`export is over the ${maxChars} cap`); }
      buf += part;
      await drain();
    }
  }
  buf += decoder.decode();
  await drain();
  return { parsed: { entries: acc.entries, digitalCurrencyIds: acc.digitalCurrencyIds, publishDate }, chars };
}

/** The SDN list, from memory when fetched within `maxAgeMs`, else fetched
 *  (one fetch in flight at a time; a caller arriving mid-fetch joins it).
 *  Throws on a failed fetch, an oversize body or an implausible parse. */
export async function loadSdnList({ maxAgeMs = 0, fetchImpl = globalThis.fetch, now = () => Date.now() } = {}) {
  if (held && maxAgeMs > 0 && now() - held.fetchedAt < maxAgeMs) return held;
  if (inFlight) return inFlight;
  inFlight = (async () => {
    const res = await fetchImpl(sdnListUrl(), { headers: { accept: "application/xml, text/xml" }, redirect: "follow", signal: AbortSignal.timeout(sdnFetchTimeoutMs()) });
    if (!res.ok) throw new Error(`fetch answered HTTP ${res.status}`);
    const { parsed, chars } = await parseSdnResponse(res, SDN_MAX_BYTES);
    // A parse that yields nothing is a FORMAT CHANGE, not an empty list:
    // serving "no match" off it would make every screen read as clean.
    if (!parsed.entries.length) throw new Error("parsed to zero entries; treated as a format change, not an empty list");
    if (!parsed.entries.some((e) => e.addresses.length)) throw new Error(`parsed to zero digital currency addresses (${parsed.entries.length} entries); treated as a format change`);
    held = { ...parsed, fetchedAt: now(), bytes: chars };
    const list = held;
    const refused = (e) => console.warn(`[ofac-sdn] a reader refused the new list: ${String(e?.message || e).slice(0, 120)}`);
    // Each reader starts on a turn after the parse's last one, and the load
    // resolves once every reader has adopted (or refused) the list.
    await Promise.all([...listeners].map((fn) => new Promise((resolve) => setImmediate(resolve)).then(() => fn(list)).catch(refused)));
    return list;
  })();
  try { return await inFlight; } finally { inFlight = null; }
}

/** Test seam: forget the held parse. */
export function __resetSdnListForTests() { held = null; inFlight = null; }
/** Test seam: hold a parse (with its fetchedAt) as if it had been fetched. */
export function __holdSdnListForTests(list) { held = list; inFlight = null; }

// Operator heap read (/__operator/heap.json `stores`).
registerMemoryStore("ofac-sdn.held", () => held, { note: "last good list" });
export { parseSdnResponse as __parseSdnResponseForTests };
