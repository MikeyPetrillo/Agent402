// A network named after an Object.prototype key ("constructor", "__proto__",
// "toString") is an unsupported network: a 400 naming the supported ones,
// never a TypeError read off the prototype. Covers every kit that resolves a
// caller-supplied network name.
import { pickNetwork as chainPick } from "../src/tools/chain-kit.js";
import { pickNetwork as alchemyPick } from "../src/tools/alchemy-data-kit.js";

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log(`ok - ${m}`); } else { fail++; console.error(`FAIL - ${m}`); } };
const refuses = (fn, label) => {
  let err = null;
  try { fn(); } catch (e) { err = e; }
  ok(err && err.statusCode === 400 && /network/i.test(err.message), `${label}: 400 (${err ? `${err.statusCode} ${String(err.message).slice(0, 40)}` : "no error"})`);
};
for (const name of ["constructor", "__proto__", "toString", "hasOwnProperty", "valueOf"]) {
  refuses(() => chainPick(name), `chain-kit refuses "${name}"`);
  refuses(() => alchemyPick(name), `alchemy-data-kit refuses "${name}"`);
}
ok(chainPick("base").name === "base", "chain-kit still resolves a real network");
ok(alchemyPick("ethereum").name === "ethereum", "alchemy-data-kit still resolves a real network");

// The kits without an exported picker resolve names the same way in source.
import { readFileSync } from "node:fs";
for (const f of ["mev-and-l2-kit.js", "nft-market-kit.js", "x402-kit.js"]) {
  const src = readFileSync(new URL(`../src/tools/${f}`, import.meta.url), "utf8");
  ok(/Object\.hasOwn\(NETWORKS, \w+\)/.test(src) && !/=\s*NETWORKS\[(n|key)\];/.test(src), `${f} reads network names as own keys only`);
}
console.log(`\n${fail ? "FAILED" : "OK"}: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
