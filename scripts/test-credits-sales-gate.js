#!/usr/bin/env node
// Selling prepaid credits creates a held balance kept against future
// redemption, so sales are OFF unless CREDITS_SALES is explicitly on.
//
// REDEMPTION IS NOT GATED, and that is the point of the test. Existing keys
// must keep spending their balance, or turning sales off would strand money
// that is already out there. This pins both halves.
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { getFreePort } from "./lib/free-port.js";

const PORT = await getFreePort();
const B = `http://127.0.0.1:${PORT}`;
let pass = 0, proc = null;
const log = [];
const fail = (m) => { console.error(`FAIL - ${m}`); for (const l of log.slice(-20)) console.error("  server:", l); proc?.kill("SIGKILL"); process.exit(1); };
const ok = (c, m) => { c ? (pass++, console.log("ok -", m)) : fail(m); };

const boot = (env) => new Promise(async (resolve) => {
  proc = spawn("node", ["src/server.js"], {
    env: { ...process.env, PORT: String(PORT), FREE_MODE: "true", STRIPE_SECRET_KEY: "sk_test_x",
      X402_INDEX_CRAWL: "off", MPP_INDEX_CRAWL: "off", MONITOR_SCHEDULER: "off",
      FREE_ALERTS: "off", FOLLOWUPS: "off", X402_SYNC_ON_START: "false", ...env },
    stdio: ["ignore", "pipe", "pipe"],
  });
  proc.stdout.on("data", (d) => log.push(...String(d).split("\n").filter(Boolean)));
  proc.stderr.on("data", (d) => log.push(...String(d).split("\n").filter(Boolean)));
  for (let i = 0; i < 120; i++) {
    try { if ((await fetch(`${B}/health`)).ok) return resolve(true); } catch { await new Promise((r) => setTimeout(r, 500)); }
  }
  resolve(false);
});

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
  const files = [join(ROOT, "README.md"), ...packageFiles];
  ok(files.length >= 30, `credits copy: ${files.length} static surfaces read (README + shipped package files)`);
  const scanWith = (rules) => (text) => rules.filter(([re]) => re.test(text)).map(([, why]) => why);
  const scan = scanWith(OFFERS), scanPackage = scanWith(PACKAGE_OFFERS);
  ok(scan("## For humans: reports, monitors and prepaid credits\n(credits keys: https://agent402.tools/credits)").length === 2, "control: the retired heading and key pointer are both reported");
  ok(scan("## Prepaid credits (keys already issued)\n\nPrepaid credits: not on sale. A key already issued keeps working.").length === 0, "control: describing an issued key is not an offer");
  ok(scan("models at a flat per-call price, paid by card or USDC.").length === 1, "control: a package that sells the card path is reported");
  ok(scanPackage("each call is paid from the prepaid card credits key (AGENT402_CREDITS_KEY)").length === 1 && scanPackage("how: \"prepaid card credits (Authorization: Bearer a402_...)\"").length === 1, "control: a package describing credits as a card purchase is reported");
  ok(scanPackage("Payment mode: card credits.").length === 1 && scanPackage("agent402PaymentMode === \"card-credits\"").length === 1, "control: the bare payment-mode word, with a space or a hyphen, is reported");
  ok(scanPackage("a card credits key already issued keeps working\nprepaid credits: a key already issued\na prepaid card-credits key issued at the credits page").length === 0, "control: a line that says the key is issued is not an offer");
  ok(packageFiles.some((f) => /\/mcp\/index\.js$/.test(f)) && packageFiles.some((f) => /\/adapters\/eliza\/index\.js$/.test(f)) && packageFiles.some((f) => /\/client\/index\.js$/.test(f)), "the package scan covers the mcp, adapter and client code");
  const hits = files.flatMap((f) => (packageFiles.includes(f) ? scanPackage : scan)(readFileSync(f, "utf8")).map((why) => `${relative(ROOT, f)}: ${why}`));
  ok(hits.length === 0, `no static surface offers credits for sale${hits.length ? `:\n    ${hits.join("\n    ")}` : ""}`);
}

