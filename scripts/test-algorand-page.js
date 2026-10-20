// Offline unit tests for the /algorand marketplace page renderer. Fixture
// snapshot + fixture rail — no server, no network. Mirrors
// scripts/test-stellar-page.js's coverage.
import { algorandSellers, algorandTools, algorandPage } from "../src/algorand-page.js";

let pass = 0, fail = 0;
const ok = (cond, msg) => { if (cond) { pass++; console.log(`ok - ${msg}`); } else { fail++; console.error(`FAIL - ${msg}`); } };

const localTools = [
  { slug: "hash", name: "Hash", category: "encoding", price: 0.001 },
  { slug: "search", name: "Web search", category: "search", price: 0.01 },
  { slug: "stock-quote", name: "Stock quote", category: "finance", price: 0.01 },
];
const LOCAL = { origin: "self", displayName: "Agent402.Tools", homepage: "https://agent402.tools", local: true, toolCount: 3, tools: localTools };
const EXT_ALGORAND = { origin: "https://ext1.example", displayName: "Ext One", homepage: "https://ext1.example", local: false, toolCount: 4, routable: true, networks: ["algorand:wGHE2Pwdvd7S12BL5FaOP20EGYesN73ktiC1qzkkit8=", "eip155:8453"] };
const EXT_EVM = { origin: "https://ext2.example", displayName: "Ext Two", homepage: "https://ext2.example", local: false, toolCount: 2, routable: true, networks: ["eip155:8453"] };
const EXT_TESTNET = { origin: "https://ext3.example", displayName: "Ext Test", homepage: "javascript:alert(1)", local: false, toolCount: 1, routable: true, networks: ["algorand:SGO1GKSzyE7IEPItTxCByw9x8FmnrCDexi9cOUJOiI"] };

const snapBoth = { sellers: [LOCAL, EXT_ALGORAND, EXT_EVM], totals: { sellers: 3 } };
const snapOnlyUs = { sellers: [LOCAL, EXT_EVM], totals: { sellers: 2 } };

// Filter helpers
let s = algorandSellers(snapBoth);
ok(s.length === 2 && s[0].local === true && s[1].origin === "https://ext1.example",
  "algorandSellers keeps local + algorand-mainnet sellers, drops EVM-only");
ok(algorandSellers(snapOnlyUs).length === 1, "algorandSellers is 1 when only local qualifies");
ok(algorandSellers({ sellers: [LOCAL, EXT_TESTNET] }).length === 1, "testnet-only sellers excluded");
ok(algorandTools(snapBoth).length === 3 && algorandTools(snapBoth)[0].slug === "hash",
  "algorandTools returns the local catalog's tools");

// Page render — rail present
const rail = { balance: 0.042, recent: [
  { tx: "https://allo.info/tx/JZIB7WN5CLWSGJFJ7NX6UXCMJUZGUPA5DSXDKUWLTKWJ4KJWGPPQ", when: "2026-07-10T04:15:00Z", usd: 0.001, from: "ZKFACAZATPUUYUXVVVE7QWMMZTSMLGQVA4G4QKW7D2UI7FCIFE3QB2SHRE", external: false, internal: true },
] };
let html = algorandPage("https://agent402.tools", { snapshot: snapOnlyUs, rail });
ok(html.includes("Algorand x402 marketplace"), "title phrase present");
ok((html.match(/Algorand x402 marketplace/g) || []).length >= 3, "phrase appears in title, h1 and description");
ok(html.includes("allo.info/tx/JZIB7WN5CLWSGJFJ7NX6UXCMJUZGUPA5DSXDKUWLTKWJ4KJWGPPQ"), "real receipt tx link rendered");
ok(html.includes("1 seller live"), "honesty line rendered when only local seller");
ok(html.includes("network=algorand"), "machine route-filter snippet present");
ok(html.includes("application/ld+json"), "JSON-LD present");
ok(html.includes("OfferCatalog"), "OfferCatalog JSON-LD type present");
ok(html.includes('href="/stellar"') && html.includes(">stellar<"), "switcher strip cross-links to /stellar");

// Page render — rail unavailable
html = algorandPage("https://agent402.tools", { snapshot: snapOnlyUs, rail: null });
ok(html.includes("temporarily unavailable"), "rail=null renders the unavailable line");
ok(!html.includes("allo.info/tx/"), "no receipt link invented without rail");

// Two sellers → no honesty line, seller row rendered
html = algorandPage("https://agent402.tools", { snapshot: snapBoth, rail: null });
ok(!html.includes("1 seller live"), "honesty line absent with an external algorand seller");
ok(html.includes('data-host="ext1.example"'), "external algorand seller rendered as a terminal row");
ok(!html.includes("ext2.example"), "EVM-only seller not rendered");

// Sole qualifying seller is external → honesty line must not show
const snapExtOnly = { sellers: [EXT_ALGORAND], totals: { sellers: 1 } };
html = algorandPage("https://agent402.tools", { snapshot: snapExtOnly, rail: null });
ok(!html.includes("1 seller live"), "honesty line requires the sole seller to be local");

