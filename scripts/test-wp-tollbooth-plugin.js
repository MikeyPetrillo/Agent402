#!/usr/bin/env node
// Static checks on the WordPress tollbooth plugin. CI has no PHP runtime, so
// this asserts the shape of the logic in the PHP source and its README:
//   1. should_skip() decides from what WordPress serves (is_admin(), the
//      login script), never from a prefix of the raw REQUEST_URI.
//   2. A verifier pass must carry an HMAC bound to this request (kind,
//      resource, a fresh nonce, the credential), compared with hash_equals;
//      a bare {"ok": true} is not a pass.
//   3. The verifier is used only with a shared secret configured.
//   4. The README documents that contract (same domain string) and does not
//      promise a /verify route on the Cloudflare Worker.
//   5. The plugin header version and the VERSION constant agree.
//   6. A Verifier URL with no usable secret (an upgrade from before the
//      secret) keeps failing closed and raises an escaped, administrators-only
//      notice on every admin page; the README carries an Upgrading note.
import { readFileSync } from "node:fs";
import { createHmac, createHash } from "node:crypto";

const php = readFileSync(new URL("../tollbooth/deploy/wordpress/agent402-tollbooth.php", import.meta.url), "utf8");
const readme = readFileSync(new URL("../tollbooth/deploy/wordpress/README.md", import.meta.url), "utf8");

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log("ok -", m); } else { fail++; console.log("FAIL -", m); } };

// Body of a PHP method: from its signature to the matching closing brace.
function methodBody(name) {
  const start = php.search(new RegExp(`function\\s+${name}\\s*\\(`));
  if (start < 0) return "";
  const open = php.indexOf("{", start);
  let depth = 0;
  for (let i = open; i < php.length; i++) {
    if (php[i] === "{") depth++;
    else if (php[i] === "}" && --depth === 0) return php.slice(open + 1, i);
  }
  return "";
}
const code = (s) => s.split("\n").filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join("\n");

