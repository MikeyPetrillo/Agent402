// E2B cost/output caps (audit F12). stdout/stderr/result/traceback were
// returned unbounded; now an aggregate UTF-8 budget truncates them with an
// explicit marker, and a global concurrency ceiling refuses new sandboxes
// before creation. Offline unit test of the cap logic + config.
//
//   node scripts/test-code-run-caps.js
import "./lib/offline-stores.js"; // per-process and file backends whatever the caller exports (see the file)
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { __test } from "../src/tools/code-run-kit.js";

const { capUtf8, TIERS, E2B_MAX_CONCURRENT } = __test;
let pass = 0, fail = 0;
const ok = (c, m) => { c ? pass++ : fail++; console.log(`${c ? "ok" : "FAIL"} - ${m}`); };

// Under budget: unchanged, not truncated.
{
  const r = capUtf8("hello world", 1024);
  ok(r.text === "hello world" && !r.truncated && r.used === 11, "under-budget output is returned unchanged");
}

// Over budget: truncated to the byte budget with a marker + truncated flag.
{
  const r = capUtf8("x".repeat(100_000), 1024);
  ok(r.truncated === true, "over-budget output is flagged truncated");
  ok(/output truncated at 1024 bytes/.test(r.text), "carries an explicit truncation marker");
  ok(r.used === 1024, "accounts exactly the budget it consumed");
}

// UTF-8 safety: cutting mid-multibyte-char must not emit a broken/oversized string.
{
  const r = capUtf8("😀".repeat(1000), 10); // each emoji is 4 bytes
  ok(r.truncated, "multibyte output truncates");
  ok(!r.text.slice(0, r.text.indexOf("\n")).includes("�"), "no replacement char from a split multibyte boundary");
}

// Aggregate budgeting: a shared budget drained field-by-field (as the handler does).
{
  let budget = 1000;
  const take = (v) => { const c = capUtf8(v, Math.max(0, budget)); budget -= c.used; return c; };
  const a = take("a".repeat(600));
  const b = take("b".repeat(600)); // only ~400 bytes of budget left
  ok(!a.truncated && a.used === 600, "first field fits");
  ok(b.truncated && b.used === 400, "second field truncated to the REMAINING budget (aggregate cap)");
  ok(budget === 0, "aggregate budget fully consumed, never negative");
}

// FR4-09: the thrown-error name + value (execution.error.value) go through the
// SAME aggregate budget as stdout/stderr/result/traceback — a multi-megabyte
// error message must not bypass the cap.
{
  let budget = 1000;
  const take = (v) => { const c = capUtf8(v, Math.max(0, budget)); budget -= c.used; return c; };
  const stdout = take("s".repeat(300));
  const errName = take("Error");
  const errMsg = take("E".repeat(5_000_000)); // huge thrown error value
  const traceback = take("t".repeat(5_000_000));
  const total = stdout.used + errName.used + errMsg.used + traceback.used;
  ok(errMsg.truncated, "a multi-megabyte error message is truncated");
  ok(total <= 1000, `error name+message+traceback stay inside the aggregate cap (used ${total} <= 1000)`);
  // The handler wires these fields through take() (guards against regression).
  const src = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "..", "src", "tools", "code-run-kit.js"), "utf8");
  ok(/const errMsg = execution\.error \? take\(execution\.error\.value/.test(src), "handler routes execution.error.value through take() (budgeted)");
}

// Config sanity.
{
  ok(TIERS["code-run"].maxOutputBytes === 256 * 1024 && TIERS["code-run-pro"].maxOutputBytes === 1024 * 1024, "tiers carry an output byte cap");
  ok(typeof E2B_MAX_CONCURRENT === "number" && E2B_MAX_CONCURRENT >= 1, `global sandbox concurrency ceiling is set (${E2B_MAX_CONCURRENT})`);
}

