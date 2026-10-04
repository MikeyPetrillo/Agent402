// Unit tests for the revenue detector's classification logic — the part that
// decides what counts as a real external x402 payment. Guards against the bug
// where non-x402 transfers (funding/tests/swaps, e.g. $1/$5 from the owner's
// other wallet) were mislabeled as "external customer payments". Pure, no network.
import { isExternalPayment, payerFromLog } from "./revenue-scan.js";

let pass = 0, fail = 0;
const ok = (cond, msg) => { if (cond) { pass++; console.log(`ok - ${msg}`); } else { fail++; console.error(`FAIL - ${msg}`); } };

const OURS = new Set(["0xfeda7403aabe9a492ed70e810b396d8548a4a022"]);
const MAX = 0.5;
const ext = (row) => isExternalPayment(row, { ourWallets: OURS, maxUsd: MAX });

// payerFromLog: pulls the address out of the padded Transfer `from` topic.
ok(payerFromLog({ topics: ["0xddf2...", "0x000000000000000000000000abcdef0000000000000000000000000000001234", "0x..."] }) === "0xabcdef0000000000000000000000000000001234", "payerFromLog extracts from topics[1]");
ok(payerFromLog({ topics: ["0xddf2..."] }) === null, "payerFromLog null when no from topic");

// The exact false positives that triggered this fix: $1/$1/$5 inbound. Even from
// an unknown wallet, they exceed the per-call ceiling → NOT external customers.
ok(ext({ payer: "0x1111111111111111111111111111111111111111", usd: 1 }) === false, "$1 inbound excluded (over ceiling)");
ok(ext({ payer: "0x2222222222222222222222222222222222222222", usd: 5 }) === false, "$5 inbound excluded (over ceiling)");

// A real per-call payment from an unknown wallet IS external.
ok(ext({ payer: "0x3333333333333333333333333333333333333333", usd: 0.005 }) === true, "$0.005 from unknown wallet = external");
ok(ext({ payer: "0x4444444444444444444444444444444444444444", usd: 0.02 }) === true, "$0.02 (max price) from unknown wallet = external");

// Our own burner is never external, even at a per-call amount.
ok(ext({ payer: "0xFEDA7403AABE9A492ED70E810B396D8548A4A022", usd: 0.005 }) === false, "our burner excluded (case-insensitive)");

// Degenerate rows.
ok(ext({ payer: null, usd: 0.005 }) === false, "null payer excluded");
ok(ext({ payer: "0x5555555555555555555555555555555555555555", usd: 0 }) === false, "zero amount excluded");
ok(ext({ payer: "0x6666666666666666666666666666666666666666", usd: -1 }) === false, "negative amount excluded");

// Exactly at the ceiling is allowed; just over is not.
ok(ext({ payer: "0x7777777777777777777777777777777777777777", usd: 0.5 }) === true, "exactly at ceiling allowed");
ok(ext({ payer: "0x8888888888888888888888888888888888888888", usd: 0.50001 }) === false, "just over ceiling excluded");

// --- an RPC failure must name the lane that failed ------------------------
//
// rpcCall walks a list of lanes and used to throw only the LAST error. That
// means the message you get comes from the least-capable fallback. Every Sei
// outage surfaced as publicnode's "Archive requests require a personal token"
// even though the relay and the primary were both healthy and had merely
// blipped - so it read as an entitlement problem on the wrong lane entirely.
{
  const { rpcCall } = await import("../src/revenue-live.js");
  let caught = null;
  try {
    await rpcCall(["https://127.0.0.1:9/a", "https://127.0.0.1:10/b"], "eth_blockNumber", [], 500);
  } catch (e) { caught = e; }
  ok(Boolean(caught), "rpcCall still throws when every lane fails");
  ok(Array.isArray(caught?.lanes) && caught.lanes.length === 2,
    `the error carries one entry per lane tried (got ${caught?.lanes?.length})`);
  ok(/127\.0\.0\.1:9/.test(caught.message) && /127\.0\.0\.1:10/.test(caught.message),
    "the message names BOTH lanes, not just the last one");
  // A token in an RPC URL must never reach a log line.
  let leaked = null;
  try {
    await rpcCall([{ url: "https://relay.example/v1", headers: { Authorization: "Bearer SUPERSECRET" } }],
      "eth_blockNumber", [], 500);
  } catch (e) { leaked = e; }
  ok(!/SUPERSECRET/.test(leaked?.message || ""), "an auth token never appears in the failure message");
}

// --- and each lane must name WHY it failed, not just that it did ------------
//
// Naming the lane was half the fix. Node flattens every network-level failure
// to "fetch failed", so "relay: fetch failed | publicnode: fetch failed" is
// still unactionable - it cannot distinguish DNS from a refused connection
// from an unroutable IPv6 address, which are three different fixes. That
// indistinguishability is exactly what gets mislabelled "transient".
{
  const { describeError } = await import("../src/revenue-live.js");
  const wrap = (props) => Object.assign(new Error("fetch failed"), { cause: Object.assign(new Error("i"), props) });
  const dns = describeError(wrap({ code: "ENOTFOUND", syscall: "getaddrinfo" }));
  const refused = describeError(wrap({ code: "ECONNREFUSED", syscall: "connect", address: "1.2.3.4", port: 443 }));
  ok(/ENOTFOUND/.test(dns), `DNS failure names itself (${dns})`);
  ok(/ECONNREFUSED/.test(refused) && /1\.2\.3\.4/.test(refused), `refused connection names the address (${refused})`);
  ok(dns !== refused, "two different network failures are distinguishable");

  // Dual-stack: most of these RPCs are Cloudflare-fronted with A and AAAA, and
  // the AggregateError wrapper carries no code at all.
  const agg = Object.assign(new Error("fetch failed"), {
    cause: new AggregateError([
      Object.assign(new Error("a"), { code: "ENETUNREACH", address: "2606:4700::1" }),
      Object.assign(new Error("b"), { code: "ECONNRESET", address: "104.21.87.156" }),
    ]),
  });
  const out = describeError(agg);
  ok(/ENETUNREACH/.test(out) && /ECONNRESET/.test(out),
    `a dual-stack failure reports every address, so IPv6-vs-IPv4 is visible (${out})`);

  // A plain error with no cause must not gain noise.
  ok(describeError(new Error("boom")) === "boom", "an error without a cause is reported unchanged");
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
