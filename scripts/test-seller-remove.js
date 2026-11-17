#!/usr/bin/env node
// Operator lever: remove ONE seller origin from the x402 index and router.
//
// What this pins:
//   - removal clears the crawl cache, submitted and discovered seeds, the
//     Bazaar maps and any succession keyed on the origin;
//   - the removal survives a reload from its persisted file, and a removal
//     loaded AFTER the stores were filled still purges them;
//   - every write path refuses the origin afterwards (cache, seed sets, Bazaar
//     maps, seed list, successions, registerOrigin), so no discovery source can
//     bring it back;
//   - the match is EXACT: another port on the same host is untouched, and a
//     name, a wildcard or a path is refused rather than guessed at;
//   - restore lifts the block without re-adding seeds;
//   - booted: the operator routes 404 without the token, remove/list/restore
//     work with it, and POST /api/index/register answers 410 for a removed
//     origin.
import "./lib/offline-stores.js"; // per-process and file backends whatever the caller exports (see the file)
import { strict as assert } from "node:assert";
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { getFreePort } from "./lib/free-port.js";

const dir = mkdtempSync(join(tmpdir(), "a402-remove-"));
const FILE = join(dir, "removed-origins.json");
process.env.REMOVED_ORIGINS_FILE = FILE;
process.env.SALES_LEDGER_DB = join(dir, "sales.db");
process.env.ALLOW_EPHEMERAL_STATS = "true";
const TAG = Math.random().toString(36).slice(2, 8);

const idx = await import("../src/x402-index.js");
const { recordSellerRegistrationSeen, sellerRegistrationFirstSeen } = await import("../src/stats.js");

let n = 0;
const ok = (c, m) => { assert.ok(c, m); n++; console.log(`ok - ${m}`); };

const O = `https://seller-${TAG}.example.com`;
const O_ALT = `https://seller-${TAG}.example.com:8443`;
const OTHER = `https://other-${TAG}.example.com`;
const entry = { manifest: { name: "x" }, tools: [{ route: "/a", name: "a" }], fetchedAt: Date.now(), error: null };
const crawl = async () => ({ ...entry });

idx.__testResetSubmitted();

// Set up: O is submitted (so it is a seed and cached), O_ALT is cached, OTHER
// is cached, O has a registration row and Bazaar quality.
let r = await idx.registerOrigin(O, { crawl });
ok(r.listed === true, "precondition: origin registers");
idx.__testSeedCache([[O_ALT, { ...entry }], [OTHER, { ...entry }]]);
idx._setBazaarQualityForTest(O, { calls30d: 5, payers30d: 2 });
recordSellerRegistrationSeen(O);
ok(sellerRegistrationFirstSeen(O) != null, "precondition: registration row exists");
ok(idx.seedList().includes(O), "precondition: origin is in the seed list");
ok(idx.recordSuccession(O, OTHER), "precondition: a succession keyed on the origin");

// Name-like, wildcard, query and malformed-path input is refused (a clean path
// prefix is a path seller's key since 2026-10-01; see test-path-scoped-sellers).
for (const bad of ["Acme Corp", "seller", `*.example.com`, `https://*.example.com`, `${O}/a/../api`, `${O}/%61pi`, `${O}?x=1`, "ftp://seller.example.com", "", "https://nodot"]) {
  ok(idx.removeOrigin(bad).error, `refused: ${JSON.stringify(bad)}`);
}
ok(idx._cacheForTests().has(O), "refused input removed nothing");

// Remove (case + trailing slash normalize to the same exact origin).
r = idx.removeOrigin(`${O.toUpperCase().replace("HTTPS", "https")}/`, { note: "test" });
ok(r.removed === true && r.origin === O, "removal returns the normalized origin");
ok(typeof r.removedAt === "number" && r.removedAt > 0, "removal records removedAt");
ok(!idx._cacheForTests().has(O), "cache cleared");
ok(!idx.seedList().includes(O), "seed list cleared");
ok(idx.bazaarQualityFor(O) === null, "Bazaar quality cleared");
ok(idx.sellerDetail(O) === null, "seller detail no longer answers");
ok(sellerRegistrationFirstSeen(O) == null, "registration row deleted");
ok(idx.succeededBy(O) === null, "succession keyed on the origin dropped");
ok(idx.isRemovedOrigin(O) && idx.isRemovedOrigin(`${O}/`), "isRemovedOrigin matches");

