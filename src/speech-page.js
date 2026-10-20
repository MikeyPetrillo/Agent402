// /speech: the speech tools in one place: text to speech (the tts tiers and
// the OpenAI-shaped /v1/audio/speech wire) and audio to text (the transcribe
// tiers and the OpenAI-shaped transcription wire). Every one is model-backed
// and the page says so.
//
// Nothing about a tier is typed here. Routes, prices and example answers come
// from the tool definitions (the catalog passed in, which also says which of
// them this instance serves); models, caps, voices, formats and the fallback
// order come from the kits' own tables (src/tools/tts-kit.js,
// src/tools/stt-kit.js, src/tools/llm-gateway-kit.js). A table that changes
// changes this page with it.
import { ledgerShell, ledgerFooterCompact, esc, breadcrumbLd } from "./ledger-chrome.js";
import { TTS_TOOLS, TTS_TIERS, VOICES, FORMATS, LITE_FORMATS, ELEVENLABS_VOICE_MAP, ELEVENLABS_VOICES, TTS_BACKUP_MODELS, TTS_DEADLINE_MS } from "./tools/tts-kit.js";
import { STT_TOOLS, STT_TIERS, DIARIZE_MODEL, MAX_AUDIO_BYTES } from "./tools/stt-kit.js";
import { SPEECH_MODELS, SPEECH_PATH, SPEECH_MAX_CHARS, SPEECH_FORMATS, OPENAI_SPEECH_VOICES } from "./tools/llm-gateway-kit.js";
import { ORG_SAME_AS } from "./repo-link.js";

const listAnd = (xs) => (xs.length <= 1 ? xs.join("") : xs.length === 2 ? `${xs[0]} and ${xs[1]}` : `${xs.slice(0, -1).join(", ")} and ${xs.at(-1)}`);
const fmtInt = (n) => Number(n).toLocaleString("en-US");

const TOC = [
  ["#tts", "Text to speech"],
  ["#voices", "Voices and formats"],
  ["#fallback", "What the fallback chain means"],
  ["#stt", "Audio to text"],
  ["#wire", "The OpenAI-shaped wires"],
  ["#pay", "Paying and failed calls"],
];

const mono = "font-family:var(--font-mono);";
const eyebrow = (t, lit = false) => `<div style="${mono}font-size:var(--fs-sm);color:var(--${lit ? "accent-lit" : "accent"});margin-bottom:12px;">${esc(t)}</div>`;
const h2 = (t, panel = false) => `<h2 style="font-weight:700;font-size:var(--fs-3xl);line-height:1.02;letter-spacing:-.025em;margin:0 0 20px;color:var(--${panel ? "on-panel" : "ink"});">${t}</h2>`;
const h3 = (t) => `<h3 style="font-weight:600;font-size:var(--fs-xl);margin:28px 0 10px;color:var(--ink);">${t}</h3>`;
const p = (t) => `<p style="font-size:var(--fs-lg);line-height:1.65;color:var(--muted);max-width:820px;margin:0 0 18px;">${t}</p>`;
const link = (href, t) => `<a href="${esc(href)}" style="color:var(--ink);text-decoration:none;border-bottom:1px solid var(--accent);">${t}</a>`;
const code = (t) => `<code style="${mono}font-size:var(--fs-code-inline);color:var(--ink);">${esc(t)}</code>`;
const chip = (t) => `<span style="display:inline-block;padding:4px 9px;border:1px solid var(--hairline);border-radius:var(--radius);background:var(--chip-bg);${mono}font-size:var(--fs-sm);color:var(--ink);white-space:nowrap;">${esc(t)}</span>`;
const pre = (label, s) => `<div style="border:1px solid var(--hairline);background:var(--panel);max-width:820px;margin:0 0 22px;">
    <div style="padding:10px 18px;border-bottom:1px solid var(--panel-rule-2);${mono}font-size:var(--fs-2xs);letter-spacing:.06em;color:var(--on-panel-dim);">${esc(label)}</div>
    <pre style="margin:0;padding:18px;${mono}font-size:var(--fs-xs);line-height:1.8;color:var(--on-panel);white-space:pre-wrap;word-break:break-word;">${esc(s)}</pre>
  </div>`;
