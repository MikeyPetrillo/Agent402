#!/usr/bin/env node
// A payment log line names a paying wallet by its first characters only.
// /privacy says the refused-payment and timing lines hold "the first
// characters of the paying address"; every other payment log line follows
// the same rule, through shortPayer (src/verify-failure-log.js), which keeps
// the case of a base58 or Stellar address exactly.
//
// The scan reads every console.log/warn/error/info/debug, log, warn and alarm
// call in src/, and names each `${...}` of a template literal and each operand
// of a string concatenation (`"paid by " + payer`) whose expression mentions a wallet-shaped name (payer, from, sender, buyer,
// payTo, wallet, address, signer, authority, owner) without a shortening step
// (shortPayer, maskAddress, mask, short, a fixed .slice(0, n)) or a count.
// String literals inside the expression are not read. A shortening step
// counts only for what it wraps: `c ? shortPayer(p) : p` still prints p.
// In the payment modules (PAYMENT_FILE) a booking or lookup key (key, e.key,
// fooKey) is read as a wallet too, since keys there are built from the payer
// (gateway-nanopayments' network|payer|nonce), and so is a call to a helper
// in the same file whose template prints a wallet unshortened (late-settle's
// labelOf). A line that must keep
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
  "src/gateway-nanopayments.js": {
    "lostDurable ? shortKey(gone.key) : gone.key": "the EVICTED line with no durable store: memory was the last copy of a booking that may be owed back",
    "lostDurable ? shortPayer(gone.payer) : gone.payer": "the same EVICTED line: the wallet a refund would be sent to",
  },
  "src/gateway-settle-breaker.js": {
    'networkOf(key) ? ` on ${networkOf(key)}` : ""': "prints the network read from the key, never the key",
    'networkOf(key) ? " on that network" : ""': "a fixed phrase chosen by the network read from the key",
  },
  "src/stellar-confirm.js": {
    'fbRes?.payer ? ` payer=${shortPayer(fbRes.payer)}` : ""': "the bare payer is only tested for presence; the printed one is shortened",
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
const SHORTENED = /\.slice\(0,\s*\d+\)|\.length\b|\.size\b|[Cc]ount\b/;
const SHORTENING_CALL = /\b(?:shortPayer|shortKey|maskAddress|mask|short)\(/g;
const KEYISH = /(?<![\w$])key\b|[a-z0-9]Key\b/;
// Payment modules: keys there carry the payer.
const PAYMENT_FILE = /^src\/(?:payments|payment-[\w-]+|payer|[\w-]+-payer|gateway-[\w-]+|hangup-[\w-]+|late-settlements|pending-settle|refund-[\w-]+|sales-ledger|revenue-ledger|outbound-ledger|settle[\w-]*|settlement-[\w-]+|credits|idempotency[\w-]*|replay-[\w-]+|mpp-[\w-]+|mcp-mpp|verify-[\w-]+|x402-buyer|solana-buyer|tempo-buyer|prepayment-refusal|svm-[\w-]+|shared-paytos|stripe-shadow-ledger|ledger-journal-redis|ledger-mirror)\.js$/;
/** The expression with every shortening call and its argument list removed. */
function withoutShortened(code) {
  let out = "", last = 0;
  for (const m of code.matchAll(SHORTENING_CALL)) {
    if (m.index < last) continue;
    let i = m.index + m[0].length, depth = 1;
    for (; i < code.length && depth; i++) { const c = code[i]; if (c === "(") depth++; else if (c === ")") depth--; }
    out += code.slice(last, m.index) + '""';
    last = i;
  }
  return out + code.slice(last);
}
/** Names of helpers in `src` whose template prints a wallet unshortened. */
function walletHelpers(src) {
  const names = [];
  for (const d of src.matchAll(/\b(?:const|let)\s+([A-Za-z_$][\w$]*)\s*=\s*\([^)\n]*\)\s*=>([^\n]*)/g)) {
    for (const e of d[2].matchAll(/\$\{([^{}]*)\}/g)) if (WALLETISH.test(withoutShortened(withoutStrings(e[1])))) { names.push(d[1]); break; }
  }
  return names;
}
// Quoted text inside an expression is not code: drop it before matching. A
// nested template keeps its own ${...} parts (they are expressions) and drops
// its text, so the words of `; buyer status: ${tx}` are not read as a wallet
// while a ${payer} inside it still is. One pass reads both: a quote inside
// template text is text (an apostrophe in `payer's ${payer}` opens nothing),
// and a backtick inside a quoted string is text.
const withoutStrings = (expr) => withoutTemplateText(expr);
function withoutTemplateText(code) {
  let out = "", i = 0;
  // A quoted string in code: copied as "" (its text is not code).
  const quoted = (q) => {
    i++;
    while (i < code.length && code[i] !== q) i += code[i] === "\\" ? 2 : 1;
    i++;
    out += '""';
  };
  // Copies code up to the closing brace of a ${...} (or the end), reading nested templates.
  const expr = (stopAtBrace) => {
    let depth = 0;
    while (i < code.length) {
      const c = code[i];
      if (c === "`") { i++; out += "`"; template(); continue; }
      if (c === '"' || c === "'") { quoted(c); continue; }
      if (stopAtBrace && c === "}" && depth === 0) return;
      if (c === "{") depth++; else if (c === "}") depth--;
      out += c; i++;
    }
  };
  // Inside a template: skip text, keep each ${...} with its expression.
  const template = () => {
    while (i < code.length) {
      const c = code[i];
      if (c === "\\") { i += 2; continue; }
      if (c === "`") { i++; out += "`"; return; }
      if (c === "$" && code[i + 1] === "{") { out += "${"; i += 2; expr(true); if (i < code.length) { out += "}"; i++; } continue; }
      i++;
    }
  };
  expr(false);
  return out;
}

// The operands of each top-level string concatenation in a call's argument
// list (`"paid by " + payer`), as { code, text }: `code` with every quoted
// string and template blanked to spaces between its delimiters (same length,
// so it lines up with `text`, the operand as written). An argument with no
// quoted or template operand is not a concatenation and gives nothing.
function concatOperands(arg) {
  let blank = "", i = 0;
  const skipQuoted = (q) => {
    blank += q; i++;
    while (i < arg.length && arg[i] !== q) {
      const step = arg[i] === "\\" ? 2 : 1;
      if (q === "`" && arg[i] === "$" && arg[i + 1] === "{") {
        // A template's ${...}: skip to its closing brace, through nested braces and strings.
        let depth = 0, j = i + 2;
        for (; j < arg.length; j++) {
          const c = arg[j];
          if (c === "{") depth++;
          else if (c === "}") { if (depth === 0) break; depth--; }
          else if (c === '"' || c === "'" || c === "`") { const qq = c; j++; while (j < arg.length && arg[j] !== qq) j += arg[j] === "\\" ? 2 : 1; }
        }
        blank += " ".repeat(Math.min(arg.length, j + 1) - i); i = j + 1; continue;
      }
      blank += " ".repeat(Math.min(step, arg.length - i)); i += step;
    }
    if (i < arg.length) { blank += q; i++; }
  };
  while (i < arg.length) {
    const c = arg[i];
    if (c === '"' || c === "'" || c === "`") { skipQuoted(c); continue; }
    blank += c; i++;
  }
  const out = [];
  let depth = 0, start = 0;
  let operands = [];
  const isLiteral = (s) => /^\s*(["'`])\s*\1\s*$/.test(s);
  const flush = (end, last) => {
    operands.push([start, end]);
    if (last) {
      if (operands.length > 1 && operands.some(([a, b]) => isLiteral(blank.slice(a, b)))) {
        for (const [a, b] of operands) if (!isLiteral(blank.slice(a, b))) out.push({ code: blank.slice(a, b), text: arg.slice(a, b).trim() });
      }
      operands = [];
    }
    start = end + 1;
  };
  for (let k = 0; k < blank.length; k++) {
    const c = blank[k];
    if (c === "(" || c === "[" || c === "{") depth++;
    else if (c === ")" || c === "]" || c === "}") depth--;
    else if (depth === 0 && c === ",") flush(k, true);
    else if (depth === 0 && c === "+" && blank[k + 1] !== "+" && blank[k + 1] !== "=" && blank[k - 1] !== "+") flush(k, false);
  }
  flush(blank.length, true);
  return out;
}

let concatSeen = 0; // concatenation operands read, so a clean tree is a result
/** Every flagged interpolation in `src` as { line, expr }. */
function scanLogCalls(src, payment = false) {
  const out = [];
  const helpers = payment ? walletHelpers(src) : [];
  const helperCall = helpers.length ? new RegExp(`(?<![\\w$.])(?:${helpers.join("|")})\\(`) : null;
  for (const m of src.matchAll(CALL)) {
    let i = m.index + m[0].length, depth = 1;
    const end = Math.min(src.length, i + 4000);
    for (; i < end && depth; i++) { const c = src[i]; if (c === "(") depth++; else if (c === ")") depth--; }
    const arg = src.slice(m.index + m[0].length, i - 1);
    const line = src.slice(0, m.index).split("\n").length;
    const flagged = (code) => {
      if (SHORTENED.test(code)) return false;
      const bare = withoutShortened(code);
      return WALLETISH.test(bare) || (payment && (KEYISH.test(bare) || (helperCall && helperCall.test(bare))));
    };
    // A wallet joined to text with `+` prints as surely as one interpolated.
    for (const o of concatOperands(arg)) { concatSeen++; if (flagged(withoutStrings(o.text))) out.push({ line, expr: o.text }); }
    if (!arg.includes("`")) continue;
    for (const e of arg.matchAll(/\$\{((?:[^{}]|\{(?:[^{}]|\{[^{}]*\})*\})*)\}/g)) {
      if (flagged(withoutStrings(e[1]))) out.push({ line, expr: e[1].trim() });
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
    "log(`[x] ${ok ? `; buyer status: GET /x?tx=${row.tx}` : \"\"}`);",
    "log(`[x] ${ok ? `; status for ${entry.payer}` : \"\"}`);",
    "log(`[x] ${ok ? `the payer's wallet ${row.payer} isn't settled` : \"\"}`);",
    'console.warn("[x] paid by " + payer + " on " + network);',
    "log('[x] refused ' + auth.from);",
    'log("[x] ok " + shortPayer(payer) + " of " + list.length + " wallets", payer);',
    'log("[x] " + (ok ? "the buyer\'s wallet" : "none") + ` n=${n}`);',
  ].join("\n");
  const hits = scanLogCalls(sample).map((h) => h.expr);
  const want = ["payer", "auth.from", "ok ? `; status for ${entry.payer}` : \"\"", "ok ? `the payer's wallet ${row.payer} isn't settled` : \"\"", "payer", "auth.from"];
  ok(hits.join("|") === want.join("|"), `control: the scanner flags a bare payer and a from, interpolated or joined with +, passes shortened values, counts and quoted words, and reads a wallet (not the words) inside a nested template, an apostrophe in its text included (${hits.join(", ")})`);
  const pay = [
    "const labelOf = (e) => `auth ${e.payer}/${e.nonce}`;",
    "const okLabel = (e) => `auth ${shortPayer(e.payer)}`;",
    "log(`[g] entry ${key} resolved`);",
    "log(`[g] evicted ${e.key} and ${cacheKey}`);",
    "log(`[g] ${labelOf(e)} and ${okLabel(e)}`);",
    "log(`[g] ${durable ? shortPayer(p.payer) : p.payer}`);",
    "log(`[g] ok ${shortKey(key)} ${keys.length} ${monkey}`);",
  ].join("\n");
  const payHits = scanLogCalls(pay, true).map((h) => h.expr);
  ok(payHits.join("|") === "key|e.key|cacheKey|labelOf(e)|durable ? shortPayer(p.payer) : p.payer", `control: in a payment module a key, a payer-printing helper and an unshortened ternary branch are flagged (${payHits.join(", ")})`);
  ok(scanLogCalls(pay, false).map((h) => h.expr).join("|") === "durable ? shortPayer(p.payer) : p.payer", "control: outside the payment modules a key is not read as a wallet");
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
  for (const h of scanLogCalls(src, PAYMENT_FILE.test(rel))) {
    if (ALLOW[rel] && Object.hasOwn(ALLOW[rel], h.expr)) { used.add(`${rel}\u0000${h.expr}`); continue; }
    bad.push(`${rel}:${h.line} \${${h.expr.slice(0, 80)}}`);
  }
}
ok(calls > 500, `the scan read ${calls} log calls`);
ok(concatSeen > 8, `the scan read ${concatSeen} operands of string concatenations`);
ok(bad.length === 0, `no log line in src/ prints a wallet in full outside the allowlist${bad.length ? `: ${bad.join("; ")}` : ""}`);
const stale = Object.entries(ALLOW).flatMap(([file, m]) => Object.keys(m).filter((expr) => !used.has(`${file}\u0000${expr}`)).map((expr) => `${file} \${${expr}}`));
ok(stale.length === 0, `every allowlist entry still names a line${stale.length ? ` (stale: ${stale.join("; ")})` : ""}`);

console.log(`\ntest-log-payer-short: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
