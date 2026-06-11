// End-to-end paid test: a real x402 agent that buys EVERY tool in the catalog.
// MODE=address  — generate/load the burner key, print the funding address.
// MODE=run      — wait for USDC funding, then buy all 56 endpoints once each.
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { createPublicClient, http, erc20Abi, formatUnits } from "viem";
import { base } from "viem/chains";
import { writeFileSync, readFileSync, existsSync } from "node:fs";
import { x402Client } from "@x402/core/client";
import { registerExactEvmScheme } from "@x402/evm/exact/client";
import { wrapFetchWithPayment } from "@x402/fetch";

const TARGET = process.env.TARGET_URL || "https://agent402.tools";
const USDC = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913"; // USDC on Base
const KEY_FILE = process.env.KEY_FILE || "/tmp/agent-key";
const SUITE_BUDGET = 150000n; // full 56-tool suite costs ~$0.13; require $0.15
const FUND_WAIT_MINUTES = 40;

let pk;
if (existsSync(KEY_FILE)) {
  pk = readFileSync(KEY_FILE, "utf8").trim();
} else {
  pk = generatePrivateKey();
  writeFileSync(KEY_FILE, pk, { mode: 0o600 });
}
const account = privateKeyToAccount(pk);
console.log(`AGENT ADDRESS: ${account.address}`);

if (process.env.MODE === "address") {
  writeFileSync("agent-address.txt", account.address + "\n");
  process.exit(0);
}

const pub = createPublicClient({ chain: base, transport: http("https://mainnet.base.org") });
const balance = () =>
  pub.readContract({ address: USDC, abi: erc20Abi, functionName: "balanceOf", args: [account.address] });

console.log(`Waiting up to ${FUND_WAIT_MINUTES} min for USDC on Base at ${account.address} …`);
let bal = 0n;
for (let i = 0; i < FUND_WAIT_MINUTES * 4; i++) {
  try {
    bal = await balance();
  } catch (e) {
    console.log(`(rpc hiccup: ${e.message?.slice(0, 80)})`);
  }
  if (bal >= SUITE_BUDGET) break;
  if (i % 8 === 0) console.log(`  balance: $${formatUnits(bal, 6)} — still waiting…`);
  await new Promise((r) => setTimeout(r, 15000));
}
if (bal < SUITE_BUDGET) {
  console.log("Never funded — nothing spent, nothing lost. Burner key (throwaway, do not reuse):", pk);
  process.exit(1);
}
const startBal = bal;
console.log(`FUNDED: $${formatUnits(bal, 6)} USDC. Buying all 56 tools from ${TARGET}`);

const client = new x402Client();
registerExactEvmScheme(client, { signer: account });
const payFetch = wrapFetchWithPayment(fetch, client);

const stamp = `e2e-${Date.now()}`;
const b64url = (obj) => Buffer.from(JSON.stringify(obj)).toString("base64url");
const testJwt = `${b64url({ alg: "HS256", typ: "JWT" })}.${b64url({ sub: "agent402-e2e", exp: 9999999999 })}.sig`;
const PNG_MAGIC = (buf) => {
  const b = new Uint8Array(buf.slice(0, 4));
  return b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47;
};

