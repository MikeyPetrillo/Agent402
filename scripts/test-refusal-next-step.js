#!/usr/bin/env node
// A refusal on the hosted connector says what to do next (src/next-step-copy.js).
//
// A caller on /mcp who asks for a paid tool with no way to pay, or who reaches
// the free limit, is told in one sentence what to do next, with an address a
// person can tap on a phone, and a rate limit says when it resets in words.
// Each offer reads the switch that sells it: with credits off sale (or the
// connector sign-in off) the sentence names the free tools on a phone
// (/start#phone) and the wallet setup (/start#fund) and nothing about cards or
// credits; with both on it names the credits connector sign-in.
//
// Part 1 (offline): the sentences, both switch states, the wait in words, the
// proof-of-work redemption limit's message.
// Part 2 boots FREE_MODE with the switches off and reads the real answers: a
// paid tool through catalog.call and by its flagship name (the next step is the
// second sentence, right after the refusal's lead), a free tool past its limit,
// and the transport's 429; every web address in them answers 200 locally.
// Part 3 boots with CREDITS_SALES=on and MCP_OAUTH=on and reads the same
// refusals: they name the credits connector, and the sales-off sentence is gone.
import "./lib/offline-stores.js"; // per-process and file backends whatever the caller exports (see the file)
import { bootServer } from "./lib/boot-server.js";
import { connectorNextStep, powLimitMessage, waitInWords, START_PHONE_PATH, START_WALLET_PATH } from "../src/next-step-copy.js";

let pass = 0;
const servers = [];
const fail = async (m) => { console.error("FAIL:", m); for (const s of servers) await s.stop().catch(() => {}); process.exit(1); };
const ok = async (c, m) => { if (c) { pass++; console.log(`ok - ${m}`); } else await fail(m); };
const EM_DASH = "—";
const CARD_WORDS = /card|credit/i;

// ---------------------------------------------------------------------------
// Part 1: the sentences, offline
// ---------------------------------------------------------------------------
const B = "https://agent402.test";
{
  await ok(waitInWords(42) === "42 seconds" && waitInWords(1) === "1 second" && waitInWords(0) === "1 second", `a short wait is whole seconds (${waitInWords(42)}, ${waitInWords(1)})`);
  await ok(waitInWords(720) === "about 12 minutes (720 seconds)" && waitInWords(3540) === "about 59 minutes (3540 seconds)", `a longer wait reads in minutes and keeps the seconds (${waitInWords(720)})`);
  await ok(waitInWords(3600) === "about 1 hour (3600 seconds)", `an hour reads as one (${waitInWords(3600)})`);
  for (const limited of [false, true]) {
    const off = connectorNextStep(B, { limited, connector: false, freeMode: false });
    const on = connectorNextStep(B, { limited, connector: true, freeMode: false });
    const what = limited ? "the limit's" : "the paid refusal's";
    await ok(off.includes(`${B}${START_PHONE_PATH}`) && off.includes(`${B}${START_WALLET_PATH}`), `${what} next step with sales off names /start#phone and /start#fund (${off})`);
    await ok(!CARD_WORDS.test(off), `${what} next step with sales off says nothing about cards or credits`);
    await ok(on.includes(`${B}/mcp/credits`) && /card/.test(on) && on.includes(`${B}/start#apps`), `${what} next step with sales on names the credits connector sign-in (${on})`);
    for (const s of [off, on]) {
      await ok(!s.includes(EM_DASH) && !/\$\d/.test(s) && (s.match(/[.!?](\s|$)/g) || []).length === 1, `one sentence, no em dash, no price (${s.slice(0, 60)})`);
    }
  }
  // A tool the credits connector would refuse is never offered it.
  const refusedHere = connectorNextStep(B, { connector: true, creditsPay: false });
  await ok(!CARD_WORDS.test(refusedHere) && !refusedHere.includes("/mcp/credits") && refusedHere.includes(`${B}${START_WALLET_PATH}`), `a tool the credits connector refuses gets the wallet step, no credits clause (${refusedHere})`);
  await ok(refusedHere === connectorNextStep(B, { connector: false }), "that step is the sales-off sentence, so the two cannot drift");
  const powOff = powLimitMessage(B, 42, { credits: false, freeMode: false });
  const powOn = powLimitMessage(B, 42, { credits: true, freeMode: false });
  await ok(/resets in 42 seconds\./.test(powOff) && powOff.includes(`${B}${START_WALLET_PATH}`) && !CARD_WORDS.test(powOff), `the proof-of-work limit says when it resets and links the wallet setup, nothing about cards with sales off (${powOff})`);
  await ok(powOn.includes(`${B}/credits`) && /card/.test(powOn), `with sales on it also names a credits key (${powOn})`);
  // A FREE_MODE server takes no payment: the limit says the limit and when it
  // resets, and points to no wallet, card or connector; a paid refusal there
  // is unchanged.
  for (const connector of [false, true]) {
    await ok(connectorNextStep(B, { limited: true, connector, freeMode: true }) === "", `FREE_MODE, connector ${connector ? "on" : "off"}: the limit has no next step to buy`);
    await ok(connectorNextStep(B, { limited: false, connector, freeMode: true }) === connectorNextStep(B, { limited: false, connector, freeMode: false }), `FREE_MODE, connector ${connector ? "on" : "off"}: the paid refusal's step is unchanged`);
  }
  const powFree = powLimitMessage(B, 42, { credits: true, freeMode: true });
  await ok(powFree === "Free-tier rate limit reached for proof-of-work redemption; it resets in 42 seconds. Retry then.", `FREE_MODE: the proof-of-work limit says the limit and when it resets, nothing to buy (${powFree})`);
}

