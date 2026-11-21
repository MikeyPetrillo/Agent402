// Given the MCP Registry's `GET /v0/servers?search=...` response on stdin,
// prints the version currently marked isLatest (nothing if none found or the
// input doesn't parse). Used by the publish job in deploy.yml: right before
// publishing a new version, it captures the version that's ABOUT to become
// stale, so it can be deprecated immediately after the new one goes live -
// otherwise every publish leaves its predecessor "active" forever, which is
// exactly how 24 of 25 published versions ended up non-deprecated (found
// 2026-08-16, first noticed via a growth/revenue audit).
//
// stdin may hold several pages, one JSON document per line.
//   --name <server name>  read only that server's entries (a search also
//                         returns other publishers' similar names)
//   --superseded          print, one per line and oldest first, every version
//                         of --name still "active" that is not the latest
//                         (nothing without --name)
//   --except <version>    leave this version out (the one being published)
const argv = process.argv.slice(2);
const arg = (flag) => { const i = argv.indexOf(flag); return i >= 0 ? argv[i + 1] : undefined; };
const NAME = arg("--name");
const SUPERSEDED = argv.includes("--superseded");
const EXCEPT = arg("--except");
const OFFICIAL = "io.modelcontextprotocol.registry/official";

const semverKey = (v) => String(v).split(/[.+-]/).slice(0, 3).map((n) => Number(n) || 0);
const bySemver = (a, b) => { const x = semverKey(a), y = semverKey(b); for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] - y[i]; return 0; };

/** Every row of every page that parses (one JSON document per line, or one in all). */
function rowsOf(input) {
  const docs = [];
  try { docs.push(JSON.parse(input)); } catch {
    for (const line of input.split("\n")) { if (!line.trim()) continue; try { docs.push(JSON.parse(line)); } catch { /* a torn page is skipped */ } }
  }
  return docs.flatMap((d) => (Array.isArray(d?.servers) ? d.servers : []));
}

let input = "";
process.stdin.on("data", (chunk) => { input += chunk; });
process.stdin.on("end", () => {
  try {
    const rows = rowsOf(input).filter((s) => !NAME || s?.server?.name === NAME);
    if (SUPERSEDED) {
      if (!NAME) return;
      const out = [...new Set(rows
        .filter((s) => s?._meta?.[OFFICIAL]?.status === "active" && s?._meta?.[OFFICIAL]?.isLatest !== true)
        .map((s) => s?.server?.version)
        .filter((v) => typeof v === "string" && /^\d+\.\d+\.\d+/.test(v) && v !== EXCEPT))].sort(bySemver);
      if (out.length) process.stdout.write(`${out.join("\n")}\n`);
      return;
    }
    const row = rows.find((s) => s?._meta?.[OFFICIAL]?.isLatest === true);
    if (row?.server?.version) process.stdout.write(String(row.server.version));
  } catch {
    // Any parse/shape surprise -> empty output. The caller (deploy.yml) treats
    // a blank result as "nothing to deprecate" and moves on - a registry
    // hiccup here must never fail the publish job over a best-effort cleanup.
  }
});
