// The home hero's first-party figures (src/home-proof.js, src/ledger-home.js,
// the "/" route in src/server.js): uptime, external payments, chains live and
// median latency are in the served HTML with the time each was measured, no
// dash or loading placeholder is served in their place, and a source that is
// slow or silent never holds the page.
//
// Unit half: offline, stubbed sources. Boot half: a FREE_MODE server on port
// 0 with its own stores, one recorded probe, and GET / read back.
import "./lib/offline-stores.js"; // per-process and file backends whatever the caller exports (see the file)
import { proofCell, homeProofFigures } from "../src/home-proof.js";
import { ledgerHomePage } from "../src/ledger-home.js";
import { RAILS } from "../src/rails.js";
import { bootServer } from "./lib/boot-server.js";
import { timeOurs, bound } from "./lib/ours-clock.js";

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log(`ok - ${m}`); } else { fail++; console.error(`FAIL - ${m}`); } };
const hero = (html) => html.slice(html.indexOf("<header"), html.indexOf("</header>"));
// What a reader of the served hero (a crawler, an unfurl, no scripts) would see as a placeholder.
const placeholders = (h) => [...h.matchAll(/>\s*(-|–|—|\.\.\.|…)\s*</g)].map((m) => m[1]).concat(/Settlement count loading|loading/i.test(h.replace(/<[^>]*>/g, " ")) ? ["loading"] : []);
const catalog = { "POST /api/hash": { name: "Hash", slug: "hash", category: "encoding", price: "$0.001", description: "Hash text", tags: [] } };

// --- the cell: never waits, reads once at a time, keeps the last good value --------
{
  let reads = 0, release;
  const cell = proofCell(() => { reads++; return new Promise((r) => { release = r; }); }, { ttlMs: 60_000 });
  const turn = () => new Promise((r) => setImmediate(r));
  ok(cell.peek() === null && reads === 0, "the first peek answers at once with nothing, before its read starts");
  await turn();
  ok(reads === 1, "the read starts on a later turn");
  ok(cell.peek() === null && reads === 1, "a peek while that read is in flight starts no second one");
  await turn();
  ok(reads === 1, "still one read in flight");
  release({ value: { count: 7 }, at: 1_700_000_000_000 });
  await cell.settled();
  const held = cell.peek();
  ok(held && held.value.count === 7 && held.at === 1_700_000_000_000 && reads === 1, "once read, the value and its measurement time are held");
  let n = 0;
  const failing = proofCell(() => { n++; if (n > 1) throw new Error("source down"); return { value: { count: 3 }, at: 1 }; }, { ttlMs: 0 });
  failing.peek(); await failing.settled();
  failing.peek(); await failing.settled();
  ok(failing.peek()?.value.count === 3, "a read that fails keeps the last good value");
}

// --- a hung read is bounded; a value too old to vouch for is left out ------------
{
  let t = 1_000_000, reads = 0, mode = "ok";
  const cell = proofCell(() => { reads++; return mode === "hang" ? new Promise(() => {}) : { value: { count: 5 }, at: t }; }, { ttlMs: 60_000, timeoutMs: 30, maxAgeMs: 300_000, now: () => t });
  cell.peek(); await cell.settled();
  ok(cell.peek()?.value.count === 5 && reads === 1, "a read that answers is held");
  mode = "hang"; t += 61_000;
  ok(cell.peek()?.value.count === 5, "while the next read hangs, the value inside its freshness window is still served");
  await cell.settled();
  ok(reads === 2, "the hung read is abandoned at its timeout");
  cell.peek();
  await new Promise((r) => setImmediate(r));
  ok(reads === 3, "after the timeout the next peek starts a new read, not pinned behind the hung one");
  await cell.settled();
  t += 300_000;
  ok(cell.peek() === null, "past its freshness window with every read hung, the figure is left out (never stale, never a zero)");
  ok(homeProofFigures({ uptime: cell.peek() }).length === 0, "and no figure is drawn for it");
}

