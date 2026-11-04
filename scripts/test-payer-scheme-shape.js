// Where does a payment payload carry its SCHEME? Ask the installed @x402/core,
// never a fixture and never memory.
//
// WHY THIS FILE EXISTS. paymentSchemeOf decides whether a request may be
// metered. It read the top-level `scheme` only, which is a v1 field: v2 puts it
// on `accepted`. Every v2 payment therefore read as "no scheme", the caller
// treated that as "not upto", and metering did nothing - with a green unit
// suite, because the fixture was written from the same wrong belief as the code.
// A live buy settled at the full ceiling twice before this was found, and it
// logged nothing either time, since a branch that is skipped says nothing.
//
// A fixture cannot catch that class: it can only ever encode what the author
// already thinks. So this reads @x402/core's OWN schema source and fails when
// the shape our reader depends on is not the shape the library defines - on a
// version bump, or the next time someone reasons from a neighbouring line.
import "./lib/offline-stores.js"; // per-process and file backends whatever the caller exports (see the file)
import { readFileSync, readdirSync } from "node:fs";
import { paymentSchemeOf } from "../src/payer.js";

let pass = 0, fail = 0;
const ok = (c, m) => { c ? pass++ : fail++; console.log(`${c ? "ok" : "FAIL"} - ${m}`); };

// --- 1. find the schema source in the INSTALLED package ----------------------
const dir = new URL("../node_modules/@x402/core/dist/esm/", import.meta.url);
const chunk = readdirSync(dir)
  .filter((f) => f.endsWith(".mjs"))
  .map((f) => ({ f, src: readFileSync(new URL(f, dir), "utf8") }))
  .find((c) => c.src.includes("PaymentPayloadV2Schema"));
ok(!!chunk, "found @x402/core's PaymentPayload schema source in node_modules");

const body = (name) => {
  const i = chunk.src.indexOf(`var ${name} = z.object({`);
  if (i < 0) return null;
  return chunk.src.slice(i, chunk.src.indexOf("});", i));
};

// --- 2. the shapes our reader depends on -------------------------------------
const v1 = body("PaymentPayloadV1Schema");
const v2 = body("PaymentPayloadV2Schema");
ok(!!v1 && !!v2, "both PaymentPayload schemas are present");

ok(/^\s*scheme:/m.test(v1), "v1 carries `scheme` TOP-LEVEL (paymentSchemeOf's fallback read)");
ok(!/^\s*scheme:/m.test(v2),
  "v2 has NO top-level `scheme` - the assumption that broke metering. If this fails, @x402/core moved it and paymentSchemeOf must be re-read against the new shape, not patched to match this test.");
ok(/^\s*accepted:\s*PaymentRequirementsV2Schema/m.test(v2),
  "v2 carries `accepted: PaymentRequirementsV2Schema` - where paymentSchemeOf reads the scheme");
ok(/^\s*scheme:/m.test(body("PaymentRequirementsV2Schema") || ""),
  "PaymentRequirementsV2 itself carries `scheme`, so `accepted.scheme` is a real path");

// --- 3. the reader agrees with the shapes just proven ------------------------
const hdr = (o) => ({ header: () => Buffer.from(JSON.stringify(o)).toString("base64") });
ok(paymentSchemeOf(hdr({ x402Version: 1, scheme: "upto", network: "base", payload: {} })) === "upto",
  "reader resolves a v1 payload's top-level scheme");
ok(paymentSchemeOf(hdr({ x402Version: 2, accepted: { scheme: "upto", network: "eip155:8453" }, payload: {} })) === "upto",
  "reader resolves a v2 payload's accepted.scheme");
ok(paymentSchemeOf(hdr({ x402Version: 2, accepted: { network: "eip155:8453" }, payload: {} })) === null,
  "a v2 payload with no scheme resolves to null, never a default");

console.log(`\n${fail ? "FAILED" : "OK"}: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
