#!/usr/bin/env node
// The legal and trust pages promise no more than the code delivers.
//
//   node scripts/test-legal-claims.js          (offline, no server)
//
// /privacy, /terms and /security each state facts the code decides: how long a
// backup lives, how long an idempotent answer is cached, which chains a refund
// is sent on, which MPP chains take a payment, which headers the analytics
// relay forwards, what the page CSP allows, how many monitor reports are kept.
// Each assertion reads the fact from its source and checks the rendered page
// says that, so changing the code without the page (or the page without the
// code) fails here.
import { readFileSync } from "node:fs";

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log(`ok - ${m}`); } else { fail++; console.error(`FAIL - ${m}`); } };
const src = (p) => readFileSync(new URL(`../${p}`, import.meta.url), "utf8");
const text = (html) => String(html).replace(/<[^>]+>/g, " ").replace(/\s+/g, " ");

const { privacyPage } = await import("../src/privacy.js");
const { termsPage } = await import("../src/terms.js");
const { securityPage } = await import("../src/security-page.js");
const { backupKeepDays } = await import("../src/backup.js");
const { IDEM_TTL_MS } = await import("../src/idempotency-store.js");
const { challengeEnabledForChain } = await import("../src/mpp-shim.js");

const privacy = text(privacyPage("https://agent402.tools"));
const terms = text(termsPage("https://agent402.tools"));
const security = text(securityPage("https://agent402.tools"));

// Backups: what the retention job deletes after, stated on both pages.
const days = backupKeepDays();
ok(Number.isInteger(days) && days > 0, `backup retention reads from backup.js (${days} days)`);
ok(privacy.includes(`deleted after ${days} days`), "/privacy states the backup retention the code runs");
ok(security.includes(`deleted after ${days} days`), "/security states the backup retention the code runs");
ok(!/go offsite nightly with bounded retention/.test(security), "/security no longer gives an unbounded backup claim");

// Idempotency: the payment-identifier is read and the cache lives IDEM_TTL_MS.
const mins = Math.round(IDEM_TTL_MS / 60000);
ok(privacy.includes(`up to ${mins} minutes`) && /payment-identifier/.test(privacy), `/privacy names the payment-identifier and its ${mins}-minute cache`);
ok(!/reads only the cryptographically-signed payer/i.test(privacy) && !/never parsed, logged, or retained/.test(privacy), "/privacy does not claim only the payer address is read");
ok(/payload\?\.extensions\?\.\["payment-identifier"\]/.test(src("src/payer.js")), "control: payer.js still reads the payment-identifier the page discloses");

// Telemetry: the refused-payment resource URL and the input hash are disclosed.
const posthog = src("src/posthog.js");
ok(/inputKey/.test(posthog) && /keyed hash of one declared input field/.test(privacy), "/privacy discloses the keyed input hash tool-call events carry");
ok(/payerBalanceBucket/.test(posthog) && /coarse balance bucket/.test(privacy), "/privacy discloses the balance bucket on a refused payment");

