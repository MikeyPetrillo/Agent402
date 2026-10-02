// Pins for src/x402-spend-controls.js (2026-09-18, the @x402 2.22 -> 2.26 bump).
//
// @x402/core 2.23 turned client-side spend controls ON BY DEFAULT: an accept
// whose asset is not a scheme "default" asset is refused unless allowlisted, and
// a default-asset accept above "$1" (DEFAULT_MAX_AMOUNT_PER_PAYMENT) is refused.
// Our buyers bound spend in their own code (payX402's maxAtomic re-check, the
// external-spend-guard, known canary leg prices, the packages' own caps), so
// every client we construct disables the vendor filter. Two halves:
//   1. BEHAVIOUR against the real installed client: a $3 USDC accept and a
//      non-default-asset accept are refused by a stock client and accepted
//      after disableVendorSpendControls(); the helper is a no-op on a client
//      without the method (a floating peer resolving to 2.22).
//   2. SOURCE: every file that constructs an x402Client (src/, scripts/, the
//      published packages, adapters) says so, with an exempt list for the
//      documentation snippets that only SHOW a client to a reader.
// Offline; signs with a throwaway key; nothing is sent anywhere.
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { x402Client, DEFAULT_MAX_AMOUNT_PER_PAYMENT } from "@x402/core/client";
import { registerExactEvmScheme } from "@x402/evm/exact/client";
import { privateKeyToAccount } from "viem/accounts";
import { disableVendorSpendControls } from "../src/x402-spend-controls.js";

let pass = 0;
const ok = (c, m) => { if (!c) { console.error("FAIL:", m); process.exit(1); } pass++; };
const ROOT = new URL("..", import.meta.url).pathname.replace(/\/$/, "");

// Throwaway key: never funded, never used anywhere else.
const signer = privateKeyToAccount("0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d");
const USDC_BASE = "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913";
const accept = (amount, asset = USDC_BASE, extra = { name: "USD Coin", version: "2" }) => ({
  scheme: "exact", network: "eip155:8453", amount, asset, payTo: "0x000000000000000000000000000000000000dEaD",
  maxTimeoutSeconds: 300, extra,
});
const required = (...accepts) => ({ x402Version: 2, error: "", resource: { url: "https://example.com/api/x" }, accepts });
const attempt = async (client, pr) => { try { await client.createPaymentPayload(pr); return "paid"; } catch (e) { return String(e?.message || e); } };

// ---- 1a. the vendor default is the one this module exists for ----
ok(DEFAULT_MAX_AMOUNT_PER_PAYMENT === "$1", `vendor default cap is "$1" (got ${DEFAULT_MAX_AMOUNT_PER_PAYMENT})`);

// ---- 1b. a stock client refuses a $3 USDC accept and a non-default asset; ours does not ----
{
  const stock = registerExactEvmScheme(new x402Client(), { signer });
  const three = await attempt(stock, required(accept("3000000")));
  ok(/spendControls\.maxAmountPerPayment/.test(three), `stock client refuses $3 USDC on Base (got: ${three.slice(0, 80)})`);
  const usdg = await attempt(stock, required(accept("1000", "0x1111111111111111111111111111111111111111", { name: "USDG", version: "1" })));
  ok(/spendControls/.test(usdg) && /allowedAssets/.test(usdg), `stock client refuses a non-default asset (got: ${usdg.slice(0, 80)})`);
  const small = await attempt(stock, required(accept("1000")));
  ok(small === "paid", "control: the stock client still signs a $0.001 USDC accept");

  const ours = registerExactEvmScheme(disableVendorSpendControls(new x402Client()), { signer });
  ok(await attempt(ours, required(accept("3000000"))) === "paid", "disabled: the $3 USDC accept is signed (route-execute-pro's $3 underlying cap)");
  ok(await attempt(ours, required(accept("1000", "0x1111111111111111111111111111111111111111", { name: "USDG", version: "1" }))) === "paid",
    "disabled: a non-default asset is signed (the USDG legs)");
  ok(await attempt(ours, required(accept("1000"))) === "paid", "disabled: the cheap accept still signs");
  ok(ours.spendControls === false, "the helper sets spendControls to false, not to a looser object");
}

// ---- 1c. version tolerance: a client with no setSpendControls is returned untouched ----
{
  const legacy = { register() {} };
  ok(disableVendorSpendControls(legacy) === legacy, "a pre-2.23 client (no setSpendControls) is returned as is");
  ok(disableVendorSpendControls(null) === null, "null is returned as is");
}

