// Refuse TLS chains that pass through a distrusted intermediate CA.
//
// The private keys of the intermediate CAs below are recoverable (Mozilla bug
// 2083449). Each is issued by an emSign G3 root and cross-issued by AAA
// Certificate Services. Neither root is in Node's bundled store, but a
// cross-signed emSign Root TLS CA - G3 chains to "emSign ECC Root CA - G3",
// which is, so a leaf signed with one of these keys validates in Node today,
// and Node checks no revocation by default. Anyone holding a key could mint a
// certificate for any host (a facilitator, an RPC, a seller whose 402 names a
// payTo) that Node would accept.
//
// The check is keyed on the SubjectPublicKeyInfo hash: the compromised thing
// is the key, so every certificate that carries it (both issuances listed,
// and any reissue) is refused. The certificate hashes are kept for reference
// and are refused too.
//
// installTlsDistrust() makes the refusal process-wide. Node's TLS client reads
// tls.checkServerIdentity at connect time for every connection that does not
// pass its own, which covers node:https, node:http2, global fetch (Node's
// bundled undici), the undici package, pg, redis and ws. The undici
// dispatchers we build pass the wrapper explicitly as well
// (`connect: { checkServerIdentity }`), and https.globalAgent carries it in its
// options. A connection made with rejectUnauthorized: false is still not
// refused (Node only marks it unauthorized), which keeps the certificate
// inspection tool in src/tools/kit.js and the private-mesh Postgres setting in
// src/db-ssl.js exactly as they were.
//
// REMOVAL: this list can be dropped once the pinned Node base image (the
// deploy Dockerfiles pin node:22-slim by digest) ships a CA store that no
// longer builds this path (no cross-signed emSign Root TLS CA - G3 under
// emSign ECC Root CA - G3, or an explicit distrust of these intermediates).
// Until then it stays.
import tls from "node:tls";
import https from "node:https";
import { createHash, X509Certificate } from "node:crypto";

const entry = (name, spkiSha256, certSha256) =>
  Object.freeze({ name, spkiSha256, certSha256: Object.freeze(certSha256) });

export const DISTRUSTED_INTERMEDIATES = Object.freeze([
  entry("EM DV TLS CA - G3B", "ebed6475c2c2d80fcb199f3fe8dd6e6b3ce60b77eb15d4e42c3dec0c6f5b5105", [
    "42c4accd12c4f59597925e1a08a7a90102608543809308d50ec427e118ba1493", // issued by emSign Root TLS CA - G3
    "45a883f349aedfd5f3a649b5498ffb121712ba8b448f3f2a91dbc5a766fcddbe", // issued by AAA Certificate Services
  ]),
  entry("EM OV TLS CA - G3B", "43bffa19d6ef651451f6841e019931e96f6f2eaeff28ab4b6f1ce4576de2717b", [
    "98b896625c0c230adeec3eb2cf6aad5001ecf9156a68644e82374ce5833bc25b", // issued by emSign Root TLS CA - G3
    "5f1ded4dd590af74631290cf073b122a2aac6a1fa479778a0bd43579bd832699", // issued by AAA Certificate Services
  ]),
  entry("EM EV TLS CA - G3B", "e0254c7fcdc265e2f0f8a428dabb75ab4ae039b4872d62f5ee57f0877d5a8a41", [
    "e7568fe6e12331f4fd7de61da4c7559d0f8eb192a218d4741a3ba75184333838", // issued by emSign Root TLS CA - G3
    "579480aea166290bd3c643589e795fc0d0e54e86505d180f1dff99efd3199512", // issued by AAA Certificate Services
  ]),
  entry("EM DV TLS CA - G3C", "49dd353dc2b919a3770645117d0e60c16115e7d1bc259eefe734b00ea434fe5f", [
    "0164d7ceae5bb909c272af151ff44b1177ae9b47d9424b94f1d9558c30934d19", // issued by emSign Root TLS CA - G3
    "62b7f9868263f72f6911fc78ceaf72c1979158b7368bf648683bb2aa39b02e72", // issued by AAA Certificate Services
  ]),
  entry("EM OV TLS CA - G3C", "63ecefee431d49523bc1136c4e72d0206a477086caf606cd5cf025686c109cf8", [
    "cb6e15165ac802e9b3f993f16c25d41f4e81c21ebde71ae1b012ac00bf9c7c3f", // issued by emSign Root TLS CA - G3
    "7485b51c0ed192878fa1d2f948fb529ae1842cc5086c4b67f7be5b2039de9489", // issued by AAA Certificate Services
  ]),
  entry("EM EV TLS CA - G3C", "5c0660a2b164910d8ff589c18e14552e9e0ec237dcefe2cb736d41a4811f81a0", [
    "432ec25f0d28de9006d97bf752f17bbb2cd41f669933fcb072d9a1148d0261f3", // issued by emSign Root TLS CA - G3
    "fd9d5c2dbbd4995ab69b8d50c439d9527b00529199c2fd01b2174eb58f07021f", // issued by AAA Certificate Services
  ]),
  entry("EM OV CS CA - G3B", "ec4ffa1ad0ac88081314b7aaffef6a91f97cd57291bb5ba686c5415f5eb4f6b6", [
    "9e39de2881273acc225a149c72ba3e0f51424963669ab633ee1dc7df5db067b4", // issued by emSign Root CS CA - G3
    "a496e23ac0cab8155fc9b117b97eae368efcbb9041aec8804d5a308d2d01c2d8", // issued by AAA Certificate Services
  ]),
  entry("EM OV CS CA - G3C", "92c063d67e8f14db71d288e11266ffdaf69cbf115f7bab14f3bc2f68d25e0e30", [
    "4b2460a466f95fd40113bcdcca2ceb29b3b093921de45474da7df48874c630b1", // issued by emSign Root CS CA - G3
    "84112972b8e59d14560ae7e7119654474aad119990cf3722bfc1e3b91615e1fd", // issued by AAA Certificate Services
  ]),
]);