// One case per paid endpoint in the catalog: 56 total.
// check() receives the parsed body (or ArrayBuffer for binary) and must return true.
const CASES = [
  // --- Web & documents (5) ---
  { slug: "extract", method: "POST", path: "/api/extract", body: { url: "https://www.bbc.com/news" }, check: (b) => !!b.title && b.wordCount > 50, show: (b) => `"${b.title}" (${b.wordCount} words)` },
  { slug: "meta", method: "GET", path: "/api/meta", query: { url: "https://github.com" }, check: (b) => !!b.title, show: (b) => b.title },
  { slug: "render", method: "POST", path: "/api/render", body: { url: "https://react.dev" }, check: (b) => b.rendered === true && b.wordCount > 50, show: (b) => `rendered "${b.title}" (${b.wordCount} words)` },
  { slug: "screenshot", method: "GET", path: "/api/screenshot", query: { url: "https://example.com" }, binary: true, check: PNG_MAGIC, show: (b) => `${b.byteLength} bytes, PNG` },
  { slug: "pdf", method: "POST", path: "/api/pdf", body: { url: "https://arxiv.org/pdf/1706.03762" }, check: (b) => b.pages === 15, show: (b) => `${b.pages} pages, ${b.wordCount} words` },
  // --- Agent memory (2) ---
  { slug: "memory-write", method: "POST", path: "/api/memory", body: { key: "e2e", value: { stamp } }, check: (b) => b.key === "e2e", show: () => `stored "e2e"` },
  { slug: "memory-read", method: "GET", path: "/api/memory", query: { key: "e2e" }, check: (b) => b.value?.stamp === stamp, show: () => "wallet-keyed round-trip ✓" },
  // --- Network & domains (6) ---
  { slug: "dns", method: "GET", path: "/api/dns", query: { name: "google.com", type: "A" }, check: (b) => b.records?.length > 0, show: (b) => `${b.records.length} A records` },
  { slug: "http-check", method: "POST", path: "/api/http-check", body: { url: "https://example.com" }, check: (b) => b.status === 200, show: (b) => `HTTP ${b.status} in ${b.latencyMs}ms` },
  { slug: "tls-cert", method: "POST", path: "/api/tls-cert", body: { host: "github.com" }, check: (b) => b.daysRemaining > 0 && b.chainTrusted === true, show: (b) => `${b.issuer}, ${b.daysRemaining}d left` },
  { slug: "whois", method: "POST", path: "/api/whois", body: { domain: "github.com" }, check: (b) => !!b.registrar, show: (b) => `${b.registrar}, expires ${b.expires?.slice(0, 10)}` },
  { slug: "robots-check", method: "POST", path: "/api/robots-check", body: { url: "https://www.google.com/search", userAgent: "TestBot" }, check: (b) => b.allowed === false, show: (b) => b.matchedRule },
  { slug: "sitemap", method: "POST", path: "/api/sitemap", body: { url: "https://www.sitemaps.org/sitemap.xml" }, check: (b) => b.count > 0, show: (b) => `${b.type}, ${b.count} urls` },
  // --- Encoding & crypto (7) ---
  { slug: "hash", method: "POST", path: "/api/hash", body: { text: "hello world" }, check: (b) => b.hex.startsWith("b94d27b9"), show: (b) => b.hex.slice(0, 16) + "…" },
  { slug: "hmac", method: "POST", path: "/api/hmac", body: { text: "payload", key: "secret" }, check: (b) => /^[0-9a-f]{64}$/.test(b.hex), show: (b) => b.hex.slice(0, 16) + "…" },
  { slug: "base64", method: "POST", path: "/api/base64", body: { text: "aGVsbG8=", mode: "decode" }, check: (b) => b.result === "hello", show: (b) => `→ "${b.result}"` },
  { slug: "hex", method: "POST", path: "/api/hex", body: { text: "hi" }, check: (b) => b.result === "6869", show: (b) => `→ ${b.result}` },
  { slug: "url-code", method: "POST", path: "/api/url-code", body: { text: "a b&c" }, check: (b) => b.result === "a%20b%26c", show: (b) => `→ ${b.result}` },
  { slug: "jwt-decode", method: "POST", path: "/api/jwt-decode", body: { token: testJwt }, check: (b) => b.payload?.sub === "agent402-e2e" && b.expired === false, show: (b) => `sub=${b.payload.sub}` },
  { slug: "totp", method: "POST", path: "/api/totp", body: { secret: "JBSWY3DPEHPK3PXP" }, check: (b) => /^\d{6}$/.test(b.code), show: (b) => `code ${b.code}, ${b.secondsRemaining}s left` },
  // --- Generators & IDs (5) ---
  { slug: "uuid", method: "GET", path: "/api/uuid", query: { version: "7", count: "2" }, check: (b) => b.uuids?.length === 2, show: (b) => b.uuids[0] },
  { slug: "ulid", method: "GET", path: "/api/ulid", query: { count: "2" }, check: (b) => b.ulids?.length === 2 && b.ulids[0].length === 26, show: (b) => b.ulids[0] },
  { slug: "password", method: "GET", path: "/api/password", query: { length: "16" }, check: (b) => b.passwords?.[0]?.length === 16, show: (b) => `${b.entropyBits} bits entropy` },
  { slug: "random", method: "GET", path: "/api/random", query: { min: "1", max: "6", count: "3" }, check: (b) => b.integers?.length === 3 && b.integers.every((n) => n >= 1 && n <= 6), show: (b) => `🎲 ${b.integers.join(", ")}` },
  { slug: "qr", method: "GET", path: "/api/qr", query: { text: "https://agent402.tools" }, binary: true, check: PNG_MAGIC, show: (b) => `${b.byteLength} bytes, PNG` },
  // --- Data conversion (10) ---
  { slug: "json-format", method: "POST", path: "/api/json-format", body: { json: '{"a":1}' }, check: (b) => b.valid === true, show: () => "valid, pretty-printed" },
  { slug: "json-to-csv", method: "POST", path: "/api/json-to-csv", body: { json: [{ a: 1, b: { c: 2 } }] }, check: (b) => b.csv.includes("b.c"), show: (b) => `${b.rows} rows, ${b.columns} cols` },
  { slug: "csv-to-json", method: "POST", path: "/api/csv-to-json", body: { csv: 'a,b\n1,"x,y"' }, check: (b) => b.rows?.[0]?.b === "x,y", show: (b) => `${b.count} rows` },
  { slug: "yaml-to-json", method: "POST", path: "/api/yaml-to-json", body: { yaml: "name: Ada\ntags:\n  - eng" }, check: (b) => b.json?.name === "Ada", show: () => "parsed" },
  { slug: "json-to-yaml", method: "POST", path: "/api/json-to-yaml", body: { json: { a: 1 } }, check: (b) => b.yaml.includes("a: 1"), show: () => "dumped" },
  { slug: "xml-to-json", method: "POST", path: "/api/xml-to-json", body: { xml: "<user id='1'><name>Ada</name></user>" }, check: (b) => b.json?.user?.name === "Ada", show: () => "parsed" },
  { slug: "markdown-to-html", method: "POST", path: "/api/markdown-to-html", body: { markdown: "# Hi\n\n**bold**" }, check: (b) => b.html.includes("<h1>"), show: () => "rendered" },
  { slug: "html-to-markdown", method: "POST", path: "/api/html-to-markdown", body: { html: "<h1>Hi</h1><p><b>bold</b></p>" }, check: (b) => b.markdown.includes("# Hi"), show: () => "converted" },
  { slug: "json-diff", method: "POST", path: "/api/json-diff", body: { a: { x: 1, y: 2 }, b: { x: 1, y: 3 } }, check: (b) => b.equal === false && b.differences.length === 1, show: (b) => `${b.differences.length} difference` },
  { slug: "json-query", method: "POST", path: "/api/json-query", body: { json: { items: [{ name: "a" }, { name: "b" }] }, path: "items[1].name" }, check: (b) => b.value === "b", show: (b) => `→ "${b.value}"` },
  // --- Text processing (7) ---
  { slug: "slugify", method: "POST", path: "/api/slugify", body: { text: "Héllo, Wörld! 2026" }, check: (b) => b.slug === "hello-world-2026", show: (b) => b.slug },
  { slug: "case", method: "POST", path: "/api/case", body: { text: "hello world example", to: "camel" }, check: (b) => b.result === "helloWorldExample", show: (b) => b.result },
  { slug: "text-stats", method: "POST", path: "/api/text-stats", body: { text: "One two three. Four five?" }, check: (b) => b.words === 5 && b.sentences === 2, show: (b) => `${b.words} words, ~${b.estimatedTokens} tokens` },
  { slug: "keywords", method: "POST", path: "/api/keywords", body: { text: "payment protocol payment agents payment protocol" }, check: (b) => b.keywords?.[0]?.term === "payment", show: (b) => b.keywords.map((k) => k.term).join(", ") },
  { slug: "text-diff", method: "POST", path: "/api/text-diff", body: { a: "l1\nl2", b: "l1\nl3" }, check: (b) => b.added === 1 && b.removed === 1, show: (b) => `+${b.added} -${b.removed}` },
  { slug: "regex", method: "POST", path: "/api/regex", body: { pattern: "\\d+", text: "a 42 b 7" }, check: (b) => b.matchCount === 2, show: (b) => `${b.matchCount} matches` },
  { slug: "lorem", method: "GET", path: "/api/lorem", query: { words: "8" }, check: (b) => b.text.split(" ").length === 8, show: (b) => b.text.slice(0, 40) + "…" },
  // --- Time & scheduling (5) ---
  { slug: "time", method: "GET", path: "/api/time", query: { tz: "America/New_York" }, check: (b) => b.epochSeconds > 1700000000 && !!b.local, show: (b) => b.local },
  { slug: "time-convert", method: "POST", path: "/api/time-convert", body: { value: 1781172000, tz: "Asia/Tokyo" }, check: (b) => b.epochMillis === 1781172000000, show: (b) => b.local },
  { slug: "cron-next", method: "POST", path: "/api/cron-next", body: { expr: "0 9 * * 1-5", count: 2 }, check: (b) => b.next?.length === 2, show: (b) => b.next[0] },
  { slug: "duration", method: "POST", path: "/api/duration", body: { value: "2h30m" }, check: (b) => b.seconds === 9000, show: (b) => `${b.seconds}s = ${b.human}` },
  { slug: "date-diff", method: "POST", path: "/api/date-diff", body: { from: "2026-01-01", to: "2026-06-11" }, check: (b) => Math.round(b.days) === 161, show: (b) => b.human },
  // --- Validation & parsing (9) ---
  { slug: "email-validate", method: "POST", path: "/api/email-validate", body: { email: "test@gmail.com" }, check: (b) => b.syntaxValid && b.deliverableDomain, show: (b) => `MX: ${b.mxRecords[0]}` },
  { slug: "url-parse", method: "POST", path: "/api/url-parse", body: { url: "https://ex.com:8080/a?x=1#f" }, check: (b) => b.hostname === "ex.com" && b.query.x === "1", show: (b) => b.origin },
  { slug: "ip-info", method: "POST", path: "/api/ip-info", body: { ip: "8.8.8.8" }, check: (b) => b.scope === "public" && b.version === 4, show: (b) => `${b.scope}, ptr: ${b.ptr[0] ?? "-"}` },
  { slug: "user-agent", method: "POST", path: "/api/user-agent", body: { ua: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36" }, check: (b) => b.browser === "Chrome" && b.os === "Windows", show: (b) => `${b.browser} ${b.version} on ${b.os}` },
  { slug: "color", method: "POST", path: "/api/color", body: { color: "#4ade80" }, check: (b) => b.rgb[0] === 74 && b.hsl[0] === 142, show: (b) => `rgb(${b.rgb}) hsl(${b.hsl})` },
  { slug: "semver", method: "POST", path: "/api/semver", body: { a: "2.4.0", b: "2.10.1" }, check: (b) => b.comparison === -1, show: () => "2.4.0 < 2.10.1 ✓" },
  { slug: "mime", method: "GET", path: "/api/mime", query: { ext: "webp" }, check: (b) => b.mime === "image/webp", show: (b) => b.mime },
  { slug: "iban-validate", method: "POST", path: "/api/iban-validate", body: { iban: "DE89370400440532013000" }, check: (b) => b.valid === true && b.country === "DE", show: (b) => b.formatted },
  { slug: "card-validate", method: "POST", path: "/api/card-validate", body: { number: "4242 4242 4242 4242" }, check: (b) => b.valid === true && b.brand === "visa", show: (b) => b.brand },
];

let passed = 0;
const failed = [];
for (const c of CASES) {
  const qs = c.query ? "?" + new URLSearchParams(c.query).toString() : "";
  const url = `${TARGET}${c.path}${qs}`;
  const init =
    c.method === "POST"
      ? { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(c.body) }
      : undefined;
  const label = c.slug.padEnd(17);
  try {
    const res = await payFetch(url, init);
    const body = c.binary ? await res.arrayBuffer() : await res.json().catch(() => ({}));
    if (res.status !== 200) {
      failed.push(c.slug);
      console.log(`[${label}] HTTP ${res.status} FAILED: ${JSON.stringify(body).slice(0, 150)}`);
      continue;
    }
    let ok = true;
    try {
      ok = c.check(body) === true;
    } catch {
      ok = false;
    }
    if (ok) {
      passed++;
      console.log(`[${label}] PAID ✓  ${c.show ? c.show(body) : ""}`);
    } else {
      failed.push(c.slug);
      console.log(`[${label}] PAID but CHECK FAILED: ${c.binary ? "(binary)" : JSON.stringify(body).slice(0, 150)}`);
    }
  } catch (e) {
    failed.push(c.slug);
    console.log(`[${label}] THREW: ${e.message?.slice(0, 150)}`);
  }
}

bal = await balance();
console.log("");
console.log("================ RESULT ================");
console.log(`Tools bought & verified: ${passed}/${CASES.length}${failed.length ? `  FAILED: ${failed.join(", ")}` : ""}`);
console.log(`Spent this run: $${formatUnits(startBal - bal, 6)} USDC`);
console.log(`Burner wallet remainder: $${formatUnits(bal, 6)} USDC (kept for future test runs)`);
console.log(`Revenue landed at the owner wallet — verify on-chain:`);
console.log(`  https://basescan.org/address/0xaBF4FAbd7c416fB67202E5f9002389Fc75e2a9D0#tokentxns`);
process.exit(passed === CASES.length ? 0 : 1);
