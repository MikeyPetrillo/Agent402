#!/usr/bin/env node
// Every published example that fetches something fetches it from us.
//
// 2026-10-07: seo-audit failed CI because a third-party page answered the
// runner 403, and an inventory found ~60 published examples pointing at other
// people's sites (a paper on arxiv, an OCR sample, an EXIF sample on a code
// host, a feed reader, a public OpenAPI demo). Each one could break our build,
// and every buyer copying the example depended on someone else's uptime. They
// now point at agent402.tools pages or at /fixtures/ files we generate
// (scripts/build-fixtures.js).
//
// This guard reads every example in /openapi.json (tools and skill packs) and
// fails on a host that is not ours and not on the list below with a reason.
// A new example that needs a file belongs in build-fixtures.js, not on someone
// else's site. It also checks that every /fixtures/ file an example names is
// served and exists, so an example cannot point at a fixture that 404s.
//
//   TARGET_URL=http://127.0.0.1:3000 node scripts/test-example-hosts.js
import { existsSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const TARGET = (process.env.TARGET_URL || "http://127.0.0.1:3000").replace(/\/+$/, "");

const OURS = new Set(["agent402.tools", "www.agent402.tools"]);

// Hosts an example may name although they are not ours. Each is either never
// fetched (a reserved example name, a string inside text, a DNS or WHOIS
// subject) or fetched by a step whose failure is not a page we depend on.
const ALLOWED = {
  "example.com": "reserved example name (RFC 2606): DNS, TLS and WHOIS subjects, a card or URL inside an input, the archive lookup subject, and tech-stack (our own home page declares no detectable stack, so the example would be empty)",
  "api.example.com": "reserved example name inside an OpenAPI document passed inline, never fetched",
  "ex.com": "a string url-parse splits, never fetched",
  "x.com": "a name inside text for entity extraction, never fetched",
  "google.com": "DNS and mail-record subject (SPF, DMARC, DKIM, propagation), never fetched over HTTP",
  "stripe.com": "mail-record subject of email-security, DNS only",
  "apple.com": "entity-enrich subject resolved through registries, never fetched",
};

// Examples still on another site until the fixture that replaces them is on
// production (an example cannot point at a file prod does not serve yet: CI
// fetches it from prod). Bound to the exact routes, so the list cannot grow;
// each entry is removed in the batch after its fixture deploys.
const PENDING = {
  "bitcoin.org": { fixture: "sample-report.pdf", routes: ["POST /api/pdf-summarize", "POST /api/skill/document-brief"] },
  "petstore3.swagger.io": { fixture: "sample-openapi.json", routes: ["POST /api/skill/openapi-audit"] },
  "raw.githubusercontent.com": { fixture: "sample-photo.jpg", routes: ["POST /api/image-exif", "POST /api/image-dominant-color", "POST /api/image-crop"] },
  "tesseract.projectnaptha.com": { fixture: "sample-text.png", routes: ["POST /api/image-ocr"] },
  "upload.wikimedia.org": { fixture: null, routes: ["POST /api/transcribe", "POST /api/transcribe-pro", "POST /api/skill/subtitle-pipeline"] },
};

// Bare domains count when they look like a site (a common TLD), so a JWT, an
// ENS name or a series id is not read as a host.
const BARE = /^[a-z0-9-]+(\.[a-z0-9-]+)*\.(com|org|net|io|dev|app|co|ai|tools|xyz)$/i;

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log(`ok - ${m}`); } else { fail++; console.log(`FAIL - ${m}`); } };

const spec = await (await fetch(`${TARGET}/openapi.json`)).json();
const uses = new Map(); // host -> Set(route)
const fixtures = new Map(); // file -> Set(route)
const walk = (v, cb) => { if (typeof v === "string") cb(v); else if (v && typeof v === "object") for (const x of Object.values(v)) walk(x, cb); };
let examples = 0;
for (const [path, ops] of Object.entries(spec.paths || {})) {
  for (const [method, op] of Object.entries(ops)) {
    if (!op || typeof op !== "object") continue;
    const ex = [op.requestBody?.content?.["application/json"]?.example, (op.parameters || []).map((p) => p.example)];
    const route = `${method.toUpperCase()} ${path}`;
    examples++;
    walk(ex, (s) => {
      const add = (h) => { h = h.toLowerCase(); if (!uses.has(h)) uses.set(h, new Set()); uses.get(h).add(route); };
      for (const m of s.matchAll(/https?:\/\/([a-z0-9.-]+)(\/[^\s"'<>)]*)?/gi)) {
        add(m[1]);
        const f = OURS.has(m[1].toLowerCase()) && /^\/fixtures\/([^/?#]+)/.exec(m[2] || "");
        if (f) { if (!fixtures.has(f[1])) fixtures.set(f[1], new Set()); fixtures.get(f[1]).add(route); }
      }
      if (BARE.test(s.trim())) add(s.trim());
    });
  }
}
ok(examples > 400, `read ${examples} published examples from ${TARGET}/openapi.json`);

for (const [host, routes] of [...uses].sort()) {
  if (OURS.has(host) || ALLOWED[host]) continue;
  const p = PENDING[host];
  if (!p) {
    ok(false, `${host} is named by ${[...routes].join(", ")}: point the example at agent402.tools or a fixture (scripts/build-fixtures.js), or, if the host is never fetched, add it to ALLOWED with the reason`);
    continue;
  }
  const extra = [...routes].filter((r) => !p.routes.includes(r));
  ok(!extra.length, `${host} is pending (${p.fixture || "no fixture yet"}) and gained no new route${extra.length ? `: ${extra.join(", ")}` : ""}`);
}
// A pending entry no example uses any more is done: delete it.
for (const host of Object.keys(PENDING)) ok(uses.has(host), `PENDING ${host} is still in use (remove the entry once its examples move)`);

// Every fixture an example names is served and on disk.
const server = readFileSync(join(ROOT, "src", "server.js"), "utf8");
const served = /const FIXTURE_FILES = \{([\s\S]*?)\};/.exec(server)?.[1] || "";
for (const [file, routes] of [...fixtures].sort()) {
  ok(served.includes(`"${file}"`) && existsSync(join(ROOT, "assets", "fixtures", file)),
    `fixture ${file} (${routes.size} example(s)) is in FIXTURE_FILES and assets/fixtures`);
}
for (const p of Object.values(PENDING)) {
  if (p.fixture) ok(served.includes(`"${p.fixture}"`) && existsSync(join(ROOT, "assets", "fixtures", p.fixture)), `pending fixture ${p.fixture} is built and served, ready for the next batch`);
}
// Control: the scan finds fixture URLs at all, so an empty map is not a pass.
ok(fixtures.size >= 3, `the scan found ${fixtures.size} fixture files named by examples`);

console.log(`\n${fail ? "FAILED" : "OK"}: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
