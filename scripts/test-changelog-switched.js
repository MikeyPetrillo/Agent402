// A changelog entry about something a switch sells reads that switch: the
// /changelog page and /changelog.xml show it only while the switch is on,
// and CHANGELOG.md scopes its text to a server that sets it.
//   - /api/transcribe-long (TRANSCRIBE_LONG=on, src/tools/stt-kit.js
//     sttLongEnabled) has an entry, and that entry carries the switch;
//   - with the switch unset (and with a junk value) neither surface names
//     the route; with it on, both do;
//   - every item that names a switched route sits in an entry that reads
//     the switch, so a later item cannot sell it unconditionally;
//   - the markdown item names the switch.
//
//   node scripts/test-changelog-switched.js
import "./lib/offline-stores.js"; // per-process and file backends whatever the caller exports (see the file)
import { readFileSync } from "node:fs";

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log(`ok - ${m}`); } else { fail++; console.error(`FAIL - ${m}`); } };

delete process.env.TRANSCRIBE_LONG;
const { CHANGELOG_ENTRIES, changelogPage, changelogRss } = await import("../src/changelog.js");
const { sttLongEnabled } = await import("../src/tools/stt-kit.js");

// Each switched route and the switch function that sells it.
const { creditsSalesEnabled, creditsConnectorOn } = await import("../src/credits-sales.js");
const { webBotAuthEnabled } = await import("../src/web-bot-auth.js");
const { tempoOusdShown } = await import("../src/changelog.js");
const { upstreamKeyEnabled } = await import("../src/upstream-key.js");
// `offs`: values that leave the switch off (default: unset, empty, off, yes);
// `also`: settings the switch needs beside it, set for every render.
const SWITCHED = [
  { route: "/api/transcribe-long", env: "TRANSCRIBE_LONG", on: "on", fn: sttLongEnabled },
  // Credit sales (also needs the private table, which this suite's import provides).
  { route: "/credits/account", env: "CREDITS_SALES", on: "on", fn: creditsSalesEnabled, offs: [undefined, "", "off", "no"] },
  { route: "/mcp/credits", env: "MCP_OAUTH", on: "on", fn: creditsConnectorOn, also: { CREDITS_SALES: "on" } },
  { route: "OUSD", env: "TEMPO_CURRENCY", on: "usdc,ousd", fn: tempoOusdShown, offs: [undefined, "", "usdc", "pathusd"], also: { TEMPO_API_KEY: "test-key", TEMPO_RECIPIENT_ADDRESS: "0x000000000000000000000000000000000000dEaD" } },
  { route: "Visa CLI", env: "WEB_BOT_AUTH", on: "on", fn: webBotAuthEnabled },
  // Bring your own key (src/upstream-key.js): off by default.
  { route: "X-Agent402-Upstream-Key", env: "UPSTREAM_KEY", on: "on", fn: upstreamKeyEnabled, offs: [undefined, "", "off", "no"] },
];

