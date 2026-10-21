#!/usr/bin/env node
// Distrusted intermediate CA refusal (src/tls-distrust.js and its copies in
// client/, mcp/networks.js and facilitator/index.js). Offline: every TLS
// server is local, on port 0.
//
//   (c) the published certificates' SPKI and certificate sha256 values match
//       the list, computed here from the PEMs, and every copy holds the same
//       list; a chain object built from a published PEM is refused with an
//       error that carries no certificate bytes.
//   (a) a throwaway CA -> intermediate -> leaf chain (made with openssl) is
//       accepted, through global fetch, https.get, the undici dispatcher the
//       server installs, and each package's own dispatcher;
//   (b) the same chain is refused once the test intermediate's SPKI is
//       injected into the list, through the same paths, while the packages'
//       refusal leaves the rest of the process alone.
//
// The TLS legs run in child processes started with NODE_EXTRA_CA_CERTS
// pointing at the throwaway root, so the real default trust path is used.
//
//   node scripts/test-tls-distrust.js
import { readFileSync, mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { execFileSync, spawnSync } from "node:child_process";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { X509Certificate, createHash } from "node:crypto";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SELF = fileURLToPath(import.meta.url);
let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log(`ok - ${m}`); } else { fail++; console.log(`FAIL - ${m}`); } };
const CODE = "ERR_TLS_DISTRUSTED_INTERMEDIATE";

