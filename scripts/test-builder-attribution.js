// Unit tests for the builder-attribution checker's pure helpers. The parser
// must agree byte-for-byte with @x402/extensions' encoder — that package is
// what the facilitator uses to append the ERC-8021 suffix, so a drift here
// would misreport live attribution. Offline; no network.
import { encodeBuilderCodeSuffix, parseBuilderCodeSuffixFromCalldata } from "@x402/extensions/builder-code";
import { parseBuilderSuffix, declaredBuilderCode } from "./check-builder-attribution.js";

let pass = 0, fail = 0;
const ok = (cond, msg) => { if (cond) { pass++; console.log(`ok - ${msg}`); } else { fail++; console.error(`FAIL - ${msg}`); } };
const eq = (a, b, msg) => ok(JSON.stringify(a) === JSON.stringify(b), `${msg} (got ${JSON.stringify(a)})`);

// Fake transferWithAuthorization-ish calldata to append suffixes to.
const CALLDATA = "0xe3ee160e" + "ab".repeat(96);

// Round-trip against the real encoder: app code only, all fields, service list.
for (const data of [
  { a: "agent402" },
  { a: "agent402", w: "cdp" },
  { a: "agent402", w: "cdp", s: ["mcp_client", "router"] },
  { s: ["solo_service"] },
]) {
  const tx = CALLDATA + encodeBuilderCodeSuffix(data).slice(2);
  eq(parseBuilderSuffix(tx), parseBuilderCodeSuffixFromCalldata(tx), `parser agrees with SDK for ${JSON.stringify(data)}`);
  eq(parseBuilderSuffix(tx), data, `round-trip decodes ${JSON.stringify(data)}`);
}

// Suffix must terminate the calldata — mid-calldata marker bytes don't count.
const midMarker = CALLDATA + encodeBuilderCodeSuffix({ a: "agent402" }).slice(2) + "deadbeef";
ok(parseBuilderSuffix(midMarker) === undefined, "suffix not at calldata end → undefined");
ok(parseBuilderSuffix(CALLDATA) === undefined, "plain calldata (no marker) → undefined");
ok(parseBuilderSuffix("0x") === undefined, "empty calldata → undefined");

// Wrong schema id byte must be rejected.
const good = encodeBuilderCodeSuffix({ a: "agent402" }).slice(2);
const badSchema = CALLDATA + good.slice(0, -34) + "01" + good.slice(-32);
ok(parseBuilderSuffix(badSchema) === undefined, "schema id != 2 → undefined");

// declaredBuilderCode: top-level extensions, per-accepts fallback, absent.
eq(
  declaredBuilderCode({ extensions: { "builder-code": { info: { a: "agent402" } } } }),
  { where: "top-level", info: { a: "agent402" } },
  "top-level extension found"
);
eq(
  declaredBuilderCode({ accepts: [{}, { extensions: { "builder-code": { info: { a: "agent402" } } } }] }),
  { where: "accepts[]", info: { a: "agent402" } },
  "per-accepts extension found"
);
ok(declaredBuilderCode({ accepts: [{}] }) === false, "absent extension → false");
ok(declaredBuilderCode(undefined) === false, "undefined payload → false");

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
