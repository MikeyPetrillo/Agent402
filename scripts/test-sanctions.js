#!/usr/bin/env node
// Sanctions screening, and the one property that matters more than accuracy:
// a MISS MUST NEVER READ AS A CLEARANCE.
//
// Everything else here is ordinary parsing. This part is not: a caller who
// reads "no match" as "cleared to transact" has been handed a decision this
// tool cannot support - lists change without notice, the same party appears
// under many spellings, and ownership rules put entities in scope who are
// named on no list at all. So the verdict vocabulary contains no word that
// reads as permission, the caveat travels IN the payload rather than in
// documentation, and a list we could not load REFUSES rather than reporting
// an empty list as a clean result. Each of those is asserted below, and the
// last one is the one that would be catastrophic to get wrong: an empty parse
// served as "no match" makes every query on earth come back clean.
import { strict as assert } from "node:assert";
import { readFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sdnCryptoAddresses, sdnNames, lookupAddress, screenName, foldName, normalizeAddress, SANCTIONS_VERDICTS } from "../src/tools/sanctions-core.js";
import { parseSdnXml, sdnEvmAddresses, loadSdnList, SDN_MAX_BYTES, __resetSdnListForTests } from "../src/ofac-sdn.js";
// The payout map a load stores goes to a scratch file, never the shared default.
process.env.SANCTIONS_PAYOUT_FILE = join(mkdtempSync(join(tmpdir(), "sanctions-")), "payout.json");

let n = 0;
const ok = (c, m) => { assert.ok(c, m); n++; };
const eq = (a, b, m) => { assert.deepEqual(a, b, m); n++; };

// Miniature SDN.XML exports in the real format (scripts/fixtures). The sample
// has several addresses per entry, mixed assets, a non-currency id holding an
// EVM-looking value and a malformed address. The long entry carries 60
// Digital Currency Addresses on one entry: the shape SDN.CSV cut short,
// because the CSV packs them into a remarks column truncated at about a
// thousand characters.
const SAMPLE = readFileSync(new URL("./fixtures/ofac-sdn-sample.xml", import.meta.url), "utf8");
const LONG = readFileSync(new URL("./fixtures/ofac-sdn-long-entry.xml", import.meta.url), "utf8");
const XML = SAMPLE.replace("</sdnList>", LONG.slice(LONG.indexOf("<sdnEntry>"), LONG.indexOf("</sdnList>")) + "</sdnList>");

// --- parsing -----------------------------------------------------------------
{
  const list = parseSdnXml(SAMPLE);
  const addrs = sdnCryptoAddresses(list);
  eq(addrs.size, 7, "every Digital Currency Address of every asset is kept (ETH, XBT, TRX, USDT, SOL, USDC), and the Passport id is not");
  ok(addrs.has("0xnotanaddress") && !sdnEvmAddresses(list).addresses.has("0xnotanaddress"), "a currency id that is not a well-formed address is kept as listed for the exact-string tool, and stays out of the EVM set");
  const eth = addrs.get("0xbad0000000000000000000000000000000000001");
  ok(eth && eth.entity === "FIXTURE ENTITY ONE" && eth.sdnId === "900001", "a hit names the entity and its SDN uid, so the caller can check it against the published list themselves");
  eq(eth.asset, "ETH", "and the asset it was listed under");
  ok(addrs.has("1FixtureBitcoinAddressNotEvm0000001"), "a Bitcoin address is kept EXACTLY - base58 is case-sensitive and folding it would miss the match");
  eq(addrs.get("0xbad0000000000000000000000000000000000002").asset, "USDT", "an address listed under two tickers keeps its first listing");
  eq(list.entries[0].programs, ["TEST"], "the program list is read");

  const names = sdnNames(list);
  eq(names.length, 3, "every named entry is parsed");
  eq(names.map((x) => x.type), ["-0-", "-0-", "individual"], "types keep the published vocabulary: individual, vessel, aircraft, and -0- for an entity");
}

