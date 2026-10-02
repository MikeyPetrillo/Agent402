#!/usr/bin/env node
// SDK snippets we publish must never let the SDK pick a credential from the
// reader's environment and send it to our host.
//
//   node scripts/test-sdk-snippet-credentials.js        (offline, no server)
//
// The OpenAI and Anthropic JavaScript SDKs fill an option the caller left
// undefined from the environment: openai reads OPENAI_API_KEY into `apiKey`,
// @anthropic-ai/sdk reads ANTHROPIC_API_KEY into `apiKey` and
// ANTHROPIC_AUTH_TOKEN into `authToken`, each independently. So a snippet
// pointed at https://agent402.tools that writes
// `apiKey: process.env.AGENT402_CREDITS_KEY` sends the reader's OpenAI key to
// us as a Bearer token whenever that variable is unset, and an Anthropic
// snippet that sets only `authToken` sends ANTHROPIC_API_KEY as x-api-key on
// every call. Both shapes were on /guides/agent-hosts (measured against
// openai 7.23 and @anthropic-ai/sdk 0.128 with a local stub). The Python SDKs
// do the same for a missing or None argument, so `os.environ.get(...)` there is
// the same defect; `os.environ[...]` raises before any request.
//
// The rule, for every OpenAI/Anthropic client constructed against our host in
// any tracked file:
//   - every credential option the SDK would otherwise fill from the
//     environment is passed explicitly (OpenAI: apiKey; Anthropic: apiKey AND
//     authToken, or api_key/auth_token in Python);
//   - its value is a literal, null, `<expr> ?? null`, or an identifier the
//     snippet has already refused to run without (`if (!x) throw`); never a
//     bare process.env read, os.environ.get(), os.getenv() or None.
// A control table of known-bad and known-good snippets runs through the same
// checker first, and the scan must see the guide's own four snippets, so a
// clean result cannot come from a checker that sees nothing.
import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log(`ok - ${m}`); } else { fail++; console.error(`FAIL - ${m}`); } };

const HOST = /agent402\.tools/;

// The argument list of a call starting at `open` (the index of its "("),
// balanced over (), {} and [] and skipping string contents.
function callArgs(text, open) {
  let depth = 0, quote = null;
  for (let i = open; i < text.length && i < open + 2000; i++) {
    const c = text[i];
    if (quote) { if (c === "\\") { i++; continue; } if (c === quote) quote = null; continue; }
    if (c === '"' || c === "'") { quote = c; continue; }
    if (c === "(" || c === "{" || c === "[") depth++;
    else if (c === ")" || c === "}" || c === "]") { depth--; if (depth === 0) return text.slice(open + 1, i); }
  }
  return null;
}

// Value of `name` in a JS object literal / Python kwargs list, or undefined
// when absent. Shorthand `{ apiKey }` returns the identifier itself.
function jsProp(args, name) {
  const m = new RegExp(`(?:^|[{,\\s])${name}\\s*:\\s*([^,}]+)`).exec(args);
  if (m) return m[1].trim();
  if (new RegExp(`(?:^|[{,\\s])${name}\\s*(?:[,}]|$)`).test(args)) return name;
  return undefined;
}
function pyKwarg(args, name) {
  const m = new RegExp(`(?:^|[(,\\s])${name}\\s*=\\s*([^,()]+(?:\\([^)]*\\))?)`).exec(args);
  return m ? m[1].trim() : undefined;
}

