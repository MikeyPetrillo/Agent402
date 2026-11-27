// A skill pack's copy describes how it runs. A chain pack (each step reads the
// one before) must not be sold as parallel; a fanout pack (steps run at once,
// independent) must not be sold as a sequence. wallet-audit's metadata step
// reads a token the wallet holds, never the wallet address, and refuses with a
// 422 when the wallet holds no tokens. Offline.
import "./lib/offline-stores.js"; // per-process and file backends whatever the caller exports
const { SKILL_PACKS, packPageCopy } = await import("../src/skills.js");
// The page's short copy (src/skill-page-copy.js) is read beside the pack's own.
const pageText = (p) => { const c = packPageCopy(p); return [c.lead, c.use, ...(c.steps || [])]; };
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
  const txt = [p.tagline, p.useCase, ...(p.workflow || []), ...pageText(p)].filter(Boolean).join(" ");
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
ok(/token the wallet holds/.test(pack?.tagline || "") && !/for a given address|contracts the wallet interacts with/.test([pack?.tagline, ...(pack?.workflow || []), ...(pack ? pageText(pack) : [])].join(" ")), "wallet-audit's copy says it reads a token the wallet holds");

// Pack copy, the macro tool descriptions and the storefront's fund card say
// what the data is and where it comes from: no signal, prediction or advice
// wording. (The Sahm Rule's published name, "recession indicator", is a name.)
{
  const ADVICE = /recession[- ]signal|recession lead indicator|recession-priced|recession territory|are we in (or near )?a recession|smart money|before any investment decision|recommend a savings|inflation-sensitive recommendation/i;
  const hits = [];
  for (const p of SKILL_PACKS) {
    const txt = [p.title, p.tagline, p.useCase, ...(p.workflow || []), p.claudePrompt, ...pageText(p)].filter(Boolean).join(" ");
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
  const macroPage = macro ? packPageCopy(macro) : {};
  ok(/each figure with its as-of date and source/.test(macroPage.lead || "") && /makes no forecast/.test(macroPage.use || ""), "macro-context's page copy says the same");
  ok(/<h3>A fund's 13F holdings<\/h3>/.test(src("src/human-reports-page.js")), "the fund card is headed by what it reports: a fund's 13F holdings");
}

// A pack's copy names only what its tools do. Each rule is a claim the copy
// once made past its tools: email-validate reads syntax and the domain's MX
// records (it probes no mailbox and suggests no correction), cpi-yoy answers
// headline CPI only, redact masks the patterns it matches (the text is not
// thereby safe to store), a certificate transparency read needs the tool that
// makes it, no pack reads a page's links, and a stock-history close is a
// venue close. Read on every pack in full and on its page copy, stock on and off.
{
  const { ALL_SKILL_PACKS } = await import("../src/skills.js");
  const { PACK_BRAND_FLOOR } = await import("./sync-count.js");
  const RULES = [
    ["a mailbox probe or a typo suggestion", /mailbox reachab|dead mailbox|likely[- ]typos?|reachable MX|MX is actually reachable|typo of a major provider/i, () => false],
    ["core CPI from cpi-yoy", /headline and core|core (CPI|inflation)/i, () => false],
    ["text that is safe to store, or free of PII", /safe to store|holds PII|sloppy with retention/i, () => false],
    ["certificate transparency", /certificate transparency|\bCT logs?\b/i, (p) => (p.toolSlugs || []).includes("cert-transparency")],
    ["a page's link graph as something the pack reads", /on-page link graph|where do its links point/i, () => false],
  ];
  const strings = (p) => {
    const out = [p.tagline, p.useCase, p.claudePrompt, ...(p.workflow || [])];
    for (const stock of [true, false]) { const c = packPageCopy(p, { stock }); out.push(c.lead, c.use, ...(c.steps || [])); }
    return out.filter(Boolean);
  };
  const findings = (packs, rules = RULES) => packs.flatMap((p) => strings(p).flatMap((t) => rules.filter(([, re, allowed]) => re.test(t) && !allowed(p)).map(([what]) => `${p.slug} claims ${what}: "${t.slice(0, 70)}"`)));
  const found = findings(ALL_SKILL_PACKS);
  ok(ALL_SKILL_PACKS.length >= PACK_BRAND_FLOOR && found.length === 0, `no pack's copy claims what its tools do not do${found.length ? `: ${found.join("; ")}` : ""}`);
  const fake = (text, toolSlugs = ["email-validate"]) => [{ slug: "control-pack", tagline: text, toolSlugs }];
  for (const [text, tools] of [["Catches typos, disposable domains and dead mailboxes."], ["Read headline and core CPI year over year with cpi-yoy."], ["into something safe to store"], ["robots policy, and certificate transparency.", ["whois"]], ["and the on-page link graph."]]) {
    ok(findings(fake(text, tools)).length >= 1, `control: "${text}" is caught`);
  }
  ok(findings(fake("Pull the certificate transparency log.", ["cert-transparency"])).length === 0, "control: a pack that holds cert-transparency may name it");
  // A stock-history close in page copy is a venue close, said where it is named.
  const venue = ALL_SKILL_PACKS.flatMap((p) => { const c = packPageCopy(p, { stock: true }); return [c.lead, c.use, ...(c.steps || [])].filter((t) => t && /24 hours old/.test(t) && !/not (the )?consolidated/.test(t)).map((t) => `${p.slug}: "${t.slice(0, 70)}"`); });
  const named = ALL_SKILL_PACKS.flatMap((p) => { const c = packPageCopy(p, { stock: true }); return [c.lead, c.use, ...(c.steps || [])].filter((t) => t && /24 hours old/.test(t)); });
  ok(named.length >= 3 && venue.length === 0, `page copy that names delayed stock closes says they are not consolidated (${named.length} lines)${venue.length ? `: ${venue.join("; ")}` : ""}`);
  const text = SKILL_PACKS.find((p) => p.slug === "text-hygiene");
  const { PII_TYPES } = await import("../src/tools/pii-redact.js");
  ok(PII_TYPES.join() === "email,card,ssn,phone,ip" && /no later step sees the emails, phone numbers, card numbers, SSNs and IPv4 addresses it matched/.test(packPageCopy(text).use || "") && /emails, phone numbers, card numbers, SSNs and IPv4 addresses it matched/.test(text.useCase), "text-hygiene names the five patterns redact matches, and redact still matches those five");
}

// A pack's copy says which of its tools are pure-CPU, free over proof-of-work
// or wallet-only, and each such claim is read against the pack's tool list:
// a tool is PoW-eligible when src/free-tier.js lists it and WALLET_ONLY_SLUGS
// (src/pow.js) does not. Four shapes of claim, sentence by sentence:
//   "N of M tools are PoW-eligible" (or wallet-only)   N and M are the pack's counts
//   "four pure-CPU ...", "two egress ..."   the count of eligible (or not) tools
//   "all N tools are wallet-only / egress"  no tool is eligible
//   pure-CPU / PoW-eligible / free over PoW / free tier / no egress:
//     with "only ... is paid" beside it, the pack holds both kinds;
//     in a clause that names tools and no "all" or "every", those tools are eligible;
//     said of all or every tool or step, or with no subject ("Pure CPU."),
//     every tool in the pack is eligible; otherwise at least one is.
{
  const { ALL_SKILL_PACKS } = await import("../src/skills.js");
  const { FREE_TIER_SLUGS } = await import("../src/free-tier.js");
  const { WALLET_ONLY_SLUGS } = await import("../src/pow.js");
  const eligible = (slug) => FREE_TIER_SLUGS.has(slug) && !WALLET_ONLY_SLUGS.has(slug);
  const NUM = { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12 };
  const num = (w) => (/^\d+$/.test(w) ? Number(w) : NUM[String(w).toLowerCase()]);
  const CLAIM = /pure[- ]CPU|PoW-eligible|free over (?:PoW|proof-of-work|the proof-of-work tier)|free via proof-of-work|free tier|egress is 0|\b(?:no|zero) egress\b/i;
  const NO_EGRESS = /egress is 0|\b(?:no|zero) egress\b/i;
  const UNIVERSAL = /\b(?:all|every|each|whole)\b/i;
  const SCOPED = /\bonly\b[^.]*\b(?:is|are) paid\b/i;
  const names = (text, slug) => new RegExp(`(?<![\\w-])${slug.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?![\\w-])`).test(text);
  const strings = (p) => {
    const out = [p.tagline, p.useCase, p.claudePrompt, ...(p.workflow || [])];
    for (const stock of [true, false]) { const c = packPageCopy(p, { stock }); out.push(c.lead, c.use, ...(c.steps || [])); }
    return [...new Set(out.filter(Boolean))];
  };
  const claimFindings = (packs) => {
    const out = [];
    for (const p of packs) {
      const tools = p.toolSlugs || [];
      const free = tools.filter(eligible), paid = tools.filter((t) => !eligible(t));
      const say = (what, sentence) => out.push(`${p.slug} ${what} (${free.length} of ${tools.length} tools are PoW-eligible; not: ${paid.join(", ") || "none"}): "${sentence.trim().slice(0, 90)}"`);
      for (const text of strings(p)) {
        for (const sentence of text.split(/(?<=[.!?])\s+/)) {
          let counted = false;
          const of = sentence.match(/\b(\w+) of (\w+) tools are PoW-eligible/i);
          if (of && num(of[1]) != null && num(of[2]) != null) { counted = true; if (num(of[1]) !== free.length || num(of[2]) !== tools.length) say("miscounts its PoW-eligible tools", sentence); }
          for (const m of sentence.matchAll(/\b(\w+) (pure[- ]CPU|egress)\b/gi)) {
            const n = num(m[1]);
            if (n == null) continue;
            counted = true;
            const have = /egress/i.test(m[2]) ? paid.length : free.length;
            if (n !== have) say(`counts ${m[1]} ${m[2]} tools`, sentence);
          }
          const ofPaid = sentence.match(/\b(\w+) of (\w+) tools are wallet-only/i);
          if (ofPaid && num(ofPaid[1]) != null && num(ofPaid[2]) != null) { counted = true; if (num(ofPaid[1]) !== paid.length || num(ofPaid[2]) !== tools.length) say("miscounts its wallet-only tools", sentence); }
          if (/\ball (?:of (?:these|the) )?(?:\w+ )?tools (?:are (?:wallet-only|egress)|touch external APIs)/i.test(sentence)) { counted = true; if (free.length) say("calls every tool wallet-only", sentence); }
          if (!CLAIM.test(sentence) || (counted && !/;/.test(sentence))) continue;
          if (SCOPED.test(sentence)) { if (!free.length || !paid.length) say("splits free steps from paid ones", sentence); continue; }
          for (const clause of sentence.split(/;\s+/)) {
            if (!CLAIM.test(clause)) continue;
            const named = tools.filter((t) => names(clause, t));
            if (/\b\w+ of \w+ tools are\b/i.test(clause)) continue; // a counted clause, held above
            const whole = UNIVERSAL.test(clause) || new RegExp(`^\\W*(?:${CLAIM.source})`, "i").test(clause) || (NO_EGRESS.test(clause) && !named.length);
            if (whole) { if (paid.length) say("calls every tool pure-CPU or free", sentence); }
            else if (named.length) { if (named.some((t) => !eligible(t))) say(`calls ${named.filter((t) => !eligible(t)).join(", ")} pure-CPU or free`, sentence); }
            else if (!free.length) say("calls some steps pure-CPU or free", sentence);
          }
        }
      }
    }
    return out;
  };
  const found = claimFindings(ALL_SKILL_PACKS);
  ok(found.length === 0, `every pure-CPU, free and wallet-only claim in pack copy matches the pack's tools${found.length ? `:\n  ${found.join("\n  ")}` : ""}`);
  const claims = ALL_SKILL_PACKS.filter((p) => strings(p).some((t) => CLAIM.test(t))).length;
  ok(claims >= 8, `the check reads the packs that make such a claim (${claims})`);
  ok(eligible("hash") && !eligible("email-validate") && !eligible("extract"), "control: hash is PoW-eligible; email-validate and extract are not");
  const fake = (text, toolSlugs) => [{ slug: "control-pack", tagline: text, toolSlugs }];
  const mixed = ["email-validate", "uuid", "hash"], pure = ["uuid", "hash"], net = ["email-validate", "extract"];
  for (const [text, tools] of [
    ["One pass, every step a pure-CPU call.", mixed], ["All three tools are pure-CPU (PoW-eligible / free tier).", mixed], ["Hashes and mints. Pure CPU.", mixed],
    ["2 of 3 tools are PoW-eligible (extract is wallet-only).", ["extract", "email-validate", "hash"]], ["all 2 tools are PoW-eligible (pure network I/O).", net],
    ["Three tools - one pure-CPU, two egress.", mixed], ["Stats steps are free over PoW; only the data fetch is paid.", pure], ["Checks mail; email-validate is pure-CPU.", mixed],
    ["All three tools are wallet-only (egress).", mixed], ["Budget small; all of these tools are wallet-only (paid per call).", mixed], ["1 of 3 tools are wallet-only; uuid is pure-CPU.", ["email-validate", "extract", "uuid"]], ["1 of 3 tools are wallet-only; email-validate is pure-CPU.", mixed], ["The mint steps are free over PoW.", net], ["Reads bytes - egress is 0, but CPU is meaningful.", mixed],
  ]) ok(claimFindings(fake(text, tools)).length >= 1, `control: "${text}" on [${tools.join(", ")}] is caught`);
  for (const [text, tools] of [
    ["One pass, every step a pure-CPU call.", pure], ["2 of 3 tools are PoW-eligible (email-validate is wallet-only).", mixed], ["Three tools - two pure-CPU, one egress.", mixed],
    ["Mint steps are free over PoW; only the mail check is paid.", mixed], ["Checks mail; hash is pure-CPU.", mixed], ["1 of 3 tools are wallet-only (a live read); hash is pure-CPU.", mixed], ["All two tools are wallet-only (egress).", net],
    ["Scores a risk-free rate into free-form objects.", net],
  ]) ok(claimFindings(fake(text, tools)).length === 0, `control: "${text}" on [${tools.join(", ")}] passes`);
}

console.log(`\n${fail ? "FAILED" : "OK"}: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