// --- the long entry: the case the CSV truncated ---------------------------------
{
  const list = parseSdnXml(LONG);
  const big = list.entries.find((e) => e.uid === "910001");
  eq(big.addresses.length, 60, "all 60 Digital Currency Address ids on one entry are read");
  const remarks = big.addresses.map((a) => `Digital Currency Address - ${a.asset} ${a.address}`).join("; alt. ");
  ok(remarks.length > 2000, `the same addresses as a CSV remarks field run ${remarks.length} characters, past the ~1,000 the CSV keeps: the fixture is the truncated case`);
  const map = sdnCryptoAddresses(list);
  const assets = new Set(big.addresses.map((a) => a.asset));
  eq([...assets].sort(), ["ARB", "BSC", "DOGE", "ETC", "ETH", "SOL", "TRX", "USDC", "USDT", "XBT", "XMR"], "every asset ticker on the entry comes through");
  const missedExact = big.addresses.filter((a) => map.get(normalizeAddress(a.address))?.sdnId !== "910001");
  eq(missedExact.length, 0, `every address on the long entry is found by an asset-less lookup, the router's (${missedExact.map((a) => a.address).join(",")})`);
  const missedHinted = big.addresses.filter((a) => lookupAddress(map, a.address, a.asset)?.sdnId !== "910001");
  eq(missedHinted.length, 0, "and by the tool's lookup with each address's own asset hint (a Tron address under USDT included)");
  const tronUsdt = big.addresses.find((a) => a.asset === "USDT" && a.address.startsWith("T"));
  ok(map.has(tronUsdt.address) && !map.has(tronUsdt.address.toLowerCase()), "a base58 address under a ticker outside CASE_SENSITIVE is stored exactly, never folded");
  const evm = sdnEvmAddresses(list);
  eq(evm.addresses.size, 24, "the EVM set holds the 24 EVM addresses of the long entry");
  ok(big.addresses.filter((a) => /^0x/.test(a.address)).every((a) => evm.addresses.has(a.address.toLowerCase())), "every one of them");
  eq(map.get("0xfeed000000000000000000000000000000000018").sdnId, "910001", "an address listed on two entries names the first");
  eq(big.programs, ["CYBER2", "RUSSIA-EO14024"], "every program on the entry");

  const names = sdnNames(list);
  ok(names.some((x) => x.id === "910001" && x.name === "FIXTURE EXCHANGE WITH MANY ADDRESSES"), "an alias's lastName never replaces the entry's own");
  ok(!names.some((x) => /ALIAS|FIXTUROFF/.test(x.name)), "aliases are not screened as names, as before");
  ok(names.some((x) => x.id === "910002" && x.name === "FIXTUROV, Ivan Fixturovich" && x.type === "individual"), "an individual reads LASTNAME, Firstname, the list's display form");
  ok(names.some((x) => x.id === "910003" && x.name === "FIXTURE JOINT STOCK COMPANY \"HOLDING\" & PARTNERS" && x.type === "-0-"), "XML entities are decoded");
  ok(names.some((x) => x.id === "910004" && x.type === "vessel"), "a vessel keeps its type");
}

// --- address normalisation ---------------------------------------------------
{
  eq(normalizeAddress("0xABCDEF0123456789012345678901234567890123"), "0xabcdef0123456789012345678901234567890123", "EVM is case-insensitive, so a checksummed address matches a lowercase listing");
  eq(normalizeAddress("1LrxsRd7zNuxPJcL5rttnoeJFyfq5HTMe4", "XBT"), "1LrxsRd7zNuxPJcL5rttnoeJFyfq5HTMe4", "a Bitcoin address is NEVER folded");
  eq(normalizeAddress("TNiq9AXBp9EjUqhDhrwrfvAA8U3GUQZH81", "TRX"), "TNiq9AXBp9EjUqhDhrwrfvAA8U3GUQZH81", "nor a Tron address");
  eq(normalizeAddress("  "), null, "blank is null, never an empty-string key that matches everything");
}

