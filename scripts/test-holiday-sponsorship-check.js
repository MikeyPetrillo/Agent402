// scripts/holiday-sponsorship-check.js (offline: fetch is stubbed): the
// heartbeat's read of the holiday source's sponsorship.
//   node scripts/test-holiday-sponsorship-check.js
import { readSponsorship } from "./holiday-sponsorship-check.js";
import { readFileSync } from "node:fs";

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log(`ok - ${m}`); } else { fail++; console.error(`FAIL - ${m}`); } };
const answer = (body, status = 200) => async (url, init) => { answer.last = { url, init }; return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } }); };
const reasonOf = async (p) => { try { await p; return null; } catch (e) { return e.reason; } };

ok((await readSponsorship({ readToken: "t", sponsorable: "nager", fetchImpl: answer({ data: { viewer: { sponsorshipsAsSponsor: { nodes: [{ sponsorable: { login: "Nager" } }] } } } }) })).active === true, "the sponsoring account's own list: active");
ok(/activeOnly: true/.test(JSON.parse(answer.last.init.body).query) && answer.last.init.headers.authorization === "Bearer t", "it asks for active sponsorships only, with the read token");
ok((await readSponsorship({ readToken: "t", fetchImpl: answer({ data: { viewer: { sponsorshipsAsSponsor: { nodes: [{ sponsorable: { login: "someone" } }] } } } }) })).active === false, "a list without the source's organization: not active");
const pub = await readSponsorship({ ghToken: "g", sponsor: "owner", fetchImpl: answer({ data: { organization: { isSponsoredBy: true } } }) });
ok(pub.active === true && pub.via === "public" && JSON.parse(answer.last.init.body).variables.who === "owner", "without a read token: the public flag for the named sponsor");
ok((await readSponsorship({ ghToken: "g", sponsor: "owner", fetchImpl: answer({ data: { organization: { isSponsoredBy: false } } }) })).active === false, "the public flag false: not active");
ok(await reasonOf(readSponsorship({ fetchImpl: answer({}) })) === "token missing", "no token: unreadable, never a pass");
ok(await reasonOf(readSponsorship({ readToken: "t", fetchImpl: answer({ errors: [{ message: "INSUFFICIENT_SCOPES secret" }] }) })) === "GraphQL error", "a scope error: unreadable, its text not echoed");
ok(await reasonOf(readSponsorship({ readToken: "t", fetchImpl: answer({}, 401) })) === "HTTP 401", "a 401: unreadable");
ok(await reasonOf(readSponsorship({ ghToken: "g", sponsor: "bad login!", fetchImpl: answer({}) })) === "sponsor login invalid", "an invalid sponsor login is refused before any read");
const wf = readFileSync(new URL("../.github/workflows/heartbeat.yml", import.meta.url), "utf8");
ok(/node scripts\/holiday-sponsorship-check\.js/.test(wf) && /Scheduled check needs review: holiday-source-sponsorship"/.test(wf) && /SPONSORSHIP_READ_TOKEN: \$\{\{ secrets\.SPONSORSHIP_READ_TOKEN \}\}/.test(wf), "the heartbeat runs the check under its fixed issue title, with the optional read token");

console.log(`\ntest-holiday-sponsorship-check: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
