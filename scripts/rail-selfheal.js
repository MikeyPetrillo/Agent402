#!/usr/bin/env node
// Bring a recovered rail back WITHOUT a human.
//
//   node scripts/rail-selfheal.js            # report only
//   RAILWAY_TOKEN=... node scripts/rail-selfheal.js   # report + restart on recovery
//
// WHY: src/payments.js drops a rail whose facilitator cannot be reached, so one
// dead third party costs one chain instead of every paid route. That decision is
// made ONCE AT BOOT - its own warning reads "a dropped rail returns on the next
// boot where its facilitator answers". So when the third party recovers, the
// rail stays dead until a human redeploys. Celo sat exactly that way while the
// service advertised twelve chains and served eleven.
//
// A live in-process swap of the offer was prototyped and REJECTED: rebuilding
// `accepts` while serving produced an EMPTY offer under test, and the failure
// mode there is "nobody can pay". Restarting re-runs the boot sequence, which is
// the most tested path in the system (quiet gate, drain, healthcheck). Boring
// beats clever on the payment path.
//
// THE RULE, and it is deliberately strict: restart only when BOTH hold
//   1. /api/rails reports a configured rail that is NOT offered, and
//   2. that rail's own facilitator answers /supported RIGHT NOW.
// A rail that is genuinely down is reported and left alone - restarting would
// not fix it and would just churn production on someone else's outage.
import { railRecovered } from "./lib/rail-recovered.js";
const TARGET = (process.env.TARGET_URL || "https://agent402.tools").replace(/\/+$/, "");

// Rails with a DEDICATED facilitator are the ones that can drop on their own;
// the rest ride CDP/PayAI and fall with them. Public endpoints, no secrets.
// scripts/test-rail-selfheal.js asserts this covers every dedicated-facilitator
// rail payments.js knows about, so the map cannot silently drift.
const FACILITATORS = {
  celo: process.env.CELO_FACILITATOR_URL || "https://api.x402.celo.org",
  monad: process.env.MONAD_FACILITATOR_URL || "https://x402-facilitator.molandak.org",
  robinhood: process.env.ROBINHOOD_FACILITATOR_URL || "",
  stellar: process.env.STELLAR_FACILITATOR_URL || "https://channels.openzeppelin.com/x402",
  algorand: process.env.ALGORAND_FACILITATOR_URL || "https://facilitator.goplausible.xyz",
  // Solvador-primary (Optimism today). No OPTIMISM_FACILITATOR_URL — Solvador is
  // the only settler for eip155:10. Without this entry a recovered Solvador
  // never restarts us, and the rail stays dropped until a human redeploys
  // (measured 2026-08-09: issue #723, Solvador /supported timed out at boot,
  // then answered again while the healer kept skipping optimism).
  optimism: process.env.SOLVADOR_FACILITATOR_URL || "https://api.solvador.com",
  // Circle's facilitator (Arc only); its /supported is keyless.
  arc: "https://api.circle.com/v1/facilitator/x402",
};

const j = async (url, opts = {}) => {
  const r = await fetch(url, { signal: AbortSignal.timeout(20_000), ...opts });
  return { ok: r.ok, status: r.status, body: await r.json().catch(() => null) };
};

const rails = await j(`${TARGET}/api/rails`);
if (!rails.ok || !rails.body) {
  console.log(`rail-selfheal: /api/rails unreadable (${rails.status}) - doing nothing.`);
  console.log("An unreadable signal is not evidence of a healthy offer, but it is also not evidence of a broken one.");
  process.exit(0);
}
const { configured, offered, degraded, rails: rows } = rails.body;
console.log(`rail-selfheal: configured=${configured} offered=${offered} degraded=${degraded}`);
if (!degraded) { console.log("every configured rail is offered - nothing to heal."); process.exit(0); }

const down = rows.filter((r) => !r.offered);
for (const r of down) console.log(`  DEGRADED ${r.network}: ${r.reason}`);

