#!/usr/bin/env node
// The buyer packages price an x402 accept from a table of known assets
// (known-assets.js), never from a decimals value in the challenge. Each
// package is published on its own, so each carries the file; this keeps the
// copies byte-identical and checks the table against what the server offers:
//   - every rail in src/rails.js has an entry,
//   - every EVM asset address is the one src/payments.js or @x402/evm's own
//     default table names for that chain, with the same decimals,
//   - Solana, Stellar and Algorand match their @x402 scheme packages.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createRequire } from "node:module";

const ROOT = new URL("..", import.meta.url).pathname;
let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log(`ok - ${m}`); } else { fail++; console.log(`FAIL - ${m}`); } };

const COPIES = ["client/known-assets.js", "mcp/known-assets.js", "openclaw/known-assets.js"];
const texts = COPIES.map((p) => readFileSync(join(ROOT, p), "utf8"));
for (let i = 1; i < COPIES.length; i++) ok(texts[i] === texts[0], `${COPIES[i]} is byte-identical to ${COPIES[0]}`);
for (const p of COPIES) {
  const pkg = JSON.parse(readFileSync(join(ROOT, p.split("/")[0], "package.json"), "utf8"));
  ok((pkg.files || []).includes("known-assets.js"), `${pkg.name} ships known-assets.js in its "files"`);
}

const { KNOWN_ASSETS, acceptUsd, knownAsset } = await import(join(ROOT, "client/known-assets.js"));
const { RAILS } = await import(join(ROOT, "src/rails.js"));
for (const r of RAILS) {
  const list = KNOWN_ASSETS[r.caip2] || [];
  ok(list.some((e) => e.symbol === r.asset), `rail ${r.name} (${r.caip2}) has a known ${r.asset} entry`);
}

// The EVM table: each address appears in src/payments.js or in @x402/evm's
// default-asset chunk beside its chain, with decimals 6.
const payments = readFileSync(join(ROOT, "src/payments.js"), "utf8");
const require = createRequire(join(ROOT, "package.json"));
const evmDir = join(require.resolve("@x402/evm").split("/dist/")[0], "dist", "esm");
const { readdirSync } = await import("node:fs");
const evmSrc = readdirSync(evmDir).filter((f) => f.endsWith(".mjs")).map((f) => readFileSync(join(evmDir, f), "utf8")).join("\n");
for (const [network, list] of Object.entries(KNOWN_ASSETS)) {
  if (!network.startsWith("eip155:")) continue;
  for (const e of list) {
    const inPayments = payments.toLowerCase().includes(e.asset.toLowerCase());
    const block = evmSrc.match(new RegExp(`"${network}":\\s*\\[\\s*\\{[^\\]]*?asset:\\s*"(0x[0-9a-fA-F]{40})"[^\\]]*?decimals:\\s*(\\d+)`));
    const inEvm = block && block[1].toLowerCase() === e.asset.toLowerCase() && Number(block[2]) === e.decimals;
    ok(e.decimals === 6 && (inPayments || inEvm), `${network} ${e.symbol} ${e.asset} is the asset the server offers (${inPayments ? "src/payments.js" : inEvm ? "@x402/evm default" : "not found"})`);
  }
}
const pkgText = (name) => {
  const dir = join(require.resolve(name).split("/dist/")[0], "dist", "esm");
  return readdirSync(dir).filter((f) => f.endsWith(".mjs")).map((f) => readFileSync(join(dir, f), "utf8")).join("\n");
};
const svm = pkgText("@x402/svm"), stellar = pkgText("@x402/stellar"), avm = pkgText("@x402/avm");
ok(svm.includes(`USDC_MAINNET_ADDRESS = "${KNOWN_ASSETS["solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp"][0].asset}"`), "Solana USDC mint matches @x402/svm");
ok(stellar.includes(`USDC_PUBNET_ADDRESS = "${KNOWN_ASSETS["stellar:pubnet"][0].asset}"`) && /DEFAULT_TOKEN_DECIMALS = 7;/.test(stellar) && KNOWN_ASSETS["stellar:pubnet"][0].decimals === 7, "Stellar USDC contract and its 7 decimals match @x402/stellar");
ok(avm.includes(`USDC_MAINNET_ASA_ID = "${KNOWN_ASSETS["algorand:wGHE2Pwdvd7S12BL5FaOP20EGYesN73k"][0].asset}"`), "Algorand USDC ASA matches @x402/avm");
ok(avm.includes(`ALGORAND_MAINNET_CAIP2 = "algorand:wGHE2Pwdvd7S12BL5FaOP20EGYesN73k"`), "the Algorand mainnet key is the CAIP-2 id @x402/avm names");
ok(JSON.stringify(KNOWN_ASSETS["algorand:wGHE2Pwdvd7S12BL5FaOP20EGYesN73ktiC1qzkkit8="]) === JSON.stringify(KNOWN_ASSETS["algorand:wGHE2Pwdvd7S12BL5FaOP20EGYesN73k"]), "the full-hash spelling of Algorand mainnet prices the same asset");

// The pricing contract itself.
const BASE = KNOWN_ASSETS["eip155:8453"][0].asset;
ok(acceptUsd({ network: "eip155:8453", asset: BASE, amount: "1500000", extra: { decimals: 18 } }) === 1.5, "a decimals hint in the accept is ignored");
ok(acceptUsd({ network: "eip155:8453", asset: "0x000000000000000000000000000000000000bEEF", amount: "1" }) === null, "an unknown asset cannot be priced");
ok(knownAsset("eip155:8453", BASE.toLowerCase()) && !knownAsset("stellar:pubnet", KNOWN_ASSETS["stellar:pubnet"][0].asset.toLowerCase()), "EVM addresses match without case; Stellar ones exactly");

// A table change ships only with a version bump: scripts/known-assets-pins.json
// holds the table's sha256 at the package version it was pinned at (no
// network: the published tarball is not read). A table that differs from its
// pin needs a version past the pinned one, then
// `node scripts/test-known-assets.js --write` to re-pin; a bump alone re-pins nothing.
{
  const { createHash } = await import("node:crypto");
  const { writeFileSync } = await import("node:fs");
  const PINS = join(ROOT, "scripts/known-assets-pins.json");
  const pins = JSON.parse(readFileSync(PINS, "utf8"));
  const current = Object.fromEntries(COPIES.map((p, i) => [p.split("/")[0], { version: JSON.parse(readFileSync(join(ROOT, p.split("/")[0], "package.json"), "utf8")).version, sha256: createHash("sha256").update(texts[i]).digest("hex") }]));
  if (process.argv.includes("--write")) { writeFileSync(PINS, JSON.stringify(current, null, 2) + "\n"); Object.assign(pins, current); console.log(`wrote ${PINS}`); }
  for (const [dir, now] of Object.entries(current)) {
    const pin = pins[dir] || {};
    ok(now.sha256 === pin.sha256 || now.version !== pin.version, `${dir}/known-assets.js changed since ${pin.version || "?"}, so ${dir}/package.json must bump its version`);
    ok(now.sha256 === pin.sha256, `${dir} pin records its table at ${pin.version || "?"} (after the bump, run with --write)`);
  }
}

console.log(`\n${fail ? "FAILED" : "OK"}: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
