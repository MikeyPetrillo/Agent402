#!/usr/bin/env node
// Every fetch in src/ that does not go through the egress guard is on this
// list, with the reason it is allowed to be raw.
//
//   node scripts/test-raw-fetch-audit.js          (offline)
//
// WHY: src/tools/fetch-guard.js is the egress policy (a public-address check
// before the request, the connection pinned to the validated address on every
// hop, a timeout that bounds headers and body, a size cap). A call that reaches
// the network some other way is outside that policy, and nothing said so: the
// guard was adopted kit by kit, and a raw `fetch(` of a URL a buyer or a crawled
// seller chose looks exactly like a raw `fetch(` of a vendor's fixed endpoint.
// This audit classifies every site once, and from now on a new raw fetch has to
// be classified here before it ships.
//
// CLASSES
//   input    The URL is, or can be, request input or crawled seller data. A raw
//            call is allowed only because the caller needs the raw Response
//            (a 402 status, a redirect hop, the response headers), which
//            safeFetch does not return. Every one pins the connection to a
//            validated public address (ssrfDispatcher) and is checked for it.
//   fixed    A constant first-party or vendor host; input reaches the path,
//            the query or the body, never the host. Must carry a timeout.
//   loopback A replay over 127.0.0.1 by design.
//   snippet  A code sample inside a string a page prints; never executed here.
//   prose    The word in running text inside a string.
//   guard    The guard's own transport.
//   wrapper  Captures globalThis.fetch to wrap it (metering, drain, timing).
//
// Two shapes count as a site: a call (`fetch(` or `globalThis.fetch(`) and a
// default implementation (`fetchImpl = fetch`, `|| globalThis.fetch`). A file's sites are matched to
// its entries in order of appearance, so a line move never fails this and a new
// site always does.
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, dirname, relative } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SRC = join(ROOT, "src");

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log(`ok - ${m}`); } else { fail++; console.error(`FAIL - ${m}`); } };

// `t: "init"` means the timeout rides in an init object built elsewhere in the
// function (or by the caller of a pass-through); `g: "init"` the same for the
// pinned dispatcher. Both are stated, never assumed.
const F = (note, extra = {}) => ({ cls: "fixed", note, ...extra });
const I = (note, extra = {}) => ({ cls: "input", note, ...extra });
const S = { cls: "snippet", note: "code sample in a page string" };
const P = { cls: "prose", note: "the word in running text" };

