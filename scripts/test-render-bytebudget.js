// Renderer actual-byte budget (audit F03). The old accounting trusted
// Content-Length, so a chunked / streamed / no-Content-Length response (or a
// WebSocket) contributed zero bytes and bypassed the 25 MB per-resource / 50 MB
// per-page caps. The fix feeds ACTUAL transferred bytes (CDP
// Network.dataReceived.encodedDataLength + WebSocket frames) into makeByteBudget,
// which trips exactly once when either cap is crossed. This unit-tests that
// budget logic directly — the SSRF guard blocks a localhost test origin, so a
// full real-Chromium RSS test belongs with the browser worker (F02).
//
//   node scripts/test-render-bytebudget.js
import "./lib/offline-stores.js"; // per-process and file backends whatever the caller exports (see the file)
import { makeByteBudget } from "../src/tools/render.js";

let pass = 0, fail = 0;
const ok = (c, m) => { c ? pass++ : fail++; console.log(`${c ? "ok" : "FAIL"} - ${m}`); };

const PER = 25 * 1024 * 1024;
const PAGE = 50 * 1024 * 1024;

// 1. Chunked/no-Content-Length: many small frames across ONE request that sum
//    past the page cap. Content-Length would have reported 0; actual bytes trip.
{
  let trips = 0;
  const b = makeByteBudget(PER, PAGE, () => { trips++; });
  const CHUNK = 64 * 1024; // 64 KB frames, none over the per-resource cap alone
  let i = 0;
  for (; i < (PAGE / CHUNK) + 100 && !b.tripped; i++) b.account("req-1", CHUNK);
  ok(b.tripped, "streamed 64 KB chunks with no Content-Length still trip (one resource -> per-resource cap)");
  ok(trips === 1, "onTrip fires exactly once (not per subsequent frame)");
  ok(b.total > PER, `actual streamed bytes exceeded the per-resource cap before tripping (${b.total} > ${PER})`);
  b.account("req-1", CHUNK); // post-trip calls are ignored
  ok(trips === 1, "post-trip accounting is a no-op");
}

// 2. A single oversized resource trips the per-resource cap even under the page cap.
{
  let trips = 0;
  const b = makeByteBudget(PER, PAGE, () => { trips++; });
  b.account("big", PER + 1);
  ok(b.tripped && trips === 1, "a single resource over the 25 MB per-resource cap trips");
}

// 3. Aggregate across MANY small resources trips only the page cap (none alone big).
{
  let trips = 0;
  const b = makeByteBudget(PER, PAGE, () => { trips++; });
  for (let i = 0; i < 60 && !b.tripped; i++) b.account(`r${i}`, 1 * 1024 * 1024); // 60 x 1 MB
  ok(b.tripped && trips === 1, "60 x 1 MB subresources trip the aggregate page cap");
}

// 4. WebSocket frames are counted (distinct ws: ids).
{
  let trips = 0;
  const b = makeByteBudget(PER, PAGE, () => { trips++; });
  for (let i = 0; i < (PAGE / (256 * 1024)) + 10 && !b.tripped; i++) b.account("ws:1", 256 * 1024);
  ok(b.tripped, "WebSocket frame bytes accumulate and trip the cap");
}

// 5. Zero / negative byte reports are ignored; a normal small page never trips.
{
  let trips = 0;
  const b = makeByteBudget(PER, PAGE, () => { trips++; });
  b.account("a", 0); b.account("a", -5); b.account("a", 500 * 1024); b.account("b", 500 * 1024);
  ok(!b.tripped && trips === 0, "a normal ~1 MB page does not trip; zero/negative ignored");
}

console.log(`\n${fail ? "FAILED" : "OK"}: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
