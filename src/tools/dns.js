import { Resolver } from "node:dns/promises";

const SUPPORTED = ["A", "AAAA", "MX", "TXT", "NS", "CNAME"];
const resolver = new Resolver({ timeout: 5000, tries: 2 });

export async function dnsLookup(name, type = "A") {
  const recordType = String(type).toUpperCase();
  if (!SUPPORTED.includes(recordType)) {
    const err = new Error(`Unsupported record type. Use one of: ${SUPPORTED.join(", ")}`);
    err.statusCode = 400;
    throw err;
  }
  if (!/^[a-zA-Z0-9._-]{1,253}$/.test(name)) {
    const err = new Error("Invalid domain name");
    err.statusCode = 400;
    throw err;
  }
  try {
    const records = await resolver.resolve(name, recordType);
    return { name, type: recordType, records };
  } catch (e) {
    if (e.code === "ENODATA" || e.code === "ENOTFOUND") {
      return { name, type: recordType, records: [] };
    }
    const err = new Error(`DNS resolution failed: ${e.code || e.message}`);
    err.statusCode = 502;
    throw err;
  }
}