// --- name screening ----------------------------------------------------------
{
  const names = [...sdnNames(parseSdnXml(SAMPLE)), { id: "12345", name: "GAZPROMBANK JOINT STOCK COMPANY", type: "-0-" }];
  const r = screenName("Gazprombank", names);
  eq(r.matches.length, 1, "a substring of a listed name matches");
  eq(r.matches[0].matchType, "contains", "and says HOW it matched, so a reader can judge it");
  eq(screenName("Gazprombank Joint Stock", names).matches.length, 1, "corporate suffixes are folded, so a near-spelling of the same entity still lands");
  eq(screenName("zzzznotreal", names).matches, [], "an unrelated name matches nothing");
  eq(screenName("ab", names).matches, [], "a two-character query is refused rather than matching half the list");
  ok(screenName("ab", names).reason, "...and says why");
  // No fuzzy distance, on purpose.
  eq(screenName("Gazpromm", names).matches, [], "a MISSPELLING does not match: this is exact-and-substring only, because a confident near-miss on a sanctions list is a liability, not an answer. Callers who want fuzzy matching can do it on their own terms");
  eq(foldName("Gazprom Neft, PJSC"), "gazprom neft", "folding drops punctuation and corporate suffixes (PJSC/JSC/LLC/GmbH...) so a filer's own spelling still lands");
  eq(foldName("Gazprom"), "gazprom", "...and leaves an identity word alone");
  ok(foldName("Public Joint Stock Company Gazprom Neft").includes("gazprom neft"), "a long official style still contains the identity");
}

// --- THE PROPERTY THAT MATTERS ----------------------------------------------
{
  const v = JSON.stringify(SANCTIONS_VERDICTS).toLowerCase();
  for (const w of ["clean", "cleared", "clear of", "safe", "approved", "permitted", "ok to"])
    ok(!v.includes(w), `no verdict says "${w}" - a word that reads as permission is the one thing this tool must never say`);
  ok(!("clean" in SANCTIONS_VERDICTS) && !("clear" in SANCTIONS_VERDICTS), "and there is no such verdict to return");
  eq(Object.keys(SANCTIONS_VERDICTS).sort(), ["lists_unavailable", "match", "match_caveat", "no_match_on_lists_checked"], "the vocabulary is closed and each name states its own limit");
  ok(/NOT a clearance/i.test(SANCTIONS_VERDICTS.no_match_on_lists_checked), "the miss verdict says in so many words that it is not a clearance");
  ok(/lists change|spellings|ownership/i.test(SANCTIONS_VERDICTS.no_match_on_lists_checked), "...and names the specific reasons it cannot be one, rather than hedging vaguely");
  ok(/refused rather than reported as no match/i.test(SANCTIONS_VERDICTS.lists_unavailable),
     "an unavailable list REFUSES: serving 'no match' off a list that failed to load makes every query on earth come back clean, which is the worst failure available here");
}

// --- an empty parse is a format change, never an empty list ------------------
{
  const src = (await import("node:fs")).readFileSync(new URL("../src/tools/sanctions-kit.js", import.meta.url), "utf8");
  ok(/if \(!names\.length\) throw new Error/.test(src),
     "a parse yielding zero entries THROWS and keeps the previous good load - OFAC changing their export format must not silently turn every screen into a pass");
  ok(/if \(!state\.fetchedAt\) throw bad\(SANCTIONS_VERDICTS\.lists_unavailable, 503\)/.test(src),
     "and with nothing cached the handler refuses 503 rather than answering from an empty map");
  ok(/notAClearance/.test(src), "the caveat rides in every response envelope, not in documentation nobody reads");
  // ...and it is VERDICT-AWARE. The first cut emitted the miss caveat
  // unconditionally, so a match answered "this value does not appear on the
  // lists" directly under `verdict: match`. Nonsense, and worse than nonsense:
  // a field that is obviously wrong once teaches a reader to skip it, and this
  // is the field that stops a miss being read as a pass. Found by reading a
  // real response rather than the shape of one.
  ok(/envelope = \(matched\)/.test(src) && /matched\s*\?/.test(src),
     "the envelope takes the verdict and picks its caveat from it");
  ok(/envelope\(!!hit\)/.test(src) && /envelope\(r\.matches\.length > 0\)/.test(src),
     "and both handlers pass their own result, so neither can emit the other verdict's caveat");
  ok(/not a confirmed identification/i.test(SANCTIONS_VERDICTS.match_caveat),
     "a MATCH carries its own caveat: names repeat and addresses are reused, so a string match is not an identification");
}