// Analytics relay: only the body and these two headers go upstream, never the client IP.
{
  const server = src("src/server.js");
  const i = server.indexOf("app.all(/^\\/e\\/(.*)$/");
  const body = server.slice(i, i + 2500);
  ok(i > 0 && /for \(const h of \["content-type", "accept"\]\) if \(req\.headers\[h\]\) headers\[h\] = req\.headers\[h\];/.test(body),
    "the /e analytics relay forwards only content-type and accept upstream");
  ok(!/x-forwarded-for|x-real-ip|req\.ip\b[^;]*headers/i.test(body.replace(/const ip = \(req\.ip[^;]*;/, "")), "the relay passes no client address header upstream");
  ok(/IP address is not passed on to the analytics provider/.test(privacy), "/privacy states what the relay forwards");
}

// MPP chains: the pages name the chains the shim challenges on by default, plus Tempo.
{
  const saved = process.env.MPP_CHALLENGE_NETWORKS; delete process.env.MPP_CHALLENGE_NETWORKS;
  ok(challengeEnabledForChain(8453) && challengeEnabledForChain(42220) && !challengeEnabledForChain(137), "control: MPP evm challenges default to Base and Celo");
  if (saved !== undefined) process.env.MPP_CHALLENGE_NETWORKS = saved;
  ok(/MPP on Base, Celo or Tempo/.test(privacy), "/privacy names the MPP chains (Base, Celo, Tempo)");
  ok(/MPP settlement on Base, Celo or Tempo/.test(terms), "/terms names the same MPP chains");
}

// Refunds: the chains a batch sends on are the senders refund-run.js has.
{
  const run = src("scripts/refund-run.js");
  const senders = [...run.matchAll(/^\s{4}(\w+): !!\(process\.env\.REFUND_[A-Z_]+ \|\| ""\)\.trim\(\),$/gm)].map((m) => m[1]).sort();
  ok(JSON.stringify(senders) === JSON.stringify(["algorand", "evm", "stellar"]), `refund-run.js has senders for ${senders.join(", ")}`);
  ok(!/"eip155:4217"/.test(run), "control: Tempo has no refund RPC entry, so its rows hold");
  ok(/On the EVM chains, Stellar and Algorand a batch sends the repayment; on Tempo and Solana the amount stays recorded as owed until we send it by hand/.test(terms),
    "/terms names which chains a refund batch sends on and which are sent by hand");
  ok(!/an amount under \$0\.05 may be held/.test(terms), "/terms does not promise a dust floor the runner does not have");
  ok(/REFUND_MIN_USD, "0"/.test(run), "control: the runner's dust floor defaults to off");
}

// CSP: no inline script on pages, except the one sandbox route the page names.
{
  const headers = src("src/security-headers.js");
  const csp = (headers.match(/"default-src[^"]*; (script-src [^;"]*)/) || [])[1] || "";
  ok(csp && !/unsafe-inline/.test(csp), `the page CSP's script-src allows no inline script (${csp})`);
  ok(/sandboxed, network-less frame of the SDK playground/.test(security), "/security names the one route with its own looser CSP");
  ok(/sdk-playground\/sandbox[\s\S]{0,400}default-src 'none'/.test(src("src/server.js")), "control: that route's CSP denies every network fetch");
}

// Monitors: the page states the report cap the scheduler enforces.
{
  const cap = Number((src("src/monitor-scheduler.js").match(/const REPORTS_PER_SUB = (\d+);/) || [])[1]);
  ok(cap > 0 && privacy.includes(`the most recent ${cap} reports we generated`), `/privacy states the ${cap}-report monitor cap`);
}

// Follow-ups: the page does not claim a deletion the code does not run.
ok(/stays in the record after the last follow-up is sent/.test(privacy), "/privacy says a follow-up address is kept unless stopped or deleted on request");

// Free trial: named on /terms where /privacy refers to it.
ok(/\?trial=1/.test(terms) && /\?trial=1/.test(privacy), "/terms and /privacy both name the ?trial=1 free trial");

// Machine copy an agent reads first: the settlement list names chains, assets
// and CAIP-2 ids, never which company settles them, and no incident is cited.
{
  const { llmsTxt } = await import("../src/seo.js");
  const { CHAIN_PAGES } = await import("../src/market-page.js");
  const llms = llmsTxt("https://agent402.tools", {});
  const lines = Object.entries(CHAIN_PAGES).map(([key, c]) => llms.split("\n").find((l) => l.startsWith(`- [${c.chainName}](https://agent402.tools/${key})`)) || "");
  ok(lines.every((l) => /^- \[[^\]]+\]\([^)]+\): [A-Z.]+ \(`[^`]+`\)$/.test(l)), `every llms.txt settlement line is chain: asset (CAIP-2) only (${lines.filter((l) => !/^- \[[^\]]+\]\([^)]+\): [A-Z.]+ \(`[^`]+`\)$/.test(l)).slice(0, 2).join(" | ") || "all clean"})`);
  const labels = [...new Set(Object.values(CHAIN_PAGES).map((c) => c.facilitatorLabel).filter(Boolean))];
  ok(labels.length > 0 && labels.every((label) => !llms.includes(` via ${label}`)), "no facilitator label from the chain table reaches llms.txt");
  ok(!/issue #\d+/.test(llms), "llms.txt cites no issue number");
}

// The connector's npm setup line names the EVM presets agent402-mcp knows by name.
{
  const { NETWORK_CAIP2 } = await import("../mcp/networks.js");
  const named = Object.entries(NETWORK_CAIP2).filter(([k, v]) => v.startsWith("eip155:") && !/sepolia/.test(k)).map(([k]) => k).sort();
  const block = (src("src/mcp-http.js").match(/const NPM_EVM_PRESETS = \{([^}]*)\}/) || [])[1] || "";
  const listed = [...block.matchAll(/(\w+):/g)].map((m) => m[1]).sort();
  ok(JSON.stringify(named) === JSON.stringify(listed), `connector setup names the npm package's EVM presets (${listed.join(", ")} vs ${named.join(", ")})`);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
