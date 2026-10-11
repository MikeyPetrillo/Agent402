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

// Refunds: the chains a batch sends on are the senders refund-run.js has,
// and they cover every chain we accept payment on.
{
  const run = src("scripts/refund-run.js");
  const senders = [...run.matchAll(/^\s{4}(\w+): !!\(process\.env\.REFUND_[A-Z_]+ \|\| ""\)\.trim\(\),$/gm)].map((m) => m[1]).sort();
  ok(JSON.stringify(senders) === JSON.stringify(["algorand", "evm", "solana", "stellar", "tempo"]), `refund-run.js has senders for ${senders.join(", ")}`);
  const rr = await import("./refund-run.js");
  const { CHAIN_PAGES } = await import("../src/market-page.js");
  const accepted = [...Object.values(CHAIN_PAGES).map((c) => c.caip2), rr.TEMPO_NETWORK];
  const uncovered = accepted.filter((n) => {
    const fam = rr.familyOf(rr.normalizeNetwork(n));
    return !senders.includes(fam) || (fam === "evm" && !rr.EVM_RPCS[n]);
  });
  ok(accepted.length > 10 && !uncovered.length, `every chain we accept (${accepted.length}, Tempo included) has a refund sender, and every EVM one an RPC (uncovered: ${uncovered.join(", ") || "none"})`);
  ok(rr.familyOf(rr.normalizeNetwork("tempo")) === "tempo", "control: a Tempo debt (booked as \"tempo\") plans on the Tempo sender");
  ok(/Each batch is started and approved by hand, and it sends the repayment on every chain we accept payment on: the EVM chains, Tempo, Solana, Stellar and Algorand/.test(terms),
    "/terms says a batch repays on every chain we accept, and that each batch is started and approved by hand");
  ok(!/sent by hand|send it by hand|stays recorded as owed until/.test(terms), "/terms no longer says Tempo or Solana are repaid by hand");
  // "Started and approved by hand": the workflow is dispatch-only, dry by
  // default, and behind an environment that requires an approval.
  const wf = src(".github/workflows/refund.yml");
  ok(/^on:\n  workflow_dispatch:/m.test(wf) && !/^\s+(push|schedule|pull_request):/m.test(wf), "refund.yml runs only when dispatched by hand");
  ok(/environment: refund-approval/.test(wf) && /live:[\s\S]{0,120}default: false/.test(wf), "refund.yml waits for an approval and is a dry run unless live is chosen");
  // "We confirm your payment reached us; on Tempo and Solana also the repayment."
  ok(/const proof = await verifyInbound\(row\);/.test(run) && run.indexOf("const proof = await verifyInbound(row);") < run.indexOf("const claimed = await claim(row.id);"), "control: every send proves the inbound payment before its claim");
  ok(JSON.stringify(rr.OUTBOUND_PROOF_FAMILIES) === JSON.stringify(["tempo", "solana"]) && /on Tempo and Solana we also confirm the repayment itself before recording it as paid/.test(terms), "/terms names the chains whose repayment is proven before it is marked paid");
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

// Follow-ups: the address goes when the sequence ends; the page states the
// numbers the module runs, and a real sequence is driven to show it.
{
  const fu = await import("../src/followups.js");
  const d = (ms) => Math.round(ms / 86_400_000);
  ok(privacy.includes(`Follow-up email records delete the address as soon as the last follow-up is sent, when you stop them or buy again, or after ${fu.MAX_SEND_FAILURES} failed deliveries in a row, and in any case ${d(fu.ADDRESS_MAX_AGE_MS)} days after the purchase`), `/privacy states when a follow-up address is deleted (${fu.MAX_SEND_FAILURES} failures, ${d(fu.ADDRESS_MAX_AGE_MS)} days)`);
  ok(privacy.includes(`is deleted ${d(fu.RECORD_KEEP_MS)} days after the purchase`), `/privacy states the ${d(fu.RECORD_KEEP_MS)}-day record removal`);
  ok(!/stays in the record after the last follow-up is sent/.test(privacy), "/privacy no longer says the address outlives the last follow-up");
  const { mkdtempSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  let clock = 1_900_000_000_000;
  const f = fu.createFollowups({ storePath: join(mkdtempSync(join(tmpdir(), "legal-fu-")), "f.json"), sendEmail: async () => true, secret: "s", now: () => clock, log: () => {}, monitorFor: () => ({ product: "m", label: "M", priceUsd: "$1" }) });
  f.enqueue({ sessionId: "cs_legal", email: "legal@example.com", product: "p", kind: "k", label: "L", input: "x" });
  clock += fu.STEP_DELAYS_MS.monitor + 1000; await f.tick();
  const mid = f._store().seqs.cs_legal.email;
  clock += fu.STEP_DELAYS_MS.another; await f.tick();
  ok(mid === "legal@example.com" && f._store().seqs.cs_legal.email === null, "control: the module deletes the address in the step that sends the last follow-up");
}

// Memory audit log: the page states the retention the sweep runs.
{
  const mr = await import("../src/memory-retention.js");
  const mem = src("src/tools/memory.js");
  ok(privacy.includes(`Each entry is deleted ${mr.auditRetentionDays()} days after it is written. Within ${Math.round(mr.AUDIT_SWEEP_MS / 60000)} minutes of a key or document being deleted or expiring, the entries that name it lose the key name and values`), `/privacy states the ${mr.auditRetentionDays()}-day audit retention and the ${Math.round(mr.AUDIT_SWEEP_MS / 60000)}-minute redaction`);
  ok(/a namespace with no keys, documents or grants left loses its whole log/.test(privacy), "/privacy states that an emptied namespace loses its log");
  ok(!/The log is kept after a key is deleted or expires/.test(privacy), "/privacy no longer says the log outlives a deleted key");
  ok(/logPruneAge\.run\(nowMs - auditRetentionDays\(\) \* 86400000\)/.test(mem) && /setInterval\(\(\) => \{\n\s+try \{\n\s+sweep\(now\(\)\);/.test(mem) && /setInterval\(\(\) => \{ Promise\.resolve\(\)\.then\(\(\) => sweepLeased\(\)\)/.test(mem), "control: both memory backends run the sweep on a timer with that retention");
  ok(/AUDIT_SWEEP_MS\)\.unref\(\);/.test(mem), "control: the sweep interval is AUDIT_SWEEP_MS");
}

// Demand board: request text is deleted after the retention window.
{
  const { wishRetentionDays } = await import("../src/wish.js");
  ok(privacy.includes(`each request's text and hash are deleted ${wishRetentionDays()} days after it was sent`), `/privacy states the ${wishRetentionDays()}-day demand-board text retention`);
  ok(!/the text stays in our records until we clear them/.test(privacy), "/privacy no longer says the text is kept until cleared");
  ok(/^startWishRotation\(\);$/m.test(src("src/server.js")), "control: the server starts the rotation that deletes it");
}

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
