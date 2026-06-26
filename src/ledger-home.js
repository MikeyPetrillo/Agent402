// Machine Ledger — Home page ("Agent402 Ledger")
// The primary marketing page: hero, receipt, registry manifest, three ways in,
// catalog index, leaderboard preview, settlement tape, proof, FAQ, CTA, footer.

import { ledgerShell, ledgerFooterFull, ledgerTape, esc } from "./ledger-chrome.js";
import { toolList, CATEGORIES } from "./pages.js";
import { isComputePayable } from "./pow.js";

const fmtNum = (n) => Number(n || 0).toLocaleString("en-US");

export function ledgerHomePage(baseUrl, catalog, stats, leaderboardSnapshot, skillPacks) {
  const tools = toolList(catalog);
  const count = tools.length;
  const freeCount = tools.filter(isComputePayable).length;
  const served = stats?.toolCallsServed;
  const recent = Array.isArray(stats?.recentCalls) ? stats.recentCalls : [];
  const board = Array.isArray(leaderboardSnapshot?.leaderboard) ? leaderboardSnapshot.leaderboard : [];
  const packCount = Array.isArray(skillPacks) ? skillPacks.length : 42;

  // Category data for the index
  const catEntries = Object.entries(CATEGORIES);
  const catData = catEntries.map(([key, { label, blurb }]) => {
    const inCat = tools.filter((t) => t.category === key);
    if (!inCat.length) return null;
    const cheapest = inCat.reduce((a, t) => Math.min(a, parseFloat(t.price.slice(1))), Infinity);
    return { key, label, blurb, count: inCat.length, price: `$${cheapest}` };
  }).filter(Boolean);
  const mid = Math.ceil(catData.length / 2);
  const leftCats = catData.slice(0, mid);
  const rightCats = catData.slice(mid);

  const catRow = (c, last) =>
    `<div style="display:grid;grid-template-columns:1fr auto auto;gap:14px;align-items:center;padding:13px 18px;${last ? "" : "border-bottom:1px solid var(--hairline);"}${c.key === "convert" ? "background:var(--card-zebra);" : ""}"><div><div style="font-weight:700;font-size:15px;">${esc(c.label)}</div><div style="font-family:var(--font-mono);font-size:11.5px;color:var(--faint);">${esc(c.blurb.length > 50 ? c.blurb.slice(0, 50) + "…" : c.blurb)}</div></div><span style="font-family:var(--font-mono);font-weight:700;font-size:15px;">${fmtNum(c.count)}</span><span style="font-family:var(--font-mono);font-size:11px;color:var(--accent);width:56px;text-align:right;">${c.price}</span></div>`;

  // Leaderboard preview (top 5)
  const top5 = board.slice(0, 5);
  const lbRow = (r, i) => {
    const rank = String(i + 1).padStart(2, "0");
    const isFirst = i === 0;
    return `<div style="display:grid;grid-template-columns:26px 1fr 86px 56px;gap:10px;padding:11px 18px;color:var(--cream);${i < top5.length - 1 ? "border-bottom:1px solid var(--dark-border);" : ""}${isFirst ? "background:linear-gradient(90deg,#d63c1a1f,transparent);" : ""}"><span style="color:${isFirst ? "var(--accent)" : "var(--dk-muted3)"};">${rank}</span><span>${esc(r.name)}</span><span style="text-align:right;color:var(--cream2);">$${Number(r.totalUsd || 0).toFixed(2)}</span><span style="text-align:right;color:var(--dk-muted2);">${fmtNum(r.uniqueBuyers || 0)}</span></div>`;
  };

  const canonical = baseUrl + "/";
  const title = `Agent402 — the open x402 index (${fmtNum(count)} tools)`;
  const description = `${fmtNum(count)} deterministic, pay-per-call tools your agent can use mid-task. Free via proof-of-work; USDC on Base + 3 more chains from $0.001/call. No signup, no API key — the wallet is the identity.`;

  const jsonLd = [
    {
      "@context": "https://schema.org",
      "@type": "WebSite",
      name: "Agent402.Tools",
      url: baseUrl,
      description,
      potentialAction: { "@type": "SearchAction", target: `${baseUrl}/api/find?q={search_term_string}`, "query-input": "required name=search_term_string" },
    },
    {
      "@context": "https://schema.org",
      "@type": "WebApplication",
      name: "Agent402.Tools",
      url: baseUrl,
      applicationCategory: "DeveloperApplication",
      operatingSystem: "Any",
      offers: { "@type": "Offer", price: "0.001", priceCurrency: "USD", description: "Pay-per-call USDC on Base, Solana, Polygon & Arbitrum" },
    },
  ];

  const body = `
  <!-- HERO -->
  <header style="position:relative;overflow:hidden;border-bottom:1.5px solid var(--ink);background-image:repeating-linear-gradient(#16150f0a 0,#16150f0a 1px,transparent 1px,transparent 34px);">
    <div style="position:absolute;right:-30px;top:10px;font-family:var(--font-body);font-weight:900;font-size:420px;line-height:1;letter-spacing:-.04em;color:transparent;-webkit-text-stroke:2px #16150f14;pointer-events:none;user-select:none;">402</div>
    <div style="max-width:1180px;margin:0 auto;padding:70px 30px 0;position:relative;">
      <div class="ml-hero-grid" style="display:grid;grid-template-columns:1.08fr .92fr;gap:50px;align-items:start;">
        <div>
          <div style="font-family:var(--font-mono);font-size:12px;letter-spacing:.14em;text-transform:uppercase;color:var(--muted);margin-bottom:22px;">▸ open source · x402 · ${fmtNum(count)} tools · free tier</div>
          <h1 class="ml-hero-h1" style="font-family:var(--font-body);font-weight:800;font-size:66px;line-height:.96;letter-spacing:-.03em;margin:0 0 8px;color:var(--ink);">Where agents<br><span style="color:var(--accent);">pay</span> agents.</h1>
          <div style="display:inline-block;transform:rotate(-7deg);border:2.5px solid var(--accent);color:var(--accent);padding:5px 11px 4px;margin:14px 0 22px;font-family:var(--font-mono);font-weight:700;font-size:11px;letter-spacing:.12em;line-height:1.3;text-align:center;">PAYMENT REQUIRED<br><span style="font-size:9px;letter-spacing:.18em;opacity:.8;">· 402 · agent402.tools ·</span></div>
          <p style="font-size:17px;line-height:1.55;color:var(--muted);max-width:500px;margin:0 0 30px;">${fmtNum(count)} deterministic, pay-per-call tools your agent can use mid-task — extract PDFs, render pages, geocode, fetch SEC filings. Free via proof-of-work; USDC on Base + 3 more chains from <strong style="color:var(--ink);font-weight:700;">$0.001/call</strong> when you scale. No signup, no API keys — <strong style="color:var(--ink);font-weight:700;">the wallet is the identity</strong>.</p>
          <div style="display:flex;flex-wrap:wrap;align-items:center;gap:11px;">
            <a href="/docs" style="background:var(--accent);color:#fff;font-family:var(--font-mono);font-weight:700;font-size:14px;text-decoration:none;padding:13px 20px;">ADD TO CLAUDE →</a>
            <a href="/tools" style="background:transparent;border:1.5px solid var(--ink);color:var(--ink);font-family:var(--font-mono);font-weight:700;font-size:14px;text-decoration:none;padding:12px 20px;">BROWSE ${fmtNum(count)} TOOLS</a>
          </div>
        </div>
        <div style="background:var(--ink);border:1.5px solid var(--ink);box-shadow:8px 8px 0 #16150f1f;">
          <div style="display:flex;align-items:center;justify-content:space-between;padding:11px 15px;border-bottom:1px solid var(--dark-border2);font-family:var(--font-mono);font-size:11px;color:var(--dk-muted);letter-spacing:.06em;"><span>~ / agent402</span><span>SH</span></div>
          <pre style="margin:0;padding:20px 18px;font-family:var(--font-mono);font-size:12.5px;line-height:1.85;color:#E7DFCD;white-space:pre-wrap;word-break:break-word;"><span style="color:var(--dk-muted3);"># ${fmtNum(count)} x402 tools in Claude Code.
# no signup, no API key.
</span><span style="color:var(--accent);">$</span> <span style="color:var(--cream);">claude mcp add agent402 -s user \\
    -- npx -y agent402-mcp@latest

</span><span style="color:var(--dk-muted3);"># then ask Claude:
# "extract the tables from this PDF"
# free tier pays in compute.
# USDC on Base + 3 more chains when you scale.</span></pre>
        </div>
      </div>

      <!-- LEDGER BAND -->
      <div class="ml-2col" style="display:grid;grid-template-columns:1fr 1fr;gap:18px;margin-top:54px;padding-bottom:50px;">
        <div style="border:1.5px solid var(--ink);background:var(--card);padding:18px 20px;">
          <div style="display:flex;align-items:center;justify-content:space-between;font-family:var(--font-mono);font-size:11px;letter-spacing:.1em;color:var(--muted);border-bottom:1px dashed #b3a98f;padding-bottom:10px;margin-bottom:12px;"><span>·· RECEIPT ··</span><span>since ${stats?.servingSince ? String(stats.servingSince).slice(0, 10) : "2026-06-12"}</span></div>
          <div style="display:flex;flex-direction:column;gap:9px;font-family:var(--font-mono);font-size:14px;">
            <div style="display:flex;align-items:baseline;gap:8px;"><span style="color:var(--muted);">x402 tools</span><span style="flex:1;border-bottom:1.5px dotted #b3a98f;transform:translateY(-4px);"></span><span style="font-weight:700;">${fmtNum(count)}</span></div>
            <div style="display:flex;align-items:baseline;gap:8px;"><span style="color:var(--muted);">free · no wallet</span><span style="flex:1;border-bottom:1.5px dotted #b3a98f;transform:translateY(-4px);"></span><span style="font-weight:700;">${fmtNum(freeCount)}</span></div>
            <div style="display:flex;align-items:baseline;gap:8px;"><span style="color:var(--muted);">starting / call</span><span style="flex:1;border-bottom:1.5px dotted #b3a98f;transform:translateY(-4px);"></span><span style="font-weight:700;color:var(--accent);">$0.001</span></div>
            <div style="display:flex;align-items:baseline;gap:8px;"><span style="color:var(--muted);">calls settled</span><span style="flex:1;border-bottom:1.5px dotted #b3a98f;transform:translateY(-4px);"></span><span style="font-weight:700;">${fmtNum(served?.total || 0)}</span></div>
          </div>
        </div>
        <div style="border:1.5px solid var(--ink);background:var(--card);padding:18px 20px;">
          <div style="display:flex;align-items:center;justify-content:space-between;font-family:var(--font-mono);font-size:11px;letter-spacing:.1em;color:var(--muted);border-bottom:1px dashed #b3a98f;padding-bottom:10px;margin-bottom:12px;"><span>·· REGISTERED ON ··</span><span>verified</span></div>
          <div style="display:grid;grid-template-columns:1fr 1fr;gap:9px 18px;font-family:var(--font-mono);font-size:13.5px;">
            <div style="display:flex;gap:8px;"><span style="color:var(--accent);font-weight:700;">✓</span> Coinbase CDP Bazaar</div>
            <div style="display:flex;gap:8px;"><span style="color:var(--accent);font-weight:700;">✓</span> MCP Registry</div>
            <div style="display:flex;gap:8px;"><span style="color:var(--accent);font-weight:700;">✓</span> npm</div>
            <div style="display:flex;gap:8px;"><span style="color:var(--accent);font-weight:700;">✓</span> GitHub</div>
            <div style="display:flex;gap:8px;"><span style="color:var(--accent);font-weight:700;">✓</span> Base · USDC</div>
            <div style="display:flex;gap:8px;"><span style="color:var(--accent);font-weight:700;">✓</span> OpenAPI 3.1</div>
          </div>
        </div>
      </div>
    </div>
  </header>

  <!-- THREE WAYS IN -->
  <section style="max-width:1180px;margin:0 auto;padding:78px 30px 20px;">
    <div style="font-family:var(--font-mono);font-size:13px;color:var(--accent);margin-bottom:12px;">$ POST /connect</div>
    <h2 style="font-family:var(--font-body);font-weight:800;font-size:44px;line-height:1;letter-spacing:-.02em;margin:0 0 10px;color:var(--ink);">Three ways in.</h2>
    <p style="font-size:16px;color:var(--muted);max-width:540px;margin:0 0 36px;">Same surface underneath — payment handled automatically: proof-of-work for free tools, your x402 wallet for paid.</p>
    <div class="ml-2col" style="display:grid;grid-template-columns:repeat(3,1fr);gap:0;border:1.5px solid var(--ink);">
      <div style="padding:22px;border-right:1.5px solid var(--ink);display:flex;flex-direction:column;background:var(--card);">
        <div style="font-family:var(--font-mono);font-size:12px;color:var(--accent);margin-bottom:14px;">01 / YOUR AGENT</div>
        <p style="font-size:14px;line-height:1.5;color:var(--muted);margin:0 0 16px;flex:1;">Pay in code with any x402 client — <span style="font-family:var(--font-mono);font-size:12.5px;">@x402/fetch</span>, axios, or your framework.</p>
        <pre style="margin:0 0 14px;background:var(--ink);color:var(--cream);padding:13px;font-family:var(--font-mono);font-size:11.5px;line-height:1.65;white-space:pre-wrap;word-break:break-word;"><span style="color:var(--dk-muted3);">// signs USDC, retries on 402
</span>await payFetch(
  "…/api/extract", { url })</pre>
        <a href="/docs" style="font-family:var(--font-mono);font-size:12.5px;color:var(--ink);text-decoration:none;border-bottom:1.5px solid var(--accent);align-self:flex-start;padding-bottom:1px;">read the docs →</a>
      </div>
      <div style="padding:22px;border-right:1.5px solid var(--ink);display:flex;flex-direction:column;background:var(--card);">
        <div style="font-family:var(--font-mono);font-size:12px;color:var(--accent);margin-bottom:14px;">02 / CLAUDE · MCP</div>
        <p style="font-size:14px;line-height:1.5;color:var(--muted);margin:0 0 16px;flex:1;">Paste the hosted connector URL — zero install. Pure-CPU tools run free, rate-limited.</p>
        <pre style="margin:0 0 14px;background:var(--ink);color:var(--cream);padding:13px;font-family:var(--font-mono);font-size:11.5px;line-height:1.65;white-space:pre-wrap;word-break:break-word;"><span style="color:var(--dk-muted3);"># Settings → Connectors
</span>https://agent402.tools/mcp</pre>
        <a href="/docs" style="font-family:var(--font-mono);font-size:12.5px;color:var(--ink);text-decoration:none;border-bottom:1.5px solid var(--accent);align-self:flex-start;padding-bottom:1px;">add connector →</a>
      </div>
      <div style="padding:22px;display:flex;flex-direction:column;background:var(--card);">
        <div style="font-family:var(--font-mono);font-size:12px;color:var(--accent);margin-bottom:14px;">03 / YOUR CODE</div>
        <p style="font-size:14px;line-height:1.5;color:var(--muted);margin:0 0 16px;flex:1;">The <span style="font-family:var(--font-mono);font-size:12.5px;">agent402-client</span> SDK resolves a task to a tool and pays automatically.</p>
        <pre style="margin:0 0 14px;background:var(--ink);color:var(--cream);padding:13px;font-family:var(--font-mono);font-size:11.5px;line-height:1.65;white-space:pre-wrap;word-break:break-word;"><span style="color:var(--dk-muted3);">// free tier, zero deps
</span>await a.call("hash",
  { text, algo:"sha256" })</pre>
        <a href="/docs" style="font-family:var(--font-mono);font-size:12.5px;color:var(--ink);text-decoration:none;border-bottom:1.5px solid var(--accent);align-self:flex-start;padding-bottom:1px;">install the SDK →</a>
      </div>
    </div>
    <div style="font-family:var(--font-mono);font-size:12px;color:var(--faint);margin-top:14px;">+ zero-dep adapters: openai · anthropic · langchain · llamaindex · vercel-ai · google-adk · aws-strands</div>
  </section>

  <!-- CATALOG INDEX -->
  <section style="max-width:1180px;margin:0 auto;padding:70px 30px 20px;">
    <div style="font-family:var(--font-mono);font-size:13px;color:var(--accent);margin-bottom:12px;">$ GET /catalog</div>
    <div style="display:flex;align-items:flex-end;justify-content:space-between;gap:20px;flex-wrap:wrap;margin-bottom:28px;">
      <h2 style="font-family:var(--font-body);font-weight:800;font-size:44px;line-height:1;letter-spacing:-.02em;margin:0;color:var(--ink);">The index — ${fmtNum(count)} tools.</h2>
      <span style="font-family:var(--font-mono);font-size:12.5px;color:var(--faint);">deterministic · flat-priced · no LLM in the path</span>
    </div>
    <div style="border:1.5px solid var(--ink);background:var(--card);">
      <div class="ml-2col" style="display:grid;grid-template-columns:1fr 1fr;">
        <div style="border-right:1.5px solid var(--ink);">
          ${leftCats.map((c, i) => catRow(c, i === leftCats.length - 1)).join("\n          ")}
        </div>
        <div>
          ${rightCats.map((c, i) => catRow(c, false)).join("\n          ")}
          <a href="/tools" style="display:grid;grid-template-columns:1fr auto;gap:14px;align-items:center;padding:14px 18px;text-decoration:none;color:var(--ink);background:var(--ink);"><span style="font-family:var(--font-mono);font-weight:700;font-size:14px;color:var(--cream);">Browse all ${fmtNum(count)} tools →</span><span style="font-family:var(--font-mono);font-size:11px;color:var(--dk-muted);">+${packCount} skill packs</span></a>
        </div>
      </div>
    </div>
  </section>

  <!-- NEUTRAL LAYER / LEADERBOARD -->
  <section style="background:var(--ink);margin-top:70px;border-top:1.5px solid var(--ink);border-bottom:1.5px solid var(--ink);">
    <div style="max-width:1180px;margin:0 auto;padding:76px 30px;">
      <div style="font-family:var(--font-mono);font-size:13px;color:var(--accent);margin-bottom:12px;">$ GET /api/leaderboard</div>
      <div class="ml-2col" style="display:grid;grid-template-columns:1fr 1.1fr;gap:50px;align-items:center;">
        <div>
          <h2 style="font-family:var(--font-body);font-weight:800;font-size:44px;line-height:1;letter-spacing:-.02em;margin:0 0 16px;color:var(--cream2);">Not just a seller —<br>the neutral index.</h2>
          <p style="font-size:16px;line-height:1.6;color:var(--dk-muted2);margin:0 0 22px;">Index + Smart Order Router + Leaderboard, auto-crawled from the Coinbase CDP Bazaar and ranked by <strong style="color:var(--cream2);font-weight:700;">real on-chain USDC volume</strong>. Route a task across every x402 seller — not just ours.</p>
          <div style="display:flex;gap:20px;flex-wrap:wrap;font-family:var(--font-mono);font-size:13px;">
            <a href="/api/route" style="color:var(--accent);text-decoration:none;">/api/route →</a>
            <a href="/index" style="color:var(--accent);text-decoration:none;">/index →</a>
          </div>
        </div>
        <div style="border:1.5px solid var(--dark-border2);background:var(--ink-panel);">
          <div style="display:flex;align-items:center;justify-content:space-between;padding:13px 18px;border-bottom:1px solid var(--dark-border2);font-family:var(--font-mono);">
            <span style="font-size:11px;color:var(--dk-muted2);letter-spacing:.06em;">SELLERS · BY USDC SETTLED</span>
            <span style="display:flex;align-items:center;gap:6px;font-size:11px;color:var(--accent);"><span style="width:6px;height:6px;border-radius:50%;background:var(--accent);display:inline-block;animation:ml-pulse 1.8s ease-in-out infinite;"></span>LIVE</span>
          </div>
          <div style="font-family:var(--font-mono);font-size:12.5px;">
            <div style="display:grid;grid-template-columns:26px 1fr 86px 56px;gap:10px;padding:9px 18px;color:var(--dk-muted3);border-bottom:1px solid var(--dark-border);"><span>#</span><span>seller</span><span style="text-align:right;">usdc</span><span style="text-align:right;">buyers</span></div>
            ${top5.map((r, i) => lbRow(r, i)).join("\n            ")}
          </div>
          <div style="padding:10px 18px;border-top:1px solid var(--dark-border2);font-family:var(--font-mono);font-size:11px;color:var(--dk-muted3);">hourly on-chain snapshot · ?include=external</div>
        </div>
      </div>
    </div>
  </section>

  <!-- SETTLEMENT TAPE -->
  ${ledgerTape(recent)}

  <!-- PROOF -->
  <section style="max-width:1180px;margin:0 auto;padding:78px 30px 20px;">
    <div style="font-family:var(--font-mono);font-size:13px;color:var(--accent);margin-bottom:12px;">$ GET /verify</div>
    <h2 style="font-family:var(--font-body);font-weight:800;font-size:44px;line-height:1;letter-spacing:-.02em;margin:0 0 10px;color:var(--ink);">Every claim, checkable.</h2>
    <p style="font-size:16px;color:var(--muted);max-width:580px;margin:0 0 32px;">No sales calls, no contracts. Deterministic outputs, flat prices, a named maintainer, fully open source — asserted by nobody, verifiable by anybody.</p>
    <div style="border:1.5px solid var(--ink);background:var(--card);">
      <div style="display:grid;grid-template-columns:200px 1fr auto;gap:16px;align-items:center;padding:16px 20px;border-bottom:1px solid var(--hairline);"><div style="display:flex;gap:9px;align-items:center;"><span style="color:var(--accent);font-weight:700;font-family:var(--font-mono);">✓</span><span style="font-weight:700;font-size:15px;">On-chain settlements</span></div><span style="font-size:13.5px;color:var(--muted);">Every paid call lands at agent402.base.eth on Base USDC — verifiable on Basescan.</span><code style="font-family:var(--font-mono);font-size:11.5px;color:var(--ink);background:#e3dac3;padding:4px 8px;">0xaBF4…a9D0</code></div>
      <div style="display:grid;grid-template-columns:200px 1fr auto;gap:16px;align-items:center;padding:16px 20px;border-bottom:1px solid var(--hairline);"><div style="display:flex;gap:9px;align-items:center;"><span style="color:var(--accent);font-weight:700;font-family:var(--font-mono);">✓</span><span style="font-weight:700;font-size:15px;">Open source</span></div><span style="font-size:13.5px;color:var(--muted);">Read every line that serves and prices your call. Self-host the whole thing free.</span><code style="font-family:var(--font-mono);font-size:11.5px;color:var(--ink);background:#e3dac3;padding:4px 8px;">github.com/…/Agent402</code></div>
      <div style="display:grid;grid-template-columns:200px 1fr auto;gap:16px;align-items:center;padding:16px 20px;border-bottom:1px solid var(--hairline);"><div style="display:flex;gap:9px;align-items:center;"><span style="color:var(--accent);font-weight:700;font-family:var(--font-mono);">✓</span><span style="font-weight:700;font-size:15px;">Deterministic</span></div><span style="font-size:13.5px;color:var(--muted);">No LLM anywhere in the serving path. Same input, same bytes — no token spend.</span><code style="font-family:var(--font-mono);font-size:11.5px;color:var(--ink);background:#e3dac3;padding:4px 8px;">re-tested per deploy</code></div>
      <div style="display:grid;grid-template-columns:200px 1fr auto;gap:16px;align-items:center;padding:16px 20px;border-bottom:1px solid var(--hairline);"><div style="display:flex;gap:9px;align-items:center;"><span style="color:var(--accent);font-weight:700;font-family:var(--font-mono);">✓</span><span style="font-weight:700;font-size:15px;">CDP Bazaar</span></div><span style="font-size:13.5px;color:var(--muted);">Discoverable on the index AI agents browse for x402 services, keyed to our payTo.</span><code style="font-family:var(--font-mono);font-size:11.5px;color:var(--ink);background:#e3dac3;padding:4px 8px;">x402/discovery</code></div>
      <div style="display:grid;grid-template-columns:200px 1fr auto;gap:16px;align-items:center;padding:16px 20px;"><div style="display:flex;gap:9px;align-items:center;"><span style="color:var(--accent);font-weight:700;font-family:var(--font-mono);">✓</span><span style="font-weight:700;font-size:15px;">Self-describing</span></div><span style="font-size:13.5px;color:var(--muted);">Full OpenAPI 3.1 spec and machine-readable pricing for the entire catalog.</span><code style="font-family:var(--font-mono);font-size:11.5px;color:var(--ink);background:#e3dac3;padding:4px 8px;">GET /openapi.json</code></div>
    </div>
  </section>

  <!-- FAQ -->
  <section style="max-width:860px;margin:0 auto;padding:70px 30px 30px;">
    <div style="font-family:var(--font-mono);font-size:13px;color:var(--accent);margin-bottom:12px;">$ GET /faq</div>
    <h2 style="font-family:var(--font-body);font-weight:800;font-size:40px;line-height:1;letter-spacing:-.02em;margin:0 0 28px;color:var(--ink);">Questions.</h2>
    <div style="display:flex;flex-direction:column;">
      <div style="padding:20px 0;border-top:1.5px solid var(--ink);"><h3 style="font-size:16px;font-weight:700;margin:0 0 7px;">What is Agent402?</h3><p style="font-size:15px;line-height:1.55;color:var(--muted);margin:0;">A live node in the machine-to-machine economy: ${fmtNum(count)} web tools an autonomous agent can call and pay for per request in USDC via x402 — or with proof-of-work, no wallet. No human, no signup, no API key.</p></div>
      <div style="padding:20px 0;border-top:1px solid var(--hairline);"><h3 style="font-size:16px;font-weight:700;margin:0 0 7px;">How does an agent pay for a tool?</h3><p style="font-size:15px;line-height:1.55;color:var(--muted);margin:0;">It calls an endpoint and gets an HTTP 402 quote. An x402 client signs a USDC payment from the agent's own wallet on Base (or Solana, Polygon, Arbitrum) and retries; the call settles on-chain in seconds. The wallet is the identity.</p></div>
      <div style="padding:20px 0;border-top:1px solid var(--hairline);"><h3 style="font-size:16px;font-weight:700;margin:0 0 7px;">Are any tools free?</h3><p style="font-size:15px;line-height:1.55;color:var(--muted);margin:0;">Yes — ${fmtNum(freeCount)} of the ${fmtNum(count)} pure-CPU tools work with no wallet: solve a short proof-of-work puzzle (a few seconds of CPU) instead of paying USDC.</p></div>
      <div style="padding:20px 0;border-top:1px solid var(--hairline);"><h3 style="font-size:16px;font-weight:700;margin:0 0 7px;">Does it spend my model tokens?</h3><p style="font-size:15px;line-height:1.55;color:var(--muted);margin:0;">No. Every tool is deterministic code — parsers, hashes, math, a real browser — with no LLM in the path. Tools like /api/extract exist to save your tokens: clean markdown out instead of 100k tokens of raw HTML in.</p></div>
      <div style="padding:20px 0;border-top:1px solid var(--hairline);border-bottom:1.5px solid var(--ink);"><h3 style="font-size:16px;font-weight:700;margin:0 0 7px;">Which frameworks are supported?</h3><p style="font-size:15px;line-height:1.55;color:var(--muted);margin:0;">Zero-dependency adapters on npm for OpenAI, Anthropic, LangChain, LlamaIndex, Vercel AI SDK, Google ADK and AWS Strands — each returning native tool objects with payment handled underneath.</p></div>
    </div>
  </section>

  <!-- CTA -->
  <section style="max-width:1180px;margin:0 auto;padding:20px 30px 64px;">
    <div style="background:var(--ink);padding:52px 44px;position:relative;overflow:hidden;">
      <div style="position:absolute;right:24px;top:-30px;font-family:var(--font-body);font-weight:900;font-size:220px;line-height:1;color:transparent;-webkit-text-stroke:2px #ffffff12;pointer-events:none;">402</div>
      <div style="position:relative;">
        <h2 style="font-family:var(--font-body);font-weight:800;font-size:42px;line-height:1;letter-spacing:-.02em;margin:0 0 14px;color:var(--cream2);">No signup. No API keys.<br>Just pay-per-call.</h2>
        <p style="font-size:16px;color:var(--dk-muted2);margin:0 0 26px;max-width:460px;">Add ${fmtNum(count)} tools to your agent in 60 seconds. Free tier, no wallet — settle in USDC when you scale.</p>
        <div style="display:flex;gap:11px;flex-wrap:wrap;">
          <a href="/docs" style="background:var(--accent);color:#fff;font-family:var(--font-mono);font-weight:700;font-size:14px;text-decoration:none;padding:13px 22px;">ADD TO CLAUDE →</a>
          <a href="/docs" style="background:transparent;border:1.5px solid #4a4738;color:var(--cream);font-family:var(--font-mono);font-weight:700;font-size:14px;text-decoration:none;padding:12px 22px;">READ THE DOCS</a>
        </div>
      </div>
    </div>
  </section>

  ${ledgerFooterFull()}`;

  return ledgerShell({ title, description, canonical, baseUrl, activePath: "", jsonLd, body });
}
