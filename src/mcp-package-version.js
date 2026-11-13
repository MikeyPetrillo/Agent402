// The agent402-mcp package version the hosted connector reports, read from
// mcp/package.json. A file that is missing or unreadable (an image built
// without it) yields "0.0.0" and one warning: the version string never
// decides whether the server starts.
import { readFileSync } from "node:fs";

export function mcpPackageVersionFrom(url) {
  try {
    const v = JSON.parse(readFileSync(url, "utf8")).version;
    if (typeof v === "string" && /^\d+\.\d+\.\d+/.test(v)) return v;
  } catch { /* falls through to the warning */ }
  console.warn("mcp: package version unreadable; serverInfo.version reports 0.0.0");
  return "0.0.0";
}
