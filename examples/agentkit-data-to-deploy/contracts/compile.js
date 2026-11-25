#!/usr/bin/env node
// Compiles Agent402PriceSnapshot.sol with solc-js and writes artifact.json
// (abi + creation bytecode + the compiler version + a hash of the source).
// The artifact is committed so the live proof deploys a known blob from a
// pinned dependency tree with no compiler in it; scripts/test-agentkit-data-to-deploy.js
// checks the committed artifact still belongs to the committed source.
//
//   npm i --no-save solc@0.8.28 && node contracts/compile.js
// or, with the compiler installed elsewhere (CI keeps it out of the example):
//   SOLC_DIR=/path/with/node_modules/solc node contracts/compile.js
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const NAME = "Agent402PriceSnapshot";
const source = readFileSync(join(here, `${NAME}.sol`), "utf8");
const solc = process.env.SOLC_DIR ? createRequire(join(process.env.SOLC_DIR, "package.json"))("solc") : (await import("solc")).default;
const input = {
  language: "Solidity",
  sources: { [`${NAME}.sol`]: { content: source } },
  settings: {
    optimizer: { enabled: true, runs: 200 },
    evmVersion: "cancun",
    metadata: { bytecodeHash: "none" },
    outputSelection: { "*": { "*": ["abi", "evm.bytecode.object"] } },
  },
};
const out = JSON.parse(solc.compile(JSON.stringify(input)));
const errors = (out.errors || []).filter((e) => e.severity === "error");
if (errors.length) { for (const e of errors) console.error(e.formattedMessage); process.exit(1); }
const c = out.contracts[`${NAME}.sol`][NAME];
const artifact = {
  contractName: NAME,
  compiler: `solc ${solc.version()}`,
  settings: input.settings,
  sourceSha256: createHash("sha256").update(source).digest("hex"),
  abi: c.abi,
  bytecode: `0x${c.evm.bytecode.object}`,
};
writeFileSync(join(here, "artifact.json"), JSON.stringify(artifact, null, 2) + "\n");
console.log(`${NAME}: ${artifact.compiler}, ${(artifact.bytecode.length - 2) / 2} bytes of creation code, source sha256 ${artifact.sourceSha256.slice(0, 12)}`);
