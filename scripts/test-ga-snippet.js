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

{
  // A bearer page's canonical is its section (/reports for /r/<id>); the request
  // path decides. Rendered inside the store the server runs every request in.
  const { renderPathStore } = await import("../src/ledger-chrome.js");
  process.env.GA_MEASUREMENT_ID = "G-TEST1234";
  for (const [path, canon] of [["/r/abc123", "/reports"], ["/m/xyz", "/monitors"], ["/credits/thanks", "/credits"], ["/alerts/confirm", "/alerts"]]) {
    ok(renderPathStore.run(path, () => gaSnippet(`${B}${canon}`)) === "", `no GA on ${path} even though its canonical is ${canon}`);
  }
  ok(renderPathStore.run("/reports", () => gaSnippet(`${B}/reports`)) !== "", "GA still on the section page itself");
  delete process.env.GA_MEASUREMENT_ID;
}
const loader = readFileSync(new URL("../assets/js/ga-loader.js", import.meta.url), "utf8");
ok(/ad_storage: "denied", ad_user_data: "denied", ad_personalization: "denied"/.test(loader), "loader: every ads consent signal is denied by default");
ok(/allow_google_signals: false/.test(loader) && /allow_ad_personalization_signals: false/.test(loader), "loader: Google signals and ad personalization off");
ok(/analytics_storage: granted \? "granted" : "denied"/.test(loader) && /\^Europe\\\//.test(loader), "loader: analytics storage starts denied for a European time zone");
ok(/traffic_type = "internal"/.test(loader), "loader: ?internal=1 browsers are tagged for the Internal Traffic filter");
ok(!/innerHTML/.test(loader), "loader: the consent strip is built without innerHTML");
ok(/"Asia\/Nicosia"/.test(loader) && /"Indian\/Reunion"/.test(loader), "loader: EU states outside the Europe/ zone prefix (Cyprus, the outermost regions) start denied too");
{
  // Session replay skips exactly the paths GA skips.
  const ph = readFileSync(new URL("../assets/js/posthog-loader.js", import.meta.url), "utf8");
  const ga = readFileSync(new URL("../src/ledger-chrome.js", import.meta.url), "utf8").match(/GA_BEARER_PATH = (\/.*\/);/)[1];
  ok(ph.includes(ga + ".test(location.pathname)) data.cfg.disable_session_recording = true"), "posthog loader: no session replay on the bearer paths (same regex as GA_BEARER_PATH)");
}
ok(/googletagmanager\.com\/gtag\/js\?id=/.test(loader), "loader: loads Google's tag for the configured id");

{
  // The browser's own bearer-path rule must be the server's, character for character.
  const chrome = readFileSync(new URL("../src/ledger-chrome.js", import.meta.url), "utf8");
  const serverRe = /const GA_BEARER_PATH = (\/.+\/);/.exec(chrome)?.[1];
  const loaderRe = /if \((\/\^.+\/)\.test\(location\.pathname\)\) return;/.exec(loader)?.[1];
  ok(!!serverRe && serverRe === loaderRe, `loader: refuses the same bearer paths as the server (${loaderRe})`);
  ok(/page_location: location\.origin \+ location\.pathname/.test(loader) && /\^utm_\[a-z_\]\+\$/.test(loader), "loader: the URL sent drops every query parameter but utm_*");
}

const server = readFileSync(new URL("../src/security-headers.js", import.meta.url), "utf8");
const csp = /"default-src 'self';[^"]*"/.exec(server)?.[0] || "";
ok(/script-src 'self' https:\/\/www\.googletagmanager\.com;/.test(csp), "CSP: script-src adds exactly www.googletagmanager.com");
ok(!/script-src[^;]*('unsafe-inline'|'unsafe-eval'|\*)/.test(csp), "CSP: no unsafe-inline, unsafe-eval or wildcard in script-src");

const privacy = readFileSync(new URL("../src/privacy.js", import.meta.url), "utf8");
ok(/Google Analytics/.test(privacy) && /_ga/.test(privacy) && !/no accounts, no cookies/i.test(privacy), "privacy page names Google Analytics and its cookie, and no longer claims no cookies");

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
