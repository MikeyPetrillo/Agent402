// Register Agent402 on the agent402.app marketplace via their REST API —
// idempotent, re-runnable. Creates the provider "agent", one "service" per
// money-maker tool (pointing at our marketplace bridge so paid invokes settle
// once), and publishes the listing. The on-chain ERC-8004 mint and wallet
// verification are wallet-signature steps the operator does once in their UI;
// this script does everything else.
//
// Env:
//   A402APP_KEY        agent402.app API key (Settings → API Keys). Required.
//   A402APP_BASE       default https://marketplace.agent402.app
//   SITE               our public base, default https://agent402.tools
//   MARKETPLACE_TOKEN  master bridge secret. Required. NEVER appears in a URL —
//                      each service_endpoint carries only HMAC(master, slug).
//   WALLET_ADDRESS     our USDC receiving wallet (informational; settlement is on-chain)
//   DRY_RUN=1          print what would happen without writing

import { marketplaceSlugToken } from "../src/marketplace-token.js";

const API = (process.env.A402APP_BASE || "https://marketplace.agent402.app").replace(/\/$/, "");
const KEY = process.env.A402APP_KEY;
const SITE = (process.env.SITE || "https://agent402.tools").replace(/\/$/, "");
const TOKEN = process.env.MARKETPLACE_TOKEN;
const DRY = process.env.DRY_RUN === "1";

if (!KEY) { console.error("A402APP_KEY is required (agent402.app → Settings → API Keys)"); process.exit(1); }
if (!TOKEN && !DRY) { console.error("MARKETPLACE_TOKEN is required (same value the server uses for the bridge)"); process.exit(1); }

const AGENT_NAME = "Agent402 Tools";
const SETTLEMENT = "eip155:8453"; // Base mainnet — matches our x402 settlement

// The services to list. Slugs match our catalog; the bridge dispatches by slug.
// Prices mirror our own catalog. These are the capabilities worth surfacing —
// not all 1,071 tools (the conversion long-tail stays discovery-only on our site).
const SERVICES = [
  { slug: "search", name: "Web Search", price: 0.01, tags: ["search", "web-search", "fresh-data", "research"],
    description: "Live web search: ranked results (title, URL, snippet, age) from an independent index as clean JSON — fresh pages a model's training cutoff has never seen." },
  { slug: "extract", name: "Extract Article", price: 0.005, tags: ["scraping", "markdown", "content-extraction"],
    description: "Extract the main article from any URL as clean markdown (title, byline, word count) — strips nav/ads/scripts so you spend tokens on content, not cruft." },
  { slug: "render", name: "Render Page (headless browser)", price: 0.02, tags: ["browser", "javascript", "spa", "render"],
    description: "Render a page in real headless Chromium (JavaScript executed) and return readable markdown — works on SPAs where a plain fetch returns an empty shell." },
  { slug: "screenshot", name: "Screenshot", price: 0.02, tags: ["browser", "screenshot", "png"],
    description: "Full-page or viewport PNG screenshot of any URL, rendered in headless Chromium." },
  { slug: "pdf", name: "PDF Text Extraction", price: 0.01, tags: ["pdf", "text-extraction", "documents"],
    description: "Extract text and page count from any PDF URL — feed papers and reports straight into your model." },
  // "convert pdf" is the marketplace's #1 unmet demand (0% supply) — these serve it.
  { slug: "pdf-merge", name: "Merge PDFs", price: 0.004, tags: ["pdf", "merge", "convert-pdf"],
    description: "Combine several PDFs into one, in order — give a list of PDF URLs, get one merged PDF back (base64). Deterministic, no AI." },
  { slug: "pdf-extract-pages", name: "Split / Extract PDF Pages", price: 0.003, tags: ["pdf", "split", "convert-pdf"],
    description: "Pull a page range (e.g. \"1-3,5\") from a PDF into a new document. The split half of convert-pdf, deterministic." },
  { slug: "images-to-pdf", name: "Images to PDF", price: 0.004, tags: ["pdf", "images", "convert-pdf"],
    description: "Combine PNG/JPEG image URLs into a single PDF, one image per page. The classic image→PDF conversion." },
  { slug: "pdf-to-markdown", name: "PDF to Markdown", price: 0.01, tags: ["pdf", "markdown", "convert-pdf", "pdf-to-markdown"],
    description: "Convert a PDF to clean markdown — headings, paragraphs, and bullets reconstructed from the text layer, ready for a model's context. No AI, deterministic." },
  { slug: "audio-convert", name: "Audio Convert (to MP3)", price: 0.02, tags: ["ffmpeg", "mp4-to-mp3", "audio"],
    description: "Extract/convert the audio of any media URL (mp4, mov, wav, m4a…) to MP3 with real ffmpeg — the classic mp4-to-mp3, deterministic, no AI." },
  { slug: "audio-normalize", name: "Audio Normalize (EBU R128)", price: 0.02, tags: ["ffmpeg", "loudnorm", "audio"],
    description: "Loudness-normalize any audio/video URL to a target LUFS (ffmpeg loudnorm) and get MP3 back — consistent levels for podcasts, clips, and TTS output." },
  // NOTE: memory tools are intentionally NOT listed here. They key state to the
  // paying wallet's signature, which the marketplace's pay-then-forward model
  // strips — so they are only sold directly via our own x402 paywall, not the
  // bridge. The bridge serves stateless tools only.
];

