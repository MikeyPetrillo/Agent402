// First-run tests for agent402-mcp: keys with or without 0x, daily and
// monthly caps that hold across restarts, the first-call allowance, media
// answers written to files, and `npx agent402-mcp setup` with the OS key
// store. Offline: stub HTTP hosts on port 0, temp folders, and stub keychain
// commands (a fake `security` first on PATH); nothing is written to a real
// keychain and nothing is paid.
//
//   node mcp/test-first-run.js   (also run by mcp/test.js)
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { mkdtempSync, writeFileSync, readFileSync, statSync, existsSync, readdirSync, chmodSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { createServer } from "node:http";
import { PassThrough } from "node:stream";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { privateKeyToAccount } from "viem/accounts";

const HERE = dirname(fileURLToPath(import.meta.url));
const INDEX = join(HERE, "index.js");
const POSIX = process.platform !== "win32";
let pass = 0;
const fail = (msg) => { console.error("FAIL:", msg); process.exit(1); };
const ok = (cond, msg) => { if (!cond) fail(msg); pass++; };
const tmp = (label) => mkdtempSync(join(tmpdir(), `a402-${label}-`));
const text = (r) => r.content?.map((c) => (c.type === "text" ? c.text : `<${c.type}>`)).join("\n") ?? "";
const mode = (p) => statSync(p).mode & 0o777;

const HEX = "4c0883a69102937d6231471b5dbb6204fe5129617082792ae468d01a3f362318";
const ADDRESS = privateKeyToAccount(`0x${HEX}`).address;

// ---------------------------------------------------------------------------
// 1) wallet-key.js
{
  const { normalizeEvmKey, evmKeyOrNull, EVM_KEY_FORM } = await import("./wallet-key.js");
  for (const [raw, label] of [[`0x${HEX}`, "0x-prefixed"], [HEX, "bare hex"], [`  0x${HEX}\n`, "whitespace and a newline"], [`0X${HEX.toUpperCase()}`, "uppercase"], [`"0x${HEX}"`, "double quotes"], [` '${HEX}' `, "single quotes and spaces"]]) {
    ok(normalizeEvmKey(raw) === `0x${HEX}`, `a key given ${label} reads as the same key`);
  }
  for (const bad of ["", "0x", `0x${HEX.slice(1)}`, `${HEX}00`, `0x${HEX.slice(0, 62)}zz`, "not a key at all", `0x0x${HEX}`]) {
    ok(evmKeyOrNull(bad) === null, `"${bad.slice(0, 12)}..." is not a key`);
    let err = null;
    try { normalizeEvmKey(bad, "AGENT_KEY"); } catch (e) { err = e; }
    ok(err && err.message.includes("AGENT_KEY is set but is not") && err.message.includes(EVM_KEY_FORM) && (bad.length < 4 || !err.message.includes(bad.trim())), `a malformed key is named with the expected form and never quoted (${err?.message})`);
  }
  console.log("wallet-key.js: with or without 0x, whitespace and quotes; malformed keys named, never quoted ✓");
}

// ---------------------------------------------------------------------------
// 2) spend-ledger.js
{
  const { SpendLedger, capOf, nextDayStart, nextMonthStart } = await import("./spend-ledger.js");
  const dir = tmp("ledger");
  const file = join(dir, "sub", "spend.json");
  const t0 = Date.UTC(2026, 10, 22, 15, 30); // 2026-11-22 15:30Z
  const L = (now = t0) => new SpendLedger({ file, dayCap: 0.05, monthCap: 0.08, now: () => now });
  ok(nextDayStart(t0) === Date.UTC(2026, 10, 23), "the day resets at the next UTC midnight");
  ok(nextMonthStart(t0) === Date.UTC(2026, 11, 1), "the month resets on the first of the next UTC month");
  ok(nextMonthStart(Date.UTC(2026, 11, 31, 23)) === Date.UTC(2027, 0, 1), "December rolls into January");
  ok(L().leftUsd() === 0.05 && !existsSync(file), "no file yet: the whole daily cap is left");
  L().record(0.03);
  ok(existsSync(file), "confirmed spend is written");
  if (POSIX) ok(mode(file) === 0o600, `the ledger file is 0600 (got ${mode(file).toString(8)})`);
  // A new instance is a restart: it reads the same totals.
  const st = L().status();
  ok(st.day.spentUsd === 0.03 && st.day.leftUsd === 0.02 && st.month.leftUsd === 0.05, `a restart reads the same totals: ${JSON.stringify(st)}`);
  const r = L().refusal(0.03, "thing");
  ok(r && r.includes("daily spending cap (AGENT402_MAX_USD_PER_DAY, $0.05)") && r.includes("$0.0200 left today") && r.includes("resets at 2026-11-23T00:00:00.000Z"), `the daily refusal says what is left and when it resets: ${r}`);
  ok(L().refusal(0.02, "thing") === null, "a call that fits is not refused");
  ok(L().refusal(0.015, "thing", { otherUsd: 0.01 })?.includes("committed to calls in flight"), "calls in flight count against the cap");
  // The next day: the day resets, the month does not.
  const t1 = Date.UTC(2026, 10, 23, 1);
  ok(L(t1).status().day.spentUsd === 0, "a new UTC day starts at zero");
  const wide = new SpendLedger({ file, dayCap: 1, monthCap: 0.08, now: () => t1 });
  wide.record(0.04);
  const m = wide.refusal(0.02, "thing");
  ok(m && m.includes("monthly spending cap (AGENT402_MAX_USD_PER_MONTH, $0.08)") && m.includes("$0.0100 left this month") && m.includes("resets at 2026-12-01T00:00:00.000Z"), `the monthly cap holds across days: ${m}`);
  // Micro-dollar counting: 1000 calls at $0.0001 are exactly $0.10.
  const micro = new SpendLedger({ file: join(dir, "micro.json"), dayCap: 1, now: () => t0 });
  for (let i = 0; i < 1000; i++) micro.record(0.0001);
  ok(micro.status().day.spentUsd === 0.1, `small calls never drift (${micro.status().day.spentUsd})`);
  // No cap set: nothing is written.
  const none = new SpendLedger({ file: join(dir, "none.json") });
  none.record(1);
  ok(!none.enabled && !existsSync(join(dir, "none.json")) && none.refusal(100, "x") === null, "with no cap set nothing is written and nothing refused");
  // An unreadable ledger refuses, naming the file, and is not overwritten.
  const broken = join(dir, "broken.json");
  writeFileSync(broken, "{not json");
  const B = new SpendLedger({ file: broken, dayCap: 5, now: () => t0 });
  ok(B.refusal(0.01, "x")?.includes(broken) && B.leftUsd !== undefined, "an unreadable ledger refuses and names its path");
  B.record(0.01);
  ok(readFileSync(broken, "utf8") === "{not json", "an unreadable ledger is never overwritten");
  // capOf: unset/off = no cap; a typo is 0 (nothing spent) and named.
  const warned = [];
  ok(capOf({}, "X") === Infinity && capOf({ X: "off" }, "X") === Infinity && capOf({ X: "" }, "X") === Infinity && capOf({ X: " 2.5 " }, "X") === 2.5, "unset, empty and off are no cap; a number is the cap");
  ok(capOf({ X: "two dollars" }, "X", (w) => warned.push(w)) === 0 && /X is not a USD amount/.test(warned[0]), "a typo reads as 0 and is named");
  console.log("spend-ledger.js: daily and monthly caps, restarts, resets, 0600, micro-dollars, unreadable file ✓");
}

// ---------------------------------------------------------------------------
// 3) media-output.js
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(20_000, 7)]);
const MP3 = Buffer.concat([Buffer.from("ID3"), Buffer.alloc(20_000, 3)]);
{
  const M = await import("./media-output.js");
  ok(M.sniffType(PNG) === "image/png" && M.sniffType(MP3) === "audio/mpeg" && M.sniffType(Buffer.from("%PDF-1.7")) === "application/pdf" && M.sniffType(Buffer.from("RIFF\0\0\0\0WAVE")) === "audio/wav" && M.sniffType(Buffer.from("hello world")) === null, "first bytes name the media type");
  ok(M.isBinaryBody("image/png") && M.isBinaryBody("audio/mpeg; charset=binary") && M.isBinaryBody("application/pdf") && !M.isBinaryBody("application/json") && !M.isBinaryBody("text/plain") && !M.isBinaryBody(""), "bytes bodies are told from text and JSON");
  const out = tmp("media");
  for (const slug of ["../../etc/passwd", "a/b\\c", "x".repeat(500), "", "\u0000‮"]) {
    const name = M.mediaFileName({ slug, field: "../evil", contentType: "image/png" });
    ok(/^[a-z0-9.-]+$/.test(name) && name.length <= 100 && name.endsWith(".png") && !name.includes(".."), `a file name is bounded and made from a fixed alphabet (${name})`);
    const f = M.saveMedia(PNG, { dir: out, slug, field: "../evil", contentType: "image/png" });
    ok(dirname(f.path) === out && readFileSync(f.path).equals(PNG) && f.bytes === PNG.length, "the file lands inside the output folder with the bytes intact");
    if (POSIX) ok(mode(f.path) === 0o600, "a media file is 0600");
  }
  ok(M.mediaFileName({ slug: "x", contentType: "text/html" }).endsWith(".bin"), "an unknown type gets .bin, never a seller-chosen extension");
  // Large base64 fields.
  const doc = { text: "hello", audio: MP3.toString("base64"), format: "mp3", nested: { image: `data:image/png;base64,${PNG.toString("base64")}` }, blob: Buffer.alloc(20_000, 65).toString("base64"), small: PNG.subarray(0, 64).toString("base64") };
  const saved = [];
  const { value, files } = M.extractMediaFields(doc, (buf, o) => { const f = M.saveMedia(buf, { dir: out, slug: "tts", ...o }); saved.push(f); return f; });
  ok(files.length === 2 && value.audio.savedTo && value.audio.contentType === "audio/mpeg" && value.nested.image.contentType === "image/png" && readFileSync(value.audio.savedTo).equals(MP3) && readFileSync(value.nested.image.savedTo).equals(PNG), `large base64 audio and image fields become files: ${JSON.stringify(value).slice(0, 300)}`);
  ok(value.text === "hello" && value.blob === doc.blob && value.small === doc.small, "text, a large non-media base64 field and a small field are left as they are");
  // Folders.
  const home = tmp("home");
  ok(M.outputDirCandidates({ env: {}, home, tmp: "/t" })[0] === join("/t", "agent402"), "with no Downloads folder the OS temp folder is used");
  mkdirSync(join(home, "Downloads"));
  ok(M.outputDirCandidates({ env: {}, home, tmp: "/t" })[0] === join(home, "Downloads", "agent402"), "the default is ~/Downloads/agent402");
  ok(M.outputDirCandidates({ env: { AGENT402_OUTPUT_DIR: out }, home, tmp: "/t" })[0] === out, "AGENT402_OUTPUT_DIR wins");
  const blocker = join(out, "a-file");
  writeFileSync(blocker, "x");
  ok(M.writableOutputDir([join(blocker, "sub"), out]) === out, "an unwritable folder falls through to the next one");
  ok(M.mediaInline({ AGENT402_MEDIA_INLINE: "1" }) && !M.mediaInline({}), "AGENT402_MEDIA_INLINE=1 opts out");
  console.log("media-output.js: sniffing, bounded names, no traversal, base64 fields, folders ✓");
}