// ---------------------------------------------------------------------------
// Child legs. argv: --child <mode> <dir>
async function child(mode, dir) {
  const https = (await import("node:https")).default;
  const tls = (await import("node:tls")).default;
  const results = [];
  const rec = (name, outcome) => results.push({ name, ...outcome });
  const key = readFileSync(join(dir, "leaf.key"));
  const cert = readFileSync(join(dir, "leaf.pem"), "utf8") + readFileSync(join(dir, "int.pem"), "utf8");
  const intSpki = createHash("sha256").update(new X509Certificate(readFileSync(join(dir, "int.pem"))).publicKey.export({ type: "spki", format: "der" })).digest("hex");
  // A fresh server per attempt: new ticket keys, so no TLS session resumes
  // across attempts (a resumed session skips checkServerIdentity), and
  // Connection: close so no pooled socket is reused.
  const servers = [];
  const serve = async () => {
    const s = https.createServer({ key, cert }, (q, r) => { r.setHeader("Connection", "close"); r.end("ok"); });
    await new Promise((r) => s.listen(0, "127.0.0.1", r));
    servers.push(s);
    return `https://localhost:${s.address().port}/`;
  };
  const outcome = async (fn) => {
    try { const body = await fn(); return { connected: body === "ok" }; }
    catch (e) {
      const err = e?.cause && e.cause.code ? e.cause : e;
      return { connected: false, code: err?.code || null, message: String(err?.message || e) };
    }
  };
  const viaFetch = (url, init) => async () => (await fetch(url, init)).text();
  const viaHttpsGet = (url) => () => new Promise((res, rej) => {
    https.get(url, (r) => { let b = ""; r.setEncoding("utf8"); r.on("data", (d) => (b += d)); r.on("end", () => res(b)); }).on("error", rej);
  });

  if (mode === "global") {
    const { installTlsDistrust, addDistrustedSpkiForTests, withDistrust, tlsDistrustInstalled } = await import(join(ROOT, "src/tls-distrust.js"));
    const { setGlobalDispatcher, Agent, fetch: undiciFetch } = await import("undici");
    installTlsDistrust();
    // The dispatcher src/server.js installs.
    setGlobalDispatcher(new Agent({ connect: withDistrust({ family: 4 }) }));
    const paths = {
      "global fetch": (u) => viaFetch(u),
      "https.get": (u) => viaHttpsGet(u),
      "undici fetch (package)": (u) => async () => (await undiciFetch(u)).text(),
      "undici Agent without explicit option": (u) => viaFetch(u, { dispatcher: new Agent() }),
      "tls.connect": (u) => () => new Promise((res, rej) => {
        const s = tls.connect({ host: "localhost", port: Number(new URL(u).port) }, () => { s.end(); res("ok"); });
        s.on("error", rej);
      }),
    };
    rec("installed", { connected: tlsDistrustInstalled() });
    for (const [n, f] of Object.entries(paths)) rec(`before:${n}`, await outcome(f(await serve())));
    addDistrustedSpkiForTests(intSpki);
    for (const [n, f] of Object.entries(paths)) rec(`after:${n}`, await outcome(f(await serve())));
    // rejectUnauthorized: false (the certificate inspection tool) is marked,
    // not refused.
    const u = await serve();
    rec("after:rejectUnauthorized false", await outcome(() => new Promise((res, rej) => {
      const s = tls.connect({ host: "localhost", port: Number(new URL(u).port), rejectUnauthorized: false }, () => {
        const marked = s.authorized === false && s.authorizationError === CODE;
        s.end(); res(marked ? "ok" : `authorized=${s.authorized} ${s.authorizationError}`);
      });
      s.on("error", rej);
    })));
  } else if (mode === "packages") {
    const client = await import(join(ROOT, "client/tls-distrust.js"));
    const clientIndex = await import(join(ROOT, "client/index.js"));
    const mcp = await import(join(ROOT, "mcp/networks.js"));
    const { wrapFetchWithPayment } = await import("@x402/fetch");
    const { x402Client } = await import("@x402/core/client");
    for (const [pkg, m] of [["client", client], ["mcp", mcp]]) {
      rec(`${pkg} before:dispatcher present`, { connected: (await m.distrustDispatcher()) !== null });
      const plain = m.distrustFetch();
      rec(`${pkg} before:distrustFetch`, await outcome(async () => (await plain(await serve())).text()));
      const refusing = m.distrustFetch(undefined, { extraSpki: [intSpki] });
      rec(`${pkg} after:distrustFetch`, await outcome(async () => (await refusing(await serve())).text()));
      // Through a payment wrapper, which rebuilds the request as a Request
      // object: the base fetch still adds the dispatcher.
      const paying = wrapFetchWithPayment(m.distrustFetch(undefined, { extraSpki: [intSpki] }), new x402Client());
      rec(`${pkg} after:x402 wrapper base`, await outcome(async () => (await paying(await serve())).text()));
      // Nothing global changed: the plain process fetch still connects.
      rec(`${pkg} scoped:global fetch untouched`, await outcome(viaFetch(await serve())));
    }
    rec("client index re-exports distrustFetch", { connected: clientIndex.distrustFetch === client.distrustFetch });
    // The SDK's default fetch goes through distrustFetch: a client built with
    // no fetchImpl hands the platform fetch a dedicated dispatcher.
    const platformFetch = globalThis.fetch;
    let handed = null;
    globalThis.fetch = (u, i) => { handed = i?.dispatcher ?? null; return platformFetch(u, i); };
    const sdk = new clientIndex.Agent402({ baseUrl: (await serve()).replace(/\/$/, "") });
    const opted = new clientIndex.Agent402({ baseUrl: sdk.baseUrl, tlsDistrust: false });
    rec("client default fetch connects", await outcome(async () => (await sdk.f(`${sdk.baseUrl}/`)).text()));
    rec("client default fetch carries a dedicated dispatcher", { connected: !!handed && typeof handed.dispatch === "function" });
    handed = "unset";
    await opted.f(`${await serve()}`).then((r) => r.text()).catch(() => {});
    rec("client tlsDistrust false sends the fetch as is", { connected: handed === null });
    globalThis.fetch = platformFetch;
  }
  for (const s of servers) s.close();
  process.stdout.write(JSON.stringify(results));
}

if (process.argv[2] === "--child") {
  await child(process.argv[3], process.argv[4]);
  process.exit(0);
}

