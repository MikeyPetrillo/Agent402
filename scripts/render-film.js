#!/usr/bin/env node
// Renders the product film and the per-tool clips OFFLINE, frame by frame:
// each scene is one self-contained HTML document whose window.renderAt(t)
// draws time t, rasterized by the server's own sandboxed frame renderer
// (renderHtmlFrames in src/tools/render.js: network refused, fonts inlined)
// and encoded with FFmpeg (H.264, yuv420p, faststart).
//
// What it reads: a FREE_MODE boot of this tree (or TARGET_URL) for the catalog
// (/api/pricing, /openapi.json: names, catalog prices, published examples) and
// whether the server signs receipts (/.well-known/agent402-receipt-key.json);
// src/rails.js for the chain names. Nothing is invented: every price, request
// and answer on screen is the catalog's own. No cost or revenue figure.
//
// Captions are drawn into the frames and written beside each video as WebVTT.
// There is no voiceover: the speech tools are model-backed and paid per call,
// and this script spends nothing.
//
// Output (default dist/media/, gitignored: large media is published as a
// release asset, never committed):
//   agent402-film.mp4 + .vtt + -poster.png   the product film, 1280x720
//   clip-<slug>.mp4 + .vtt                   a short clip per tool
//   agent402-call.gif                        the paid-call scene as a GIF
//                                            (copy to docs/media/ for the READMEs)
//
//   node scripts/render-film.js                       (boots its own server)
//   node scripts/render-film.js --only=film|clips|gif --fps=24 --out=dist/media
//   node scripts/render-film.js --receipts=sign       (its boot signs receipts with a throwaway key)
//   TARGET_URL=http://127.0.0.1:3000 node scripts/render-film.js
import "./lib/offline-stores.js"; // per-process and file backends whatever the caller exports (see the file)
import { spawn, execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { generateKeyPairSync } from "node:crypto";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { ownStoreEnv } from "./lib/own-stores.js";
import { RAILS } from "../src/rails.js";
import { CATEGORY_LINE, SUPPORT_LINE } from "../src/positioning.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const arg = (k, d) => { const a = process.argv.find((x) => x.startsWith(`--${k}=`)); return a ? a.slice(k.length + 3) : d; };
const FPS = Number(arg("fps", "24"));
// --out: a relative path is read from the repository root; an absolute path
// is used as given (never joined under the repository).
export function outDirOf(value, root = ROOT) { return resolve(root, String(value || "dist/media")); }
const OUT = outDirOf(arg("out", "dist/media"));
const ONLY = arg("only", "");
const CLIP_SLUGS = arg("clips", "answer,search,whois,uuid").split(",").filter(Boolean);
const W = 1280, H = 720;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---- the scene documents ---------------------------------------------------
const font = (file) => readFileSync(join(ROOT, "assets/fonts", file)).toString("base64");
const FONTS = `
@font-face{font-family:G;font-weight:400;src:url(data:font/woff2;base64,${font("geist-400-latin.woff2")}) format("woff2")}
@font-face{font-family:G;font-weight:600;src:url(data:font/woff2;base64,${font("geist-600-latin.woff2")}) format("woff2")}
@font-face{font-family:M;font-weight:400;src:url(data:font/woff2;base64,${font("geist-mono-400-latin.woff2")}) format("woff2")}
@font-face{font-family:S;font-weight:400;src:url(data:font/woff2;base64,${font("instrument-serif-400-latin.woff2")}) format("woff2")}`;
// DESIGN.md palette: the obsidian panel, its ink and the lit accent.
const STYLE = `${FONTS}
*{margin:0;padding:0;box-sizing:border-box}
html,body{width:${W}px;height:${H}px;overflow:hidden;background:#0C0D0F;color:#E9EAEC;font-family:G,sans-serif}
.l{position:absolute;opacity:0;will-change:opacity,transform}
.mark{left:64px;top:48px;font-family:M;font-size:20px;letter-spacing:.14em;text-transform:uppercase;color:#9AA1A9}
.mark b{color:#9EF0B0;font-weight:400}
.serif{font-family:S;font-weight:400;letter-spacing:-.01em;line-height:1.02}
.mono{font-family:M}
.cap{left:0;right:0;bottom:44px;text-align:center;font-size:28px;line-height:1.3;color:#E9EAEC}
.cap span{display:inline-block;background:rgba(12,13,15,.86);padding:8px 18px;border-radius:4px}
.term{left:64px;top:150px;width:700px;height:430px;border:1px solid #24282C;background:#16191D;border-radius:4px;padding:22px 24px;font-family:M;font-size:19px;line-height:1.55;color:#C9CED3;overflow:hidden}
.term .ln{white-space:pre;opacity:0}
.k{color:#9AA1A9}.ok{color:#9EF0B0}.warn{color:#E0A040}.v{color:#A78BFA}
.rail{left:812px;top:150px;width:400px}
.st{display:flex;align-items:center;gap:18px;height:68px}
.dot{width:34px;height:34px;border-radius:50%;border:2px solid #353B41;display:flex;align-items:center;justify-content:center;font-family:M;font-size:15px;color:#868D95;flex:none}
.st .t{font-family:M;font-size:15px;letter-spacing:.14em;text-transform:uppercase;color:#868D95}
.st .d{font-family:M;font-size:18px;color:#868D95;margin-top:3px}
.st.on .dot{background:#9EF0B0;border-color:#9EF0B0;color:#0B0C0E}
.st.on .t{color:#9EF0B0}.st.on .d{color:#E9EAEC}
.grid{left:64px;top:200px;width:1152px;display:grid;grid-template-columns:repeat(4,1fr);gap:12px}
.cell{border:1px solid #24282C;background:#16191D;border-radius:4px;padding:14px 16px;opacity:0}
.cell .n{font-size:18px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.cell .p{font-family:M;font-size:16px;color:#9EF0B0;margin-top:6px}
.chains{left:64px;top:200px;width:1152px;display:flex;flex-wrap:wrap;gap:14px 14px}
.chip{font-family:M;font-size:22px;padding:10px 18px;border:1px solid #353B41;border-radius:4px;color:#E9EAEC;opacity:0}
`;

// renderAt(t): every layer's opacity and offset is a pure function of t.
// A layer is { id, from, to } in seconds; it rises in over 0.4 s from `from`
// and fades over 0.28 s before `to` (the site's --dur-slow and --dur-slow-exit).
const RUNTIME = `
const ease = (x) => 1 - Math.pow(1 - Math.min(1, Math.max(0, x)), 3);
function show(el, t, from, to, rise) {
  const a = ease((t - from) / 0.4) * (to == null ? 1 : 1 - ease((t - (to - 0.28)) / 0.28));
  el.style.opacity = String(a);
  el.style.transform = rise ? 'translateY(' + ((1 - ease((t - from) / 0.4)) * 14).toFixed(2) + 'px)' : '';
}
window.renderAt = async (t) => {
  for (const L of window.LAYERS) show(document.getElementById(L.id), t, L.from, L.to, L.rise !== false);
  for (const S of window.STEPS) document.getElementById(S.id).classList.toggle('on', t >= S.at);
  if (document.fonts) await document.fonts.ready;
};`;

const esc = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
function doc(body, layers, steps = []) {
  return `<!doctype html><html><head><meta charset="utf-8"><style>${STYLE}</style></head><body>${body}<script>window.LAYERS=${JSON.stringify(layers)};window.STEPS=${JSON.stringify(steps)};${RUNTIME}</script></body></html>`;
}
const brand = () => `<div class="l mark" id="mk">Agent<b>402</b></div>`;

// The captions of a scene list, as both burned-in layers and WebVTT cues.
function captions(list) {
  const html = list.map((c, i) => `<div class="l cap" id="cap${i}"><span>${esc(c.text)}</span></div>`).join("");
  const layers = list.map((c, i) => ({ id: `cap${i}`, from: c.from, to: c.to, rise: false }));
  return { html, layers };
}
const stamp = (s) => { const ms = Math.round(s * 1000); const p = (n, w = 2) => String(n).padStart(w, "0"); return `${p(Math.floor(ms / 3600000))}:${p(Math.floor(ms / 60000) % 60)}:${p(Math.floor(ms / 1000) % 60)}.${p(ms % 1000, 3)}`; };
export const vtt = (list) => `WEBVTT\n\n${list.map((c, i) => `${i + 1}\n${stamp(c.from)} --> ${stamp(c.to)}\n${c.text}\n`).join("\n")}`;

// The paid call, the film's middle scene and the GIF: a terminal on the left,
// the six steps on the right lighting in turn.
function callScene({ t0, tool, price, chains, example, receipts, query }) {
  const beat = 1.7;
  const curlPath = `${tool.path}${query ? `?${query}` : ""}`;
  const reqLine = `${tool.method} ${curlPath}`;
  const json = JSON.stringify(example ?? {}, null, 2).split("\n").slice(0, 5);
  if (JSON.stringify(example ?? {}, null, 2).split("\n").length > 5) json.push("  …");
  const lines = [
    [0, `<span class="k">$</span> curl "agent402.tools${esc(curlPath.length > 32 ? `${curlPath.slice(0, 31)}…` : curlPath)}"`],
    [1, `<span class="warn">HTTP 402</span> Payment Required`],
    [1, `<span class="k">price</span> ${esc(price)} USDC <span class="k">on</span> ${chains} chains`],
    [2, `<span class="k">PAYMENT-SIGNATURE:</span> <span class="v">signed for ${esc(price)}</span>`],
    [3, `<span class="k">settled on</span> Base`],
    [4, `<span class="ok">HTTP 200</span> OK`],
    ...json.map((l) => [4, esc(l.length > 52 ? `${l.slice(0, 51)}…` : l)]),
    ...(receipts ? [[5, `<span class="k">Agent402-Receipt:</span> <span class="v">EdDSA, signed</span>`]] : []),
  ];
  const names = [["Request", reqLine.length > 30 ? tool.path : reqLine], ["402", `${price} USDC`], ["Sign", "PAYMENT-SIGNATURE"], ["Settle", `on ${chains} chains`], ["Answer", "200 OK"], ...(receipts ? [["Receipt", "Agent402-Receipt"]] : [])];
  const body = `<div class="l term" id="term">${lines.map(([, h], i) => `<div class="ln" id="ln${t0}_${i}">${h}</div>`).join("")}</div>
<div class="l rail" id="rail">${names.map(([k, d], i) => `<div class="st" id="st${i}"><span class="dot">${i + 1}</span><div><div class="t">${esc(k)}</div><div class="d">${esc(d)}</div></div></div>`).join("")}</div>`;
  const layers = [{ id: "term", from: t0, to: null }, { id: "rail", from: t0, to: null }, ...lines.map(([s], i) => ({ id: `ln${t0}_${i}`, from: t0 + 0.3 + s * beat + (i % 7) * 0.06, to: null, rise: false }))];
  const steps = names.map((_, i) => ({ id: `st${i}`, at: t0 + 0.3 + i * beat }));
  const caps = [
    "An agent calls a tool: one HTTP request, no account.",
    `The server answers 402 with the exact price: ${price}.`,
    "The agent's wallet signs for exactly that amount.",
    "The payment settles on chain.",
    "The answer comes back as JSON.",
    ...(receipts ? ["A signed receipt ties the payment to the answer."] : []),
  ].map((text, i) => ({ text, from: t0 + 0.3 + i * beat, to: t0 + 0.3 + (i + 1) * beat }));
  return { body, layers, steps, caps, end: t0 + 0.3 + names.length * beat + 1.2 };
}

function filmDoc(ctx) {
  const cap = [];
  let body = brand();
  const layers = [{ id: "mk", from: 0, to: null, rise: false }];
  // 1. Title.
  body += `<div class="l serif" id="h1" style="left:64px;top:230px;width:1100px;font-size:92px">${esc(CATEGORY_LINE)}</div>`;
  body += `<div class="l mono" id="h1s" style="left:64px;top:360px;font-size:24px;color:#9AA1A9">x402 &middot; MPP &middot; ${esc(SUPPORT_LINE.replace(/\.$/, ""))}</div>`;
  layers.push({ id: "h1", from: 0.2, to: 4.4 }, { id: "h1s", from: 0.8, to: 4.4 });
  cap.push({ text: "Agents find, pay for and verify paid calls over x402 and MPP.", from: 0.6, to: 4.4 });
  // 2. One paid call.
  const call = callScene({ t0: 4.6, ...ctx.call });
  body += `<div class="l" id="call">${call.body}</div><div class="l mono" id="callh" style="left:64px;top:96px;font-size:22px;color:#9EF0B0">Watch a call get paid</div>`;
  layers.push({ id: "call", from: 4.6, to: call.end, rise: false }, { id: "callh", from: 4.6, to: call.end }, ...call.layers);
  cap.push(...call.caps);
  // 3. The catalog.
  const t3 = call.end;
  body += `<div class="l serif" id="h3" style="left:64px;top:104px;font-size:58px">500+ tools</div><div class="l grid" id="grid">${ctx.tools.map((x, i) => `<div class="cell" id="c${i}"><div class="n">${esc(x.name)}</div><div class="p">${esc(x.price)}</div></div>`).join("")}</div>`;
  layers.push({ id: "h3", from: t3, to: t3 + 5.6 }, { id: "grid", from: t3, to: t3 + 5.6, rise: false }, ...ctx.tools.map((_, i) => ({ id: `c${i}`, from: t3 + 0.2 + i * 0.06, to: t3 + 5.6 })));
  cap.push({ text: "Each tool is priced per call, in the catalog and in its 402.", from: t3 + 0.2, to: t3 + 5.6 });
  // 4. The rails.
  const t4 = t3 + 5.8;
  body += `<div class="l serif" id="h4" style="left:64px;top:104px;font-size:58px">Settles where your wallet is</div><div class="l chains" id="chains">${ctx.chains.map((n, i) => `<div class="chip" id="ch${i}">${esc(n)}</div>`).join("")}</div>`;
  layers.push({ id: "h4", from: t4, to: t4 + 5.2 }, { id: "chains", from: t4, to: t4 + 5.2, rise: false }, ...ctx.chains.map((_, i) => ({ id: `ch${i}`, from: t4 + 0.2 + i * 0.06, to: t4 + 5.2 })));
  cap.push({ text: "Pay over x402 or MPP, on the chain your wallet already uses.", from: t4 + 0.2, to: t4 + 5.2 });
  // 5. End card.
  const t5 = t4 + 5.4;
  body += `<div class="l serif" id="h5" style="left:64px;top:220px;font-size:92px">agent402.tools</div><div class="l mono" id="cmd" style="left:64px;top:360px;font-size:22px;color:#C9CED3;background:#16191D;border:1px solid #24282C;border-radius:4px;padding:16px 20px">claude mcp add --transport http agent402 https://agent402.tools/mcp</div>`;
  layers.push({ id: "h5", from: t5, to: null }, { id: "cmd", from: t5 + 0.3, to: null });
  cap.push({ text: "Add it to your agent in one line.", from: t5 + 0.4, to: t5 + 4.2 });
  const capL = captions(cap);
  return { html: doc(body + capL.html, [...layers, ...capL.layers], call.steps), duration: t5 + 4.4, cues: cap, posterAt: 4.6 + 0.3 + 4 * 1.7 + 0.8 };
}

function clipDoc(c) {
  let body = brand();
  const layers = [{ id: "mk", from: 0, to: null, rise: false }];
  body += `<div class="l" id="ttl" style="left:64px;top:92px;font-size:30px;font-weight:600;width:1150px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${esc(c.tool.name)} <span class="mono" style="color:#9EF0B0;font-weight:400;font-size:24px">${esc(c.price)} per call</span>${c.tool.modelBacked ? ` <span class="mono" style="color:#9AA1A9;font-weight:400;font-size:20px">· model-backed</span>` : ""}</div>`;
  layers.push({ id: "ttl", from: 0.1, to: null });
  const call = callScene({ t0: 0.4, ...c });
  body += call.body;
  layers.push(...call.layers);
  const capL = captions(call.caps);
  return { html: doc(body + capL.html, [...layers, ...capL.layers], call.steps), duration: call.end, cues: call.caps };
}

// ---- render and encode -------------------------------------------------------
async function renderVideo(name, built, { renderHtmlFrames }) {
  const dir = mkdtempSync(join(tmpdir(), `a402-film-${name}-`));
  const total = Math.round(built.duration * FPS);
  const times = Array.from({ length: total }, (_, i) => +(i / FPS).toFixed(4));
  let n = 0;
  for (let i = 0; i < times.length; i += 12) {
    const r = await renderHtmlFrames(built.html, times.slice(i, i + 12), { width: W, height: H });
    for (const f of r.frames) writeFileSync(join(dir, `${String(n++).padStart(5, "0")}.png`), Buffer.from(f.pngBase64, "base64"));
    process.stdout.write(`\r${name}: ${n}/${total} frames`);
  }
  process.stdout.write("\n");
  const mp4 = join(OUT, `${name}.mp4`);
  execFileSync("ffmpeg", ["-y", "-loglevel", "error", "-framerate", String(FPS), "-i", join(dir, "%05d.png"), "-c:v", "libx264", "-preset", "slow", "-tune", "animation", "-crf", "30", "-pix_fmt", "yuv420p", "-movflags", "+faststart", mp4]);
  writeFileSync(join(OUT, `${name}.vtt`), vtt(built.cues));
  return { dir, mp4 };
}

async function main() {
  mkdirSync(OUT, { recursive: true });
  let proc = null, BASE = process.env.TARGET_URL || null;
  if (!BASE) {
    // --receipts=sign: the boot signs receipts with a throwaway key made here and
    // never stored, as production does with its own, so the receipt step shows.
    const signing = arg("receipts", "") === "sign" ? (() => {
      const { privateKey } = generateKeyPairSync("ed25519");
      return { RECEIPT_SIGNING_KEY: Buffer.from(privateKey.export({ type: "pkcs8", format: "pem" })).toString("base64"), RECEIPT_SIGNING_KEY_ID: "film-local" };
    })() : {};
    proc = spawn(process.execPath, [join(ROOT, "src", "server.js")], { cwd: ROOT, env: { ...process.env, ...ownStoreEnv("film"), ...signing, FREE_MODE: "true", PORT: "0", X402_SYNC_ON_START: "false", X402_INDEX_CRAWL: "off", MPP_INDEX_CRAWL: "off" }, stdio: ["ignore", "pipe", "ignore"] });
    let log = "";
    proc.stdout.on("data", (d) => { if (!BASE) log = (log + d).slice(-20_000); });
    for (let i = 0; i < 180 && !BASE; i++) { const m = log.match(/listening on :(\d+)/); if (m) BASE = `http://127.0.0.1:${m[1]}`; else await sleep(500); }
    if (!BASE) throw new Error("server never printed its port");
  }
  try {
    const pricing = await (await fetch(`${BASE}/api/pricing`)).json();
    const spec = await (await fetch(`${BASE}/openapi.json`)).json();
    const keyDoc = await fetch(`${BASE}/.well-known/agent402-receipt-key.json`).then((r) => (r.ok ? r.json() : null)).catch(() => null);
    const receipts = !!(keyDoc && keyDoc.signing === true);
    const endpoints = pricing.endpoints || [];
    const chains = RAILS.length;
    const ex = (t) => {
      const op = spec.paths?.[t.path]?.[t.method.toLowerCase()];
      const c = op?.responses?.["200"]?.content || {};
      const example = (c["application/json"] || Object.values(c)[0] || {}).example;
      const q = (op?.parameters || []).filter((p) => p.in === "query" && p.example != null).slice(0, 1).map((p) => `${p.name}=${encodeURIComponent(p.example)}`).join("&");
      return { example, query: q };
    };
    const priceOf = (t) => String(t.price || "").replace(/^from /, "");
    const uuid = endpoints.find((t) => t.slug === "uuid");
    const callTool = uuid || endpoints[0];
    // A fixed, readable sample of the catalog: the shortest names of the first
    // tool in each category, in catalog order (deterministic).
    const seen = new Set(), sample = [];
    for (const t of endpoints) { if (seen.has(t.category) || t.name.length > 28) continue; seen.add(t.category); sample.push({ name: t.name, price: t.price }); if (sample.length === 16) break; }
    const ctx = { call: { tool: callTool, price: priceOf(callTool), chains, receipts, ...ex(callTool) }, tools: sample, chains: RAILS.map((r) => r.name) };
    const { renderHtmlFrames } = await import("../src/tools/render.js");
    const sizes = [];
    if (!ONLY || ONLY === "film" || ONLY === "gif") {
      const film = filmDoc(ctx);
      if (!ONLY || ONLY === "film") {
        const { dir, mp4 } = await renderVideo("agent402-film", film, { renderHtmlFrames });
        const poster = join(OUT, "agent402-film-poster.png");
        execFileSync("cp", [join(dir, `${String(Math.round(film.posterAt * FPS)).padStart(5, "0")}.png`), poster]);
        sizes.push(mp4, join(OUT, "agent402-film.vtt"), poster);
        rmSync(dir, { recursive: true, force: true });
      }
      if (!ONLY || ONLY === "gif") {
        // The paid-call scene alone, as a small looping GIF for the READMEs.
        const c = clipDoc({ tool: callTool, price: priceOf(callTool), chains, receipts, ...ex(callTool) });
        const { dir } = await renderVideo("agent402-call", c, { renderHtmlFrames });
        const gif = join(OUT, "agent402-call.gif");
        execFileSync("ffmpeg", ["-y", "-loglevel", "error", "-framerate", String(FPS), "-i", join(dir, "%05d.png"), "-vf", "fps=10,scale=720:-1:flags=lanczos,split[a][b];[a]palettegen=max_colors=48:stats_mode=diff[p];[b][p]paletteuse=dither=none:diff_mode=rectangle", "-loop", "0", gif]);
        sizes.push(gif);
        rmSync(dir, { recursive: true, force: true });
      }
    }
    if (!ONLY || ONLY === "clips") {
      for (const slug of CLIP_SLUGS) {
        const t = endpoints.find((x) => x.slug === slug);
        if (!t) { console.log(`no tool ${slug}; skipped`); continue; }
        const { dir, mp4 } = await renderVideo(`clip-${slug}`, clipDoc({ tool: t, price: priceOf(t), chains, receipts, ...ex(t) }), { renderHtmlFrames });
        sizes.push(mp4, join(OUT, `clip-${slug}.vtt`));
        rmSync(dir, { recursive: true, force: true });
      }
    }
    for (const f of sizes) console.log(`${(statSync(f).size / 1024).toFixed(1).padStart(8)} KB  ${f.replace(ROOT + "/", "")}`);
    console.log(`receipts ${receipts ? "signed (receipt step shown)" : "off on this server (receipt step left out)"}; captions only, no voiceover`);
  } finally {
    if (proc) proc.kill("SIGKILL");
  }
  process.exit(0);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main().catch((e) => { console.error(e); process.exit(1); });