export const DISTRUSTED_ERROR_CODE = "ERR_TLS_DISTRUSTED_INTERMEDIATE";

const bySpki = new Map(DISTRUSTED_INTERMEDIATES.map((e) => [e.spkiSha256, e.name]));
const byCert = new Map(DISTRUSTED_INTERMEDIATES.flatMap((e) => e.certSha256.map((h) => [h, e.name])));

/** Test-only injection point: refuse one more SPKI hash (hex). It can only
 *  add a refusal, never remove one. */
export function addDistrustedSpkiForTests(spkiSha256Hex, name = "test entry") {
  bySpki.set(String(spkiSha256Hex).toLowerCase(), name);
}

/** sha256 (lowercase hex) of a DER SubjectPublicKeyInfo. */
export function spkiSha256OfDer(spkiDer) {
  return createHash("sha256").update(spkiDer).digest("hex");
}

/** sha256 of the SPKI of a certificate given as PEM, DER or X509Certificate. */
export function spkiSha256OfCertificate(certificate) {
  const x = certificate instanceof X509Certificate ? certificate : new X509Certificate(certificate);
  return spkiSha256OfDer(x.publicKey.export({ type: "spki", format: "der" }));
}

// A peer certificate's `pubkey` is the raw key for EC (the point, not the
// SPKI), so the SPKI is taken from `raw` (the certificate DER). A chain
// repeats its CA certificates across connections, so the hash is cached by
// the certificate's own fingerprint, bounded.
const spkiCache = new Map();
const SPKI_CACHE_MAX = 1024;
function peerSpkiSha256(cert) {
  const key = cert.fingerprint256 || null;
  if (key && spkiCache.has(key)) return spkiCache.get(key);
  const h = spkiSha256OfCertificate(cert.raw);
  if (key) {
    if (spkiCache.size >= SPKI_CACHE_MAX) spkiCache.clear();
    spkiCache.set(key, h);
  }
  return h;
}

const certHashOf = (cert) => String(cert.fingerprint256 || "").replace(/:/g, "").toLowerCase();

/** Walk a detailed peer certificate (tls getPeerCertificate(true) shape) up
 *  its issuerCertificate links until a self-issued certificate. */
export function peerChain(cert, max = 16) {
  const out = [];
  let c = cert;
  while (c && typeof c === "object" && !out.includes(c) && out.length < max) {
    out.push(c);
    const next = c.issuerCertificate;
    if (!next || next === c) break;
    c = next;
  }
  return out;
}

/** The distrusted CA a presented chain passes through, or null. Throws when a
 *  certificate in the chain cannot be read (the caller refuses on that). */
export function distrustedInChain(cert) {
  for (const c of peerChain(cert)) {
    const byFingerprint = byCert.get(certHashOf(c));
    if (byFingerprint) return byFingerprint;
    if (!c.raw) continue;
    const name = bySpki.get(peerSpkiSha256(c));
    if (name) return name;
  }
  return null;
}

function refusal(host, reason) {
  const e = new Error(`Refusing the TLS certificate for ${host}: ${reason}`);
  e.code = DISTRUSTED_ERROR_CODE;
  e.reason = "distrusted intermediate";
  e.host = host;
  return e;
}

// Node's own hostname check, captured before installTlsDistrust() replaces the
// module export, so the wrapper never calls itself.
const nodeCheckServerIdentity = tls.checkServerIdentity;

/** Drop-in checkServerIdentity: refuses a chain through a distrusted
 *  intermediate, else defers to Node's hostname check. Returns an Error (never
 *  carrying certificate bytes) or undefined. */
export function checkServerIdentity(host, cert) {
  let name;
  try {
    name = distrustedInChain(cert);
  } catch {
    return refusal(host, "distrusted intermediate check could not read the certificate chain");
  }
  if (name) return refusal(host, `distrusted intermediate (${name}) in the certificate chain`);
  return nodeCheckServerIdentity(host, cert);
}

/** undici `connect` options with the refusal added to whatever the caller
 *  already sets (family, lookup, timeout ...). */
export function withDistrust(connect = {}) {
  return { ...connect, checkServerIdentity };
}

let installed = false;
/** Make the refusal process-wide (idempotent). */
export function installTlsDistrust() {
  if (installed) return;
  installed = true;
  tls.checkServerIdentity = checkServerIdentity;
  https.globalAgent.options.checkServerIdentity = checkServerIdentity;
}

export function tlsDistrustInstalled() {
  return installed && tls.checkServerIdentity === checkServerIdentity;
}
