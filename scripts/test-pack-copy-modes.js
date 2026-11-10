// A skill pack's copy describes how it runs. A chain pack (each step reads the
// one before) must not be sold as parallel; a fanout pack (steps run at once,
// independent) must not be sold as a sequence. wallet-audit's metadata step
// reads a token the wallet holds, never the wallet address, and refuses with a
// 422 when the wallet holds no tokens. Offline.
import "./lib/offline-stores.js"; // per-process and file backends whatever the caller exports
const { SKILL_PACKS } = await import("../src/skills.js");
const { PACK_STEPS } = await import("../src/tools/skill-runner.js");

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log(`ok - ${m}`); } else { fail++; console.error(`FAIL - ${m}`); } };

const PARALLEL = /\b(side by side|in parallel|parallel call|all at once|simultaneous(ly)?)\b/i;
const SEQUENCE = /\b(in sequence|one after another|then feeds|feeds (it|the result) into|chained)\b/i;
let checked = 0;
const wrong = [];
for (const p of SKILL_PACKS) {
  const steps = PACK_STEPS[p.slug];
  if (!steps) continue;
  checked++;
  const txt = [p.tagline, p.useCase, ...(p.workflow || [])].filter(Boolean).join(" ");
  if (steps.mode === "chain" && PARALLEL.test(txt)) wrong.push(`${p.slug} (chain) reads "${txt.match(PARALLEL)[0]}"`);
  if (steps.mode === "fanout" && SEQUENCE.test(txt)) wrong.push(`${p.slug} (fanout) reads "${txt.match(SEQUENCE)[0]}"`);
}
ok(checked > 20, `the check reads the packs that have step configs (${checked})`);
ok(wrong.length === 0, `no pack's copy contradicts its run mode${wrong.length ? `: ${wrong.join("; ")}` : ""}`);
// Control: the patterns fire on the phrasing the review found.
ok(PARALLEL.test("one parallel call returns SPF and DMARC") && SEQUENCE.test("runs the checks in sequence"), "control: the patterns catch the phrasing they guard");

// wallet-audit: the metadata step's input comes from the balance step's tokens.
const wa = PACK_STEPS["wallet-audit"];
ok(wa?.mode === "chain", "wallet-audit runs as a chain (its metadata step reads the balance step)");
const meta = wa?.steps?.find((s) => s.slug === "token-metadata");
const wallet = "0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045";
const token = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
const got = meta?.mapInput({ address: wallet }, { "wallet-balance": { tokens: [{ contract: token, symbol: "USDC" }] } });
ok(got?.contract === token && got?.contract !== wallet, "the metadata step looks up the token the wallet holds, not the wallet address");
let err = null;
try { meta?.mapInput({ address: wallet }, { "wallet-balance": { tokens: [] } }); } catch (e) { err = e; }
ok(err?.statusCode === 422, "a wallet holding no tokens gets a 422 on the metadata step, not a lookup of its own address");
const pack = SKILL_PACKS.find((p) => p.slug === "wallet-audit");
ok(/token the wallet holds/.test(pack?.tagline || "") && !/for a given address|contracts the wallet interacts with/.test([pack?.tagline, ...(pack?.workflow || [])].join(" ")), "wallet-audit's copy says it reads a token the wallet holds");

// Pack copy, the macro tool descriptions and the storefront's fund card say
// what the data is and where it comes from: no signal, prediction or advice
// wording. (The Sahm Rule's published name, "recession indicator", is a name.)
{
  const ADVICE = /recession[- ]signal|recession lead indicator|recession-priced|recession territory|are we in (or near )?a recession|smart money|before any investment decision|recommend a savings|inflation-sensitive recommendation/i;
  const hits = [];
  for (const p of SKILL_PACKS) {
    const txt = [p.title, p.tagline, p.useCase, ...(p.workflow || []), p.claudePrompt].filter(Boolean).join(" ");
    const m = txt.match(ADVICE);
    if (m) hits.push(`${p.slug}: "${m[0]}"`);
  }
  ok(hits.length === 0, `no skill pack's copy uses signal, prediction or advice wording${hits.length ? ": " + hits.join("; ") : ""}`);
  ok(ADVICE.test("the classic recession signal") && ADVICE.test("Follow the smart money") && !ADVICE.test("the Sahm Rule recession indicator"), "control: the wording check matches the phrases it names and not the indicator's published name");
  const { readFileSync } = await import("node:fs");
  const src = (f) => readFileSync(new URL(`../${f}`, import.meta.url), "utf8");
  for (const f of ["src/human-reports-page.js", "src/tools/macro-kit.js", "wiki/Skill-Packs.md"]) {
    const lines = src(f).split("\n").filter((l) => !/^\s*\/\//.test(l) && ADVICE.test(l));
    ok(lines.length === 0, `${f} carries none of that wording${lines.length ? ": " + lines[0].trim().slice(0, 80) : ""}`);
  }
  const macro = SKILL_PACKS.find((p) => p.slug === "macro-context");
  ok(/each figure with its as-of date and source/.test(macro?.tagline || "") && /makes no forecast/.test(macro?.useCase || ""), "macro-context says its figures are dated and sourced, and that it makes no forecast");
  ok(/<h3>A fund's 13F holdings<\/h3>/.test(src("src/human-reports-page.js")), "the fund card is headed by what it reports: a fund's 13F holdings");
}

console.log(`\n${fail ? "FAILED" : "OK"}: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
