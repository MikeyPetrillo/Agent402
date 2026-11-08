#!/usr/bin/env node
// The per-payer, global and per-chain 24 h spending ceilings and the EVM
// low-balance refusal are reserved by the CALLERS of the outside-seller
// buyers (route-execute, seller-payability, flights), not inside payX402 or
// payTempo. So every call into a buyer from the shipped tree is listed here,
// with the kit that reserves for it: a new caller fails this check until it
// reserves against the same ceilings and is added below.
import "./lib/offline-stores.js"; // per-process and file backends whatever the caller exports (see the file)
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log(`ok - ${m}`); } else { fail++; console.log(`FAIL - ${m}`); } };

const walk = (d) => readdirSync(d).flatMap((n) => {
  const p = join(d, n);
  return statSync(p).isDirectory() ? walk(p) : p.endsWith(".js") ? [p] : [];
});
const BUYERS = new Set(["src/x402-buyer.js", "src/tempo-buyer.js"]);
const CALL = /\b(payX402|payTempo)\(/g;
const sites = [];
for (const f of walk(join(ROOT, "src"))) {
  const rel = relative(ROOT, f);
  if (BUYERS.has(rel)) continue;
  const lines = readFileSync(f, "utf8").split("\n");
  lines.forEach((line, i) => {
    const t = line.trim();
    if (t.startsWith("//") || t.startsWith("*")) return;
    if (/export (async )?function (payX402|payTempo)\b/.test(t)) return;
    for (const m of line.matchAll(CALL)) sites.push({ rel, line: i + 1, text: t, fn: m[1] });
  });
}

// Each allowed call site: the wiring line it lives on, and the kit that
// reserves against the shared ceilings before it pays.
const ALLOWED = [
  { name: "route-execute (payExternal)", match: /payExternal: \(url, opts\) => \{ const o = \{ \.\.\.opts, memoizeDelivery: true \}; return opts\?\.chain === "tempo" \? payTempo\(url, o\) : payX402\(url, o\); \}/, kit: "src/tools/route-execute.js", reserve: /await reserveSpend\(/ },
  { name: "seller-payability", match: /^pay: async \(url, opts\) => \(await import\("\.\/x402-buyer\.js"\)\)\.payX402\(url, opts\),$/, kit: "src/tools/seller-payability-kit.js", reserve: /await reserve\(spendPayer, /, },
  { name: "flights", match: /^pay: async \(url, opts\) => \(await import\("\.\/x402-buyer\.js"\)\)\.payX402\(url, opts\),$/, kit: "src/tools/flights-kit.js", reserve: /await reserve\(spendPayer, /, },
];

const unknown = sites.filter((s) => !(s.rel === "src/server.js" && ALLOWED.some((a) => a.match.test(s.text))));
ok(unknown.length === 0, `every call into the outside-seller buyers is a listed caller${unknown.length ? `:\n  ${unknown.map((s) => `${s.rel}:${s.line} ${s.text.slice(0, 100)}`).join("\n  ")}` : ""}`);
const serverCalls = sites.filter((s) => s.rel === "src/server.js").length;
ok(serverCalls === 4, `the three listed callers make the four known calls (route-execute's two rails, seller-payability, flights; found ${serverCalls})`);
for (const a of ALLOWED) {
  const src = readFileSync(join(ROOT, a.kit), "utf8");
  const imports = /import \{[^}]*\breserveSpend\b[^}]*\} from "\.\.\/external-spend-guard\.js"/.test(src);
  ok(imports && a.reserve.test(src), `${a.name} imports the shared reserve and books against it before it pays (${a.kit})`);
}

console.log(`\ntest-buyer-callers: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
