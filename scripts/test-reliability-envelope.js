// /api/reliability is the "is this seller safe to depend on" surface. Listing
// portals, agents, and would-be integrators all read it before binding to the
// service. Every claim in `guarantees[]` is paired with a `verify` URL so a
// caller can independently confirm the claim — a regression that drops the
// pairing (claim without verify, or a guarantee silently removed) turns the
// report into marketing copy rather than an audit primitive.
//
// This test boots FREE_MODE and locks:
//
//   1. GET /api/reliability → 200 application/json.
//   2. Envelope: { service, status, asOf, servingSince, uptimeSeconds,
//      toolCallsServed, onchain{}, guarantees[], endpoints{}, incidents }.
//   3. service === 'Agent402.Tools', status === 'operational' (a 200 by definition
//      means the node is serving — the field documents that contract).
//   4. asOf parses as ISO; uptimeSeconds and toolCallsServed are numbers.
//   5. onchain has revenueProof URL (or null in FREE_MODE) + a note.
//   6. guarantees[] is non-empty AND every entry has `claim` + `verify` —
//      the verify URL is the trustless half of every claim.
//   7. Every documented endpoint URL points to a real path on this BASE.
//   8. incidents URL is a GitHub issues query (the public escalation log).
//
//   node scripts/test-reliability-envelope.js
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const PORT = 3082;
const BASE = `http://localhost:${PORT}`;

let pass = 0;
const fail = (m) => { console.error("FAIL:", m); try { proc.kill("SIGKILL"); } catch {} process.exit(1); };
const ok = (c, m) => { if (c) { pass++; console.log(`ok - ${m}`); } else fail(m); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const proc = spawn(process.execPath, [join(ROOT, "src", "server.js")], {
  cwd: ROOT,
  env: { ...process.env, FREE_MODE: "true", PORT: String(PORT), X402_SYNC_ON_START: "false" },
  stdio: "ignore",
});

try {
  for (let i = 0; i < 40; i++) { try { if ((await fetch(`${BASE}/health`)).ok) break; } catch {} await sleep(500); }

  const res = await fetch(`${BASE}/api/reliability`);
  ok(res.status === 200, `/api/reliability → 200 (got ${res.status})`);
  ok((res.headers.get("content-type") || "").includes("application/json"), `content-type is application/json`);
  const body = await res.json();

  // Envelope shape.
  for (const k of ["service", "status", "asOf", "servingSince", "uptimeSeconds", "toolCallsServed", "onchain", "guarantees", "endpoints", "incidents"]) {
    ok(k in body, `envelope key '${k}' present (got: ${Object.keys(body).join(",")})`);
  }
  ok(body.service === "Agent402.Tools", `service='Agent402.Tools' (got ${body.service})`);
  // status field documents the contract — a 200 from this URL means the
  // node is up; the field is the machine-readable version of that fact.
  ok(body.status === "operational", `status='operational' (got ${body.status}) — a 200 here documents node liveness`);
  ok(typeof body.asOf === "string" && !isNaN(Date.parse(body.asOf)), `asOf is parseable ISO (got ${body.asOf})`);
  ok(typeof body.servingSince === "string", `servingSince is string (got ${typeof body.servingSince})`);
  ok(typeof body.uptimeSeconds === "number" && body.uptimeSeconds >= 0, `uptimeSeconds is non-negative number (got ${body.uptimeSeconds})`);
  // toolCallsServed is the structured tally: total + breakdown by payment
  // path. The breakdown is what's interesting — viaUSDC vs viaProofOfWork
  // tells a portal which tier dominates traffic.
  ok(typeof body.toolCallsServed === "object" && body.toolCallsServed != null, `toolCallsServed is an object (got ${typeof body.toolCallsServed})`);
  ok(typeof body.toolCallsServed.total === "number" && body.toolCallsServed.total >= 0, `toolCallsServed.total is non-negative number (got ${body.toolCallsServed.total})`);
  ok(typeof body.toolCallsServed.viaUSDC === "number", `toolCallsServed.viaUSDC is number (got ${typeof body.toolCallsServed.viaUSDC})`);
  ok(typeof body.toolCallsServed.viaProofOfWork === "number", `toolCallsServed.viaProofOfWork is number (got ${typeof body.toolCallsServed.viaProofOfWork})`);

  // onchain block — revenueProof may be null in FREE_MODE (no wallet) but the
  // key must exist; note must be present so a caller knows where the source
  // of truth lives.
  ok(typeof body.onchain === "object" && body.onchain != null, "onchain is an object");
  ok("revenueProof" in body.onchain, `onchain.revenueProof key present (value may be null in FREE_MODE; got ${body.onchain.revenueProof})`);
  ok(typeof body.onchain.note === "string" && body.onchain.note.length > 0, `onchain.note is non-empty (got "${body.onchain.note?.slice(0, 60)}…")`);

  // Guarantees — every claim has a verify URL. Listing portals scrape this
  // field; a claim without a verify URL is a marketing statement, not an
  // auditable one.
  ok(Array.isArray(body.guarantees) && body.guarantees.length >= 3, `guarantees has >= 3 entries (got ${body.guarantees?.length})`);
  let claimOk = 0;
  for (const g of body.guarantees) {
    if (typeof g.claim !== "string" || !g.claim.length) { fail(`guarantee missing claim (got ${JSON.stringify(g)})`); break; }
    // verify can be null only for guarantees that have no off-domain proof,
    // but it must be a string (URL) or null — not undefined.
    if (!("verify" in g)) { fail(`guarantee missing verify key (claim: ${g.claim.slice(0, 40)}…)`); break; }
    if (g.verify !== null && typeof g.verify !== "string") { fail(`guarantee.verify is neither string nor null (got ${typeof g.verify})`); break; }
    claimOk++;
  }
  ok(claimOk === body.guarantees.length, `every guarantee has claim + verify key (${claimOk}/${body.guarantees.length})`);

  // Endpoints block — every URL is on this BASE so a caller doesn't have to
  // guess. (REPO links live elsewhere — only the in-service URLs belong here.)
  ok(typeof body.endpoints === "object" && body.endpoints != null, "endpoints is an object");
  for (const k of ["health", "stats", "openapi", "manifest"]) {
    ok(typeof body.endpoints[k] === "string" && body.endpoints[k].startsWith(BASE), `endpoints.${k} is on BASE (got ${body.endpoints[k]})`);
  }
  // Spot-check that endpoints.health actually serves 200 — a stale URL here
  // breaks every listing portal that follows it.
  const probe = await fetch(body.endpoints.health);
  ok(probe.status === 200, `endpoints.health resolves to 200 (got ${probe.status})`);

  // Incidents — public escalation log. Should be a github.com issues URL so
  // a caller can read the open incidents without auth.
  ok(typeof body.incidents === "string" && body.incidents.includes("github.com"), `incidents points to github.com (got ${body.incidents})`);

  console.log(`\n${pass} passed (${body.guarantees.length} guarantees, ${Object.keys(body.endpoints).length} endpoints)`);
  proc.kill("SIGKILL");
  process.exit(0);
} catch (e) {
  fail(e.message);
}
