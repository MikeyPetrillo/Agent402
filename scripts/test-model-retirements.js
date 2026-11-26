// Upstream model retirements, checked against our code. A quoted model id
// that appears in live code after its retirement date fails the build; before
// the date the guard only reports how many days are left. Comments are not
// matched: only quoted strings, which is where a request would name the model.
// A retirement-table key ("id": { until: ... }) is not a use: it is what keeps
// a caller naming the retired id served by its successor, so it stays.
//
//   node scripts/test-model-retirements.js
//   MODEL_RETIREMENTS_NOW=2026-12-12 node scripts/test-model-retirements.js
// The second form reads the code as of that day (an ISO date or time), so a
// change can prove it passes after a retirement date before the date comes.
import "./lib/offline-stores.js"; // per-process and file backends whatever the caller exports (see the file)
import { fileURLToPath } from "node:url";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

const RETIRING = [
  { vendor: "OpenAI", ids: ["gpt-image-1", "openai/gpt-image-1", "gpt-4o-2024-05-13", "gpt-4.1-nano-2025-04-14"], retires: "2026-10-23" },
  { vendor: "OpenAI", ids: ["gpt-image-1-mini", "openai/gpt-image-1-mini", "gpt-image-1.5", "openai/gpt-image-1.5"], retires: "2026-12-01" },
  { vendor: "OpenAI", ids: ["gpt-5", "openai/gpt-5", "gpt-5-mini", "openai/gpt-5-mini", "gpt-5-nano", "openai/gpt-5-nano", "gpt-5-pro", "openai/gpt-5-pro", "o3", "openai/o3", "o3-pro", "openai/o3-pro"], retires: "2026-12-11" },
  { vendor: "OpenAI", ids: ["tts-1", "tts-1-hd", "gpt-4o-mini-tts"], retires: "2027-01-06" },
  { vendor: "Anthropic", ids: ["claude-sonnet-4-5-20250929", "anthropic/claude-sonnet-4-5-20250929", "claude-sonnet-4-5", "anthropic/claude-sonnet-4.5"], retires: "2026-11-30" },
  { vendor: "Anthropic", ids: ["claude-opus-4-5-20251101", "anthropic/claude-opus-4-5-20251101", "claude-opus-4-5", "anthropic/claude-opus-4.5"], retires: "2027-01-22" },
  { vendor: "OpenAI", ids: ["gpt-image-2", "openai/gpt-image-2", "gpt-image-2-2026-04-21"], retires: "2027-02-10" },
];

