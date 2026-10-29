// F04: validating + pinning egress proxy for the browser worker.
//
// Chromium resolves DNS and connects on its own, so the app-layer route guard
// (render.js context.route + hostIsPublic) validates a hostname but does NOT
// bind Chromium's actual socket to the checked IP. A DNS-rebinding host can
// return a public IP to the validator and a private one to Chromium's connect,
// reaching *.railway.internal / RFC1918 / loopback / metadata. This closes that
// TOCTOU by making the proxy the ONLY resolver and connector: Chromium is
// launched with --proxy-server pointed here, and for every destination the proxy
// resolves the host ONCE, refuses if ANY resolved address is private/reserved
// (isPrivateIp — the same classifier the SSRF guard uses, which also flags the
// fc00::/7 ULA that *.railway.internal resolves to), and connects to that exact
// PINNED IP. Redirects are re-validated because Chromium re-issues them here.
import http from "node:http";
import net from "node:net";
import dns from "node:dns/promises";
import { isPrivateIp } from "../src/tools/fetch-guard.js";

const CONNECT_TIMEOUT_MS = Number(process.env.EGRESS_PROXY_TIMEOUT_MS) || 15_000;

// Resolve a host to a SINGLE validated, pinned address. Throws (blocks) if an IP
// literal is private, resolution fails, or ANY resolved address is private —
// so a public-A-record + private-AAAA split can never slip a connection through.
export async function resolvePinned(host) {
  const lit = net.isIP(host);
  if (lit) {
    if (isPrivateIp(host)) throw new Error(`blocked: ${host} is a private/reserved address`);
    return { address: host, family: lit };
  }
  let addrs;
  try { addrs = await dns.lookup(host, { all: true, verbatim: true }); }
  catch { throw new Error(`blocked: cannot resolve ${host}`); }
  if (!addrs.length) throw new Error(`blocked: no address for ${host}`);
  if (addrs.some((a) => isPrivateIp(a.address))) throw new Error(`blocked: ${host} resolves to a private/reserved address`);
  return addrs[0]; // pinned: connect to this exact validated IP, no re-resolution
}

// `resolve` replaces the validating resolver; only test suites pass one (to
// treat a loopback fixture as a public host), never a serving path.
export function startEgressProxy({ port = 0, resolve: resolveHost = resolvePinned } = {}) {
  const server = http.createServer((req, res) => {
    // Plain HTTP proxying (absolute-form request URL) — rare from Chromium.
    (async () => {
      let target;
      try { target = new URL(req.url); } catch { res.writeHead(400).end("bad target"); return; }
      if (target.protocol !== "http:") { res.writeHead(403).end("only http(s) via CONNECT"); return; }
      let pinned;
      try { pinned = await resolveHost(target.hostname); } catch (e) { res.writeHead(403).end(e.message); return; }
      const upstream = http.request(
        { host: pinned.address, family: pinned.family, port: Number(target.port) || 80, method: req.method, path: target.pathname + target.search, headers: { ...req.headers, host: target.host }, timeout: CONNECT_TIMEOUT_MS },
        (up) => { res.writeHead(up.statusCode || 502, up.headers); up.pipe(res); },
      );
      upstream.on("error", () => { if (!res.headersSent) res.writeHead(502); res.end(); });
      upstream.on("timeout", () => upstream.destroy());
      req.pipe(upstream);
    })();
  });

  // HTTPS and the common case: CONNECT tunnels. Chromium sends CONNECT host:443;
  // we resolve+validate, then TCP-connect to the pinned IP and blindly tunnel.
  server.on("connect", (req, clientSocket, head) => {
    (async () => {
      const [host, portStr] = String(req.url).split(":");
      const port = Number(portStr) || 443;
      let pinned;
      try { pinned = await resolveHost(host); }
      catch (e) { try { clientSocket.write(`HTTP/1.1 403 Forbidden\r\n\r\n${e.message}`); } catch { /* */ } clientSocket.destroy(); return; }
      const upstream = net.connect({ host: pinned.address, port, family: pinned.family }, () => {
        clientSocket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
        if (head && head.length) upstream.write(head);
        upstream.pipe(clientSocket);
        clientSocket.pipe(upstream);
      });
      upstream.setTimeout(CONNECT_TIMEOUT_MS, () => upstream.destroy());
      upstream.on("error", () => { try { clientSocket.destroy(); } catch { /* */ } });
      clientSocket.on("error", () => { try { upstream.destroy(); } catch { /* */ } });
    })();
  });

  return new Promise((resolve) => {
    server.listen(port, "127.0.0.1", () => {
      const addr = server.address();
      resolve({ port: addr.port, url: `http://127.0.0.1:${addr.port}`, close: () => new Promise((r) => server.close(r)), server });
    });
  });
}
