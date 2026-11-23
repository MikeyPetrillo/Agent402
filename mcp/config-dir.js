// Where this package keeps its own small files (the spend ledger, the wallet
// key when no OS keychain is available): AGENT402_CONFIG_DIR when set, else
// the platform's per-user config folder.
import { homedir } from "node:os";
import { join } from "node:path";
import { mkdirSync, chmodSync } from "node:fs";

export function configDir({ env = process.env, platform = process.platform, home = homedir() } = {}) {
  const own = String(env.AGENT402_CONFIG_DIR || "").trim();
  if (own) return own;
  if (platform === "win32") return join(env.APPDATA || join(home, "AppData", "Roaming"), "agent402");
  if (platform === "darwin") return join(home, "Library", "Application Support", "agent402");
  return join(String(env.XDG_CONFIG_HOME || "").trim() || join(home, ".config"), "agent402");
}

/** Make the folder (owner-only on POSIX when this call creates it) and return it.
 *  A folder that already exists keeps its own mode. */
export function ensureConfigDir(dir) {
  const made = mkdirSync(dir, { recursive: true, mode: 0o700 });
  if (made && process.platform !== "win32") { try { chmodSync(dir, 0o700); } catch { /* the umask already applied */ } }
  return dir;
}
