#!/usr/bin/env node
// Settle first beyond the /v1 model routes (src/settle-first.js; server.js
// SETTLE_FIRST_CATALOG_SLUGS): web search and answer, image generation,
// speech, transcription, judgment and code runs. One PAID-mode server
// (scripts/lib/paid-wires-rig.js) whose stub facilitators record every settle
// call and whose stub upstreams (Brave, the images, speech and transcription
// APIs, the judgment API, the sandbox API) record every call they are sent,
// so the ORDER of the two is read, not inferred. For each route:
//   - a wallet that never paid: its payment is settled BEFORE the upstream call;
//   - a buyer's own mistake is refused before any settle call or upstream call;
//   - the upstream failing after the settlement is booked owed under the class
//     settle-first-failed, and the answer says so;
//   - the same payment sent again runs once more with no settle call and voids
//     that debt;
//   - a payment that does not settle runs no upstream call.
// A second boot with GATEWAY_SETTLE_FIRST=off shows the same calls run the
// upstream first, as before; a third (the default budget mode) shows a catalog
// route's unsettled runs feed the same budget meter and the same per-wallet
// count the /v1 routes do.
//
//   node scripts/test-settle-first-routes.js
import "./lib/offline-stores.js"; // per-process and file backends whatever the caller exports
import "./lib/file-mode.js";
import { bootPaidWires, sleep } from "./lib/paid-wires-rig.js";

let pass = 0, rig = null;
const fail = async (m) => { console.error(`FAIL - ${m}`); for (const l of (rig?.log() || "").split("\n").filter(Boolean).slice(-25)) console.error("  server:", l.slice(0, 300)); await rig?.stop().catch(() => {}); process.exit(1); };
const ok = async (c, m) => { if (c) { pass++; console.log(`ok - ${m}`); } else await fail(m); };
const CLASS = "settle-first-failed";
const decode = (h) => { try { return JSON.parse(Buffer.from(String(h), "base64").toString("utf8")); } catch { return null; } };

// A one-second silent 16 kHz mono WAV: a file the transcription route can read.
function silentWav(seconds = 1, rate = 16000) {
  const n = seconds * rate, data = Buffer.alloc(n * 2), h = Buffer.alloc(44);
  h.write("RIFF", 0); h.writeUInt32LE(36 + data.length, 4); h.write("WAVE", 8); h.write("fmt ", 12);
  h.writeUInt32LE(16, 16); h.writeUInt16LE(1, 20); h.writeUInt16LE(1, 22); h.writeUInt32LE(rate, 24); h.writeUInt32LE(rate * 2, 28); h.writeUInt16LE(2, 32); h.writeUInt16LE(16, 34);
  h.write("data", 36); h.writeUInt32LE(data.length, 40);
  return Buffer.concat([h, data]);
}
function multipart(fields, file) {
  const b = "----a402" + Math.random().toString(16).slice(2);
  const parts = [];
  for (const [k, v] of Object.entries(fields)) parts.push(Buffer.from(`--${b}\r\nContent-Disposition: form-data; name="${k}"\r\n\r\n${v}\r\n`));
  parts.push(Buffer.from(`--${b}\r\nContent-Disposition: form-data; name="file"; filename="${file.name}"\r\nContent-Type: ${file.type}\r\n\r\n`), file.buf, Buffer.from(`\r\n--${b}--\r\n`));
  return { body: Buffer.concat(parts), type: `multipart/form-data; boundary=${b}` };
}

const PNG_1PX = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
// Each route: how a good call, a buyer's mistake and an upstream failure look.
const ROUTES = [
  { slug: "search", route: { method: "GET", path: "/api/search?q=x402%20payments" }, host: "api.search.brave.com",
    bad: { method: "GET", path: "/api/search?q=x402%20payments" }, badPath: `/api/search?q=${encodeURIComponent(Array.from({ length: 60 }, (_, i) => `w${i}`).join(" "))}` },
  { slug: "answer", route: { method: "GET", path: "/api/answer?q=what%20is%20x402" }, host: "api.search.brave.com", noServe: true },
  { slug: "image-gen", route: { method: "POST", path: "/api/image-gen", body: { prompt: "a red square" } }, host: "llm", badBody: { prompt: "" } },
  { slug: "tts-lite", route: { method: "POST", path: "/api/tts-lite", body: { text: "hello there" } }, host: "llm", badBody: { text: "" } },
  { slug: "judge", route: { method: "POST", path: "/v1/judge", body: { state: "The export button crashes in Safari.", questions: { repro: { type: "noul", instructions: "Does the report give steps to reproduce?" } } } }, host: "api.typesafe.ai", badBody: { questions: { repro: { type: "noul", instructions: "x" } } } },
  { slug: "code-run", route: { method: "POST", path: "/api/code-run", body: { code: "print(1)", language: "python" } }, host: "api.e2b.app", badBody: { code: "print(1)", language: "cobol" }, noServe: true },
];

