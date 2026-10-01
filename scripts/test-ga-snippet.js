// Google Analytics wiring (2026-10-01): env-gated, kept off bearer-link pages,
// consent-defaulted in Europe, ads features off, CSP opened to one host only.
import { readFileSync } from "node:fs";

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log(`ok - ${m}`); } else { fail++; console.error(`FAIL - ${m}`); } };

const { gaSnippet } = await import("../src/ledger-chrome.js");
const B = "https://agent402.tools";

delete process.env.GA_MEASUREMENT_ID;
ok(gaSnippet(`${B}/`) === "", "no GA_MEASUREMENT_ID: nothing rendered");
process.env.GA_MEASUREMENT_ID = "not-an-id";
ok(gaSnippet(`${B}/`) === "", "a malformed id renders nothing");
process.env.GA_MEASUREMENT_ID = "G-TEST1234";
const home = gaSnippet(`${B}/`);
ok(home.includes('"id":"G-TEST1234"') && home.includes('<script src="/js/ga-loader.js"></script>'), "a valid id renders the JSON island and the first-party loader");
ok(!/<script src="https?:/.test(home), "the page itself carries no third-party script tag");
for (const p of ["/r/cs_abc", "/m/xyz", "/reports/public/rp_1", "/alerts/confirm", "/followups/stop", "/credits/thanks", "/monitors/manage", "/monitors/thanks", "/digest/confirm"]) {
  ok(gaSnippet(`${B}${p}`) === "", `no GA on the bearer-link page ${p}`);
}
for (const p of ["/reports", "/marketplace", "/tools/hash", "/revenue", "/privacy"]) ok(gaSnippet(`${B}${p}`) !== "", `GA on the public page ${p}`);
delete process.env.GA_MEASUREMENT_ID;

const loader = readFileSync(new URL("../assets/js/ga-loader.js", import.meta.url), "utf8");
ok(/ad_storage: "denied", ad_user_data: "denied", ad_personalization: "denied"/.test(loader), "loader: every ads consent signal is denied by default");
ok(/allow_google_signals: false/.test(loader) && /allow_ad_personalization_signals: false/.test(loader), "loader: Google signals and ad personalization off");
ok(/analytics_storage: granted \? "granted" : "denied"/.test(loader) && /\^Europe\\\//.test(loader), "loader: analytics storage starts denied for a European time zone");
ok(/traffic_type = "internal"/.test(loader), "loader: ?internal=1 browsers are tagged for the Internal Traffic filter");
ok(!/innerHTML/.test(loader), "loader: the consent strip is built without innerHTML");
ok(/googletagmanager\.com\/gtag\/js\?id=/.test(loader), "loader: loads Google's tag for the configured id");

const server = readFileSync(new URL("../src/server.js", import.meta.url), "utf8");
const csp = /"default-src 'self';[^"]*"/.exec(server)?.[0] || "";
ok(/script-src 'self' https:\/\/www\.googletagmanager\.com;/.test(csp), "CSP: script-src adds exactly www.googletagmanager.com");
ok(!/script-src[^;]*('unsafe-inline'|'unsafe-eval'|\*)/.test(csp), "CSP: no unsafe-inline, unsafe-eval or wildcard in script-src");

const privacy = readFileSync(new URL("../src/privacy.js", import.meta.url), "utf8");
ok(/Google Analytics/.test(privacy) && /_ga/.test(privacy) && !/no accounts, no cookies/i.test(privacy), "privacy page names Google Analytics and its cookie, and no longer claims no cookies");

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
