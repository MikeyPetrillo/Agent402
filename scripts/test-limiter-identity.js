#!/usr/bin/env node
// CLASS GUARD: a per-key limit beaten by rotating keys, by parallel requests
// or by a header. Batch 6 found OAuth code guesses sent in parallel past a
// per-email lockout and a handful of addresses locking everyone out; batch 7
// found any payment header skipping the /aws per-client limits and the
// code-mail allowance multiplied by rotating /64s inside one /48. Each was
// fixed with a test of its own feature; this suite holds the class.
//
//   node scripts/test-limiter-identity.js
//
//   A. The identity keys. Every spelling of one address is one limiter key
//      (case, leading zeros, "::" anywhere, IPv4-mapped forms); every address
//      in one IPv6 /64 is one key; every /64 in one /48 (and every address in
//      an IPv4 /24) is one wide key; every spelling of one mailbox ("+tag",
//      Gmail's dots and googlemail.com, case) is one mailbox key.
//   B. The registry. Every limiter declared in src/ (createLimiter and
//      createRateLimiter names, registration limiters, the connector sign-in's
//      counters, the balance page's send budgets, the /aws windows) is listed
//      in LIMITERS below with the identity it keys on. A new one fails here
//      until it is listed: name its identity and, when it is not driven here,
//      the suite that drives it with rotated keys and parallel calls. A
//      limiter whose key reads the request (headers, query, body, cookies)
//      must say so (identity "caller-text"), and a mailbox limiter keys
//      through mailboxKey.
//   C. The drivers. The limiters batches 6 and 7 touched are driven through
//      one contract: one identity spread over its rotations (addresses in a
//      /64, /64s in a /48, mailbox spellings, payment headers that do not
//      verify) and sent in parallel never gets more than its bound, and a
//      different identity is still served (the control, so the bound is not
//      met by refusing everyone).
import "./lib/offline-stores.js";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, dirname, relative } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const CLASS = "[per-key limit beaten by rotation, parallelism or a header]";
let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log(`ok - ${m}`); } else { fail++; console.error(`FAIL - ${CLASS} ${m}`); } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const { limiterKey, wideNetworkKey, createLimiter } = await import("../src/rate-limit.js");
const { mailboxKey } = await import("../src/mailbox-key.js");

// ---- A. identity keys ------------------------------------------------------------
{
  const FIX = "fold the spelling in src/rate-limit.js limiterKey (every limiter reads it)";
  const host = ["2001:db8:a:b::1", "2001:DB8:A:B::1", "2001:0db8:000a:000b:0000:0000:0000:0001", "2001:db8:a:b:0:0:0:1", "2001:db8:a:b::0:1"];
  ok(new Set(host.map(limiterKey)).size === 1, `one IPv6 address in five spellings is one limiter key (${[...new Set(host.map(limiterKey))].join(" | ")}; ${FIX})`);
  const in64 = Array.from({ length: 12 }, (_, i) => `2001:db8:a:b:${(i * 4099).toString(16)}:${(i * 7).toString(16)}::${(i + 1).toString(16)}`);
  ok(new Set(in64.map(limiterKey)).size === 1, `addresses rotated inside one /64 are one limiter key (${new Set(in64.map(limiterKey)).size} keys)`);
  ok(limiterKey("2001:db8:a:c::1") !== limiterKey(host[0]), "CONTROL: another /64 is another key");
  const v4 = ["198.51.100.7", "::ffff:198.51.100.7", "::FFFF:198.51.100.7", "0:0:0:0:0:ffff:198.51.100.7", "::ffff:c633:6407", "0000:0000:0000:0000:0000:FFFF:C633:6407"];
  ok(new Set(v4.map(limiterKey)).size === 1, `an IPv4 address and its mapped spellings are one limiter key (${[...new Set(v4.map(limiterKey))].join(" | ")}; ${FIX})`);
  ok(limiterKey("198.51.100.8") !== limiterKey("198.51.100.7") && limiterKey("::ffff:1.2.3.4") !== limiterKey("::ffff:1.2.3.5"), "CONTROL: two IPv4 hosts stay two keys, mapped or not");
  ok(limiterKey("ip:1.2.3.4|tool") === "ip:1.2.3.4|tool" && limiterKey("") === "" && limiterKey("unknown") === "unknown", "a composite or non-address key is used as given");
  const in48 = Array.from({ length: 10 }, (_, i) => `2001:DB8:7:${(i * 257).toString(16)}::${i + 1}`);
  ok(new Set(in48.map(wideNetworkKey)).size === 1 && wideNetworkKey("2001:db8:8::1") !== wideNetworkKey(in48[0]), `/64s rotated inside one /48 are one wide key, another /48 is another (${new Set(in48.map(wideNetworkKey)).size})`);
  const in24 = ["203.0.113.1", "::ffff:203.0.113.200", "203.0.113.99"];
  ok(new Set(in24.map(wideNetworkKey)).size === 1 && wideNetworkKey("203.0.114.1") !== wideNetworkKey(in24[0]), "addresses in one IPv4 /24 are one wide key, mapped or not");
  const box = ["victim@gmail.com", "Victim@Gmail.com", " v.i.c.t.i.m@gmail.com ", "victim+news@gmail.com", "victim+1@googlemail.com"];
  ok(new Set(box.map(mailboxKey)).size === 1, `spellings of one mailbox are one mailbox key (${[...new Set(box.map(mailboxKey))].join(" | ")})`);
  ok(mailboxKey("a.b+c@example.com") === mailboxKey("A.B@example.com") && mailboxKey("ab@example.com") !== mailboxKey("a.b@example.com"), "a +tag folds everywhere; dots fold only where the provider ignores them");
}

