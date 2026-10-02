#!/usr/bin/env node
// A refused email send is recorded and logged, never silent (2026-10-01: the
// provider's prepaid credits ran out and every report link, credits key and
// alert confirmation stopped going out with nothing in any log). Offline:
// fetch is stubbed, the status file lives in a temp dir.
import { mkdtempSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
const dir = mkdtempSync(join(tmpdir(), "email-status-"));
process.env.EMAIL_STATUS_FILE = join(dir, "email-status.json");
process.env.EMAIL_FROM = "noreply@example.test";
process.env.ZEPTOMAIL_TOKEN = "test-token-not-real";
const { sendEmail, emailSendStatus, providerErrorCode } = await import("../src/email.js");

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log(`ok - ${m}`); } else { fail++; console.log(`FAIL: ${m}`); } };
const logs = [];
const warn = console.warn; console.warn = (...a) => { logs.push(a.join(" ")); };
const realFetch = globalThis.fetch;
const TO = "buyer-secret@example.test";

ok(emailSendStatus().status === "unknown", "no send recorded yet reads unknown, never ok");

// The exact refusal ZeptoMail returned on 2026-10-01.
globalThis.fetch = async () => new Response(JSON.stringify({ error: { code: "TM_5001", details: [{ code: "LE_102", message: "Credit exhausted" }], message: "Resource Limit Exhausted." } }), { status: 429 });
ok(await sendEmail({ to: TO, subject: "s", html: "<p>h</p>", text: "t" }) === false, "a refused send still returns false to the caller (best-effort contract unchanged)");
ok(emailSendStatus().status === "exhausted", `a credit refusal reads exhausted (${emailSendStatus().status})`);
ok(emailSendStatus({ full: true }).lastCode === "LE_102" && emailSendStatus({ full: true }).failuresSinceOk === 1, "the operator read carries the provider code and the failure count");
ok(logs.some((l) => /\[email\] send refused by zeptomail: HTTP 429 LE_102/.test(l)), "the refusal is logged with status and code");
ok(!logs.join("\n").includes(TO) && !JSON.stringify(emailSendStatus({ full: true })).includes(TO), "no recipient address in the log line or the status");
ok(JSON.stringify(emailSendStatus()) === JSON.stringify({ status: "exhausted" }), "the public read is one word");
ok(existsSync(process.env.EMAIL_STATUS_FILE) && JSON.parse(readFileSync(process.env.EMAIL_STATUS_FILE, "utf8")).code === "LE_102", "the outcome is kept on the volume, so a restart does not reset the alarm to unknown");

globalThis.fetch = async () => new Response("{}", { status: 500 });
await sendEmail({ to: TO, subject: "s", html: "h", text: "t" });
ok(emailSendStatus().status === "failing", "another refusal reads failing");

globalThis.fetch = async () => { throw Object.assign(new Error("t"), { name: "TimeoutError" }); };
await sendEmail({ to: TO, subject: "s", html: "h", text: "t" });
ok(emailSendStatus({ full: true }).lastCode === "timeout", "a thrown send is recorded too, not swallowed");

globalThis.fetch = async () => new Response("{}", { status: 201 });
ok(await sendEmail({ to: TO, subject: "s", html: "h", text: "t" }) === true && emailSendStatus().status === "ok" && emailSendStatus({ full: true }).failuresSinceOk === 0, "a delivered send clears it to ok");

ok(providerErrorCode('{"error":{"code":"<script>"}}') === null && providerErrorCode("not json") === null, "only a code-shaped value is ever kept from a provider body");

// Fallback: with both providers configured, a ZeptoMail refusal is retried once on Resend.
{
  process.env.RESEND_API_KEY = "re_test_not_real";
  const hosts = [];
  globalThis.fetch = async (url) => {
    hosts.push(new URL(url).host);
    if (String(url).includes("zeptomail")) return new Response(JSON.stringify({ error: { code: "TM_5001", details: [{ code: "LE_102" }] } }), { status: 429 });
    return new Response("{}", { status: 200 });
  };
  ok(await sendEmail({ to: TO, subject: "s", html: "h", text: "t" }) === true && hosts.join(",") === "api.zeptomail.com,api.resend.com", `a ZeptoMail refusal is delivered through Resend (${hosts.join(",")})`);
  ok(emailSendStatus().status === "ok" && emailSendStatus({ full: true }).provider === "resend", "the delivered fallback reads ok, attributed to the provider that sent it");
  hosts.length = 0;
  globalThis.fetch = async (url) => { hosts.push(new URL(url).host); return new Response("{}", { status: 200 }); };
  await sendEmail({ to: TO, subject: "s", html: "h", text: "t" });
  ok(hosts.join(",") === "api.zeptomail.com", "a ZeptoMail success never also sends through Resend (one email, not two)");
  hosts.length = 0;
  globalThis.fetch = async (url) => { hosts.push(new URL(url).host); return new Response("{}", { status: 500 }); };
  ok(await sendEmail({ to: TO, subject: "s", html: "h", text: "t" }) === false && hosts.length === 2 && emailSendStatus().status === "failing", "both refusing returns false, tries each once, and reads failing");
  delete process.env.RESEND_API_KEY;
}

const server = readFileSync(new URL("../src/server.js", import.meta.url), "utf8");
ok(/email: \(\(\) => \{ try \{ return emailSendStatus\(\{ full \}\)/.test(server), "/api/gateway-status carries the email word");
const hb = readFileSync(new URL("../.github/workflows/heartbeat.yml", import.meta.url), "utf8");
ok(/\.email\.status/.test(hb) && /exhausted\|failing\)/.test(hb), "the heartbeat pages on exhausted or failing");

globalThis.fetch = realFetch; console.warn = warn;
console.log(`\n${fail ? "FAILED" : "OK"}: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
