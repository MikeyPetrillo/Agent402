#!/usr/bin/env node
// Selling prepaid credits creates a held balance kept against future
// redemption, so sales are OFF unless CREDITS_SALES is explicitly on.
//
// REDEMPTION IS NOT GATED, and that is the point of the test. Existing keys
// must keep spending their balance, or turning sales off would strand money
// that is already out there. This pins both halves.
import "./lib/offline-stores.js"; // per-process and file backends whatever the caller exports (see the file)
import { readFileSync } from "node:fs";
import { bootServer } from "./lib/boot-server.js";
import { ownStoreEnv } from "./lib/own-stores.js";

let B = "";
let pass = 0, srv = null;
const booted = [];
const bootErrors = [];
const log = () => [...booted.flatMap((s) => s.log().split("\n").filter(Boolean)), ...bootErrors];
const fail = (m) => { console.error(`FAIL - ${m}`); for (const l of log().slice(-20)) console.error("  server:", l); srv?.child.kill("SIGKILL"); process.exit(1); };
const ok = (c, m) => { c ? (pass++, console.log("ok -", m)) : fail(m); };

// Every surface that names a credits key a caller may hold reads the switch:
// "a key already issued" while sales are off, any key while they are on.
// Each entry is [surface, text, the phrase there with sales off, with sales on].
async function rpc(method, params) {
  const res = await fetch(`${B}/mcp`, { method: "POST", headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) });
  const t = await res.text();
  return (res.headers.get("content-type") || "").startsWith("text/event-stream") ? JSON.parse(t.split("\n").filter((l) => l.startsWith("data:")).map((l) => l.slice(5).trim()).join("")) : JSON.parse(t);
}
const callText = async (name, args) => JSON.stringify((await rpc("tools/call", { name, arguments: args }))?.result || {});
async function keySurfaces() {
  const get = (path) => fetch(`${B}${path}`).then((r) => r.text());
  const llms = await get("/llms-full.txt"), skill = await get("/skill.md"), pricing = await get("/pricing"), howToPay = await get("/how-to-pay");
  const search = await callText("catalog.search", { query: "whois domain", limit: 30 });
  const find = await callText("catalog.find", { task: "look up the whois record of a domain" });
  const describe = await callText("server.describe", {});
  return [
    ["llms-full.txt skip-the-signature line", llms, "A prepaid credits key already issued also skips the per-call signature.", "A prepaid credits key also skips the per-call signature."],
    ["llms-full.txt npm package line", llms, "for a prepaid credits key already issued)", "`AGENT402_CREDITS_KEY` for a prepaid credits key)"],
    ["SKILL.md description", skill, "or with a prepaid credits key already issued (Bearer a402_...)", "or with a prepaid credits key (Bearer a402_...)"],
    ["SKILL.md body", skill, "a prepaid credits key already issued also works", "a prepaid credits key also works"],
    ["/pricing gateway note", pricing, "A credits key already issued also works as the API key.", ">A credits key also works as the API key."],
    ["/how-to-pay install lines", howToPay, "# a credits key already issued works there too", "# a credits key works there too"],
    ["MCP catalog.search access", search, "or a prepaid credits key already issued as AGENT402_CREDITS_KEY", "or a prepaid credits key as AGENT402_CREDITS_KEY"],
    ["MCP catalog.find usage", find, "a prepaid credits key already issued).", "(a wallet, or a prepaid credits key)."],
    ["MCP server.describe paidAccess", describe, "or a prepaid credits key already issued (AGENT402_CREDITS_KEY), or any x402 HTTP client", "or a prepaid credits key (AGENT402_CREDITS_KEY), or any x402 HTTP client"],
  ];
}

// Both boots share one set of file stores, as they shared one before.
const STORES = ownStoreEnv("credits-sales-gate");
const boot = async (env) => {
  try {
    srv = await bootServer({ stores: false, timeoutMs: 60_000, env: { ...STORES, FREE_MODE: "true", STRIPE_SECRET_KEY: "sk_test_x",
      X402_INDEX_CRAWL: "off", MPP_INDEX_CRAWL: "off", MONITOR_SCHEDULER: "off",
      FREE_ALERTS: "off", FOLLOWUPS: "off", X402_SYNC_ON_START: "false", ...env } });
  } catch (e) { bootErrors.push(...e.message.split("\n")); return false; }
  booted.push(srv);
  B = srv.url;
  return true;
};

