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
import { resolvePublicAddresses } from "../src/tools/fetch-guard.js";

const CONNECT_TIMEOUT_MS = Number(process.env.EGRESS_PROXY_TIMEOUT_MS) || 15_000;

// Every refusal reads the same, whatever the reason (a name that does not
// resolve, a private address, a scheme the proxy does not carry), so a page
// that redirects the browser here learns nothing about which internal names
// exist. A refusal on the plain-HTTP path also carries EGRESS_REFUSED_HEADER,
// which render.js reads to fail the call instead of rendering this text.
export const EGRESS_REFUSAL = "blocked by the egress policy";
export const EGRESS_REFUSED_HEADER = "x-egress-refused";
const refuse = (res) => {
  if (res.headersSent) return res.end();
  res.writeHead(403, { "content-type": "text/plain; charset=utf-8", "content-length": Buffer.byteLength(EGRESS_REFUSAL), [EGRESS_REFUSED_HEADER]: "1", connection: "close" });
  res.end(EGRESS_REFUSAL);
};

// Resolve a host to a SINGLE validated, pinned address. Throws (blocks) if an IP
// literal is private, resolution fails, or ANY resolved address is private —
// so a public-A-record + private-AAAA split can never slip a connection through.
// The resolving and the checks are the fetch guard's own (resolvePublicAddresses:
// c-ares, so an unanswered name holds no libuv pool thread, every A and AAAA
// answer checked, a single-label name refused), so the browser's egress and the
// fetch path refuse the same hosts.
export async function resolvePinned(host) {
  let addrs;
  try { addrs = await resolvePublicAddresses(host); }
  catch { throw new Error(EGRESS_REFUSAL); }
  return addrs[0]; // pinned: connect to this exact validated IP, no re-resolution
}

// `resolve` replaces the validating resolver; only test suites pass one (to
// treat a loopback fixture as a public host), never a serving path.
export function startEgressProxy({ port = 0, resolve: resolveHost = resolvePinned } = {}) {
  const server = http.createServer((req, res) => {
    // Plain HTTP proxying (absolute-form request URL) — rare from Chromium.
    (async () => {
      let target;
      try { target = new URL(req.url); } catch { refuse(res); return; }
      if (target.protocol !== "http:") { refuse(res); return; }
      let pinned;
      try { pinned = await resolveHost(target.hostname); } catch { refuse(res); return; }
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
      catch { try { clientSocket.write(`HTTP/1.1 403 Forbidden\r\nContent-Length: ${Buffer.byteLength(EGRESS_REFUSAL)}\r\n\r\n${EGRESS_REFUSAL}`); } catch { /* */ } clientSocket.destroy(); return; }
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