// --- all-token matching: the false negative that prompted it ----------------
// A live buy on 2026-09-13 screened "Vladimir Putin" against a correctly loaded
// 19,388-entry SDN list and came back no_match, because OFAC stores
// "PUTIN, Vladimir Vladimirovich" and neither string contains the other. On a
// sanctions screen that is the dangerous direction to fail: the buyer reads
// no_match as clean and acts on it. The existing suite passed throughout,
// which is why these cases exist.
{
  const entries = [
    { id: "1", name: "PUTIN, Vladimir Vladimirovich" },
    { id: "2", name: "PUTINA, Olga Ivanovna" },
    { id: "3", name: "SMITH, John" },
    { id: "4", name: "GAZPROMBANK JOINT STOCK COMPANY" },
  ];
  const hit = (q) => screenName(q, entries).matches;

  eq(hit("Vladimir Putin").length, 1, "the natural name order now matches the list's comma form");
  eq(hit("Vladimir Putin")[0].matchType, "all-tokens", "and says WHICH matcher fired, so a consumer can weigh it");
  eq(hit("Vladimir Vladimirovich Putin").length, 1, "a fuller name still matches");
  eq(hit("Olga Putina").length, 1, "and it is not special-cased to one entry");

  // The promise the description makes is that this is not fuzzy. Hold it.
  eq(hit("Vladimir Smith").length, 0, "tokens from two different entries do not combine into a match");
  eq(hit("Vlad Putin").length, 0, "a partial token is not a token - no edit distance, no partial credit");
  eq(screenName("Putin", entries).matches.every((m) => m.matchType === "contains"), true,
     "a single token stays substring-only: treating one token as an all-token match would make every common surname a hit");

  // Counts stay separable so the three matchers can be audited apart.
  const r = screenName("Vladimir Putin", entries);
  eq(r.exactCount, 0, "exactCount unaffected");
  eq(r.containsCount, 0, "containsCount unaffected");
  eq(r.allTokensCount, 1, "allTokensCount reports the new matcher on its own");
}

// The published description must not still claim substring-only matching - a
// machine-readable promise that stopped being true is the false-absolutes class.
{
  const { readFileSync } = await import("node:fs");
  const src = readFileSync(new URL("../src/tools/sanctions-kit.js", import.meta.url), "utf8");
  ok(!/Matching is exact and substring only/.test(src), "the old exact-and-substring-only claim is gone");
  ok(/all-tokens/.test(src), "and the description names the third matcher");
  ok(/allTokensCount/.test(src), "the response and its published example carry the new counter");
}

// --- one public word on /api/gateway-status, driven not grepped ----------------
// An unloaded list refuses every call; a STALE one answers from an old list,
// which is the failure nothing else would notice, so the word must say "stale".
{
  const { loadSanctions, sanctionsHealth, sanctionsStatus } = await import("../src/tools/sanctions-kit.js");
  const H = 3600_000, boot = 1_000_000;
  ok(sanctionsHealth(boot + 60_000, boot).status === "loading", "never loaded inside the boot grace: loading");
  ok(sanctionsHealth(boot + 16 * 60_000, boot).status === "unloaded", "never loaded past the boot grace: unloaded");
  const t0 = boot + 20 * 60_000;
  await loadSanctions({ force: true, now: () => t0, fetchImpl: async () => new Response(XML, { status: 200 }) });
  ok(sanctionsHealth(t0 + H, boot).status === "ok", "a fresh load: ok");
  ok(sanctionsHealth(t0 + 25 * H, boot).status === "stale", "two refresh cycles without a successful load: stale");
  ok(Object.keys(sanctionsHealth(t0, boot)).join() === "status", "the public word carries no count, date or error text");
  const st = sanctionsStatus();
  ok(st.source === "SDN.XML" && st.addresses === 67 && st.entries === 7 && st.publishDate === "10/14/2026", `the operator counts read the XML load (${JSON.stringify(st)})`);
}

