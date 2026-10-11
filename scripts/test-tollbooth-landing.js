// /tollbooth: the install snippet on the page is RUN, for every mode the page
// offers, against the real package (tollbooth/index.js), and the page's mode,
// option and dashboard wording is checked against the package source.
//
// The snippet is rendered client-side by assets/js/tollbooth-snippet.js from
// the page's wallet / price / mode inputs. This test executes that script in a
// minimal DOM, takes the code text a visitor would copy, swaps only the two
// placeholders a reader must replace (their routes, their port), and imports it
// with its bare specifiers resolved to the packages this repo installs. Then:
//   - observe: true  -> a known AI crawler is served, marked would-charge, counted;
//   - mode "bots"    -> a browser passes, a crawler gets a 402 carrying the x402
//                       middleware's PAYMENT-REQUIRED, an MPP challenge and a
//                       proof-of-work; the solved work unlocks it; a stock
//                       @x402/fetch client pays and the facilitator settles once;
//   - mode "strict"  -> a real browser request passes, anything else is charged;
//   - mode "all"     -> a browser request is charged too.
// A stub facilitator on port 0 stands in for the network; nothing is spent.
import { createServer } from "node:http";
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import vm from "node:vm";
import { x402Client } from "@x402/core/client";
import { registerExactEvmScheme } from "@x402/evm/exact/client";
import { wrapFetchWithPayment } from "@x402/fetch";
import { privateKeyToAccount, generatePrivateKey } from "viem/accounts";
import { tollboothLandingPage } from "../src/tollbooth-landing.js";
import { integrationBySlug } from "../src/integration-pages.js";

let pass = 0;
const servers = [];
const fail = (m) => { console.error("FAIL:", m); for (const s of servers) try { s.close(); } catch {} process.exit(1); };
const ok = (c, m) => { if (c) { pass++; console.log(`ok - ${m}`); } else fail(m); };

for (const k of Object.keys(process.env)) if (k.startsWith("TOLLBOOTH_")) delete process.env[k];
process.env.TOLLBOOTH_SECRET = "tollbooth-landing-test-secret";

// ---- 1. page copy against the package source --------------------------------
const pkg = readFileSync(new URL("../tollbooth/index.js", import.meta.url), "utf8");
const html = tollboothLandingPage("https://agent402.tools");
// The page's own content (the shared nav, footer and site JSON-LD name every rail).
const own = html.slice(html.indexOf('<div class="tb-wrap">'), html.indexOf("<script src=\"/js/tollbooth-snippet.js\">"));
ok(own.length > 1000, "found the page's own content block");
const text = own.replace(/<\/?(code|a|b|i|em|strong|span)\b[^>]*>/g, "").replace(/<[^>]+>/g, " ").replace(/&quot;/g, '"').replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&").replace(/\s+/g, " ");

ok(/if \(mode === "all"\) return true;/.test(pkg) && /if \(mode === "strict"\) return !looksHuman\(req\);/.test(pkg),
  "the package still defines all = every client, strict = anything not a real browser");
ok(text.includes("all - charge every client") && text.includes("strict - charge anything not a browser") && !/paywall everyone|everything non-human/.test(text),
  "mode labels say what each mode charges (all charges people too; strict passes real browsers)");
ok(/observe = config\.observe/.test(pkg) && !/mode: "observe"/.test(own) && text.includes("observe: true"),
  "observe is shown as the boolean option it is, never as a mode value (which would charge)");
ok(!/statsToken/.test(pkg) && !/statsToken|\?token=/.test(own), "no statsToken option and no ?token= query: neither exists in the package");
ok(/TOLLBOOTH_ADMIN_TOKEN/.test(pkg) && /startsWith\("Bearer "\)/.test(pkg) && text.includes("TOLLBOOTH_ADMIN_TOKEN gates both and is read from an Authorization: Bearer header"),
  "the dashboard token is the proxy's TOLLBOOTH_ADMIN_TOKEN, sent as a Bearer header");
ok(text.includes("reverse proxy (npx agent402-tollbooth) and the Cloudflare Worker also serve a dashboard at /__tollbooth"),
  "the /__tollbooth dashboard is attributed to the proxy and the Worker, not the middleware");
ok(/adaptive = config\.adaptive \?\? \(process\.env\.TOLLBOOTH_ADAPTIVE === "true"\)/.test(pkg) && text.includes("adaptive: true raises its difficulty"),
  "adaptive proof-of-work is described as the opt-in it is");
ok(!/waitlist|platform proxy|platform gateways|href="\/compare"/i.test(own), "no retired comparison copy or link");
ok(!/GPTBot|ClaudeBot|CCBot|Perplexity|Googlebot|Coinbase/.test(text), "no third-party company or bot names in the copy");
ok(!/Solana|Stellar/.test(text), "no chain the shown snippet cannot settle (the CLI and this snippet settle EVM USDC; Solana/Stellar need another scheme)");
ok(text.includes("One file: middleware.js") && readFileSync(new URL("../tollbooth/deploy/nextjs/middleware.js", import.meta.url), "utf8").length > 0,
  "the Next.js template is the middleware.js file it ships");
