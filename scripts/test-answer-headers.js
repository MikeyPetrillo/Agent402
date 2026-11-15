#!/usr/bin/env node
// A header a handler set for its ANSWER is never sent on a refusal
// (src/answer-headers.js). The dub tool answers audio bytes with its
// translation beside them in X-Dub-Translation; a payment that verifies and
// then cannot be settled is answered 402 with the audio withheld, and the
// translation must be withheld with it.
//
// Booted PAID server (scripts/lib/paid-wires-rig.js), POST /api/dub with a
// stubbed model upstream, on three wires that settle after the handler: a
// Tempo pull credential, the MPP evm wire through the shim, and x402 on Base.
// On each: a funded wallet gets 200, the audio and the header (control); a
// wallet whose payment is refused at settlement gets 402 with neither.
// Then the guard itself, offline: recorded names are removed at 400 and above
// and kept below, whichever way the status reaches writeHead, and a header the
// handler did not record is left alone.
import "./lib/offline-stores.js"; // per-process and file backends whatever the caller exports
import "./lib/file-mode.js";
import { createServer } from "node:http";
import { bootPaidWires } from "./lib/paid-wires-rig.js";
import { answerHeadersGuard, setAnswerHeader, answerHeaderNamesOf } from "../src/answer-headers.js";

let pass = 0, rig = null;
const fail = async (m) => { console.error(`FAIL - ${m}`); for (const l of (rig?.log() || "").split("\n").filter(Boolean).slice(-20)) console.error("  server:", l.slice(0, 300)); await rig?.stop().catch(() => {}); process.exit(1); };
const ok = async (c, m) => { if (c) { pass++; console.log(`ok - ${m}`); } else await fail(m); };

// ---- the guard, offline ----
{
  const srv = createServer((req, res) => {
    answerHeadersGuard()(req, res, () => {
      const u = new URL(req.url, "http://x");
      setAnswerHeader(req, res, "X-Answer-Part", "secret");
      res.setHeader("X-Plain", "kept");
      const status = Number(u.searchParams.get("s"));
      if (u.searchParams.get("via") === "writeHead") { res.writeHead(status, { "content-type": "text/plain" }); res.end("x"); }
      else { res.statusCode = status; res.end("x"); }
      if (answerHeaderNamesOf(req)[0] !== "x-answer-part") res.destroy();
    });
  });
  await new Promise((r) => srv.listen(0, "127.0.0.1", r));
  const at = `http://127.0.0.1:${srv.address().port}`;
  for (const via of ["writeHead", "implicit"]) {
    for (const [s, kept] of [[200, true], [206, true], [399, true], [400, false], [402, false], [429, false], [500, false]]) {
      const r = await fetch(`${at}/?s=${s}&via=${via}`); await r.arrayBuffer();
      await ok(r.status === s && (r.headers.get("x-answer-part") === "secret") === kept && r.headers.get("x-plain") === "kept", `guard, ${via} ${s}: the answer header is ${kept ? "sent" : "removed"} and an unrecorded header is kept`);
    }
  }
  await new Promise((r) => srv.close(r));
}

// ---- the booted server ----
const DUB = { method: "POST", path: "/api/dub", body: { text: "hello world", targetLanguage: "es" } };
const MARK = "PAID-TRANSLATION-hola-mundo";
rig = await bootPaidWires({ label: "answer-headers" });
rig.st.llmContent = () => JSON.stringify({ source: "en", text: MARK });
const decoded = (h) => { try { return Buffer.from(String(h || ""), "base64").toString("utf8"); } catch { return ""; } };
try {
  const unpaid = await rig.send(DUB);
  await ok(unpaid.status === 402 && !unpaid.headers.get("x-dub-translation"), `the unpaid 402 carries no translation header (${unpaid.status})`);
  for (const wire of ["tempo", "mpp-evm", "evm"]) {
    const good = await rig.wallet(wire);
    const paid = await rig.pay(good, DUB);
    await ok(paid.status === 200 && /^audio\//.test(paid.headers.get("content-type") || "") && decoded(paid.headers.get("x-dub-translation")).includes(MARK), `${wire}: a settled call answers the audio with the translation header (control: ${paid.status} ${paid.headers.get("content-type")})`);
    const broke = await rig.wallet(wire);
    rig.fund(broke, 0n, { shown: 10n ** 12n });
    const c0 = rig.st.completions;
    const r = await rig.pay(broke, DUB);
    await ok(r.status === 402 && rig.st.completions > c0 && rig.outcomesOf(broke).refused === 1, `${wire}: the handler ran, settlement was refused, and the call answers 402 (${r.status}, settle ${JSON.stringify(rig.outcomesOf(broke))})`);
    await ok(r.headers.get("x-dub-translation") === null, `${wire}: the 402 carries no X-Dub-Translation (${String(r.headers.get("x-dub-translation")).slice(0, 30)})`);
    const everything = [r.text, ...[...r.headers.entries()].map(([k, v]) => `${k}: ${v} ${decoded(v)}`)].join("\n");
    await ok(!everything.includes(MARK) && !everything.includes(Buffer.from(MARK).toString("base64").slice(0, 24)), `${wire}: no header and no body of the 402 holds the translation`);
  }
} finally { await rig.stop(); }
console.log(`\n${pass} checks passed`);
