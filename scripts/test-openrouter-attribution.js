// GUARD: every OpenRouter request we make must carry our app-attribution
// headers, and every composite must book its upstream spend exactly once.
//
// Why this exists: OpenRouter's activity export files a call under the app name
// from `X-Title`. A call site that fetches openrouter.ai directly - or that
// spreads its own header object instead of the shared constant - still WORKS,
// so nothing fails, but its cost lands in the export unattributed and drops out
// of any margin review. This has already happened once: a month of activity
// contained a block of calls with no app name at all, which a margin review
// could not place against any product.
//
// The second half is the composite-accounting rule. A composite that calls
// ANOTHER composite in-process (ticker-pack calls dossier + insider) must not
// let the inner one book its own sale: one purchase would emit several usage
// rows, each with its own price, and the outer product's margin would read far
// higher than it is. The inner kits take an `accountAs` callback for this.
import { readFileSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SRC = join(ROOT, "src");
let pass = 0, fail = 0;
const ok = (cond, msg) => { if (cond) { pass++; console.log(`ok - ${msg}`); } else { fail++; console.error(`FAIL - ${msg}`); } };

function walk(dir) {
  const out = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) out.push(...walk(p));
    else if (e.name.endsWith(".js")) out.push(p);
  }
  return out;
}
const files = [...walk(SRC), ...walk(join(ROOT, "services"))];
const rel = (p) => p.slice(ROOT.length + 1);

// --- 1. the shared constant exists and carries the app name -------------------
const attribution = readFileSync(join(SRC, "openrouter-attribution.js"), "utf8");
const gateway = readFileSync(join(SRC, "tools/llm-gateway-kit.js"), "utf8");
ok(/export const OPENROUTER_ATTRIBUTION = Object\.freeze\(\{/.test(attribution), "src/openrouter-attribution.js exports a frozen OPENROUTER_ATTRIBUTION");
ok(/export \{ OPENROUTER_ATTRIBUTION \}/.test(gateway), "llm-gateway-kit re-exports it for the kits that import it from there");
for (const h of ["HTTP-Referer", "X-Title", "X-OpenRouter-Title"]) {
  ok(new RegExp(`"${h}":`).test(attribution), `the constant sets ${h}`);
}

// --- 2. no call site hardcodes the headers instead of using the constant ------
const hardcoded = files.filter((f) => /"X-Title"\s*:/.test(readFileSync(f, "utf8")) && !/OPENROUTER_ATTRIBUTION = Object\.freeze/.test(readFileSync(f, "utf8")));
ok(hardcoded.length === 0, `no file hardcodes X-Title outside the shared constant${hardcoded.length ? ` - ${hardcoded.map(rel).join(", ")}` : ""}`);
const gatewayHardcodes = (gateway.match(/"X-Title"\s*:/g) || []).length;
ok(gatewayHardcodes === 0, `llm-gateway-kit states no X-Title of its own (found ${gatewayHardcodes})`);
// A file outside src/tools that talks to openrouter.ai directly (the decide
// service) must spread the constant into its request headers.
const directCallers = files.filter((f) => !f.includes(`${join("src", "tools")}`) && /["'`]https:\/\/openrouter\.ai/.test(readFileSync(f, "utf8")) && !/OPENROUTER_ATTRIBUTION = Object\.freeze/.test(readFileSync(f, "utf8")));
const unlabelled = directCallers.filter((f) => !/headers:\s*\{\s*\.\.\.OPENROUTER_ATTRIBUTION/.test(readFileSync(f, "utf8")));
ok(unlabelled.length === 0, `every direct OpenRouter caller outside the kits sends the attribution headers${unlabelled.length ? ` - ${unlabelled.map(rel).join(", ")}` : ` (${directCallers.map(rel).join(", ") || "none"})`}`);

// --- 3. every openrouter.ai fetch is attributed --------------------------------
// A call site either goes through fetchOpenRouter (which spreads the constant)
// or spreads the constant itself. Anything else is an unattributed call.
const offenders = [];
for (const f of files) {
  const src = readFileSync(f, "utf8");
  if (!/openrouter\.ai/.test(src)) continue;
  if (/OPENROUTER_ATTRIBUTION = Object\.freeze/.test(src)) continue;  // the definition itself
  for (const m of src.matchAll(/await fetch\(([^;]{0,400}?)\)\s*;/gs)) {
    const call = m[1];
    const looksOpenRouter = /OPENROUTER|openrouter\.ai/.test(call);
    if (!looksOpenRouter) continue;
    if (!/OPENROUTER_ATTRIBUTION/.test(call)) offenders.push(`${rel(f)}: ${call.replace(/\s+/g, " ").slice(0, 90)}`);
  }
}
ok(offenders.length === 0, `every direct openrouter.ai fetch spreads OPENROUTER_ATTRIBUTION${offenders.length ? ` - ${offenders.join(" | ")}` : ""}`);

// --- 4. composites that call composites do not double-book --------------------
const inner = ["tools/dossier-kit.js", "tools/insider-flow-kit.js"];
for (const f of inner) {
  const src = readFileSync(join(SRC, f), "utf8");
  ok(/input\?\.accountAs/.test(src), `${f} honours an accountAs override instead of always booking its own sale`);
  ok(/else recordCompositeUsage\(/.test(src), `${f} still books normally when called directly`);
}
const pack = readFileSync(join(SRC, "tools/ticker-pack-kit.js"), "utf8");
ok((pack.match(/accountAs:/g) || []).length >= 2, "ticker-pack passes accountAs to BOTH inner composites");
ok(/upstreamUsd: spent \+ partSpend/.test(pack), "ticker-pack records its own spend PLUS the folded part spend, once");

console.log(`\n${fail ? "FAILED" : "OK"}: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
