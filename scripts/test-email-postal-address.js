#!/usr/bin/env node
// F-01 guard: every outbound email carries the physical postal address.
process.env.EMAIL_FROM = "test@agent402.tools";
process.env.ZEPTOMAIL_TOKEN = "";
process.env.RESEND_API_KEY = "";
const { postalAddress } = await import("../src/email.js");
let pass = 0, fail = 0;
const ok = (c, m) => { c ? (pass++, console.log("ok -", m)) : (fail++, console.error("FAIL -", m)); };

delete process.env.COMPANY_POSTAL_ADDRESS;
ok(postalAddress() === null, "unset reads null (and warns) rather than inventing an address");
process.env.COMPANY_POSTAL_ADDRESS = "Havok Holdings LLC\n123 Example St\nWilmington, DE 19801";
ok(/Wilmington/.test(postalAddress() || ""), "set value is returned");
// the sender is the chokepoint, so the footer cannot be forgotten per-template
const src = (await import("node:fs")).readFileSync(new URL("../src/email.js", import.meta.url), "utf8");
ok(/withPostalFooter\(html, text\)/.test(src), "sendEmail appends the footer for every caller");
ok(src.indexOf("({ html, text } = withPostalFooter(html, text));") > src.indexOf("export async function sendEmail"), "the CALL sits inside sendEmail, after its guard clause");
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
