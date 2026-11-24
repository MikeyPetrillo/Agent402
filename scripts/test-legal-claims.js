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
import "./lib/offline-stores.js"; // per-process and file backends whatever the caller exports (see the file)
import { readFileSync } from "node:fs";
import { pageText } from "./lib/html-text.js";

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log(`ok - ${m}`); } else { fail++; console.error(`FAIL - ${m}`); } };
const src = (p) => readFileSync(new URL(`../${p}`, import.meta.url), "utf8");
const text = pageText;

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
// The service runs with no data volume: the backup is the state database.
ok(!/data volume/.test(privacy) && !/data volume/.test(security), "neither page names a data volume the service no longer has");
ok(/Nightly backups of the state database go to separate object storage/.test(security) && /the state database, including the email, memory and ledger records/.test(privacy), "both pages name the state database as what is backed up");

// EU and UK rights: the controller is the entity /company names, the rights
// are listed, the mailbox is the one the page already uses, and the place of
// processing is stated.
{
  const { companyPage } = await import("../src/company.js");
  const legalName = (companyPage("https://agent402.tools").match(/"legalName":"([^"]+)"/) || [])[1];
  const rights = privacy.slice(privacy.indexOf("Your rights (EU and UK)"), privacy.indexOf("Children"));
  ok(legalName && rights.includes(`${legalName} , doing business as Havok Holdings LLC`), `the controller is the legal entity /company names (${legalName})`);
  for (const r of ["access", "corrected or erased", "portable form", "object to processing", "withdraw consent", "supervisory authority"]) ok(rights.includes(r), `/privacy lists the right to ${r}`);
  for (const basis of ["contract", "legitimate interest", "consent"]) ok(rights.includes(basis), `/privacy names the ${basis} legal basis`);
  ok(/email help@agent402\.tools/.test(rights) && /processed and stored there/.test(rights) && /United States/.test(rights), "/privacy says how to exercise a right and where data is processed");
}

// Google Analytics is described once, in the sentence that carries its details.
ok((privacy.match(/Pages (?:also )?run[^.]*Google Analytics/g) || []).length === 1, "/privacy introduces Google Analytics in one sentence, not two");

// Idempotency: the payment-identifier is read and the cache lives IDEM_TTL_MS.
const mins = Math.round(IDEM_TTL_MS / 60000);
ok(privacy.includes(`up to ${mins} minutes`) && /payment-identifier/.test(privacy), `/privacy names the payment-identifier and its ${mins}-minute cache`);
// The manifest key the page names is the one discovery.js publishes.
{
  const { serviceManifest } = await import("../src/discovery.js");
  const dh = serviceManifest({ baseUrl: "https://agent402.tools", network: "base", networks: ["base"], wallet: "0x0000000000000000000000000000000000000001", catalog: {}, toolCount: 0, powSlugs: new Set(), powDifficulty: 20, prices: {} })?.payment?.dataHandling || {};
  ok(dh.readsAnnotationFields === false && Array.isArray(dh.readsOnly) && /readsAnnotationFields: false/.test(privacy) && /readsOnly/.test(privacy), "/privacy names the manifest's readsOnly list and readsAnnotationFields flag");
  // The Solana payer kept is the transfer's authority (which can be a
  // multisig that does not sign), or the transaction's signers: both surfaces say so.
  const solana = /the paying wallet of a Solana payment \(the transfer's authority\) or its signers/;
  ok(solana.test(privacy) && solana.test((dh.readsOnly || []).join(" | ")), "/privacy and readsOnly name the Solana paying wallet as the transfer's authority or its signers");
  ok(!/the signers of a Solana payment/.test(privacy) && !/the signers of a Solana payment/.test((dh.readsOnly || []).join(" | ")), "neither surface says only the signers of a Solana payment");
}
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
  // "Before a repayment is sent we check the receiving address against the published sanctions lists."
  const sol = readFileSync(new URL("./solana-refund-send.js", import.meta.url), "utf8");
  ok(/we check the receiving address against the published sanctions lists; we do not send to a listed address, and a repayment waits while that check cannot be made/.test(terms)
    && /assertPayoutScreened/.test(run) && /if \(screen\) \{\s*try \{ await screen\(row\); \}/.test(run) && /held for a human, still owed/.test(run) && /sanction|screen/i.test(sol),
    "/terms says repayments are screened and held when the screen cannot run, and both refund senders screen");
  // "If an x402 payment or a Tempo transaction lands on chain after we answered the call with an error, we record the amount as owed."
  const tempo = readFileSync(new URL("../src/mpp-tempo.js", import.meta.url), "utf8");
  const late = readFileSync(new URL("../src/late-settlements.js", import.meta.url), "utf8");
  ok(/If an x402 payment on an EVM chain, Solana or Algorand whose failed settlement named its transaction, or a Tempo transaction, lands on chain after we answered the call with an error, we record the amount as owed back to the paying wallet and repay it the same way/.test(terms)
    && /TEMPO_LATE_CONFIRM_DELAYS_MS/.test(tempo) && /booked_owed/.test(late),
    "/terms names the late landing booked as owed, which the Tempo late watch and the late-settlement book do");
  // The book takes EVM, Solana and Algorand networks (not Tempo, which has its own watch), so the sentence is scoped to them.
  ok(/if \(!rail \|\| network === TEMPO_NETWORK\)/.test(late) && /startsWith\("solana:"\)\) return "svm"/.test(late) && /startsWith\("algorand:"\)\) return "avm"/.test(late) && !/If an x402 payment (or|lands)/.test(terms),
    "/terms scopes the late landing to the networks the book takes (EVM, Solana, Algorand) and Tempo's own watch");
}