// ---------------------------------------------------------------------------
// 4) key-store.js with a stub command runner (no real keychain).
{
  const K = await import("./key-store.js");
  const calls = [];
  const stored = {};
  const run = (cmd, args, { input = "" } = {}) => {
    calls.push({ cmd, args, input });
    if (cmd === "security" && args[0] === "-i") { const m = /-w (\S+)/.exec(input); if (m) stored.mac = m[1]; return { status: 0, stdout: "" }; }
    if (cmd === "security" && args[0] === "find-generic-password") return stored.mac ? { status: 0, stdout: `${stored.mac}\n` } : { status: 44, stdout: "" };
    if (cmd === "powershell.exe") { if (args.at(-1).includes("::Write(")) { stored.win = input.trim(); return { status: 0, stdout: "" }; } return stored.win ? { status: 0, stdout: stored.win } : { status: 44, stdout: "" }; }
    if (cmd === "secret-tool" && args[0] === "store") { stored.lin = input; return { status: 0, stdout: "" }; }
    if (cmd === "secret-tool" && args[0] === "lookup") return stored.lin ? { status: 0, stdout: stored.lin } : { status: 1, stdout: "" };
    if (cmd === "secret-tool") return { status: 0, stdout: "secret-tool 0.20" };
    return { status: null, stdout: "", missing: true };
  };
  const key = `0x${HEX}`;
  const dir = tmp("keys");
  ok(K.keyStoreKind({ env: {}, platform: "darwin", run }) === "macos" && K.keyStoreKind({ env: {}, platform: "win32", run }) === "windows" && K.keyStoreKind({ env: {}, platform: "linux", run }) === "secret-tool", "the platform picks the store");
  ok(K.keyStoreKind({ env: {}, platform: "linux", run: () => ({ missing: true }) }) === "file", "Linux without secret-tool uses the file");
  ok(K.keyStoreKind({ env: { AGENT402_KEY_STORE: "off" }, platform: "darwin", run }) === "off", "AGENT402_KEY_STORE=off turns it off");
  for (const kind of ["macos", "windows", "secret-tool"]) {
    calls.length = 0;
    const r = K.storeKey(key, { kind, dir, run });
    ok(r.stored && !r.warning, `${kind}: the key is stored (${JSON.stringify(r)})`);
    ok(calls.every((c) => !c.args.join(" ").includes(HEX)), `${kind}: the key never rides on a command line`);
    ok(calls.some((c) => c.input.includes(HEX)), `${kind}: the key goes on stdin`);
    ok(K.readStoredKey({ kind, dir, run }) === key, `${kind}: the stored key reads back`);
  }
  ok(K.WIN_WRITE_SCRIPT.includes("CredWrite") && K.WIN_READ_SCRIPT.includes("CredRead") && !K.WIN_WRITE_SCRIPT.includes(HEX), "Windows uses Credential Manager through the Win32 credential API");
  const f = K.storeKey(key, { kind: "file", dir, run });
  ok(f.stored && /plain file/.test(f.warning) && readFileSync(join(dir, "wallet-key"), "utf8").trim() === key, "the file store writes the key with a warning");
  if (POSIX) ok(mode(join(dir, "wallet-key")) === 0o600, "the key file is 0600");
  ok(K.readStoredKey({ kind: "macos", dir, run: () => ({ status: 44, stdout: "" }) }) === key, "a key the keychain refused is read from the file");
  ok(K.readStoredKey({ kind: "off", dir, run }) === null, "off reads nothing");
  console.log("key-store.js: macOS, Windows, Secret Service and file stores; key on stdin only ✓");
}