async function api(method, path, body) {
  const res = await fetch(`${API}${path}`, {
    method,
    headers: { Authorization: `Bearer ${KEY}`, "X-API-Key": KEY, "Content-Type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json; try { json = JSON.parse(text); } catch { json = text; }
  if (!res.ok) throw new Error(`${method} ${path} → ${res.status}: ${typeof json === "string" ? json.slice(0, 300) : JSON.stringify(json).slice(0, 400)}`);
  return json;
}

// Per-slug bridge token: HMAC(master, slug) — must match the server's
// marketplaceSlugToken(). The master TOKEN never appears in a registered URL.
const slugToken = (slug) => marketplaceSlugToken(TOKEN, slug) || "<token>";
const serviceEndpoint = (slug) => `${SITE}/mkt/${slugToken(slug)}/${slug}`;

async function main() {
  console.log(`Marketplace: ${API}`);
  console.log(`Listing as "${AGENT_NAME}" → services bridge at ${SITE}/mkt/<per-slug-token>/<slug>\n`);

  // 1) Find or create our agent (provider card). Idempotent by name.
  let agent;
  if (DRY) {
    console.log("[dry-run] would GET /api/v1/agents to find an existing listing");
  } else {
    const existing = await api("GET", "/api/v1/agents");
    const agents = Array.isArray(existing) ? existing : existing.agents || existing.data || [];
    agent = agents.find((a) => a.name === AGENT_NAME);
  }

  if (!agent) {
    const payload = {
      name: AGENT_NAME,
      description: `1,071 pay-per-call web tools for AI agents via x402 (USDC on Base): live web search, headless-browser rendering & screenshots, PDF extraction, URL-to-markdown, and wallet-keyed memory & coordination. No signup, no API key. ${SITE}`,
      identity_provider_id: "erc8004",
      identity_network_caip2: "eip155:8453",
      settlement_network_caip2: SETTLEMENT,
    };
    if (DRY) { console.log("[dry-run] would POST /api/v1/agents", payload); agent = { id: "DRY_AGENT", name: AGENT_NAME }; }
    else { agent = await api("POST", "/api/v1/agents", payload); console.log(`created agent ${agent.id} (status: ${agent.status || "?"})`); }
  } else {
    console.log(`reusing agent ${agent.id} (status: ${agent.status || "?"})`);
  }

  // 2) Find or create each service. Idempotent by slug.
  let current = [];
  if (!DRY) {
    try { const s = await api("GET", `/api/v1/agents/${agent.id}/services`); current = Array.isArray(s) ? s : s.services || []; } catch { current = []; }
  }
  for (const [i, svc] of SERVICES.entries()) {
    const have = current.find((c) => c.slug === svc.slug || c.name === svc.name);
    const payload = {
      name: svc.name,
      description: svc.description,
      service_endpoint: serviceEndpoint(svc.slug),
      price_usd: svc.price,
      pricing_model: "per_call",
      is_primary: i === 0, // search is the flagship → primary
      tags: svc.tags,
      slug: svc.slug,
    };
    if (have) {
      // Update in place so endpoint changes (e.g. the per-slug bridge token) take
      // effect — don't skip, or a stale service_endpoint lingers on the marketplace.
      try {
        await api("PATCH", `/api/v1/agents/${agent.id}/services/${have.id}`, payload);
        console.log(`  updated service "${svc.name}" (${have.id}) → ${serviceEndpoint(svc.slug)}`);
      } catch (e) {
        // PATCH unsupported → recreate to refresh the endpoint.
        try { await api("DELETE", `/api/v1/agents/${agent.id}/services/${have.id}`); } catch {}
        const recreated = await api("POST", `/api/v1/agents/${agent.id}/services`, payload);
        console.log(`  recreated service "${svc.name}" → ${recreated.invoke_url || recreated.id}`);
      }
      continue;
    }
    if (DRY) { console.log(`  [dry-run] would POST service`, payload); continue; }
    const created = await api("POST", `/api/v1/agents/${agent.id}/services`, payload);
    console.log(`  created service "${svc.name}" → ${created.invoke_url || created.id}`);
  }

  // 2b) Remove any previously-listed service that's no longer in our set
  //     (e.g. memory-write, which can't work through the pay-then-forward bridge).
  const wanted = new Set(SERVICES.map((s) => s.slug));
  for (const c of current) {
    if (!wanted.has(c.slug)) {
      if (DRY) { console.log(`  [dry-run] would DELETE stale service "${c.slug}"`); continue; }
      try { await api("DELETE", `/api/v1/agents/${agent.id}/services/${c.id}`); console.log(`  removed stale service "${c.slug}"`); }
      catch (e) { console.log(`  (could not remove "${c.slug}": ${e.message})`); }
    }
  }

  // 3) Publish to the marketplace.
  const publish = { is_published: true, tagline: "1,071 web tools agents pay for per call — search, browser, memory. No signup.", tags: ["tools", "web-search", "browser", "memory", "x402", "agents"] };
  if (DRY) { console.log("[dry-run] would PATCH publish", publish); }
  else { await api("PATCH", `/api/v1/agents/${agent.id}`, publish); console.log(`\npublished agent ${agent.id} to the marketplace`); }

  console.log(`\nNext (one-time wallet steps in the agent402.app UI, which the API cannot sign for you):`);
  console.log(`  1. Settings → Operator Wallets → add + verify ${process.env.WALLET_ADDRESS || "your wallet"} on Base (sign a message).`);
  console.log(`  2. Sign the ERC-8004 identity mint when prompted (this makes the listing "active").`);
  console.log(`  Agent + services + bridge are already created; the listing goes live the moment the wallet is verified.`);
}

main().catch((e) => { console.error("FAILED:", e.message); process.exit(1); });