// 1. skip rule
const skip = code(methodBody("should_skip"));
ok(skip.length > 0, "should_skip() exists");
ok(/is_admin\(\)/.test(skip), "should_skip() uses is_admin()");
ok(!/REQUEST_URI/.test(skip), "should_skip() does not read the raw REQUEST_URI");
ok(!/strpos\s*\(\s*\$uri/.test(php), "no prefix match on a raw URI anywhere in the plugin");
const login = code(methodBody("is_login_request"));
ok(/pagenow/.test(login) && /SCRIPT_FILENAME/.test(login) && !/REQUEST_URI/.test(login), "the login skip reads the running script, not the URI");
const uriReaders = [...php.matchAll(/function\s+(\w+)\s*\(/g)].map((m) => m[1]).filter((n) => /REQUEST_URI/.test(code(methodBody(n))));
ok(uriReaders.length === 1 && uriReaders[0] === "canonical_resource", `only canonical_resource() reads REQUEST_URI (found: ${uriReaders.join(", ") || "none"})`);

// 2. bound verifier answer
const verify = code(methodBody("verify_with_worker"));
ok(/random_bytes\(\s*16\s*\)/.test(verify) && /'nonce'\s*=>\s*\$nonce/.test(verify), "each verifier call sends a fresh 16-byte nonce");
ok(!/!empty\(\$j\['ok'\]\)/.test(php), "no bare {\"ok\": true} acceptance");
ok(/return\s+self::verifier_answer_ok\(/.test(verify), "verify_with_worker() returns the bound-answer check");
const answer = code(methodBody("verifier_answer_ok"));
ok(/\(\$j\['ok'\]\s*\?\?\s*null\)\s*!==\s*true/.test(answer), "ok must be literal true");
ok(/hash_equals\(\s*\$nonce\s*,\s*\$j\['nonce'\]\s*\)/.test(answer), "nonce echoed back, compared with hash_equals");
ok(/hash_hmac\(\s*'sha256'\s*,\s*self::verify_message\(\s*\$kind\s*,\s*\$resource\s*,\s*\$nonce\s*,\s*\$token\s*\)\s*,\s*\$secret\s*\)/.test(answer), "sig = HMAC-SHA256(secret, verify_message(kind, resource, nonce, token))");
ok(/hash_equals\(\s*\$expected\s*,/.test(answer), "sig compared with hash_equals");
const msg = code(methodBody("verify_message"));
ok(/self::VERIFY_DOMAIN\s*\.\s*"\\n"\s*\.\s*\$kind\s*\.\s*"\\n"\s*\.\s*\$resource\s*\.\s*"\\n"\s*\.\s*\$nonce\s*\.\s*"\\n"\s*\.\s*hash\('sha256',\s*\(string\)\$token\)/.test(msg), "message = domain \\n kind \\n resource \\n nonce \\n sha256(token)");
const domain = (php.match(/const VERIFY_DOMAIN\s*=\s*'([^']+)'/) || [])[1];
ok(domain === "agent402-tollbooth-verify.v1", `domain string pinned (${domain})`);

// 3. secret gate
const ready = code(methodBody("verifier_ready"));
ok(/verifier_url/.test(ready) && /strlen\(\$opts\['verifier_secret'\]\)\s*>=\s*self::MIN_SECRET_LEN/.test(ready), "verifier used only with a URL and a long enough secret");
const gate = code(methodBody("gate"));
ok((gate.match(/self::verifier_ready\(\$opts\)/g) || []).length === 2 && !/!empty\(\$opts\['verifier_url'\]\)/.test(gate), "both rails require verifier_ready()");
ok(/'verifier_secret'\s*=>\s*''/.test(code(methodBody("defaults"))), "verifier_secret defaults to empty");
ok(/value=""/.test(php.slice(php.indexOf("att-verifier-secret"), php.indexOf("att-verifier-secret") + 400)), "the settings form never echoes the saved secret");

// 4. README contract
ok(!/exposes a `POST \/verify`/.test(readme), "README no longer promises a /verify route on the Worker");
ok(readme.includes(domain) && /HMAC-SHA256/.test(readme) && /"nonce"/.test(readme) && /bare `\{"ok": true\}`/.test(readme), "README documents the signed-answer contract");
// The documented message, computed here, is what a verifier produces; the PHP
// builds the same five lines (asserted above).
const doc = [domain, "pow", "https://site.test/p", "ab".repeat(16), createHash("sha256").update("tok").digest("hex")].join("\n");
ok(/^[0-9a-f]{64}$/.test(createHmac("sha256", "s".repeat(32)).update(doc).digest("hex")), "documented message signs to a 64-hex sig");

// 5. version agreement
const header = (php.match(/\*\s*Version:\s*([0-9.]+)/) || [])[1];
const constant = (php.match(/const VERSION\s*=\s*'([0-9.]+)'/) || [])[1];
ok(header && header === constant, `plugin header version (${header}) matches VERSION (${constant})`);
ok(header !== "0.1.0", "plugin version bumped past 0.1.0");

// 6. upgrade notice for a Verifier URL without a secret
ok(/add_action\('admin_notices',\s*\[__CLASS__,\s*'admin_notice_verifier_secret'\]\)/.test(code(methodBody("init"))), "init() registers the verifier-secret admin notice");
const missing = code(methodBody("verifier_secret_missing"));
ok(/!empty\(\$opts\['verifier_url'\]\)\s*&&\s*!self::verifier_ready\(\$opts\)/.test(missing), "the notice condition is a Verifier URL set and the verifier not ready (no secret, or too short)");
const notice = code(methodBody("admin_notice_verifier_secret"));
const firstLine = notice.split("\n").map((l) => l.trim()).find(Boolean) || "";
ok(/^if \(!current_user_can\('manage_options'\)\) return;$/.test(firstLine), "the notice is for administrators only (manage_options checked first)");
ok(/if \(!self::verifier_secret_missing\(\$opts\)\) return;/.test(notice), "the notice shows only while the secret is missing");
ok(!/get_current_screen|\$hook|\$_GET\['page'\]|pagenow/.test(notice), "the notice is not limited to the plugin's own screen (shows on every admin page)");
ok(!/\becho\b/.test(notice) && /printf\(/.test(notice), "the notice prints through one printf");
// The printf call's top-level arguments (commas inside nested calls and
// quoted strings do not split).
function topLevelArgs(src, at) {
  const args = []; let depth = 0, cur = "", quote = null;
  for (let i = src.indexOf("(", at) + 1; i < src.length; i++) {
    const c = src[i];
    if (quote) { cur += c; if (c === "\\") { cur += src[++i]; } else if (c === quote) quote = null; continue; }
    if (c === "'" || c === '"') { quote = c; cur += c; continue; }
    if (c === "(") depth++;
    if (c === ")") { if (depth === 0) { args.push(cur.trim()); return args; } depth--; }
    if (c === "," && depth === 0) { args.push(cur.trim()); cur = ""; continue; }
    cur += c;
  }
  return args;
}
const printfArgs = topLevelArgs(notice, notice.indexOf("printf(")).slice(1);
ok(printfArgs.length === 4 && printfArgs.every((a) => /^esc_(html|url|attr)(__)?\(/.test(a)), `every printed value is escaped (${printfArgs.map((a) => a.slice(0, 12)).join(" | ")})`);
ok(/Verifier secret/.test(notice) && /paid \(x402\) and proof-of-work crawlers are refused/.test(notice) && /needs this secret/.test(notice), "the notice says the verifier needs the new secret and that paid and proof-of-work crawlers are refused until it is set");
ok(/notice notice-error/.test(notice), "the notice is an error notice");
ok(/'note'\s*=>\s*!self::verifier_ready\(\$opts\)/.test(code(methodBody("send_402"))), "the 402 note reads the same readiness as the rails, so a URL without a secret is not advertised as verifying");
ok((gate.match(/self::verifier_ready\(\$opts\)/g) || []).length === 2, "the gate still fails closed without the secret (both rails require verifier_ready())");
const upgrading = readme.slice(readme.indexOf("## Upgrading"), readme.indexOf("\n## ", readme.indexOf("## Upgrading") + 5));
ok(upgrading.length > 40 && /0\.1\.1/.test(upgrading) && /fails closed/.test(upgrading) && /notice/.test(upgrading) && /Verifier secret/.test(upgrading), "the README has an Upgrading note for sites with a Verifier URL and no secret");
ok(!/\u2014/.test(upgrading) && !/\u2014/.test(notice), "no em dash in the notice or the Upgrading note");

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