// Which of the degraded rails is actually healthy again upstream?
const recovered = [];
for (const r of down) {
  const url = FACILITATORS[r.network];
  if (!url) { console.log(`  ${r.network}: no dedicated facilitator known - cannot confirm recovery, leaving alone`); continue; }
  try {
    const s = await j(`${url.replace(/\/+$/, "")}/supported`);
    if (railRecovered(r.network, s)) {
      console.log(`  ${r.network}: facilitator ANSWERS again (${s.status}) - recovered upstream`);
      recovered.push(r.network);
    } else {
      console.log(`  ${r.network}: facilitator still failing (${s.status}) - genuinely down, not restarting for it`);
    }
  } catch (e) {
    console.log(`  ${r.network}: facilitator unreachable (${String(e?.message || e).slice(0, 60)}) - still down`);
  }
}

if (!recovered.length) {
  console.log("\nNothing recovered upstream. Reporting only - a restart would not bring these back.");
  process.exit(0);
}

console.log(`\n${recovered.join(", ")} recovered upstream but the running process still has them dropped (boot-time decision).`);
const token = process.env.RAILWAY_TOKEN;
if (!token) {
  console.log("RAILWAY_TOKEN not set - cannot restart. Redeploy to pick the rail back up.");
  process.exit(0);
}

// Resolve the service and environment from the TOKEN, the same way the deploy
// job does, rather than demanding two more secrets. A healer that silently
// no-ops because an id was never configured is worse than no healer: the
// dashboard would show it running green while nothing ever heals.
const gql = async (query, variables = {}) => {
  const r = await fetch("https://backboard.railway.com/graphql/v2", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
    body: JSON.stringify({ query, variables }),
    signal: AbortSignal.timeout(30_000),
  });
  const out = await r.json().catch(() => null);
  if (!r.ok || out?.errors) throw new Error(`${r.status} ${JSON.stringify(out?.errors || out).slice(0, 160)}`);
  return out?.data;
};

const PROJECT_NAME = process.env.RAILWAY_PROJECT_NAME || "agent402";
const SERVICE_NAME = process.env.RAILWAY_SERVICE_NAME || "agent402";
let service = process.env.RAILWAY_SERVICE_ID || "";
let envId = process.env.RAILWAY_ENVIRONMENT_ID || "";
try {
  if (!service || !envId) {
    const projects = await gql("query { projects { edges { node { id name } } } }");
    const project = projects?.projects?.edges?.find((e) => e.node.name === PROJECT_NAME)?.node;
    if (!project) throw new Error(`no Railway project named "${PROJECT_NAME}"`);
    const detail = await gql(
      "query($id:String!){ project(id:$id){ environments { edges { node { id name } } } services { edges { node { id name } } } } }",
      { id: project.id }
    );
    envId = envId || detail?.project?.environments?.edges?.find((e) => e.node.name === "production")?.node?.id || "";
    const svcEdges = detail?.project?.services?.edges || [];
    service = service
      || svcEdges.find((e) => e.node.name === SERVICE_NAME)?.node?.id
      || (svcEdges.length === 1 ? svcEdges[0].node.id : "");
    if (!service || !envId) throw new Error(`could not resolve service/environment (services: ${svcEdges.map((e) => e.node.name).join(", ") || "none"})`);
    console.log(`resolved Railway service=${service.slice(0, 8)}… environment=${envId.slice(0, 8)}…`);
  }
} catch (e) {
  console.error(`cannot resolve the Railway service to restart: ${String(e?.message || e).slice(0, 180)}`);
  process.exit(1);
}

// Restart the CURRENT deployment: same build, fresh boot, rails re-probed.
// Deliberately not a redeploy - that would rebuild from main and could ship
// unrelated commits as a side effect of a third party's recovery.
try {
  await gql(
    "mutation($id:String!,$env:String!){ serviceInstanceRedeploy(serviceId:$id, environmentId:$env) }",
    { id: service, env: envId }
  );
} catch (e) {
  console.error(`restart FAILED: ${String(e?.message || e).slice(0, 200)}`);
  process.exit(1);
}
console.log(`restart triggered - ${recovered.join(", ")} will be re-offered once the new container serves.`);