// Call sites, per file, in order of appearance.
const CALLS = {
  "src/adapter-docs.js": [P, P],
  "src/algorand-sellers.js": [F("Algorand facilitator, configured base")],
  "src/backup.js": [F("object store endpoint from config, SigV4 signed")],
  "src/email.js": [F("mail provider A"), F("mail provider B")],
  "src/evm-logs-rpc.js": [F("pass-through default; RPC lanes are configuration", { t: "init" })],
  "src/guides.js": [S, S, S, S, S],
  "src/leaderboard.js": [F("discovery directory, fixed base"), F("RPC list from configuration")],
  "src/mpp-subscriptions.js": [F("Tempo RPC from configuration")],
  "src/mpp-tempo.js": [F("MPP relay, fixed base"), F("MPP relay retry, same init", { t: "init" })],
  "src/pages.js": [S, S],
  "src/payments.js": [F("Solana public RPC, boot-time check")],
  "src/pow.js": [S, S],
  "src/revenue-ledger.js": [F("Stellar Horizon")],
  "src/revenue-live.js": [F("configured bases, walked"), F("configured RPC list"), F("Stellar Horizon"), F("chain explorer, fixed host")],
  "src/server.js": [
    I("seller-payability probe; the kit asserts the URL and sets redirect manual and the timeout", { t: "init" }),
    F("analytics proxy: fixed ingest and assets hosts, request path", { t: "init" }),
  ],
  "src/skills.js": [P],
  "src/solana-history-rpc.js": [F("pass-through default; RPC lanes are configuration", { t: "init" })],
  "src/tempo-buyer.js": [
    F("Tempo RPC from configuration"),
    I("seller bare leg: init() carries the pinned dispatcher, redirect manual and the deadline", { t: "init", g: "init" }),
    I("seller paid leg: same init()", { t: "init", g: "init" }),
  ],
  "src/tools/b20-kit.js": [F("Base RPC list, pinned")],
  "src/tools/crawl-kit.js": [I("crawl hop: asserted per hop, pinned, redirect manual, budget signal")],
  "src/tools/cve-kit.js": [F("pass-through default; NVD is the only host", { t: "init" })],
  "src/tools/domain-audit-kit.js": [F("DNS over HTTPS resolver")],
  "src/tools/embed-kit.js": [F("embeddings vendor")],
  "src/tools/fetch-guard.js": [{ cls: "guard", note: "probePublicUrl" }, { cls: "guard", note: "safeFetch" }],
  "src/tools/image-gen-kit.js": [F("image vendor")],
  "src/tools/kit.js": [
    F("IANA RDAP bootstrap, pinned"),
    I("url-status: asserted, pinned, needs the status and headers"),
    I("RDAP registry from the IANA bootstrap (crawled data), pinned, needs the 404"),
  ],
  "src/tools/llm-gateway-kit.js": [F("model gateway, fixed URL set"), F("gateway credits read"), F("embeddings vendor"), F("rerank endpoint"), F("speech endpoint")],
  "src/tools/llm-images-fast-kit.js": [F("gateway model listing, model id in the path"), F("gateway GET, fixed base")],
  "src/tools/llm-kit.js": [F("chat vendor")],
  "src/tools/macro-kit.js": [F("FRED API, fixed base, asserted")],
  "src/tools/memory.js": [F("embeddings provider from configuration")],
  "src/tools/moderate-kit.js": [F("moderation vendor")],
  "src/tools/network-kit2.js": [
    F("certificate transparency log, domain in the query, pinned"),
    I("http-headers: asserted, pinned, needs the headers"),
    I("tech-detect HEAD: asserted, pinned, needs the headers"),
  ],
  "src/tools/stt-kit.js": [F("transcription vendor A"), F("transcription vendor B")],
  "src/tools/token-risk-kit.js": [F("token risk sources, fixed hosts")],
  "src/tools/tts-kit.js": [F("speech vendor probe, init from the caller", { t: "init" })],
  "src/how-to-pay.js": [S, S],
  "src/tools/web-kit.js": [I("unshorten hop: asserted per hop, pinned, redirect manual")],
  "src/tools/x402-kit.js": [
    F("RPC list per network, pinned"),
    I("x402 quote: asserted, pinned, needs the 402"),
    I("x402 audit: asserted, pinned, needs the 402 and headers"),
  ],
  "src/transparency.js": [F("code host traffic API"), F("code host traffic API")],
  "src/upstream-buyer-status.js": [F("Base RPC list")],
  "src/worker-client.js": [F("render worker from configuration")],
  "src/x402-buyer.js": [
    I("seller bare leg: reqInit carries the pinned dispatcher, redirect manual and the timeout", { t: "init", g: "init" }),
    I("seller paid leg, pinned"),
    I("seller paid retry, pinned"),
  ],
};

