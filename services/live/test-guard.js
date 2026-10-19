// Offline tests for the live service's outbound guard and stream cap:
// address forms that carry a private IPv4 inside IPv6 are refused, the logo
// connection resolves once and connects to the address it checked, and one
// client address cannot hold more than its share of /events streams.
import http from "node:http";
import { isPrivateIp, makeLogoCache, guardedFetch } from "./lib/logos.js";

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log(`ok - ${m}`); } else { fail++; console.error(`FAIL - ${m}`); } };

// --- Address forms
for (const ip of ["::ffff:7f00:1", "::ffff:a9fe:a9fe", "::ffff:0:7f00:1", "64:ff9b::7f00:1", "64:ff9b::a9fe:a9fe", "64:ff9b:1::1", "::7f00:1", "::127.0.0.1", "::a00:1", "2002:7f00:1::1", "2002:c0a8:101::1", "fec0::1", "2001:0:4136:e378::1", "2001:db8::1", "100::1", "::", "::1", "198.18.0.1", "192.0.0.8", "not-an-ip"]) {
  ok(isPrivateIp(ip), `refuses ${ip}`);
}
for (const ip of ["8.8.8.8", "::ffff:808:808", "::ffff:8.8.8.8", "64:ff9b::808:808", "2002:808:808::1", "2606:4700::1111"]) ok(!isPrivateIp(ip), `allows ${ip}`);

// --- The URL parser rewrites a mapped dotted quad to hex; both are refused before any request.
{
  let calls = 0;
  const lc = makeLogoCache({ fetchImpl: async () => { calls++; throw new Error("offline"); } });
  for (const [i, host] of ["[::ffff:127.0.0.1]", "[::ffff:a9fe:a9fe]", "[64:ff9b::a9fe:a9fe]", "[::7f00:1]"].entries()) {
    await lc.get(`x402:k${i}`, { icon: `https://${host}/logo.png` });
  }
  ok(calls === 0, `a private address in an IPv6 literal never reaches the fetch (fetch calls ${calls})`);
}

// --- The connection resolves once, through the check, and connects to the checked address.
{
  let hits = 0;
  const srv = http.createServer((req, res) => { hits++; res.writeHead(200, { "content-type": "image/png" }); res.end(Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3, 4])); });
  await new Promise((r) => srv.listen(0, "127.0.0.1", r));
  const port = srv.address().port;
  // In this test 127.0.0.1 stands for a public address and 127.0.0.2 for a private one.
  const isPrivate = (a) => a !== "127.0.0.1";
  let lookups = 0;
  const rebinding = async () => (++lookups === 1 ? [{ address: "127.0.0.1", family: 4 }] : [{ address: "127.0.0.2", family: 4 }]);
  let r = null, body = Buffer.alloc(0);
  try {
    r = await guardedFetch(`http://rebind.test:${port}/logo.png`, { transport: http, resolve: rebinding, isPrivate, timeoutMs: 2000 });
    body = Buffer.from(await r.arrayBuffer());
  } catch (e) { r = { status: e.message }; }
  ok(r.status === 200 && body.length === 8 && hits === 1, `the connection reaches the address its lookup checked (got ${r.status})`);
  ok(lookups === 1, `one resolution per request, so a second answer cannot be swapped in (lookups ${lookups})`);
  const before = hits;
  let err = null;
  try { await guardedFetch(`http://private.test:${port}/logo.png`, { transport: http, resolve: async () => [{ address: "127.0.0.2", family: 4 }, { address: "127.0.0.1", family: 4 }], isPrivate }); } catch (e) { err = e; }
  ok(err && /non-public/.test(err.message) && hits === before, "a name with any private answer is refused before a connection is made");
  // An oversized body is cut at the cap, so the caller's size check sees it.
  const big = http.createServer((req, res) => { res.writeHead(200, { "content-type": "image/png" }); res.end(Buffer.alloc(500_000)); });
  await new Promise((r) => big.listen(0, "127.0.0.1", r));
  const rb = await guardedFetch(`http://big.test:${big.address().port}/`, { transport: http, resolve: async () => [{ address: "127.0.0.1", family: 4 }], isPrivate, maxBytes: 1000 });
  ok((await rb.arrayBuffer()).byteLength === 1001, "a body past maxBytes stops at maxBytes + 1");
  srv.close(); big.close();
}

// --- /events: per-address cap
{
  process.env.PORT = "0"; process.env.LIVE_OFFLINE = "1"; process.env.LIVE_MAX_CLIENTS_PER_IP = "3";
  const { server } = await import("./server.js");
  await new Promise((r) => server.listening ? r() : server.once("listening", r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const open = async (xff) => {
    const ctl = new AbortController();
    const res = await fetch(base + "/events", { signal: ctl.signal, headers: xff ? { "x-forwarded-for": xff } : {} });
    if (res.status === 200) { const rd = res.body.getReader(); await rd.read(); }
    return { status: res.status, close: () => ctl.abort() };
  };
  const a = [await open("203.0.113.9"), await open("203.0.113.9"), await open("203.0.113.9")];
  const over = await open("203.0.113.9");
  ok(a.every((x) => x.status === 200) && over.status === 429, `the fourth stream from one address is refused (got ${a.map((x) => x.status)}, ${over.status})`);
  const spoof = await open("1.2.3.4, 203.0.113.9");
  ok(spoof.status === 429, "a client-supplied X-Forwarded-For entry does not move it to another address");
  const other = await open("198.51.100.7");
  ok(other.status === 200, "another address still gets a stream");
  a[0].close();
  await new Promise((r) => setTimeout(r, 200));
  const again = await open("203.0.113.9");
  ok(again.status === 200, "a closed stream frees its slot");
  for (const x of [...a, other, again]) x.close();
  server.close(); server.closeAllConnections?.();
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
