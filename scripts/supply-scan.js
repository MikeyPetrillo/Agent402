// Supply-side gap analysis: enumerate every x402 service the ecosystem already
// offers (Coinbase CDP Bazaar = the canonical public discovery index, plus the
// agent402.app public Bazaar-quality view) and bucket them by keyword, so we can
// see which capability categories are crowded and which are thin/unserved.
// Public endpoints — no auth. Runs in CI (sandbox has no egress).
const CDP = "https://api.cdp.coinbase.com/platform/v2/x402/discovery/resources";
const A402 = "https://marketplace.agent402.app/api/v1/bazaar/quality?details=true";

async function getJson(url, label) {
  try {
    const res = await fetch(url, { headers: { Accept: "application/json" }, signal: AbortSignal.timeout(25000) });
    const text = await res.text();
    let json; try { json = JSON.parse(text); } catch { json = null; }
    console.log(`\n# ${label}: ${url} -> ${res.status}`);
    if (!json) { console.log("  (non-JSON)", text.slice(0, 200)); return null; }
    return json;
  } catch (e) {
    console.log(`\n# ${label}: ${url} -> ERR ${e.message}`);
    return null;
  }
}

// Capability buckets — keyword sets we map each listing's text onto. "ours"
// marks categories Agent402 already covers, so gaps stand out.
const BUCKETS = [
  ["web scrape / extract / markdown", /scrap|extract|crawl|readability|markdown|article|html.?to/i, true],
  ["browser / screenshot / render", /screenshot|render|headless|browser|puppeteer|playwright/i, true],
  ["search", /\bsearch\b|serp|web.?search|index/i, true],
  ["pdf / documents", /\bpdf\b|document|ocr/i, true],
  ["audio / video / media", /audio|video|ffmpeg|transcod|mp3|mp4|image.?resize|thumbnail/i, true],
  ["memory / storage / state", /memory|storage|cache|kv|database|persist/i, true],
  ["unit / data conversion", /convert|unit|currency|json.?to|csv|yaml|xml/i, true],
  ["crypto / hashing / encoding", /hash|hmac|encode|base64|jwt|cipher|encrypt/i, true],
  ["llm tokens / chunking / embeddings", /token|tokeniz|chunk|embedding|vector|rerank/i, true],
  ["network / dns / tls / whois", /\bdns\b|whois|tls|ssl|certificate|http.?check|uptime/i, true],
  ["government / open data / weather", /weather|gov|census|earthquake|noaa|usgs/i, true],
  // Categories we do NOT currently cover — these are the candidate gaps:
  ["smart contract / onchain / web3", /contract|solidity|onchain|on-chain|abi|etherscan|gas|nft|token.?metadata/i, false],
  ["geocoding / maps / places", /geocod|geocode|map|places|lat.?long|address.?to|reverse.?geo/i, false],
  ["translation / language", /translat|language.?detect|transliterat/i, false],
  ["finance / market / prices", /stock|ticker|forex|crypto.?price|market.?data|quote|exchange.?rate/i, false],
  ["sentiment / classification / NLP", /sentiment|classif|moderat|toxicity|ner|entity|summari/i, false],
  ["email / SMS / notifications", /\bemail\b|\bsms\b|notif|webhook|push/i, false],
  ["barcode / QR / OCR / vision", /barcode|qr.?code|ocr|vision|object.?detect|image.?recogn/i, false],
];

function bucketize(items, getText) {
  const counts = Object.fromEntries(BUCKETS.map((b) => [b[0], 0]));
  let uncategorized = 0;
  const samples = {};
  for (const it of items) {
    const text = getText(it).toLowerCase();
    let matched = false;
    for (const [label, re] of BUCKETS) {
      if (re.test(text)) { counts[label]++; matched = true; if (!samples[label]) samples[label] = getText(it).slice(0, 80); break; }
    }
    if (!matched) { uncategorized++; }
  }
  return { counts, uncategorized };
}

// --- CDP Bazaar ---
const cdp = await getJson(CDP, "Coinbase CDP Bazaar");
let items = [];
if (cdp) {
  items = cdp.resources || cdp.items || cdp.data || (Array.isArray(cdp) ? cdp : []);
  console.log(`  total resources: ${items.length}`);
  const getText = (r) =>
    [r.resource, r.url, r.name, r.description, r.type, ...(r.accepts || []).map((a) => `${a.resource || ""} ${a.description || ""} ${a.extra?.name || ""}`)]
      .filter(Boolean).join(" ");
  const { counts, uncategorized } = bucketize(items, getText);
  console.log("\n## Capability buckets across the CDP Bazaar (count of listings):");
  for (const [label, , ours] of BUCKETS) console.log(`  ${String(counts[label]).padStart(5)}  ${ours ? "[have]" : "[GAP?]"} ${label}`);
  console.log(`  ${String(uncategorized).padStart(5)}  [misc] uncategorized`);
}

// --- agent402.app public Bazaar quality ---
const aq = await getJson(A402, "agent402.app Bazaar quality");
if (aq) console.log("  summary:", JSON.stringify({ total: aq.total_services, avg: aq.avg_quality_score, high: aq.high_quality, low: aq.low_quality, stale: aq.stale }));

console.log("\nDone. [GAP?] buckets with low counts but real agent utility = build candidates.");