// ---------------------------------------------------------------------------
// Parts 2 and 3: the real answers
// ---------------------------------------------------------------------------
const CAP = 40; // the transport's per-minute bucket in these boots
// A fixed public address, so each message is compared whole; its pages are read on the booted port.
const SITE = "http://agent402.test";
const boot = (label, env) => bootServer({
  stores: label,
  timeoutMs: 180_000,
  env: {
    FREE_MODE: "true", BASE_URL: SITE, X402_SYNC_ON_START: "false", X402_INDEX_CRAWL: "off", MPP_INDEX_CRAWL: "off", MONITOR_SCHEDULER: "off", REDIS_URL: "",
    CREDITS_SALES: "", MCP_OAUTH: "",
    AGENT402_MCP_REQ_PER_MIN: String(CAP), AGENT402_MCP_REQ_PER_HOUR: "1000", AGENT402_MCP_MAX_PER_MIN: "1", AGENT402_MCP_MAX_PER_HOUR: "1000",
    ...env,
  },
}).then((s) => { servers.push(s); return s; });

let id = 1;
async function call(srv, name, args) {
  const r = await fetch(`${srv.url}/mcp`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream" },
    body: JSON.stringify({ jsonrpc: "2.0", id: id++, method: "tools/call", params: { name, arguments: args } }),
  });
  let t = await r.text();
  if ((r.headers.get("content-type") || "").startsWith("text/event-stream")) t = t.split("\n").filter((l) => l.startsWith("data:")).map((l) => l.slice(5).trim()).join("");
  let j = null;
  try { j = JSON.parse(t); } catch { j = null; }
  return { status: r.status, json: j, text: (j?.result?.content || []).filter((c) => c.type === "text").map((c) => c.text).join("\n") };
}
// The text after the refusal's lead: the sentence a person reads next.
const secondSentence = (text) => {
  const lead = text.indexOf("is not part of this hosted free tier. ");
  return lead < 0 ? "" : text.slice(lead + "is not part of this hosted free tier. ".length);
};
// Every web address in a message (the connector itself is not a page).
const pagesIn = (text) => [...new Set((text.match(/https?:\/\/[^\s)"';]+/g) || []).map((u) => u.replace(/[.,]$/, "")).filter((u) => !/\/mcp(\/credits)?$/.test(u)))];

async function resolves(srv, text, what) {
  const pages = pagesIn(text).filter((u) => { try { return new URL(u).origin === new URL(SITE).origin; } catch { return false; } });
  await ok(pages.length > 0, `${what} carries a web address on this site (${pages.join(", ")})`);
  for (const u of pages) {
    const r = await fetch(`${srv.url}${u.slice(SITE.length).split("#")[0]}`);
    await r.arrayBuffer();
    await ok(r.status === 200, `${what}: ${u.slice(SITE.length)} answers 200 (got ${r.status})`);
  }
}

const [offSrv, onSrv] = await Promise.all([
  boot("next-step-off", {}).catch((e) => fail(`the sales-off server booted (${String(e?.message || e).slice(-800)})`)),
  boot("next-step-on", { CREDITS_SALES: "on", MCP_OAUTH: "on", CREDITS_GUARDS_JSON: process.env.CREDITS_GUARDS_JSON }).catch((e) => fail(`the sales-on server booted (${String(e?.message || e).slice(-800)})`)),
]);

for (const [srv, connector, label] of [[offSrv, false, "sales off"], [onSrv, true, "sales on"]]) {
  const want = connectorNextStep(SITE, { connector, freeMode: true });
  const other = connectorNextStep(SITE, { connector: !connector, freeMode: true });
  // A paid tool through catalog.call, and a paid flagship by its listed name.
  for (const [name, args, what] of [["catalog.call", { slug: "summarize", params: { url: "https://example.com" } }, "catalog.call summarize"], ["web.answer", { q: "What is x402?" }, "web.answer"]]) {
    const r = await call(srv, name, args);
    await ok(r.json?.result?.isError === true, `${label}: ${what} is refused without a payment (status ${r.status})`);
    await ok(secondSentence(r.text).startsWith(want), `${label}: ${what}'s second sentence is the next step (${secondSentence(r.text).slice(0, 160)})`);
    await ok(!r.text.includes(other), `${label}: ${what} carries no sentence for the other switch state`);
    if (!connector) await ok(!CARD_WORDS.test(r.text), `${label}: ${what} says nothing about cards or credits`);
    await resolves(srv, r.text, `${label}: ${what}`);
  }
  // A free tool past its limit (one call a minute in these boots).
  const first = await call(srv, "catalog.call", { slug: "hash", params: { text: "hello world" } });
  await ok(first.json?.result && !first.json.result.isError, `${label}: the first free call runs`);
  const second = await call(srv, "catalog.call", { slug: "hash", params: { text: "hello world" } });
  const m = /^Free-tier rate limit reached \(1 call a minute, 1000 an hour from one address\); it resets in (\d+) seconds?\.(?: |$)/.exec(second.text);
  await ok(second.json?.result?.isError === true && !!m && Number(m[1]) >= 1 && Number(m[1]) <= 60, `${label}: the limit names the calls allowed and when it resets, in seconds (${second.text.slice(0, 140)})`);
  // These boots are FREE_MODE, which takes no payment: the limit's words are the whole answer.
  await ok(!second.text.includes(START_WALLET_PATH) && !second.text.includes(START_PHONE_PATH) && !/wallet|\/mcp\/credits|credits/i.test(second.text) && /seconds?\.$/.test(second.text.trim()), `${label}: on a FREE_MODE server the limit says the limit and when it resets, and offers nothing to buy (${second.text.slice(0, 200)})`);
  if (!connector) await ok(!CARD_WORDS.test(second.text), `${label}: the limit says nothing about cards or credits`);
  await ok(pagesIn(second.text).length === 0, `${label}: the FREE_MODE limit links no page to buy from (${pagesIn(second.text).join(", ") || "none"})`);
}

// With credits on, a tool the credits connector refuses (a wallet-identity
// route, a route that buys from an outside seller) is not offered it; an
// ordinary paid tool still is (the summarize control above, and again here).
{
  const credits = connectorNextStep(SITE, { connector: true });
  const wallet = connectorNextStep(SITE, { connector: true, creditsPay: false });
  for (const [args, what, offered] of [
    [{ slug: "memory-write", params: { key: "note", value: "hello" } }, "memory-write (wallet-identity bound)", false],
    [{ slug: "route-execute", params: { task: "hash hello" } }, "route-execute (buys from an outside seller)", false],
    [{ slug: "summarize", params: { url: "https://example.com" } }, "summarize (control)", true],
  ]) {
    const r = await call(onSrv, "catalog.call", args);
    const next = secondSentence(r.text);
    await ok(r.json?.result?.isError === true && next.length > 0, `sales on: ${what} is refused with a next step (${r.text.slice(0, 120)})`);
    if (offered) await ok(next.startsWith(credits), `sales on: ${what} is offered the credits connector (${next.slice(0, 160)})`);
    else await ok(next.startsWith(wallet) && !r.text.includes(credits) && !r.text.includes("/mcp/credits"), `sales on: ${what} carries no credits clause and names the wallet step (${next.slice(0, 160)})`);
  }
}

// The transport's own 429: when the limit resets, in words.
{
  let refused = null;
  for (let i = 0; i < CAP + 5 && !refused; i++) {
    const r = await fetch(`${offSrv.url}/mcp`, { method: "POST", headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream" }, body: JSON.stringify({ jsonrpc: "2.0", id: 900 + i, method: "tools/list", params: {} }) });
    if (r.status === 429) refused = { retry: r.headers.get("retry-after"), body: await r.json().catch(() => null) };
    else await r.arrayBuffer();
  }
  const msg = String(refused?.body?.error?.message || "");
  await ok(!!refused && refused.body?.error?.code === -32000, `the transport refuses past its cap with the same JSON-RPC code (${JSON.stringify(refused?.body?.error || null).slice(0, 160)})`);
  await ok(new RegExp(`^Too many requests to /mcp from this address; the limit resets in ${refused?.retry} seconds?\\.$`).test(msg), `its message says when the limit resets, the Retry-After seconds (${msg}; Retry-After ${refused?.retry})`);
}

for (const s of servers) await s.stop();
console.log(`\n${pass} passed (refusal next step)`);
