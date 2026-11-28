// Routes that buy from an outside seller with our wallet are sold for a
// wallet payment only (src/third-party-routes.js): prepaid credits and card
// payments are spent only on Agent402's own services. Checks the real catalog
// definitions carry the flag and that both card-funded gates receive it.
import "./lib/offline-stores.js"; // per-process and file backends whatever the caller exports (see the file)
import { readFileSync } from "node:fs";
import { stripElements } from "./lib/html-text.js";
import { paysThirdParty } from "../src/third-party-routes.js";

let failed = 0;
const ok = (c, m) => { if (c) console.log("ok - " + m); else { failed++; console.log("FAIL - " + m); } };

const { EXEC_TIERS, buildRouteExecuteTool } = await import("../src/tools/route-execute.js");
const src = (f) => readFileSync(new URL(`../src/${f}`, import.meta.url), "utf8");

// route-execute: every tier is built by one function; the flag sits in it.
const re = src("tools/route-execute.js");
ok(EXEC_TIERS.length > 0 && typeof buildRouteExecuteTool === "function", "route-execute builds its tiers from one definition");
ok(/spendsOwnWallet: true,[\s\S]{0,200}paysThirdPartySeller: true,/.test(re), "route-execute's tier definition is flagged");
for (const [file, slug] of [["tools/seller-payability-kit.js", "seller-payability"], ["tools/decide-kit.js", "decide-execute"]]) {
  const s = src(file);
  // The definition's own line (a slug named inside a call, such as a refund
  // row's, is not the definition).
  const at = s.search(new RegExp(`\\n\\s+slug: "${slug}",\\n`));
  ok(at > 0 && /paysThirdPartySeller: true,/.test(s.slice(at, at + 1200)), `${slug} is flagged`);
}
// The flight routes buy each answer from an outside seller with our wallet: flagged too.
{
  const fl = src("tools/flights-kit.js");
  for (const slug of ["flight-search", "flight-status"]) { const at = fl.indexOf(`slug: "${slug}"`); ok(at > 0 && /paysThirdPartySeller: true,/.test(fl.slice(at, at + 600)), `${slug} is flagged`); }
}
// Network gas is an ordinary cost of our own service, not a third-party purchase.
ok(!/paysThirdPartySeller/.test(src("tools/attest-kit.js")), "attest-kit.js is not flagged");

ok(paysThirdParty({ paysThirdPartySeller: true }) === true && paysThirdParty(null) === false && paysThirdParty({ slug: "x" }) === false, "the explicit flag counts; a plain route is not in the class");
ok(paysThirdParty({ slug: "new-buyer", spendsOwnWallet: true }) === true, "a route that spends our wallet is in the class without the flag (derived, so a forgotten flag still refuses card money)");
ok(paysThirdParty({ slug: "attest", spendsOwnWallet: true }) === false, "attest's gas is a cost of our own service: the one listed exception");

