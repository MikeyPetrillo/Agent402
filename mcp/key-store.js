// The wallet key in the operating system's own credential store, so a client
// config needs no AGENT_KEY variable: `npx agent402-mcp setup` writes it once,
// and the server reads it at start when AGENT_KEY is not set.
//
//   macOS    the login Keychain, through /usr/bin/security
//   Windows  Credential Manager (a generic credential), through PowerShell
//   Linux    the Secret Service, through secret-tool, when it is installed
//   else     a file (wallet-key, mode 0600) in the package's config folder
//
// The key never rides on a command line (where other local users could read
// it in the process list): every store command takes it on stdin.
// AGENT402_KEY_STORE picks the store: auto (default), macos, windows,
// secret-tool, file, or off (never read one).
import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync, renameSync, chmodSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { ensureConfigDir } from "./config-dir.js";

export const KEY_SERVICE = "agent402-mcp";
export const KEY_ACCOUNT = "AGENT_KEY";
export const KEY_LABEL = "Agent402 wallet key";
export const KEY_FILE_NAME = "wallet-key";
export const KEY_STORE_ENV = "AGENT402_KEY_STORE";
const STORES = new Set(["macos", "windows", "secret-tool", "file", "off"]);
const RUN_TIMEOUT_MS = 15_000;

