// A2A Agent Card validator — offline unit tests. No network.
//   node scripts/test-a2a-card.js
import { validateAgentCard, SAMPLE_AGENT_CARD, A2A_WELL_KNOWN_PATHS, buildOurAgentCard, buildAgentRegistration, ERC8004_IDENTITY_REGISTRY } from "../src/tools/a2a-card.js";

let passed = 0, failed = 0;
const ok = (cond, msg) => {
  if (cond) { passed++; console.log(`ok - ${msg}`); }
  else { failed++; console.error(`FAIL - ${msg}`); }
};

// the shipped sample must be VALID — it is both tools' discovery example
const sample = validateAgentCard(SAMPLE_AGENT_CARD);
ok(sample.valid && sample.errors.length === 0, `SAMPLE_AGENT_CARD is valid (errors: ${JSON.stringify(sample.errors)})`);
ok(sample.summary.name === "Sample Weather Agent" && sample.summary.skillCount === 1, "sample summary carries name + skillCount");
ok(sample.summary.preferredTransport === "JSONRPC", "sample summary reads the declared transport");

// required-field enforcement
const missing = validateAgentCard({ name: "x" });
ok(!missing.valid, "card missing core fields is invalid");
for (const f of ["description", "url", "version", "capabilities", "defaultInputModes", "defaultOutputModes", "skills"]) {
  ok(missing.errors.some((e) => e.includes(`"${f}"`)), `missing "${f}" is reported`);
}

// non-object input never throws
ok(validateAgentCard(null).valid === false, "null card → invalid, no throw");
ok(validateAgentCard("{}").valid === false, "string card → invalid, no throw");

// skill shape
const badSkill = validateAgentCard({ ...SAMPLE_AGENT_CARD, skills: [{ id: "a", name: "A", description: "d", tags: ["t"] }, { id: "a", name: "B", description: "d", tags: ["t"] }] });
ok(badSkill.errors.some((e) => e.includes("unique")), "duplicate skill ids are an error");
const noTags = validateAgentCard({ ...SAMPLE_AGENT_CARD, skills: [{ id: "a", name: "A", description: "d" }] });
ok(noTags.errors.some((e) => e.includes("tags")), "skill without tags is an error");

// url + transport rules
ok(validateAgentCard({ ...SAMPLE_AGENT_CARD, url: "ftp://x" }).errors.some((e) => e.includes("http")), "non-http url is an error");
ok(validateAgentCard({ ...SAMPLE_AGENT_CARD, url: "http://x.example" }).warnings.some((w) => w.includes("https")), "plain-http url is a warning, not an error");
ok(validateAgentCard({ ...SAMPLE_AGENT_CARD, preferredTransport: "CARRIER_PIGEON" }).warnings.some((w) => w.includes("registered transport")), "unknown transport warns");
const noTransport = validateAgentCard((({ preferredTransport, ...rest }) => rest)(SAMPLE_AGENT_CARD));
ok(noTransport.valid && noTransport.warnings.some((w) => w.includes("JSONRPC")), "absent transport is valid + assumed-JSONRPC warning");

// empty skills = warning, not error
const empty = validateAgentCard({ ...SAMPLE_AGENT_CARD, skills: [] });
ok(empty.valid && empty.warnings.some((w) => w.includes("skills is empty")), "empty skills array warns but stays valid");

// additionalInterfaces shape
const badIf = validateAgentCard({ ...SAMPLE_AGENT_CARD, additionalInterfaces: [{ url: "https://x.example" }] });
ok(badIf.errors.some((e) => e.includes("additionalInterfaces[0]")), "malformed additionalInterfaces entry is an error");

// resolution order constant (a2a-card-fetch depends on canonical-first)
ok(A2A_WELL_KNOWN_PATHS[0] === "/.well-known/agent-card.json" && A2A_WELL_KNOWN_PATHS[1] === "/.well-known/agent.json", "well-known resolution order is canonical-first");

// OUR OWN CARD (2026-09-18). We sold card validation and card fetching and
// served no card of our own. It is judged by the validator we sell, and the
// assertions below are the ones that keep it HONEST rather than merely valid:
// a card that claims a transport we do not run, or capabilities we do not
// have, is the manifest-overstatement defect wearing a different hat.
{
  const card = buildOurAgentCard({ baseUrl: "https://agent402.tools", version: "2.1.0", toolCount: 607 });
  const v = validateAgentCard(card);
  ok(v.valid, `our own card passes our own validator (${JSON.stringify(v.errors)})`);
  ok(v.warnings.length === 0, `and raises no interop warnings (${JSON.stringify(v.warnings)})`);
  ok(card.preferredTransport === "HTTP+JSON", "it declares HTTP+JSON, because we run no A2A JSON-RPC endpoint");
  ok(card.capabilities.streaming === false, "it does not claim A2A task streaming (our SSE is on the LLM routes)");
  ok(card.capabilities.pushNotifications === false && card.capabilities.stateTransitionHistory === false, "nor push notifications or state history");
  ok(card.provider.organization === "Havok Holdings LLC", "the provider is the operating entity, never a person");
  // Parsed origin, never a prefix: "https://agent402.tools" as a startsWith
  // also accepts https://agent402.tools.example.com, which is the whole point
  // of the rule CodeQL raises here.
  ok(new URL(card.url).origin === "https://agent402.tools" && new URL(card.url).pathname === "/api", "the url is our own origin, matched exactly");
  ok(new Set(card.skills.map((s) => s.id)).size === card.skills.length && card.skills.length >= 3, "skills are unique and there are enough to be useful");
  ok(card.skills.every((s) => s.tags.length > 0), "every skill carries tags an A2A client can match on");
  const stale = buildOurAgentCard({ baseUrl: "https://agent402.tools/", version: "2.1.0" });
  ok(stale.url === "https://agent402.tools/api", "a trailing slash on the base url never doubles");
  ok(/500\+ priced endpoints/.test(stale.description), "an unreadable catalog count falls back to the evergreen claim, never to a wrong number");
  ok(/607 priced endpoints/.test(card.description), "and a live count is used when there is one");
}

