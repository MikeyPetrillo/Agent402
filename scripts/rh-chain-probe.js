// Robinhood Chain reachability + USDG verification probe. The sandbox can't
// reach external RPCs, so this runs in CI (which has network) to (a) prove the
// chain params baked into x402-kit are correct and the public RPC is live, and
// (b) read USDG's on-chain EIP-712 domain (name/version) + metadata so the
// payments-layer defaults in src/payments.js can be verified/corrected before
// anyone enables `robinhood` in PAYMENT_NETWORKS.
//
// It does NOT settle an x402 payment — that needs a USDG-funded buyer on chain
// 4663 through the configured external facilitator. This validates everything up
// to the point of an actual transfer, so enabling Robinhood Chain payments is a
// verified config flip, not a guess.
//
// Set ROBINHOOD_FACILITATOR_URL to also probe the facilitator's /supported
// endpoint (confirms it advertises exact/eip155:4663/USDG); omit to skip that.
//
//   ROBINHOOD_FACILITATOR_URL=<facilitator-url> node scripts/rh-chain-probe.js
const MAIN = { url: "https://rpc.mainnet.chain.robinhood.com", chainId: 4663 };
const TEST = { url: "https://rpc.testnet.chain.robinhood.com", chainId: 46646 };
const USDG = "0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168";
const FACILITATOR_URL = (process.env.ROBINHOOD_FACILITATOR_URL || "").trim().replace(/\/$/, "");
const FACILITATOR_SUPPORTED = FACILITATOR_URL ? `${FACILITATOR_URL}/supported` : "";

// ERC-20 / EIP-712 selectors
const SEL = {
  name: "0x06fdde03", symbol: "0x95d89b41", decimals: "0x313ce567",
  version: "0x54fd4d50", eip712Domain: "0x84b0196e", DOMAIN_SEPARATOR: "0x3644e515",
};

async function rpc(url, method, params = []) {
  const r = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
    signal: AbortSignal.timeout(15000),
  });
  const j = await r.json();
  if (j.error) throw new Error(`${method}: ${JSON.stringify(j.error)}`);
  return j.result;
}
const ethCall = (url, to, data) => rpc(url, "eth_call", [{ to, data }, "latest"]);

// Decode a single ABI-encoded `string` return (head is one 0x20 offset word).
function decodeAbiString(hex) {
  if (!hex || hex === "0x") return null;
  const h = hex.slice(2);
  const len = parseInt(h.slice(64, 128), 16);
  if (!Number.isFinite(len) || len <= 0 || len * 2 > h.length - 128) return null;
  return Buffer.from(h.slice(128, 128 + len * 2), "hex").toString("utf8");
}
// Decode name+version out of an eip712Domain() (EIP-5267) tuple return.
// Layout: fields(bytes1) name(string@off) version(string@off) chainId(uint) ...
function decodeEip712Domain(hex) {
  if (!hex || hex === "0x") return {};
  const h = hex.slice(2);
  const word = (i) => h.slice(i * 64, i * 64 + 64);
  const strAt = (byteOffset) => {
    const base = byteOffset * 2;
    const len = parseInt(h.slice(base + 64, base + 128), 16);
    if (!Number.isFinite(len) || len <= 0) return null;
    return Buffer.from(h.slice(base + 128, base + 128 + len * 2), "hex").toString("utf8");
  };
  try {
    return { name: strAt(parseInt(word(1), 16)), version: strAt(parseInt(word(2), 16)) };
  } catch { return {}; }
}

let ok = true;

for (const [name, c] of [["mainnet", MAIN], ["testnet", TEST]]) {
  console.log(`\n=== Robinhood Chain ${name} (${c.url}) ===`);
  try {
    const [idHex, blkHex, gasHex] = await Promise.all([
      rpc(c.url, "eth_chainId"), rpc(c.url, "eth_blockNumber"), rpc(c.url, "eth_gasPrice"),
    ]);
    const chainId = parseInt(idHex, 16);
    console.log(`  chainId ${chainId} (${idHex}) | block ${parseInt(blkHex, 16)} | gas ${(Number(BigInt(gasHex)) / 1e9).toFixed(6)} gwei`);
    if (chainId !== c.chainId) { console.log(`  >>> MISMATCH expected ${c.chainId}`); if (name === "mainnet") ok = false; }
    else console.log(`  >>> OK: ${name} reachable, chainId matches`);
  } catch (e) {
    console.log(`  UNREACHABLE: ${e?.message || e}`);
    if (name === "mainnet") ok = false;
  }
}

