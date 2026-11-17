// Behavior checks for agent402-client's buyer-owned output contract and its
// route() discovery call, written from the published behavior (README, specs).
// Offline: every network answer is a local stub; nothing listens on a port.
import { Agent402, OutputValidationError } from "../client/index.js";

let failures = 0;
const check = (cond, label) => {
  if (cond) console.log(`ok - ${label}`);
  else { failures++; console.log(`FAIL - ${label}`); }
};
const reject = async (fn) => { try { await fn(); return null; } catch (e) { return e; } };
const answer = (body, status = 200) => ({ ok: status >= 200 && status < 300, status, json: async () => body });

// A client whose wallet fetch and plain fetch both answer one fixed body.
const sellerClient = (opts = {}) => {
  const c = new Agent402({
    baseUrl: "https://seller.example",
    fetch: async () => answer({ n: 1 }),
    fetchImpl: async () => answer({ n: 1 }),
    ...opts,
  });
  c._catalog = new Map([["thing", { method: "POST", path: "/thing", computePayable: false, price: "$0.01" }]]);
  return c;
};

// 1. Malformed validators are refused with a TypeError, at construction and per call.
{
  const bad = [
    ["a string", "v1"],
    ["an array", [{ id: "a", validate: () => true }]],
    ["an id with surrounding spaces", { id: " v1 ", validate: () => true }],
    ["an empty id", { id: "", validate: () => true }],
    ["an id over 256 characters", { id: "x".repeat(257), validate: () => true }],
    ["a non-string id", { id: 5, validate: () => true }],
    ["a validate that is not a function", { id: "v1", validate: true }],
  ];
  for (const [what, v] of bad) {
    const e = await reject(async () => new Agent402({ fetchImpl: async () => answer({}), outputValidator: v }));
    check(e instanceof TypeError && /outputValidator/.test(e.message), `constructor refuses ${what}`);
  }
  let touched = 0;
  const c = new Agent402({ fetchImpl: async () => { touched++; return answer({ endpoints: [] }); } });
  for (const [what, v] of bad) {
    const e = await reject(() => c.call("thing", {}, { outputValidator: v }));
    check(e instanceof TypeError, `call() refuses ${what}`);
  }
  check(touched === 0, "a refused per-call validator made no network request");
  const okId = new Agent402({ fetchImpl: async () => answer({}), outputValidator: { id: "y".repeat(256), validate: () => true } });
  check(okId instanceof Agent402, "an id of exactly 256 characters is accepted");
  const none = new Agent402({ fetchImpl: async () => answer({}), outputValidator: null });
  check(none instanceof Agent402, "a null validator means no contract");
}

// 2. An unpaid (proof-of-work or free) delivery that fails the contract says it was not paid.
{
  const c = new Agent402({ baseUrl: "https://free.example", fetchImpl: async () => answer({ n: 2 }) });
  c._catalog = new Map([["free", { method: "POST", path: "/free", computePayable: true, price: "$0" }]]);
  const e = await reject(() => c.call("free", {}, { outputValidator: { id: "free/v1", validate: () => false } }));
  check(e instanceof OutputValidationError && e.paid === false && e.cacheHit === false, "a rejected free delivery is labelled unpaid and not a cache hit");
  check(e && e.name === "OutputValidationError" && e.contractId === "free/v1" && e.slug === "free", "the error names the slug and the contract id");
  check(e && !/WAS paid/.test(e.message), "an unpaid rejection does not claim a payment");
  const ok = await c.call("free", {}, { outputValidator: { id: "free/v2", validate: (b) => b.n === 2 } });
  check(ok && ok.n === 2, "a passing validator returns the parsed body");
}

// 3. A paid rejection says so in its message; a validator that never settles is bounded by its timeoutMs.
{
  const c = sellerClient({ outputValidator: { id: "never/v1", validate: () => new Promise(() => {}), timeoutMs: 150 } });
  const t0 = Date.now();
  const e = await reject(() => c.call("thing"));
  check(e instanceof OutputValidationError && e.paid === true && /WAS paid/.test(e.message), "a paid rejection is marked paid in fields and message");
  check(Date.now() - t0 < 3000, "a constructor validator's timeoutMs bounds the wait");
}

// 4. A per-call validator replaces the constructor one; the same request under two ids is two cache entries.
{
  const c = sellerClient({ outputValidator: { id: "strict/v1", validate: () => false } });
  const out = await c.call("thing", {}, { outputValidator: { id: "loose/v1", validate: () => true } });
  check(out && out.n === 1, "a per-call validator overrides the constructor validator");
  const plain = sellerClient();
  await plain.call("thing", { q: 1 });
  await plain.call("thing", { q: 1 }, { outputValidator: { id: "c/v1", validate: () => true } });
  check(plain._cache.size === 2, "an uncontracted and a contracted result do not share a cache entry");
}

// 5. route(): bounds on k, query defaults, and its failure.
{
  const seen = [];
  const r = new Agent402({
    baseUrl: "https://router.example",
    fetchImpl: async (url) => { seen.push(new URL(String(url))); return answer({ query: "", include: "all", count: 0, sellers: 0, results: [] }); },
  });
  await r.route("x", { k: 0 });
  check(seen.at(-1).searchParams.get("k") === "5", "k of 0 falls back to 5");
  await r.route("x", { k: "abc" });
  check(seen.at(-1).searchParams.get("k") === "5", "a non-numeric k falls back to 5");
  await r.route("x", { k: -4 });
  check(seen.at(-1).searchParams.get("k") === "1", "a negative k is raised to 1");
  await r.route("x", { k: "7" });
  check(seen.at(-1).searchParams.get("k") === "7", "a numeric string k is read as a number");
  await r.route(undefined);
  const last = seen.at(-1);
  check(last.searchParams.get("q") === "" && last.searchParams.get("include") === "all" && !last.searchParams.has("network"), "no task sends an empty q, include=all and no network");
  check(seen.every((u) => u.pathname === "/api/route"), "every route() read goes to /api/route only");
  const down = new Agent402({ baseUrl: "https://router.example", fetchImpl: async () => answer({ error: "no" }, 500) });
  const e = await reject(() => down.route("x"));
  check(e && e.status === 500 && /^route failed: HTTP 500/.test(e.message), "a non-2xx route() read throws naming route and the status");
}

console.log(failures ? `\n${failures} failed` : "\nall passed");
process.exit(failures ? 1 : 0);