// Default implementations (`fetchImpl = fetch`) and wrappers, per file: count
// and class. Each reads a configured or constant host unless noted.
const DEFAULTS = {
  "src/async-jobs.js": { n: 1, cls: "loopback" },
  "src/avm-sponsorship.js": { n: 1, cls: "fixed" },
  "src/decision-one.js": { n: 1, cls: "fixed" },
  "src/discovery-rerank.js": { n: 1, cls: "fixed" },
  "src/drain-abort.js": { n: 1, cls: "wrapper" },
  "src/egress-meter.js": { n: 1, cls: "wrapper" },
  "src/evm-authorization-state.js": { n: 1, cls: "fixed" },
  "src/facilitator-diagnostics.js": { n: 1, cls: "wrapper" },
  "src/indexnow.js": { n: 2, cls: "fixed" },
  "src/mcp-mpp.js": { n: 1, cls: "loopback" },
  "src/mpp-reconcile.js": { n: 1, cls: "fixed" },
  "src/mpp-stripe.js": { n: 1, cls: "fixed" },
  "src/mpp-tempo.js": { n: 1, cls: "fixed" },
  "src/ofac-sdn.js": { n: 1, cls: "fixed" },
  "src/payment-verify.js": { n: 1, cls: "fixed" },
  "src/request-timing.js": { n: 1, cls: "wrapper" },
  "src/sanctions-screen.js": { n: 2, cls: "fixed" },
  "src/search-data.js": { n: 1, cls: "fixed" },
  "src/settle-onchain-proof.js": { n: 1, cls: "fixed" },
  "src/solana-buyer.js": { n: 4, cls: "fixed" },
  "src/stellar-confirm.js": { n: 1, cls: "fixed" },
  "src/stellar-facilitator-status.js": { n: 1, cls: "fixed" },
  "src/stripe-shadow-ledger.js": { n: 1, cls: "fixed" },
  "src/svm-clarify.js": { n: 1, cls: "fixed" },
  "src/tempo-confirm.js": { n: 2, cls: "fixed" },
  "src/tempo-transfers.js": { n: 1, cls: "fixed" },
  "src/tool-judge.js": { n: 3, cls: "fixed" },
  "src/tools/decide-kit.js": { n: 1, cls: "fixed" },
  "src/tools/edgar-13f-datasets.js": { n: 3, cls: "fixed" },
  "src/tools/filing-watch-kit.js": { n: 1, cls: "fixed" },
  "src/tools/judge-kit.js": { n: 5, cls: "fixed" },
  "src/tools/judge-preview-kit.js": { n: 3, cls: "fixed" },
  "src/tools/llm-gateway-kit.js": { n: 1, cls: "fixed" },
  "src/tools/sanctions-kit.js": { n: 1, cls: "fixed" },
  "src/tools/ticker-pack-kit.js": { n: 1, cls: "fixed", note: "13F data set tables on the SEC host" },
  "src/tweet-queue.js": { n: 1, cls: "fixed" },
  "src/upstream-deadline.js": { n: 1, cls: "wrapper", note: "deadline helper; callers pass fixed vendor URLs" },
  "src/verify-hint.js": { n: 1, cls: "fixed" },
  "src/wish-classify.js": { n: 2, cls: "fixed" },
  "src/x402-buyer.js": { n: 1, cls: "input", note: "sellerServesModel: the model list read asserts the URL and pins the connection" },
};

function walk(dir, out = []) {
  for (const name of readdirSync(dir).sort()) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (p.endsWith(".js")) out.push(p);
  }
  return out;
}

