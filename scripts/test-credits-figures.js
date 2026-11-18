#!/usr/bin/env node
// The credits balance page's figures (src/credits-figures.js) are stated in
// copy by reading them, never typed: the sign-in link's life, the session's
// idle and maximum life, and the low-balance threshold, on /privacy, /terms,
// the sign-in and low-balance emails, the sign-in answer and the balance
// pages. Proven by changing the figures: a child process loads the same
// modules with src/credits-figures.js rewritten (a module load hook) and
// every surface states the new figures and none of the old ones.
import "./lib/offline-stores.js";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { durationWords, SIGN_IN_TTL_MS, SESSION_IDLE_MS, SESSION_MAX_MS, LOW_BALANCE_MICRO } from "../src/credits-figures.js";

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log(`ok - ${m}`); } else { fail++; console.error(`FAIL - ${m}`); } };
const ROOT = fileURLToPath(new URL("..", import.meta.url));

ok(durationWords(15 * 60_000) === "15 minutes" && durationWords(12 * 3600_000) === "12 hours" && durationWords(60_000) === "1 minute" && durationWords(90_000) === "90 seconds" && durationWords(86_400_000) === "1 day", "durations are stated in the largest whole unit");

// What every surface states, rendered in a child with the given figures.
const RENDER = `
const { privacyPage } = await import("./src/privacy.js");
const { termsPage } = await import("./src/terms.js");
const a = await import("./src/credits-account.js");
const pg = await import("./src/credits-account-page.js");
const out = {
  privacy: privacyPage("https://agent402.tools"),
  terms: termsPage("https://agent402.tools"),
  signInEmail: a.buildSignInEmail({ link: "https://agent402.tools/x" }).text,
  lowEmail: a.buildLowBalanceEmail({ balanceUsd: 1, keyId: "0123456789ab", accountUrl: "u", unsubscribeUrl: "v" }).text,
  answer: a.SIGN_IN_ANSWER,
  accountPage: pg.creditsAccountPage("https://agent402.tools"),
  noticeOff: pg.creditsNoticeOffPage("https://agent402.tools", "0123456789ab", "k"),
};
process.stdout.write(JSON.stringify(out));`;
const HOOK = (swap) => `
import { register } from "node:module";
register("data:text/javascript," + encodeURIComponent(\`
export async function load(url, context, next) {
  const r = await next(url, context);
  if (!url.endsWith("/src/credits-figures.js")) return r;
  let src = String(r.source);
  for (const [a, b] of ${JSON.stringify(swap)}) { if (!src.includes(a)) throw new Error("hook: " + a + " not found"); src = src.replace(a, b); }
  return { ...r, source: src, shortCircuit: true };
}\`));`;
function render(swap) {
  const r = spawnSync(process.execPath, ["--import", `data:text/javascript,${encodeURIComponent(HOOK(swap))}`, "--input-type=module", "-e", RENDER], { cwd: ROOT, env: { ...process.env, CREDITS_SALES: "on" }, encoding: "utf8", timeout: 60_000, maxBuffer: 64 * 1024 * 1024 });
  if (r.status !== 0) throw new Error(`render failed: ${r.stderr.slice(0, 600)}`);
  return JSON.parse(r.stdout);
}
const flat = (h) => String(h).replace(/<[^>]*>/g, " ").replace(/\s+/g, " ");

const base = render([]);
const now = { link: durationWords(SIGN_IN_TTL_MS), idle: durationWords(SESSION_IDLE_MS), max: durationWords(SESSION_MAX_MS), low: `$${(LOW_BALANCE_MICRO / 1e6).toFixed(2)}` };
const changed = render([
  ["SIGN_IN_TTL_MS = 15 * 60_000", "SIGN_IN_TTL_MS = 25 * 60_000"],
  ["SESSION_IDLE_MS = 30 * 60_000", "SESSION_IDLE_MS = 45 * 60_000"],
  ["SESSION_MAX_MS = 12 * 3600_000", "SESSION_MAX_MS = 9 * 3600_000"],
  ["LOW_BALANCE_MICRO = 2 * 1_000_000", "LOW_BALANCE_MICRO = 3.5 * 1_000_000"],
]);
const next = { link: "25 minutes", idle: "45 minutes", max: "9 hours", low: "$3.50" };
// Where each figure is stated: the surface and the words around it (a page
// states other durations too, so the words pin the sentence).
const WHERE = [
  ["link", "privacy", (v) => `works once, for ${v};`], ["link", "privacy", (v) => `would have expired (${v})`], ["link", "terms", (v) => `valid once for ${v}.`],
  ["link", "signInEmail", (v) => `It works once, for ${v}.`], ["link", "answer", (v) => `It works once, for ${v}.`], ["link", "accountPage", (v) => `The link works once, for ${v}.`],
  ["idle", "privacy", (v) => `ends after ${v} without use`], ["idle", "privacy", (v) => `(${v} without use`],
  ["max", "privacy", (v) => `after ${v} at most`], ["max", "privacy", (v) => `, ${v} at most, or when you sign out)`],
  ["low", "privacy", (v) => `drops under ${v},`], ["low", "terms", (v) => `drops under ${v} unless`], ["low", "lowEmail", (v) => `drops under ${v}.`], ["low", "noticeOff", (v) => `drops under ${v}.`],
];
for (const [fig, s, words] of WHERE) {
  ok(flat(base[s]).includes(words(now[fig])), `${s} states the ${fig} figure as configured: "${words(now[fig])}"`);
  ok(flat(changed[s]).includes(words(next[fig])) && !flat(changed[s]).includes(words(now[fig])), `${s}: changing the ${fig} figure changes the copy: "${words(next[fig])}"`);
}
ok(flat(changed.privacy).includes(`(${next.link})`) && flat(changed.privacy).includes(`${next.idle} without use, ${next.max} at most`), "/privacy's retention sentence reads the changed figures");

// No surface types a figure: the balance page's script reads the threshold
// from session.json, and every server module reads src/credits-figures.js.
for (const f of ["src/privacy.js", "src/terms.js", "src/credits-account.js", "src/credits-account-page.js", "assets/credits/account.js"]) {
  const src = readFileSync(new URL(`../${f}`, import.meta.url), "utf8");
  const typed = ["for 15 minutes", "under $2.00", "minutes without use, after", "(15 minutes)", "30 minutes without use", "12 hours at most", "once for 15 minutes"].filter((t) => src.includes(t));
  ok(typed.length === 0, `${f} types no credits figure${typed.length ? `: ${typed.join(", ")}` : ""}`);
}
console.log(`\ntest-credits-figures: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