// --- the tools and the router's screen find every address, end to end ----------
{
  const { SANCTIONS_TOOLS, screenAddressForPayment, loadSanctions, sanctionsStatus } = await import("../src/tools/sanctions-kit.js");
  const wallet = SANCTIONS_TOOLS.find((t) => t.slug === "sanctions-wallet");
  const nameTool = SANCTIONS_TOOLS.find((t) => t.slug === "sanctions-name");
  const big = parseSdnXml(LONG).entries.find((e) => e.uid === "910001");
  let walletMiss = 0, routerMiss = 0;
  for (const a of big.addresses) {
    const r = await wallet.handler({ address: a.address });
    if (r.verdict !== "match" || r.sdnId !== "910001" || r.listedAddress !== a.address) walletMiss++;
    if ((await screenAddressForPayment(a.address))?.sdnId !== "910001") routerMiss++;
  }
  eq(walletMiss, 0, "sanctions-wallet matches every one of the 60 addresses on the long entry");
  eq(routerMiss, 0, "and so does the router's payout screen");
  const miss = await wallet.handler({ address: "0x902dCf34E53695bDEA2fFB354b1a2e58bD598256" });
  ok(miss.verdict === "no_match_on_lists_checked" && miss.notAClearance && miss.addressesOnList === 67, "an unlisted address is a miss with the caveat");
  const nm = await nameTool.handler({ name: "Fixturovich Fixturov" });
  ok(nm.verdict === "match" && nm.allTokensCount === 1 && nm.matches[0].id === "910002", "sanctions-name finds an individual by the natural name order");
  ok(Object.keys(nm).join() === "query,verdict,exactCount,containsCount,allTokensCount,matches,entriesOnList,listsChecked,listsFetchedAt,confirmBeforeActing", `sanctions-name answers the same fields (${Object.keys(nm).join()})`);
  const w = await wallet.handler({ address: big.addresses[0].address });
  ok(Object.keys(w).join() === "address,verdict,entity,sdnId,asset,listedAddress,addressesOnList,listsChecked,listsFetchedAt,confirmBeforeActing", `sanctions-wallet answers the same fields (${Object.keys(w).join()})`);

  // A broken refresh keeps the previous good load: the format guard.
  const before = sanctionsStatus().fetchedAt;
  for (const body of ["<html>not a list</html>", SAMPLE.replace(/<idList>[\s\S]*?<\/idList>/g, "")]) {
    await loadSanctions({ force: true, now: () => Date.now() + 365 * 86400_000, fetchImpl: async () => new Response(body, { status: 200 }) });
    ok(sanctionsStatus().fetchedAt === before && sanctionsStatus().addresses === 67 && /format change/.test(sanctionsStatus().lastError), `an export with no entries or no addresses is a format change; the previous load stays (${sanctionsStatus().lastError})`);
  }
}

// --- the shared loader ---------------------------------------------------------
{
  __resetSdnListForTests();
  ok(SDN_MAX_BYTES >= 64 * 1024 * 1024, "the size cap leaves headroom over the ~30 MB export");
  let fetches = 0;
  const f = async () => { fetches++; await new Promise((r) => setTimeout(r, 20)); return new Response(XML, { status: 200 }); };
  const [a, b] = await Promise.all([loadSdnList({ fetchImpl: f }), loadSdnList({ fetchImpl: f })]);
  ok(fetches === 1 && a === b, "two loads at once share one fetch");
  await loadSdnList({ maxAgeMs: 60_000, fetchImpl: f });
  ok(fetches === 1, "a load inside the caller's window takes the held parse");
  await loadSdnList({ maxAgeMs: 0, fetchImpl: f });
  ok(fetches === 2, "a load with no window fetches");
  await assert.rejects(loadSdnList({ fetchImpl: async () => new Response("x", { status: 503 }) }), /HTTP 503/); n++;
  await assert.rejects(loadSdnList({ fetchImpl: async () => new Response("<sdnList></sdnList>", { status: 200 }) }), /zero entries/); n++;
  const src = readFileSync(new URL("../src/ofac-sdn.js", import.meta.url), "utf8");
  ok(/AbortSignal\.timeout\(sdnFetchTimeoutMs\(\)\)/.test(src) && /10 \* 60_000/.test(src), "the download timeout covers a multi-minute download");
}

console.log(`test-sanctions: ${n} assertions OK`);