// Exact match: other port and other host untouched.
ok(idx._cacheForTests().has(O_ALT), "a different port on the same host is NOT removed");
ok(!idx.isRemovedOrigin(O_ALT), "isRemovedOrigin is port-exact");
ok(idx._cacheForTests().has(OTHER), "an unrelated origin is untouched");
ok(!idx.isRemovedOrigin(`http://seller-${TAG}.example.com`), "a different scheme is not the same origin");

// Every write path refuses it.
idx.__testSeedCache([[O, { ...entry }]]);
ok(!idx._cacheForTests().has(O), "a crawl/discovery write to the cache is refused");
idx._setBazaarQualityForTest(O, { calls30d: 1 });
ok(idx.bazaarQualityFor(O) === null, "a Bazaar write is refused");
ok(!idx.recordSuccession(O, OTHER) && !idx.recordSuccession(OTHER, O), "a succession involving it is refused");
r = await idx.registerOrigin(O, { crawl });
ok(r.listed === false && r.removed === true && r.error === idx.REMOVED_ORIGIN_ERROR, "registerOrigin refuses it");
ok(!idx.seedList().includes(O), "still not in the seed list after a register attempt");

// Persisted, and survives a reload.
ok(existsSync(FILE), "removed list persisted");
const saved = JSON.parse(readFileSync(FILE, "utf8"));
ok(saved.length === 1 && saved[0].origin === O && saved[0].note === "test", "persisted record carries origin + note");
idx.__testResetSubmitted(); // clears the in-memory removed set too
ok(!idx.isRemovedOrigin(O), "reset clears memory");
idx.__testSeedCache([[O, { ...entry }]]); // filled before the load, like a warm start out of order
ok(idx.loadRemovedOrigins() === 1, "reload reads one removal");
ok(idx.isRemovedOrigin(O), "removal survives the reload");
ok(!idx._cacheForTests().has(O), "a removal loaded after the stores were filled still purges them");
ok(idx.listRemovedOrigins()[0].origin === O, "listRemovedOrigins returns it");

// Restore.
ok(idx.restoreOrigin("not an origin").error, "restore refuses non-origin input");
r = idx.restoreOrigin(O);
ok(r.restored === true, "restore lifts the block");
ok(!idx.isRemovedOrigin(O), "no longer removed");
ok(!idx.seedList().includes(O), "restore does not re-add seeds");
ok(JSON.parse(readFileSync(FILE, "utf8")).length === 0, "restore persisted");
r = await idx.registerOrigin(O, { crawl });
ok(r.listed === true, "the owner can register again after restore");
ok(idx.restoreOrigin(O).restored === false, "restoring a non-removed origin reports false");

// Preview and provenance. A dry run names what a removal would take, where
// the origin is known from and how it comes back once restored, and changes
// nothing. A registry-only origin returns by itself on the next registry read;
// an origin only its owner submitted returns when the owner registers again.
idx.__testResetSubmitted();
const REG = `https://registry-${TAG}.example.com`;
const OWN = `https://owned-${TAG}.example.com`;
const regTools = [{ route: "/a", name: "a" }, { route: "/b", name: "b" }];
idx.__testSetBazaarTools(REG, regTools);
idx.__testSeedCache([[REG, { ...entry, tools: regTools, source: "bazaar-fallback" }]]);
ok(idx.removalPreview("Acme").error, "preview refuses a name");
let p = idx.removalPreview(`${REG}/`);
ok(p.origin === REG && p.removed === false, "preview: normalized origin, not removed");
ok(JSON.stringify(p.knownFrom) === '["registry"]', "preview: a registry-only origin reads knownFrom registry");
ok(p.returnsBy === "registry" && /registry/.test(p.afterRestore), "preview: a registry-only origin returns on its own after restore");
ok(p.held.cached === true && p.held.tools === 2 && p.held.toolsTotal === 2 && p.held.registryRows === 2 && p.held.source === "bazaar-fallback", "preview: counts what the index holds");
ok(p.held.submitted === false && p.held.successions === 0, "preview: nothing submitted, no succession");
ok(idx._cacheForTests().has(REG) && !idx.isRemovedOrigin(REG) && idx.listRemovedOrigins().length === 0, "preview changes nothing");
{
  const { SELLER_TOOL_CAP } = await import("../src/seller-tool-cap.js");
  const many = Array.from({ length: SELLER_TOOL_CAP + 5 }, (_, i) => ({ route: `/r${i}`, name: `r${i}` }));
  idx.__testSeedCache([[REG, { ...entry, tools: many, source: "bazaar-fallback" }]]);
  const h = idx.removalPreview(REG).held;
  ok(h.tools === SELLER_TOOL_CAP && h.toolsTotal === SELLER_TOOL_CAP + 5, "preview: a capped listing reads the kept rows and the count it listed");
  idx.__testSeedCache([[REG, { ...entry, tools: regTools, source: "bazaar-fallback" }]]);
}

