// agent402-client: the buyer's delivery contract (outputValidator), the
// result cache's option values, and route(). Everything is offline: each
// fetch is an in-process stub and no socket is opened.
import { Agent402, OutputValidationError, SpendingLimitError, ResponseTooLargeError } from "../client/index.js";

const outcomes = [];
const expect = (label, pass) => outcomes.push({ label, pass: Boolean(pass) });
const settle = async (fn) => { try { return { value: await fn() }; } catch (error) { return { error }; } };
// A fresh parsed object per read, as a real fetch gives; text() lets the
// client measure the body against maxResponseBytes.
const reply = (body, status = 200) => {
  const text = JSON.stringify(body);
  return { ok: status >= 200 && status < 300, status, json: async () => JSON.parse(text), text: async () => text };
};

const ITEM = "thing";
// A wallet client for one $0.01 tool; `paidBody` is what each paid request
// answers, and `spent` counts the paid requests.
function walletClient({ paidBody = { n: 1 }, payFetch, ...opts } = {}) {
  const meter = { spent: 0 };
  const client = new Agent402({
    baseUrl: "https://seller.example",
    fetch: payFetch || (async () => { meter.spent++; return reply(paidBody); }),
    fetchImpl: async () => reply(paidBody),
    ...opts,
  });
  client._catalog = new Map([[ITEM, { method: "POST", path: "/thing", computePayable: false, price: "$0.01" }]]);
  return { client, meter };
}

// ---- validators that are not { id, validate } are refused before any work ----
const malformed = {
  "a string": "v1",
  "an array": [{ id: "a", validate: () => true }],
  "an id padded with spaces": { id: " v1 ", validate: () => true },
  "an empty id": { id: "", validate: () => true },
  "a 257-character id": { id: "x".repeat(257), validate: () => true },
  "a numeric id": { id: 5, validate: () => true },
  "a validate that is not a function": { id: "v1", validate: true },
};
{
  let requests = 0;
  const caller = new Agent402({ fetchImpl: async () => { requests++; return reply({ endpoints: [] }); } });
  for (const [what, validator] of Object.entries(malformed)) {
    const built = await settle(async () => new Agent402({ fetchImpl: async () => reply({}), outputValidator: validator }));
    expect(`new Agent402 throws a TypeError naming outputValidator for ${what}`,
      built.error instanceof TypeError && built.error.message.startsWith("constructor") && built.error.message.includes("outputValidator"));
    const called = await settle(() => caller.call(ITEM, {}, { outputValidator: validator }));
    expect(`call() throws a TypeError starting with "call" for ${what}`,
      called.error instanceof TypeError && called.error.message.startsWith("call"));
  }
  expect("no refused call reached the network", requests === 0);
  for (const [what, validator] of [["a 256-character id", { id: "y".repeat(256), validate: () => true }], ["null", null], ["undefined", undefined]]) {
    const built = await settle(async () => new Agent402({ fetchImpl: async () => reply({}), outputValidator: validator }));
    expect(`the constructor accepts ${what}`, built.value instanceof Agent402);
  }
}

// ---- the exact error text a buyer reads ----
{
  const free = new Agent402({ baseUrl: "https://free.example", fetchImpl: async () => reply({ n: 2 }) });
  free._catalog = new Map([["free", { method: "POST", path: "/free", computePayable: true, price: "$0" }]]);
  const unpaid = await settle(() => free.call("free", {}, { outputValidator: { id: "free/v1", validate: () => false } }));
  const e = unpaid.error;
  expect("an unpaid rejection is an OutputValidationError", e instanceof OutputValidationError && e.name === "OutputValidationError");
  expect("an unpaid rejection reads exactly 'output for \"free\" failed buyer validator \"free/v1\"'",
    e?.message === 'output for "free" failed buyer validator "free/v1"');
  expect("an unpaid rejection carries slug, contractId, paid false, cacheHit false",
    e?.slug === "free" && e?.contractId === "free/v1" && e?.paid === false && e?.cacheHit === false);
  expect("a false verdict is explained by an Error in cause", e?.cause instanceof Error && e.cause.message.includes("free/v1"));
  const passed = await settle(() => free.call("free", {}, { outputValidator: { id: "free/v2", validate: (b) => b.n === 2 } }));
  expect("a passing validator hands back the parsed body", passed.value?.n === 2);

  const { client } = walletClient({ outputValidator: { id: "paid/v1", validate: () => { throw new Error("bad shape"); } } });
  const paid = await settle(() => client.call(ITEM));
  expect("a paid rejection reads exactly '...failed buyer validator \"paid/v1\"; this call WAS paid'",
    paid.error?.message === 'output for "thing" failed buyer validator "paid/v1"; this call WAS paid');
  expect("the validator's own error is the cause", paid.error?.cause?.message === "bad shape" && paid.error?.paid === true);
}