// ---- B. the registry ------------------------------------------------------------
// identity: what one bucket stands for.
//   network       the caller's address (an IPv6 /64, an IPv4 address)
//   wide          the caller's wider network (an IPv6 /48, an IPv4 /24)
//   mailbox       a mailbox (src/mailbox-key.js)
//   pair          a mailbox together with the asker's network
//   buyer         a payer or a buyer id the payment proves
//   service       the whole service (one bucket)
//   credential    a presented credential or code (a guess counter)
//   caller-text   a value the request names (kept only where the request's
//                 own text is the thing metered, never as a caller identity)
// driven: "here" (section C) or the suite that drives it with rotated keys
// and parallel calls.
const LIMITERS = {
  // createLimiter / createRateLimiter (src/rate-limit.js folds every key through limiterKey)
  "answer-share": { identity: "network", driven: "here" }, "answer-share-page": { identity: "network", driven: "here" }, "answer-share-card": { identity: "network", driven: "here" },
  "mcp": { identity: "network", driven: "here" }, "mcp-transport": { identity: "network", driven: "here" }, "mcp-transport-paid": { identity: "network", driven: "here" },
  "pow-http": { identity: "network", driven: "here" }, "trial-tool": { identity: "network", driven: "test-first-call-allowance.js" }, "trial-ip": { identity: "network", driven: "here" },
  "posthog-proxy": { identity: "network", driven: "here" }, "checkout": { identity: "network", driven: "here" }, "credits-refund": { identity: "network", driven: "here" },
  "credits-revoke": { identity: "network", driven: "here" }, "session-read": { identity: "network", driven: "here" }, "fund-resolve": { identity: "service", driven: "here" },
  "alerts-signup": { identity: "network", driven: "here" }, "alerts-email": { identity: "mailbox", driven: "here" },
  "large-body-unpaid": { identity: "network", driven: "here" }, "metered-quote": { identity: "network", driven: "here" },
  "metered-quote-refused-credential": { identity: "network", driven: "here" }, "metered-quote-paid-client": { identity: "network", driven: "test-unpaid-quote-budget.js" },
  "metered-quote-paid-egress": { identity: "network", driven: "test-unpaid-quote-budget.js" }, "revenue-read": { identity: "network", driven: "here" },
  "receipt-verify": { identity: "network", driven: "here" }, "receipt-fetch": { identity: "network", driven: "here" }, "refund-lookup": { identity: "network", driven: "here" },
  "programmatic-pages": { identity: "network", driven: "here" }, "manage-link": { identity: "network", driven: "here" }, "manage-link-email": { identity: "caller-text", driven: "test-monitor-manage-link.js" },
  "operator-attempt": { identity: "network", driven: "here" }, "operator-login": { identity: "network", driven: "here" }, "wish-intent": { identity: "network", driven: "here" },
  "wish-rerank": { identity: "network", driven: "here" }, "operator-heavy": { identity: "network", driven: "here" }, "operator-ledger": { identity: "network", driven: "here" },
  "prepayment-refusal-writes": { identity: "network", driven: "here" }, "discovery-compute": { identity: "network", driven: "here" }, "decide-feedback": { identity: "network", driven: "here" },
  "route-judge": { identity: "network", driven: "here" }, "wallet-session": { identity: "network", driven: "here" },
  "credits-sign-in": { identity: "network", driven: "here" }, "credits-sign-in-email": { identity: "pair", driven: "here" },
  "credits-sign-in-mailbox": { identity: "mailbox", driven: "here" }, "credits-sign-in-mailbox-first": { identity: "mailbox", driven: "here" },
  // registration limiters (src/registration-limits.js, keyed on limiterKey(req.ip) by server.js)
  "reg:reputation-recheck": { identity: "network", driven: "test-register-recheck-cooldown.js" }, "reg:x402": { identity: "network", driven: "test-registration-limits-redis.js" }, "reg:mpp": { identity: "network", driven: "test-registration-limits-redis.js" },
  // the connector sign-in's counters (src/mcp-oauth.js)
  "mcpo:fails": { identity: "credential", driven: "here" }, "mcpo:bearer-bad": { identity: "network", driven: "test-mcp-oauth.js" },
  "mcpo:send-ip": { identity: "network", driven: "here" }, "mcpo:send-email": { identity: "pair", driven: "here" }, "mcpo:send-email-day": { identity: "pair", driven: "here" },
  "mcpo:send-mailbox-day": { identity: "mailbox", driven: "here" }, "mcpo:send-mailbox-cold-day": { identity: "mailbox", driven: "here" },
  "mcpo:send-net-hour": { identity: "network", driven: "here" }, "mcpo:send-net-day": { identity: "network", driven: "here" }, "mcpo:send-wide-day": { identity: "wide", driven: "here" },
  "mcpo:send-global": { identity: "service", driven: "here" }, "mcpo:register": { identity: "network", driven: "here" }, "mcpo:authorize": { identity: "network", driven: "test-mcp-oauth.js" },
  "mcpo:buy": { identity: "network", driven: "test-mcp-oauth.js" }, "mcpo:token": { identity: "network", driven: "test-mcp-oauth.js" }, "mcpo:token-client": { identity: "caller-text", driven: "test-mcp-oauth.js" },
  // the balance page's send budgets (src/credits-account.js)
  "acct:send-net": { identity: "network", driven: "here" }, "acct:send-global": { identity: "service", driven: "here" }, "acct:send-wide": { identity: "wide", driven: "here" },
  // the /aws windows (src/aws-marketplace-gate.js createAwsRateLimits)
  "aws:q": { identity: "network", driven: "here" }, "aws:pc": { identity: "network", driven: "here" }, "aws:pb": { identity: "buyer", driven: "here" },
};
const IDENTITIES = new Set(["network", "wide", "mailbox", "pair", "buyer", "service", "credential", "caller-text"]);
{
  const files = [];
  const walk = (d) => { for (const f of readdirSync(d)) { const p = join(d, f); if (statSync(p).isDirectory()) walk(p); else if (f.endsWith(".js")) files.push(p); } };
  walk(join(ROOT, "src"));
  const found = new Map(); // name -> file
  const note = (name, file) => { if (!found.has(name)) found.set(name, relative(ROOT, file)); };
  const varsByFile = new Map(); // file -> [{ v, name }]
  for (const f of files) {
    const s = readFileSync(f, "utf8");
    for (const m of s.matchAll(/(?:const|let)\s+(\w+)\s*=\s*create(?:Rate)?Limiter\(\s*["']([^"']+)["']/g)) { note(m[2], f); (varsByFile.get(f) || varsByFile.set(f, []).get(f)).push({ v: m[1], name: m[2] }); }
    for (const m of s.matchAll(/\bcreate(?:Rate)?Limiter\(\s*["']([^"']+)["']/g)) note(m[1], f);
    for (const m of s.matchAll(/createRegistrationLimiter\(\{\s*name:\s*["']([^"']+)["']/g)) note(`reg:${m[1]}`, f);
    if (f.endsWith(join("src", "mcp-oauth.js"))) for (const m of s.matchAll(/\b(?:over|add|charge)\(\s*"([a-z0-9-]+)"/g)) note(`mcpo:${m[1]}`, f);
    if (f.endsWith(join("src", "credits-account.js"))) for (const m of s.matchAll(/\bspend\(\s*"([a-z0-9-]+)"/g)) note(`acct:${m[1]}`, f);
    if (f.endsWith(join("src", "aws-marketplace-gate.js"))) for (const m of s.matchAll(/\bhit\(\s*"([a-z]+)"/g)) note(`aws:${m[1]}`, f);
  }
  ok(found.size >= 60, `the scan finds the limiters declared in src/ (${found.size})`);
  const unlisted = [...found].filter(([n]) => !Object.hasOwn(LIMITERS, n));
  ok(unlisted.length === 0, `every limiter in src/ is registered with its identity (${unlisted.map(([n, f]) => `${n} in ${f}`).join(", ") || "all"}${unlisted.length ? "; add it to LIMITERS in scripts/test-limiter-identity.js with the identity it keys on and a suite that drives it rotated and in parallel" : ""})`);
  const stale = Object.keys(LIMITERS).filter((n) => !found.has(n));
  ok(stale.length === 0, `no registered limiter is gone from src/ (${stale.join(", ") || "none"})`);
  const badId = Object.entries(LIMITERS).filter(([, e]) => !IDENTITIES.has(e.identity));
  ok(badId.length === 0, `every registered identity is a known kind (${badId.map(([n]) => n).join(",") || "all"})`);
  const missingSuite = Object.entries(LIMITERS).filter(([, e]) => e.driven !== "here").filter(([, e]) => { try { return !statSync(join(ROOT, "scripts", e.driven)).isFile(); } catch { return true; } });
  ok(missingSuite.length === 0, `every limiter not driven here names a suite that exists (${missingSuite.map(([n, e]) => `${n}: ${e.driven}`).join(", ") || "all"})`);
  // Call sites: a network-keyed limiter never keys on text the request names,
  // and a mailbox-keyed one keys through mailboxKey.
  const headerish = /req\.(headers|get\(|query|body|cookies)|\bb\.email\b|\bemail\b/;
  const offenders = [];
  for (const [f, vars] of varsByFile) {
    const s = readFileSync(f, "utf8");
    const lines = s.split("\n");
    for (const { v, name } of vars) {
      const e = LIMITERS[name];
      if (!e) continue;
      lines.forEach((line, i) => {
        for (const m of line.matchAll(new RegExp(`\\b${v}\\.(?:check|peek)\\(([^)]*\\)?)`, "g"))) {
          const arg = m[1];
          if (e.identity === "network" || e.identity === "service") { if (headerish.test(arg)) offenders.push(`${relative(ROOT, f)}:${i + 1} ${name} (${e.identity}) keys on ${arg.slice(0, 60)}`); }
          if (e.identity === "mailbox" && !lines.slice(Math.max(0, i - 3), i + 1).some((l) => /mailboxKey\(/.test(l))) offenders.push(`${relative(ROOT, f)}:${i + 1} ${name} (mailbox) keys without mailboxKey`);
        }
      });
    }
  }
  ok(offenders.length === 0, `each limiter's call sites key on the identity it is registered with (${offenders.join("; ") || "all"}${offenders.length ? "; key a network limiter on the client address and a mailbox limiter through src/mailbox-key.js mailboxKey" : ""})`);
}

// ---- C. the drivers: one contract -----------------------------------------------
// drive({ name, bound, rotated, distinct, attempt }): `attempt(id)` resolves
// true when the call was served. The rotated identities share one bound,
// sequential and in parallel; the distinct one is still served afterwards.
async function drive({ name, bound, rotated, distinct, attempt, fresh }) {
  {
    const a = await fresh();
    let served = 0;
    for (const id of rotated) if (await a(id)) served++;
    ok(served <= bound && served > 0, `${name}: rotated one identity sequentially, served ${served} of ${rotated.length}, bound ${bound}`);
    ok(await a(distinct), `${name}: CONTROL, a different identity is still served`);
  }
  {
    const a = await fresh();
    const got = await Promise.all(rotated.map((id) => a(id)));
    const served = got.filter(Boolean).length;
    ok(served <= bound && served > 0, `${name}: rotated one identity in parallel, served ${served} of ${rotated.length}, bound ${bound}`);
    ok(await a(distinct), `${name}: CONTROL, a different identity is still served after the parallel burst`);
  }
}
const spellings64 = (n, p = "2001:db8:c:d") => Array.from({ length: n }, (_, i) => [`${p}::${(i + 1).toString(16)}`, `${p.toUpperCase()}:0:0:0:${(i + 1).toString(16)}`, `${p}:${(i * 911 + 1).toString(16)}::9`][i % 3]);
const spellingsV4 = (n) => Array.from({ length: n }, (_, i) => (i % 2 ? "::ffff:192.0.2.44" : "192.0.2.44"));

// C1. createLimiter: every network limiter above shares it.
await drive({
  name: "createLimiter (network)", bound: 4, rotated: [...spellings64(10), ...spellings64(4, "2001:db8:c:d")], distinct: "2001:db8:c:e::1",
  fresh: async () => { const l = createLimiter(`id-${Math.random()}`, { perMin: 4, perHour: 4 }); return async (id) => !l.check(id).limited; },
  attempt: null,
});
await drive({
  name: "createLimiter (IPv4 and its mapped spellings)", bound: 3, rotated: spellingsV4(9), distinct: "192.0.2.45",
  fresh: async () => { const l = createLimiter(`id4-${Math.random()}`, { perMin: 3, perHour: 3 }); return async (id) => !l.check(id).limited; },
});

// C2. /aws: the unpaid window keys on the client network through the gate's
// own default key, and the paid window on the buyer across addresses.
{
  const gate = await import("../src/aws-marketplace-gate.js");
  const src = readFileSync(join(ROOT, "src", "aws-marketplace-gate.js"), "utf8");
  const def = /clientKey = \(req\) => ([^,]+\)\)),/.exec(src);
  ok(def && /limiterKey\(/.test(def[1]), `/aws: the gate's default client key folds the address through limiterKey (${def ? def[1] : "not found"})`);
  const keyOf = (ip) => limiterKey(String(ip || ""));
  await drive({
    name: "/aws unpaid window (network)", bound: 3, rotated: spellings64(9, "2001:db8:aa:1"), distinct: "2001:db8:aa:2::1",
    fresh: async () => { const l = gate.createAwsRateLimits({ quotesPerMin: 3, paidPerMin: 3 }); return async (ip) => l.quote(keyOf(ip)) === 0; },
  });
  await drive({
    name: "/aws paid window (buyer across addresses)", bound: 2, rotated: Array.from({ length: 8 }, (_, i) => ({ ip: `198.51.100.${i + 1}`, buyer: "buyer-1" })), distinct: { ip: "198.51.100.99", buyer: "buyer-2" },
    fresh: async () => { const l = gate.createAwsRateLimits({ quotesPerMin: 100, paidPerMin: 2 }); return async ({ ip, buyer }) => l.paid(keyOf(ip), buyer) === 0; },
  });
}

// C3. The balance page's sign-in link (src/credits-account.js): per mailbox
// with the asker's network, per mailbox across askers, and the first-send
// allowance past the service budget per wider network.
{
  const { createCreditsAccount, accountSecretFrom } = await import("../src/credits-account.js");
  const { createJsonDocument } = await import("../src/json-document.js");
  const { createMemoryLimits } = await import("../src/shared-limits.js");
  const { useGuardsTable, guardsTable } = await import("./lib/credits-guards-table.js");
  const { mkdtempSync, rmSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const dir = mkdtempSync(join(tmpdir(), "limiter-identity-"));
  process.on("exit", () => rmSync(dir, { recursive: true, force: true }));
  const credits = { balancesForEmail: async () => [] };
  const mk = (sizes, sentTo) => createCreditsAccount({
    credits, baseUrl: "https://agent402.tools", secret: accountSecretFrom("sk_test_fixture"), sendEmail: async (m) => { sentTo.push(m.to); return true; },
    store: createJsonDocument({ name: `li-${Math.random()}`, file: join(dir, `${Math.random()}.json`), log: () => {} }), limits: createMemoryLimits(),
    ipLimiter: createLimiter(`li-ip-${Math.random()}`, { perMin: 1000, perHour: 1000 }),
    emailLimiter: createLimiter(`li-e-${Math.random()}`, { perMin: sizes.pair, perHour: sizes.pair }),
    mailboxLimiter: createLimiter(`li-m-${Math.random()}`, { perMin: sizes.mailbox, perHour: sizes.mailbox }),
    coldLimiter: createLimiter(`li-c-${Math.random()}`, { perMin: sizes.cold, perHour: sizes.cold }), log: () => {},
  });
  const keep = guardsTable();
  useGuardsTable({ ...keep, account: { ...keep.account, sendsGlobalPerHour: 1000, sendsPerNetHour: 1000 } });
  const box = ["victim@gmail.com", "Victim+a@gmail.com", "v.ictim@gmail.com", "victim+b@googlemail.com", "VICTIM@gmail.com", "vic.tim+c@gmail.com"];
  await drive({
    name: "balance-page sign-in (mailbox spellings from one network)", bound: 2, rotated: [...box, ...box], distinct: "someone@example.com",
    fresh: async () => { const sent = []; const a = mk({ pair: 2, mailbox: 50, cold: 50 }, sent); return async (e) => { const r = a.requestSignIn(e, "203.0.113.50"); if (r.work) await r.work; return r.status === 200; }; },
  });
  await drive({
    name: "balance-page sign-in (one mailbox from many networks)", bound: 3 + 2, rotated: Array.from({ length: 16 }, (_, i) => ({ e: box[i % box.length], ip: `192.0.2.${i + 1}` })), distinct: { e: "other@example.com", ip: "192.0.2.200" },
    fresh: async () => { const sent = []; const a = mk({ pair: 1, mailbox: 3, cold: 2 }, sent); return async ({ e, ip }) => { const r = a.requestSignIn(e, ip); if (r.work) await r.work; return r.status === 200; }; },
  });
  // Past the service-wide budget, a network's first link is counted per /48.
  useGuardsTable({ ...keep, account: { ...keep.account, sendsGlobalPerHour: 1, sendsPerNetHour: 1000 } });
  await drive({
    name: "balance-page first link past the service budget (/64s in one /48)", bound: 1 + 1, rotated: Array.from({ length: 8 }, (_, i) => ({ e: `rot${i}@example.com`, ip: `2001:db8:77:${(i + 1).toString(16)}::1` })), distinct: { e: "far@example.com", ip: "2001:db8:78::1" },
    fresh: async () => {
      const sent = []; const a = mk({ pair: 100, mailbox: 100, cold: 100 }, sent);
      // Each attempt names its own address, so a send is read by its address (a count before and after is wrong under parallel calls).
      return async ({ e, ip }) => { const r = a.requestSignIn(e, ip); if (r.work) await r.work; return sent.includes(e); };
    },
  });
  useGuardsTable(keep);
}

// C4. The connector sign-in (src/mcp-oauth.js), mounted on a bare app with a
// shared-limits store that answers after a delay, as Redis does.
{
  const { guardsTable, useGuardsTable } = await import("./lib/credits-guards-table.js");
  process.env.CREDITS_SALES = "on"; process.env.MCP_OAUTH = "on";
  const BASE = guardsTable();
  const { createMcpOAuth } = await import("../src/mcp-oauth.js");
  const { SKIP_UPDATE } = await import("../src/json-document.js");
  const { createMemoryLimits } = await import("../src/shared-limits.js");
  const { default: express } = await import("express");
  const memStore = () => {
    const s = { body: {} };
    s.read = async () => ({ ok: true, body: structuredClone(s.body) });
    s.update = async (fn) => { for (;;) { const seen = s.body; await sleep(1); const r = fn(structuredClone(seen)); if (r === SKIP_UPDATE) return { ok: true }; if (s.body !== seen) continue; s.body = r; return { ok: true }; } };
    return s;
  };
  const slowLimits = (ms) => {
    const m = createMemoryLimits();
    const slow = (f) => async (...a) => { await sleep(ms); return f(...a); };
    return { ...m, counterAdd: slow(m.counterAdd), counterGet: slow(m.counterGet), windowAdd: slow(m.windowAdd), windowRead: slow(m.windowRead) };
  };
  async function harness(table = {}) {
    useGuardsTable({ ...BASE, mcpOAuth: { ...BASE.mcpOAuth, ...table } });
    const sent = [];
    const oa = createMcpOAuth({ credits: { balancesForEmail: async () => [], grantSpentToday: async () => 0 }, store: memStore(), clientStore: memStore(), requestStore: memStore(), secret: "s".repeat(32), baseUrl: "https://agent402.tools", limits: slowLimits(3), sendEmail: async (m) => { sent.push({ to: m.to, code: (/\b(\d{6})\b/.exec(m.text) || [])[1] }); return true; }, log: () => {} });
    const app = express();
    oa.mount(app, { express, clientIp: (r) => String(r.headers["x-test-ip"] || "127.0.0.1") });
    const server = await new Promise((r) => { const x = app.listen(0, "127.0.0.1", () => r(x)); });
    const U = `http://127.0.0.1:${server.address().port}`;
    const h = { sent, U, close: () => new Promise((r) => server.close(r)) };
    h.register = (ip) => fetch(`${U}/oauth/register`, { method: "POST", headers: { "content-type": "application/json", "x-test-ip": ip }, body: JSON.stringify({ redirect_uris: ["https://claude.ai/cb"] }) });
    h.start = async (ip, client) => {
      const a = await fetch(`${U}/oauth/authorize?${new URLSearchParams({ response_type: "code", client_id: client, redirect_uri: "https://claude.ai/cb", state: "s", code_challenge_method: "S256", code_challenge: "A".repeat(43) })}`, { redirect: "manual", headers: { "x-test-ip": ip } });
      if (a.status !== 303) return null;
      const rid = new URL(a.headers.get("location"), U).searchParams.get("rid");
      const cookie = (a.headers.get("set-cookie") || "").split(";")[0];
      const html = await (await fetch(`${U}/oauth/consent?rid=${rid}`, { headers: { cookie, "x-test-ip": ip } })).text();
      return { rid, cookie, ip, csrf: (/name="csrf" value="([^"]+)"/.exec(html) || [])[1] };
    };
    h.post = (s, fields) => fetch(`${U}/oauth/consent`, { method: "POST", redirect: "manual", headers: { "content-type": "application/x-www-form-urlencoded", cookie: s.cookie, "x-test-ip": s.ip, "sec-fetch-site": "same-origin" }, body: new URLSearchParams({ rid: s.rid, csrf: s.csrf, ...fields }).toString() });
    return h;
  }
  const hs = [];
  const fresh = async (table, prep) => { const h = await harness(table); hs.push(h); return prep(h); };
  try {
    // Registration per network: spellings and rotations inside one /64.
    await drive({
      name: "connector app registration (network)", bound: 4, rotated: spellings64(12, "2001:db8:5:6"), distinct: "2001:db8:5:7::1",
      fresh: () => fresh({ registerPerIp: 4 }, (h) => async (ip) => (await h.register(ip)).status === 201),
    });
    // Code mail to one mailbox from many networks, its spellings, in parallel:
    // the day ceiling plus the first-send allowance, however many ask.
    const perDay = 2;
    // Every attempt a spelling of its own (one mailbox), so each send is read by the address it went to.
    const spell = (i) => [`owner+${i}@gmail.com`, `o.wner+${i}@gmail.com`, `ow.ner+${i}@googlemail.com`][i % 3];
    await drive({
      name: "connector code mail (one mailbox from many networks)", bound: perDay * 2, rotated: Array.from({ length: 14 }, (_, i) => ({ ip: `198.18.${i + 1}.1`, email: spell(i) })), distinct: { ip: "198.18.200.1", email: "someone-else@example.com" },
      fresh: () => fresh({ sendsPerEmailDay: perDay, sendsPerEmail: 50, sendsPerIp: 500 }, async (h) => {
        const client = (await (await h.register("198.18.0.1")).json()).client_id;
        return async ({ ip, email }) => {
          const s = await h.start(ip, client);
          if (!s?.csrf) return false;
          await (await h.post(s, { action: "email", email })).text();
          return h.sent.some((m) => m.to === email);
        };
      }),
    });
    // Past the service-wide hourly budget, a first send per wider network.
    await drive({
      name: "connector code mail past the service budget (/64s in one /48)", bound: 1 + 1, rotated: Array.from({ length: 8 }, (_, i) => ({ ip: `2001:db8:99:${(i + 1).toString(16)}::1`, email: `r${i}@example.com` })), distinct: { ip: "2001:db8:9a::1", email: "far@example.com" },
      fresh: () => fresh({ sendsGlobalPerHour: 1, sendsPerEmail: 50, sendsPerIp: 500, sendsPerEmailDay: 50 }, async (h) => {
        const client = (await (await h.register("198.18.0.2")).json()).client_id;
        return async ({ ip, email }) => {
          const s = await h.start(ip, client);
          if (!s?.csrf) return false;
          await (await h.post(s, { action: "email", email })).text();
          return h.sent.some((m) => m.to === email);
        };
      }),
    });
    // Wrong codes in parallel from one address: at most the bound compared.
    {
      const fails = 3;
      const h = await harness({ failsPerEmail: fails, emailCodeTries: 50, sendsPerEmail: 50, sendsPerIp: 500, sendsPerEmailDay: 50 });
      hs.push(h);
      const client = (await (await h.register("198.18.50.1")).json()).client_id;
      const ip = "2001:db8:51:1::1";
      const open = [];
      for (let i = 0; i < 3; i++) { const s = await h.start(i % 2 ? ip.toUpperCase() : ip, client); await (await h.post(s, { action: "email", email: `g${i}@example.com` })).text(); s.code = h.sent.at(-1)?.code; open.push(s); }
      let compared = 0;
      await Promise.all(open.flatMap((s) => Array.from({ length: 6 }, (_, i) => async () => {
        const r = await h.post(s, { action: "code", code: String((Number(s.code) + 1 + i) % 1_000_000).padStart(6, "0") });
        if (/did not match|no longer works/.test(await r.text())) compared++;
      })).map((f) => f()));
      ok(open.every((s) => s.code) && compared <= fails && compared > 0, `connector wrong codes in parallel from one /64: ${compared} compared, bound ${fails}`);
      const own = await h.start("198.18.60.1", client);
      await (await h.post(own, { action: "email", email: "g0@example.com" })).text();
      const html = await (await h.post(own, { action: "code", code: h.sent.at(-1).code })).text();
      ok(!/did not match|no longer works|Too many/.test(html), "CONTROL: a different network still signs in with its own code");
    }
  } finally { for (const h of hs) await h.close(); useGuardsTable(BASE); }
}

console.log(`\ntest-limiter-identity: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
