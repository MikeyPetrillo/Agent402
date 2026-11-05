// Offline contract test for the whois tool's IANA RDAP bootstrap parser.
// No network: feeds dns.json-shaped fixtures to parseRdapBootstrap and pins
// the TLD → authoritative-base mapping the handler walks before rdap.org.
import "./lib/offline-stores.js"; // per-process and file backends whatever the caller exports (see the file)
import { parseRdapBootstrap } from "../src/tools/kit.js";

let failed = 0;
const ok = (cond, msg) => {
  if (cond) console.log(`  ✓ ${msg}`);
  else {
    failed++;
    console.error(`  ✗ ${msg}`);
  }
};

// ---- 1. the real dns.json shape: services = [ [[tlds], [urls]], ... ] ----
{
  const map = parseRdapBootstrap({
    description: "RDAP bootstrap file for Domain Name System registrations",
    version: "1.0",
    services: [
      [["com", "net"], ["https://rdap.verisign.com/com/v1/"]],
      [["org"], ["https://rdap.publicinterestregistry.org/rdap/"]],
      [["dev", "app"], ["https://www.registry.google/rdap/"]],
    ],
  });
  ok(map.get("com") === "https://rdap.verisign.com/com/v1/", "com maps to Verisign");
  ok(map.get("net") === "https://rdap.verisign.com/com/v1/", "multi-TLD service maps every TLD");
  ok(map.get("org") === "https://rdap.publicinterestregistry.org/rdap/", "org maps to PIR");
  ok(map.get("xyz") === undefined, "unlisted TLD is absent (handler falls back to rdap.org)");
}

// ---- 2. https is required; a missing trailing slash is normalised ----
{
  const map = parseRdapBootstrap({
    services: [
      [["insecure"], ["http://rdap.example.net/"]],
      [["mixed"], ["http://rdap.example.net/", "https://rdap.example.net/rdap"]],
      [["noslash"], ["https://rdap.example.org/v1"]],
    ],
  });
  ok(map.get("insecure") === undefined, "http-only service is skipped");
  ok(map.get("mixed") === "https://rdap.example.net/rdap/", "https URL wins over http in the same service");
  ok(map.get("noslash") === "https://rdap.example.org/v1/", "base URL gains a trailing slash");
}

// ---- 3. TLD keys are case-normalised ----
{
  const map = parseRdapBootstrap({ services: [[["COM"], ["https://rdap.verisign.com/com/v1/"]]] });
  ok(map.get("com") === "https://rdap.verisign.com/com/v1/", "TLD keys are lowercased");
}

// ---- 4. degenerate inputs return an empty map, never throw ----
{
  ok(parseRdapBootstrap(null).size === 0, "null input → empty map");
  ok(parseRdapBootstrap({}).size === 0, "missing services → empty map");
  ok(parseRdapBootstrap({ services: "nope" }).size === 0, "non-array services → empty map");
  ok(parseRdapBootstrap({ services: [null, "x", [["com"]], [[null], ["https://a/"]]] }).size === 0, "malformed service rows are skipped");
}

if (failed) {
  console.error(`test-whois-bootstrap: ${failed} FAILED`);
  process.exit(1);
}
console.log("test-whois-bootstrap: all assertions passed");
