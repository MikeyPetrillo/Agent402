// F-15: what we publish ABOUT NAMED THIRD PARTIES.
//
// seller-dossier and the two leaderboards are the only products that publish an
// assessment-shaped read of a named outside business. The rule that keeps such a
// report fair is not a disclaimer bolted on the page - it is that every line is
// an OBSERVATION we made, by a stated method, at a stated time, with no claim
// about the company's intent or character, and a route to have a reading
// corrected. This pins that rule so a future flag cannot quietly cross it.
//
// Scoped to the claim, not to the file that drifted last: any flag added to the
// dossier is swept, whatever it says.
import { NOTICE, buildSellerDossierTool } from "../src/tools/seller-dossier.js";
import { readFileSync } from "node:fs";

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log(`ok - ${m}`); } else { fail++; console.error(`FAIL - ${m}`); } };

// --- the notice exists, says the four things, and names a correction route ---
for (const k of ["what", "notAnAssessment", "unobserved", "pointInTime", "corrections"]) {
  ok(typeof NOTICE[k] === "string" && NOTICE[k].length > 40, `NOTICE.${k} is stated`);
}
ok(/not an assessment of the business/i.test(NOTICE.notAnAssessment),
  "the notice disclaims assessing the business, in those words");
ok(/@/.test(NOTICE.corrections) && /correct or withdraw/i.test(NOTICE.corrections),
  "the notice names a reachable correction route and what we will do");
ok(Object.isFrozen(NOTICE), "the notice is frozen: a caller cannot edit it out of a response");

// --- the dossier SHIPS it in the payload, not just in docs ---
{
  const src = readFileSync(new URL("../src/tools/seller-dossier.js", import.meta.url), "utf8");
  ok(/notice:\s*NOTICE/.test(src), "the dossier envelope carries `notice` (it rides with the quote, not in docs)");
  ok(/generatedAt,/.test(src), "the dossier envelope carries generatedAt (every figure is point-in-time)");
}

// --- no flag may impute intent, character or conduct to a named business ---
{
  const src = readFileSync(new URL("../src/tools/seller-dossier.js", import.meta.url), "utf8");
  const flags = [...src.matchAll(/flags\.push\(\s*(`|")([\s\S]*?)\1/g)].map((m) => m[2]);
  ok(flags.length > 15, `swept every dossier flag (${flags.length} found)`);
  // Words that assert a purpose or a character rather than a reading of ours.
  const IMPUTING = [
    /\baimed at\b/i, /\bintended to\b/i, /\bdeliberate/i, /\bdeceptive/i, /\bfraud/i,
    /\bscam/i, /\bfake\b/i, /\bwash[- ]trad/i, /\bmalicious/i, /\bdishonest/i,
    /\buntrustworthy\b/i, /\bbad actor/i, /\blying\b/i, /\bfabricat/i,
  ];
  const bad = flags.filter((f) => IMPUTING.some((re) => re.test(f)));
  ok(bad.length === 0, `no flag imputes intent or character (${bad.length ? bad.join(" | ") : "none"})`);
}

// --- the leaderboard disclosure is asserted against the RENDERED PAGE ---
//
// The first cut of this guard read src/leaderboard.js and passed while
// measuring nothing: `leaderboardPage` there is imported by server.js and never
// invoked - dead, like src/pricing-page.js and src/landing.js. The live page is
// ledgerLeaderboardPage. A guard that greps the module its author happened to
// edit certifies only that module. Render the page a visitor gets instead.
{
  // Defaults to the booted server the CI lane already runs on :3000, like every
  // other page test here. Reading only TARGET_URL would make these three
  // assertions skip in CI - inert, which is the failure this guard exists to
  // catch. A server that is not up fails the check rather than skipping it.
  const target = process.env.TARGET_URL || "http://localhost:3000";
  const up = await fetch(`${target}/health`).then((r) => r.ok).catch(() => false);
  if (!up) {
    ok(false, `leaderboard render check could not reach a server at ${target} (boot one, or set TARGET_URL)`);
  } else {
    const html = await fetch(`${target}/leaderboard`).then((r) => r.text());
    ok(/not asserting that any flagged row is inauthentic/i.test(html),
      "rendered /leaderboard says plainly what a concentration flag does NOT mean");
    ok(/mike@agent402\.tools/.test(html) && /correct or withdraw/i.test(html),
      "rendered /leaderboard names a correction route");
    ok(/an assessment of any business/i.test(html),
      "rendered /leaderboard disclaims assessing the business");
  }
}

// --- a planted violation must FAIL, or this file is decoration ---
{
  const IMPUTING = [/\baimed at\b/i, /\bwash[- ]trad/i];
  const planted = "this seller is running wash-trading through one payer";
  ok(IMPUTING.some((re) => re.test(planted)),
    "control: the imputing-language rule catches a planted violation");
}

// --- the tool still builds with the notice attached ---
{
  const tool = buildSellerDossierTool({
    getSellerDetail: () => null, getSellerEntry: () => null, getDispatchRow: () => null,
    getEvidenceBinding: () => null, getLeaderboardRow: () => null, getBazaarQuality: () => null,
    getSolanaEvidence: () => null, getMpp: () => null, getRefusals: () => [],
    getDeliveryFailures: () => [], getRegistration: () => null, getDelivery: () => null,
    getSharedClaims: () => [],
  });
  ok(tool.slug === "seller-dossier", "the dossier tool still builds");
}

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