// The stub upstreams' behavior: `failing` (a set of hosts) answers 500.
const failing = new Set();
function installUpstreams() {
  rig.st.upHook = async ({ host, path, j, res, reply }) => {
    if (failing.has(host)) { reply(500, { error: "stub upstream failure" }); return true; }
    if (host === "api.search.brave.com" && path.startsWith("/res/v1/web/search")) { reply(200, { web: { results: [{ title: "x402", url: "https://www.x402.org/", description: "An open standard" }] } }); return true; }
    if (host === "api.typesafe.ai") {
      const answers = Object.fromEntries(Object.keys(j?.questions || {}).map((id) => [id, { type: "noul", noul: 0.8 }]));
      reply(200, { model: "jev-1.14.0", answers, usage: { input_tokens: 10, output_tokens: 1 } }); return true;
    }
    if (host === "api.e2b.app") { reply(500, { message: "stub sandbox service down" }); return true; }
    return false;
  };
  rig.st.llmHook = async ({ path, res, reply }) => {
    if (failing.has("llm") && /\/(images\/generations|audio\/speech|audio\/transcriptions)$/.test(path)) { reply(500, { error: { message: "stub upstream failure" } }); return true; }
    if (path.endsWith("/v1/images/generations")) { reply(200, { created: 1, data: [{ b64_json: PNG_1PX }], usage: { input_tokens: 5, output_tokens: 100 } }); return true; }
    if (path.endsWith("/audio/speech")) { res.writeHead(200, { "Content-Type": "audio/mpeg" }); res.end(Buffer.from("ID3\u0003\u0000\u0000\u0000\u0000\u0000\u0000" + "x".repeat(400))); return true; }
    if (path.endsWith("/audio/transcriptions")) { reply(200, { text: "hello there", usage: { type: "duration", seconds: 1 } }); return true; }
    return false;
  };
}

const ENV = {
  REFUND_OWED_NOTICE_MINUTES: "0",
  BRAVE_API_KEY: "stub-brave-key", BRAVE_ANSWERS_API_KEY: "stub-brave-key",
  OPENAI_API_KEY: "stub-openai-key", TYPESAFE_API_KEY: "stub-typesafe-key", E2B_API_KEY: "stub-e2b-key",
  UPSTREAM_STUB_HOSTS: "api.search.brave.com,api.typesafe.ai",
};

const mark = () => rig.st.events.length;
/** What reached the stubs since `from` for wallet `w` (settle calls) and the
 *  route's upstream: "settle-first", "upstream-first", "settle-only",
 *  "upstream-only" or "nothing". */
const orderOf = (w, from) => {
  const ev = rig.st.events.slice(from).filter((e) => e.t === "upstream" || (e.t === "settle" && e.id === w.id));
  if (!ev.length) return "nothing";
  const s = ev.some((e) => e.t === "settle"), u = ev.some((e) => e.t === "upstream");
  if (s && !u) return "settle-only";
  if (u && !s) return "upstream-only";
  return ev[0].t === "settle" ? "settle-first" : "upstream-first";
};
const upstreamSince = (from) => rig.st.events.slice(from).filter((e) => e.t === "upstream").length;
const refunds = async () => (await rig.operator("/__operator/refunds.json?status=all&limit=500"))?.refunds || [];
const refundOf = async (pred, tries = 40) => { for (let i = 0; i < tries; i++) { const r = (await refunds()).find(pred); if (r) return r; await sleep(100); } return null; };
const fresh = async (route, calls = 10) => { const w = await rig.wallet("evm"); const price = await rig.priceOf(w, route); rig.fund(w, price * BigInt(calls)); return w; };
const withPath = (route, path) => ({ ...route, path });

