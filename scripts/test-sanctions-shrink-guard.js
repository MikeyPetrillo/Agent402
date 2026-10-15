// The sanctions tools keep the list they hold when a new download parses to
// under half its size (a truncated export), the same rule the payment-party
// screen applies; a list of normal size replaces it. Offline: two synthetic
// SDN XML documents fed through the shared loader with an injected fetch.
//   node scripts/test-sanctions-shrink-guard.js
let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log(`ok - ${m}`); } else { fail++; console.error(`FAIL - ${m}`); } };
const addr = (i) => "0x" + (i + 1).toString(16).padStart(40, "a");
const entry = (i, n) => `<sdnEntry><uid>${i + 1}</uid><lastName>ENTITY ${i}</lastName><sdnType>Entity</sdnType><idList>${Array.from({ length: n }, (_, k) => `<id><uid>${i * 100 + k}</uid><idType>Digital Currency Address - ETH</idType><idNumber>${addr(i * 100 + k)}</idNumber></id>`).join("")}</idList></sdnEntry>`;
const doc = (entries, perEntry) => `<?xml version="1.0"?><sdnList><publshInformation><Publish_Date>10/15/2026</Publish_Date><Record_Count>${entries}</Record_Count></publshInformation>${Array.from({ length: entries }, (_, i) => entry(i, perEntry)).join("")}</sdnList>`;
let body = doc(20, 5); // 100 addresses
const fetchImpl = async () => new Response(body, { status: 200, headers: { "content-type": "application/xml" } });
process.env.SANCTIONS_LIST_URL = "https://fixture.invalid/SDN.XML";
process.env.SANCTIONS_PAYOUT_FILE = (await import("node:path")).join((await import("node:fs")).mkdtempSync((await import("node:path")).join((await import("node:os")).tmpdir(), "sanctions-shrink-")), "payout.json");
const sdn = await import("../src/ofac-sdn.js");
const kit = await import("../src/tools/sanctions-kit.js");
const st = await kit.loadSanctions({ fetchImpl, force: true });
ok(st.addresses?.size === 100, `the first list is adopted (${st.addresses?.size} addresses)`);
body = doc(8, 5); // 40 addresses: under half of 100
sdn.__resetSdnListForTests();
await sdn.loadSdnList({ fetchImpl, now: () => Date.now() + 1000 }).catch(() => {});
const after = kit.sanctionsStatus();
const held = (await kit.loadSanctions({ fetchImpl: async () => { throw new Error("no fetch expected"); } })).addresses?.size;
ok(held === 100, `a list under half the held size is refused and the held list stays (${held} addresses held)`);
ok(/drop past half/.test(String(after.lastError || "")), `the refusal is recorded on the status (${String(after.lastError || "").slice(0, 80)})`);
body = doc(19, 5); // 95 addresses: a normal small delisting
sdn.__resetSdnListForTests();
await sdn.loadSdnList({ fetchImpl, now: () => Date.now() + 2000 }).catch(() => {});
const held2 = (await kit.loadSanctions({ fetchImpl: async () => { throw new Error("no fetch expected"); } })).addresses?.size;
ok(held2 === 95, `a list of normal size replaces the held one (${held2} addresses held)`);
console.log(`test-sanctions-shrink-guard: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
