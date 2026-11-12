// F04 validating + pinning egress proxy. Chromium is launched through this
// proxy so it can't resolve/connect to a private, metadata, or
// *.railway.internal destination even under DNS rebinding — the proxy is the
// single resolver + connector and pins the validated IP. Offline: unit-tests the
// resolve/validate decision on IP literals (no DNS) and functionally proves the
// proxy REFUSES a CONNECT to a private/metadata target.
//
//   node scripts/test-egress-proxy.js
import net from "node:net";
import { stubGuardResolver, stubGuardLookup, resolverError } from "./lib/guard-resolver-stub.js";
import { resolvePinned, startEgressProxy } from "../worker/egress-proxy.js";

let pass = 0, fail = 0;
const ok = (c, m) => { c ? pass++ : fail++; console.log(`${c ? "ok" : "FAIL"} - ${m}`); };
const blocked = async (host) => { try { await resolvePinned(host); return false; } catch { return true; } };

// --- 1. resolvePinned: IP-literal decisions (no DNS) --------------------------
{
  const pub = await resolvePinned("8.8.8.8");
  ok(pub.address === "8.8.8.8" && pub.family === 4, "a public IPv4 literal is allowed and pinned");
  ok(await blocked("127.0.0.1"), "loopback 127.0.0.1 is blocked");
  ok(await blocked("10.0.0.1"), "RFC1918 10.0.0.1 is blocked");
  ok(await blocked("192.168.1.1"), "RFC1918 192.168.1.1 is blocked");
  ok(await blocked("169.254.169.254"), "cloud metadata 169.254.169.254 is blocked");
  ok(await blocked("100.64.0.1"), "CGNAT 100.64.0.1 is blocked");
  ok(await blocked("::1"), "IPv6 loopback ::1 is blocked");
  ok(await blocked("fd00::1"), "IPv6 ULA fd00::1 (the *.railway.internal class) is blocked");
  ok(await blocked("fe80::1"), "IPv6 link-local fe80::1 is blocked");
}

// --- 1b. resolvePinned: names go through the fetch guard's resolver ----------
// (c-ares, every A and AAAA answer checked, the OS resolver only when the name
// server refuses a query at once), so the browser's egress refuses exactly the
// hosts the fetch path refuses. Stubbed: nothing leaves the process.
{
  const A = { "pub.egress.test": ["93.184.215.14"], "mixed.egress.test": ["93.184.215.14"], "refused.egress.test": null };
  const AAAA = { "mixed.egress.test": ["fd00::1"] };
  let lookups = 0;
  const restoreResolver = stubGuardResolver((h, family) => {
    if (h === "refused.egress.test" || h === "refused-priv.egress.test") return Promise.reject(resolverError("EREFUSED", h));
    if (h === "servfail.egress.test") return Promise.reject(resolverError("ESERVFAIL", h));
    const list = (family === 4 ? A : AAAA)[h];
    return list ? list : Promise.reject(resolverError(family === 4 && !(h in A) ? "ENOTFOUND" : "ENODATA", h));
  });
  // The OS resolver gives a private answer for every name: a proxy that asked
  // it first (getaddrinfo) would refuse the public name and pin the private one.
  const restoreLookup = stubGuardLookup((h) => { lookups++; return h === "refused.egress.test" ? [{ address: "93.184.215.15", family: 4 }] : [{ address: "10.0.0.9", family: 4 }]; });
  const pinned = await resolvePinned("pub.egress.test").catch((e) => e);
  ok(pinned?.address === "93.184.215.14" && pinned.family === 4 && lookups === 0, `a public name is pinned to the guard resolver's answer with no OS lookup (${JSON.stringify(pinned)}, ${lookups} lookups)`);
  ok(await blocked("mixed.egress.test"), "a public A beside a private AAAA is refused (every answer checked)");
  ok(await blocked("nothere.egress.test"), "a name that does not resolve is refused");
  ok(await blocked("servfail.egress.test") && lookups === 0, "a SERVFAIL is refused with no OS lookup");
  ok(await blocked("internal-db"), "a single-label name is refused before any lookup");
  const viaOs = await resolvePinned("refused.egress.test").catch((e) => e);
  ok(viaOs?.address === "93.184.215.15" && lookups === 1, `a REFUSED query takes the OS resolver once (${JSON.stringify(viaOs)})`);
  ok(await blocked("refused-priv.egress.test"), "the OS resolver's private answer is refused");
  restoreLookup(); restoreResolver();
}

// --- 2. Functional: the proxy refuses a CONNECT to a private/metadata target --
{
  const proxy = await startEgressProxy();
  const connectResult = (target) => new Promise((resolve) => {
    const s = net.connect(proxy.port, "127.0.0.1", () => {
      s.write(`CONNECT ${target} HTTP/1.1\r\nHost: ${target}\r\n\r\n`);
    });
    let buf = "";
    s.on("data", (d) => { buf += d; if (buf.includes("\r\n\r\n") || buf.length > 200) { resolve(buf.split("\r\n")[0]); s.destroy(); } });
    s.on("error", () => resolve("ERROR"));
    setTimeout(() => { resolve(buf.split("\r\n")[0] || "TIMEOUT"); try { s.destroy(); } catch { /* */ } }, 4000);
  });

  ok(/403/.test(await connectResult("127.0.0.1:80")), "CONNECT to loopback is refused (403)");
  ok(/403/.test(await connectResult("10.0.0.1:5432")), "CONNECT to an RFC1918 host (e.g. an internal DB) is refused (403)");
  ok(/403/.test(await connectResult("169.254.169.254:80")), "CONNECT to the metadata endpoint is refused (403)");
  await proxy.close();
}

console.log(`\n${fail ? "FAILED" : "OK"}: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
