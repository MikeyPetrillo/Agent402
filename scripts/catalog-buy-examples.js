#!/usr/bin/env node
// Turn the weekly catalog buy's paid answers into better examples and a list of
// tools to improve.
//
// Input: the catalog-buy-outputs artifact (scripts/catalog-buy.js --outputs),
// downloaded from a run with --from-run <id> (gh) or read with --file <path>.
//
// 1. Examples. A tool with NO hand-written output example gets its captured
//    paid answer, trimmed (src/tool-output-examples.js trimToBudget), in
//    src/tool-output-examples.json. A hand-written example is never replaced:
//    where its top-level keys disagree with the real answer, the report flags
//    it instead. A captured entry is refreshed only when its key set changed or
//    with --refresh; an entry for a tool that now has a hand-written example is
//    removed. Only a passing answer seeds an example, and any example that
//    names a listed third-party host, counterparty or upstream vendor (the same
//    hashed lists scripts/test-no-third-party-names.js reads) is left out.
//    The default is a preview; --write applies it. Applying stays a reviewed PR.
//
// 2. Report. Tools graded failing or thin, ranked by severity: failed grades,
//    documented keys missing from the real answer, real keys the example lacks,
//    answers far smaller than their example, model text under a sensible length,
//    and slow calls with their latency. --report <path> writes it as markdown;
//    --step-summary <n> appends the top n to $GITHUB_STEP_SUMMARY.
//
// Usage:
//   node scripts/catalog-buy-examples.js (--from-run <id> | --file <path>)
//        [--write] [--refresh] [--report report.md] [--step-summary 20]
//        [--examples src/tool-output-examples.json] [--top 40]
import { readFileSync, writeFileSync, appendFileSync, mkdtempSync, readdirSync, realpathSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { trimToBudget, keyMismatch, normalizeEntry } from "../src/tool-output-examples.js";
import { loadVendorData, vendorHits } from "./lib/vendor-names.js";

export const DEFAULT_EXAMPLES_PATH = fileURLToPath(new URL("../src/tool-output-examples.json", import.meta.url));
export const MIN_MODEL_TEXT_CHARS = 80;
export const SLOW_MS = 30_000;
export const VERY_SLOW_MS = 90_000;
export const SMALL_RATIO = 0.25;      // answer under a quarter of its example's size
export const SMALL_MIN_DOC_BYTES = 400; // ...when the example is big enough for the ratio to mean something
const MODEL_TEXT_KEY = /^(text|answer|content|summary|report|message|output|completion|response|markdown)$/i;

// ---- third-party guard (the hashed lists the repo guard reads) -------------
const h = (s) => createHash("sha256").update(s).digest("hex").slice(0, 20);
let guardData = null;
function guard() {
  if (!guardData) {
    const tp = JSON.parse(readFileSync(new URL("./data/third-party-hashes.json", import.meta.url), "utf8"));
    const { vendors } = loadVendorData();
    guardData = { hosts: new Set(tp.hosts), names: new Set(tp.names), vendors };
  }
  return guardData;
}
/** True when `text` names a listed third-party host, counterparty or vendor. */
export function namesThirdParty(text, lists = guard()) {
  const lower = String(text || "").toLowerCase();
  if ((lower.match(/[a-z0-9-]+(?:\.[a-z0-9-]+)+/g) || []).some((t) => lists.hosts.has(h(t)) || lists.hosts.has(h(t.replace(/^www\./, ""))))) return true;
  if ((lower.match(/[a-z0-9][a-z0-9-]{2,}/g) || []).some((t) => lists.names.has(h(t)) || t.split("-").some((p) => p.length >= 4 && lists.names.has(h(p))))) return true;
  return vendorHits("captured-example", "example", lower, lists.vendors, {}).length > 0;
}

// ---- findings ---------------------------------------------------------------
const longestModelText = (body) => {
  let best = null;
  const walk = (v, key) => {
    if (typeof v === "string") { if (key && MODEL_TEXT_KEY.test(key)) best = Math.max(best ?? 0, v.length); return; }
    if (Array.isArray(v)) v.forEach((x) => walk(x, key));
    else if (v && typeof v === "object") for (const [k, x] of Object.entries(v)) walk(x, k);
  };
  walk(body, null);
  return best; // null: no model-text field to judge
};

/** Every finding for one capture record: [{ slug, kind, severity, detail }]. */
export function findingsFor(c) {
  const out = [];
  const add = (kind, severity, detail) => out.push({ slug: c.slug, kind, severity, detail });
  const body = c.captured?.body;
  if (!c.pass) add("failing", 100, `grade ${c.grade}${c.status != null ? `, HTTP ${c.status}` : ""}`);
  if (c.pass && body && c.documented?.source === "hand-written") {
    const doc = Object.fromEntries((c.documented.keys || []).map((k) => [k, true]));
    const mm = keyMismatch(doc, body);
    if (mm?.missing.length) add("example-keys-missing", 70, `documented keys absent from the real answer: ${mm.missing.join(", ")}`);
    if (mm?.extra.length) add("example-keys-extra", 40, `real top-level keys the example lacks: ${mm.extra.join(", ")}`);
  }
  if (c.pass && body) {
    const hollow = (c.documented?.populatedArrays || []).filter((k) => Array.isArray(body[k]) && body[k].length === 0);
    if (hollow.length) add("thin-empty", 60, `empty where the example shows rows: ${hollow.join(", ")}`);
    const docBytes = c.documented?.bytes || 0, gotBytes = c.captured.bytes || 0;
    if (docBytes >= SMALL_MIN_DOC_BYTES && gotBytes < docBytes * SMALL_RATIO) add("thin-small", 50, `answer ${gotBytes} B against a ${docBytes} B example`);
    if (c.modelBacked) {
      const n = longestModelText(body);
      if (n !== null && n < MIN_MODEL_TEXT_CHARS) add("thin-model-text", 50, `longest model text ${n} chars (under ${MIN_MODEL_TEXT_CHARS})`);
    }
  }
  if (Number.isFinite(c.ms) && c.ms >= SLOW_MS) add("slow", c.ms >= VERY_SLOW_MS ? 45 : 30, `${(c.ms / 1000).toFixed(1)} s`);
  return out;
}

/** All findings, ranked: severity first, then slug, then kind. */
export function rankFindings(captures) {
  return captures.flatMap(findingsFor).sort((a, b) => b.severity - a.severity || a.slug.localeCompare(b.slug) || a.kind.localeCompare(b.kind));
}

// ---- examples ---------------------------------------------------------------
const keySet = (v) => (v && typeof v === "object" && !Array.isArray(v) ? Object.keys(v).sort().join(",") : Array.isArray(v) ? "[array]" : typeof v);

/**
 * The next examples file from the current one and a run's captures. Pure.
 * Returns { next, added, refreshed, removed, kept, skipped: [{slug, reason}] }.
 */
export function planExamples(current, captures, { capturedAt, refresh = false, namesCheck = namesThirdParty } = {}) {
  const next = {};
  for (const [k, v] of Object.entries(current || {})) next[k] = v;
  const added = [], refreshed = [], removed = [], kept = [], skipped = [];
  const day = String(capturedAt || new Date().toISOString()).slice(0, 10);
  for (const c of captures) {
    const has = Object.prototype.hasOwnProperty.call(next, c.slug) && !c.slug.startsWith("_");
    if (c.documented?.source === "hand-written") {
      // Never overwrite a hand-written example; an entry it shadows is dead.
      if (has) { delete next[c.slug]; removed.push(c.slug); }
      continue;
    }
    if (!c.pass) { skipped.push({ slug: c.slug, reason: `graded ${c.grade}` }); continue; }
    if (!c.captured?.body) { skipped.push({ slug: c.slug, reason: c.dropped || "no body" }); continue; }
    const { example, fits } = trimToBudget(c.captured.body);
    if (!fits) { skipped.push({ slug: c.slug, reason: "too large after trimming" }); continue; }
    if (namesCheck(JSON.stringify(example))) { skipped.push({ slug: c.slug, reason: "names a listed third party" }); continue; }
    const entry = { capturedAt: day, example, modelBacked: c.modelBacked === true };
    if (!normalizeEntry(entry)) { skipped.push({ slug: c.slug, reason: "empty answer" }); continue; }
    if (!has) { next[c.slug] = entry; added.push(c.slug); continue; }
    if (refresh || keySet(next[c.slug].example) !== keySet(example)) { next[c.slug] = entry; refreshed.push(c.slug); continue; }
    kept.push(c.slug);
  }
  return { next, added, refreshed, removed, kept, skipped };
}

/** Stable serialization: header first, then slugs in order. */
export function serializeExamples(obj) {
  const out = {};
  for (const k of Object.keys(obj).filter((k) => k.startsWith("_")).sort()) out[k] = obj[k];
  for (const k of Object.keys(obj).filter((k) => !k.startsWith("_")).sort()) out[k] = obj[k];
  return `${JSON.stringify(out, null, 2)}\n`;
}

// ---- report -----------------------------------------------------------------
const cell = (s) => String(s ?? "").replace(/\\/g, "\\\\").replace(/\|/g, "\\|").replace(/\r?\n/g, " ");

export function markdownReport(doc, findings, plan, { top = Infinity } = {}) {
  const shown = findings.slice(0, top);
  const lines = [
    `## Catalog buy: enhancement report`,
    "",
    `run captured ${String(doc.capturedAt || "").slice(0, 10)} | tier \`${doc.tier || "?"}\` | graded ${doc.captures.length} | answers kept ${doc.captures.filter((c) => c.captured).length} | findings ${findings.length}${shown.length < findings.length ? ` (top ${shown.length} shown)` : ""}`,
    "",
    `examples: ${plan.added.length} to add, ${plan.refreshed.length} to refresh, ${plan.removed.length} to remove (now hand-written), ${plan.kept.length} unchanged. Apply locally with \`node scripts/catalog-buy-examples.js --from-run <id> --write\` and open a PR.`,
    "",
  ];
  if (!shown.length) return [...lines, "No tool graded failing or thin."].join("\n");
  lines.push("| # | slug | finding | severity | detail |", "|---:|---|---|---:|---|");
  shown.forEach((f, i) => lines.push(`| ${i + 1} | ${cell(f.slug)} | ${cell(f.kind)} | ${f.severity} | ${cell(f.detail)} |`));
  return lines.join("\n");
}

// ---- CLI --------------------------------------------------------------------
export function readOutputs(path) {
  const doc = JSON.parse(readFileSync(path, "utf8"));
  if (!doc || !Array.isArray(doc.captures)) throw new Error(`${path}: not a catalog-buy outputs file (no captures array)`);
  return doc;
}

function downloadRun(runId) {
  if (!/^\d+$/.test(String(runId))) throw new Error("--from-run takes a numeric run id");
  const dir = mkdtempSync(join(tmpdir(), "catalog-buy-outputs-"));
  execFileSync("gh", ["run", "download", String(runId), "-n", "catalog-buy-outputs", "-D", dir], { stdio: ["ignore", "inherit", "inherit"] });
  const names = readdirSync(dir);
  const f = names.find((n) => n === "catalog-buy-outputs.json") || names.find((n) => n.endsWith(".json"));
  if (!f) throw new Error(`run ${runId}: the catalog-buy-outputs artifact holds no JSON file`);
  return join(dir, f);
}

async function main() {
  const args = process.argv.slice(2);
  const arg = (n, d = null) => { const i = args.indexOf(n); return i >= 0 && args[i + 1] !== undefined ? args[i + 1] : d; };
  const examplesPath = arg("--examples", DEFAULT_EXAMPLES_PATH);
  const file = arg("--file") || (arg("--from-run") ? downloadRun(arg("--from-run")) : null);
  if (!file) { console.error("catalog-buy-examples: pass --from-run <id> or --file <path>"); process.exit(2); }
  const doc = readOutputs(file);
  let current = {};
  try { current = JSON.parse(readFileSync(examplesPath, "utf8")); } catch { /* first run */ }
  const plan = planExamples(current, doc.captures, { capturedAt: doc.capturedAt, refresh: args.includes("--refresh") });
  const findings = rankFindings(doc.captures);
  const top = Number(arg("--top", 40)) || 40;

  console.log(`examples: +${plan.added.length} added, ~${plan.refreshed.length} refreshed, -${plan.removed.length} removed, ${plan.kept.length} unchanged, ${plan.skipped.length} not usable`);
  for (const s of plan.added) console.log(`  + ${s}`);
  for (const s of plan.refreshed) console.log(`  ~ ${s}`);
  for (const s of plan.removed) console.log(`  - ${s} (a hand-written example exists)`);
  console.log(`\nfindings (${findings.length}, top ${Math.min(top, findings.length)}):`);
  for (const f of findings.slice(0, top)) console.log(`  [${String(f.severity).padStart(3)}] ${f.slug.padEnd(34)} ${f.kind.padEnd(22)} ${f.detail}`);

  const report = arg("--report");
  if (report) { writeFileSync(report, `${markdownReport(doc, findings, plan)}\n`); console.log(`\nwrote ${report}`); }
  const stepTop = arg("--step-summary");
  if (stepTop && process.env.GITHUB_STEP_SUMMARY) {
    try { appendFileSync(process.env.GITHUB_STEP_SUMMARY, `\n${markdownReport(doc, findings, plan, { top: Number(stepTop) || 20 })}\n`); } catch { /* local run */ }
  }
  if (args.includes("--write")) {
    writeFileSync(examplesPath, serializeExamples(plan.next));
    console.log(`wrote ${examplesPath}`);
  } else {
    console.log("\npreview only: pass --write to update the examples file");
  }
}

const isMain = (() => { try { return Boolean(process.argv[1]) && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url); } catch { return false; } })();
if (isMain) main().catch((e) => { console.error(`catalog-buy-examples: ${e?.message || e}`); process.exit(1); });