// ---------------------------------------------------------------------------
// 5) setup.js in-process: hidden input, snippets, fallback.
{
  const { runSetup, configSnippets } = await import("./setup.js");
  const version = JSON.parse(readFileSync(join(HERE, "package.json"), "utf8")).version;
  const sn = configSnippets();
  ok(sn.claudeCode === `claude mcp add agent402 -s user -- npx -y agent402-mcp@${version}` && JSON.parse(sn.claudeDesktop).mcpServers.agent402.args[1] === `agent402-mcp@${version}` && !sn.claudeDesktop.includes("env"), "the snippets pin this version and need no env var");
  const drive = async (line, run, { tty = false } = {}) => {
    const input = new PassThrough();
    if (tty) { input.isTTY = true; input.setRawMode = () => input; }
    const output = new PassThrough();
    let out = "";
    output.on("data", (d) => (out += d));
    const p = runSetup({ input, output, env: { AGENT402_CONFIG_DIR: tmp("setup"), AGENT402_KEY_STORE: "macos" }, run, platform: "darwin" });
    for (const piece of line) input.write(piece);
    const code = await p;
    return { code, out };
  };
  const stored = [];
  const run = (cmd, args, { input = "" } = {}) => {
    if (args[0] === "-i") { stored.push(input); return { status: 0, stdout: "" }; }
    if (args[0] === "find-generic-password") return { status: 0, stdout: `${/-w (\S+)/.exec(stored.at(-1) || "")?.[1] || ""}\n` };
    return { status: 1, stdout: "" };
  };
  const good = await drive([`  ${HEX}  \n`], run);
  ok(good.code === 0 && /-w 0x[0-9a-f]{64}/.test(stored[0]) && stored[0].includes(HEX), `setup stores a bare-hex key, normalized: ${good.out}`);
  ok(!good.out.includes(HEX) && good.out.includes(ADDRESS) && good.out.includes("macOS Keychain") && good.out.includes(sn.claudeCode) && /needs no ETH/.test(good.out), `setup prints the wallet, the store and the config, never the key: ${good.out}`);
  // A terminal: keystrokes typed one by one with a backspace, never echoed.
  const typed = await drive([..."x" + "\u007f" + HEX, "\r"], run, { tty: true });
  ok(typed.code === 0 && !typed.out.includes(HEX) && stored.at(-1).includes(HEX), "typed input with a backspace is read and not echoed");
  const bad = await drive(["0x1234\n"], run);
  ok(bad.code === 1 && /That is not a 32-byte hex private key/.test(bad.out) && !bad.out.includes("0x1234") && stored.length === 2, `a malformed key is refused, not stored and not echoed: ${bad.out}`);
  const canceled = await drive(["\u0003"], run, { tty: true });
  ok(canceled.code === 1 && /canceled/.test(canceled.out), "Ctrl-C cancels");
  // The keychain refuses: the key goes to the file, with a warning.
  const refused = await drive([`${HEX}\n`], () => ({ status: 1, stdout: "" }));
  ok(refused.code === 0 && /storing it in a file instead/.test(refused.out) && /Warning: the key is stored in a plain file/.test(refused.out), `a refused keychain falls back to the 0600 file with a warning: ${refused.out}`);
  console.log("setup.js: hidden input, normalized key, snippets, file fallback ✓");
}