// The transcription route takes OpenAI's multipart wire.
const STT = { method: "POST", path: "/v1/audio/transcriptions", body: {} };
async function sendStt(headers, { empty = false } = {}) {
  const mp = empty ? multipart({ language: "en" }, { name: "a.txt", type: "text/plain", buf: Buffer.from("") }) : multipart({}, { name: "speech.wav", type: "audio/wav", buf: silentWav() });
  const r = await fetch(`${rig.url}${STT.path}`, { method: "POST", headers: { ...headers, "content-type": mp.type }, body: mp.body });
  const text = await r.text(); let json = null; try { json = JSON.parse(text); } catch { /* not JSON */ }
  return { status: r.status, json, text, headers: r.headers };
}

// =============================================================================
// boot A: settle first always on
// =============================================================================
rig = await bootPaidWires({ label: "settle-first-routes-a", env: (F) => ({ ...ENV, E2B_API_URL: `${F}/up/api.e2b.app`, GATEWAY_SETTLE_FIRST: "always", HARDCAP_E2B_SANDBOXES: "2" }) });
installUpstreams();
try {
  for (const R of ROUTES) {
    // ---- a wallet that never paid ----
    if (!R.noServe) {
      const w = await fresh(R.route);
      const from = mark();
      const r = await rig.pay(w, R.route);
      const o = rig.outcomesOf(w);
      await ok(r.status === 200 && orderOf(w, from) === "settle-first" && o.attempts === 1 && o.settled === 1 && decode(r.headers.get("payment-response"))?.success === true,
        `${R.slug}: a wallet that never paid is served, its payment settled BEFORE the upstream call, once (${r.status} ${orderOf(w, from)} ${JSON.stringify(o)} ${r.status !== 200 ? r.text.slice(0, 200) : ""})`);
    }
    // ---- the buyer's own mistake: no settle call, no upstream call ----
    if (R.badBody || R.badPath) {
      const w = await fresh(R.route);
      const cred = await rig.credentialFor(w, R.route);
      const from = mark();
      const r = await rig.send(R.badBody ? { ...R.route, body: R.badBody } : withPath(R.route, R.badPath), cred);
      await ok(r.status >= 400 && r.status < 500 && r.status !== 402 && rig.outcomesOf(w).attempts === 0 && orderOf(w, from) === "nothing" && !(await refunds()).some((x) => x.payer === w.address.toLowerCase()),
        `${R.slug}: a buyer's mistake is refused ${r.status} before any settle call or upstream call, and nothing is owed (${orderOf(w, from)})`);
    }
    // ---- the upstream failing after the settlement: owed, said so; then the same payment again ----
    {
      const w = await fresh(R.route);
      const cred = await rig.credentialFor(w, R.route);
      failing.add(R.host);
      const from = mark();
      const r = await rig.send(R.route, cred);
      failing.delete(R.host);
      const o = rig.outcomesOf(w);
      const row = await refundOf((x) => x.payer === w.address.toLowerCase() && x.slug === R.slug);
      const receipt = decode(r.headers.get("payment-response"));
      await ok(r.status >= 500 && orderOf(w, from) === "settle-first" && o.attempts === 1 && o.settled === 1,
        `${R.slug}: the upstream failing after the settlement answers ${r.status} on a payment taken once, settled before the upstream call (${orderOf(w, from)} ${JSON.stringify(o)})`);
      await ok(!!row && row.status === "owed" && String(row.note).startsWith(CLASS) && row.httpStatus === r.status && String(row.evidence).toLowerCase() === String(receipt?.transaction).toLowerCase(),
        `${R.slug}: that charge is owed on the refund ledger under ${CLASS}, with its transaction (${JSON.stringify(row && { note: row.note, slug: row.slug, status: row.status })})`);
      await ok(r.json?.charged === true && r.json?.retry === "same-payment" && !/not charged|nothing was charged/i.test(JSON.stringify(r.json)),
        `${R.slug}: the failure says the payment was taken and can be sent again, never "not charged" (${JSON.stringify(r.json).slice(0, 220)})`);
      if (!R.noServe) {
        const from2 = mark();
        const again = await rig.send(R.route, cred);
        await sleep(150);
        const row2 = (await refunds()).find((x) => x.id === row?.id);
        await ok(again.status === 200 && rig.outcomesOf(w).attempts === 1 && orderOf(w, from2) === "upstream-only" && row2?.status === "void",
          `${R.slug}: the same payment sent again runs once more with no settle call, and its debt is void (${again.status} ${orderOf(w, from2)} ${row2?.status})`);
      }
    }
    // ---- a payment that does not settle: no upstream call ----
    {
      const poor = await rig.wallet("evm");
      rig.fund(poor, 0n);
      const from = mark();
      const r = await rig.pay(poor, R.route);
      await ok(r.status === 402 && upstreamSince(from) === 0 && rig.outcomesOf(poor).attempts === 1 && rig.outcomesOf(poor).settled === 0,
        `${R.slug}: a payment that does not settle is answered 402 with no upstream call (${r.status}, ${upstreamSince(from)} upstream)`);
    }
  }

  // ---- THE RESEND BOUND: one payment runs again at most twice after its run failed ----
  {
    const SEARCH = ROUTES[0];
    const w = await fresh(SEARCH.route);
    const cred = await rig.credentialFor(w, SEARCH.route);
    failing.add(SEARCH.host);
    const first = await rig.send(SEARCH.route, cred);
    const row = await refundOf((x) => x.payer === w.address.toLowerCase() && x.slug === SEARCH.slug);
    const runs = [];
    for (let i = 0; i < 3; i++) {
      const from = mark();
      const r = await rig.send(SEARCH.route, cred);
      await sleep(150);
      runs.push({ status: r.status, json: r.json, upstream: upstreamSince(from), order: orderOf(w, from), row: (await refunds()).find((x) => x.id === row?.id)?.status });
    }
    failing.delete(SEARCH.host);
    const [a, b2, c] = runs;
    await ok(first.status >= 500 && row?.status === "owed" && [a, b2].every((x) => x.status >= 500 && x.upstream === 1 && x.order === "upstream-only" && x.row === "owed"),
      `search: the same payment sent again after its run failed runs again twice, each with no settle call, the debt owed again after each (${JSON.stringify([a, b2].map((x) => [x.status, x.order, x.row]))})`);
    await ok(c.status === 402 && c.json?.error === "resend_limit_reached" && c.json?.charged === true && c.json?.refundOwed === true && /nothing more is charged/i.test(c.json?.hint || "") && c.json?.resends?.max === 2 && c.json?.refund?.status === "owed" && (() => { try { const u = new URL(c.json.refund.lookup); return u.pathname === "/api/refunds/lookup" && !!u.searchParams.get("tx"); } catch { return false; } })() && c.upstream === 0 && c.order === "nothing" && c.row === "owed" && rig.outcomesOf(w).attempts === 1,
      `search: a third resend of that payment runs nothing, is charged nothing more, says its one charge is owed back (charged: true, refundOwed: true), and is answered with the debt's refund status (${c.status} ${JSON.stringify(c.json).slice(0, 200)} ${c.order} ${c.row})`);
  }

  // ---- a daily usage ceiling already reached: refused before any settle call ----
  // (HARDCAP_E2B_SANDBOXES=2 here: the failed run above took one sandbox.)
  {
    const CODE = ROUTES.find((x) => x.slug === "code-run").route;
    const a = await fresh(CODE);
    const ra = await rig.pay(a, CODE);
    await ok(ra.status === 503 && rig.outcomesOf(a).settled === 1, `code-run: the run that takes the last sandbox of the day settles first (${ra.status})`);
    const b = await fresh(CODE);
    const from = mark();
    const rb = await rig.pay(b, CODE);
    await sleep(100);
    await ok(rb.status === 503 && /usage limit/.test(rb.json?.error || "") && rig.outcomesOf(b).attempts === 0 && orderOf(b, from) === "nothing" && !(await refunds()).some((x) => x.payer === b.address.toLowerCase()),
      `code-run: with the daily ceiling reached, the next run is refused 503 before any settle call, and nothing is owed (${rb.status} ${orderOf(b, from)})`);
  }

  // ---- transcription (multipart wire) ----
  {
    const w = await fresh(STT);
    let from = mark();
    let r = await sendStt(await rig.credentialFor(w, STT));
    await ok(r.status === 200 && orderOf(w, from) === "settle-first" && rig.outcomesOf(w).settled === 1 && r.json?.text === "hello there",
      `v1-audio-transcriptions: served, its payment settled BEFORE the transcription call (${r.status} ${orderOf(w, from)} ${r.status !== 200 ? r.text.slice(0, 200) : ""})`);
    const w2 = await fresh(STT);
    from = mark();
    r = await sendStt(await rig.credentialFor(w2, STT), { empty: true });
    await ok(r.status >= 400 && r.status < 500 && r.status !== 402 && rig.outcomesOf(w2).attempts === 0 && orderOf(w2, from) === "nothing",
      `v1-audio-transcriptions: an unreadable file is refused ${r.status} before any settle call or upstream call (${orderOf(w2, from)})`);
    const w3 = await fresh(STT);
    failing.add("llm");
    from = mark();
    r = await sendStt(await rig.credentialFor(w3, STT));
    failing.delete("llm");
    const row = await refundOf((x) => x.payer === w3.address.toLowerCase());
    await ok(r.status >= 500 && orderOf(w3, from) === "settle-first" && rig.outcomesOf(w3).settled === 1 && row?.status === "owed" && String(row.note).startsWith(CLASS),
      `v1-audio-transcriptions: the upstream failing after the settlement is owed under ${CLASS} (${r.status} ${orderOf(w3, from)} ${row?.note})`);
  }
} finally {
  await rig.stop();
}

