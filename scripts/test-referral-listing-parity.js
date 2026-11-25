#!/usr/bin/env node
// The 402 of a referral copy (/ref/<slug>, src/referral-gate.js) tells a
// buyer what the call returns before it pays: the description the catalog
// publishes for the tool (/api/pricing) and the same extensions.bazaar block
// (info.input and schema) the tool's public route lists in its own 402
// (src/payments.js publicBazaarOf), with nothing that points a buyer at this
// server's own surfaces.
//
// Boots the real server in paid mode with EVERY published slug listed (and
// every resale and parity exception opened for the test), so each slug any
// listing could name is checked, not only today's list:
//   - the description is the catalog's, a direct route named by its slug, and
//     only a sentence that still points home left out;
//   - extensions.bazaar equals the public route's decoded PAYMENT-REQUIRED
//     block, the two shortened-example notes that name the spec reworded;
//   - no host, catalog URL, /api path, spec or docs link in any 402 body or header;
//   - the largest /ref 402, measured as the header it would be, fits the
//     challenge budget a buyer echoes back (scripts/test-challenge-size.js);
//   - the price and the accept are the ones the gate quoted before this change.
//
//   node scripts/test-referral-listing-parity.js
import "./lib/offline-stores.js"; // per-process and file backends whatever the caller exports (see the file)
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { bootPaidServer } from "./lib/paid-boot.js";

let failed = 0;
const ok = (cond, msg) => { if (cond) console.log(`ok - ${msg}`); else { failed++; console.log(`not ok - ${msg}`); } };

const tmp = mkdtempSync(join(tmpdir(), "a402-ref-listing-"));
process.on("exit", () => { try { rmSync(tmp, { recursive: true, force: true }); } catch { /* best effort */ } });
const screenFile = join(tmp, "screen.json");
writeFileSync(screenFile, JSON.stringify({ v: 1, loadedAt: Date.now(), publishDate: "01/01/2026", perAsset: { ETH: 1 }, addresses: [] }));

const published = JSON.parse(readFileSync(fileURLToPath(new URL("./published-slugs.json", import.meta.url)), "utf8")).tools;
ok(Array.isArray(published) && published.length > 400, `every published slug is listed (${published?.length})`);
const LIST = published.join(",");
const COSTS = { UPSTREAM_COSTS_JSON: "", UPSTREAM_COSTS_FILE: fileURLToPath(new URL("../docs/example-upstream-costs.json", import.meta.url)) };
// The challenge a buyer echoes back (scripts/test-challenge-size.js MAX_HEADER_BYTES).
const MAX_CHALLENGE_BYTES = 12_000;

const srv = await bootPaidServer({
  label: "ref-listing",
  env: {
    ...COSTS,
    RESALE_CLEARED_FOR_TEST: LIST,
    SANCTIONS_SCREEN_FILE: screenFile,
    REFERRAL_PAY_TO: "0x1111111111111111111111111111111111111111",
    REFERRAL_MERCHANT_ID: "7",
    REFERRAL_PAYOUT_ADDRESS: "0x2222222222222222222222222222222222222222",
    REFERRAL_FACILITATOR_URL: "http://127.0.0.1:9/never-called",
    REFERRAL_SIGNER_KEY: "11".repeat(32),
    REFERRAL_SETUP_URL: "https://setup.example/.well-known/referral",
    REFERRAL_COMMISSION_BPS: "default:1234",
    REFERRAL_SLUGS: LIST,
    REFERRAL_PARITY_GRANDFATHERED: LIST,
    FIRST_CALL_ALLOWANCE: "off", RETURNING_WALLET_PRICE: "off",
  },
});