// ---------------------------------------------------------------------------
// (c) Published certificates against the list, and the copies against it.
const { DISTRUSTED_INTERMEDIATES, spkiSha256OfCertificate, checkServerIdentity, peerChain } = await import(join(ROOT, "src/tls-distrust.js"));
const fixture = JSON.parse(readFileSync(join(ROOT, "scripts/fixtures/tls-distrust-intermediates.json"), "utf8"));
ok(fixture.certificates.length === 16, `fixture holds 16 published certificates (got ${fixture.certificates.length})`);
ok(DISTRUSTED_INTERMEDIATES.length === 8, `list holds 8 intermediate keys (got ${DISTRUSTED_INTERMEDIATES.length})`);
ok(Object.isFrozen(DISTRUSTED_INTERMEDIATES) && DISTRUSTED_INTERMEDIATES.every((e) => Object.isFrozen(e) && Object.isFrozen(e.certSha256)), "list and entries are frozen");
const listedCerts = new Set(DISTRUSTED_INTERMEDIATES.flatMap((e) => e.certSha256));
const seenCerts = new Set();
for (const c of fixture.certificates) {
  const x = new X509Certificate(c.pem);
  const spki = spkiSha256OfCertificate(c.pem);
  const certSha = x.fingerprint256.replace(/:/g, "").toLowerCase();
  ok(spki === c.spki_sha256, `${c.name} (issued by ${c.issuer.split(",")[0].slice(3)}): computed SPKI sha256 matches the published value`);
  ok(certSha === c.sha256, `${c.name}: computed certificate sha256 matches the published value`);
  const e = DISTRUSTED_INTERMEDIATES.find((d) => d.spkiSha256 === spki);
  ok(e && e.name === c.name && e.certSha256.includes(certSha), `${c.name}: listed under its SPKI with this certificate's hash`);
  seenCerts.add(certSha);
}
ok([...listedCerts].every((h) => seenCerts.has(h)) && listedCerts.size === 16, "every listed certificate hash is one of the published certificates");

// The SPKI computation for a live peer certificate (from its raw DER) equals
// the one for the PEM: shown on a chain object built from a published PEM.
const pub = fixture.certificates[0];
const intX = new X509Certificate(pub.pem);
const leafLike = { raw: Buffer.from("not a certificate"), fingerprint256: "00", subject: { CN: "example.test" } };
const root = { raw: null, fingerprint256: "" };
root.issuerCertificate = root;
const fakeChain = { ...leafLike, raw: intX.raw, fingerprint256: "", issuerCertificate: root };
ok(peerChain(fakeChain).length === 2, "peerChain stops at a self-issued certificate");
const refused = checkServerIdentity("example.test", fakeChain);
ok(refused instanceof Error && refused.code === CODE && /distrusted intermediate/.test(refused.message), `a chain carrying ${pub.name} is refused with the reason (${refused?.message})`);
const b64 = pub.pem.split("\n")[1];
ok(!/BEGIN CERTIFICATE/.test(refused.message) && !refused.message.includes(b64.slice(0, 24)) && !JSON.stringify(refused).includes(b64.slice(0, 24)), "the refusal carries no certificate bytes");
const unreadable = checkServerIdentity("example.test", { raw: Buffer.from("junk"), fingerprint256: "", issuerCertificate: null });
ok(unreadable instanceof Error && unreadable.code === CODE, "an unreadable chain certificate is refused, not passed");