// ---- 2. every construction site says so ----
// Files that only SHOW a client in documentation strings, never construct one at runtime.
const DOC_SNIPPETS = {
  "src/guides.js": "guide pages: code blocks a reader copies",
  "src/pages.js": "tool pages: code blocks",
  "src/quickstart.js": "quickstart page: code blocks",
  "src/skill-md.js": "SKILL.md text: code blocks",
  "src/ledger-docs.js": "/docs page: code blocks",
  "src/integration-pages.js": "integration pages: code blocks",
  "src/learn.js": "learn pages: code blocks",
  "src/x402-spend-controls.js": "the helper's own comment names the class",
  "examples/hello-agent402.js": "commented-out example",
};
const SKIP_DIR = new Set(["node_modules", "dist", ".git", "assets", "wiki", "docs", "scratchpad", ".claude"]);
const isTest = (p) => /(^|\/)test[-.]|\.test\.js$|\/test\.js$|test-runtime|test-real-install/.test(p);
function* walk(dir) {
  for (const name of readdirSync(dir)) {
    if (SKIP_DIR.has(name)) continue;
    const p = join(dir, name);
    const st = statSync(p);
    if (st.isDirectory()) yield* walk(p);
    else if (/\.(js|mjs)$/.test(name)) yield p;
  }
}
const SCAN_ROOTS = ["src", "scripts", "mcp", "openclaw", "adapters", "client", "tollbooth", "examples", "workers"];
const sites = [];
const missing = [];
for (const root of SCAN_ROOTS) {
  let entries;
  try { entries = [...walk(join(ROOT, root))]; } catch { continue; }
  for (const p of entries) {
    const rel = relative(ROOT, p);
    if (isTest(rel)) continue;
    const src = readFileSync(p, "utf8");
    if (!src.includes("x402Client")) continue;
    // aliases: `x402Client: Name` destructures, plus the bare name and `<obj>.x402Client`
    const aliases = new Set(["x402Client"]);
    for (const m of src.matchAll(/x402Client:\s*([A-Za-z_$][\w$]*)/g)) aliases.add(m[1]);
    const re = new RegExp(`new\\s+(?:[\\w$]+\\.)?(?:${[...aliases].join("|")})\\s*\\(`, "g");
    const hits = [...src.matchAll(re)];
    if (!hits.length) continue;
    if (Object.hasOwn(DOC_SNIPPETS, rel)) continue;
    sites.push(rel);
    const covered = /disableVendorSpendControls\(|setSpendControls\?\.\(false\)|setSpendControls\(false\)/.test(src);
    // every hit must be wrapped or followed by the inline call: check per site for the wrapped form,
    // else the file-level inline form must be present
    const unwrapped = hits.filter((h) => !/disableVendorSpendControls\($/.test(src.slice(Math.max(0, h.index - 30), h.index)));
    if (!covered || (unwrapped.length && !/setSpendControls/.test(src))) missing.push(`${rel} (${hits.length} site(s))`);
  }
}
ok(sites.length >= 30, `the scan sees the construction sites (found ${sites.length}; the buyers, canaries, sweeps and packages)`);
ok(sites.some((s) => s === "src/x402-buyer.js") && sites.some((s) => s === "src/solana-buyer.js") && sites.some((s) => s === "scripts/paid-canary.js")
  && sites.some((s) => s === "mcp/index.js") && sites.some((s) => s === "openclaw/index.js"),
  "the scan reaches the server buyers, the paid canary and the published packages");
ok(missing.length === 0, `every x402Client construction disables the vendor spend controls; missing: ${missing.join(", ") || "none"}`);
for (const rel of Object.keys(DOC_SNIPPETS)) {
  ok(!sites.includes(rel), `${rel} is exempt as a documentation snippet (${DOC_SNIPPETS[rel]})`);
}
// Control for the scanner itself: a planted unwrapped construction must be reported.
{
  const planted = 'const c = new x402Client();\nconst { x402Client: Alt } = await import("@x402/core/client");\nnew Alt((v, a) => a[0]);';
  const aliases = new Set(["x402Client"]);
  for (const m of planted.matchAll(/x402Client:\s*([A-Za-z_$][\w$]*)/g)) aliases.add(m[1]);
  const re = new RegExp(`new\\s+(?:[\\w$]+\\.)?(?:${[...aliases].join("|")})\\s*\\(`, "g");
  ok([...planted.matchAll(re)].length === 2, "control: the scanner sees a bare and an aliased construction");
}

console.log(`\ntest-x402-spend-controls: ${pass} assertions passed (${sites.length} construction sites scanned)`);