// THE CLASS IS DERIVED FROM IMPORTS. Every tool kit whose imports reach
// src/external-spend-guard.js (directly, or through another kit under
// src/tools/) is read; every tool definition in it must be in the class, or
// carry a reason here. A new kit that buys with our wallet is found by its
// import, never by a name typed into this test.
{
  const { readdirSync } = await import("node:fs");
  const { toolDefObjects } = await import("./lib/tool-def-objects.js");
  const toolsDir = new URL("../src/tools/", import.meta.url);
  const files = readdirSync(toolsDir).filter((f) => f.endsWith(".js"));
  const imports = new Map(files.map((f) => [f, [...src(`tools/${f}`).matchAll(/^\s*(?:import|export)\s[^;]*?from\s+["']([^"']+)["']/gm)].map((m) => m[1])]));
  const reaches = new Map();
  const reachesGuard = (f, seen = new Set()) => {
    if (reaches.has(f)) return reaches.get(f);
    if (seen.has(f)) return false;
    seen.add(f);
    const deps = imports.get(f) || [];
    const v = deps.includes("../external-spend-guard.js") || deps.some((d) => d.startsWith("./") && files.includes(d.slice(2)) && reachesGuard(d.slice(2), seen));
    reaches.set(f, v);
    return v;
  };
  const kits = files.filter((f) => reachesGuard(f));
  // Kits whose spend is our own service's cost, not a purchase from a seller.
  const OWN_SERVICE_KITS = { "attest-kit.js": "pays network gas for our own attestation" };
  // Definitions in a buying kit that buy nothing themselves.
  const NOT_BUYING = { "decide": "sells a plan written by our planner; it buys from no seller" };
  ok(["route-execute.js", "flights-kit.js", "seller-payability-kit.js", "decide-kit.js", "attest-kit.js"].every((k) => kits.includes(k)), `the import walk finds the kits that spend our wallet (${kits.join(", ")})`);
  let defs = 0;
  for (const kit of kits) {
    if (OWN_SERVICE_KITS[kit]) continue;
    for (const o of toolDefObjects(src(`tools/${kit}`))) {
      defs++;
      // The definition's own slug is its first slug key (an example nested
      // further in can name another tool's).
      const m = /\bslug:\s*(?:"([^"]+)"|([\w.]+))/.exec(o.text) || [];
      const slug = m[1] || m[2];
      if (NOT_BUYING[slug]) continue;
      const flagged = /\bpaysThirdPartySeller:\s*true\b/.test(o.text) || (/\bspendsOwnWallet:\s*true\b/.test(o.text) && !["attest"].includes(slug));
      ok(flagged, `${kit} ${slug}: a definition in a kit that buys with our wallet is wallet-only`);
    }
  }
  ok(defs >= 5, `the walk read the definitions (${defs})`);
  // Control: a definition in such a kit with neither flag is caught.
  const control = toolDefObjects('export const T = [{ route: "POST /api/x", slug: "x", category: "agent", price: "$0.01", description: "a { brace } in text", handler: async () => ({}) }];');
  ok(control.length === 1 && !/paysThirdPartySeller:\s*true/.test(control[0].text) && !/spendsOwnWallet:\s*true/.test(control[0].text), "control: an unflagged definition is found and would fail");
}

// Both card-funded gates are handed the flag by the server.
const server = src("server.js");
{
  // Read inside the Stripe gate's own options, so a field added beside the
  // flag (longRunning) does not hide it and another gate's copy cannot pass.
  const at = server.indexOf("const stripeGate = createStripeGate({");
  const block = at >= 0 ? server.slice(at, server.indexOf("if (stripeGate)", at)) : "";
  ok(/priceUsd \? \{[^}]*\bpaysThirdParty: paysThirdParty\(def\)[^}]*\} : null;/.test(block), "the Stripe card gate receives paysThirdParty");
}
ok(/slug: def\.slug, identityBound: isIdentityBoundRoute\(def\), paysThirdParty: paysThirdParty\(def\)/.test(server), "the credits gate receives paysThirdParty");
ok(/!item\.paysThirdParty && priceUsd >= STRIPE_MIN_USD/.test(src("mpp-stripe.js")), "the card challenge is not offered on a third-party route");

