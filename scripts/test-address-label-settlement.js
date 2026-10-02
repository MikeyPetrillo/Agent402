#!/usr/bin/env node
// address-label says its dataset holds "the USDC and USDG contracts of every
// EVM chain we settle on". Until 2026-10-02 it said "USDC on every chain we
// settle on" while holding only Base, Ethereum, Polygon, Arbitrum and
// Optimism - Avalanche, Sei, Monad, Celo and Robinhood Chain were missing.
//
// Pins both directions of that claim, offline:
//   1. every stablecoin address literal in src/payments.js's accept config is
//      labelled, under its own address;
//   2. every EVM rail in src/rails.js has a stablecoin label for its network.
import { readFileSync } from "node:fs";
import { CONTRACT_TOOLS } from "../src/tools/contract-kit.js";
import { RAILS } from "../src/rails.js";

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) pass++; else { fail++; console.error("FAIL:", m); } };

const tool = CONTRACT_TOOLS.find((t) => t.slug === "address-label");
ok(!!tool, "address-label exists");
ok(/every EVM chain we settle on/.test(tool.description), "description scopes the claim to EVM settlement chains");

const payments = readFileSync(new URL("../src/payments.js", import.meta.url), "utf8");
const assets = [...payments.matchAll(/asset:[^\n]*?"(0x[0-9a-fA-F]{40})"/g)].map((m) => m[1].toLowerCase());
ok(assets.length >= 6, `payments.js accept assets read (${assets.length})`);
for (const a of assets) {
  const r = await tool.handler({ address: a });
  ok(r.found && r.labels.some((l) => /^USD[CG]$/.test(l.label)), `settlement asset ${a} is labelled`);
}

const stableNetworks = new Set();
for (const t of [
  "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913", "0x3c499c542cef5e3811e1192ce70d8cc03d5c3359", "0xaf88d065e77c8cc2239327c5edb3a432268e5831", ...assets,
]) {
  const r = await tool.handler({ address: t });
  for (const l of r.labels || []) if (/^USD[CG]$/.test(l.label)) stableNetworks.add(l.network);
}
for (const rail of RAILS.filter((r) => r.chainId)) {
  const net = rail.name.toLowerCase().replace(/ chain$/, "");
  ok(stableNetworks.has(net), `EVM rail ${rail.name}: its ${rail.asset} contract is labelled (network "${net}")`);
}
const sample = await tool.handler({ address: assets[0] });
ok(sample.provenance.entries >= 39, "provenance counts the grown dataset");
ok(tool.discovery.output.example.provenance.updated === sample.provenance.updated && tool.discovery.output.example.provenance.entries === sample.provenance.entries,
  "the published example's provenance matches the live dataset");

console.log(`test-address-label-settlement: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