// ---- a validator that never settles is cut off at its timeoutMs ----
{
  const { client } = walletClient({ outputValidator: { id: "never/v1", validate: () => new Promise(() => {}), timeoutMs: 150 } });
  const began = Date.now();
  const r = await settle(() => client.call(ITEM));
  expect("a hung validator rejects the paid delivery", r.error instanceof OutputValidationError && r.error.paid === true);
  expect("the timeout is an Error in cause", r.error?.cause instanceof Error);
  expect("timeoutMs bounds the wait", Date.now() - began < 3000);
}

// ---- contracts and the cache ----
{
  const { client } = walletClient({ outputValidator: { id: "strict/v1", validate: () => false } });
  const r = await settle(() => client.call(ITEM, {}, { outputValidator: { id: "loose/v1", validate: () => true } }));
  expect("a per-call validator replaces the constructor's", r.value?.n === 1);

  const plain = walletClient().client;
  await plain.call(ITEM, { q: 1 });
  await plain.call(ITEM, { q: 1 }, { outputValidator: { id: "c/v1", validate: () => true } });
  expect("contracted and uncontracted results are cached apart", plain._cache.size === 2);
}

// ---- cache: null is a fresh purchase, exactly like cache: false ----
for (const option of [null, false]) {
  const { client, meter } = walletClient();
  const first = await client.call(ITEM, { q: 2 });
  expect(`(${option}) the default call stores its answer`, client._cache.size === 1 && meter.spent === 1);
  const again = await client.call(ITEM, { q: 2 }, { cache: option });
  expect(`cache: ${option} does not return the cached object`, again !== first && meter.spent === 2);
  const third = await client.call(ITEM, { q: 3 }, { cache: option });
  expect(`cache: ${option} stores nothing`, third?.n === 1 && client._cache.size === 1 && meter.spent === 3);
}
{
  const { client, meter } = walletClient();
  const first = await client.call(ITEM, { q: 4 });
  const leftOut = await client.call(ITEM, { q: 4 }, { cache: undefined });
  expect("cache left undefined serves the cached answer without paying", leftOut === first && meter.spent === 1);
}

// ---- a paid answer refused on delivery is never reported as a spending refusal ----
// The payment fetch records a signing refusal (as the signing guard does for
// an option it declined) and then answers 200: the error the buyer gets is
// the delivery's own.
{
  const refusing = (client, body) => async () => {
    const store = client._signCtx.getStore();
    if (store) store.refusal = { reason: "signed-amount", detail: "an earlier option was refused", priceUsd: 0.01, limit: "maxPerCallUsd", allowanceUsd: 0 };
    return reply(body);
  };
  const cases = [
    ["a failed buyer validator", { n: 1 }, { outputValidator: { id: "shape/v1", validate: () => false } }, OutputValidationError],
    ["an oversized body", { blob: "z".repeat(4096) }, { maxResponseBytes: 64 }, ResponseTooLargeError],
  ];
  for (const [what, body, opts, Expected] of cases) {
    let client;
    ({ client } = walletClient({ payFetch: (...a) => refusing(client, body)(...a), ...opts }));
    const r = await settle(() => client.call(ITEM));
    expect(`${what} on a paid answer throws ${Expected.name}, not SpendingLimitError`,
      r.error instanceof Expected && !(r.error instanceof SpendingLimitError) && r.error.paid === true);
  }
}

// ---- route(): k bounds, defaults, failure ----
{
  const asked = [];
  const router = new Agent402({
    baseUrl: "https://router.example",
    fetchImpl: async (url) => { asked.push(new URL(String(url))); return reply({ query: "", include: "all", count: 0, sellers: 0, results: [] }); },
  });
  const kCases = [[0, "5"], ["abc", "5"], [-4, "1"], [99, "25"], ["7", "7"]];
  for (const [k, sent] of kCases) {
    await router.route("x", { k });
    expect(`route() sends k=${sent} for k=${JSON.stringify(k)}`, asked.at(-1).searchParams.get("k") === sent);
  }
  await router.route(undefined);
  const q = asked.at(-1).searchParams;
  expect("route() with no task sends q='', include=all and no network", q.get("q") === "" && q.get("include") === "all" && !q.has("network"));
  expect("route() reads /api/route and nothing else", asked.every((u) => u.pathname === "/api/route"));
  const broken = new Agent402({ baseUrl: "https://router.example", fetchImpl: async () => reply({ error: "no" }, 500) });
  const r = await settle(() => broken.route("x"));
  expect("a failed route() read says 'route failed: HTTP 500' and carries the status",
    r.error?.status === 500 && r.error.message.startsWith("route failed: HTTP 500"));
}

const failed = outcomes.filter((o) => !o.pass);
for (const o of outcomes) console.log(`${o.pass ? "ok" : "FAIL"} - ${o.label}`);
console.log(`\n${outcomes.length - failed.length}/${outcomes.length} checks passed`);
process.exit(failed.length ? 1 : 0);
