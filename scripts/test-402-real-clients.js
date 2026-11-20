#!/usr/bin/env node
// Real HTTP clients read our 402.
//
// A 402 a client cannot parse is a sale it cannot make: the client sees a
// parser error, never the price. Our size guards count bytes
// (scripts/test-challenge-size.js, test-challenge-fit.js); this suite asks
// the clients themselves. It boots THIS tree in paid mode on port 0 with
// every rail a local stub stands in for (ten EVM chains, upto on Base,
// Solana, Stellar, Algorand), MPP and a builder code, and has each client,
// at its own defaults, read the largest 402s the catalog answers:
//
//   aiohttp    (Python) caps one header line at 8,190 bytes. At its own
//              User-Agent it gets the compact PAYMENT-REQUIRED header
//              (src/payment-required-compact.js); with another User-Agent it
//              reads the 402 when it sends X-Payment-Compact: 1. Without the
//              flag it reads a route's default 402 exactly when every header
//              line, measured as `name: value`, is 8,190 bytes or less: the
//              suite predicts the outcome per route from that measure, so
//              the measure the guards use is checked against the real parser.
//   httpx      (Python, httpcore over h11, which holds a head to 100 KB).
//   requests   (Python, http.client).
//   undici     (Node's own fetch) holds a response head to 16 KB.
//   Go         net/http's default client.
//
// Every priced route's 402 is also read with X-Payment-Compact: 1: every
// header line of it is 8,190 bytes or less. The default PAYMENT-REQUIRED is
// not bounded per line: the Bazaar harvests it whole (every accept and every
// extension land in the listing; scripts/listing-coverage.js), so it is the
// full offer, and a line-capped client reads the compact one.
//
// The last four read the full default header, byte for byte what a raised
// limit reads. A second server answers a synthetic 402 whose head is exactly
// test-challenge-size's 16,200-byte ceiling, counted the way it counts: every
// client but aiohttp reads it; a head 500 bytes over is refused by undici
// (the control that the synthetic sits where Node's 16 KB limit bites).
//
// Clients are processes: Python 3 (`python3`, or REAL_CLIENT_PYTHON) run
// isolated (-I) with aiohttp, httpx and requests installed, and Go (`go`, or
// REAL_CLIENT_GO). A missing client fails the suite under CI and is skipped
// with a note elsewhere.
//   node scripts/test-402-real-clients.js
import "./lib/offline-stores.js"; // per-process and file backends whatever the caller exports (see the file)
import { spawn, spawnSync } from "node:child_process";
import { createServer } from "node:net";
import { createServer as createHttpServer, request, maxHeaderSize } from "node:http";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ownStoreEnv } from "./lib/own-stores.js";
import { AIOHTTP_DEFAULT_LINE_BYTES, COMPACT_REQUEST_HEADER, FULL_OFFER_IN } from "../src/payment-required-compact.js";

const IN_CI = Boolean(process.env.CI);
const PYTHON = process.env.REAL_CLIENT_PYTHON || "python3";
const GO = process.env.REAL_CLIENT_GO || "go";
// test-challenge-size's ceiling on a 402's whole head, and how it counts it.
const MAX_TOTAL_HEADER_BYTES = 16_200;
const headBytes = (pairs) => pairs.reduce((n, [k, v]) => n + k.length + v.length + 4, 20);
const lineBytes = (k, v) => Buffer.byteLength(`${k}: ${v}`, "utf8");
const CUSTOM_UA = "agent402-real-client-test/1.0";
const GW = JSON.stringify({ model: "openai/gpt-5", max_tokens: 300, messages: [{ role: "user", content: "Reply with the single word: settled" }] });

