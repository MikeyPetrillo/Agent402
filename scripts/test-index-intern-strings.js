// The index cache interns short strings in every entry it stores (src/x402-index.js,
// IndexCache.set): a value repeated across sellers' tools is held once. This
// pins that the stored values are unchanged, that a repeated short value adds
// one interned string however many tools carry it, that long text is left
// alone, and that a frozen object is skipped without throwing.
process.env.X402_INDEX_CRAWL = "off";
const { __testSeedCache, _internedStringCount, _cacheForTests, _internPending } = await import("../src/x402-index.js");
// Tools are interned in the background, a few milliseconds per turn.
const drained = async () => { while (_internPending()) await new Promise((r) => setImmediate(r)); };

let pass = 0, fail = 0;
const ok = (c, m) => { c ? pass++ : fail++; console.log(`${c ? "ok" : "FAIL"} - ${m}`); };

const tool = (i) => ({
  name: `Tool ${i}`, description: "x".repeat(200) + i, category: "finance", tags: ["price", "fx"],
  accepts: [{ network: "eip155:8453", asset: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913", scheme: "exact", extra: { name: "USD Coin" } }],
});
const entryA = { origin: "https://a.example", tools: [tool(1), tool(2)] };
const entryB = { origin: "https://b.example", tools: [tool(3)] };
const expectedA = JSON.parse(JSON.stringify(entryA));

const before = _internedStringCount();
__testSeedCache([["https://a.example", entryA]]);
await drained();
const afterA = _internedStringCount();
__testSeedCache([["https://b.example", entryB]]);
await drained();
const afterB = _internedStringCount();

const stored = _cacheForTests().get("https://a.example");
ok(JSON.stringify(stored) === JSON.stringify(expectedA), "a stored entry reads exactly as it was given");
ok(afterA > before, "storing an entry interns its short strings");
// entryB repeats every shared short value of entryA; only its own new short
// value ("https://b.example") may be added. Names are near unique and skipped.
ok(afterB - afterA === 1, `a second seller repeating the same short values adds only its own new ones (added ${afterB - afterA})`);
ok(stored.tools[0].description.length === 201, "long text is kept whole");

const frozen = Object.freeze({ origin: "https://c.example", tools: Object.freeze([Object.freeze(tool(4))]) });
let threw = false;
try { __testSeedCache([["https://c.example", frozen]]); } catch { threw = true; }
ok(!threw && _cacheForTests().get("https://c.example") === frozen, "a frozen entry is stored as is, without throwing");

console.log(`\n${fail ? "FAILED" : "OK"}: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
