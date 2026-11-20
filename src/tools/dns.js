import { Resolver } from "node:dns/promises";
import { internalNameReason } from "./dns-name-filter.js";
import { atCeiling, assertBeforeCeiling, ceilingPassed, ceilingCutError } from "../run-ceiling.js";

const SUPPORTED = ["A", "AAAA", "MX", "TXT", "NS", "CNAME"];
const RESOLVER_OPTS = { timeout: 5000, tries: 2 };

export async function dnsLookup(name, type = "A") {
  const recordType = String(type).toUpperCase();
  if (!SUPPORTED.includes(recordType)) {
    const err = new Error(`Unsupported record type. Use one of: ${SUPPORTED.join(", ")}`);
    err.statusCode = 400;
    throw err;
  }
  // The shared internal-name filter (trailing dot stripped first).
  const refused = internalNameReason(name);
  if (refused) {
    const err = new Error(refused);
    err.statusCode = 400;
    throw err;
  }
  name = String(name).trim().replace(/\.$/, "");
  if (!/^[a-zA-Z0-9._-]{1,253}$/.test(name)) {
    const err = new Error("Invalid domain name");
    err.statusCode = 400;
    throw err;
  }
  // A resolver of its own per lookup, so a run's ceiling (src/run-ceiling.js;
  // none on a direct route) can cancel this query and nothing else's: the
  // lookup is the tool's only upstream wait, and it ends at the ceiling.
  const resolver = new Resolver(RESOLVER_OPTS);
  const off = atCeiling(() => resolver.cancel());
  try {
    assertBeforeCeiling();
    const records = await resolver.resolve(name, recordType);
    return { name, type: recordType, records };
  } catch (e) {
    // A lookup the ceiling ended is a run that did not finish, never "no records".
    if (e?.ceilingCut || ceilingPassed()) throw ceilingCutError();
    if (e.code === "ENODATA" || e.code === "ENOTFOUND") {
      return { name, type: recordType, records: [] };
    }
    const err = new Error(`DNS resolution failed: ${e.code || e.message}`);
    err.statusCode = 502;
    throw err;
  } finally { off(); }
}
