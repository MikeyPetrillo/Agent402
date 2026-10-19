// The S3 wire used by the backup and the dataset snapshot, checked on the
// requests it actually sends (fetch is stubbed; nothing leaves the process):
// objectExists LISTS the key and never sends HEAD (a HEAD on a missing key
// answers 403 on a credential without ListBucket); putObject percent-encodes
// the key per segment and signs exactly the path it sends; a Buffer upload
// sends no explicit content-length header.
import { createHash, createHmac } from "node:crypto";

process.env.BACKUP_S3_ENDPOINT = "https://bucket.example.test";
process.env.BACKUP_S3_BUCKET = "snap-bucket";
process.env.BACKUP_S3_KEY_ID = "AKIDTEST";
process.env.BACKUP_S3_SECRET = "secret-for-test";
process.env.BACKUP_S3_REGION = "auto";
process.env.BACKUP_RETRY_MAX = "0";
delete process.env.STATE_DATABASE_URL;

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log(`ok - ${m}`); } else { fail++; console.error(`FAIL - ${m}`); } };

const sent = [];
let listXml = "";
globalThis.fetch = async (url, init = {}) => {
  sent.push({ url: String(url), method: init.method || "GET", headers: { ...(init.headers || {}) } });
  if ((init.method || "GET") === "GET" && /list-type=2/.test(String(url))) return new Response(listXml, { status: 200 });
  if (init.method === "HEAD") return new Response(null, { status: 403 });
  return new Response("", { status: 200 });
};

const { objectExists, putObject } = await import("../src/backup.js");

// Recompute SigV4 over the request as sent and compare.
function verifies(req) {
  const u = req.url.indexOf("?");
  const rawPath = req.url.slice("https://bucket.example.test".length, u < 0 ? undefined : u);
  const query = u < 0 ? "" : req.url.slice(u + 1);
  const auth = req.headers.Authorization || "";
  const m = /Credential=([^/]+)\/(\d{8})\/([^/]+)\/s3\/aws4_request, SignedHeaders=([^,]+), Signature=([0-9a-f]+)/.exec(auth);
  if (!m) return false;
  const [, , date, region, signedHeaders, signature] = m;
  const lower = Object.fromEntries(Object.entries(req.headers).map(([k, v]) => [k.toLowerCase(), String(v).trim()]));
  const names = signedHeaders.split(";");
  const canon = [req.method, rawPath, query, names.map((h) => `${h}:${lower[h]}\n`).join(""), signedHeaders, lower["x-amz-content-sha256"]].join("\n");
  const toSign = ["AWS4-HMAC-SHA256", lower["x-amz-date"], `${date}/${region}/s3/aws4_request`, createHash("sha256").update(canon).digest("hex")].join("\n");
  let k = createHmac("sha256", "AWS4" + process.env.BACKUP_S3_SECRET).update(date).digest();
  for (const part of [region, "s3", "aws4_request"]) k = createHmac("sha256", k).update(part).digest();
  return createHmac("sha256", k).update(toSign).digest("hex") === signature;
}

// objectExists lists, never HEADs.
listXml = "<ListBucketResult><Contents><Key>datasets/v1/dt=2026-09-11/manifest.json</Key><Size>12</Size></Contents></ListBucketResult>";
sent.length = 0;
const yes = await objectExists("datasets/v1/dt=2026-09-11/manifest.json");
ok(yes === true, "a listed key exists");
ok(sent.length >= 1 && sent.every((r) => r.method === "GET" && /list-type=2/.test(r.url)), `objectExists sends only list requests (sent ${sent.map((r) => r.method).join(",")})`);
listXml = "<ListBucketResult></ListBucketResult>";
sent.length = 0;
const no = await objectExists("datasets/v1/dt=2026-09-12/manifest.json");
ok(no === false && !sent.some((r) => r.method === "HEAD"), "a missing key is false, and no HEAD is sent");

// putObject: per-segment encoding, signature over the sent path, no content-length.
sent.length = 0;
await putObject("datasets/v1/dt=2026-09-11/sellers.csv.gz", Buffer.from("abc"));
const put = sent[0] || { url: "", headers: {} };
ok(put.method === "PUT", "putObject sends a PUT");
ok(put.url.includes("/snap-bucket/datasets/v1/dt%3D2026-09-11/sellers.csv.gz"), `the "=" in the partition is percent-encoded in the sent path (${put.url})`);
ok(verifies(put), "the signature verifies over the exact path that was sent");
ok(!Object.keys(put.headers).some((h) => h.toLowerCase() === "content-length"), "a Buffer upload sends no explicit content-length");

console.log(`\n${fail ? "FAILED" : "OK"}: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