// The flagship tool descriptions are clipped before this line can show, so
// their source is read: no surface module types the off-state phrase bare.
{
  for (const f of ["src/mcp-http.js", "src/seo.js", "src/skill-md.js", "src/ledger-pricing.js", "src/how-to-pay.js"]) {
    const src = readFileSync(new URL(`../${f}`, import.meta.url), "utf8");
    ok(!/credits key already issued/.test(src), `${f} names "a credits key already issued" only through creditsKeyQualifier()`);
  }
}

// --- the copy that cannot read the switch ----------------------------------
// The README and the published packages are static text: they cannot ask
// creditsSalesEnabled(), so they may describe an issued key and must not offer
// credits for sale or point a reader at the credits page to get one.
{
  const { packageDirs, shippedFiles, ROOT } = await import("./lib/shipped-files.js");
  const { join, relative } = await import("node:path");
  const OFFERS = [
    [/^#+ (?!.*(?:already issued|not on sale)).*prepaid credits/im, "a heading that sells credits"],
    [/credits keys?: https?:\/\/\S*\/credits/i, "a pointer to the credits page to obtain a key"],
    [/\bbuy (prepaid )?credits\b/i, "an invitation to buy credits"],
    [/\btop up (your )?credits\b/i, "an invitation to top up credits"],
    [/\bcredits? packs?\b/i, "a credit pack on offer"],
    // A key is "already issued"; "paid by card" offers the purchase the
    // switch may have closed.
    [/\bpaid by card or USDC\b/i, "card payment for a tool call"],
  ];
  // "Card credits", bare or as a key, names the purchase. A shipped package
  // cannot read the switch, so its code and docs describe the key they hold
  // (a "credits key"); a line that says the key is issued describes rather
  // than sells. (The root README's module map names the server's own credits
  // module and is not package copy.)
  const PACKAGE_OFFERS = [
    ...OFFERS,
    [/^(?!.*\bissued\b).*\bcard[ -]credits\b/im, "credits described as a card purchase"],
  ];
  const isText = (f) => /\.(md|js|ts|py|json)$/.test(f);
  const packageFiles = packageDirs().flatMap(shippedFiles).filter(isText);
  // The ecosystem-listing copy (docs/) and the wiki source (wiki/) are static
  // text too, read from GitHub and the listing sites: held to the package
  // rules, so a key is described as sold or issued, never as a card purchase.
  const { walk } = await import("./lib/shipped-files.js");
  const docFiles = ["docs", "wiki"].flatMap((d) => walk(join(ROOT, d))).filter(isText);
  const files = [join(ROOT, "README.md"), ...packageFiles, ...docFiles];
  ok(files.length >= 30, `credits copy: ${files.length} static surfaces read (README + shipped package files + docs and wiki)`);
  ok(docFiles.length >= 20 && docFiles.some((f) => /\/wiki\/MCP-Connector\.md$/.test(f)) && docFiles.some((f) => /\/docs\/ecosystem-listings\.md$/.test(f)), `the scan covers docs/ and wiki/ (${docFiles.length} files)`);
  const scanWith = (rules) => (text) => rules.filter(([re]) => re.test(text)).map(([, why]) => why);
  const scan = scanWith(OFFERS), scanPackage = scanWith(PACKAGE_OFFERS);
  ok(scan("## For humans: reports, monitors and prepaid credits\n(credits keys: https://agent402.tools/credits)").length === 2, "control: the retired heading and key pointer are both reported");
  ok(scan("## Prepaid credits (keys already issued)\n\nPrepaid credits: not on sale. A key already issued keeps working.").length === 0, "control: describing an issued key is not an offer");
  ok(scan("models at a flat per-call price, paid by card or USDC.").length === 1, "control: a package that sells the card path is reported");
  ok(scanPackage("each call is paid from the prepaid card credits key (AGENT402_CREDITS_KEY)").length === 1 && scanPackage("how: \"prepaid card credits (Authorization: Bearer a402_...)\"").length === 1, "control: a package describing credits as a card purchase is reported");
  ok(scanPackage("Payment mode: card credits.").length === 1 && scanPackage("agent402PaymentMode === \"card-credits\"").length === 1, "control: the bare payment-mode word, with a space or a hyphen, is reported");
  ok(scanPackage("a card credits key already issued keeps working\nprepaid credits: a key already issued\na prepaid card-credits key issued at the credits page").length === 0, "control: a line that says the key is issued is not an offer");
  ok(packageFiles.some((f) => /\/mcp\/index\.js$/.test(f)) && packageFiles.some((f) => /\/adapters\/eliza\/index\.js$/.test(f)) && packageFiles.some((f) => /\/client\/index\.js$/.test(f)), "the package scan covers the mcp, adapter and client code");
  const hits = files.flatMap((f) => (packageFiles.includes(f) || docFiles.includes(f) ? scanPackage : scan)(readFileSync(f, "utf8")).map((why) => `${relative(ROOT, f)}: ${why}`));
  ok(hits.length === 0, `no static surface offers credits for sale${hits.length ? `:\n    ${hits.join("\n    ")}` : ""}`);
}

try {
  // --- default: a host that sets nothing is in the SAFE state, not the exposed one
  ok(await boot({}), "server booted with CREDITS_SALES unset");
  const off = await fetch(`${B}/api/credits/checkout`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ pack: "credits-20" }) });
  ok(off.status === 503, `selling is refused by default (got ${off.status})`);
  const body = await off.json().catch(() => ({}));
  ok(/not on sale/i.test(String(body.error || "")), "and the refusal says sales are off rather than reading as a misconfiguration");

  for (const [where, text, offPhrase, onPhrase] of await keySurfaces()) ok(text.includes(offPhrase) && !text.includes(onPhrase), `${where} names only a key already issued while sales are off`);

  const rvOff = await fetch(`${B}/api/credits/revoke`, { method: "POST", headers: { authorization: `Bearer a402_ck_${"R".repeat(43)}` } });
  ok(rvOff.status === 200 && (await rvOff.json()).status === "received", "a key can be revoked while sales are off");
  // redemption must survive: a 404 here would mean an existing key was stranded
  ok((await fetch(`${B}/api/credits/balance`)).status !== 404, "the balance route still exists, so an existing key can still be read");
  ok((await fetch(`${B}/api/credits/claim?session=x`)).status !== 404, "the claim route still exists");
  // Refund on request is part of the on-sale terms: with sales off the route
  // answers exactly as a path this server does not serve.
  const refundOff = await fetch(`${B}/api/credits/refund`, { method: "POST", headers: { authorization: `Bearer a402_${"q".repeat(40)}` } });
  const noRoute = await fetch(`${B}/api/credits/no-such-route`, { method: "POST" });
  ok(refundOff.status === 404 && refundOff.status === noRoute.status, `the refund route is not served while sales are off (got ${refundOff.status}, an unserved path ${noRoute.status})`);

  // The machine and page surfaces follow the same switch. /api/pricing used to
  // advertise packs and a checkout body that this server answers 503 to, and
  // /credits carried an InStock Offer and a "Buy $20" snippet while refusing.
  const pricingOff = await (await fetch(`${B}/api/pricing`)).json();
  ok(pricingOff.credits && pricingOff.credits.onSale === false, "/api/pricing says credits are not on sale");
  ok(!pricingOff.credits.checkout && !pricingOff.credits.packs && !pricingOff.credits.buy && !pricingOff.credits.refund && !("balanceMaxUsd" in pricingOff.credits), "...and offers no packs, buy link, checkout body, refund route or cap");
  ok(/already issued/.test(String(pricingOff.credits.how)) && /balance/.test(String(pricingOff.credits.balance)), "...and still tells an existing key holder how to spend and read it");
  const pageOff = await (await fetch(`${B}/credits`)).text();
  ok(!/InStock/.test(pageOff) && !/Buy \$20/.test(pageOff) && !/data-pack-buy/.test(pageOff), "/credits carries no Offer, buy snippet or buy button while sales are off");
  ok(!/Buy \$5 of credits|Buy \$10 of credits/.test(pageOff) && !/\$5, \$10/.test(pageOff), "/credits offers no starter pack while sales are off");
  const ogOff = await (await fetch(`${B}/og/credits.svg`)).text();
  ok(/not on sale/.test(ogOff) && !/\$5, \$10/.test(ogOff), "the credits share card names no pack while sales are off");
  const descOf = (html) => (html.match(/<meta name="description" content="([^"]*)"/) || [])[1] || "";
  // /terms states whether credits are sold, read from the same switch: the
  // credits clause and the access line both follow it.
  const termsCredits = async () => {
    const res = await fetch(`${B}/terms`);
    const html = await res.text();
    const clause = (html.match(/<li><b>Prepaid credits:<\/b>([\s\S]*?)<\/li>/) || [])[1] || "";
    // The access line, found by its stable sentence (its opening words follow the switch).
    const access = (html.match(/<li>((?:(?!<li>)[\s\S])*?Access is by paying per call[\s\S]*?)<\/li>/) || [])[1] || "";
    return { status: res.status, clause, access };
  };
  const OFFERS_CREDITS = /\b(?:are|is) sold\b|\bbuy\b|\bpurchase\b|href="\/credits"/i;
  const NOT_SOLD = /\bnot (?:currently|now)? ?(?:sold|on sale)\b/i;
  const tOff = await termsCredits();
  ok(tOff.status === 200 && tOff.clause.length > 100 && tOff.access.length > 100, "/terms renders its credits clause and access line while sales are off");
  ok(NOT_SOLD.test(tOff.clause) && /keys? already issued keeps? working/i.test(tOff.clause), `/terms says credits are not currently sold and issued keys keep working ("${(tOff.clause.match(/[^.]*not currently sold[^.]*\./i) || [""])[0].trim()}")`);
  ok(!OFFERS_CREDITS.test(tOff.clause.replace(/Credits are not money[\s\S]*$/, "")), "/terms offers no credits purchase and no link to buy them while sales are off");
  ok(/Stripe Checkout, for reports and monitors\)/.test(tOff.access) && !/prepaid credits/i.test(tOff.access), "/terms access line names card for reports and monitors only while sales are off");
  ok(/not on sale/.test(descOf(pageOff)) && !/Buy \$/.test(descOf(pageOff)), `/credits describes itself as closed while sales are off ("${descOf(pageOff).slice(0, 40)}...")`);
  // A closed product is kept out of search: no sitemap slot, noindex on the
  // page, while the page itself still answers 200 for key holders.
  const robotsMeta = (html) => (html.match(/<meta name="robots" content="([^"]*)"/) || [])[1] || "";
  ok((await fetch(`${B}/credits`)).status === 200, "/credits still answers 200 while sales are off");
  ok(/noindex/.test(robotsMeta(pageOff)) && /(^|[ ,])follow/.test(robotsMeta(pageOff)), `/credits is noindex, follow while sales are off (got "${robotsMeta(pageOff)}")`);
  for (const path of ["/sitemap.xml", "/sitemap-pages.xml"]) {
    const xml = await (await fetch(`${B}${path}`)).text();
    ok(/<loc>/.test(xml) && !/\/credits<\/loc>/.test(xml), `${path} does not list /credits while sales are off`);
  }
  srv?.child.kill("SIGKILL");

  // --- explicitly on: selling works again, so this is a switch and not a deletion
  // The daily purchase limit is wide here so every pack is on offer (a pack
  // above it is not; scripts/test-credits-terms.js).
  const OP = `op-${process.pid}-sales-gate-token`;
  ok(await boot({ CREDITS_SALES: "on", CREDITS_DAILY_MAX_USD: "1000", AGENT402_OPERATOR_TOKEN: OP }), "server booted with CREDITS_SALES=on");
  // The operator's dispute review: listed on the credits view, and recorded
  // only for a dispute that waits on a person.
  {
    const opH = { "content-type": "application/json", "x-operator-token": OP };
    const view = await (await fetch(`${B}/__operator/credits.json`, { headers: opH })).json().catch(() => ({}));
    ok(Array.isArray(view.disputesToReview), "/__operator/credits.json lists the disputes waiting on a person");
    const post = (body) => fetch(`${B}/__operator/credits/dispute-reviewed`, { method: "POST", headers: opH, body: JSON.stringify(body) });
    ok((await post({ keyId: "0123456789ab", paymentIntent: "pi_x", outcome: "maybe" })).status === 400, "a review outcome other than won or lost is refused");
    ok((await post({ keyId: "0123456789ab", paymentIntent: "pi_none", outcome: "lost" })).status === 404, "a review of a dispute that waits on nobody records nothing");
    ok((await fetch(`${B}/__operator/credits/dispute-reviewed`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" })).status === 404, "without the operator token the route is not there");
  }
  const on = await fetch(`${B}/api/credits/checkout`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ pack: "credits-20" }) });
  const onBody = await on.json().catch(() => ({}));
  ok(on.status === 401 && /\/credits\/account$/.test(String(onBody.signIn)) && /\/credits\/account\/buy$/.test(String(onBody.buy?.url)), `selling is reachable when explicitly enabled, signed in: the API checkout points at the balance page (got ${on.status})`);
  const pricingOn = await (await fetch(`${B}/api/pricing`)).json();
  ok(pricingOn.credits?.onSale === true && pricingOn.credits.checkout?.method === "POST", "/api/pricing advertises the checkout when sales are on");
  ok(pricingOn.credits.balanceMaxUsd === 100 && pricingOn.credits.expires === false && pricingOn.credits.feesUsd === 0 && /\/api\/credits\/refund$/.test(pricingOn.credits.refund?.url) && pricingOn.credits.packs.every((p) => p.priceUsd <= pricingOn.credits.balanceMaxUsd), "/api/pricing states the cap, no expiry, no fees and the refund route, and every pack is within the cap");
  for (const [where, text, offPhrase, onPhrase] of await keySurfaces()) ok(text.includes(onPhrase) && !text.includes(offPhrase), `${where} names any credits key while sales are on`);
  const refundOn = await fetch(`${B}/api/credits/refund`, { method: "POST" });
  const refundOnBad = await fetch(`${B}/api/credits/refund`, { method: "POST", headers: { authorization: `Bearer a402_${"q".repeat(40)}` } });
  ok(refundOn.status === 401 && refundOnBad.status === 401 && (await refundOnBad.json()).status === "unknown", `the refund route is served when sales are on and refuses a missing or unknown key (${refundOn.status}, ${refundOnBad.status})`);
  // Refund requests count on their own limiter: a holder resending one never
  // uses up the same address's checkout budget.
  let refund429 = null;
  for (let i = 0; i < 12 && !refund429; i++) {
    const r = await fetch(`${B}/api/credits/refund`, { method: "POST", headers: { authorization: `Bearer a402_${"q".repeat(40)}` } });
    if (r.status === 429) refund429 = { retryAfter: r.headers.get("retry-after"), body: await r.json() };
  }
  ok(refund429 && Number(refund429.retryAfter) > 0 && refund429.body.status === "rate_limited", `repeated refund requests are limited with a status and Retry-After (${refund429?.retryAfter})`);
  const buyAfter = await fetch(`${B}/api/credits/checkout`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ pack: "credits-20" }) });
  ok(buyAfter.status !== 429, `a purchase from the same address is not limited by those refund requests (got ${buyAfter.status})`);
  const pageOnRes = await fetch(`${B}/credits`);
  const pageOn = await pageOnRes.text();
  ok(pageOnRes.status === 200 && !/noindex/.test(robotsMeta(pageOn)), `/credits is 200 and indexable when sales are on (got "${robotsMeta(pageOn)}")`);
  ok(!/not on sale/.test(descOf(pageOn)) && /\$20/.test(descOf(pageOn)), `/credits describes the purchase when sales are on ("${descOf(pageOn).slice(0, 40)}...")`);
  // The starter packs, read from the pack table on every surface that sells.
  const { CREDIT_PACKS } = await import("../src/credits.js");
  const dollars = Object.values(CREDIT_PACKS).map((p) => `$${p.cents / 100}`);
  ok(dollars[0] === "$5" && dollars[1] === "$10", "the pack table starts with the $5 and $10 starter packs");
  ok(/^Buy \$5, \$10, \$20, \$50 or \$100 by card/.test(descOf(pageOn)), `/credits description lists every pack, starters first ("${descOf(pageOn).slice(0, 50)}...")`);
  for (const [key, p] of Object.entries(CREDIT_PACKS)) ok(pageOn.includes(`data-pack-buy="${key}"`) && pageOn.includes(`Buy $${p.cents / 100} of credits`) && pageOn.includes(p.note), `/credits sells the ${key} pack with its own note`);
  const lds = [...pageOn.matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g)].flatMap((m) => { try { const j = JSON.parse(m[1]); return Array.isArray(j["@graph"]) ? j["@graph"] : [j]; } catch { return []; } });
  const offers = lds.find((j) => j && j["@type"] === "Product" && Array.isArray(j.offers)) || {};
  ok(Array.isArray(offers.offers) && offers.offers.map((o) => o.price).join() === "5.00,10.00,20.00,50.00,100.00", "the /credits structured data offers every pack at its table price");
  ok(pricingOn.credits.packs.map((p) => `${p.pack}:${p.priceUsd}`).join() === "credits-5:5,credits-10:10,credits-20:20,credits-50:50,credits-100:100" && pricingOn.credits.checkout.body.pack === "credits-5", "/api/pricing lists the starter packs and its example checkout body names the smallest");
  const ogOn = await (await fetch(`${B}/og/credits.svg`)).text();
  ok(/\$5, \$10, \$20, \$50 or \$100\./.test(ogOn), "the credits share card lists every pack, starters first, while sales are on");
  const starter = await fetch(`${B}/credits/account/buy`, { method: "POST", headers: { "content-type": "application/json", "sec-fetch-site": "same-origin" }, body: JSON.stringify({ pack: "credits-5" }) });
  ok(starter.status === 401, `a starter pack purchase needs a signed-in balance page first (got ${starter.status})`);
  ok(/\/credits\/account\/buy$/.test(String(pricingOn.credits.checkout.url)) && /\/credits\/account$/.test(String(pricingOn.credits.checkout.signIn)), "/api/pricing names the signed-in purchase route");
  for (const path of ["/sitemap.xml", "/sitemap-pages.xml"]) {
    const xml = await (await fetch(`${B}${path}`)).text();
    ok(/\/credits<\/loc>/.test(xml), `${path} lists /credits when sales are on`);
  }
  const tOn = await termsCredits();
  ok(tOn.status === 200 && tOn.clause.length > 100, "/terms renders its credits clause when sales are on");
  ok(/\bsold by card\b/i.test(tOn.clause) && /href="\/credits"/.test(tOn.clause) && !NOT_SOLD.test(tOn.clause), "/terms offers credits by card at /credits, and does not say they are not sold, when sales are on");
  ok(/Stripe Checkout, for reports and monitors, and for prepaid credits\)/.test(tOn.access), "/terms access line names card for prepaid credits when sales are on");
  ok(/POST \/api\/credits\/refund/.test(pageOn) && /No fees/.test(pageOn) && /refunded on request/.test(pageOn), "/credits states the refund route and no fees when sales are on");
  ok(!/api\/credits\/refund/.test(pageOff) && !/No fees/.test(pageOff), "/credits offers neither while sales are off");

  // A key never travels in a URL, and never reaches the server's log.
  const leaked = `a402_ck_${"Q".repeat(43)}`;
  const inUrl = await fetch(`${B}/api/credits/balance?key=${leaked}`);
  const inUrlBody = await inUrl.json().catch(() => ({}));
  ok(inUrl.status === 400 && inUrlBody.reason === "key_in_url" && !JSON.stringify(inUrlBody).includes(leaked), "a key in a URL is refused, and the answer does not repeat it");
  await fetch(`${B}/api/hash`, { method: "POST", headers: { authorization: `Bearer ${leaked}`, "content-type": "application/json" }, body: "{}" });
  await fetch(`${B}/api/credits/balance`, { headers: { authorization: `Bearer ${leaked}` } });
  ok(!log().join("\n").includes(leaked.slice(8)), "no key sent in a URL or a header reaches the server's log");
  // Revoke by key: one answer for every key, with sales on or off.
  const rvA = await (await fetch(`${B}/api/credits/revoke`, { method: "POST", headers: { authorization: `Bearer ${leaked}` } })).json();
  const rvB = await (await fetch(`${B}/api/credits/revoke`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ key: "not-a-key" }) })).json();
  ok(rvA.status === "received" && JSON.stringify(rvA) === JSON.stringify(rvB), "revoking by key answers the same for any key");

  // the gate must be read at call time, never latched at boot
  const src = readFileSync(new URL("../src/server.js", import.meta.url), "utf8");
  ok(/if \(!creditsSalesEnabled\(\)\) return res\.status\(503\)/.test(src), "the check runs inside the handler, before Stripe is touched");

  console.log(`\n${pass} passed, 0 failed`);
} finally { srv?.child.kill("SIGKILL"); }