// CSP: no inline script on pages, except the one sandbox route the page names.
{
  const headers = src("src/security-headers.js");
  const csp = (headers.match(/"default-src[^"]*; (script-src [^;"]*)/) || [])[1] || "";
  ok(csp && !/unsafe-inline/.test(csp), `the page CSP's script-src allows no inline script (${csp})`);
  ok(/sandboxed, network-less frame of the SDK playground/.test(security), "/security names the one route with its own looser CSP");
  ok(/sdk-playground\/sandbox[\s\S]{0,900}default-src 'none'/.test(src("src/server.js")), "control: that route's CSP denies every network fetch");
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
  const auditDays = [...privacy.matchAll(/(\d+) days after (?:it is|they are) written/g)].map((m) => Number(m[1]));
  ok(auditDays.length >= 1 && auditDays.every((d) => d === mr.auditRetentionDays()), `every audit-retention figure on /privacy is ${mr.auditRetentionDays()} days (found ${auditDays.join(", ")})`);
}

// Demand board: request text is deleted after the retention window.
{
  const { wishRetentionDays } = await import("../src/wish.js");
  ok(privacy.includes(`each request's text and hash are deleted ${wishRetentionDays()} days after it was sent`), `/privacy states the ${wishRetentionDays()}-day demand-board text retention`);
  ok(!/the text stays in our records until we clear them/.test(privacy), "/privacy no longer says the text is kept until cleared");
  ok(/^startWishRotation\(\);$/m.test(src("src/server.js")), "control: the server starts the rotation that deletes it");
  const wishDays = [...privacy.matchAll(/(\d+) days after it was sent/g)].map((m) => Number(m[1]));
  ok(wishDays.length >= 1 && wishDays.every((d) => d === wishRetentionDays()), `every demand-board retention figure on /privacy is ${wishRetentionDays()} days (found ${wishDays.join(", ")})`);
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
  // The chain table no longer carries a settler label at all; if one comes
  // back, it still must not reach llms.txt.
  ok(labels.every((label) => !llms.includes(` via ${label}`)) && !/^- \[[^\]]+\]\([^)]+\): .* via /m.test(llms.split("\n").filter((l) => lines.includes(l)).join("\n")), "no facilitator label from the chain table reaches llms.txt");
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

// The Tempo late-landing record (src/tempo-late-watches.js) is named on
// /privacy and in /.well-known/x402 readsOnly, at the bound the code keeps.
{
  const { LATE_WATCH_GIVE_UP_MS } = await import("../src/tempo-late-watches.js");
  const priv = readFileSync(new URL("../src/privacy.js", import.meta.url), "utf8").replace(/\s+/g, " ");
  const disc = readFileSync(new URL("../src/discovery.js", import.meta.url), "utf8");
  const hours = Math.round(LATE_WATCH_GIVE_UP_MS / 3600_000);
  ok(hours === 24 && priv.includes(`a Tempo pull credential answered 402 after its broadcast failed (kept with its route, amount and payer until the check for a late landing ends: minutes, at most ${hours} hours while the chain cannot be read`)
    && disc.includes(`a Tempo pull credential answered 402 after its broadcast failed, with its route, amount and the payer it names: kept until the check for a late landing ends (minutes; at most ${hours} hours while the chain cannot be read)`),
    "/privacy and /.well-known/x402 name the Tempo late-landing record and its 24-hour bound");
}

// A settled payment's replay mark (src/replay-guard.js): /privacy and the
// dataHandling text on /.well-known/x402 state the hold the guard keeps, read
// from the same functions and constants the guard runs on.
{
  const { settledHoldText, settledMarkHoldText, CONSUMED_VALIDITY_MARGIN_MS, SETTLED_HOLD_MS, MAX_SETTLED_MARK_HOLD_MS } = await import("../src/replay-guard.js");
  const { serviceManifest } = await import("../src/discovery.js");
  const margin = Math.round(CONSUMED_VALIDITY_MARGIN_MS / 60000);
  const hold = settledHoldText(), bound = settledMarkHoldText();
  ok(SETTLED_HOLD_MS > 0 && MAX_SETTLED_MARK_HOLD_MS > SETTLED_HOLD_MS && margin > 0 && /^(an? |\d)/.test(hold) && /^(a |\d)/.test(bound), `control: the hold reads ${hold}, the margin ${margin} minutes, the bound ${bound}`);
  const sentence = `kept about ${hold} after a settled call, or until the authorization's own validBefore plus ${margin} minutes when that is later`;
  ok(privacy.includes(`replay mark (${sentence}; for a grant`) && !/at most \d+ years/.test(privacy), `/privacy states the settled replay hold (${hold}, or validBefore plus ${margin} minutes), with no figure for the internal clamp`);
  ok(privacy.includes(`on chain, until the authorization's own validBefore plus ${margin} minutes`), `/privacy states the unsettled grant's hold to validBefore plus ${margin} minutes`);
  const dh = serviceManifest({ baseUrl: "https://agent402.tools", network: "base", networks: ["base"], wallet: "0x0000000000000000000000000000000000000001", catalog: {}, toolCount: 0, powSlugs: new Set(), powDifficulty: 20, prices: {} })?.payment?.dataHandling || {};
  const reads = (dh.readsOnly || []).join(" | ");
  ok(reads.includes(`as a replay mark, ${sentence}; for a grant`) && !/at most \d+ years/.test(reads), `/.well-known/x402 dataHandling states the same settled hold`);
  ok(reads.includes(`on chain, until the authorization's own validBefore plus ${margin} minutes`), `/.well-known/x402 dataHandling states the unsettled grant's hold`);
}

// The payment log lines /privacy describes: the refused-payment line and the
// paid-call timing line hold the network, the route and the first characters
// of the paying address, never the whole address.
{
  const { verifyFailureLine } = await import("../src/verify-failure-log.js");
  const payer = "0x" + "ab12".repeat(10);
  const line = verifyFailureLine({ verb: "rejected", network: "eip155:8453", scheme: "exact", reason: `insufficient funds for ${payer}`, slug: "hash", payer });
  ok(line.includes("eip155:8453") && line.includes("route=hash") && line.includes(`payer=${payer.slice(0, 6)}`) && !line.includes(payer), `control: the refused-payment line holds the network, route and a short payer (${line})`);
  const timing = src("src/paid-phase-timing.js");
  ok(/String\(w\.payer\)\.slice\(0, 6\)/.test(timing) && /net=\$\{row\.network/.test(timing) && /\[paid-timing\] \$\{row\.slug\}/.test(timing), "control: the timing line holds the network, the route and the payer's first six characters");
  ok(/The log line written for a refused payment, and the timing line written for each paid call, also hold the payment's network, the route and the first characters of the paying address\./.test(privacy), "/privacy states what the payment log lines hold");
}

// Payer sanctions screening. The x402, MPP evm and Tempo relay screens fail
// open while no sanctions list is loaded (and an EVM payment whose payer the
// screen cannot read is served unscreened), so a page sentence that says a
// payer is screened before the paid route runs states that case beside it,
// and names the live word that says whether a list is loaded.
{
  const { trustPage } = await import("../src/trust-page.js");
  const trust = text(trustPage("https://agent402.tools"));
  const pages = { "/trust": trust, "/privacy": privacy, "/terms": terms, "/security": security };
  const CLAIM = /[^.]*\b(?:screens?|screened|checked)\b[^.]*before the (?:paid )?route runs[^.]*\./gi;
  const FAIL_OPEN = /no (?:sanctions )?list is loaded[^.]*fails? open[^.]*unscreened/i;
  let claims = 0; const bare = [];
  for (const [name, t] of Object.entries(pages)) {
    for (const m of t.matchAll(CLAIM)) {
      claims++;
      const around = t.slice(Math.max(0, m.index - 300), m.index + m[0].length + 600);
      if (!FAIL_OPEN.test(around)) bare.push(`${name}: "${m[0].trim().slice(0, 90)}"`);
    }
  }
  ok(claims >= 1, `class: the pages' screened-before-the-route claims are found (${claims})`);
  ok(bare.length === 0, `class: every screened-before-the-route claim states the fail-open case beside it${bare.length ? ` (bare: ${bare.join(" | ")})` : ""}`);
  ok(!/Every rail that carries a payer address screens it/.test(trust), "/trust does not open the screening sentence unconditionally");
  ok(/as is an EVM payment whose payer the screen cannot read/.test(trust), "/trust names the unreadable-payer case the x402 screen serves unscreened");
  ok(/Tempo direct settlement is not offered/.test(trust), "/trust says Tempo direct settlement is not offered while no list is loaded");
  ok(/sanctionsScreen word on \/api\/gateway-status reads missing while no list is loaded/.test(trust), "/trust names the live word that says whether a list is loaded");
  // Controls: the code still does what the scoped sentence says.
  const screen = src("src/x402-payer-screen.js");
  ok(/serving x402 payments unscreened/.test(screen) && /named no payer this screen reads[^\n]*served unscreened/.test(screen), "control: the x402 screen serves unscreened with no list, and an unreadable EVM payer unscreened");
  ok(/serving Tempo payments unscreened/.test(src("src/payer-screen-rails.js")), "control: the Tempo relay screen serves unscreened with no list");
  ok(/tempoSettlementMode\(\) === "relay" \|\| sanctionsScreenStatus\(\) !== "missing"/.test(src("src/mpp-tempo.js")), "control: Tempo direct mode offers no challenge while no list is loaded");
  ok(/: \{ status: sanctionsScreenStatus\(\) \}/.test(src("src/server.js")), "control: /api/gateway-status publishes the sanctionsScreen word to everyone");
  ok("missing" === (await import("../src/sanctions-screen.js")).sanctionsScreenStatus(), "control: with no list loaded the word reads missing");
}

// The audit report sums what the wallet paid; repayments of charged calls are
// listed beside it, never netted from it, and the listing says so. It is a
// record of paid calls, not a compliance product: no compliance tag or alias.
{
  const kit = await import("../src/tools/audit-report-kit.js");
  const def = kit.AUDIT_TOOLS.find((t) => t.slug === "audit-report");
  ok(!/hand to an auditor|ready to hand/i.test(def.description), "audit-report: the description does not sell the report as ready for an auditor");
  ok(!def.tags.includes("compliance") && !def.aliases.includes("compliance-report") && !def.aliases.some((a) => /compliance/.test(a)), "audit-report: no compliance tag or alias");
  ok(/not netted/.test(def.description) && /refunds/.test(def.description), "audit-report: the description says repayments are listed and not netted");
  ok(!/compliance|hand to an auditor/i.test(src("src/tools/audit-report-kit.js").split("\n").slice(0, 3).join("\n")), "audit-report: the kit's header names no auditor hand-off");
  const DAY = 86_400_000, T0 = Date.parse("2026-10-01T00:00:00Z");
  const W = "0x" + "a1".repeat(20);
  const sale = { id: 1, ts: T0 + 2 * DAY, slug: "hash", priceUsd: 0.05, quotedUsd: null, rail: "x402", wire: "x402", network: "eip155:8453", tx: "0x" + "11".repeat(32) };
  const page = { rows: [sale], matched: 1, totals: { calls: 1, paidUsd: 0.05, firstAt: new Date(sale.ts).toISOString(), lastAt: new Date(sale.ts).toISOString() }, byTool: [{ slug: "hash", calls: 1, usd: 0.05 }], byDay: [{ day: "2026-10-03", calls: 1, usd: 0.05 }] };
  const ref = (id, status, usd, at, paidTx = null) => ({ evidence: "0x" + String(id).padStart(2, "0").repeat(32), network: "eip155:8453", priceUsd: usd, status, paidTx, createdAt: at, resolvedAt: paidTx ? at + 1000 : null });
  const inWindow = [ref(21, "paid", 0.05, T0 + 2 * DAY, "0x" + "22".repeat(32)), ref(23, "owed", 0.02, T0 + 3 * DAY)];
  const outside = [ref(24, "paid", 0.4, T0 - 5 * DAY, "0x" + "25".repeat(32))];
  let asked = null;
  const run = (refundsForPayer) => kit.makeAuditReportHandler({ payerOf: () => W, signer: () => null, refresh: async () => {}, refundRefresh: async () => {}, now: () => T0 + 10 * DAY, payerAuditRows: () => page, receiptsForSettlements: async () => new Map(), refundsForPayer })({ from: "2026-10-01", to: "2026-10-10" }, { headers: {} });
  const r = await run((p, o) => { asked = { p, o }; return [...inWindow, ...outside]; });
  const b = r.report.refunds || {};
  ok(asked?.p === W, "audit-report: the refunds read is the paying wallet's own");
  ok(b.netted === false && b.count === 2 && b.repaidUsd === 0.05 && b.owedUsd === 0.02, `audit-report: the refunds block lists the window's repaid and owed rows, not netted (${JSON.stringify({ netted: b.netted, count: b.count, repaidUsd: b.repaidUsd, owedUsd: b.owedUsd })})`);
  ok(r.report.totals.paidUsd === 0.05 && !("netPaidUsd" in r.report.totals), "audit-report: totals stay what the wallet paid; nothing is subtracted");
  ok(Array.isArray(b.rows) && b.rows.every((x) => x.tx !== outside[0].evidence) && b.rows.some((x) => x.status === "paid" && x.refundTx), "audit-report: a refund recorded outside the window is left out; a repaid row names its repayment");
  ok(b.complete === true && b.truncated === false, "audit-report: a read under the cap is complete");
  ok(r.reportSha256 === kit.reportDigest(r.report), "audit-report: the report digest covers the refunds block");
  const capped = Array.from({ length: kit.AUDIT_REFUNDS_MAX }, (_, i) => ref(30 + (i % 60), "owed", 0.001, T0 + 9 * DAY - i));
  const rc = (await run(() => capped)).report.refunds || {};
  ok(rc.complete === false && rc.truncated === true && rc.count === kit.AUDIT_REFUNDS_MAX, `audit-report: a read that fills the cap inside the window says it may be partial (${rc.complete}, ${rc.count})`);
  const rf = (await run(() => { throw new Error("store down"); })).report.refunds || {};
  ok(rf.read === "unavailable" && rf.count === 0 && rf.netted === false, "audit-report: a refunds read that fails says unavailable, never zero owed as fact");
}

// Signed receipts kept outside the receipt store: a delivered card report
// keeps the receipt issued at delivery on its record, and a monitor
// subscription keeps its most recent paid periods' receipts (the count the
// code keeps) until the record ends; /privacy names both.
{
  const { SUBSCRIPTION_RECEIPTS_KEPT } = await import("../src/receipt-signing.js");
  const { TOMBSTONE_FIELDS } = await import("../src/mpp-subscriptions.js");
  ok(/if \(typeof receipt === "string" && receipt\) rec\.receipt = receipt;/.test(src("src/human-checkout.js")), "control: a delivered card report keeps its signed receipt on the report record");
  ok(/signedReceipts: appendPeriodReceipt\(kept, r\)/.test(src("src/stripe-subscriptions.js")) && /signedReceipts: appendPeriodReceipt\(rec\.signedReceipts, r\)/.test(src("src/mpp-subscriptions.js")), "control: card and MPP monitor subscriptions keep their period receipts on the record");
  ok(SUBSCRIPTION_RECEIPTS_KEPT > 0 && !TOMBSTONE_FIELDS.includes("signedReceipts"), `control: ${SUBSCRIPTION_RECEIPTS_KEPT} period receipts are kept, and an ended MPP subscription's reduced record drops them`);
  ok(/the report record on our server holds the session id, your input, the finished report and the signed receipt we issued for it at delivery \(SHA-256 digests of the request and of the report, the price and Stripe's payment id\), not the email/.test(privacy), "/privacy names the card report's signed receipt on the report record");
  ok(privacy.includes(`and the signed receipts of its ${SUBSCRIPTION_RECEIPTS_KEPT} most recent paid periods (each a record of SHA-256 digests, the amount and the payment reference, kept with the period's statement, which names the subject and the period), for the life of the subscription`), `/privacy names the monitor's ${SUBSCRIPTION_RECEIPTS_KEPT} kept period receipts`);
  ok(/the email and the subject you asked us to watch are removed, and so are the signed period receipts/.test(privacy), "/privacy says an ended MPP subscription's reduced record drops its period receipts");
  ok(privacy.includes(`a signing key our server made for that subscription. Once a period is paid, the record also keeps the signed receipts of its ${SUBSCRIPTION_RECEIPTS_KEPT} most recent paid periods`), "/privacy names the period receipts on an MPP subscription's record");
}

// The privacy page's sanctions item names every payer screen the code runs:
// x402, the MPP evm wire, Tempo settled by our server, Tempo settled through
// Tempo's relay, and MPP monitor subscriptions.
{
  ok(/sanctionsScreening: x402ScreenCell\(L, "mpp-evm", true\)/.test(src("src/conformance.js")), "control: the MPP evm wire is screened by the x402 payer screen");
  ok(/Tempo relay payer screen/.test(src("src/payer-screen-rails.js")) && /mpp-tempo-relay/.test(src("src/conformance.js")), "control: a Tempo payment settled through the relay has its paying wallet screened");
  const item = privacy.slice(privacy.indexOf("Sanctions screening."), privacy.indexOf("Memory tools."));
  ok(/[Tt]he paying address of an x402 payment or of an MPP evm payment/.test(item), "/privacy: the sanctions item names the MPP evm payer");
  ok(/the paying wallet of a Tempo payment settled through Tempo's relay \(and the sender the relay settled on\)/.test(item), "/privacy: the sanctions item names the Tempo relay screen");
}

// Signed receipts cover the direct routes. A referral copy (/ref/<slug>) is
// never signed (src/server.js receiptFieldsOf); a streamed answer that is
// neither an event stream nor sent with TE: trailers is signed and fetched at
// the address its head names: the lead sentence stays the owner's line, and
// the surfaces that detail the receipt state how each one gets it. This block
// runs last: it loads a key.
{
  ok(/function receiptFieldsOf\(req, res\) \{\n\s+if \(FREE_MODE \|\| String\(req\.path \|\| ""\)\.startsWith\("\/ref\/"\)\) return null;/.test(src("src/server.js")), "control: a /ref answer is never signed");
  ok(/Every streamed answer is[\s/]+signed, a stream that is neither \(no event stream, no trailers asked[\s/]+for\) included: its head names X-Agent402-Receipt-Url/.test(src("src/receipt-signing.js")) && /a stream that is neither still gets it\./.test(src("src/conformance.js")), "control: a stream that is neither an event stream nor asked trailers still gets its receipt, fetched at the address its head names");
  const readme = src("README.md").replace(/\*\*/g, "");
  const bullet = readme.split("\n").find((l) => /signed receipt/.test(l) && /^- /.test(l)) || "";
  ok(!/Buyer protection/.test(readme), "README: no \"Buyer protection\" heading (it reads as a guarantee program)");
  ok(/on the direct routes carries a signed receipt/.test(bullet) && /a tool bought through a referral link carries none/.test(bullet) && /event-stream comment line/.test(bullet) && /TE: trailers/.test(bullet), `README: the money-path bullet scopes the signed receipt to the direct routes and names both exceptions ("${bullet.slice(0, 80)}...")`);
  // Every markdown tree: a sentence that says every settled paid answer is
  // signed scopes it to the direct routes, and its paragraph names the
  // referral exception (a /ref answer carries no receipt).
  {
    const { execFileSync } = await import("node:child_process");
    const mdFiles = execFileSync("git", ["ls-files", "*.md"], { cwd: new URL("..", import.meta.url), encoding: "utf8" }).split("\n").filter((f) => f && !f.startsWith(".claude/") && f !== "CHANGELOG.md");
    const unscoped = [];
    for (const f of mdFiles) {
      const paras = src(f).split(/\n\s*\n/).map((p) => p.replace(/\s+/g, " "));
      for (const para of paras) {
        for (const m of para.matchAll(/[^.]*\bevery (?:settled )?paid answer\b[^.]*\./gi)) {
          if (!/on the direct routes/i.test(m[0]) || !/referral/i.test(para)) unscoped.push(`${f}: "${m[0].trim().slice(0, 90)}"`);
        }
      }
    }
    ok(mdFiles.length > 20 && unscoped.length === 0, `markdown: every "every settled paid answer" scopes the receipt to the direct routes and names the referral exception (${unscoped.join("; ") || `${mdFiles.length} files read`})`);
  }
  ok(!/every paid path is signed/.test(src("src/positioning.js")) && /\/ref\/ copy is never signed/.test(src("src/positioning.js")), "positioning.js: the lead's comment states the receipt's scope, not every paid path");
  const { generateKeyPairSync } = await import("node:crypto");
  const { resetReceiptKeys, receiptsServed } = await import("../src/receipt-signing.js");
  const { markGateMounted } = await import("../src/gate-mounts.js");
  const { trustPage } = await import("../src/trust-page.js");
  const pem = generateKeyPairSync("ed25519").privateKey.export({ type: "pkcs8", format: "pem" });
  resetReceiptKeys({ RECEIPT_SIGNING_KEY: Buffer.from(pem).toString("base64"), RECEIPT_SIGNING_KEY_ID: "legal-test" });
  markGateMounted("receiptSigner");
  ok(receiptsServed(), "control: a key is loaded and the signer mounted");
  const REF = { REFERRAL_PAY_TO: "0x00000000000000000000000000000000000000a1", REFERRAL_FACILITATOR_URL: "http://127.0.0.1:9/", REFERRAL_SIGNER_KEY: "11".repeat(32), REFERRAL_SLUGS: "hash", REFERRAL_PARITY_GRANDFATHERED: "hash", REFERRAL_SETUP_URL: "https://setup.example/referral", REFERRAL_COMMISSION_BPS: "default:1234", REFERRAL_MERCHANT_ID: "4242", REFERRAL_PAYOUT_ADDRESS: "0x00000000000000000000000000000000000000b2" };
  const NOTE = "A tool bought through a referral link carries no signed receipt from this server; the payment's transaction on chain is its record.";
  const off = text(trustPage("https://agent402.tools"));
  const saved = Object.fromEntries(Object.keys(REF).map((k) => [k, process.env[k]]));
  Object.assign(process.env, REF);
  const on = text(trustPage("https://agent402.tools"));
  for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  ok(on.includes(NOTE), "/trust: with referral links offered, the receipt step says a referral purchase carries no signed receipt");
  ok(!off.includes(NOTE) && !/referral/i.test(off), "/trust: with no referral links, the page names none");
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