// Every copy holds the same list.
const canonical = new Map(DISTRUSTED_INTERMEDIATES.map((e) => [e.spkiSha256, e.name]));
const sameMap = (m) => m.size === canonical.size && [...canonical].every(([k, v]) => m.get(k) === v);
const clientMod = await import(join(ROOT, "client/tls-distrust.js"));
const mcpMod = await import(join(ROOT, "mcp/networks.js"));
ok(sameMap(new Map(Object.entries(clientMod.DISTRUSTED_SPKI_SHA256))), "client/tls-distrust.js holds the same list");
ok(sameMap(new Map(Object.entries(mcpMod.DISTRUSTED_SPKI_SHA256))), "mcp/networks.js holds the same list");
ok(Object.isFrozen(clientMod.DISTRUSTED_SPKI_SHA256) && Object.isFrozen(mcpMod.DISTRUSTED_SPKI_SHA256), "package lists are frozen");
const facSrc = readFileSync(join(ROOT, "facilitator/index.js"), "utf8");
const facMap = new Map([...facSrc.matchAll(/\["([0-9a-f]{64})", "([^"]+)"\]/g)].map((m) => [m[1], m[2]]));
ok(sameMap(facMap), `facilitator/index.js holds the same list (${facMap.size} entries)`);
ok(/^tls\.checkServerIdentity = distrustCheckServerIdentity;$/m.test(facSrc) && /^https\.globalAgent\.options\.checkServerIdentity = distrustCheckServerIdentity;$/m.test(facSrc), "facilitator installs the refusal process-wide");
// The client and mcp copies are the same code (mcp's lives in networks.js).
const clientSrc = readFileSync(join(ROOT, "client/tls-distrust.js"), "utf8");
const mcpSrc = readFileSync(join(ROOT, "mcp/networks.js"), "utf8");
const tail = clientSrc.slice(clientSrc.indexOf("export const DISTRUSTED_SPKI_SHA256"));
ok(mcpSrc.endsWith(tail), "mcp/networks.js carries client/tls-distrust.js's code verbatim");

// Entry points that install it process-wide.
for (const [f, spec] of [["src/server.js", "./tls-distrust-boot.js"], ["worker/server.js", "../src/tls-distrust-boot.js"], ["src/router-worker-thread.js", "./tls-distrust-boot.js"],
  ["scripts/paid-canary.js", "../src/tls-distrust-boot.js"], ["scripts/bazaar-validate.js", "../src/tls-distrust-boot.js"], ["scripts/facilitator-mainnet-canary.js", "../src/tls-distrust-boot.js"],
  ["scripts/algorand-rail-canary.js", "../src/tls-distrust-boot.js"], ["scripts/tempo-canary-verify.js", "../src/tls-distrust-boot.js"], ["scripts/tempo-subscription-canary.js", "../src/tls-distrust-boot.js"],
  ["scripts/stripe-link-canary.mjs", "../src/tls-distrust-boot.js"], ["scripts/backfill-status-history.js", "../src/tls-distrust-boot.js"]]) {
  ok(readFileSync(join(ROOT, f), "utf8").includes(`import "${spec}";`), `${f} installs the refusal at boot`);
}
const serverSrc = readFileSync(join(ROOT, "src/server.js"), "utf8");
ok(/setGlobalDispatcher\(new UndiciAgent\(\{ connect: withDistrust\(\{ family: 4 \}\) \}\)\)/.test(serverSrc), "src/server.js's global dispatcher keeps family 4 and adds the refusal");
for (const f of ["src/x402-buyer.js", "src/tempo-buyer.js"]) ok(/new UndiciAgent\(\{ connect: withDistrust\(\) \}\)/.test(readFileSync(join(ROOT, f), "utf8")), `${f}'s trusted dispatcher carries the refusal`);
ok(/buildConnector\(\{ lookup: guardedLookup, timeout: FETCH_TIMEOUT_MS, checkServerIdentity \}\)/.test(readFileSync(join(ROOT, "src/tools/fetch-guard.js"), "utf8")), "the SSRF dispatcher's connector carries the refusal");
// Deliberate exceptions stay as they were.
ok(/rejectUnauthorized: false/.test(readFileSync(join(ROOT, "src/tools/kit.js"), "utf8")), "src/tools/kit.js keeps its rejectUnauthorized: false (certificate inspection)");
ok(/railway\.internal"\)\) return \{ rejectUnauthorized: false \}/.test(readFileSync(join(ROOT, "src/db-ssl.js"), "utf8")), "src/db-ssl.js keeps the private-mesh setting");
ok(/REMOVAL:/.test(readFileSync(join(ROOT, "src/tls-distrust.js"), "utf8")), "src/tls-distrust.js carries its removal note");

// ---------------------------------------------------------------------------
// (a)/(b) Live TLS through a throwaway chain.
const dir = mkdtempSync(join(tmpdir(), "tls-distrust-"));
try {
  const ssl = (...args) => execFileSync("openssl", args, { cwd: dir, stdio: ["ignore", "pipe", "pipe"] });
  writeFileSync(join(dir, "int.ext"), "basicConstraints=critical,CA:TRUE,pathlen:0\nkeyUsage=critical,keyCertSign,cRLSign\n");
  writeFileSync(join(dir, "leaf.ext"), "basicConstraints=CA:FALSE\nsubjectAltName=DNS:localhost,IP:127.0.0.1\nextendedKeyUsage=serverAuth\n");
  ssl("ecparam", "-name", "prime256v1", "-genkey", "-noout", "-out", "ca.key");
  ssl("req", "-x509", "-new", "-key", "ca.key", "-subj", "/CN=TLS Distrust Test Root", "-days", "2", "-out", "ca.pem",
    "-addext", "basicConstraints=critical,CA:TRUE", "-addext", "keyUsage=critical,keyCertSign,cRLSign");
  ssl("ecparam", "-name", "prime256v1", "-genkey", "-noout", "-out", "int.key");
  ssl("req", "-new", "-key", "int.key", "-subj", "/CN=TLS Distrust Test Intermediate", "-out", "int.csr");
  ssl("x509", "-req", "-in", "int.csr", "-CA", "ca.pem", "-CAkey", "ca.key", "-CAcreateserial", "-days", "2", "-extfile", "int.ext", "-out", "int.pem");
  ssl("ecparam", "-name", "prime256v1", "-genkey", "-noout", "-out", "leaf.key");
  ssl("req", "-new", "-key", "leaf.key", "-subj", "/CN=localhost", "-out", "leaf.csr");
  ssl("x509", "-req", "-in", "leaf.csr", "-CA", "int.pem", "-CAkey", "int.key", "-CAcreateserial", "-days", "2", "-extfile", "leaf.ext", "-out", "leaf.pem");
  ok(true, "generated a throwaway root -> intermediate -> leaf chain");

  const run = (mode) => {
    const r = spawnSync(process.execPath, [SELF, "--child", mode, dir], {
      cwd: ROOT, encoding: "utf8", timeout: 60_000,
      env: { ...process.env, NODE_EXTRA_CA_CERTS: join(dir, "ca.pem") },
    });
    if (r.status !== 0) { console.log(r.stderr); return []; }
    try { return JSON.parse(r.stdout.slice(r.stdout.indexOf("[{"))); } catch { console.log(r.stdout, r.stderr); return []; }
  };
  const check = (rows, expect) => {
    ok(rows.length > 0, `child returned ${rows.length} results`);
    for (const row of rows) {
      const want = expect(row.name);
      if (want === "connect") ok(row.connected === true, `${row.name}: connects${row.connected ? "" : ` (${row.code} ${row.message})`}`);
      else ok(row.connected === false && row.code === CODE && /distrusted intermediate/.test(row.message) && !/BEGIN CERTIFICATE/.test(row.message), `${row.name}: refused with "distrusted intermediate"${row.connected ? " (CONNECTED)" : ` (${row.code})`}`);
    }
  };
  check(run("global"), (n) => (n.startsWith("after:") && n !== "after:rejectUnauthorized false" ? "refuse" : "connect"));
  check(run("packages"), (n) => (n.includes(" after:") ? "refuse" : "connect"));
} catch (e) {
  ok(false, `throwaway chain legs: ${e.message}`);
} finally {
  rmSync(dir, { recursive: true, force: true });
}

console.log(`\n${fail ? "FAILED" : "OK"}: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