const call = async (url, { method = "GET", body, headers = {} } = {}) => {
  const r = await fetch(url, { method, headers: { ...(body !== undefined ? { "content-type": "application/json" } : {}), ...headers }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
  const text = await r.text();
  let json = null; try { json = JSON.parse(text); } catch { /* not JSON */ }
  return { status: r.status, headers: r.headers, text, json };
};
let ip = 0;
const xff = () => ({ "x-forwarded-for": `198.51.100.${1 + (++ip % 250)}` });

/** Every pointer to this server's own surfaces (scripts/test-referral-gate.js pointerWalk). */
const pointerWalk = (hostOf) => (text, slug) => {
  const found = [];
  for (const m of String(text).matchAll(new RegExp(`(?:agent402\\.tools|${hostOf.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")})(\\/[^\\s"'\\\\<>)]*)?`, "gi"))) { const path = m[1] || "/"; if (!path.startsWith(`/ref/${slug}`)) found.push(m[0]); }
  for (const m of String(text).matchAll(/(?:^|[\s"'(])(\/(?:api\/[a-z0-9-]+|v1\/[a-z0-9/-]+|openapi\.json|llms[a-z-]*\.txt|\.well-known\/x402|docs|pricing|crawler|tools|catalog)\b[^\s"']*)/gi)) found.push(m[1]);
  return found;
};
/** The /ref copy's rewording of the public listing's two shortened-example notes. */
const reworded = (v) => {
  if (typeof v === "string") {
    if (v === "full example in /openapi.json") return "example shortened to fit the listing";
    const m = /^<(\d+) characters; the full example is in \/openapi\.json>$/.exec(v);
    return m ? `<${m[1]} characters>` : v;
  }
  if (Array.isArray(v)) return v.map(reworded);
  if (v && typeof v === "object") return Object.fromEntries(Object.entries(v).map(([k, w]) => [k, reworded(w)]));
  return v;
};
const decodeOffer = (r) => { const h = r.headers.get("payment-required"); try { return h ? JSON.parse(Buffer.from(h, "base64").toString("utf8")) : null; } catch { return null; } };

try {
  const log = srv.log();
  const line = /Referral gate enabled for (\d+) route\(s\): ([^\n]*)/.exec(log);
  const served = line ? line[2].split(",").map((s) => s.trim()).filter(Boolean) : [];
  ok(served.length >= 100, `the boot serves a /ref copy of each eligible published slug (${served.length})`);
  const pricing = (await call(`${srv.url}/api/pricing`, { headers: xff() })).json;
  const rows = new Map((pricing?.endpoints || []).filter((r) => r && r.slug).map((r) => [r.slug, r]));
  const hostOf = new URL(srv.url).host;
  const pointers = pointerWalk(hostOf);
  ok(pointers(`see https://agent402.tools/api/pricing, /openapi.json and /docs`, "hash").length === 3 && pointers(`{"url":"https://${hostOf}/ref/hash"}`, "hash").length === 0, "control: the walk finds a pointer home and passes the route's own URL");
  ok(reworded({ a: ["full example in /openapi.json", "<300 characters; the full example is in /openapi.json>"] }).a.join("|") === "example shortened to fit the listing|<300 characters>", "control: the expected rewording of the two shortened-example notes");

  const descFaults = [], bazaarFaults = [], pointed = [], acceptFaults = [];
  const droppedSentences = [];
  let withBazaar = 0, trimmedDesc = 0, largest = { slug: null, bytes: 0 };
  for (const slug of served) {
    const row = rows.get(slug);
    const ref = await call(`${srv.url}/ref/${slug}`, { headers: xff() });
    if (ref.status !== 402 || !ref.json) { descFaults.push(`${slug}: /ref ${ref.status}`); continue; }
    // The description: the catalog's; where it names a direct route, that
    // route reads as its tool's slug, and only a sentence that still points
    // home is left out.
    const want = String(row?.description || "");
    const got = ref.json.resource?.description;
    if (!want) descFaults.push(`${slug}: no catalog description`);
    else if (got !== want) {
      const named = want.split(/\/api\/(?=[a-z0-9])/).join("");
      const sentences = named.split(/(?<=[.!?])\s+(?=[A-Z0-9("'])/);
      const kept = sentences.filter((s) => !pointers(s, slug).length).join(" ");
      if (!(got === kept && pointers(want, slug).length > 0 && got.length > 0)) descFaults.push(`${slug}: ${JSON.stringify(got).slice(0, 80)} vs catalog ${JSON.stringify(want).slice(0, 80)}`);
      else {
        trimmedDesc++;
        const dropped = sentences.filter((s) => pointers(s, slug).length);
        if (dropped.length) droppedSentences.push(`${slug}: ${dropped.join(" | ")}`);
      }
    }
    // The bazaar block: the public route's own 402.
    const routeMethod = /^(GET|POST|PUT|PATCH|DELETE)$/.test(row?.method || "") ? row.method : null;
    const directPath = routeMethod && row?.path ? row.path : `/api/${slug}`;
    const input = ref.json.emptyRequest?.input;
    const verb = routeMethod || "POST";
    const qs = verb === "GET" && input ? `?${new URLSearchParams(Object.entries(input).map(([k, v]) => [k, typeof v === "string" ? v : JSON.stringify(v)]))}` : "";
    const direct = await call(`${srv.url}${directPath}${qs}`, { method: verb, ...(verb === "GET" ? {} : { body: input || {} }), headers: xff() });
    const offer = direct.status === 402 ? decodeOffer(direct) : null;
    const publicBazaar = offer?.extensions?.bazaar;
    const refBazaar = ref.json.extensions?.bazaar;
    if (publicBazaar) {
      withBazaar++;
      if (JSON.stringify(refBazaar) !== JSON.stringify(reworded(publicBazaar))) bazaarFaults.push(`${slug}: ${JSON.stringify(refBazaar ?? null).slice(0, 120)} vs public ${JSON.stringify(publicBazaar).slice(0, 120)}`);
    } else if (direct.status === 402 && refBazaar) bazaarFaults.push(`${slug}: the public route lists no bazaar block, /ref lists one`);
    else if (direct.status !== 402) bazaarFaults.push(`${slug}: public route ${directPath} answered ${direct.status}`);
    // The accept is the gate's own: one exact Base accept to the split contract.
    const a = ref.json.accepts;
    if (!Array.isArray(a) || a.length !== 1 || a[0].scheme !== "exact" || a[0].network !== "eip155:8453" || a[0].payTo !== "0x1111111111111111111111111111111111111111") acceptFaults.push(slug);
    // No pointer home in the body or any header.
    const headerText = [...ref.headers.entries()].map(([k, v]) => `${k}: ${v}`).join("\n");
    const hit = [...pointers(ref.text, slug), ...pointers(headerText, slug)];
    if (hit.length) pointed.push(`${slug}: ${hit.slice(0, 2).join(" ")}`);
    const bytes = Buffer.from(ref.text).toString("base64").length;
    if (bytes > largest.bytes) largest = { slug, bytes };
  }
  for (const d of droppedSentences) console.log(`# sentence left out of the /ref description: ${d}`);
  ok(descFaults.length === 0, `every /ref 402 carries the description the catalog publishes, a direct route named by its slug and only a sentence that still points home left out (${served.length} slugs, ${trimmedDesc} trimmed${descFaults.length ? `: ${descFaults.slice(0, 5).join("; ")}` : ""})`);
  ok(withBazaar >= served.length * 0.9 && bazaarFaults.length === 0, `every /ref 402 carries the public route's extensions.bazaar block (info.input and schema) (${withBazaar} of ${served.length}${bazaarFaults.length ? `: ${bazaarFaults.slice(0, 5).join("; ")}` : ""})`);
  ok(pointed.length === 0, `no /ref 402 body or header points at this server's host, catalog, API paths, spec or docs (${pointed.slice(0, 5).join("; ") || `${served.length} walked`})`);
  ok(acceptFaults.length === 0, `each /ref 402 keeps its one exact Base accept to the split contract (${acceptFaults.slice(0, 5).join(",") || "all"})`);
  console.log(`# largest /ref 402: ${largest.slug} ${largest.bytes} bytes as a base64 header`);
  ok(largest.bytes > 0 && largest.bytes <= MAX_CHALLENGE_BYTES, `the largest /ref 402, measured as a header, fits the ${MAX_CHALLENGE_BYTES}-byte challenge budget (${largest.slug} ${largest.bytes})`);
} finally {
  await srv.stop();
}
if (failed) { console.log(`\n${failed} check(s) failed`); process.exit(1); }
console.log("\nall referral listing parity checks passed");
