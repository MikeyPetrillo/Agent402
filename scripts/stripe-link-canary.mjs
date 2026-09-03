#!/usr/bin/env node
// Stripe cards-over-MPP live canary (dispatch-only). Buys ONE $0.50 route on production
// over the stripe/charge challenge with a real Link wallet through @stripe/link-cli:
//   402 probe (a stripe challenge must be offered) -> spend request (shared payment token,
//   the operator approves it in the Link app) -> `mpp pay` -> 200 + Payment-Receipt ->
//   /api/revenue/mpp byNetwork.stripe advanced by one.
// Every request carries X-Heartbeat-Token so the ledger files the buy as internal.
// Needs LINK_ACCESS_TOKEN / LINK_REFRESH_TOKEN (Actions secrets), STRIPE_PROFILE_ID, POW_SECRET.
import { createHmac } from "node:crypto";
import { spawnSync } from "node:child_process";

const TARGET = (process.env.TARGET_URL || "https://agent402.tools").replace(/\/+$/, "");
const ROUTE = process.env.STRIPE_CANARY_ROUTE || "/v1/premium/chat/completions";
// A path only: "@other.host/x" appended to the target would move the whole URL (and the payment
// credential + heartbeat token) to another host. Review note 2026-09-03.
if (!/^\/[A-Za-z0-9\/_.-]*$/.test(ROUTE)) { console.error(`FAIL - STRIPE_CANARY_ROUTE must be a bare path, got ${JSON.stringify(ROUTE)}`); process.exit(1); }
const PROFILE = (process.env.STRIPE_PROFILE_ID || "").trim();
const LINK_CLI = process.env.LINK_CLI_VERSION || "0.16.0";
const APPROVAL_WAIT_S = Number(process.env.STRIPE_CANARY_APPROVAL_WAIT_S || 720);
const BODY = JSON.stringify({
  model: "openai/gpt-5", max_tokens: 300, reasoning: { effort: "minimal" },
  messages: [{ role: "user", content: "Reply with the single word: settled" }],
});
const fail = (m) => { console.error(`FAIL - ${m}`); process.exit(1); };
const redact = (s) => String(s).replace(/(liwl|lsrq_[a-z]*_)?[A-Za-z0-9_-]{40,}/g, "<redacted>");
const heartbeat = () => {
  const secret = (process.env.POW_SECRET || "").trim();
  if (!secret) { console.warn("WARN  POW_SECRET unset - this buy will be recorded as EXTERNAL"); return null; }
  const minute = Math.floor(Date.now() / 60_000);
  return createHmac("sha256", secret).update(`heartbeat:${minute}`).digest("base64url").slice(0, 32);
};
const linkCli = (args, { timeoutMs = 120_000 } = {}) => {
  const r = spawnSync("npx", ["-y", `@stripe/link-cli@${LINK_CLI}`, ...args, "--format", "json"], {
    encoding: "utf8", timeout: timeoutMs,
    env: { ...process.env, LINK_ACCESS_TOKEN: process.env.LINK_ACCESS_TOKEN, LINK_REFRESH_TOKEN: process.env.LINK_REFRESH_TOKEN },
  });
  const out = (r.stdout || "") + (r.stderr || "");
  let json = null;
  try { json = JSON.parse(r.stdout.trim()); } catch { /* not json */ }
  return { status: r.status, out, json };
};

for (const k of ["LINK_ACCESS_TOKEN", "LINK_REFRESH_TOKEN"]) if (!process.env[k]) fail(`${k} unset`);
if (!PROFILE) fail("STRIPE_PROFILE_ID unset");

// 1. the live 402 must offer a stripe challenge on this route
const url = `${TARGET}${ROUTE}`;
const hb = heartbeat();
const probe = await fetch(url, { method: "POST", headers: { "content-type": "application/json", ...(hb ? { "X-Heartbeat-Token": hb } : {}) }, body: BODY });
const wwwAuth = probe.headers.get("www-authenticate") || "";
if (probe.status !== 402) fail(`expected 402 on ${ROUTE}, got ${probe.status}`);
if (!/\bPayment\b/.test(wwwAuth)) fail("402 carries no WWW-Authenticate: Payment challenge");
// mppx wire: `Payment id="..", realm="..", method="evm|stripe|tempo", intent="charge", request="<b64url>", ...` repeated.
const methods = [...wwwAuth.matchAll(/method="([^"]+)"/g)].map((m) => m[1]);
if (!methods.includes("stripe")) fail(`no stripe/charge challenge on the live 402 (methods: ${methods.join(",") || "none"})`);
if (process.env.STRIPE_CANARY_PROBE_ONLY === "1") { console.log(`ok - 402 offers stripe/charge (methods: ${methods.join(",")}); probe-only run, nothing bought`); process.exit(0); }
console.log(`ok - 402 offers stripe/charge (methods: ${methods.join(",")})`);

