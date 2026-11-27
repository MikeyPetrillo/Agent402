// Reads a site's MCP Registry namespace proof the way the registry reads it.
//
//   node scripts/registry-proof-check.js [--warn] [--tries N] [--wait-ms M] <base URL>
//
// One GET of <base>/.well-known/mcp-registry-auth with the registry's own
// request shape (Accept: text/plain, User-Agent: mcp-registry/1.0), no
// redirect followed, a 10 s limit and at most 4096 bytes read. The proof is
// served when the answer is a 200 whose body is one proof record
// ("v=MCPv1; k=ed25519; p=<public key>"), the grammar the server itself
// serves by (src/mcp-registry-auth.js). Holds no secret and reads only a
// public value.
//
// Prints one JSON line {word, status, url}: word is ok, absent (404),
// redirect (a 3xx, which the registry refuses), invalid (a 200 that is not a
// proof record, or an answer past the size limit), refused (any other
// status) or unreadable (no answer). Exit 0 on ok, 1 otherwise. --warn turns
// every other word into a ::warning:: line and exit 0, for a step that
// reports and never decides.
import { MCP_REGISTRY_AUTH_PATH, MCP_REGISTRY_AUTH_MAX_BYTES, registryAuthProof } from "../src/mcp-registry-auth.js";

const argv = process.argv.slice(2);
const flag = (name) => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : undefined; };
const WARN = argv.includes("--warn");
const bounded = (raw, fallback, max) => { const n = Number(raw); return Number.isInteger(n) && n >= 0 ? Math.min(n, max) : fallback; };
const TRIES = Math.max(1, bounded(flag("--tries"), 1, 10));
const WAIT_MS = bounded(flag("--wait-ms"), 10000, 60000);
const valued = new Set(["--tries", "--wait-ms"]);
const base = argv.filter((a, i) => !a.startsWith("--") && !valued.has(argv[i - 1]))[0];

/** At most `max` + 1 bytes of the body (one more than the limit shows it was passed). */
async function boundedText(res, max) {
  const chunks = [];
  let size = 0;
  if (res.body) for await (const chunk of res.body) { chunks.push(chunk); size += chunk.length; if (size > max) break; }
  return { text: Buffer.concat(chunks).toString("utf8"), over: size > max };
}

async function readProof(baseUrl) {
  const url = `${String(baseUrl).replace(/\/+$/, "")}${MCP_REGISTRY_AUTH_PATH}`;
  let res;
  try {
    res = await fetch(url, { redirect: "manual", signal: AbortSignal.timeout(10000), headers: { accept: "text/plain", "user-agent": "mcp-registry/1.0" } });
  } catch {
    return { word: "unreadable", status: 0, url };
  }
  const status = res.status;
  if (status >= 300 && status < 400) return { word: "redirect", status, url };
  if (status === 404) return { word: "absent", status, url };
  if (status !== 200) return { word: "refused", status, url };
  let body;
  try { body = await boundedText(res, MCP_REGISTRY_AUTH_MAX_BYTES); } catch { return { word: "unreadable", status, url }; }
  // One line: the record and at most its line ending.
  const line = body.text.replace(/\r?\n$/, "");
  const valid = !body.over && line.startsWith("v=MCPv1;") && registryAuthProof({ MCP_REGISTRY_AUTH_PROOF: line }).proof === line;
  return { word: valid ? "ok" : "invalid", status, url };
}

const MEANING = {
  absent: "the proof route answers 404 (MCP_REGISTRY_AUTH_PROOF is unset or not a proof record on this build)",
  redirect: "the proof route answers a redirect, which the registry does not follow",
  invalid: "the proof route answers 200 with a body that is not one proof record",
  refused: "the proof route answers a status the registry does not accept",
  unreadable: "the proof route could not be read",
};

async function main() {
  if (!base || !/^https?:\/\//.test(base)) { console.error("usage: node scripts/registry-proof-check.js [--warn] [--tries N] [--wait-ms M] <base URL>"); process.exit(2); }
  let out;
  for (let attempt = 1; attempt <= TRIES; attempt++) {
    out = await readProof(base);
    if (out.word === "ok" || attempt === TRIES) break;
    await new Promise((r) => setTimeout(r, WAIT_MS));
  }
  console.log(JSON.stringify(out));
  if (out.word === "ok") { console.log("registry namespace proof: served"); return; }
  console.log(`::${WARN ? "warning" : "error"}::MCP Registry namespace proof is not served: ${MEANING[out.word]} (HTTP ${out.status}). A registry login for the domain fails until it is.`);
  process.exit(WARN ? 0 : 1);
}

await main();