ok(/activePath: "\/sell"/.test(readFileSync(new URL("../src/tollbooth-landing.js", import.meta.url), "utf8")), "the page highlights Sell in the nav");

// ---- 2. render the snippet the way the browser does -------------------------
const snippetJs = readFileSync(new URL("../assets/js/tollbooth-snippet.js", import.meta.url), "utf8");
function renderSnippet(mode, wallet = "0x000000000000000000000000000000000000dEaD", price = "$0.002") {
  const els = {
    wallet: { value: wallet, addEventListener() {} },
    price: { value: price, addEventListener() {} },
    mode: { value: mode, addEventListener() {} },
    snip: { innerHTML: "" },
  };
  const document = { getElementById: (id) => els[id] || null, querySelectorAll: () => [] };
  vm.runInNewContext(snippetJs, { document, navigator: {}, setTimeout });
  return els.snip.innerHTML.replace(/<[^>]+>/g, "").replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");
}
const modes = [...html.matchAll(/<option value="([a-z]+)"/g)].map((m) => m[1]);
ok(modes.join(",") === "observe,bots,strict,all", `the page offers observe, bots, strict, all (got ${modes.join(",")})`);

// ---- 3. stub facilitator ----------------------------------------------------
const settles = [];
const facilitator = createServer((req, res) => {
  let body = ""; req.on("data", (c) => { body += c; });
  req.on("end", () => {
    const reply = (o) => { res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify(o)); };
    const parsed = body ? JSON.parse(body) : {};
    if (req.url === "/supported") return reply({ kinds: [{ x402Version: 2, scheme: "exact", network: "eip155:8453" }], extensions: [], signers: {} });
    if (req.url === "/verify") return reply({ isValid: true, payer: parsed.paymentPayload?.payload?.authorization?.from });
    if (req.url === "/settle") { settles.push(parsed); return reply({ success: true, transaction: `0x${"ab".repeat(32)}`, network: "eip155:8453", payer: parsed.paymentPayload?.payload?.authorization?.from }); }
    res.writeHead(404); res.end();
  });
});
servers.push(facilitator);
await new Promise((r) => facilitator.listen(0, "127.0.0.1", r));
process.env.X402_FACILITATOR_URL = `http://127.0.0.1:${facilitator.address().port}`;

