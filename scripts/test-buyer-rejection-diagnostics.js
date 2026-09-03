// When a seller we PAID rejects the paid retry, the reason must be logged, and
// none of it may reach our buyer.
//
// Measured 2026-08-30: an upstream we pay ($0.002/call over x402) returned HTTP
// 500 on every paid retry for two days, and the only evidence anything kept was
// the number 500 - so "their backend is broken" and "they refused our payment"
// were indistinguishable, and those need opposite responses. Same shape as the
// facilitator diagnostics, where 200 characters of truncated Cloudflare HTML hid
// an outage-versus-egress-block.
//
// The other half is a leak boundary: a seller's error body is their text, and
// relaying it verbatim to our buyers is exactly what the 2026-08-19 review closed
// for the MPP relay. So it is logged server-side and the thrown message stays
// status-only. Source-level assertions, because both properties are about what
// the code SAYS - a runtime test could show the log and still miss the leak.
import { strict as assert } from "node:assert";
import { readFile } from "node:fs/promises";
const src = await readFile("src/x402-buyer.js", "utf8");
let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log(`ok - ${m}`); } else { fail++; console.error(`FAIL - ${m}`); } };
const block = src.slice(src.indexOf("if (paid.status !== 200)"), src.indexOf("// Pull the settle tx"));
ok(/console\.warn\(`\[x402-buyer\]/.test(block), "it logs the rejection server-side");
ok(/await paid\.text\(\)/.test(block) && /slice\(0, 400\)/.test(block), "it reads a BOUNDED slice of the body");
ok(/\[\\u0000-\\u001f\\u007f\]/.test(block), "control characters are stripped (no log forging)");
ok(/content-type/.test(block), "and the content-type, which is what tells HTML-error-page from JSON");
ok(/new URL\(url\)\.host/.test(block), "it names the host, not the full URL (no query/credential in the log)");
// The leak guard: the THROWN message must carry only the status.
const thrown = block.match(/throw bad\(`([^`]+)`/)?.[1] || "";
ok(thrown === "Seller rejected the paid retry (HTTP ${paid.status})", `the buyer-facing message stays status-only (got: ${thrown})`);
ok(!/why|raw|body/.test(thrown), "no part of the seller's body reaches the buyer");
ok(/try \{[\s\S]*?\} catch \{ why = "\(body unreadable\)"/.test(block), "an unreadable body never throws over the real error");
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
