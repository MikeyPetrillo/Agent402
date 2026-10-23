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

export const SDN_LIST_DEFAULT_URL = "https://sanctionslistservice.ofac.treas.gov/api/PublicationPreview/exports/SDN.XML";
export const SDN_MAX_BYTES = 96 * 1024 * 1024; // the export is ~30 MB; far past that is a surprise worth refusing
const EVM_RE = /^0x[0-9a-fA-F]{40}$/;

const envMs = (k, d, min = 1) => { const n = Number(process.env[k]); return Number.isFinite(n) && n >= min ? n : d; };
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
  const text = String(xml || "");
  const entries = [];
  let digitalCurrencyIds = 0;
  for (const m of text.matchAll(/<sdnEntry>([\s\S]*?)<\/sdnEntry>/g)) {
    const block = m[1];
    const programs = [];
    const pl = /<programList>([\s\S]*?)<\/programList>/.exec(block);
    if (pl) for (const p of pl[1].matchAll(/<program>([\s\S]*?)<\/program>/g)) { const v = decodeXml(p[1]); if (v) programs.push(v); }
    const addresses = [];
    const il = /<idList>([\s\S]*?)<\/idList>/.exec(block);
    if (il) for (const idm of il[1].matchAll(/<id>([\s\S]*?)<\/id>/g)) {
      const type = tag(idm[1], "idType");
      const t = type ? CURRENCY_RE.exec(type) : null;
      if (!t) continue;
      digitalCurrencyIds++;
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
    if (!uid || !lastName) continue;
    const firstName = tag(own, "firstName") || null;
    entries.push({ uid, lastName, firstName, name: firstName ? `${lastName}, ${firstName}` : lastName, sdnType: tag(own, "sdnType") || null, programs, addresses });
  }
  const pd = /<Publish_Date>([^<]*)<\/Publish_Date>/.exec(text);
  return { entries, digitalCurrencyIds, publishDate: pd ? detach(pd[1].trim()) : null };
}

/** The EVM-format addresses of a parse (0x + 40 hex, under any asset ticker),
 *  lowercased, with distinct-address counts per ticker. */
export function sdnEvmAddresses(parsed) {
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
 *  timer. Returns an unsubscribe function. */
export function onSdnList(fn) { listeners.add(fn); return () => listeners.delete(fn); }

/** The SDN list, from memory when fetched within `maxAgeMs`, else fetched
 *  (one fetch in flight at a time; a caller arriving mid-fetch joins it).
 *  Throws on a failed fetch, an oversize body or an implausible parse. */
export async function loadSdnList({ maxAgeMs = 0, fetchImpl = globalThis.fetch, now = () => Date.now() } = {}) {
  if (held && maxAgeMs > 0 && now() - held.fetchedAt < maxAgeMs) return held;
  if (inFlight) return inFlight;
  inFlight = (async () => {
    const res = await fetchImpl(sdnListUrl(), { headers: { accept: "application/xml, text/xml" }, redirect: "follow", signal: AbortSignal.timeout(sdnFetchTimeoutMs()) });
    if (!res.ok) throw new Error(`fetch answered HTTP ${res.status}`);
    const xml = await res.text();
    if (xml.length > SDN_MAX_BYTES) throw new Error(`export is ${xml.length} bytes, over the ${SDN_MAX_BYTES} cap`);
    const parsed = parseSdnXml(xml);
    // A parse that yields nothing is a FORMAT CHANGE, not an empty list:
    // serving "no match" off it would make every screen read as clean.
    if (!parsed.entries.length) throw new Error("parsed to zero entries; treated as a format change, not an empty list");
    if (!parsed.entries.some((e) => e.addresses.length)) throw new Error(`parsed to zero digital currency addresses (${parsed.entries.length} entries); treated as a format change`);
    held = { ...parsed, fetchedAt: now(), bytes: xml.length };
    for (const fn of listeners) { try { fn(held); } catch (e) { console.warn(`[ofac-sdn] a reader refused the new list: ${String(e?.message || e).slice(0, 120)}`); } }
    return held;
  })();
  try { return await inFlight; } finally { inFlight = null; }
}

/** Test seam: forget the held parse. */
export function __resetSdnListForTests() { held = null; inFlight = null; }

// Operator heap read (/__operator/heap.json `stores`).
registerMemoryStore("ofac-sdn.held", () => held, { note: "last good list" });