// Offline sandbox stub: timeouts, creation failures and per-caller concurrency.
{
  const { CODE_RUN_TOOLS } = await import("../src/tools/code-run-kit.js");
  const run = CODE_RUN_TOOLS.find((t) => t.slug === "code-run").handler;
  const realKey = process.env.E2B_API_KEY;
  process.env.E2B_API_KEY = "e2b-test-not-a-key";
  const timeoutErr = (msg) => Object.assign(new Error(msg), { name: "TimeoutError" });
  let behavior = null;
  __test.setSandbox({ create: async () => behavior.create() });
  const sandbox = (runCode) => ({ runCode, kill: async () => {} });
  const req = (ip, header) => ({ ip, header: (k) => (header && (k === "payment-signature") ? header : undefined) });
  try {
    // The buyer's code hit the time limit: answered with the partial output.
    behavior = { create: async () => sandbox(async (_code, opts) => { opts.onStdout?.({ line: "tick 1\n" }); opts.onStdout?.({ line: "tick 2\n" }); opts.onStderr?.({ line: "warn\n" }); throw timeoutErr("Execution timed out - the 'timeoutMs' option can be used to increase this timeout"); }) };
    const r = await run({ code: "while True: pass" }, req("10.0.0.1"));
    ok(r.timedOut === true && r.stdout === "tick 1\ntick 2\n" && r.stderr === "warn\n" && r.error === null, "a run that hits the time limit returns 200 with timedOut and the partial output");
    ok(CODE_RUN_TOOLS.every((t) => /timedOut: true/.test(t.description) && /is charged/.test(t.description)), "both tiers disclose that a timed-out run is returned and charged");

    // A transport timeout is not the buyer's code: still an uncharged 504.
    behavior = { create: async () => sandbox(async () => { throw timeoutErr("Request timed out - the 'requestTimeoutMs' option can be used to increase this timeout"); }) };
    let e = await run({ code: "print(1)" }, req("10.0.0.1")).catch((x) => x);
    ok(e?.statusCode === 504, `a request timeout stays a 504 (got ${e?.statusCode})`);

    // Sandbox creation failure: generic 503, no upstream text.
    const warn = console.warn; console.warn = () => {};
    behavior = { create: async () => { throw new Error("403: account SECRET-ACCOUNT-STATE e2b-test-not-a-key"); } };
    e = await run({ code: "print(1)" }, req("10.0.0.1")).catch((x) => x);
    console.warn = warn;
    ok(e?.statusCode === 503 && /temporarily unavailable/.test(e.message) && !/SECRET|e2b-test/.test(e.message), "sandbox creation failure is a generic 503 with no upstream detail");

    // Per-caller concurrency by IP (no payer identity): a looser limit, since
    // many callers can share one address; the next one past it is refused.
    let release; const gate = new Promise((r) => { release = r; });
    behavior = { create: async () => sandbox(async () => { await gate; return { logs: { stdout: ["ok\n"], stderr: [] }, text: null, error: null }; }) };
    const held = Array.from({ length: __test.PER_IP_MAX_CONCURRENT }, (_, k) => run({ code: `a${k}` }, req("10.0.0.2")));
    await new Promise((r) => setTimeout(r, 10));
    const third = run({ code: "c" }, req("10.0.0.2")).catch((x) => x);
    e = await Promise.race([third, new Promise((r) => setTimeout(() => r("still running"), 50))]);
    ok(__test.PER_IP_MAX_CONCURRENT > __test.PER_PAYER_MAX_CONCURRENT && e?.statusCode === 429 && /too many concurrent runs/i.test(e.message), `one IP past its looser limit is a 429 (got ${e?.statusCode ?? e})`);
    const other = run({ code: "d" }, req("10.0.0.3"));
    release();
    await third;
    const done = await Promise.all([...held, other]);
    ok(done.every((d) => d.stdout === "ok\n"), "the held runs and another caller's run complete");
    const again = await run({ code: "e" }, req("10.0.0.2"));
    ok(again.stdout === "ok\n", "the caller's slots are released when its runs finish");
    // The signed payer, when present, is the key (two IPs, one wallet).
    const pay = Buffer.from(JSON.stringify({ payload: { authorization: { from: "0x" + "ab".repeat(20) } } })).toString("base64");
    let release2; const gate2 = new Promise((r) => { release2 = r; });
    behavior = { create: async () => sandbox(async () => { await gate2; return { logs: { stdout: [], stderr: [] }, text: null, error: null }; }) };
    const held2 = [run({ code: "a" }, req("10.0.1.1", pay)), run({ code: "b" }, req("10.0.1.2", pay))];
    await new Promise((r) => setTimeout(r, 10));
    const third2 = run({ code: "c" }, req("10.0.1.3", pay)).catch((x) => x);
    e = await Promise.race([third2, new Promise((r) => setTimeout(() => r("still running"), 50))]);
    ok(e?.statusCode === 429, `the payer is the key when the request carries a signed payment (got ${e?.statusCode ?? e})`);
    release2(); await Promise.all([...held2, third2]);
    // A credits key is the caller's own identity: the tighter per-payer limit.
    let release3; const gate3 = new Promise((r) => { release3 = r; });
    behavior = { create: async () => sandbox(async () => { await gate3; return { logs: { stdout: [], stderr: [] }, text: null, error: null }; }) };
    const creditsReq = (ip) => ({ ...req(ip), creditsKeyId: "key-1" });
    const held3 = [run({ code: "a" }, creditsReq("10.0.2.1")), run({ code: "b" }, creditsReq("10.0.2.2"))];
    await new Promise((r) => setTimeout(r, 10));
    const third3 = run({ code: "c" }, creditsReq("10.0.2.3")).catch((x) => x);
    e = await Promise.race([third3, new Promise((r) => setTimeout(() => r("still running"), 50))]);
    ok(e?.statusCode === 429, `a credits key is the key across IPs (got ${e?.statusCode ?? e})`);
    release3(); await Promise.all([...held3, third3]);
    // A routed run (route-execute, decide, a skill pack) calls the handler with
    // no request inside runAsCallerOf: it counts against the dispatching
    // caller, and its refusal makes no charge claim (the answer it sits in is
    // charged). Addresses in one IPv6 /64 are one caller.
    const { runAsCallerOf } = await import("../src/dispatch-caller.js");
    let release4; const gate4 = new Promise((r) => { release4 = r; });
    behavior = { create: async () => sandbox(async () => { await gate4; return { logs: { stdout: ["ok\n"], stderr: [] }, text: null, error: null }; }) };
    const v6 = (n) => ({ ...req(`2001:db8:1:2::${n.toString(16)}`), headers: {} });
    const routed = (n) => runAsCallerOf(v6(n), () => run({ code: `r${n}` }));
    const held4 = Array.from({ length: __test.PER_IP_MAX_CONCURRENT }, (_, k) => routed(k + 1));
    await new Promise((r) => setTimeout(r, 10));
    const past = routed(99).catch((x) => x);
    e = await Promise.race([past, new Promise((r) => setTimeout(() => r("still running"), 50))]);
    ok(e?.statusCode === 429 && /too many concurrent runs/i.test(e.message) && !/charged/i.test(e.message), `a routed run past its caller's limit is a 429 with no charge claim, across one /64 (got ${e?.statusCode ?? e}: ${e?.message})`);
    const direct = run({ code: "z" }, { ...req("2001:db8:1:2::77"), headers: {} }).catch((x) => x);
    e = await Promise.race([direct, new Promise((r) => setTimeout(() => r("still running"), 50))]);
    ok(e?.statusCode === 429 && /not charged on x402/.test(e.message), `a direct call from the same /64 shares the routed runs' limit and keeps its charge sentence (got ${e?.statusCode ?? e})`);
    const elsewhere = routed(0).then(() => "ran", (x) => x);
    const otherNet = runAsCallerOf({ ...req("2001:db8:9:9::1"), headers: {} }, () => run({ code: "o" }));
    release4();
    await Promise.all([...held4, past, direct, otherNet]);
    ok((await elsewhere)?.statusCode === 429, "the same /64 is still one caller while its runs hold every place");
    // A request that carries no caller key (a CDN request with no proof of
    // its client's address and no signed key) still opens a scope, so the
    // request-less runs its steps make are counted and capped: under the
    // address the server derived, never one count shared by every such
    // request, and a paid call under its own payment.
    {
      const { currentDispatchCaller, currentDispatchCallerKeys, ANONYMOUS_CALLER, IN_PROCESS_CALLER } = await import("../src/dispatch-caller.js");
      const unproven = (ip, header) => ({ ...req(ip, header), headers: {}, cdnUnproven: true });
      const seen = await runAsCallerOf(unproven("203.0.113.90"), async () => [currentDispatchCaller(), currentDispatchCallerKeys()]);
      ok(seen[0] === "ip:203.0.113.90" && JSON.stringify(seen[1]) === JSON.stringify([ANONYMOUS_CALLER]), `a request with no caller key runs its steps capped under its derived address and admitted as anonymous (${JSON.stringify(seen)})`);
      const noAddr = await Promise.all([1, 2].map(() => runAsCallerOf({ headers: {}, header: () => undefined }, async () => currentDispatchCaller())));
      ok(noAddr.every((k) => typeof k === "string" && k.startsWith(`${ANONYMOUS_CALLER}:`)) && noAddr[0] !== noAddr[1], `two requests with nothing to key on are each their own cap key (${noAddr.join(", ")})`);
      ok((await runAsCallerOf(undefined, async () => currentDispatchCaller())) === IN_PROCESS_CALLER, "a dispatch with no request and no enclosing caller runs under the shared in-process key");
      ok((await runAsCallerOf(v6(1), () => runAsCallerOf(undefined, async () => currentDispatchCaller()))) === "ip:2001:db8:1:2::/64", "a nested dispatch with no request keeps the enclosing caller");
      let release5; const gate5 = new Promise((r) => { release5 = r; });
      behavior = { create: async () => sandbox(async () => { await gate5; return { logs: { stdout: ["ok\n"], stderr: [] }, text: null, error: null }; }) };
      const step = (ip, n, header) => runAsCallerOf(unproven(ip, header), () => run({ code: `u${n}` }));
      // One address holds every place its key allows.
      const held5 = Array.from({ length: __test.PER_IP_MAX_CONCURRENT }, (_, k) => step("203.0.113.91", k));
      await new Promise((r) => setTimeout(r, 10));
      const over = step("203.0.113.91", 9).catch((x) => x);
      e = await Promise.race([over, new Promise((r) => setTimeout(() => r("still running"), 50))]);
      ok(e?.statusCode === 429 && /too many concurrent runs/i.test(e.message), `request-less runs for one address with no caller key are capped (got ${e?.statusCode ?? e})`);
      // A second address, and a paid call from the full one, are not refused
      // because of the first address's runs.
      const other = step("203.0.113.92", 10).then(() => "ran", (x) => x);
      const paidSol = Buffer.from(JSON.stringify({ x402Version: 2, payload: { transaction: "solana-tx-bytes" } })).toString("base64");
      const paid = step("203.0.113.91", 11, paidSol).then(() => "ran", (x) => x);
      e = await Promise.race([Promise.all([other, paid]), new Promise((r) => setTimeout(() => r("still running"), 50))]);
      ok(e === "still running", `a second address and a paid call at the full address are running, not refused (got ${JSON.stringify(e?.map?.((x) => x?.statusCode ?? x) ?? e)})`);
      release5();
      await Promise.all([...held5, over]);
      ok((await other) === "ran" && (await paid) === "ran", `two different addresses keep independent counts, and a paid call is counted on its own payment (${await other}, ${await paid})`);
    }
  } finally {
    __test.setSandbox(undefined);
    if (realKey === undefined) delete process.env.E2B_API_KEY; else process.env.E2B_API_KEY = realKey;
  }
}

console.log(`\n${fail ? "FAILED" : "OK"}: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