// ERC-8004 registration file. The id is the hazard: it does not exist until
// the mint lands, and a machine surface that claims one we do not hold is the
// worst place for a false claim.
{
  const reg = buildAgentRegistration({ baseUrl: "https://agent402.tools", toolCount: 607 });
  for (const f of ["type", "name", "description", "image", "services"]) {
    ok(reg[f] !== undefined, `registration carries the EIP's required field "${f}"`);
  }
  ok(reg.type === "https://eips.ethereum.org/EIPS/eip-8004#registration-v1", "type is the EIP's own registration URI, not a schema.org class");
  ok(Array.isArray(reg.services) && reg.services.length >= 3, "it lists several ways to reach us, not just one");
  // The spec names these fields { name, endpoint }. The first cut shipped
  // { type, url }, which a conforming reader parses as zero usable services -
  // caught by reading the EIP's own example rather than a summary of it.
  ok(reg.services.every((x) => typeof x.name === "string" && typeof x.endpoint === "string"), "every service uses the spec's { name, endpoint } fields");
  ok(!reg.services.some((x) => "url" in x || "type" in x), "and none carries the wrong field names");
  ok(reg.services.some((x) => x.name === "MCP") && reg.services.some((x) => x.name === "A2A"), "including MCP and the A2A card");
  ok(reg.x402Support === true, "x402Support is declared, which is the whole point of this seller");
  ok(!("registrations" in reg), "an UNREGISTERED deployment publishes no registrations array at all");
  ok(!("supportedTrust" in reg), "and claims no trust model, so the standard is used for discovery only");
  for (const bad of [undefined, "", "0", "abc", "12x"]) {
    ok(!("registrations" in buildAgentRegistration({ baseUrl: "https://agent402.tools", agentId: bad })), `agentId ${JSON.stringify(bad)} is refused rather than published`);
  }
  const live = buildAgentRegistration({ baseUrl: "https://agent402.tools", agentId: "47" });
  ok(live.registrations[0].agentId === 47, "a real id is published as a number");
  ok(live.registrations[0].agentRegistry === `${ERC8004_IDENTITY_REGISTRY.chain}:${ERC8004_IDENTITY_REGISTRY.address}`, "with the CAIP-scoped registry it was minted in");
}


// The descriptions offer what is sold today, and the agent id is one constant.
{
  const { ERC8004_AGENT_ID } = await import("../src/tools/a2a-card.js");
  const reg = buildAgentRegistration({ baseUrl: "https://agent402.tools", toolCount: 3 });
  const card = buildOurAgentCard({ baseUrl: "https://agent402.tools", toolCount: 3 });
  for (const [n, d] of [["registration", reg.description], ["agent card", card.description]]) {
    ok(!/prepaid by card/.test(d), `the ${n} does not offer prepaid card credits`);
    ok(/USDG on Robinhood Chain/.test(d), `the ${n} names the non-USDC settlement asset from RAILS`);
  }
  const { readFileSync, readdirSync } = await import("node:fs");
  const srcDir = new URL("../src/", import.meta.url);
  const typed = readdirSync(srcDir).filter((f) => f.endsWith(".js") && readFileSync(new URL(f, srcDir), "utf8").includes(ERC8004_AGENT_ID));
  ok(typed.length === 0, `the agent id is typed only in a2a-card.js (also in: ${typed.join(", ") || "none"})`);
}

// One reader decides the published id for the registration file, /company and
// llms.txt: the setting when valid, else the hosted origin's constant, else none.
{
  const { ERC8004_AGENT_ID, erc8004AgentId } = await import("../src/tools/a2a-card.js");
  const { companyPage } = await import("../src/company.js");
  const saved = process.env.ERC8004_AGENT_ID;
  delete process.env.ERC8004_AGENT_ID;
  ok(erc8004AgentId("https://agent402.tools") === ERC8004_AGENT_ID, "the hosted origin publishes the constant id");
  ok(erc8004AgentId("http://127.0.0.1:3000") === null, "a self-hosted origin publishes no id by default");
  ok(!/agent \d+<\/strong>/.test(companyPage("http://127.0.0.1:3000")) && companyPage("https://agent402.tools").includes(`agent ${ERC8004_AGENT_ID}</strong>`), "/company names the id only where the reader returns one");
  process.env.ERC8004_AGENT_ID = "47";
  ok(erc8004AgentId("http://127.0.0.1:3000") === "47" && erc8004AgentId("https://agent402.tools") === "47", "the setting wins on any origin");
  process.env.ERC8004_AGENT_ID = "0x1";
  ok(erc8004AgentId("https://agent402.tools") === null, "an invalid setting publishes no id rather than a guess");
  if (saved === undefined) delete process.env.ERC8004_AGENT_ID; else process.env.ERC8004_AGENT_ID = saved;
}

console.log(`\n${failed ? "FAILED" : "OK"}: ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