try {
  // --- default: a host that sets nothing is in the SAFE state, not the exposed one
  ok(await boot({}), "server booted with CREDITS_SALES unset");
  const off = await fetch(`${B}/api/credits/checkout`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ pack: "credits-20" }) });
  ok(off.status === 503, `selling is refused by default (got ${off.status})`);
  const body = await off.json().catch(() => ({}));
  ok(/not on sale/i.test(String(body.error || "")), "and the refusal says sales are off rather than reading as a misconfiguration");

  // redemption must survive: a 404 here would mean an existing key was stranded
  ok((await fetch(`${B}/api/credits/balance`)).status !== 404, "the balance route still exists, so an existing key can still be read");
  ok((await fetch(`${B}/api/credits/claim?session=x`)).status !== 404, "the claim route still exists");

  // The machine and page surfaces follow the same switch. /api/pricing used to
  // advertise packs and a checkout body that this server answers 503 to, and
  // /credits carried an InStock Offer and a "Buy $20" snippet while refusing.
  const pricingOff = await (await fetch(`${B}/api/pricing`)).json();
  ok(pricingOff.credits && pricingOff.credits.onSale === false, "/api/pricing says credits are not on sale");
  ok(!pricingOff.credits.checkout && !pricingOff.credits.packs && !pricingOff.credits.buy, "...and offers no packs, buy link or checkout body");
  ok(/already issued/.test(String(pricingOff.credits.how)) && /balance/.test(String(pricingOff.credits.balance)), "...and still tells an existing key holder how to spend and read it");
  const pageOff = await (await fetch(`${B}/credits`)).text();
  ok(!/InStock/.test(pageOff) && !/Buy \$20/.test(pageOff) && !/data-pack-buy/.test(pageOff), "/credits carries no Offer, buy snippet or buy button while sales are off");
  const descOf = (html) => (html.match(/<meta name="description" content="([^"]*)"/) || [])[1] || "";
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
  proc.kill("SIGKILL");

  // --- explicitly on: selling works again, so this is a switch and not a deletion
  ok(await boot({ CREDITS_SALES: "on" }), "server booted with CREDITS_SALES=on");
  const on = await fetch(`${B}/api/credits/checkout`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ pack: "credits-20" }) });
  ok(on.status !== 503, `selling is reachable when explicitly enabled (got ${on.status}, not the 503 refusal)`);
  const pricingOn = await (await fetch(`${B}/api/pricing`)).json();
  ok(pricingOn.credits?.onSale === true && pricingOn.credits.checkout?.method === "POST", "/api/pricing advertises the checkout when sales are on");
  const pageOnRes = await fetch(`${B}/credits`);
  const pageOn = await pageOnRes.text();
  ok(pageOnRes.status === 200 && !/noindex/.test(robotsMeta(pageOn)), `/credits is 200 and indexable when sales are on (got "${robotsMeta(pageOn)}")`);
  ok(!/not on sale/.test(descOf(pageOn)) && /\$20/.test(descOf(pageOn)), `/credits describes the purchase when sales are on ("${descOf(pageOn).slice(0, 40)}...")`);
  for (const path of ["/sitemap.xml", "/sitemap-pages.xml"]) {
    const xml = await (await fetch(`${B}${path}`)).text();
    ok(/\/credits<\/loc>/.test(xml), `${path} lists /credits when sales are on`);
  }

  // the gate must be read at call time, never latched at boot
  const src = readFileSync(new URL("../src/server.js", import.meta.url), "utf8");
  ok(/if \(!creditsSalesEnabled\(\)\) return res\.status\(503\)/.test(src), "the check runs inside the handler, before Stripe is touched");

  console.log(`\n${pass} passed, 0 failed`);
} finally { proc?.kill("SIGKILL"); }