// A call: `fetch(` not preceded by an identifier character or a dot, or
// `globalThis.fetch(`. A default: `= fetch`, `= globalThis.fetch` or the
// `|| globalThis.fetch` fallback, with no call.
const CALL_RE = /(?<![A-Za-z0-9_$.])(?:globalThis\.)?fetch\s*\(/g;
const DEFAULT_RE = /(?:=|\|\|)\s*(?:globalThis\.)?fetch\b(?!\s*\()/g;

/** The balanced argument text of a call whose "(" is at `open`. */
function callText(src, open) {
  let depth = 0;
  for (let k = open; k < src.length; k++) {
    const c = src[k];
    if (c === "(") depth++;
    else if (c === ")" && --depth === 0) return src.slice(open, k + 1);
  }
  return src.slice(open);
}

function scan(file) {
  const src = readFileSync(file, "utf8");
  const calls = [], defaults = [];
  let offset = 0, inBlock = false;
  for (const line of src.split("\n")) {
    const t = line.trim();
    const skip = inBlock || t.startsWith("//") || t.startsWith("*") || t.startsWith("/*");
    if (inBlock && t.includes("*/")) inBlock = false;
    else if (t.startsWith("/*") && !t.includes("*/")) inBlock = true;
    if (!skip) {
      const lineNo = src.slice(0, offset).split("\n").length;
      for (const m of line.matchAll(CALL_RE)) {
        const open = offset + m.index + m[0].length - 1;
        calls.push({ line: lineNo, text: callText(src, open) });
      }
      for (const m of line.matchAll(DEFAULT_RE)) defaults.push({ line: lineNo, text: m[0] });
    }
    offset += line.length + 1;
  }
  return { calls, defaults };
}

const files = walk(SRC);
ok(files.length > 100, `scanned the source tree (${files.length} files)`);

const seenCalls = new Set(), seenDefaults = new Set();
const tally = {};
const count = (cls) => { tally[cls] = (tally[cls] || 0) + 1; };

for (const file of files) {
  const rel = relative(ROOT, file);
  const { calls, defaults } = scan(file);

  if (calls.length) {
    seenCalls.add(rel);
    const want = CALLS[rel];
    if (!want) { ok(false, `${rel}: ${calls.length} raw fetch call(s) with no allowlist entry (lines ${calls.map((c) => c.line).join(", ")}); use safeFetch or probePublicUrl, or classify it here`); continue; }
    if (want.length !== calls.length) { ok(false, `${rel}: ${calls.length} raw fetch call(s), allowlist has ${want.length} (lines ${calls.map((c) => c.line).join(", ")})`); continue; }
    calls.forEach((c, i) => {
      const e = want[i];
      count(e.cls);
      if (e.cls === "fixed" || e.cls === "input") {
        const timed = e.t === "init" || /\bsignal\b/.test(c.text);
        ok(timed, `${rel}:${c.line} (${e.cls}) carries a timeout`);
      }
      if (e.cls === "input") {
        const pinned = e.g === "init" || /dispatcher/.test(c.text);
        ok(pinned, `${rel}:${c.line} (input) pins the connection to a validated address`);
      }
    });
  }

  if (defaults.length) {
    seenDefaults.add(rel);
    const want = DEFAULTS[rel];
    if (!want) { ok(false, `${rel}: ${defaults.length} fetch default(s) with no allowlist entry (lines ${defaults.map((d) => d.line).join(", ")})`); continue; }
    ok(want.n === defaults.length, `${rel}: ${defaults.length} fetch default(s) listed (${want.cls})`);
    for (let i = 0; i < defaults.length; i++) count(want.cls);
  }
}

// An entry for a file that no longer has a raw site is stale bookkeeping, and
// a stale list is how the next real site hides.
const staleCalls = Object.keys(CALLS).filter((f) => !seenCalls.has(f));
ok(staleCalls.length === 0, staleCalls.length ? `CALLS names files with no raw fetch call: ${staleCalls.join(", ")}` : "no stale call entries");
const staleDefaults = Object.keys(DEFAULTS).filter((f) => !seenDefaults.has(f));
ok(staleDefaults.length === 0, staleDefaults.length ? `DEFAULTS names files with no fetch default: ${staleDefaults.join(", ")}` : "no stale default entries");

// safeFetch and probePublicUrl stay the only transports the guard exports with
// a fetch inside: a third raw fetch in the guard would be a policy change.
ok((CALLS["src/tools/fetch-guard.js"] || []).length === 2, "the guard itself holds exactly two transports");

console.log(`\nraw fetch sites by class: ${Object.entries(tally).map(([k, v]) => `${k}=${v}`).join(", ")}`);
console.log(`${fail ? "FAILED" : "OK"}: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
