// Mail text helpers (src/email-text.js): a header value carries no control
// character (CR/LF would start a new header) and keeps its length cap; HTML
// escaping covers both quote kinds so a value stays inert inside an attribute.
import { headerText, escapeHtml } from "../src/email-text.js";

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log(`ok - ${m}`); } else { fail++; console.error(`FAIL - ${m}`); } };

const injected = headerText("Your report\r\nBcc: someone@example.test\nX-Evil: 1");
ok(!/[\r\n]/.test(injected), "CR and LF never survive into a header value");
ok(![...headerText("a\u0000b\u0007c\u001fd\u007fe\tf")].some((ch) => ch.charCodeAt(0) < 32 || ch.charCodeAt(0) === 127), "every control character (NUL, BEL, unit separator, DEL, tab) is replaced");
ok(headerText("x".repeat(500)).length === 100 && headerText("x".repeat(500), 40).length === 40, "the length cap holds (default 100, or the one passed)");
ok(headerText(null) === "" && headerText(undefined) === "", "a missing value is empty");

ok(escapeHtml(`<a href="x" title='y'>&</a>`) === "&lt;a href=&quot;x&quot; title=&#39;y&#39;&gt;&amp;&lt;/a&gt;", "escapeHtml covers < > & and both quote kinds");
ok(escapeHtml(null) === "", "escapeHtml renders a missing value empty");

console.log(`\n${fail ? "FAILED" : "OK"}: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
