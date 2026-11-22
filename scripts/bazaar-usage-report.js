#!/usr/bin/env node
// Monthly read of the Bazaar discovery listing for this host's routes.
//
// The run log is public, so this prints a bare status only: the listing was
// read, or it could not be read (exit 1, which the workflow files under its
// neutral issue text). No figure from the listing is printed.
//
// Read-only, keyless, spends nothing.
import { pathToFileURL } from "node:url";

const HOST = process.env.HOST || "agent402.tools";
const API = "https://api.cdp.coinbase.com/platform/v2/x402/discovery/resources";

/** Walks the listing by limit/offset; returns this host's rows. Throws when a page cannot be read. */
export async function listings({ fetchImpl = fetch, host = HOST } = {}) {
  const out = [];
  let offset = 0;
  for (let p = 0; p < 30; p++) {
    const r = await fetchImpl(`${API}?limit=1000&offset=${offset}`).catch(() => null);
    if (!r || !r.ok) throw new Error("listing unreadable");
    const d = await r.json();
    const items = d.items || d.resources || [];
    if (!items.length) break;
    out.push(...items.filter((i) => {
      try { return new URL(String(i.resource || "")).hostname === host; } catch { return false; }
    }));
    if (items.length < 1000) break;
    offset += items.length;
  }
  return out;
}

/** The one line this check prints, and its exit code. */
export async function run({ fetchImpl = fetch, log = console.log } = {}) {
  try {
    await listings({ fetchImpl });
  } catch {
    log("listing usage report: could not read the listing");
    return 1;
  }
  log("listing usage report: ran");
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  run().then((code) => process.exit(code), () => { console.log("listing usage report: could not read the listing"); process.exit(1); });
}
