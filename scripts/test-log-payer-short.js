#!/usr/bin/env node
// A payment log line names a paying wallet by its first characters only.
// /privacy says the refused-payment and timing lines hold "the first
// characters of the paying address"; every other payment log line follows
// the same rule, through shortPayer (src/verify-failure-log.js), which keeps
// the case of a base58 or Stellar address exactly.
//
// The scan reads every console.log/warn/error/info/debug, log, warn and alarm
// call in src/ whose argument is a template literal, and names each `${...}`
// whose expression mentions a wallet-shaped name (payer, from, sender, buyer,
// payTo, wallet, address, signer, authority, owner) without a shortening step
// (shortPayer, maskAddress, mask, short, a fixed .slice(0, n)) or a count.
// String literals inside the expression are not read. A line that must keep
// the full address is in ALLOW with its reason; an ALLOW entry that no longer
// matches anything fails too, so the list never outlives its lines.
// The scanner is exercised on a sample first, so a clean tree is a result and
// not a scanner that read nothing. Offline.
import "./lib/offline-stores.js"; // per-process and file backends whatever the caller exports (see the file)
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log(`ok - ${m}`); } else { fail++; console.error(`FAIL - ${m}`); } };

// file -> expression text (as written) -> why the full value is printed.
const ALLOW = {
  "src/late-settlements.js": {
    "byAuth ? `auth ${c.payer}/${c.nonce}` : `tx ${c.tx}`": "the could-NOT-be-recorded alarm: store and journal both refused, so this line is the only record of who is owed",
    "entry.payer": "the same alarm: the wallet a refund would be sent to",
  },
  "src/paid-phase-timing.js": {
    'row.payer || "-"': "already the first six characters (cut when the row is built)",
  },
  "src/payments.js": {
    "client.address": "our own relayer wallet, not a buyer",
    'r.signer || "(unknown)"': "a facilitator's signer wallet, not a buyer",
    "owner": "our own Solana payTo, not a buyer",
  },
};

const CALL = /(?<![\w$.])(?:console\.(?:log|warn|error|info|debug)|log|warn|alarm)\s*\(/g;
const WALLETISH = /\b(payer|payers|from|sender|buyer|payTo|wallet|address|signer|authority|owner)\b/i;
const SHORTENED = /\bshortPayer\(|\bmaskAddress\(|\bmask\(|\bshort\(|\.slice\(0,\s*\d+\)|\.length\b|\.size\b|[Cc]ount\b/;
// Quoted text inside an expression is not code: drop it before matching. A
// nested template keeps its own ${...} parts (they are expressions).
const withoutStrings = (expr) => expr.replace(/"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'/g, '""').replace(/`(?:[^`\\$]|\\.|\$(?!\{))*`/g, "``");

/** Every flagged interpolation in `src` as { line, expr }. */
function scanLogCalls(src) {
  const out = [];
  for (const m of src.matchAll(CALL)) {
    let i = m.index + m[0].length, depth = 1;
    const end = Math.min(src.length, i + 4000);
    for (; i < end && depth; i++) { const c = src[i]; if (c === "(") depth++; else if (c === ")") depth--; }
    const arg = src.slice(m.index + m[0].length, i - 1);
    if (!arg.includes("`")) continue;
    for (const e of arg.matchAll(/\$\{((?:[^{}]|\{(?:[^{}]|\{[^{}]*\})*\})*)\}/g)) {
      const code = withoutStrings(e[1]);
      if (!WALLETISH.test(code) || SHORTENED.test(code)) continue;
      out.push({ line: src.slice(0, m.index).split("\n").length, expr: e[1].trim() });
    }
  }
  return out;
}

// Control: the scanner reads a sample the way it reads the tree.
{
  const sample = [
    "log(`[x] refused ${payer} on ${network}`);",
    "console.warn(`[x] ${auth.from} nonce ${n}`);",
    "log(`[x] ok ${shortPayer(payer)} and ${maskAddress(addr)} ${list.length} wallets`);",
    'log(`[x] ${ok ? "resolve it by hand from this line" : "kept"}`);',
    "Math.log(payer);",
  ].join("\n");
  const hits = scanLogCalls(sample).map((h) => h.expr);
  ok(hits.join("|") === "payer|auth.from", `control: the scanner flags a bare payer and a from, and passes shortened values, counts and quoted words (${hits.join(", ")})`);
}

const files = [];
(function walk(d) {
  for (const n of readdirSync(d)) {
    const p = join(d, n);
    if (statSync(p).isDirectory()) { if (n !== "generated" && n !== "node_modules") walk(p); } else if (n.endsWith(".js")) files.push(p);
  }
})(join(ROOT, "src"));
ok(files.length > 100, `read ${files.length} source files under src/`);

const used = new Set();
const bad = [];
let calls = 0;
for (const f of files) {
  const rel = relative(ROOT, f).split("\\").join("/");
  const src = readFileSync(f, "utf8");
  calls += (src.match(CALL) || []).length;
  for (const h of scanLogCalls(src)) {
    if (ALLOW[rel] && Object.hasOwn(ALLOW[rel], h.expr)) { used.add(`${rel}\u0000${h.expr}`); continue; }
    bad.push(`${rel}:${h.line} \${${h.expr.slice(0, 80)}}`);
  }
}
ok(calls > 500, `the scan read ${calls} log calls`);
ok(bad.length === 0, `no log line in src/ prints a wallet in full outside the allowlist${bad.length ? `: ${bad.join("; ")}` : ""}`);
const stale = Object.entries(ALLOW).flatMap(([file, m]) => Object.keys(m).filter((expr) => !used.has(`${file}\u0000${expr}`)).map((expr) => `${file} \${${expr}}`));
ok(stale.length === 0, `every allowlist entry still names a line${stale.length ? ` (stale: ${stale.join("; ")})` : ""}`);

console.log(`\ntest-log-payer-short: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