function sources(dir, out = []) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) sources(p, out);
    else if (/\.(js|mjs)$/.test(name)) out.push(p);
  }
  return out;
}
const files = sources(fileURLToPath(new URL("../src", import.meta.url)));
const RETIREMENT_KEY = /(["'`])[^"'`\n]+\1:\s*\{\s*until:/g;
// An air-quality pollutant code ("o3" is ozone) is a contract value, not a
// model id: a quoted value under a `pollutant` key is not read.
const POLLUTANT_VALUE = /\bpollutant:\s*(["'`])[^"'`\n]+\1/g;
const text = new Map(files.map((f) => [f, readFileSync(f, "utf8").replace(RETIREMENT_KEY, "").replace(POLLUTANT_VALUE, "")]));
const NOW_OVERRIDE = process.env.MODEL_RETIREMENTS_NOW;
const now = NOW_OVERRIDE ? Date.parse(NOW_OVERRIDE) : Date.now();
if (!Number.isFinite(now)) { console.log(`FAIL MODEL_RETIREMENTS_NOW is not a date: ${NOW_OVERRIDE}`); process.exit(1); }
if (NOW_OVERRIDE) console.log(`reading as of ${new Date(now).toISOString()}`);
let fail = 0, pass = 0;
for (const r of RETIRING) {
  const days = Math.ceil((Date.parse(r.retires) - now) / 86_400_000);
  const hits = [];
  for (const id of r.ids) {
    const needles = [`"${id}"`, `'${id}'`, `\`${id}\``];
    for (const [f, src] of text) if (needles.some((n) => src.includes(n))) hits.push(`${id} in ${f.replace(/^.*\/src\//, "src/")}`);
  }
  if (!hits.length) { pass++; continue; }
  if (days <= 0) { fail++; console.log(`FAIL ${r.vendor} retired ${r.retires}, still in code:\n  ${hits.join("\n  ")}`); }
  else console.log(`warn ${r.vendor} retires ${r.retires} (${days} days${days <= 14 ? ", within 14" : ""}): still referenced in ${hits.length} place(s)${days <= 14 ? `:\n  ${hits.join("\n  ")}` : ""}`);
}
// OpenAI's 2026-06-11 notice removes these ids from the API on 2026-12-11;
// its deprecations page (developers.openai.com/api/docs/deprecations, read
// 2026-11-25) names each replacement (pro mode for the -pro ids is the -pro
// listing). The scan group above and the gateway's RETIRING_MODELS must both
// carry that date and successor, so moving one date (or one successor) fails
// here instead of drifting.
const NOTICE_2026_12_11 = {
  "openai/gpt-5": "openai/gpt-6.1-sol",
  "openai/gpt-5-mini": "openai/gpt-6.1-terra",
  "openai/gpt-5-nano": "openai/gpt-6-luna",
  "openai/gpt-5-pro": "openai/gpt-6.1-sol-pro",
  "openai/o3": "openai/gpt-6.1-sol",
  "openai/o3-pro": "openai/gpt-6.1-sol-pro",
};
{
  const { RETIRING_MODELS } = await import("../src/tools/llm-gateway-kit.js");
  for (const [id, use] of Object.entries(NOTICE_2026_12_11)) {
    const group = RETIRING.find((r) => r.ids.includes(id));
    const e = RETIRING_MODELS[id];
    const okDate = group?.retires === "2026-12-11" && group.ids.includes(id.replace(/^openai\//, ""));
    const okTable = e?.until === "2026-12-11" && e.use === use && e.asItselfUntil === true;
    if (okDate && okTable) pass++;
    else { fail++; console.log(`FAIL ${id}: scan group ${group?.retires ?? "missing"}, RETIRING_MODELS ${e ? `${e.until} -> ${e.use}` : "missing"} (notice: 2026-12-11 -> ${use})`); }
  }
  // The /api/llm-premium proxy (llm-kit.js) serves o3 and o3-pro by the same
  // named replacement from the same day.
  const { RETIRING: PROXY_RETIRING } = await import("../src/tools/llm-kit.js");
  for (const id of ["o3", "o3-pro"]) {
    const e = PROXY_RETIRING[id], use = NOTICE_2026_12_11[`openai/${id}`].replace(/^openai\//, "").replace(/-pro$/, "");
    if (e?.until === "2026-12-11" && e.use === use) pass++;
    else { fail++; console.log(`FAIL llm-kit RETIRING ${id}: ${e ? `${e.until} -> ${e.use}` : "missing"} (notice: 2026-12-11 -> ${use})`); }
  }
  // Anthropic's model deprecations page (platform.claude.com/docs/en/about-claude/model-deprecations,
  // read 2026-11-25): each retirement with the replacement it names.
  const ANTHROPIC_NOTICES = {
    "anthropic/claude-sonnet-4.5": ["2026-11-30", "anthropic/claude-sonnet-5.5"],
    "anthropic/claude-opus-4.5": ["2027-01-22", "anthropic/claude-opus-5.5"],
  };
  for (const [id, [until, use]] of Object.entries(ANTHROPIC_NOTICES)) {
    const e = RETIRING_MODELS[id];
    if (e?.until === until && e.use === use && e.asItselfUntil === true) pass++;
    else { fail++; console.log(`FAIL ${id}: RETIRING_MODELS ${e ? `${e.until} -> ${e.use}` : "missing"} (notice: ${until} -> ${use})`); }
  }
  // Every scan id that is also a RETIRING_MODELS key carries the same date.
  for (const r of RETIRING) for (const id of r.ids) {
    const e = RETIRING_MODELS[id];
    if (!e) continue;
    if (e.until === r.retires) pass++;
    else { fail++; console.log(`FAIL ${id}: scan date ${r.retires}, RETIRING_MODELS ${e.until}`); }
  }
}
// Scheduled chat retirements (RETIRING_MODELS asItselfUntil entries, such as
// gpt-4o and gpt-4o-mini on 2027-01-14) as of the same day: no tier default,
// compat default, fallback or auto rung names an id retired by then, every
// such id is still admitted on a tier and served there by a successor that is
// itself not retired, and the OpenAI proxy's defaults are not retired either.
{
  const K = await import("../src/tools/llm-gateway-kit.js");
  const P = await import("../src/tools/llm-kit.js");
  const { TIERS: IMG, RETIRED_IMAGE_MODELS } = await import("../src/tools/image-gen-kit.js");
  const named = [];
  for (const [slug, t] of Object.entries(K.TIERS)) {
    for (const m of [t.defaultModel, t.defaultModelCompat, ...(t.fallbacks || [])]) if (m) named.push([`${slug} ${m}`, m]);
  }
  for (const [q, b] of Object.entries(K.AUTO_RANKINGS)) for (const [c, list] of Object.entries(b)) for (const m of list) named.push([`auto ${q}/${c} ${m}`, m]);
  const due = (until) => now >= Date.parse(`${until}T00:00:00Z`);
  for (const [where, m] of named) {
    const r = K.RETIRING_MODELS[m];
    if (r && due(r.until)) { fail++; console.log(`FAIL ${where}: retired ${r.until}, still named`); } else pass++;
  }
  // A tier list (metered's is the union of the flat lists) that names a
  // retiring id by itself drops it on its date: /v1/models stops printing it
  // then (advertisedPrefixes), and the entry would only be dead config.
  for (const [slug, t] of Object.entries(K.TIERS)) {
    for (const p of t.prefixes || []) {
      const r = Object.hasOwn(K.RETIRING_MODELS, p) ? K.RETIRING_MODELS[p] : null;
      if (!r) continue;
      if (due(r.until)) { fail++; console.log(`FAIL ${slug} lists ${p} by name, retired ${r.until}: drop it from the list`); }
      else console.log(`warn ${slug} lists ${p} by name; it retires ${r.until}: drop it from the list that day`);
    }
  }
  // On the date of every retirement (and today), /v1/models and each tier's
  // advertised list (what the live-catalog guard grades) name no id retired
  // by then: an id the gateway serves as its successor is never advertised.
  {
    const retiredAt = (at) => Object.entries(K.RETIRING_MODELS).filter(([, r]) => !r.asItselfUntil || at >= Date.parse(`${r.until}T00:00:00Z`)).map(([id]) => id);
    const days = [...new Set([...Object.values(K.RETIRING_MODELS).map((r) => Date.parse(`${r.until}T00:00:00Z`)), now])].sort((a, b) => a - b);
    for (const at of days) {
      K.setRetiringClockForTest(() => at);
      try {
        const gone = new Set(retiredAt(at));
        const day = `${at === now ? "today, " : ""}${new Date(at).toISOString().slice(0, 10)}`;
        const printed = K.modelsList().data.map((m) => m.id).filter((id) => gone.has(id));
        const advertised = typeof K.advertisedPrefixes === "function"
          ? Object.keys(K.TIERS).flatMap((s) => K.advertisedPrefixes(s).filter((p) => gone.has(p)).map((p) => `${s}:${p}`))
          : ["advertisedPrefixes is not exported"];
        if (!printed.length && !advertised.length) pass++;
        else { fail++; console.log(`FAIL as of ${day}: retired ids still advertised (/v1/models: ${printed.join(", ") || "none"}; tier lists: ${advertised.join(", ") || "none"})`); }
      } finally { K.setRetiringClockForTest(null); }
    }
  }
  K.setRetiringClockForTest(() => now);
  try {
    for (const [id, r] of Object.entries(K.RETIRING_MODELS)) {
      if (!r.asItselfUntil || !due(r.until)) continue;
      const homes = Object.keys(K.TIERS).filter((s) => K.tierAllows(s, K.canonicalModel(id), id));
      const succ = K.RETIRING_MODELS[r.use];
      if (homes.length && !(succ && due(succ.until))) pass++;
      else { fail++; console.log(`FAIL ${id}: retired ${r.until}; served on [${homes.join(", ")}] by ${r.use}${succ ? ` (itself retired ${succ.until})` : ""}`); }
    }
  } finally { K.setRetiringClockForTest(null); }
  for (const slug of ["llm", "llm-pro", "llm-premium"]) {
    const d = P.proxyDefaultModel(slug);
    if (d && !P.retiredSuccessor(d, now)) pass++; else { fail++; console.log(`FAIL ${slug}: default ${d} is retired as of this day`); }
  }
  for (const [slug, t] of Object.entries(IMG)) {
    const r = RETIRED_IMAGE_MODELS[t.model];
    if (r && due(r.until)) { fail++; console.log(`FAIL ${slug}: renders on ${t.model}, retired ${r.until}`); } else pass++;
  }
}
// The wiki and docs: a sentence that says an id "is served as itself until"
// a date names the date RETIRING_MODELS holds, and none is left once that
// date has passed (the id is then served by its successor).
{
  const { RETIRING_MODELS } = await import("../src/tools/llm-gateway-kit.js");
  const { execFileSync } = await import("node:child_process");
  const { readFileSync } = await import("node:fs");
  const root = new URL("..", import.meta.url);
  const files = execFileSync("git", ["ls-files", "wiki/*.md", "docs/*.md", "*.md"], { cwd: root, encoding: "utf8" }).split("\n").filter((f) => f && f !== "CHANGELOG.md");
  let seen = 0;
  for (const f of [...new Set(files)]) {
    const text = readFileSync(new URL(f, root), "utf8").replace(/\s+/g, " ");
    for (const m of text.matchAll(/`([\w.\/:-]+)` is served as itself until (?:its upstream expiration on )?(\d{4}-\d{2}-\d{2})/g)) {
      seen++;
      const r = RETIRING_MODELS[m[1]];
      if (!r) { fail++; console.log(`FAIL ${f}: ${m[1]} is "served as itself until ${m[2]}" but RETIRING_MODELS has no entry`); }
      else if (r.until !== m[2]) { fail++; console.log(`FAIL ${f}: ${m[1]} until ${m[2]}, RETIRING_MODELS ${r.until}`); }
      else if (now >= Date.parse(`${m[2]}T00:00:00Z`)) { fail++; console.log(`FAIL ${f}: ${m[1]} is still "served as itself until ${m[2]}", a date that has passed: name its successor mapping instead`); }
      else pass++;
    }
  }
  console.log(`markdown "served as itself until" sentences read: ${seen}`);
}
console.log(`${pass} retirement checks clean, ${fail} failing`);
process.exit(fail ? 1 : 0);