// =============================================================================
// boot B: GATEWAY_SETTLE_FIRST=off, the same calls run their upstream first
// =============================================================================
rig = await bootPaidWires({ label: "settle-first-routes-b", env: (F) => ({ ...ENV, E2B_API_URL: `${F}/up/api.e2b.app`, GATEWAY_SETTLE_FIRST: "off" }) });
installUpstreams();
try {
  for (const R of ROUTES.filter((x) => !x.noServe)) {
    const w = await fresh(R.route);
    const from = mark();
    const r = await rig.pay(w, R.route);
    await ok(r.status === 200 && orderOf(w, from) === "upstream-first", `${R.slug}, switch off: a new wallet's call runs the upstream before its settle call, as before (${orderOf(w, from)})`);
    const w2 = await fresh(R.route);
    failing.add(R.host);
    const r2 = await rig.pay(w2, R.route);
    failing.delete(R.host);
    await sleep(100);
    await ok(r2.status >= 500 && rig.outcomesOf(w2).attempts === 0 && !(await refunds()).some((x) => x.payer === w2.address.toLowerCase()),
      `${R.slug}, switch off: an upstream failure is answered ${r2.status} with no settle call and nothing owed`);
  }
} finally {
  await rig.stop();
}

// =============================================================================
// boot C: the default budget mode. A wallet with history whose settlements
// fail on a catalog route is served first twice, then settles first (the same
// per-wallet count as /v1), and those unsettled runs feed the budget meter.
// =============================================================================
rig = await bootPaidWires({ label: "settle-first-routes-c", env: (F) => ({ ...ENV, E2B_API_URL: `${F}/up/api.e2b.app`, GATEWAY_SETTLE_FIRST_BUDGET_USD: "1000" }) });
installUpstreams();
try {
  const SEARCH = ROUTES[0].route;
  const SQL = { method: "POST", path: "/api/sql-guard", body: { sql: "select 1" } };
  const w = await rig.wallet("evm");
  rig.fund(w, 10n ** 12n);
  const hist = await rig.pay(w, SQL);
  await ok(hist.status === 200, "setup: the wallet has a paid sale on the books");
  await sleep(150);
  const meterOf = async () => (await rig.operator("/api/gateway-status"))?.settleFailures?.settleFirst?.meter;
  const before = (await meterOf())?.unsettledUsd24h ?? 0;
  rig.st.settleAnswer = ({ id }) => (id === w.id ? { status: 500, body: { error: "facilitator unavailable" } } : null);
  const seen = [];
  for (let i = 0; i < 4; i++) { const from = mark(); const r = await rig.pay(w, SEARCH); seen.push(`${r.status}:${orderOf(w, from)}`); }
  rig.st.settleAnswer = null;
  await ok(seen.slice(0, 2).every((x) => x.endsWith(":upstream-first")) && seen.slice(2).every((x) => x.endsWith(":settle-only")) && !seen.some((x) => x.startsWith("429")),
    `search, budget mode: a wallet with history whose settlements fail is served twice, then settles first and runs nothing, never refused (${seen.join(" ")})`);
  await sleep(200);
  const after = (await meterOf())?.unsettledUsd24h ?? 0;
  await ok(after - before > 0.015, `search, budget mode: those two unsettled runs feed the same budget meter as the /v1 routes (${before} -> ${after})`);
} finally {
  await rig.stop();
}

console.log(`\n${pass} passed, 0 failed`);