const section = (id, inner, wide = false) => `<section id="${id}" style="max-width:${wide ? 1180 : 900}px;margin:0 auto;padding:64px 30px 0;">${inner}</section>`;
const th = (t, right = false) => `<th scope="col" style="text-align:${right ? "right" : "left"};font-weight:700;padding:13px 18px;">${esc(t)}</th>`;
const table = (cols, rows) => `<div class="sp-scroll"><table style="font-size:var(--fs-base);border:1px solid var(--hairline);background:var(--card);border-collapse:collapse;width:100%;"><thead><tr style="border-bottom:1px solid var(--hairline);${mono}font-size:var(--fs-2xs);letter-spacing:.12em;text-transform:uppercase;color:var(--faint);">${cols.map((c) => (Array.isArray(c) ? th(c[0], c[1]) : th(c))).join("")}</tr></thead><tbody>${rows}</tbody></table></div>`;
const td = (t, style = "") => `<td style="padding:12px 18px;color:var(--muted);vertical-align:top;${style}">${t}</td>`;
const tdMono = (t, style = "") => td(`<span style="${mono}font-size:var(--fs-sm);color:var(--ink);">${t}</span>`, `white-space:nowrap;${style}`);
const tdPrice = (t) => td(`<span style="${mono}font-size:var(--fs-sm);color:var(--accent);font-variant-numeric:tabular-nums;">${esc(t)}</span>`, "white-space:nowrap;");
const row = (cells) => `<tr style="border-bottom:1px solid var(--hairline);">${cells.join("")}</tr>`;
const routeLink = (def) => `<a href="/tools/${esc(def.slug)}" style="color:var(--ink);text-decoration:none;border-bottom:1px solid var(--accent);">${esc(def.route)}</a>`;

/** The catalog's entry for a kit tool (the catalog decides what this instance serves). */
const served = (catalog, def) => (catalog ? catalog[def.route] || null : def);

