// Quick-tunnel hostnames in the self-serve submission door. A tunnel service
// hands out a random hostname per session, so a dead tunnel never comes back:
// its slot is released after days (settled or not), and tunnels may hold only
// a share of the slots, so live ones cannot fill the door for stable sellers.
import {
  isEphemeralTunnelOrigin, tunnelSubmissionCap, selectReleasableOrigins,
  registerOrigin, __testResetSubmitted, __testSetSubmittedCap,
} from "../src/x402-index.js";

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log("ok -", m); } else { fail++; console.error("FAIL -", m); } };

// --- which hosts count ---
for (const o of ["https://0a1b2c.lhr.life", "https://x-y.trycloudflare.com", "https://fast-earwig-92.loca.lt", "https://abc.ngrok-free.app", "https://q.tunnelmole.net"]) {
  ok(isEphemeralTunnelOrigin(o), `${o} is a quick tunnel`);
}
for (const o of ["https://lhr.life.example.com", "https://evil-lhr.life", "https://api.example.com", "https://seller.workers.dev", "https://x.vercel.app", "not a url"]) {
  ok(!isEphemeralTunnelOrigin(o), `${o} is not a quick tunnel`);
}
ok(tunnelSubmissionCap(2000) === 500, "a quarter of 2,000 slots may be tunnels");

// --- release ---
const DAY = 86_400_000, NOW = 1_800_000_000_000;
const row = (origin, f = {}) => ({ origin, first_seen: NOW - 60 * DAY, last_routable_seen: null, last_settled_seen: null, ...f });
const rel = (rows, hasSettled = () => false) => selectReleasableOrigins({ now: NOW, isSubmitted: () => true, hasSettled, registrations: rows, cycleOkFraction: 1 });

ok(rel([row("https://t1.lhr.life", { last_routable_seen: NOW - 4 * DAY })]).includes("https://t1.lhr.life"), "a tunnel silent 4 days is released");
ok(rel([row("https://t2.lhr.life", { last_routable_seen: NOW - 1 * DAY })]).length === 0, "a tunnel seen yesterday keeps its slot");
ok(rel([row("https://t3.lhr.life", { last_routable_seen: NOW - 4 * DAY, last_settled_seen: NOW - 5 * DAY })], () => true).includes("https://t3.lhr.life"), "a settled tunnel silent 4 days is released: the hostname cannot return");
ok(rel([row("https://stable.example", { last_routable_seen: NOW - 4 * DAY })]).length === 0, "a stable hostname silent 4 days keeps its slot (30-day rule)");
ok(rel([row("https://paid.example", { last_routable_seen: NOW - 90 * DAY })], () => true).length === 0, "a settled stable seller is never released");
ok(selectReleasableOrigins({ now: NOW, isSubmitted: () => true, registrations: [row("https://t4.lhr.life", { last_routable_seen: NOW - 9 * DAY })], cycleOkFraction: 0.1 }).length === 0, "the outage guard still holds for tunnels");

// --- the register door ---
__testResetSubmitted();
__testSetSubmittedCap(8); // tunnel share: 2
const crawl = async () => ({ manifest: { name: "S" }, tools: [{ slug: "t", route: "/v1/x" }], error: null, history: [true] });
const a = await registerOrigin("https://aa.lhr.life", { crawl });
const b = await registerOrigin("https://bb.trycloudflare.com", { crawl });
ok(a.listed && b.listed, "tunnels are accepted up to their share");
const c = await registerOrigin("https://cc.loca.lt", { crawl });
ok(c.listed === false && /tunnel submissions are full/.test(c.error || ""), "a tunnel past its share is refused with the tunnel reason");
const again = await registerOrigin("https://aa.lhr.life", { crawl });
ok(again.listed === true, "a tunnel already holding a slot can re-register");
const d = await registerOrigin("https://stable-seller.example", { crawl });
ok(d.listed === true, "a stable hostname is still accepted while the tunnel share is full");
__testSetSubmittedCap();
__testResetSubmitted();

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