// ---- 4. run the copied snippet for each mode ---------------------------------
const spec = (s) => import.meta.resolve(s);
const resolved = {
  '"express"': spec("express"), '"agent402-tollbooth"': new URL("../tollbooth/index.js", import.meta.url).href,
  '"@x402/express"': spec("@x402/express"), '"@x402/core/server"': spec("@x402/core/server"), '"@x402/evm/exact/server"': spec("@x402/evm/exact/server"),
};
const dir = mkdtempSync(join(tmpdir(), "tollbooth-landing-"));
async function boot(mode, code = renderSnippet(mode)) {
  ok(code.includes("app.use(yourExistingRoutes);") && code.includes("app.listen(3000);"), `${mode}: the snippet has the two placeholders a reader replaces`);
  let runnable = code
    .replace("app.use(yourExistingRoutes);", 'app.get("/article", (_req, res) => res.send("the article"));')
    .replace("app.listen(3000);", "const server = app.listen(0, \"127.0.0.1\");\nexport { server, gate };");
  for (const [k, v] of Object.entries(resolved)) runnable = runnable.split(`from ${k}`).join(`from ${JSON.stringify(v)}`);
  ok(!/from "(?!file:)/.test(runnable), `${mode}: every import in the snippet resolves to an installed package`);
  const file = join(dir, `snippet-${mode}.mjs`);
  writeFileSync(file, runnable);
  const mod = await import(pathToFileURL(file).href);
  servers.push(mod.server);
  await new Promise((r) => (mod.server.listening ? r() : mod.server.once("listening", r)));
  return { base: `http://127.0.0.1:${mod.server.address().port}`, gate: mod.gate };
}
const BOT = { "user-agent": "Mozilla/5.0 (compatible; GPTBot/1.2; +https://openai.com/gptbot)" };
const BROWSER = { "user-agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0) AppleWebKit/537.36 Chrome/126 Safari/537.36", accept: "text/html,application/xhtml+xml" };
const lz = (buf) => { let n = 0; for (const b of buf) { if (b === 0) { n += 8; continue; } n += Math.clz32(b) - 24; break; } return n; };
const solve = (chal, diff) => { let n = 0; while (lz(createHash("sha256").update(`${chal}:${n}`).digest()) < diff) n++; return n; };

{
  const { base, gate } = await boot("observe");
  const r = await fetch(`${base}/article`, { headers: BOT });
  ok(r.status === 200 && r.headers.get("x-tollbooth-observed") === "would-charge" && (await r.text()) === "the article",
    "observe: true serves a known AI crawler and marks it would-charge");
  ok(gate.stats().wouldCharge === 1 && gate.stats().charged === 0 && gate.stats().observe === true, "observe: true counts it in gate.stats().wouldCharge and charges nothing");
}
{
  const { base, gate } = await boot("bots");
  let r = await fetch(`${base}/article`, { headers: BROWSER });
  ok(r.status === 200, "bots: a person browsing is served free");
  r = await fetch(`${base}/article`, { headers: BOT });
  const quote = await r.json();
  ok(r.status === 402 && r.headers.get("payment-required") && /Payment /.test(r.headers.get("www-authenticate") || ""),
    "bots: a known AI crawler gets a 402 carrying the x402 PAYMENT-REQUIRED offer and an MPP challenge");
  ok(quote.proofOfWork?.challenge && quote.accepts?.[0]?.payTo, "bots: the same 402 carries a proof-of-work challenge and the payTo");
  const sol = `${quote.proofOfWork.token}:${solve(quote.proofOfWork.challenge, quote.proofOfWork.difficulty)}`;
  r = await fetch(`${base}/article`, { headers: { ...BOT, "x-pow-solution": sol } });
  ok(r.status === 200 && r.headers.get("x-tollbooth-paid") === "pow", "bots: a solved proof-of-work unlocks the page with no wallet");
  const client = new x402Client();
  registerExactEvmScheme(client, { signer: privateKeyToAccount(generatePrivateKey()) });
  const payFetch = wrapFetchWithPayment(fetch, client);
  r = await payFetch(`${base}/article`, { headers: BOT });
  ok(r.status === 200 && r.headers.get("x-tollbooth-paid") === "x402" && (await r.text()) === "the article", "bots: a stock @x402/fetch client pays and is served");
  ok(settles.length === 1 && settles[0].paymentRequirements?.payTo === "0x000000000000000000000000000000000000dEaD",
    "bots: the x402 middleware settled the payment once, to the payTo in the snippet");
  ok(gate.stats().x402Paid === 1 && gate.stats().powSolved === 1, "bots: gate.stats() counts the x402 payment and the proof-of-work");
}
{
  const { base } = await boot("strict");
  let r = await fetch(`${base}/article`, { headers: BROWSER });
  ok(r.status === 200, "strict: a real browser request (browser user-agent asking for HTML) passes");
  r = await fetch(`${base}/article`, { headers: { "user-agent": "curl/8.4.0" } });
  ok(r.status === 402, "strict: anything that is not a real browser is charged");
}
{
  const { base } = await boot("all");
  const r = await fetch(`${base}/article`, { headers: BROWSER });
  ok(r.status === 402, "all: every client is charged, a browser included");
}

{
  // /integrations/tollbooth shows its own Express example: run that one too.
  const page = integrationBySlug("tollbooth");
  const code = page.example.replace('app.get("/article", (_req, res) => res.send("...your content..."));', "app.use(yourExistingRoutes);");
  ok(code !== page.example, "/integrations/tollbooth: the example's route line is the one this test swaps");
  const deps = [...code.matchAll(/from "([^"]+)"/g)].map((m) => m[1].replace(/^(@[^/]+\/[^/]+|[^/@][^/]*).*$/, "$1"));
  ok(deps.every((d) => page.install.split(/\s+/).includes(d) || d === "agent402-tollbooth"), `/integrations/tollbooth: the install line carries every package the example imports (${[...new Set(deps)].join(", ")})`);
  // Name the gate so the test can read its stats; nothing else changes.
  // and the wallet placeholder a reader replaces gets a real address.
  const named = code.replace("app.use(createTollbooth({ payTo, price, x402 }));", "const gate = createTollbooth({ payTo, price, x402 });\napp.use(gate);")
    .replace('const payTo = "0xYourWallet";', 'const payTo = "0x000000000000000000000000000000000000dEaD";');
  ok(named !== code, "/integrations/tollbooth: the example mounts createTollbooth({ payTo, price, x402 })");
  const { base, gate } = await boot("integration", named);
  let r = await fetch(`${base}/article`, { headers: BOT });
  ok(r.status === 402 && r.headers.get("payment-required") && /Payment /.test(r.headers.get("www-authenticate") || ""), "/integrations/tollbooth: a crawler gets a 402 with an x402 offer and an MPP challenge, as its lede says");
  const before = settles.length;
  const client = new x402Client();
  registerExactEvmScheme(client, { signer: privateKeyToAccount(generatePrivateKey()) });
  r = await wrapFetchWithPayment(fetch, client)(`${base}/article`, { headers: BOT });
  ok(r.status === 200 && settles.length === before + 1, "/integrations/tollbooth: a stock x402 client pays and the payment settles once");
  ok(gate.stats().x402Paid === 1, "/integrations/tollbooth: gate.stats() counts it");
}

for (const s of servers) await new Promise((r) => s.close(() => r()));
rmSync(dir, { recursive: true, force: true });
console.log(`\n${pass} passed, 0 failed`);
process.exit(0);