const LITERAL = /^(["'])[^"']*\1$/;
const IDENT = /^[A-Za-z_$][\w$]*$/;

// JS credential value: safe, or a reason it is not.
function jsValueProblem(value, before) {
  if (value === undefined) return "not passed, so the SDK reads it from the environment";
  if (value === "null" || LITERAL.test(value)) return null;
  if (/\?\?\s*null$/.test(value)) return null;
  if (/process\.env/.test(value)) return `\`${value}\` falls back to the SDK's own environment variable when unset`;
  if (IDENT.test(value)) {
    const guard = new RegExp(`if\\s*\\(\\s*!\\s*${value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*\\)\\s*throw`);
    return guard.test(before) ? null : `\`${value}\` is never checked (no \`if (!${value}) throw\` before the client)`;
  }
  return `\`${value}\` is not a literal, null, \`?? null\` or a checked identifier`;
}
function pyValueProblem(value) {
  if (value === undefined) return "not passed, so the SDK reads it from the environment";
  if (value === "None") return "None makes the SDK read its own environment variable";
  if (/os\.environ\.get\(|os\.getenv\(/.test(value)) return `\`${value}\` returns None when unset, and the SDK then reads its own environment variable`;
  return null;
}

// Every OpenAI/Anthropic construction aimed at our host in `text`.
function findProblems(text) {
  const found = [];
  const problems = [];
  const jsRe = /new\s+(OpenAI|Anthropic)\s*\(/g;
  for (let m; (m = jsRe.exec(text)); ) {
    const open = m.index + m[0].length - 1;
    const args = callArgs(text, open);
    if (args === null || !HOST.test(args)) continue;
    const kind = m[1];
    const line = text.slice(0, m.index).split("\n").length;
    // The code block this client lives in: a check in an earlier block does
    // not protect this one.
    let before = text.slice(Math.max(0, m.index - 600), m.index);
    const fence = Math.max(before.lastIndexOf("```"), before.lastIndexOf("\\`\\`\\`"));
    if (fence >= 0) before = before.slice(fence);
    found.push({ lang: "js", kind, line });
    const props = kind === "OpenAI" ? ["apiKey"] : ["apiKey", "authToken"];
    for (const p of props) {
      const why = jsValueProblem(jsProp(args, p), before);
      if (why) problems.push(`L${line} new ${kind}: ${p} ${why}`);
    }
  }
  const pyRe = /(?<![\w.])(OpenAI|Anthropic)\s*\(\s*base_url\s*=/g;
  for (let m; (m = pyRe.exec(text)); ) {
    const open = text.indexOf("(", m.index);
    const args = callArgs(text, open);
    if (args === null || !HOST.test(args)) continue;
    const kind = m[1];
    const line = text.slice(0, m.index).split("\n").length;
    found.push({ lang: "py", kind, line });
    if (kind === "OpenAI") {
      const why = pyValueProblem(pyKwarg(args, "api_key"));
      if (why) problems.push(`L${line} ${kind}(): api_key ${why}`);
    } else {
      // An explicit api_key or auth_token makes the Python client read no
      // credential from the environment (anthropic 0.125 and 1.8, measured).
      const vals = ["api_key", "auth_token"].map((k) => [k, pyKwarg(args, k)]).filter(([, v]) => v !== undefined);
      if (!vals.length) problems.push(`L${line} ${kind}(): neither api_key nor auth_token passed, so the SDK reads them from the environment`);
      for (const [k, v] of vals) { const why = pyValueProblem(v); if (why) problems.push(`L${line} ${kind}(): ${k} ${why}`); }
    }
  }
  return { found, problems };
}

// --- controls: the checker must reject every known-bad shape and accept the good ones.
const U = "https://agent402.tools/v1/metered";
const MUST_FAIL = {
  "openai apiKey from process.env (the reviewed defect)": `const client = new OpenAI({ baseURL: "${U}", apiKey: process.env.AGENT402_CREDITS_KEY });`,
  "anthropic authToken from process.env, apiKey unset": `const client = new Anthropic({ baseURL: "${U}", authToken: process.env.AGENT402_CREDITS_KEY });`,
  "anthropic authToken literal, apiKey unset (sends ANTHROPIC_API_KEY)": `const client = new Anthropic({ baseURL: "${U}", authToken: "a402_..." });`,
  "unchecked shorthand identifier": `const apiKey = process.env.AGENT402_CREDITS_KEY;\nconst client = new OpenAI({ baseURL: "${U}", apiKey });`,
  "openai with no apiKey at all": `const client = new OpenAI({ baseURL: "${U}" });`,
  "anthropic checked token but apiKey unset": `const authToken = process.env.K;\nif (!authToken) throw new Error("x");\nconst client = new Anthropic({ baseURL: "${U}", authToken });`,
  "python openai os.environ.get": `client = OpenAI(base_url="${U}", api_key=os.environ.get("AGENT402_CREDITS_KEY"))`,
  "python openai os.getenv": `client = OpenAI(base_url="${U}", api_key=os.getenv("AGENT402_CREDITS_KEY"))`,
  "python openai no api_key": `client = OpenAI(base_url="${U}")`,
  "python anthropic auth_token None": `client = Anthropic(base_url="${U}", auth_token=None)`,
  "the only check is in an earlier code block": "```js\nconst apiKey = process.env.K;\nif (!apiKey) throw new Error(\"x\");\n```\n\n```js\n" +
    `const client = new OpenAI({ baseURL: "${U}", apiKey });\n` + "```",
};
const MUST_PASS = {
  "openai checked identifier": `const apiKey = process.env.AGENT402_CREDITS_KEY;\nif (!apiKey) throw new Error("export AGENT402_CREDITS_KEY first");\nconst client = new OpenAI({ baseURL: "${U}", apiKey });`,
  "anthropic checked token + apiKey null": `const authToken = process.env.AGENT402_CREDITS_KEY;\nif (!authToken) throw new Error("x");\nconst client = new Anthropic({ baseURL: "${U}", apiKey: null, authToken });`,
  "openai ?? null": `const client = new OpenAI({ baseURL: "${U}", apiKey: process.env.AGENT402_CREDITS_KEY ?? null });`,
  "python openai os.environ[...]": `client = OpenAI(base_url="${U}", api_key=os.environ["AGENT402_CREDITS_KEY"])`,
  "python anthropic os.environ[...]": `client = Anthropic(base_url="${U}", auth_token=os.environ["AGENT402_CREDITS_KEY"])`,
  "python literal": `client = OpenAI(base_url="https://agent402.tools/v1", api_key="unused")`,
  "a client for another host is out of scope": `const openai = new OpenAI();`,
};
for (const [name, code] of Object.entries(MUST_FAIL)) {
  const r = findProblems(code);
  ok(r.found.length === 1 && r.problems.length > 0, `control rejects: ${name}${r.problems[0] ? ` (${r.problems[0]})` : ""}`);
}
for (const [name, code] of Object.entries(MUST_PASS)) {
  const r = findProblems(code);
  ok(r.problems.length === 0, `control accepts: ${name}${r.problems.length ? ` (${r.problems.join("; ")})` : ""}`);
}

// --- the real scan: every tracked text file.
const files = execFileSync("git", ["ls-files", "-z"], { cwd: root, encoding: "utf8" })
  .split("\0")
  .filter((f) => /\.(js|mjs|cjs|ts|md|py|html|txt)$/.test(f) && !f.startsWith("node_modules/"))
  .filter((f) => f !== "scripts/test-sdk-snippet-credentials.js");
const seen = [];
for (const f of files) {
  let text;
  try { text = readFileSync(join(root, f), "utf8"); } catch { continue; }
  if (!HOST.test(text) || !/(OpenAI|Anthropic)\s*\(/.test(text)) continue;
  const r = findProblems(text);
  for (const x of r.found) seen.push({ file: f, ...x });
  for (const p of r.problems) ok(false, `${f} ${p}`);
}
const inGuide = seen.filter((s) => s.file === "src/guides.js");
ok(inGuide.filter((s) => s.lang === "js").length >= 2 && inGuide.filter((s) => s.lang === "py").length >= 2,
  `the scan sees the agent-hosts SDK snippets (${inGuide.map((s) => `${s.lang}:${s.kind}@L${s.line}`).join(", ")})`);
ok(seen.length >= 4, `SDK clients aimed at agent402.tools found across the tree: ${seen.length}`);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