let pass = 0, failed = 0, proc = null, fac = null, synth = null;
const ok = (c, m) => { if (c) { pass++; console.log(`ok - ${m}`); } else { failed++; console.log(`FAIL - ${m}`); } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const dec = (h) => JSON.parse(Buffer.from(h, "base64").toString("utf8"));
const work = mkdtempSync(join(tmpdir(), "a402-real-clients-"));
const stop = () => { try { proc?.kill("SIGKILL"); } catch {} try { fac?.close(); } catch {} try { synth?.close(); } catch {} };
process.on("exit", stop);

// ---------------------------------------------------------------------------
// The clients
// ---------------------------------------------------------------------------
const PY = `
import sys, json, asyncio
kind, path = sys.argv[1], sys.argv[2]
reqs = json.load(open(path))
out = []
def rec(status=None, pr=None, err=None):
    out.append({"status": status, "pr": pr, "err": err})
try:
    if kind == "aiohttp":
        import aiohttp
        version = aiohttp.__version__
        async def run():
            async with aiohttp.ClientSession() as s:
                for q in reqs:
                    try:
                        async with s.request(q["method"], q["url"], headers=q["headers"], data=q.get("body")) as r:
                            await r.read()
                            rec(r.status, r.headers.get("PAYMENT-REQUIRED"))
                    except Exception as e:
                        rec(err=type(e).__name__ + ": " + str(e)[:200])
        asyncio.run(run())
    elif kind == "httpx":
        import httpx
        version = httpx.__version__
        with httpx.Client() as c:
            for q in reqs:
                try:
                    r = c.request(q["method"], q["url"], headers=q["headers"], content=q.get("body"))
                    rec(r.status_code, r.headers.get("PAYMENT-REQUIRED"))
                except Exception as e:
                    rec(err=type(e).__name__ + ": " + str(e)[:200])
    elif kind == "requests":
        import requests
        version = requests.__version__
        s = requests.Session()
        for q in reqs:
            try:
                r = s.request(q["method"], q["url"], headers=q["headers"], data=q.get("body"), timeout=30)
                rec(r.status_code, r.headers.get("PAYMENT-REQUIRED"))
            except Exception as e:
                rec(err=type(e).__name__ + ": " + str(e)[:200])
    else:
        raise SystemExit("unknown client " + kind)
except ImportError as e:
    print(json.dumps({"missing": str(e)}))
    sys.exit(3)
print(json.dumps({"version": version, "results": out}))
`;
const GO_SRC = `package main

import (
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"os"
	"runtime"
	"strings"
)

type req struct {
	Method  string            \`json:"method"\`
	URL     string            \`json:"url"\`
	Headers map[string]string \`json:"headers"\`
	Body    *string           \`json:"body"\`
}
type res struct {
	Status int    \`json:"status,omitempty"\`
	PR     string \`json:"pr,omitempty"\`
	Err    string \`json:"err,omitempty"\`
}

func main() {
	data, err := os.ReadFile(os.Args[1])
	if err != nil {
		panic(err)
	}
	var reqs []req
	if err := json.Unmarshal(data, &reqs); err != nil {
		panic(err)
	}
	out := []res{}
	for _, q := range reqs {
		var body io.Reader
		if q.Body != nil {
			body = strings.NewReader(*q.Body)
		}
		r, err := http.NewRequest(q.Method, q.URL, body)
		if err != nil {
			out = append(out, res{Err: err.Error()})
			continue
		}
		for k, v := range q.Headers {
			r.Header.Set(k, v)
		}
		resp, err := http.DefaultClient.Do(r)
		if err != nil {
			out = append(out, res{Err: err.Error()})
			continue
		}
		io.Copy(io.Discard, resp.Body)
		resp.Body.Close()
		out = append(out, res{Status: resp.StatusCode, PR: resp.Header.Get("Payment-Required")})
	}
	b, _ := json.Marshal(map[string]any{"version": runtime.Version(), "results": out})
	fmt.Println(string(b))
}
`;
const pyFile = join(work, "client.py");
const goFile = join(work, "client.go");
writeFileSync(pyFile, PY);
writeFileSync(goFile, GO_SRC);
const goEnv = { ...process.env, GOCACHE: join(work, "gocache"), GOPATH: join(work, "gopath"), GOTOOLCHAIN: "local", GOTELEMETRY: "off", GOFLAGS: "" };

const runChild = (cmd, args, env = process.env) => new Promise((resolve) => {
  let child;
  try { child = spawn(cmd, args, { env, stdio: ["ignore", "pipe", "pipe"] }); } catch (e) { resolve({ code: -1, out: "", err: String(e?.message || e) }); return; }
  let out = "", err = "";
  child.stdout.on("data", (d) => (out += d)); child.stderr.on("data", (d) => (err += d));
  child.on("error", (e) => resolve({ code: -1, out, err: String(e?.message || e) }));
  child.on("close", (code) => resolve({ code, out, err }));
});
/** Run one client over `reqs`; { version, results[] } or { missing }. */
async function runClient(kind, reqs) {
  const file = join(work, `reqs-${kind}-${Math.random().toString(36).slice(2)}.json`);
  writeFileSync(file, JSON.stringify(reqs));
  if (kind === "undici") {
    const results = [];
    for (const q of reqs) {
      try {
        const r = await fetch(q.url, { method: q.method, headers: q.headers, body: q.body ?? undefined });
        await r.arrayBuffer();
        results.push({ status: r.status, pr: r.headers.get("payment-required") });
      } catch (e) { results.push({ err: `${e?.name}: ${String(e?.cause?.code || e?.cause?.message || e?.message).slice(0, 200)}` }); }
    }
    return { version: `node ${process.version} (head limit ${maxHeaderSize})`, results };
  }
  const r = kind === "go" ? await runChild(GO, ["run", goFile, file], goEnv) : await runChild(PYTHON, ["-I", pyFile, kind, file]);
  const last = r.out.trim().split("\n").pop() || "";
  let j = null; try { j = JSON.parse(last); } catch { /* not JSON */ }
  if (j?.results) return j;
  return { missing: j?.missing || `${kind === "go" ? GO : PYTHON} exited ${r.code}: ${(r.err || r.out).trim().split("\n").slice(-2).join(" | ").slice(0, 200)}` };
}
const missing = [];
/** Each client's run, or null (noted) when the client is not installed. */
async function clientRun(kind, reqs) {
  const r = await runClient(kind, reqs);
  if (r.missing) { missing.push(`${kind} (${r.missing})`); return null; }
  return r;
}

// ---------------------------------------------------------------------------
// The paid server
// ---------------------------------------------------------------------------
const EVM_KINDS = ["eip155:8453", "eip155:137", "eip155:42161", "eip155:143", "eip155:42220", "eip155:43114", "eip155:1329", "eip155:10", "eip155:57073", "eip155:4663"];
const NON_EVM_KINDS = [
  { x402Version: 2, scheme: "exact", network: "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp", extra: { feePayer: "9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM" } },
  { x402Version: 2, scheme: "exact", network: "stellar:pubnet", extra: { areFeesSponsored: true } },
  { x402Version: 2, scheme: "exact", network: "algorand:wGHE2Pwdvd7S12BL5FaOP20EGYesN73k", extra: { feePayer: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAY5HFKQ" } },
];
fac = createHttpServer((req, res) => {
  req.resume();
  req.on("end", () => {
    const reply = (s, o) => { res.writeHead(s, { "content-type": "application/json" }); res.end(JSON.stringify(o)); };
    if (req.url === "/supported") return reply(200, { kinds: [...EVM_KINDS.map((network) => ({ x402Version: 2, scheme: "exact", network })), { x402Version: 2, scheme: "upto", network: "eip155:8453" }, ...NON_EVM_KINDS], extensions: [], signers: {} });
    if (req.url === "/rpc") return reply(200, { jsonrpc: "2.0", id: 1, result: "0x0" });
    reply(404, {});
  });
});
await new Promise((r) => fac.listen(0, "127.0.0.1", r));
const F = `http://127.0.0.1:${fac.address().port}`;
const env = { ...process.env };
for (const k of ["TARGET_URL", "SOLVADOR_KEY", "ROBINHOOD_RELAYER_KEY", "NETWORK_PRICE_FLOORS", "NETWORK_PRICE_PREMIUMS", "MPP_CHALLENGE_NETWORKS", "ACCEPT_OUTPUT_SCHEMA", "TEMPO_API_KEY", "CIRCLE_FACILITATOR_API_KEY", "PAYMENT_REQUIRED_BODY", "PAYMENT_REQUIRED_COMPACT"]) delete env[k];
proc = spawn(process.execPath, ["--import", "./scripts/lib/loopback-only-preload.js", "src/server.js"], {
  env: {
    ...env, ...ownStoreEnv("real-clients"), PORT: "0", FREE_MODE: "", NODE_ENV: "test", BASE_URL: "https://agent402.test", RAILS_TEST_GRADUATE: "ink",
    WALLET_ADDRESS: "0x000000000000000000000000000000000000dEaD", NETWORK: "base",
    PAYMENT_NETWORKS: "base,polygon,arbitrum,monad,celo,avalanche,sei,optimism,ink,robinhood,solana,stellar,algorand", X402_UPTO_NETWORKS: "eip155:8453",
    CELO_FACILITATOR_KEY: "real-clients-placeholder", SOLVADOR_KEY: "real-clients-placeholder", SOLVADOR_FACILITATOR_URL: F,
    SOLANA_WALLET_ADDRESS: "9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM", STELLAR_WALLET_ADDRESS: "GAAZI4TCR3TY5OJHCTJC2A4QSY6CJWJH5IAJTGKIN2ER7LBNVKOCCWN7",
    STELLAR_FACILITATOR_URL: F, STELLAR_FACILITATOR_KEY: "real-clients-placeholder", ALGORAND_WALLET_ADDRESS: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAY5HFKQ", ALGORAND_FACILITATOR_URL: F,
    FACILITATOR_URL: F, PAYAI_FACILITATOR_URL: F, INK_FACILITATOR_URL: F, CELO_FACILITATOR_URL: F, MONAD_FACILITATOR_URL: F, ROBINHOOD_FACILITATOR_URL: F, AGENT402_BASE_RPC: `${F}/rpc`,
    CDP_API_KEY_ID: "", CDP_API_KEY_SECRET: "", PAYAI_API_KEY_ID: "", PAYAI_API_KEY_SECRET: "", MPP_SECRET_KEY: "real-clients-test-secret", FACILITATOR_GAS_CHECK: "off",
    BASE_BUILDER_CODE: "agent402",
    STATS_ALLOW_EPHEMERAL: "true", X402_INDEX_CRAWL: "off", MPP_INDEX_CRAWL: "off", MONITOR_SCHEDULER: "off", FREE_ALERTS: "off", FOLLOWUPS: "off", REVENUE_WARMUP: "off", REVENUE_LEDGER: "off",
    X_BEARER_TOKEN: "real-clients-placeholder", NEYNAR_API_KEY: "real-clients-placeholder", EXA_API_KEY: "real-clients-placeholder", TYPESAFE_API_KEY: "real-clients-placeholder", RUGCHECK_TOOLS: "on", OPENROUTER_TTS_ENABLED: "true",
  },
  stdio: ["ignore", "pipe", "pipe"],
});
let serverLog = "";
const port = await new Promise((resolve) => {
  const read = (d) => { serverLog = (serverLog + d).slice(-8000); const m = /listening on :(\d+)/.exec(serverLog); if (m) resolve(Number(m[1])); };
  proc.stdout.on("data", read); proc.stderr.on("data", read);
  proc.once("exit", () => resolve(0));
  setTimeout(() => resolve(0), 120_000);
});
const B = port ? `http://127.0.0.1:${port}` : null;
let up = false;
for (let i = 0; B && i < 240 && !up; i++) { try { up = (await fetch(`${B}/health`)).ok; } catch {} if (!up) await sleep(500); }
ok(up, "the paid server booted with every rail a local stub stands in for");
if (!up) { console.log(serverLog.slice(-2000)); process.exit(1); }

// Every priced route's default 402, read with a raised limit: the header as
// sent, and the longest line of the whole head.
const rawRead = (path, method, headers = {}) => new Promise((resolve, reject) => {
  const q = request(`${B}${path}`, { method, headers: { ...(method === "POST" ? { "content-type": "application/json" } : {}), "user-agent": CUSTOM_UA, ...headers }, maxHeaderSize: 262144, timeout: 30_000 }, (r) => {
    r.resume();
    r.on("end", () => {
      const pairs = []; for (let i = 0; i < r.rawHeaders.length; i += 2) pairs.push([r.rawHeaders[i], r.rawHeaders[i + 1]]);
      resolve({ status: r.statusCode, pairs, pr: r.headers["payment-required"] || null });
    });
  });
  q.on("timeout", () => q.destroy(new Error("timeout"))); q.on("error", reject);
  if (method === "POST") q.write(/^\/v1\//.test(path) ? GW : "{}");
  q.end();
});
const pricing = await (await fetch(`${B}/api/pricing`)).json();
const endpoints = (pricing.endpoints || []).map((e) => ({ path: e.path, method: e.method || "GET", slug: e.slug || e.path }));
const measured = [];
{
  const q = [...endpoints];
  await Promise.all(Array.from({ length: 8 }, async () => {
    while (q.length) {
      const e = q.shift();
      let r; try { r = await rawRead(e.path, e.method); } catch { continue; }
      if (r.status !== 402 || !r.pr) continue;
      const longest = Math.max(...r.pairs.map(([k, v]) => lineBytes(k, v)));
      // The 402 a line-capped client asks for, on the same route.
      let compactLongest = null;
      try { const c = await rawRead(e.path, e.method, { [COMPACT_REQUEST_HEADER]: "1" }); if (c.status === 402) compactLongest = Math.max(...c.pairs.map(([k, v]) => lineBytes(k, v))); } catch { /* counted below */ }
      measured.push({ ...e, pr: r.pr, prLine: lineBytes("PAYMENT-REQUIRED", r.pr), longest, compactLongest, head: headBytes(r.pairs) });
    }
  }));
}
ok(measured.length >= 400, `${measured.length} priced routes answered a 402 with PAYMENT-REQUIRED`);
// The routes the clients read: the four largest PAYMENT-REQUIRED lines, the
// two largest heads, and the smallest line (a route whose header fits).
const byLine = [...measured].sort((a, b) => b.prLine - a.prLine);
const byHead = [...measured].sort((a, b) => b.head - a.head);
const chosen = [...new Map([...byLine.slice(0, 4), ...byHead.slice(0, 2), byLine.at(-1)].map((e) => [`${e.method} ${e.path}`, e])).values()];
console.log(`   routes read by every client: ${chosen.map((e) => `${e.slug} (line ${e.prLine}, head ${e.head})`).join(", ")}`);
const over = measured.filter((e) => e.longest > AIOHTTP_DEFAULT_LINE_BYTES);
console.log(`   ${over.length} of ${measured.length} default 402s have a header line over ${AIOHTTP_DEFAULT_LINE_BYTES} bytes (every one is PAYMENT-REQUIRED: ${over.every((e) => e.prLine === e.longest)})`);
ok(over.every((e) => e.prLine === e.longest), `the only header line over ${AIOHTTP_DEFAULT_LINE_BYTES} bytes on any default 402 is PAYMENT-REQUIRED (a line-capped client's way around it is the compact header)`);
const compactOver = measured.filter((e) => !(e.compactLongest > 0 && e.compactLongest <= AIOHTTP_DEFAULT_LINE_BYTES));
ok(compactOver.length === 0, `with ${COMPACT_REQUEST_HEADER}: 1, every header line of every route's 402 is ${AIOHTTP_DEFAULT_LINE_BYTES} bytes or less (longest ${Math.max(...measured.map((e) => e.compactLongest || 0))})${compactOver.length ? `: ${compactOver.slice(0, 3).map((e) => `${e.slug} ${e.compactLongest ?? "unread"}`).join(", ")}` : ""}`);
const asReq = (e, headers = {}) => ({ method: e.method, url: `${B}${e.path}`, headers: { ...(e.method === "POST" ? { "content-type": "application/json" } : {}), ...headers }, body: e.method === "POST" ? (/^\/v1\//.test(e.path) ? GW : "{}") : null });

// ---------------------------------------------------------------------------
// Full-header clients: the default header, byte for byte
// ---------------------------------------------------------------------------
for (const kind of ["httpx", "requests", "undici", "go"]) {
  const run = await clientRun(kind, chosen.map((e) => asReq(e)));
  if (!run) continue;
  const bad = run.results.map((r, i) => ({ r, e: chosen[i] })).filter(({ r, e }) => !(r.status === 402 && r.pr === e.pr));
  ok(bad.length === 0, `${kind} ${run.version} reads every 402 at its defaults, PAYMENT-REQUIRED byte for byte${bad.length ? ` (${bad.slice(0, 2).map(({ r, e }) => `${e.slug}: ${r.err || `status ${r.status}, header ${r.pr ? r.pr.length : "none"} vs ${e.pr.length}`}`).join("; ")})` : ""}`);
}

// ---------------------------------------------------------------------------
// aiohttp: its own User-Agent, the flag, and the line measure
// ---------------------------------------------------------------------------
/** A header a line-capped client got: the full one when that fits, else the
 *  compact one (Base exact first, resource and Bazaar extension untouched). */
function compactOk(got, full) {
  if (typeof got !== "string") return false;
  if (lineBytes("PAYMENT-REQUIRED", got) > AIOHTTP_DEFAULT_LINE_BYTES) return false;
  if (lineBytes("PAYMENT-REQUIRED", full) <= AIOHTTP_DEFAULT_LINE_BYTES) return got === full;
  const c = dec(got), f = dec(full);
  return c.compact?.fullOfferIn === FULL_OFFER_IN && c.accepts?.[0]?.network === "eip155:8453" && c.accepts[0].scheme === "exact"
    && JSON.stringify(c.resource) === JSON.stringify(f.resource) && JSON.stringify(c.extensions?.bazaar) === JSON.stringify(f.extensions?.bazaar);
}
{
  const own = await clientRun("aiohttp", chosen.map((e) => asReq(e)));
  if (own) {
    const bad = own.results.map((r, i) => ({ r, e: chosen[i] })).filter(({ r, e }) => !(r.status === 402 && compactOk(r.pr, e.pr)));
    ok(bad.length === 0, `aiohttp ${own.version} at its own User-Agent reads every 402 (the compact header where the full one is over its line limit)${bad.length ? ` (${bad.slice(0, 2).map(({ r, e }) => `${e.slug}: ${r.err || r.status}`).join("; ")})` : ""}`);
    const flagged = await clientRun("aiohttp", chosen.map((e) => asReq(e, { "User-Agent": CUSTOM_UA, [COMPACT_REQUEST_HEADER]: "1" })));
    const badF = flagged.results.map((r, i) => ({ r, e: chosen[i] })).filter(({ r, e }) => !(r.status === 402 && compactOk(r.pr, e.pr)));
    ok(badF.length === 0, `aiohttp with another User-Agent reads every 402 when it sends ${COMPACT_REQUEST_HEADER}: 1${badF.length ? ` (${badF.slice(0, 2).map(({ r, e }) => `${e.slug}: ${r.err || r.status}`).join("; ")})` : ""}`);
    // Without the flag: readable exactly when every line is within the limit.
    const plain = await clientRun("aiohttp", chosen.map((e) => asReq(e, { "User-Agent": CUSTOM_UA })));
    const wrong = plain.results.map((r, i) => ({ r, e: chosen[i] })).filter(({ r, e }) => {
      const fits = e.longest <= AIOHTTP_DEFAULT_LINE_BYTES;
      return fits ? !(r.status === 402 && r.pr === e.pr) : !(r.err && /8190/.test(r.err));
    });
    ok(wrong.length === 0, `aiohttp with another User-Agent and no flag reads a 402 exactly when every \`name: value\` line is ${AIOHTTP_DEFAULT_LINE_BYTES} bytes or less (${chosen.filter((e) => e.longest > AIOHTTP_DEFAULT_LINE_BYTES).length} of ${chosen.length} over)${wrong.length ? `: ${wrong.slice(0, 2).map(({ r, e }) => `${e.slug} line ${e.longest}: ${r.err || r.status}`).join("; ")}` : ""}`);
    ok(chosen.some((e) => e.longest <= AIOHTTP_DEFAULT_LINE_BYTES) && chosen.some((e) => e.longest > AIOHTTP_DEFAULT_LINE_BYTES), "control: the routes read include one whose header fits the line limit and one whose header does not");
  }
}

// ---------------------------------------------------------------------------
// The 16,200-byte head ceiling, read by real clients
// ---------------------------------------------------------------------------
// A 402 shaped like production's largest (a PAYMENT-REQUIRED line of 10,491
// bytes and a WWW-Authenticate of 3,457, measured 2026-11-20), padded with
// further headers to an exact head size by test-challenge-size's count.
function synthetic402(totalHead) {
  const pairs = [["Content-Type", "application/json"], ["PAYMENT-REQUIRED", "A".repeat(10_491 - "PAYMENT-REQUIRED: ".length)], ["WWW-Authenticate", `Payment ${"b".repeat(3_457 - "WWW-Authenticate: Payment ".length)}`], ["Content-Length", "2"], ["Connection", "close"]];
  for (let i = 0; headBytes(pairs) < totalHead; i++) {
    const room = totalHead - headBytes(pairs);
    const name = `X-Pad-${i}`;
    const len = Math.min(1000, room - name.length - 4);
    pairs.push([name, "p".repeat(Math.max(1, len))]);
  }
  return { pairs, head: headBytes(pairs) };
}
const synthAt = { ceiling: synthetic402(MAX_TOTAL_HEADER_BYTES), over: synthetic402(MAX_TOTAL_HEADER_BYTES + 500) };
ok(synthAt.ceiling.head === MAX_TOTAL_HEADER_BYTES && synthAt.over.head === MAX_TOTAL_HEADER_BYTES + 500, `the synthetic heads measure ${synthAt.ceiling.head} and ${synthAt.over.head} bytes by test-challenge-size's count`);
synth = createServer((sock) => {
  let buf = "";
  sock.on("data", (d) => {
    buf += d;
    const end = buf.indexOf("\r\n\r\n");
    if (end < 0) return;
    const line = buf.slice(0, buf.indexOf("\r\n"));
    buf = "";
    const which = /\/over\b/.test(line) ? synthAt.over : synthAt.ceiling;
    sock.write(`HTTP/1.1 402 Payment Required\r\n${which.pairs.map(([k, v]) => `${k}: ${v}\r\n`).join("")}\r\n{}`);
    sock.end();
  });
  sock.on("error", () => {});
});
await new Promise((r) => synth.listen(0, "127.0.0.1", r));
const S = `http://127.0.0.1:${synth.address().port}`;
const synthPR = synthAt.ceiling.pairs.find(([k]) => k === "PAYMENT-REQUIRED")[1];
for (const kind of ["httpx", "requests", "undici", "go"]) {
  const run = await clientRun(kind, [{ method: "GET", url: `${S}/ceiling`, headers: {}, body: null }, { method: "GET", url: `${S}/over`, headers: {}, body: null }]);
  if (!run) continue;
  const [atCeiling, overCeiling] = run.results;
  ok(atCeiling.status === 402 && atCeiling.pr === synthPR, `${kind} reads a 402 whose head is at the ${MAX_TOTAL_HEADER_BYTES}-byte ceiling${atCeiling.err ? ` (${atCeiling.err})` : ""}`);
  if (kind === "undici") ok(!overCeiling.status && !!overCeiling.err, `control: ${kind} refuses a head ${synthAt.over.head - MAX_TOTAL_HEADER_BYTES} bytes over the ceiling (the synthetic sits where its 16 KB limit bites)${overCeiling.err ? ` (${overCeiling.err.slice(0, 80)})` : ` (got ${overCeiling.status})`}`);
}

// ---------------------------------------------------------------------------
if (missing.length) {
  const note = `client(s) not installed: ${[...new Set(missing)].join("; ")}`;
  if (IN_CI) ok(false, `${note} (every client is required under CI)`);
  else console.log(`SKIPPED (not CI): ${note}`);
}
stop();
console.log(`${failed ? "FAILED" : "OK"}: ${pass} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