// --- stubbed sources render as figures with an as-of each ---------------------------
const AT = { u: Date.UTC(2026, 10, 11, 10, 0, 0), e: Date.UTC(2026, 10, 11, 10, 1, 0), c: Date.UTC(2026, 10, 11, 10, 2, 0), l: Date.UTC(2026, 10, 11, 10, 3, 0) };
const full = homeProofFigures({
  uptime: { value: { pct: 99.9512, observed: 25000, windowDays: 90 }, at: AT.u },
  external: { value: { count: 1234 }, at: AT.e },
  chains: { value: { count: RAILS.length }, at: AT.c },
  latency: { value: { p50Ms: 212.4 }, at: AT.l },
});
{
  ok(full.map((f) => f.key).join(",") === "uptime,paid,chains,latency", `four figures in order (${full.map((f) => f.key).join(",")})`);
  const html = ledgerHomePage("https://agent402.tools", catalog, {}, {}, [], { settledOnChain: 1300, external: { count: 1234, usd: 56.78 }, proof: full });
  const h = hero(html);
  const fig = (key) => (h.match(new RegExp(`<a class="hm-own-fig" id="hm-own-${key}"[^>]*>[\\s\\S]*?</a>`)) || [""])[0];
  ok(/>99\.951%</.test(fig("uptime")) && /href="\/status"/.test(fig("uptime")) && fig("uptime").includes(`data-as-of="${new Date(AT.u).toISOString()}"`), "uptime is served with its value, its /status link and its as-of");
  ok(/>1,234</.test(fig("paid")) && /external payments/.test(fig("paid")) && fig("paid").includes(`data-as-of="${new Date(AT.e).toISOString()}"`), "external payments are served with their value and as-of");
  ok(new RegExp(`>${RAILS.length}<`).test(fig("chains")) && fig("chains").includes(`data-as-of="${new Date(AT.c).toISOString()}"`), "chains live are served from the count given, with an as-of");
  ok(/>212 ms</.test(fig("latency")) && fig("latency").includes(`data-as-of="${new Date(AT.l).toISOString()}"`), "median latency is served with its as-of");
  ok(placeholders(h).length === 0, `the served hero holds no dash or loading placeholder (found: ${placeholders(h).join(" ") || "none"})`);
  ok(/66 of our own test purchases are not counted above/.test(h) && /\$56\.78 external revenue/.test(h), "our own test purchases are footnoted under the external figure");
  ok(/id="hm-live-stats" hidden/.test(h), "the ecosystem row is served hidden until the live view answers");
  ok(!/>1,300</.test(h), "the total that includes our own wallets is not shown as a figure");
}
{
  // A source with nothing yet leaves its figure out: no dash, no zero.
  const some = homeProofFigures({ uptime: null, external: null, chains: { value: { count: RAILS.length }, at: AT.c }, latency: { value: { p50Ms: 0 }, at: AT.l } });
  ok(some.map((f) => f.key).join(",") === "chains", "a missing or zero source is left out");
  const h = hero(ledgerHomePage("https://agent402.tools", catalog, {}, {}, [], { proof: some }));
  ok(!/id="hm-own-(uptime|paid|latency)"/.test(h) && placeholders(h).length === 0 && !/>0</.test((h.match(/<div class="hm-own"[\s\S]*?<\/div>/) || [""])[0]), "the left-out figures render nothing in their place");
  // Zero is "nothing yet", never a figure: no "0 chains live", no uptime
  // from a window with no observations.
  const zeroChains = homeProofFigures({ chains: { value: { count: 0 }, at: AT.c }, latency: { value: { p50Ms: 90 }, at: AT.l } });
  ok(zeroChains.map((f) => f.key).join(",") === "latency", `zero offered chains draw no chains figure (${zeroChains.map((f) => `${f.key}=${f.value}`).join(",")})`);
  const unobserved = homeProofFigures({ uptime: { value: { pct: 100, observed: 0, windowDays: 90 }, at: AT.u }, latency: { value: { p50Ms: 90 }, at: AT.l } });
  ok(unobserved.map((f) => f.key).join(",") === "latency", `uptime with no observations draws no uptime figure (${unobserved.map((f) => `${f.key}=${f.value}`).join(",")})`);
  const zh = hero(ledgerHomePage("https://agent402.tools", catalog, {}, {}, [], { proof: homeProofFigures({ uptime: { value: { pct: 100, observed: 0, windowDays: 90 }, at: AT.u }, external: { value: { count: 0 }, at: AT.e }, chains: { value: { count: 0 }, at: AT.c } }) }));
  ok(!/class="hm-own"/.test(zh) && !/id="hm-own-/.test(zh), "a hero fed only zero sources draws no figure at all");
  // The status line beside the buttons follows the same offer.
  const line = (o) => hero(ledgerHomePage("https://agent402.tools", catalog, {}, {}, [], { chainsOffered: o }));
  ok(/>3 chains( \+ Tempo)? live</.test(line(3).replace(/<span class="ml-dot"><\/span>/, "")) && !/chains( \+ Tempo)? live/.test(line(0)), "the hero's chains-live line counts the offered chains and leaves the count out at zero");
  const none = hero(ledgerHomePage("https://agent402.tools", catalog, {}, {}, []));
  ok(!/class="hm-own"/.test(none) && placeholders(none).length === 0, "with no figures at all the panel serves no grid and no placeholder");
  ok(!/not counted above/.test(none), "no footnote without the figure it qualifies");
}

// --- a slow source does not hold the page --------------------------------------------
{
  let started = 0;
  // Never answers: only a page that does not wait on it can render.
  const slow = proofCell(() => { started++; return new Promise(() => {}); });
  const lim = bound(50, 4);
  const { value: html, ms } = timeOurs(() => ledgerHomePage("https://agent402.tools", catalog, {}, {}, [], {
    proof: homeProofFigures({ uptime: slow.peek(), chains: { value: { count: RAILS.length }, at: AT.c } }),
  }));
  await new Promise((r) => setImmediate(r));
  ok(started === 1 && /id="hm-own-chains"/.test(html) && !/id="hm-own-uptime"/.test(html), "with a source that never answers, the page renders the figures it has and leaves that one out");
  ok(ms <= lim.ms, `the render took ${ms.toFixed(1)} ms (${lim.note})`);
}

// --- the served page -------------------------------------------------------------------
{
  const token = "home-proof-probe-token";
  const srv = await bootServer({ env: { FREE_MODE: "true", STATUS_PROBE_TOKEN: token }, stores: "home-proof" });
  try {
    const now = Date.now();
    const probes = Array.from({ length: 12 }, (_, i) => ({ component: "api", ok: i !== 3, ts: now - (12 - i) * 300_000 }));
    const w = await fetch(`${srv.url}/api/status/probe`, { method: "POST", headers: { "content-type": "application/json", "x-operator-token": token }, body: JSON.stringify({ source: "heartbeat", probes }) });
    ok(w.status === 200, `the probe intake recorded the test observations (${w.status})`);

    const first = await fetch(`${srv.url}/`);
    const h1 = hero(await first.text());
    ok(first.status === 200 && placeholders(h1).length === 0, `GET / serves the hero with no placeholder (found: ${placeholders(h1).join(" ") || "none"})`);
    // The chains figure is the offer /api/rails reports, not the static
    // list: present with that count when a rail is offered, absent otherwise.
    const chains = (h1.match(/<a class="hm-own-fig" id="hm-own-chains"[^>]*>[\s\S]*?<\/a>/) || [""])[0];
    const offered = Number((await (await fetch(`${srv.url}/api/rails`)).json()).offered) || 0;
    ok(offered > 0
      ? new RegExp(`>${offered}<`).test(chains) && /data-as-of="\d{4}-\d\d-\d\dT[^"]+"/.test(chains)
      : chains === "" && !/chains live/.test(h1),
    `GET / serves the chains figure from the offered rails (/api/rails offered ${offered}, of ${RAILS.length} listed): ${chains ? "drawn" : "left out"}`);

    // The uptime cell reads the /status snapshot in the background; the page
    // carries the figure once that read lands (deadline, not a fixed sleep).
    let uptime = "";
    const deadline = Date.now() + 30_000;
    while (!uptime && Date.now() < deadline) {
      const h = hero(await (await fetch(`${srv.url}/`)).text());
      uptime = (h.match(/<a class="hm-own-fig" id="hm-own-uptime"[^>]*>[\s\S]*?<\/a>/) || [""])[0];
      if (!uptime) await new Promise((r) => setTimeout(r, 200));
    }
    ok(/>91\.67%</.test(uptime) && /href="\/status"/.test(uptime) && /data-as-of="\d{4}-/.test(uptime), `GET / serves uptime as the outside observations measured it (${uptime.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim() || "absent"})`);

    const stats = await fetch(`${srv.url}/api/stats`);
    ok(stats.status === 200, `/api/stats still answers (${stats.status})`);
  } finally {
    await srv.stop();
  }
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