/** Run a command with `input` on stdin; never throws. */
export function runCommand(cmd, args, { input = "" } = {}) {
  const r = spawnSync(cmd, args, { input, encoding: "utf8", timeout: RUN_TIMEOUT_MS, windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
  return { status: r.error ? null : r.status, stdout: r.stdout || "", missing: r.error?.code === "ENOENT" };
}

/** Which store to use. */
export function keyStoreKind({ env = process.env, platform = process.platform, run = runCommand } = {}) {
  const asked = String(env[KEY_STORE_ENV] || "").trim().toLowerCase();
  if (STORES.has(asked)) return asked;
  if (platform === "darwin") return "macos";
  if (platform === "win32") return "windows";
  return run("secret-tool", ["--version"]).missing ? "file" : "secret-tool";
}

// A generic credential through the Win32 API (CredWrite/CredRead), compiled
// once per call by Add-Type; it ships with Windows PowerShell 5.1.
const WIN_CRED_TYPE = `
Add-Type -TypeDefinition @"
using System; using System.Runtime.InteropServices; using System.Text;
public static class A402Cred {
  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
  public struct CREDENTIAL { public int Flags; public int Type; public string TargetName; public string Comment;
    public System.Runtime.InteropServices.ComTypes.FILETIME LastWritten; public int CredentialBlobSize; public IntPtr CredentialBlob;
    public int Persist; public int AttributeCount; public IntPtr Attributes; public string TargetAlias; public string UserName; }
  [DllImport("advapi32.dll", CharSet = CharSet.Unicode, SetLastError = true)] static extern bool CredWrite(ref CREDENTIAL c, int flags);
  [DllImport("advapi32.dll", CharSet = CharSet.Unicode, SetLastError = true)] static extern bool CredRead(string target, int type, int flags, out IntPtr c);
  [DllImport("advapi32.dll")] static extern void CredFree(IntPtr c);
  public static void Write(string target, string user, string secret) {
    byte[] b = Encoding.Unicode.GetBytes(secret);
    CREDENTIAL c = new CREDENTIAL(); c.Type = 1; c.TargetName = target; c.UserName = user; c.Persist = 2; c.CredentialBlobSize = b.Length;
    c.CredentialBlob = Marshal.AllocHGlobal(b.Length); Marshal.Copy(b, 0, c.CredentialBlob, b.Length);
    try { if (!CredWrite(ref c, 0)) throw new System.ComponentModel.Win32Exception(Marshal.GetLastWin32Error()); }
    finally { Marshal.FreeHGlobal(c.CredentialBlob); }
  }
  public static string Read(string target) {
    IntPtr p; if (!CredRead(target, 1, 0, out p)) return null;
    try { CREDENTIAL c = (CREDENTIAL)Marshal.PtrToStructure(p, typeof(CREDENTIAL)); return Marshal.PtrToStringUni(c.CredentialBlob, c.CredentialBlobSize / 2); }
    finally { CredFree(p); }
  }
}
"@`;
const POWERSHELL = ["powershell.exe", ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command"]];
export const WIN_WRITE_SCRIPT = `$ErrorActionPreference = 'Stop'${WIN_CRED_TYPE}
[A402Cred]::Write('${KEY_SERVICE}', '${KEY_ACCOUNT}', [Console]::In.ReadLine().Trim())`;
export const WIN_READ_SCRIPT = `$ErrorActionPreference = 'Stop'${WIN_CRED_TYPE}
$v = [A402Cred]::Read('${KEY_SERVICE}'); if ($v) { [Console]::Out.Write($v) } else { exit 44 }`;

const keyFile = (dir) => join(dir, KEY_FILE_NAME);

/** Store `key`. Returns { stored: true, kind, where, warning? } or { stored: false, kind, reason }. */
export function storeKey(key, { kind, dir, run = runCommand } = {}) {
  const line = `${String(key).trim()}\n`;
  if (kind === "macos") {
    // Interactive mode reads the command on stdin, so the key is not an argument.
    const r = run("security", ["-i"], { input: `add-generic-password -U -s ${KEY_SERVICE} -a ${KEY_ACCOUNT} -l "${KEY_LABEL}" -w ${String(key).trim()}\n` });
    const back = r.status === 0 ? run("security", ["find-generic-password", "-s", KEY_SERVICE, "-a", KEY_ACCOUNT, "-w"]) : null;
    if (back && back.status === 0 && back.stdout.trim() === String(key).trim()) return { stored: true, kind, where: `the macOS Keychain (item "${KEY_SERVICE}", account ${KEY_ACCOUNT})` };
    return { stored: false, kind, reason: "the macOS Keychain did not accept the key" };
  }
  if (kind === "windows") {
    const r = run(POWERSHELL[0], [...POWERSHELL[1], WIN_WRITE_SCRIPT], { input: line });
    if (r.status === 0) return { stored: true, kind, where: `Windows Credential Manager (generic credential "${KEY_SERVICE}")` };
    return { stored: false, kind, reason: "Windows Credential Manager did not accept the key" };
  }
  if (kind === "secret-tool") {
    const r = run("secret-tool", ["store", `--label=${KEY_LABEL}`, "service", KEY_SERVICE, "account", KEY_ACCOUNT], { input: String(key).trim() });
    if (r.status === 0) return { stored: true, kind, where: `the Secret Service keyring (service ${KEY_SERVICE}, account ${KEY_ACCOUNT})` };
    return { stored: false, kind, reason: "the Secret Service keyring did not accept the key (is a keyring running?)" };
  }
  if (kind === "file") {
    ensureConfigDir(dir);
    const path = keyFile(dir);
    const tmp = `${path}.${process.pid}.tmp`;
    writeFileSync(tmp, line, { mode: 0o600 });
    if (process.platform !== "win32") chmodSync(tmp, 0o600);
    renameSync(tmp, path);
    return { stored: true, kind, where: path, warning: `the key is stored in a plain file readable by your user account (${path}, mode 0600), since no OS keychain was available; anyone who can read your files can read it` };
  }
  return { stored: false, kind, reason: `no key store (${KEY_STORE_ENV}=off)` };
}

/** The stored key text, or null when none is stored or the store cannot be read. */
export function readStoredKey({ kind, dir, run = runCommand } = {}) {
  const fromFile = () => { try { return readFileSync(keyFile(dir), "utf8").trim() || null; } catch { return null; } };
  if (kind === "off") return null;
  if (kind === "file") return fromFile();
  let r = null;
  if (kind === "macos") r = run("security", ["find-generic-password", "-s", KEY_SERVICE, "-a", KEY_ACCOUNT, "-w"]);
  else if (kind === "windows") r = run(POWERSHELL[0], [...POWERSHELL[1], WIN_READ_SCRIPT]);
  else if (kind === "secret-tool") r = run("secret-tool", ["lookup", "service", KEY_SERVICE, "account", KEY_ACCOUNT]);
  const v = r && r.status === 0 ? r.stdout.trim() : "";
  // A key setup wrote to the file because the keychain refused it.
  return v || fromFile();
}

/** Remove the file copy (used after a keychain write succeeds, so one key has one home). */
export function removeKeyFile(dir) { try { unlinkSync(keyFile(dir)); return true; } catch { return false; } }