export function speechPage(baseUrl, catalog = null) {
  const canonical = `${baseUrl}/speech`;
  const title = "Speech tools: text to speech and audio to text, paid per call";
  const description =
    "Agent402's model-backed speech tools: three text-to-speech tiers, two transcription tiers with speaker labels, and OpenAI-shaped wires for both. Voices, formats, caps and prices read from the tools themselves, with example calls and what a backup model means for a buyer.";

  // ---- text to speech, from the kit ---------------------------------------------
  const ttsRows = TTS_TOOLS.map((def) => ({ def, live: served(catalog, def), tier: TTS_TIERS[def.slug] })).filter((r) => r.live);
  const chainOf = (slug) => {
    const t = TTS_TIERS[slug];
    const links = t.chain ? [...t.chain] : [t.model];
    const backups = t.provider === "elevenlabs" ? [...TTS_BACKUP_MODELS] : [];
    return { links, backups };
  };
  const formatsOf = (slug) => [...(TTS_TIERS[slug].provider === "openrouter" ? LITE_FORMATS : FORMATS)];
  const ttsTable = table(["route", "price", "model", "max chars", "formats", "voices"], ttsRows.map(({ def, live, tier }) => row([
    tdMono(routeLink(live)),
    tdPrice(live.price),
    tdMono(esc(tier.model.split("/").pop())),
    td(fmtInt(tier.maxChars), `${mono}font-size:var(--fs-sm);color:var(--ink);font-variant-numeric:tabular-nums;white-space:nowrap;`),
    td(`<span class="ml-codelist">${formatsOf(def.slug).map((f) => `<code style="${mono}font-size:var(--fs-sm);color:var(--ink);">${esc(f)}</code>`).join(" ")}</span>`),
    td(tier.provider === "elevenlabs" ? `the ${VOICES.size} standard names, each its own voice, or ${ELEVENLABS_VOICES.size} named voices` : `the ${VOICES.size} standard names, mapped to the model's nearest voice`),
  ])).join(""));

  const ttsDef = ttsRows.find((r) => r.def.slug === "tts")?.live || ttsRows[0]?.live || null;
  const ttsExample = ttsDef ? JSON.stringify(ttsDef.discovery?.output?.example || {}, null, 2) : "";
  const ttsInput = ttsDef ? JSON.stringify(ttsDef.discovery?.input || {}) : "";

  // ---- voices -----------------------------------------------------------------------
  const voiceRows = [...VOICES].map((v) => row([tdMono(esc(v)), tdMono(esc(ELEVENLABS_VOICE_MAP[v] || v))])).join("");
  const namedVoices = [...ELEVENLABS_VOICES].sort();

  // ---- audio to text, from the kit ----------------------------------------------
  const sttRows = STT_TOOLS.map((def) => ({ def, live: served(catalog, def) })).filter((r) => r.live);
  const sttTierOf = (slug) => STT_TIERS[slug.replace(/^v1-audio-transcriptions(-pro)?$/, (_, pro) => (pro ? "transcribe-pro" : "transcribe"))];
  const sttTable = table(["route", "price", "model", "max audio", "input", "speaker labels"], sttRows.map(({ live, def }) => {
    const t = sttTierOf(def.slug);
    return row([
      tdMono(routeLink(live)),
      tdPrice(live.price),
      tdMono(esc(t.model)),
      td(`${t.maxMinutes} minutes, ${Math.round(MAX_AUDIO_BYTES / 1024 / 1024)} MB`, "white-space:nowrap;"),
      td(def.discovery?.bodyType === "form-data" ? "multipart upload, a part named file" : "a URL to the audio file"),
      tdMono(`${esc(DIARIZE_MODEL.split("/").pop())} with diarize: true`),
    ]);
  }).join(""));
  const sttDef = sttRows.find((r) => r.def.slug === "transcribe")?.live || sttRows[0]?.live || null;
  const sttInput = sttDef ? JSON.stringify(sttDef.discovery?.input || {}) : "";
  const sttExample = sttDef ? JSON.stringify(sttDef.discovery?.output?.example || {}, null, 2) : "";
  const proDef = sttRows.find((r) => r.def.slug === "transcribe-pro")?.live || null;

  // ---- the OpenAI-shaped wires ------------------------------------------------------
  const speechWire = catalog ? catalog[`POST ${SPEECH_PATH}`] || null : null;
  const transWire = sttRows.find((r) => r.def.slug === "v1-audio-transcriptions")?.live || null;
  const transWirePro = sttRows.find((r) => r.def.slug === "v1-audio-transcriptions-pro")?.live || null;

  // ---- structured data ---------------------------------------------------------------
  const orgLd = { "@type": "Organization", "@id": `${baseUrl}/#organization`, name: "Agent402", url: baseUrl, logo: { "@type": "ImageObject", url: `${baseUrl}/logo.png` }, sameAs: ORG_SAME_AS };
  const crumbsLd = breadcrumbLd(baseUrl, [["Agent402", "/"], ["Speech", "/speech"]]);
  const listLd = { "@type": "ItemList", "@id": `${canonical}#tools`, name: "Agent402 speech tools", itemListElement: [...ttsRows.map((r) => r.live), ...sttRows.map((r) => r.live), ...(speechWire ? [speechWire] : [])].map((d, i) => ({ "@type": "ListItem", position: i + 1, name: d.name, url: `${baseUrl}/tools/${d.slug}` })) };

  const extraCss = `
.sp-scroll{overflow-x:auto;max-width:100%;margin:0 0 22px}
.sp-scroll table{min-width:640px}
@media (max-width:900px){.sp-2col{grid-template-columns:minmax(0,1fr)!important}}
`;

  const tocHtml = TOC.map(([href, label]) =>
    `<a href="${href}" style="padding:11px 18px;border-bottom:1px solid var(--panel-rule);text-decoration:none;color:var(--on-panel-soft);font-size:var(--fs-md);">${esc(label)}</a>`
  ).join("");

  const body = `
<header style="border-bottom:1px solid var(--hairline);">
  <div style="max-width:1180px;margin:0 auto;padding:52px 30px 44px;">
    <nav aria-label="Breadcrumb" class="ml-crumb" style="${mono}font-size:var(--fs-xs);color:var(--faint);margin-bottom:22px;">
      <a href="/" style="color:var(--muted);text-decoration:none;">agent402</a> / <a href="/tools" style="color:var(--muted);text-decoration:none;">tools</a> / <span style="color:var(--ink);">speech</span>
    </nav>
    <div class="sp-2col" style="display:grid;grid-template-columns:1.1fr .9fr;gap:50px;align-items:start;">
      <div>
        <div class="ml-meta" style="display:flex;flex-wrap:wrap;gap:8px;margin-bottom:18px;"><span>${chip("model-backed")}</span><span>${chip("pay per call")}</span><span>${chip("x402 or MPP")}</span></div>
        <h1 style="font-family:var(--font-display);font-weight:400;letter-spacing:-.01em;font-size:var(--fs-5xl);line-height:.94;margin:0 0 24px;color:var(--ink);text-wrap:balance;">Speech: <span style="color:var(--accent);">text to voice</span>, voice to text</h1>
        <p style="font-size:var(--fs-lg);line-height:1.5;color:var(--muted);margin:0 0 20px;"><strong style="color:var(--ink);font-weight:700;">Every tool on this page runs a speech model and is marked model-backed in the catalog.</strong> Send text and get audio back in the format you ask for; send audio and get a transcript, with speaker labels and word times when you want them. No API key and no account: each call is paid on its own 402 over ${link("/what-is-x402", "x402")} or ${link("/what-is-mpp", "MPP")}.</p>
        <p style="font-size:var(--fs-lg);line-height:1.6;color:var(--muted);margin:0;">The models, caps, voices and formats below are read from the tools' own tables, and the prices from the catalog ${link("/api/pricing", "/api/pricing")} serves. ${link("/how-to-pay", "How to pay")} covers the wallet side.</p>
      </div>
      <div style="border:1px solid var(--hairline);background:var(--panel);">
        <div style="padding:12px 18px;border-bottom:1px solid var(--panel-rule-2);${mono}font-size:var(--fs-2xs);letter-spacing:.08em;color:var(--on-panel-dim);">ON THIS PAGE</div>
        <div style="display:flex;flex-direction:column;">${tocHtml}</div>
      </div>
    </div>
  </div>
</header>

${section("tts", `
  ${eyebrow("01 / TEXT TO SPEECH")}
  ${h2("Three tiers, one request shape.")}
  ${p(`Send ${code("text")}, an optional ${code("voice")} and an optional ${code("format")}; the answer is JSON with the audio base64-encoded and the model, voice and format that actually spoke. The three tiers differ in model, price and cap, not in interface, so a buyer moves between them by changing the path.`)}
  ${ttsTable}
  ${h3("Example call")}
  ${pre(`${ttsDef ? ttsDef.route : "POST /api/tts"}, paid over x402`, `# the first request answers 402 with the price; a paying client retries it
curl -X POST ${baseUrl}${ttsDef ? ttsDef.route.split(" ")[1] : "/api/tts"} \\
  -H 'Content-Type: application/json' \\
  -H "PAYMENT-SIGNATURE: <signed by your x402 client>" \\
  -d '${ttsInput || '{"text":"Hello from Agent402!","voice":"alloy","format":"mp3"}'}' \\
  | jq -r .audio | base64 -d > hello.mp3`)}
  ${pre("the same call, buyer SDK", `import { Agent402 } from "agent402-client";
import { writeFile } from "node:fs/promises";

const a = new Agent402({ fetch: payFetch }); // a wallet-paying fetch, see /how-to-pay
const out = await a.call("${ttsDef ? ttsDef.slug : "tts"}", ${ttsInput || '{ text: "Hello from Agent402!", voice: "alloy", format: "mp3" }'});
await writeFile("hello." + out.format, Buffer.from(out.audio, "base64"));
console.log(out.model, out.voice, out.chars);`)}
  ${h3("What comes back")}
  ${pre("the answer", ttsExample || "{ model, provider, voice, format, audio, chars }")}
  ${p(`${code("model")} and ${code("voice")} name what spoke, which matters when a backup served the call (below). ${code("chars")} is the number of characters spoken, the unit the cap is counted in; a text over the tier's cap is a 400 before anything is generated, and a 400 is not charged on x402.`)}
`, true)}

${section("voices", `
  ${eyebrow("02 / VOICES AND FORMATS")}
  ${h2("Ten standard names, and a longer list.")}
  ${p(`The ${VOICES.size} standard voice names work on every tier. On ${esc(listAnd(ttsRows.filter((r) => r.tier.provider === "elevenlabs").map((r) => r.def.route.split(" ")[1])))} each name is its own voice, listed here; on the lite tier each maps to the nearest voice of its model and the answer names it.`)}
  <div class="sp-2col" style="display:grid;grid-template-columns:1fr 1fr;gap:30px;align-items:start;max-width:820px;">
    <div>
      ${table(["standard name", "speaks as"], voiceRows)}
    </div>
    <div>
      <div style="${mono}font-size:var(--fs-2xs);letter-spacing:.12em;text-transform:uppercase;color:var(--faint);margin:0 0 12px;">${ELEVENLABS_VOICES.size} named voices</div>
      <div class="ml-meta" style="display:flex;flex-wrap:wrap;gap:8px;margin:0 0 18px;">${namedVoices.map((v) => `<span>${chip(v)}</span>`).join("")}</div>
      <p style="font-size:var(--fs-base);line-height:1.6;color:var(--muted);margin:0 0 18px;">Name one directly as ${code("voice")}. On ${esc(ttsRows.find((r) => r.def.slug === "tts-hd")?.def.route.split(" ")[1] || "the HD tier")}, inline audio tags such as ${code("[whispering]")} are read as delivery cues.</p>
      <div style="${mono}font-size:var(--fs-2xs);letter-spacing:.12em;text-transform:uppercase;color:var(--faint);margin:0 0 12px;">formats</div>
      <div class="ml-meta" style="display:flex;flex-wrap:wrap;gap:8px;margin:0 0 12px;">${[...FORMATS].map((f) => `<span>${chip(f)}</span>`).join("")}</div>
      <p style="font-size:var(--fs-base);line-height:1.6;color:var(--muted);margin:0;">${code("mp3")} is the default. The lite tier serves ${esc(listAnd([...LITE_FORMATS]))} only, and asks for another format with a 400 that names the tiers that serve it, never a silent downgrade.</p>
    </div>
  </div>
`)}

${section("fallback", `
  ${eyebrow("03 / THE FALLBACK CHAIN")}
  ${h2("What a backup model means for a buyer.")}
  ${p(`A tier is priced for its primary model, and that model serves the call whenever it can. When it is busy, throttling or answering with a server error, the call moves down a chain, and the answer's ${code("model")} field names whichever link spoke. The chain is read from the tier table:`)}
  ${table(["route", "primary, then its chain", "backups after the chain"], ttsRows.map(({ live, def }) => {
    const c = chainOf(def.slug);
    return row([
      tdMono(routeLink(live)),
      td(`<span class="ml-codelist">${c.links.map((m) => `<code style="${mono}font-size:var(--fs-sm);color:var(--ink);">${esc(m.split("/").pop())}</code>`).join(" → ")}</span>`),
      td(c.backups.length ? `<span class="ml-codelist">${c.backups.map((m) => `<code style="${mono}font-size:var(--fs-sm);color:var(--ink);">${esc(m.split("/").pop())}</code>`).join(" → ")}</span>` : "none: one model at one price, and an upstream failure is an uncharged error"),
    ]);
  }).join(""))}
  ${p(`<strong style="color:var(--ink);font-weight:700;">One paid call is at most one generation.</strong> A link is skipped only after a failure that could not have been billed: a throttle, a server error, or a connection that never opened. A timeout or an empty answer may already have been generated, so it ends the call with an uncharged error instead of a second attempt. The whole walk, backups included, runs inside ${Math.round(TTS_DEADLINE_MS / 1000)} seconds.`)}
  ${p(`A backup can have fewer voices and languages than the primary: the standard name you asked for maps to its nearest voice, and a named voice maps back to its standard name first. The price does not change with the link that served you. Read ${code("model")} if your pipeline depends on a particular voice, and retry when it names a backup you would rather not keep.`)}
`, true)}

${section("stt", `
  ${eyebrow("04 / AUDIO TO TEXT")}
  ${h2("Transcription, with speakers and word times on request.")}
  ${p(`Send the URL of an audio file (${esc(listAnd(["mp3", "wav", "m4a", "ogg", "flac", "webm"]))}) and the answer is the transcript with the language detected and the duration read. Add ${code("diarize: true")} and the call runs on the ${esc(DIARIZE_MODEL.split("/").pop())} model instead, adding ${code("words")} (each with start, end and a speaker number), ${code("speakers")} and ${code("language_confidence")}, at the same price and cap.`)}
  ${sttTable}
  ${p(`The duration cap is enforced before any model is called, from the file's own headers: a recording over the cap is a 422 naming the tier that takes it, and a 422 is not charged on x402. ${proDef ? `${code(proDef.route)} is the same model on a longer cap, for recordings the shorter tier refuses.` : ""}`)}
  ${h3("Example call")}
  ${pre(`${sttDef ? sttDef.slug : "transcribe"}, paid over x402`, `curl -X POST ${baseUrl}${sttDef ? sttDef.route.split(" ")[1] : "/api/transcribe"} \\
  -H 'Content-Type: application/json' \\
  -H "PAYMENT-SIGNATURE: <signed by your x402 client>" \\
  -d '${sttInput || '{"url":"https://example.com/call.mp3"}'}'

# with speaker labels and word timestamps, same price
curl -X POST ${baseUrl}${sttDef ? sttDef.route.split(" ")[1] : "/api/transcribe"} \\
  -H 'Content-Type: application/json' \\
  -H "PAYMENT-SIGNATURE: <signed by your x402 client>" \\
  -d '${sttInput ? sttInput.replace(/\}$/, ',"diarize":true}') : '{"url":"https://example.com/call.mp3","diarize":true}'}'`)}
  ${pre("the answer", sttExample || "{ model, provider, text, language, duration }")}
  ${p(`On the hosted MCP connector the same tool is ${code("audio.transcribe")}, one of the flagship tools listed on connect; the long tail (${code("transcribe-pro")}, the tts tiers) is reached through ${code("catalog.find")} and ${code("catalog.call")}.`)}
`, true)}

${section("wire", `
  ${eyebrow("05 / THE OPENAI-SHAPED WIRES")}
  ${h2("Point an existing SDK at the gateway.")}
  ${speechWire ? `
  ${p(`${code(`POST ${SPEECH_PATH}`)} speaks the request format of the OpenAI speech endpoint, so an SDK's ${code("audio.speech.create()")} works by changing ${code("base_url")} to ${code(`${baseUrl}/v1`)}. It answers raw audio bytes (${esc(listAnd(Object.keys(SPEECH_FORMATS)))}), not JSON, at ${esc(speechWire.price)} per call for up to ${fmtInt(SPEECH_MAX_CHARS)} characters. The ${OPENAI_SPEECH_VOICES.length} standard voice names map per model, and any model's native voice id is accepted too.`)}
  ${p(`It runs its own chain of ${SPEECH_MODELS.length} speech models, walked on any upstream failure, so the answer may come from any of them: ${esc(listAnd(SPEECH_MODELS.map((m) => m.id.split("/").pop())))}. Pin one with ${code("model")} and the rest stay as fallbacks.`)}
  ${pre("raw audio bytes to a file", `curl -X POST ${baseUrl}${SPEECH_PATH} \\
  -H 'Content-Type: application/json' \\
  -H "PAYMENT-SIGNATURE: <signed by your x402 client>" \\
  -d '${JSON.stringify(speechWire.discovery?.input || { input: "Hello from Agent402!", voice: "alloy" })}' \\
  --output hello.mp3`)}` : p(`The hosted service also serves ${code(`POST ${SPEECH_PATH}`)}, the OpenAI-shaped speech wire that answers raw audio bytes for up to ${fmtInt(SPEECH_MAX_CHARS)} characters behind a chain of ${SPEECH_MODELS.length} speech models; this instance does not have it switched on.`)}
  ${transWire ? p(`${code(transWire.route)} is the matching transcription wire: ${code("multipart/form-data")} with a part named ${code("file")} (and an optional ${code("language")} or ${code("diarize")}), the same model and cap as ${code(sttDef ? sttDef.route : "/api/transcribe")}, at ${esc(transWire.price)}${transWirePro ? `; ${code(transWirePro.route)} takes a recording up to ${sttTierOf(transWirePro.slug).maxMinutes} minutes at ${esc(transWirePro.price)}` : ""}.`) : ""}
  ${transWire ? pre("multipart upload, same wire", `curl -X POST ${baseUrl}${transWire.route.split(" ")[1]} \\
  -H "PAYMENT-SIGNATURE: <signed by your x402 client>" \\
  -F "file=@meeting.m4a" -F "language=en" -F "diarize=true"`) : ""}
`)}

${section("pay", `
  ${eyebrow("06 / PAYING")}
  ${h2("Paid per call, and not for a call that failed.")}
  ${p(`Every route here takes the same 402 handshake as the rest of the catalog: ask, get the price, pay with a wallet over x402 or MPP, and the identical request completes with a receipt header. The speech tools are wallet-only; there is no proof-of-work tier for a model call. ${link("/how-to-pay", "How to pay")} walks every rail with a snippet to paste.`)}
  ${p(`The model runs first and the payment settles only after a response below 400 is ready, so on x402, on MPP's evm method and on a Tempo charge a 4xx or 5xx (a text over the cap, a format the tier does not serve, an upstream that could not answer) is not charged. A 200 is charged only if its settlement then succeeds. ${link("/proof", "/proof")} shows settled receipts against their quotes, and ${link("/status", "/status")} measures the paid path from outside.`)}
`)}

<section style="max-width:1180px;margin:0 auto;padding:56px 30px 56px;">
  <div class="ml-cta-panel" style="background:var(--panel);border:1px solid var(--hairline);padding:52px 44px;position:relative;overflow:hidden;">
    <div style="position:relative;">
      ${h2("Hear it, then read it back.", true)}
      <p style="font-size:var(--fs-lg);line-height:1.6;color:var(--on-panel-muted);margin:0 0 28px;max-width:540px;">One wallet pays the speech tools and the other 500+ tools in the catalog on the same 402.</p>
      <div style="display:flex;gap:11px;flex-wrap:wrap;">
        <a class="btn btn-primary on-panel" href="/how-to-pay">How to pay →</a>
        <a class="btn btn-secondary on-panel" href="/tools/category/ai">Every speech tool</a>
      </div>
    </div>
  </div>
</section>
${ledgerFooterCompact()}`;

  return ledgerShell({
    title,
    description,
    canonical,
    baseUrl,
    activePath: "/speech",
    jsonLd: [orgLd, crumbsLd, listLd],
    extraCss,
    body,
  });
}
