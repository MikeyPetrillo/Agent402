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

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
