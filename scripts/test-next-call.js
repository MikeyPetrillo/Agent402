// The flagship first calls carry an additive, informational `next`
// (src/next-call.js): web.search -> web.answer, decide.plan -> decide.execute.
// Offline. A client that ignores unknown fields must keep working, so the
// wrapper only ever ADDS one key and keeps everything else byte-for-byte.
import { withNextCall, nextCallFor } from "../src/next-call.js";
import { readFileSync } from "node:fs";

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log(`ok - ${m}`); } else { fail++; console.error(`FAIL - ${m}`); } };

const answerDef = { slug: "answer", route: "GET /api/answer", price: "$0.08" };
const execDef = { slug: "decide-execute", route: "POST /api/decide/execute", price: "$0.001", quote: () => 0.001 };
const next = nextCallFor(answerDef);
ok(JSON.stringify(next) === JSON.stringify({ slug: "answer", route: "GET /api/answer", price: "$0.08" }), "next names slug, route and the catalog price");
ok(nextCallFor(execDef).priced && nextCallFor(execDef).price === "$0.001", "a quoted next says its listed price is the floor");

const base = { query: "q", results: [{ title: "t" }], count: 1 };
const h = withNextCall(async () => ({ ...base }), next);
const out = await h({});
ok(JSON.stringify({ ...out, next: undefined }) === JSON.stringify({ ...base, next: undefined }) && out.next?.slug === "answer", "every existing field is unchanged and next is added");

const meter = {}; Object.defineProperty(meter, "__meterUpstreamUsd", { value: 0.01, enumerable: false });
Object.assign(meter, base);
const m = await withNextCall(async () => meter, next)({});
ok(m.__meterUpstreamUsd === 0.01 && !Object.keys(m).includes("__meterUpstreamUsd"), "a non-enumerable sentinel survives, still hidden");

ok((await withNextCall(async () => ({ __sse: true }), next)({})).next === undefined, "a streamed answer gets no next");
ok((await withNextCall(async () => ({ __binary: true }), next)({})).next === undefined, "a binary answer gets no next");
ok((await withNextCall(async () => ({ next: "mine" }), next)({})).next === "mine", "a handler's own next is never replaced");
ok(Array.isArray(await withNextCall(async () => [1], next)({})), "a non-object answer passes through");
ok(withNextCall(h, next) === h, "wrapping twice is a no-op");

const server = readFileSync(new URL("../src/server.js", import.meta.url), "utf8");
ok(/const NEXT_CALL = \{ search: "answer", decide: "decide-execute" \}/.test(server), "server.js wires search -> answer and decide -> decide-execute");

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