// ---------------------------------------------------------------------------
// 6) The real server against a stub host.
const BASE_USDC = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
const seen = { signed: 0 };
const offer = (path, amount) => Buffer.from(JSON.stringify({
  x402Version: 2,
  resource: { url: `http://127.0.0.1${path}`, description: "paid", mimeType: "application/json" },
  accepts: [{ scheme: "exact", network: "eip155:8453", amount: String(amount), asset: BASE_USDC, payTo: "0x000000000000000000000000000000000000dEaD", maxTimeoutSeconds: 300, extra: { name: "USD Coin", version: "2" } }],
})).toString("base64");
const row = (slug, price = "$0.01") => ({ slug, method: "POST", path: `/api/${slug}`, price, description: `${slug} test`, category: "util", computePayable: false });
const ROWS = [row("paid"), row("grant"), row("grant-settled"), row("pic"), row("tts")];
const BIG_AUDIO = { text: "hi", audio: MP3.toString("base64"), format: "mp3" };
const stub = createServer((req, res) => {
  const send = (status, body, headers = {}) => { res.writeHead(status, { "content-type": "application/json", ...headers }); res.end(typeof body === "string" ? body : JSON.stringify(body)); };
  const path = req.url.split("?")[0];
  req.resume();
  if (path === "/api/pricing") return send(200, { endpoints: ROWS, payment: { network: "base" } });
  if (path === "/openapi.json") return send(200, { paths: {} });
  if (path === "/api/skill-packs.json") return send(200, { packs: [] });
  const slug = path.slice(5);
  if (!ROWS.some((r) => r.slug === slug)) return send(404, {});
  const paid = req.headers["payment-signature"] || req.headers["x-payment"];
  if (!paid) return send(402, {}, { "PAYMENT-REQUIRED": offer(path, 10000) });
  seen.signed++;
  const receipt = { "PAYMENT-RESPONSE": Buffer.from(JSON.stringify({ success: true, transaction: "0x" + "ab".repeat(32), network: "eip155:8453" })).toString("base64") };
  if (slug === "grant") return send(200, { ok: true, firstCallAllowance: { note: "first call" } }, { "X-Agent402-Allowance": "first-call" });
  if (slug === "grant-settled") return send(200, { ok: true }, { "X-Agent402-Allowance": "first-call", ...receipt });
  if (slug === "pic") { res.writeHead(200, { "content-type": "image/png", ...receipt }); return res.end(PNG); }
  if (slug === "tts") return send(200, BIG_AUDIO, receipt);
  return send(200, { ok: true }, receipt);
});
await new Promise((r) => stub.listen(0, "127.0.0.1", r));
const STUB = `http://127.0.0.1:${stub.address().port}`;
const clean = () => {
  const e = { ...process.env, AGENT402_URL: STUB, AGENT402_KEY_STORE: "off", AGENT402_MAX_PER_CALL: "off" };
  for (const k of ["AGENT_KEY", "SOLANA_AGENT_KEY", "AGENT402_CREDITS_KEY", "AGENT402_BUDGET", "AGENT402_MAX_USD_PER_DAY", "AGENT402_MAX_USD_PER_MONTH", "AGENT402_NETWORKS", "AGENT402_MEDIA_INLINE", "AGENT402_OUTPUT_DIR", "AGENT402_CONFIG_DIR", "AGENT402_TOOLS"]) delete e[k];
  // A media answer outside 6d never lands in the user's Downloads folder.
  e.AGENT402_OUTPUT_DIR = tmp("out-default");
  return e;
};
const connect = async (env) => {
  const c = new Client({ name: "agent402-first-run-test", version: "0.0.0" });
  let err = "";
  const t = new StdioClientTransport({ command: process.execPath, args: [INDEX], env: { ...clean(), ...env }, stderr: "pipe" });
  t.stderr?.on("data", (d) => (err += d));
  await c.connect(t);
  c.stderrText = () => err;
  return c;
};
const callSlug = (c, slug) => c.callTool({ name: "catalog.call", arguments: { slug, params: { q: "x" } } });
const info = async (c) => JSON.parse(text(await c.callTool({ name: "payment.info", arguments: {} })));

