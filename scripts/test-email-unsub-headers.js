#!/usr/bin/env node
// One-click unsubscribe headers reach the mailbox on both providers: the
// ZeptoMail request carries them in mime_headers, the Resend request in
// headers. Offline: fetch is replaced and every request body is read back.
process.env.EMAIL_FROM = "alerts@agent402.tools";
process.env.ZEPTOMAIL_TOKEN = "zepto-test-token";
process.env.RESEND_API_KEY = "";
process.env.COMPANY_POSTAL_ADDRESS = "Test address";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
const dir = mkdtempSync(join(tmpdir(), "email-unsub-"));
process.on("exit", () => rmSync(dir, { recursive: true, force: true }));
process.env.EMAIL_STATUS_FILE = join(dir, "email-status.json");
delete process.env.STATE_DATABASE_URL;

let pass = 0, fail = 0;
const ok = (c, m) => { c ? (pass++, console.log("ok -", m)) : (fail++, console.error("FAIL -", m)); };

const sent = [];
let answer = 200;
globalThis.fetch = async (url, init) => {
  sent.push({ url: String(url), body: JSON.parse(init.body) });
  const status = answer;
  return { ok: status < 300, status, text: async () => (status < 300 ? "{}" : '{"error":{"code":"TM_TEST"}}') };
};
const { sendEmail } = await import("../src/email.js");

const UNSUB = { "List-Unsubscribe": "<https://agent402.tools/alerts/unsubscribe?id=a1&k=sig>", "List-Unsubscribe-Post": "List-Unsubscribe=One-Click" };

ok(await sendEmail({ to: "buyer@example.com", subject: "s", html: "<p>h</p>", text: "t", headers: UNSUB }) === true, "ZeptoMail send succeeds");
let z = sent.at(-1);
ok(/zeptomail/.test(z.url), "the request went to ZeptoMail");
ok(JSON.stringify(z.body.mime_headers) === JSON.stringify(UNSUB), `ZeptoMail body carries both headers unchanged in mime_headers (${JSON.stringify(z.body.mime_headers)})`);

await sendEmail({ to: "buyer@example.com", subject: "s", html: "<p>h</p>", text: "t" });
ok(!("mime_headers" in sent.at(-1).body), "a message with no headers sends no mime_headers field");

await sendEmail({ to: "buyer@example.com", subject: "s", html: "<p>h</p>", text: "t", headers: { "List-Unsubscribe": "<https://a.example/u>\r\nBcc: x@evil.example", "Bad Name": "v", "X-Null": null } });
const mh = sent.at(-1).body.mime_headers;
ok(mh && Object.keys(mh).join() === "List-Unsubscribe" && !/[\r\n]/.test(mh["List-Unsubscribe"]), "header values lose line breaks, and malformed names or empty values are dropped");

// Resend path, unchanged: a refused ZeptoMail send falls back with headers.
process.env.RESEND_API_KEY = "re_test";
answer = 500;
sent.length = 0;
const origFetch = globalThis.fetch;
globalThis.fetch = async (url, init) => { const r = await origFetch(url, init); if (/resend/.test(String(url))) return { ok: true, status: 200, text: async () => "{}" }; return r; };
ok(await sendEmail({ to: "buyer@example.com", subject: "s", html: "<p>h</p>", text: "t", headers: UNSUB }) === true, "a refused ZeptoMail send falls back to Resend");
const r = sent.find((x) => /resend/.test(x.url));
ok(r && JSON.stringify(r.body.headers) === JSON.stringify(UNSUB) && !("mime_headers" in r.body), "Resend body still carries the headers in its headers field");

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