// Malicious homepage href is neutralized, never rendered raw
const EXT_EVIL = { ...EXT_ALGORAND, origin: "https://evil.example", displayName: "Evil", homepage: "javascript:alert(1)" };
html = algorandPage("https://agent402.tools", { snapshot: { sellers: [LOCAL, EXT_EVIL] }, rail: null });
ok(!/href="javascript:/.test(html) && !html.includes("javascript:alert"), "malicious homepage scheme never rendered raw, and never as an href");

// Seller health markers reflect local/routable state
html = algorandPage("https://agent402.tools", { snapshot: snapBoth, rail: null });
ok(html.includes("healthy"), "external routable seller marked healthy");
ok(html.includes("live"), "local seller marked live");

// Marketplace UI: stats strip + seller cards
html = algorandPage("https://agent402.tools", { snapshot: snapBoth, rail });
ok(html.includes("SELLERS") && html.includes("PRICE FLOOR"), "stats strip renders");
ok(html.includes("THIS HOST"), "local seller card carries the THIS HOST tag");
ok(html.includes("ext1.example"), "seller card shows the hostname");

// Self-serve form present (submit handler is external — CSP hardening, 2026-08-16)
ok(html.includes('id="list-api"') && html.includes('<script src="/js/reg-form.js"></script>'), "List your API form renders");

// Activity section: cards + bars + honesty captions
const buckets = Array.from({ length: 30 }, (_, i) => ({ date: "2026-06-" + String(11 + (i % 20)).padStart(2, "0"), tx: i === 29 ? 5 : 0, usd: i === 29 ? 0.05 : 0, buyers: i === 29 ? 2 : 0 }));
const activity = { days: 30, truncated: false, buckets, totals: { tx: 42, usd: 1.23, buyers: 7, internalTx: 5, internalUsd: 0.1 } };
html = algorandPage("https://agent402.tools", { snapshot: snapBoth, rail, activity });
ok(html.includes("TRANSACTIONS") && html.includes("VOLUME") && html.includes("BUYERS"), "activity cards render");
ok(html.includes("PAST 30 DAYS"), "activity window labeled");
ok(html.includes(">42<") && html.includes("$1.23") && html.includes(">7<"), "activity totals rendered as given, never invented");
ok(html.includes("includes 5 internal canary buys"), "internal canary honesty caption present");
ok(!html.includes("totals are a floor"), "no truncation caption when scan completed");
html = algorandPage("https://agent402.tools", { snapshot: snapBoth, rail, activity: { ...activity, truncated: true } });
ok(html.includes("totals are a floor"), "capped scan renders the floor caption");
html = algorandPage("https://agent402.tools", { snapshot: snapBoth, rail });
ok(html.includes("activity scan temporarily unavailable"), "missing activity renders the honest unavailable line");
ok(!html.includes("TRANSACTIONS"), "no zero-cards invented when the scan is unavailable");

// Per-seller activity: selection re-scopes the label, caption, and highlight
const extSel = { local: false, host: "ext1.example", name: "Ext One" };
html = algorandPage("https://agent402.tools", { snapshot: snapBoth, rail, activity, selectedSeller: extSel });
ok(html.includes("EXT1.EXAMPLE · PAST 30 DAYS"), "selected external seller scopes the activity label");
ok(html.includes("may include non-x402 transfers"), "external-wallet caption is honest about scope");
ok(!html.includes("all inbound USDC settlements to this host"), "this-host caption absent when external selected");
ok(html.includes('href="?seller=ext1.example#detail"'), "the seller's terminal row links to its detail view");
ok(/data-host="ext1\.example"[^>]*aria-current="true"/.test(html), "the selected seller's terminal row is marked current");
html = algorandPage("https://agent402.tools", { snapshot: snapBoth, rail, activity: null, selectedSeller: extSel });
ok(html.includes("no Algorand payTo advertised"), "external seller without a scannable wallet gets the honest line");
html = algorandPage("https://agent402.tools", { snapshot: snapBoth, rail, activity });
ok(html.includes("THIS HOST · PAST 30 DAYS"), "no selection defaults the activity scope to this host");

// Seller list scales: one terminal row per seller at any size
const many = { sellers: [LOCAL, ...Array.from({ length: 14 }, (_, i) => ({ ...EXT_ALGORAND, origin: "https://ext" + i + ".example", homepage: "https://ext" + i + ".example", displayName: "Ext " + i }))], totals: { sellers: 15 } };
html = algorandPage("https://agent402.tools", { snapshot: many, rail: null });
ok((html.match(/data-t-row data-host=/g) || []).length === 15, "15 sellers render as 15 terminal rows");
ok(html.includes('data-host="ext13.example"'), "the last seller is a row");
html = algorandPage("https://agent402.tools", { snapshot: snapBoth, rail: null });
ok((html.match(/data-t-row data-host=/g) || []).length === 2, "2 sellers render as 2 terminal rows, no card layout");

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