try {
  // 6a) AGENT_KEY without 0x and with whitespace pays; a malformed one is named.
  {
    const c = await connect({ AGENT_KEY: `  ${HEX}\n`, AGENT402_CONFIG_DIR: tmp("cfg") });
    try {
      const i = await info(c);
      ok(i.wallet === ADDRESS && i.walletKeySource === "AGENT_KEY", `a bare-hex AGENT_KEY with whitespace reads as the wallet (${i.wallet})`);
      const before = seen.signed;
      const r = await callSlug(c, "paid");
      ok(!r.isError && seen.signed === before + 1, `a bare-hex key signs a payment: ${text(r).slice(0, 200)}`);
    } finally { await c.close(); }
    const bad = await connect({ AGENT_KEY: "0xfeedfacecafe", AGENT402_CONFIG_DIR: tmp("cfg") });
    try {
      const r = await callSlug(bad, "paid");
      ok(r.isError && /AGENT_KEY is set but is not a 32-byte hex private key \(64 hex characters, with or without the 0x prefix\)/.test(text(r)) && !text(r).includes("feedfacecafe") && !bad.stderrText().includes("feedfacecafe"), `a malformed key is named with the expected form, never echoed: ${text(r)}`);
    } finally { await bad.close(); }
    console.log("server: keys with or without 0x; malformed key named, never echoed ✓");
  }

  // 6b) A daily cap that holds across a restart, and a monthly one.
  {
    const cfg = tmp("cfg");
    const env = { AGENT_KEY: `0x${HEX}`, AGENT402_CONFIG_DIR: cfg, AGENT402_MAX_USD_PER_DAY: "0.025" };
    let c = await connect(env);
    try {
      ok(!(await callSlug(c, "paid")).isError && !(await callSlug(c, "paid")).isError, "two $0.01 calls fit a $0.025 daily cap");
      const before = seen.signed;
      const third = await callSlug(c, "paid");
      ok(third.isError && /daily spending cap \(AGENT402_MAX_USD_PER_DAY, \$0\.025\) has \$0\.0050 left today/.test(text(third)) && /resets at \d{4}-\d\d-\d\dT00:00:00\.000Z/.test(text(third)) && seen.signed === before, `the third call is refused before signing, saying what is left and when it resets: ${text(third)}`);
      const i = await info(c);
      ok(i.spendControls.daily?.leftUsd === 0.005 && i.spendControls.daily.resetsAt, `payment.info shows the daily cap: ${JSON.stringify(i.spendControls)}`);
    } finally { await c.close(); }
    const ledger = join(cfg, "spend.json");
    if (POSIX) ok(mode(ledger) === 0o600, "the ledger is 0600");
    c = await connect(env);
    try {
      const before = seen.signed;
      const r = await callSlug(c, "paid");
      ok(r.isError && /left today/.test(text(r)) && seen.signed === before, `after a restart the daily cap still holds: ${text(r)}`);
    } finally { await c.close(); }
    // Monthly: seeded with this month's spend.
    const cfg2 = tmp("cfg");
    const now = new Date();
    writeFileSync(join(cfg2, "spend.json"), JSON.stringify({ version: 1, unit: "micro-USD", days: {}, months: { [now.toISOString().slice(0, 7)]: 995_000 } }));
    c = await connect({ AGENT_KEY: `0x${HEX}`, AGENT402_CONFIG_DIR: cfg2, AGENT402_MAX_USD_PER_MONTH: "1" });
    try {
      const r = await callSlug(c, "paid");
      ok(r.isError && /monthly spending cap \(AGENT402_MAX_USD_PER_MONTH, \$1\) has \$0\.0050 left this month/.test(text(r)) && /resets at \d{4}-\d\d-01T00:00:00\.000Z/.test(text(r)), `the monthly cap reads the ledger: ${text(r)}`);
    } finally { await c.close(); }
    console.log("server: daily and monthly caps hold across restarts and say when they reset ✓");
  }

  // 6c) The first-call allowance is labeled and not counted.
  {
    const cfg = tmp("cfg");
    const c = await connect({ AGENT_KEY: `0x${HEX}`, AGENT402_CONFIG_DIR: cfg, AGENT402_MAX_USD_PER_DAY: "0.01", AGENT402_BUDGET: "0.01" });
    try {
      const g = await callSlug(c, "grant");
      ok(!g.isError && text(g).includes("One-time free call") && text(g).includes("counts against no spending cap"), `a granted call is labeled: ${text(g)}`);
      const i = await info(c);
      ok(i.spendControls.spentThisSessionUsd === 0 && i.spendControls.daily.spentUsd === 0, `a granted call counts against no cap: ${JSON.stringify(i.spendControls)}`);
      const p = await callSlug(c, "paid");
      ok(!p.isError && !text(p).includes("One-time free call"), "the next paid call still fits the caps the grant left alone");
      const after = await info(c);
      ok(after.spendControls.daily.spentUsd === 0.01 && after.spendControls.spentThisSessionUsd === 0.01, "the paid call is counted");
    } finally { await c.close(); }
    // Control: the allowance header beside a settlement receipt is a paid call.
    const c2 = await connect({ AGENT_KEY: `0x${HEX}`, AGENT402_CONFIG_DIR: tmp("cfg"), AGENT402_MAX_USD_PER_DAY: "1" });
    try {
      const s = await callSlug(c2, "grant-settled");
      const i = await info(c2);
      ok(!s.isError && !text(s).includes("One-time free call") && i.spendControls.daily.spentUsd === 0.01, `a settled call is counted even with the allowance header: ${JSON.stringify(i.spendControls)}`);
    } finally { await c2.close(); }
    console.log("server: the first-call allowance is labeled and counts against no cap ✓");
  }

  // 6d) Media answers become files; AGENT402_MEDIA_INLINE=1 keeps them inline.
  {
    const out = tmp("out");
    const c = await connect({ AGENT_KEY: `0x${HEX}`, AGENT402_CONFIG_DIR: tmp("cfg"), AGENT402_OUTPUT_DIR: out });
    try {
      const pic = await callSlug(c, "pic");
      const saved = pic.structuredContent?.result?.result;
      ok(!pic.isError && pic.content.every((b) => b.type === "text") && /Saved image\/png \(20,008 bytes\) to /.test(text(pic)) && saved?.savedTo && dirname(saved.savedTo) === out && readFileSync(saved.savedTo).equals(PNG) && saved.bytes === PNG.length && saved.contentType === "image/png", `an image answer is a file, not inline base64: ${text(pic)} ${JSON.stringify(pic.structuredContent)}`);
      const tts = await callSlug(c, "tts");
      const audio = tts.structuredContent?.result?.audio;
      ok(!tts.isError && audio?.savedTo && readFileSync(audio.savedTo).equals(MP3) && audio.contentType === "audio/mpeg" && !text(tts).includes(BIG_AUDIO.audio.slice(0, 200)) && tts.structuredContent.result.text === "hi", `a large base64 audio field is a file: ${text(tts).slice(0, 300)}`);
      ok(readdirSync(out).length === 2, "exactly the two media files were written");
    } finally { await c.close(); }
    const inl = await connect({ AGENT_KEY: `0x${HEX}`, AGENT402_CONFIG_DIR: tmp("cfg"), AGENT402_OUTPUT_DIR: out, AGENT402_MEDIA_INLINE: "1" });
    try {
      const pic = await callSlug(inl, "pic");
      ok(pic.content[0].type === "image" && Buffer.from(pic.content[0].data, "base64").equals(PNG), "AGENT402_MEDIA_INLINE=1 returns the image inline");
      const tts = await callSlug(inl, "tts");
      ok(text(tts).includes(BIG_AUDIO.audio.slice(0, 200)), "AGENT402_MEDIA_INLINE=1 leaves base64 fields inline");
      ok(readdirSync(out).length === 2, "inline mode writes no file");
    } finally { await inl.close(); }
    console.log("server: media answers written to files with path, size and type; inline opt-out ✓");
  }

  // 6e) The stored key: read from a stub keychain when AGENT_KEY is unset.
  if (POSIX) {
    const bin = tmp("bin");
    const log = join(bin, "calls.log");
    writeFileSync(join(bin, "security"), `#!/bin/sh\necho "$@" >> "${log}"\nif [ "$1" = "find-generic-password" ]; then printf '%s\\n' "${HEX}"; exit 0; fi\nif [ "$1" = "-i" ]; then cat >> "${log}.stdin"; exit 0; fi\nexit 1\n`);
    chmodSync(join(bin, "security"), 0o755);
    const PATHV = `${bin}:${process.env.PATH}`;
    const c = await connect({ AGENT402_KEY_STORE: "macos", PATH: PATHV, AGENT402_CONFIG_DIR: tmp("cfg") });
    try {
      const i = await info(c);
      ok(i.wallet === ADDRESS && /stored key/.test(i.walletKeySource) && i.mode === "usdc", `with AGENT_KEY unset the stored key pays: ${JSON.stringify({ w: i.wallet, s: i.walletKeySource })}`);
      const r = await callSlug(c, "paid");
      ok(!r.isError, "the stored key signs a payment");
    } finally { await c.close(); }
    const off = await connect({ AGENT402_KEY_STORE: "off", PATH: PATHV, AGENT402_CONFIG_DIR: tmp("cfg") });
    try { ok((await info(off)).mode === "proof-of-work", "AGENT402_KEY_STORE=off reads no stored key"); } finally { await off.close(); }

    // `npx agent402-mcp setup` as a command, key piped on stdin.
    rmSync(log, { force: true });
    const cfg = tmp("cfg");
    const r = await new Promise((resolve) => {
      const p = spawn(process.execPath, [INDEX, "setup"], { env: { ...clean(), AGENT402_KEY_STORE: "macos", PATH: PATHV, AGENT402_CONFIG_DIR: cfg }, stdio: ["pipe", "pipe", "pipe"] });
      let out = "";
      p.stdout.on("data", (d) => (out += d)); p.stderr.on("data", (d) => (out += d));
      p.on("exit", (code) => resolve({ code, out }));
      p.stdin.end(`0x${HEX}\n`);
    });
    const args = readFileSync(log, "utf8");
    const stdin = readFileSync(`${log}.stdin`, "utf8");
    ok(r.code === 0 && !r.out.includes(HEX) && r.out.includes(ADDRESS) && r.out.includes("claude mcp add agent402 -s user -- npx -y agent402-mcp@") && !/catalog:/.test(r.out), `setup runs as a command and never starts the server: ${r.out}`);
    ok(!args.includes(HEX) && stdin.includes(`-w 0x${HEX}`) && /add-generic-password -U -s agent402-mcp -a AGENT_KEY/.test(stdin), "setup hands the key to the keychain on stdin, never in arguments");
    console.log("server: the stored key is read when AGENT_KEY is unset; `setup` stores it through the keychain ✓");
  }
} finally {
  stub.close();
}
console.log(`first-run tests: ${pass} assertions passed`);
