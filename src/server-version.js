// The server's own version, read once from package.json: the OpenAPI
// document's info.version and the A2A agent card's version report it, so a
// directory that shows either one shows the release that is running. A file
// that is missing or unreadable yields "0.0.0" and one warning: the version
// string never decides whether the server starts.
import { readFileSync } from "node:fs";

export function serverVersionFrom(url) {
  try {
    const v = JSON.parse(readFileSync(url, "utf8")).version;
    if (typeof v === "string" && /^\d+\.\d+\.\d+/.test(v)) return v;
  } catch { /* falls through to the warning */ }
  console.warn("server: package version unreadable; the OpenAPI and agent card versions report 0.0.0");
  return "0.0.0";
}

export const SERVER_VERSION = serverVersionFrom(new URL("../package.json", import.meta.url));