r = idx.removeOrigin(REG, { note: "diagnostic" });
ok(r.removed === true && JSON.stringify(r.knownFrom) === '["registry"]' && r.returnsBy === "registry", "removal answer carries the provenance");
ok(JSON.stringify(idx.listRemovedOrigins()[0].knownFrom) === '["registry"]', "the removed list carries the provenance");
ok(JSON.stringify(JSON.parse(readFileSync(FILE, "utf8"))[0].knownFrom) === '["registry"]', "provenance persisted");
p = idx.removalPreview(REG);
ok(p.removed === true && p.held.cached === false && JSON.stringify(p.knownFrom) === '["registry"]', "preview of a removed origin reads the stored provenance");
idx.__testResetSubmitted();
ok(idx.loadRemovedOrigins() === 1 && JSON.stringify(idx.listRemovedOrigins()[0].knownFrom) === '["registry"]', "provenance survives a reload");
r = idx.restoreOrigin(REG);
ok(r.restored === true && r.returnsBy === "registry" && /registry/.test(r.afterRestore), "restore says a registry-only origin comes back on its own");

r = await idx.registerOrigin(OWN, { crawl });
ok(r.listed === true, "precondition: an owner-submitted origin");
p = idx.removalPreview(OWN);
ok(JSON.stringify(p.knownFrom) === '["owner"]' && p.returnsBy === "owner" && /owner/.test(p.afterRestore), "preview: an owner-submitted origin returns when the owner registers again");
idx.removeOrigin(OWN);
r = idx.restoreOrigin(OWN);
ok(r.restored === true && r.returnsBy === "owner", "restore: the owner-submitted origin waits for its owner");
// A fallback entry still held after its registry rows rotated out is registry provenance.
const FB = `https://fallback-${TAG}.example.com`;
idx.__testSeedCache([[FB, { ...entry, source: "bazaar-fallback" }]]);
p = idx.removalPreview(FB);
ok(JSON.stringify(p.knownFrom) === '["registry"]' && p.held.registryRows === 0, "preview: a held registry-fallback entry reads registry with no rows left");
// Owner-submitted AND listed in a registry: it returns by itself, so registry wins.
ok((await idx.registerOrigin(OWN, { crawl })).listed === true, "precondition: the owner registers again after restore");
idx.__testSetBazaarTools(OWN, regTools);
p = idx.removalPreview(OWN);
ok(JSON.stringify(p.knownFrom) === '["registry","owner"]' && p.returnsBy === "registry", "preview: a registry listing outranks the owner's submission");
idx.__testSetBazaarTools(OWN, null);
p = idx.removalPreview(`https://nothing-${TAG}.example.com`);
ok(p.knownFrom.length === 0 && p.returnsBy === null && p.held.cached === false, "preview: an origin the index never held");
// A stored record written before provenance existed reads as unknown.
idx.__testResetSubmitted();
writeFileSync(FILE, JSON.stringify([{ origin: OWN, removedAt: 1, note: "" }, { origin: REG, removedAt: 2, note: "", knownFrom: ["registry", "bogus", 7] }]));
idx.loadRemovedOrigins();
const byOrigin = Object.fromEntries(idx.listRemovedOrigins().map((x) => [x.origin, x]));
ok(byOrigin[OWN].knownFrom === null && byOrigin[OWN].returnsBy === null, "an old record has no provenance");
ok(JSON.stringify(byOrigin[REG].knownFrom) === '["registry"]', "a stored provenance keeps only known words");
idx.restoreOrigin(OWN); idx.restoreOrigin(REG);