// 2. baseline
const revBefore = await fetch(`${TARGET}/api/revenue/mpp`).then((r) => r.json()).catch(() => null);
const stripeCount = (rev) => Number(rev?.byNetwork?.stripe?.count ?? rev?.byNetwork?.stripe ?? 0) || 0;
const before = stripeCount(revBefore);
console.log(`baseline /api/revenue/mpp byNetwork.stripe = ${before}`);

// 3. spend request (shared payment token), approved by the operator in the Link app
const context = `Agent402 daily Stripe card canary: one $0.50 purchase of ${ROUTE} on ${TARGET} over the MPP stripe/charge challenge, proving the live card rail settles end to end. Recorded as internal traffic.`;
console.log("creating spend request (approve it in the Link app within ~10 minutes)...");
const PRESET = (process.env.STRIPE_CANARY_SPEND_REQUEST_ID || "").trim(); // an already-approved request (a rerun after a late approval)
const sr = PRESET ? { json: [{ id: PRESET, status: "preset" }], out: "", status: 0 } : linkCli(["spend-request", "create", "--credential-type", "shared_payment_token", "--network-id", PROFILE, "--amount", "50", "--currency", "usd", "--context", context, "--request-approval"]);
// the CLI answers an ARRAY of one spend request; --request-approval sends the push and returns pending_approval
const srObj = Array.isArray(sr.json) ? sr.json[0] : (sr.json?.spend_request || sr.json);
const srId = srObj?.id || (sr.out.match(/\b(lsrq_[A-Za-z0-9]+)\b/) || [])[1];
if (!srId) fail(`spend request not created: ${redact(sr.out).slice(0, 400)}`);
console.log(`spend request ${srId} status=${srObj?.status || "?"}; approve at ${srObj?.approval_url || "the Link app"} (waiting up to ${APPROVAL_WAIT_S}s)`);
// poll until the operator approves (terminal statuses end the poll; anything but approved fails)
// Our own retrieve loop: the CLI's --interval poll returned pending_approval once with exit 0 while the
// approval landed inside the window (run 33710477233), so the status is re-read here until the deadline.
const deadline = Date.now() + APPROVAL_WAIT_S * 1000;
let srStatus = "?";
while (Date.now() < deadline) {
  const polled = linkCli(["spend-request", "retrieve", srId], { timeoutMs: 60_000 });
  const polledObj = Array.isArray(polled.json) ? polled.json[0] : polled.json;
  srStatus = polledObj?.status || srStatus;
  if (srStatus === "approved" || /denied|expired|canceled|cancelled|failed/.test(srStatus)) break;
  await new Promise((r) => setTimeout(r, 10_000));
}
console.log(`spend request ${srId} final status=${srStatus}`);
if (srStatus !== "approved") fail(`spend request ${srId} was not approved in time (status ${srStatus})`);

// 4. pay
// NO content-type here: the CLI sets application/json itself and a second one is joined into
// "application/json, application/json", which the JSON body parser refuses (run 33710477233: 400, no body).
const hdrs = [];
const hb2 = heartbeat(); if (hb2) hdrs.push("-H", `X-Heartbeat-Token: ${hb2}`);
const pay = linkCli(["mpp", "pay", url, "--spend-request-id", srId, "--method", "POST", "--data", BODY, ...hdrs], { timeoutMs: 180_000 });
console.log(`mpp pay exit=${pay.status}: ${redact(pay.out).slice(0, 600)}`);
const payText = pay.out;
const payStatus = pay.json?.status ?? pay.json?.response?.status ?? (payText.match(/"status":\s*(\d{3})/) || [])[1];
const receipt = pay.json?.receipt || pay.json?.response?.headers?.["payment-receipt"] || /payment-receipt/i.test(payText);
if (pay.status !== 0) fail("mpp pay exited non-zero");
if (payStatus && Number(payStatus) !== 200) fail(`paid retry answered ${payStatus}, not 200`);
if (!/choices|settled/i.test(payText)) fail("paid response carries no completion");
if (!receipt) console.warn("WARN  no Payment-Receipt visible in the CLI output (checking the ledger instead)");

// 5. the ledger must have moved by exactly one stripe settle
let after = before;
for (let i = 0; i < 6 && after === before; i++) {
  await new Promise((r) => setTimeout(r, 5_000));
  after = stripeCount(await fetch(`${TARGET}/api/revenue/mpp`).then((r) => r.json()).catch(() => null));
}
if (after !== before + 1) fail(`/api/revenue/mpp byNetwork.stripe went ${before} -> ${after}, expected +1`);
console.log(`OK stripe/charge -> settled $0.50 by card, ledger ${before} -> ${after}`);
