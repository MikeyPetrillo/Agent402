// The router's refusal and delivery memos reach the other replica through the
// shared store (src/shared-limits.js). Two module instances of the buyer stand
// in for two containers; in memory mode they share one store, exactly as two
// containers share Redis. The local map stays the floor.
let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log(`ok - ${m}`); } else { fail++; console.log(`FAIL - ${m}`); } };
const A = await import("../src/x402-buyer.js?replica=a");
const B = await import("../src/x402-buyer.js?replica=b");
const settle = () => new Promise((r) => setImmediate(r));

// Route refusals: two strikes on A bench the route on B after one refresh.
{
  const url = "https://memo-seller.example/v1/thing";
  A.noteSellerRefusal(url, "base", 402);
  A.noteSellerRefusal(url, "base", 402);
  await settle();
  ok(A.sellerRouteRefusedRecently(url, "base")?.strikes === 2, "A benches the route after its own two strikes");
  ok(B.sellerRouteRefusedRecently(url, "base") === null, "B has not read the shared memo yet");
  await B.refreshSellerMemos([{ url, chain: "base" }]);
  const hit = B.sellerRouteRefusedRecently(url, "base");
  ok(hit?.strikes === 2 && hit.status === 402, `B benches the route after one refresh (got ${JSON.stringify(hit)})`);
  ok(B.sellerRefusedRecently("https://memo-seller.example", "base")?.route === url, "the seller record on B names the benched route");
  // A settled delivery on A clears it for B too.
  A.clearSellerRefusal(url, "base");
  await settle();
  await B.refreshSellerMemos([{ url, chain: "base" }]);
  ok(B.sellerRouteRefusedRecently(url, "base") === null, "a clear on A reaches B on its next refresh");
}

// Delivery failures: one strike on each replica is two strikes in all.
{
  const origin = "https://memo-delivery.example";
  A.noteSellerDeliveryFailure(origin, "base", { status: 500, ms: 1000 });
  B.noteSellerDeliveryFailure(origin, "base", { status: 503, ms: 1000 });
  await settle();
  ok(A.sellerDeliveryFailingRecently(origin, "base") === null && B.sellerDeliveryFailingRecently(origin, "base") === null, "one strike on each replica benches nothing locally");
  await A.refreshSellerMemos([{ origin, chain: "base" }]);
  const f = A.sellerDeliveryFailingRecently(origin, "base");
  ok(f?.strikes === 2, `after a refresh A counts both replicas' strikes (got ${JSON.stringify(f)})`);
  B.clearSellerDeliveryFailure(origin, "base");
  await settle();
  await A.refreshSellerMemos([{ origin, chain: "base" }]);
  ok(A.sellerDeliveryFailingRecently(origin, "base") === null, "a delivery on B clears the memo on A");
}

console.log(`\n${fail ? "FAILED" : "OK"}: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