console.log(`\n=== USDG token on mainnet (${USDG}) — verify EIP-712 domain for signing ===`);
try {
  const [nm, sym, dec] = await Promise.all([
    ethCall(MAIN.url, USDG, SEL.name).then(decodeAbiString).catch(() => null),
    ethCall(MAIN.url, USDG, SEL.symbol).then(decodeAbiString).catch(() => null),
    ethCall(MAIN.url, USDG, SEL.decimals).then((x) => (x && x !== "0x" ? parseInt(x, 16) : null)).catch(() => null),
  ]);
  console.log(`  name()=${JSON.stringify(nm)}  symbol()=${JSON.stringify(sym)}  decimals()=${dec}`);

  let ver = await ethCall(MAIN.url, USDG, SEL.version).then(decodeAbiString).catch(() => null);
  const dom = await ethCall(MAIN.url, USDG, SEL.eip712Domain).then(decodeEip712Domain).catch(() => ({}));
  const ds = await ethCall(MAIN.url, USDG, SEL.DOMAIN_SEPARATOR).then((x) => x && x !== "0x").catch(() => false);
  if (!ver && dom.version) ver = dom.version;
  console.log(`  version()=${JSON.stringify(ver)}  eip712Domain()=${JSON.stringify(dom)}  DOMAIN_SEPARATOR present=${ds}`);

  const eip712Name = dom.name || nm;
  const eip712Version = ver;
  console.log(`  >>> EIP-712 domain to configure in payments.js:`);
  console.log(`        ROBINHOOD_USDG_EIP712_NAME    = ${JSON.stringify(eip712Name)}   (payments.js default "Global Dollar")`);
  console.log(`        ROBINHOOD_USDG_EIP712_VERSION = ${JSON.stringify(eip712Version)}   (payments.js default "1")`);
  if (!ds) console.log(`  >>> WARNING: no DOMAIN_SEPARATOR() — USDG may not use standard EIP-712/EIP-3009; confirm the facilitator's expected signing scheme before enabling.`);
} catch (e) {
  console.log(`  USDG read failed: ${e?.message || e}`);
}

if (FACILITATOR_SUPPORTED) {
  console.log(`\n=== facilitator /supported (${FACILITATOR_SUPPORTED}) ===`);
  try {
    const r = await fetch(FACILITATOR_SUPPORTED, { headers: { Accept: "application/json" }, signal: AbortSignal.timeout(15000) });
    const body = await r.text();
    console.log(`  HTTP ${r.status}`);
    if (r.ok) {
      try {
        const j = JSON.parse(body);
        const kinds = (j.kinds || []).map((k) => `v${k.x402Version} ${k.scheme} ${k.network} ${k.extra?.symbol || ""}`);
        console.log(`  kinds: ${JSON.stringify(kinds)}`);
        const has4663 = (j.kinds || []).some((k) => String(k.network) === "eip155:4663");
        console.log(`  >>> settles Robinhood Chain (eip155:4663): ${has4663}`);
      } catch { console.log(`  body: ${body.slice(0, 300)}`); }
    } else {
      console.log(`  (non-200 — likely bot protection from a CI runner; fetch it from a browser to confirm)`);
    }
  } catch (e) {
    console.log(`  fetch failed: ${e?.message || e} (the facilitator may block automated fetches; this is informational only)`);
  }
} else {
  console.log(`\n=== facilitator /supported — skipped (set ROBINHOOD_FACILITATOR_URL to probe) ===`);
}

console.log(`\n${ok ? "PASS" : "FAIL"}: Robinhood Chain mainnet read path`);
process.exit(ok ? 0 : 1);