// Credits cannot reach an outside seller through decide's execution credit.
const decide = src("tools/decide-kit.js");
ok(/const cardFunded = req\?\.creditsSettling === true \|\| req\?\.stripeSettling === true;\n\s+const amount = cardFunded \? 0 :/.test(decide), "a decision paid with credits or a card mints no execution credit");
ok(!/by credits or card/.test(decide), "decide-execute's description no longer offers credits or a card");
// The surfaces that describe what a credits key pays read the same flag or name the exclusion.
const pages = src("pages.js");
ok(/tool\.identityBound \|\| paysThirdParty\(tool\) \? \[\] : \["a credits key"\]/.test(pages) && /paysThirdParty\(tool\) \? " It buys from an outside seller with our wallet/.test(pages), "tool pages read the predicate where they name what pays a route");
// The rendered page, not only its source: every route in the class is
// rendered with credits sales on and off, and nothing in its head or <main>
// offers a credits key or a card. The one sentence that names them says they
// do not pay it. A route outside the class is the control: its page offers
// the key, so the reader below is proven to find an offer.
{
  const { toolPage, toolList } = await import("../src/pages.js");
  const offers = (html) => {
    const own = html.slice(0, html.indexOf("</head>")) + html.slice(html.indexOf("<main"), html.indexOf("</main>"));
    const text = stripElements(stripElements(own, ["script"], " ", (m) => /ld\+json/.test(m)), ["style"])
      // The share image's meta name and address hold the word and offer nothing.
      .replace(/twitter:card|\/tools\/[a-z0-9-]+\/card\b/g, " ")
      .replace(/prepaid credits and cards do not pay it\./g, " ");
    return [...text.matchAll(/[^.<>]{0,60}(?:credits?[ -]key|card-credits|AGENT402_CREDITS_KEY|a402_|\/credits\b|prepaid|\bcards?\b)[^.<>]{0,40}/gi)].map((m) => m[0].trim());
  };
  const tiers = EXEC_TIERS.map((tier) => buildRouteExecuteTool({ getCatalog: () => ({}), tier }));
  const plain = { route: "GET /api/sample", name: "Sample", slug: "sample-read", category: "web", price: "$0.01", description: "Reads a page.", tags: [], discovery: { inputSchema: { type: "object", properties: { url: { type: "string" } }, required: ["url"] }, input: { url: "https://example.com" }, output: { example: { ok: true } } } };
  const flagged = { ...plain, route: "GET /api/sample-buy", slug: "sample-buy", paysThirdPartySeller: true };
  const spender = { ...plain, route: "GET /api/sample-spend", slug: "sample-spend", spendsOwnWallet: true };
  const saved = process.env.CREDITS_SALES;
  try {
    for (const sales of ["on", ""]) {
      if (sales) process.env.CREDITS_SALES = sales; else delete process.env.CREDITS_SALES;
      const render = (def) => toolPage("https://x.test", toolList({ [def.route]: def })[0], [], {});
      for (const def of [...tiers, flagged, spender]) {
        const html = render(def);
        const found = offers(html);
        ok(paysThirdParty(def) && found.length === 0, `${def.slug} page (credits sales ${sales || "off"}): no credits key and no card anywhere${found.length ? ` (${found.slice(0, 2).join(" | ")})` : ""}`);
        ok(/prepaid credits and cards do not pay it\./.test(html), `${def.slug} page (credits sales ${sales || "off"}): says credits and cards do not pay it`);
      }
      ok(offers(render(plain)).length > 0, `control (credits sales ${sales || "off"}): a route outside the class offers the key, and the reader finds it`);
    }
  } finally { if (saved === undefined) delete process.env.CREDITS_SALES; else process.env.CREDITS_SALES = saved; }
}
ok(/the operations that buy from an outside seller/.test(pages), "openapi's credits scheme names the excluded operations");
ok(/except the ones that buy from an outside seller/.test(src("seo.js")), "llms.txt names the excluded routes");
// llms.txt's decide line renders only while /api/decide is in the catalog (a
// FREE_MODE boot hides it), so the generator is called with that route present.
// decide-execute is flagged above: the line must not offer credits or a card.
{
  const { llmsTxt, llmsFullTxt } = await import("../src/seo.js");
  const catalog = { "POST /api/decide": { route: "POST /api/decide", slug: "decide", name: "Decide", category: "agent", price: "$0.003", description: "A paid decision.", tags: [] } };
  for (const [name, render] of [["llms.txt", llmsTxt], ["llms-full.txt", llmsFullTxt]]) {
    const line = render("https://agent402.test", catalog).split("\n").find((l) => l.includes("`POST /api/decide/execute`")) || "";
    ok(line.length > 0, `${name} renders the decide line when /api/decide is in the catalog`);
    const pays = (line.match(/`POST \/api\/decide\/execute`,[^.]*\./) || [""])[0];
    ok(pays.length > 0 && !/\bpaid[^.;(]*\b(?:by|or) (?:credits|card|a card)\b/.test(pays) && /paid from a wallet on Base/.test(pays) && /a prepaid credits key or a card does not pay it/.test(pays),
      `${name} sells decide-execute for a wallet payment only`);
  }
  const sentence = "`POST /api/decide/execute`, which runs the plan when paid on Base or by credits or card (third-party steps at the seller's price plus a 5% markup).";
  ok(/\bpaid[^.;(]*\b(?:by|or) (?:credits|card|a card)\b/.test(sentence), "control: the sentence that offered credits or a card is caught");
}
const mcpHttp = src("mcp-http.js");
ok(/onSale: creditsSalesEnabled\(\)/.test(mcpHttp) && /the routes that buy from an outside seller/.test(mcpHttp), "payment.info reads the sales switch and names the excluded routes");

console.log(failed ? `${failed} failed` : "all passed");
process.exit(failed ? 1 : 0);
