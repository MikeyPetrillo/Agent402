// Whether this boot runs a crawler that reads third-party seller hosts (the
// x402 index under X402_INDEX_CRAWL, the MPP index under MPP_INDEX_CRAWL).
//
// The crawlers are a production job: one service, a pass every 30 minutes.
// They used to start on every boot unless the switch read "off", so each CI
// server, each test that spawned src/server.js and each local or agent boot
// ran its own full pass over every indexed seller's host, and sellers saw
// that as crawl traffic from dozens of addresses an hour.
//
// The rule, in order:
//   1. the switch "off" (or false/0)  -> off
//   2. the switch "on"  (or true/1)   -> on (a test crawling a local stub sets this)
//   3. CI set in the environment      -> off
//   4. a production boot              -> on (src/production-env.js: NODE_ENV=production,
//                                        which the Dockerfile sets, or Railway's
//                                        production environment name; never FREE_MODE)
//   5. anything else                  -> off
// A self-hosted deployment that wants its own index runs the image (NODE_ENV=
// production) or sets the switch to "on".
import { isProductionEnv } from "./production-env.js";

const OFF = new Set(["off", "false", "0", "no"]);
const ON = new Set(["on", "true", "1", "yes"]);

/**
 * @param {string} name   the switch, e.g. "X402_INDEX_CRAWL"
 * @param {Record<string,string|undefined>} [env]
 * @returns {{ on: boolean, reason: string }}
 */
export function crawlSwitch(name, env = process.env) {
  const v = String(env[name] ?? "").trim().toLowerCase();
  if (OFF.has(v)) return { on: false, reason: `${name}=off` };
  if (ON.has(v)) return { on: true, reason: `${name}=on` };
  if (String(env.CI ?? "").trim() !== "" && String(env.CI).toLowerCase() !== "false") return { on: false, reason: `CI is set; ${name}=on crawls` };
  if (isProductionEnv(env)) return { on: true, reason: "production boot" };
  return { on: false, reason: `not a production boot; NODE_ENV=production or ${name}=on crawls` };
}