// Booted leg: auth, routes, register refusal.
idx.__testResetSubmitted();
const TOKEN = `op-${TAG}-secret-token`;
const PORT = await getFreePort();
const base = `http://127.0.0.1:${PORT}`;
const bootFile = join(dir, "boot-removed.json");
const child = spawn(process.execPath, ["src/server.js"], {
  env: { ...process.env, FREE_MODE: "true", PORT: String(PORT), AGENT402_OPERATOR_TOKEN: TOKEN, X402_INDEX_CRAWL: "off", X402_SYNC_ON_START: "false", REMOVED_ORIGINS_FILE: bootFile },
  stdio: ["ignore", "pipe", "pipe"],
});
let log = "";
child.stdout.on("data", (d) => { log += d; });
child.stderr.on("data", (d) => { log += d; });
const wait = (ms) => new Promise((res) => setTimeout(res, ms));
try {
  let up = false;
  for (let i = 0; i < 120; i++) {
    try { if ((await fetch(`${base}/health`)).ok) { up = true; break; } } catch { /* booting */ }
    await wait(500);
  }
  if (!up) console.error(log.slice(-800));
  ok(up, "server booted");
  const post = (path, body, headers = {}) => fetch(`${base}${path}`, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) });
  const auth = { authorization: `Bearer ${TOKEN}` };
  const B = `https://booted-${TAG}.example.com`;

  ok((await post("/__operator/sellers/remove", { origin: B })).status === 404, "remove: 404 without the token");
  ok((await fetch(`${base}/__operator/sellers/removed.json`)).status === 404, "list: 404 without the token");
  ok((await post("/__operator/sellers/restore", { origin: B })).status === 404, "restore: 404 without the token");
  ok((await post("/__operator/sellers/remove", { origin: B }, { authorization: "Bearer wrong" })).status === 404, "remove: 404 with a wrong token");

  ok((await post("/__operator/sellers/remove", { origin: "Acme" }, auth)).status === 400, "remove: name-like input 400");
  ok((await post("/__operator/sellers/remove", { origin: "https://*.example.com" }, auth)).status === 400, "remove: wildcard 400");
  let res = await post("/__operator/sellers/remove", { origin: B, dryRun: true }, auth);
  let j = await res.json();
  ok(res.status === 200 && j.dryRun === true && j.removed === false && j.origin === B && Array.isArray(j.knownFrom) && j.held && "afterRestore" in j, "remove dryRun: 200 with the preview");
  j = await (await fetch(`${base}/__operator/sellers/removed.json`, { headers: auth })).json();
  ok(j.total === 0, "remove dryRun: nothing removed");
  ok((await post("/__operator/sellers/remove", { origin: "Acme", dryRun: true }, auth)).status === 400, "remove dryRun: name-like input 400");
  for (const dryRun of ["true", 1]) {
    res = await post("/__operator/sellers/remove", { origin: B, dryRun }, auth);
    j = await res.json();
    ok(res.status === 400 && /dryRun/.test(j.error || ""), `remove dryRun ${JSON.stringify(dryRun)}: 400 naming the field (${res.status})`);
  }
  j = await (await fetch(`${base}/__operator/sellers/removed.json`, { headers: auth })).json();
  ok(j.total === 0, "a non-boolean dryRun removes nothing");
  res = await post("/__operator/sellers/remove", { origin: B, note: "n" }, auth);
  j = await res.json();
  ok(res.status === 200 && j.removed === true && j.origin === B && j.removedAt > 0, "remove: 200 with the token");
  j = await (await fetch(`${base}/__operator/sellers/removed.json`, { headers: auth })).json();
  ok(j.total === 1 && j.removed[0].origin === B, "list shows the removed origin");

  res = await post("/api/index/register", { origin: B });
  j = await res.json();
  ok(res.status === 410 && j.error === "origin removed at the owner's request" && Object.keys(j).length === 1, "register refuses a removed origin with 410 and no detail");
  res = await post("/api/index/register", { origin: `https://new-${TAG}.example.com`, replaces: B });
  ok(res.status === 410, "register refuses a removed origin as `replaces`");

  res = await post("/__operator/sellers/restore", { origin: B }, auth);
  j = await res.json();
  ok(res.status === 200 && j.restored === true && "returnsBy" in j && typeof j.note === "string", "restore: 200 with the token and how it returns");
  j = await (await fetch(`${base}/__operator/sellers/removed.json`, { headers: auth })).json();
  ok(j.total === 0, "list empty after restore");
} finally {
  try { child.kill("SIGKILL"); } catch { /* gone */ }
  rmSync(dir, { recursive: true, force: true });
}
console.log(`\ntest-seller-remove: ${n} assertions passed`);
process.exit(0);
