// A GET sent with exactly the headers given, over node:http. fetch adds
// Cache-Control: no-cache to a request that carries a conditional header,
// which hides the server's conditional answer; this does not.
import { request } from "node:http";

export function rawGet(url, headers = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const req = request({ host: u.hostname, port: u.port, path: u.pathname + u.search, method: "GET", headers }, (res) => {
      let body = "";
      res.on("data", (c) => { body += c; });
      res.on("end", () => resolve({ status: res.statusCode, headers: res.headers, body }));
    });
    req.on("error", reject);
    req.end();
  });
}