for (const s of SWITCHED) {
  const prior = Object.fromEntries(Object.keys(s.also || {}).map((k) => [k, process.env[k]]));
  Object.assign(process.env, s.also || {});
  const entries = CHANGELOG_ENTRIES.filter((e) => e.items.some((i) => i.includes(s.route)));
  ok(entries.length > 0, `the changelog has an entry for ${s.route}`);
  ok(entries.every((e) => e.shownWhen === s.fn), `every entry that names ${s.route} is shown only while ${s.env} is on (shownWhen)`);
  ok(entries.every((e) => e.items.filter((i) => i.includes(s.route)).every((i) => i.includes(`${s.env}=${s.on}`))), `each item that names ${s.route} names the switch, so CHANGELOG.md reads true with it off`);

  const render = () => ({ page: changelogPage("https://example.test"), rss: changelogRss("https://example.test") });
  for (const v of s.offs || [undefined, "", "off", "yes"]) {
    if (v === undefined) delete process.env[s.env]; else process.env[s.env] = v;
    const { page, rss } = render();
    ok(!page.includes(s.route) && !rss.includes(s.route), `${s.env}=${v === undefined ? "(unset)" : JSON.stringify(v)}: /changelog and /changelog.xml do not name ${s.route}`);
  }
  process.env[s.env] = s.on;
  const { page, rss } = render();
  ok(page.includes(s.route) && rss.includes(s.route), `${s.env}=${s.on}: /changelog and /changelog.xml name ${s.route}`);
  delete process.env[s.env];
  for (const [k, v] of Object.entries(prior)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
}

// The markdown carries the same item, scoped to the switch.
const md = readFileSync(new URL("../CHANGELOG.md", import.meta.url), "utf8");
for (const s of SWITCHED) {
  const at = md.indexOf(s.route);
  ok(at >= 0, `CHANGELOG.md has the ${s.route} item`);
  const para = at >= 0 ? md.slice(md.lastIndexOf("\n- ", at), md.indexOf("\n- ", at + 1)) : "";
  ok(para.replace(/\s+/g, " ").includes(`${s.env}=${s.on}`), `the CHANGELOG.md item names ${s.env}=${s.on}`);
}

// Entries about something only a switched server offers carry that switch:
// the MPP offer gate, MPP subscriptions and wallet sign-in.
{
  const { mppSubscriptionsEnabled } = await import("../src/mpp-subscriptions.js");
  const { walletSignInEnabled } = await import("../src/wallet-sign-in.js");
  for (const [title, fn] of [["x402 by default for python-httpx clients", null], ["Wallet subscriptions for monitors", mppSubscriptionsEnabled], ["Wallet subscription renewals retried", mppSubscriptionsEnabled], ["Wallet sign-in", walletSignInEnabled]]) {
    const e = CHANGELOG_ENTRIES.find((x) => x.title === title);
    ok(e && typeof e.shownWhen === "function" && (fn === null || e.shownWhen === fn), `the "${title}" entry is shown only while its switch reads on (shownWhen)`);
  }
}

const render = () => `${changelogPage("https://example.test")}\n${changelogRss("https://example.test")}`;

// Calls paid before they run (settle-first, on unless GATEWAY_SETTLE_FIRST=off,
// src/settle-first-copy.js settleFirstCopyOn): every item that names it or its
// resend bound sits in an entry that reads the switch, neither surface names
// either with the switch off, both do with it on, and each CHANGELOG.md item
// is scoped to a server that leaves the switch on.
{
  const { settleFirstCopyOn, SETTLE_FIRST_MARK } = await import("../src/settle-first-copy.js");
  const RESEND = "sent again at most twice";
  const naming = CHANGELOG_ENTRIES.filter((x) => x.items.some((i) => i.includes(SETTLE_FIRST_MARK) || i.includes(RESEND)));
  ok(naming.length > 0 && naming.every((x) => x.shownWhen === settleFirstCopyOn), `every entry that says calls are ${SETTLE_FIRST_MARK} or names the resend bound is shown only while settle-first is on (shownWhen)`);
  const was = process.env.GATEWAY_SETTLE_FIRST;
  process.env.GATEWAY_SETTLE_FIRST = "off";
  const off = render();
  ok(!off.includes(SETTLE_FIRST_MARK) && !off.includes(RESEND), "GATEWAY_SETTLE_FIRST=off: /changelog and /changelog.xml name neither the settle-first rule nor its resend bound");
  delete process.env.GATEWAY_SETTLE_FIRST;
  const on = render();
  ok(on.includes(SETTLE_FIRST_MARK) && on.includes(RESEND), "settle-first on (the default): both surfaces name the rule and the bound");
  if (was === undefined) delete process.env.GATEWAY_SETTLE_FIRST; else process.env.GATEWAY_SETTLE_FIRST = was;
  const mdItems = md.split(/\n(?:- |#)/).map((i) => i.split("\n\n")[0].replace(/\s+/g, " ").trim()).filter((i) => !i.startsWith("#") && (i.includes(SETTLE_FIRST_MARK) || i.includes(RESEND)));
  const unscoped = mdItems.filter((i) => !i.startsWith("On a server that does not set `GATEWAY_SETTLE_FIRST=off`,"));
  ok(mdItems.length >= 2 && unscoped.length === 0, `each CHANGELOG.md item about it opens "On a server that does not set \`GATEWAY_SETTLE_FIRST=off\`" (${unscoped.map((i) => JSON.stringify(i.slice(0, 60))).join(", ") || mdItems.length + " items"})`);
}

const mdItemAt = (needle) => {
  const at = md.indexOf(needle);
  return at >= 0 ? md.slice(md.lastIndexOf("\n- ", at), md.indexOf("\n- ", at + 1)).replace(/\s+/g, " ") : "";
};

// The returning-wallet price (RETURNING_WALLET_PRICE=on, src/returning-wallet.js):
// its entry reads the switch, every item that names the header or a setting
// of it sits in that entry, and neither surface names the header with the
// switch unset or set to anything but "on".
{
  const { returningWalletEnabled, WALLET_HINT_HEADER } = await import("../src/returning-wallet.js");
  const title = "A lower price for a returning wallet";
  const e = CHANGELOG_ENTRIES.find((x) => x.title === title);
  ok(e && e.shownWhen === returningWalletEnabled, `the "${title}" entry is shown only while RETURNING_WALLET_PRICE is on (shownWhen)`);
  const naming = CHANGELOG_ENTRIES.filter((x) => x.items.some((i) => i.includes(WALLET_HINT_HEADER) || i.includes("RETURNING_WALLET_") || i.includes("returningWalletPrice")));
  ok(naming.length > 0 && naming.every((x) => x.shownWhen === returningWalletEnabled), "every item that names the wallet header or a returning-wallet setting sits in an entry that reads the switch");
  ok(e?.items[0].includes("RETURNING_WALLET_PRICE=on") && mdItemAt(WALLET_HINT_HEADER).includes("RETURNING_WALLET_PRICE=on"), "the item names RETURNING_WALLET_PRICE=on on the page and in CHANGELOG.md");
  for (const v of [undefined, "", "off", "yes"]) {
    if (v === undefined) delete process.env.RETURNING_WALLET_PRICE; else process.env.RETURNING_WALLET_PRICE = v;
    const out = render();
    ok(!out.includes(WALLET_HINT_HEADER) && !out.includes(title), `RETURNING_WALLET_PRICE=${v === undefined ? "(unset)" : JSON.stringify(v)}: /changelog and /changelog.xml do not name ${WALLET_HINT_HEADER}`);
  }
  process.env.RETURNING_WALLET_PRICE = "on";
  ok(changelogPage("https://example.test").includes(WALLET_HINT_HEADER) && changelogRss("https://example.test").includes(WALLET_HINT_HEADER), `RETURNING_WALLET_PRICE=on: /changelog and /changelog.xml name ${WALLET_HINT_HEADER}`);
  delete process.env.RETURNING_WALLET_PRICE;
}

// The named speech and transcription models (NAMED_AUDIO_MODELS,
// src/speech-additions.js): each entry is shown only while this server serves
// such a model on the routes it is about, which takes the switch AND the
// model's admission. The cost rows installed here are derived from each
// route's own price and cap (no rate is typed).
{
  const U = await import("../src/upstream-costs.js");
  const A = await import("../src/speech-additions.js");
  const G = await import("../src/tools/llm-gateway-kit.js");
  const S = await import("../src/tools/stt-kit.js");
  const { namedSpeechShown, namedTranscriptionShown, elevenV3ConversationalShown, ELEVEN_V3_CONVERSATIONAL } = await import("../src/changelog.js");
  const EXAMPLE = JSON.parse(readFileSync(new URL("../docs/example-upstream-costs.json", import.meta.url), "utf8"));
  const speechPrice = Number(G.LLM_GATEWAY_TOOLS.find((t) => t.slug === "v1-audio-speech").price.replace("$", ""));
  const speechRows = Object.fromEntries(A.SPEECH_ADDITIONS.map((m) => [m.id, 0.5 * A.ADDITION_MARGIN * speechPrice / G.SPEECH_MAX_CHARS]));
  const sttRows = Object.fromEntries(A.STT_ADDITIONS.map((m) => [m.id, 0.5 * A.ADDITION_MARGIN * S.STT_TIERS.transcribe.priceUsd / S.STT_TIERS.transcribe.maxMinutes]));
  const install = ({ speech = {}, stt = {} } = {}) => U.setUpstreamCostsForTest({ ...EXAMPLE, speech: { "your/speech-model": EXAMPLE.speech["your/speech-model"], ...speech }, sttPerMinute: { "gpt-transcribe": EXAMPLE.sttPerMinute["gpt-transcribe"], ...stt } });
  const SPEECH = "Named speech models", STT = "Named transcription models";
  const speech = CHANGELOG_ENTRIES.find((x) => x.title === SPEECH), stt = CHANGELOG_ENTRIES.find((x) => x.title === STT);
  ok(speech && speech.shownWhen === namedSpeechShown && stt && stt.shownWhen === namedTranscriptionShown, "the named speech and transcription entries each read whether this server serves such a model (shownWhen)");
  const naming = CHANGELOG_ENTRIES.filter((x) => x.items.some((i) => i.includes("NAMED_AUDIO_MODELS")));
  const LENGTH = "Named speech model length";
  const length = CHANGELOG_ENTRIES.find((x) => x.title === LENGTH);
  ok(A.SPEECH_ADDITIONS.some((m) => m.id === ELEVEN_V3_CONVERSATIONAL) && length && length.shownWhen === elevenV3ConversationalShown, `the "${LENGTH}" entry reads whether this server serves ${ELEVEN_V3_CONVERSATIONAL} (shownWhen)`);
  ok(naming.length === 3 && naming.every((x) => x === speech || x === stt || x === length), "every item that names NAMED_AUDIO_MODELS sits in one of those three entries");
  ok(mdItemAt("`elevenlabs/eleven-v3-conversational` takes").includes("NAMED_AUDIO_MODELS"), "the CHANGELOG.md length item is scoped to a server that lists the model in NAMED_AUDIO_MODELS");
  ok(mdItemAt("`POST /v1/audio/speech`, each").includes("NAMED_AUDIO_MODELS") && mdItemAt("URL transcribe").includes("NAMED_AUDIO_MODELS"), "both CHANGELOG.md items are scoped to a server that lists the models in NAMED_AUDIO_MODELS");
  const shown = () => { const out = render(); return { speech: out.includes(SPEECH), stt: out.includes(STT), length: out.includes(LENGTH) }; };
  const state = (want, m) => { const got = shown(); want = { length: want.speech, ...want }; ok(got.speech === want.speech && got.stt === want.stt && got.length === want.length, `${m}: speech entry ${want.speech ? "shown" : "hidden"}, transcription entry ${want.stt ? "shown" : "hidden"} (got ${JSON.stringify(got)})`); };

  process.env.OPENROUTER_TTS_ENABLED = "true";
  delete process.env.NAMED_AUDIO_MODELS;
  install({ speech: speechRows, stt: sttRows });
  state({ speech: false, stt: false }, "switch unset, rows present");
  process.env.NAMED_AUDIO_MODELS = "off";
  state({ speech: false, stt: false }, "switch off, rows present");
  process.env.NAMED_AUDIO_MODELS = "all";
  install();
  state({ speech: false, stt: false }, "switch on, no row");
  install({ speech: speechRows });
  state({ speech: true, stt: false }, "switch on, speech rows only");
  install({ stt: sttRows });
  state({ speech: false, stt: true }, "switch on, transcription rows only");
  install({ speech: speechRows, stt: sttRows });
  state({ speech: true, stt: true }, "switch on, every row");
  process.env.NAMED_AUDIO_MODELS = A.STT_ADDITIONS[0].id;
  state({ speech: false, stt: true }, "switch names one transcription model");
  const otherSpeech = A.SPEECH_ADDITIONS.find((m) => m.id !== ELEVEN_V3_CONVERSATIONAL);
  if (otherSpeech) { process.env.NAMED_AUDIO_MODELS = otherSpeech.id; state({ speech: true, stt: false, length: false }, `switch names ${otherSpeech.id} only`); }
  process.env.NAMED_AUDIO_MODELS = ELEVEN_V3_CONVERSATIONAL;
  state({ speech: true, stt: false, length: true }, `switch names ${ELEVEN_V3_CONVERSATIONAL} only`);
  process.env.NAMED_AUDIO_MODELS = "all";
  delete process.env.OPENROUTER_TTS_ENABLED;
  state({ speech: false, stt: true }, "the speech route not served");
  delete process.env.NAMED_AUDIO_MODELS;
}

// Tempo fee sponsorship (TEMPO_GAS_SPONSORSHIP=on with the sponsor key,
// src/tempo-charge-sponsor.js): every item that names the switch sits in one
// entry that reads it, and neither surface shows that entry while it is off.
{
  const title = "Tempo network fees paid by the server";
  const e = CHANGELOG_ENTRIES.find((x) => x.title === title);
  ok(e && typeof e.shownWhen === "function", `the "${title}" entry carries a switch (shownWhen)`);
  const naming = CHANGELOG_ENTRIES.filter((x) => x.items.some((i) => i.includes("TEMPO_GAS_SPONSOR")));
  ok(naming.length === 1 && naming[0] === e && e.items.every((i) => i.includes("TEMPO_GAS_SPONSORSHIP=on")) && mdItemAt("TEMPO_GAS_SPONSORSHIP").includes("TEMPO_GAS_SPONSORSHIP=on"), "every item that names TEMPO_GAS_SPONSORSHIP sits in that entry and names the switch, on the page and in CHANGELOG.md");
  const saved = { sw: process.env.TEMPO_GAS_SPONSORSHIP, key: process.env.TEMPO_SUBSCRIPTION_FEE_PAYER_KEY };
  for (const v of [undefined, "", "off", "yes"]) {
    if (v === undefined) delete process.env.TEMPO_GAS_SPONSORSHIP; else process.env.TEMPO_GAS_SPONSORSHIP = v;
    ok(!render().includes(title), `TEMPO_GAS_SPONSORSHIP=${v === undefined ? "(unset)" : JSON.stringify(v)}: /changelog and /changelog.xml do not show the sponsorship entry`);
  }
  process.env.TEMPO_GAS_SPONSORSHIP = "on";
  delete process.env.TEMPO_SUBSCRIPTION_FEE_PAYER_KEY;
  ok(!render().includes(title), "TEMPO_GAS_SPONSORSHIP=on with no sponsor key: the entry is not shown");
  for (const [k, v] of [["TEMPO_GAS_SPONSORSHIP", saved.sw], ["TEMPO_SUBSCRIPTION_FEE_PAYER_KEY", saved.key]]) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  // The spend floor for a paid day is a returning-wallet setting: its entry reads that switch.
  const floor = CHANGELOG_ENTRIES.find((x) => x.items.some((i) => i.includes("RETURNING_WALLET_MIN_DAY_SPEND_USD")));
  const { returningWalletEnabled } = await import("../src/returning-wallet.js");
  ok(floor && floor.shownWhen === returningWalletEnabled && !render().includes(floor.title), "the paid-day spend floor entry reads RETURNING_WALLET_PRICE and is hidden while it is off");
}

// The stock history entry: shown only while a stock provider serves stock-history.
{
  const { stockHistoryShown } = await import("../src/changelog.js");
  // Older entries record stock-history's earlier history and stay; the entry
  // that offers today's DBEQ bars is the one that must read the switch.
  const naming = CHANGELOG_ENTRIES.filter((x) => x.items.some((i) => i.includes("DBEQ")));
  ok(naming.length > 0 && naming.every((x) => x.shownWhen === stockHistoryShown), "every entry that names the DBEQ stock history reads the stock provider switch (shownWhen)");
  const saved = { p: process.env.STOCK_DATA_PROVIDER, k: process.env.DATABENTO_API_KEY };
  const page = () => `${changelogPage("https://example.test")}\n${changelogRss("https://example.test")}`;
  delete process.env.STOCK_DATA_PROVIDER; delete process.env.DATABENTO_API_KEY;
  ok(!page().includes("DBEQ"), "STOCK_DATA_PROVIDER unset: /changelog and /changelog.xml do not name the DBEQ stock history");
  process.env.STOCK_DATA_PROVIDER = "databento"; process.env.DATABENTO_API_KEY = "test-key";
  ok(page().includes("DBEQ"), "control: with the provider on and its key set, the stock history entry renders");
  for (const [k, v] of [["STOCK_DATA_PROVIDER", saved.p], ["DATABENTO_API_KEY", saved.k]]) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
}

// Control: an entry with no switch is always shown.
ok(CHANGELOG_ENTRIES.some((e) => !e.shownWhen) && changelogPage("https://example.test").includes(CHANGELOG_ENTRIES.find((e) => !e.shownWhen).title.replace(/&/g, "&amp;").replace(/'/g, "&#39;").slice(0, 20)), "control: an entry without a switch renders");

console.log(`\ntest-changelog-switched: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
