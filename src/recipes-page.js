// /recipes: things a person can ask an AI app to do with Agent402, each as a
// prompt to copy, the tool it runs (linked to its tool page), and whether it
// is free or paid.
//
// Nothing here is typed that the catalog decides: free means the tool is on
// the proof-of-work tier (isComputePayable: src/free-tier.js and not
// WALLET_ONLY_SLUGS), a paid tool's price is its catalog price, and a
// model-backed tool says so from its own `modelBacked` flag. A recipe whose
// tool this boot does not list is left out, so the page never offers a tool
// the catalog does not serve. Every task here answers within the connector's
// blocking wait (a long call such as a video or a research report is not one
// tap from a phone, so it is not listed). The paid line reads the switch that
// sells credits through the connector (creditsConnectorOn).
import { ledgerShell, ledgerFooterCompact, esc, codeBlock, breadcrumbLd } from "./ledger-chrome.js";
import { siteOrgRef } from "./site-org.js";
import { isComputePayable } from "./pow.js";
import { creditsConnectorOn } from "./credits-sales.js";
import { START_PHONE_PATH, START_WALLET_PATH, START_APPS_PATH } from "./next-step-copy.js";

export const RECIPES_PATH = "/recipes";
export const RECIPES_TITLE = "Things you can do";

/**
 * The tasks, in page order. `prompt` is what a person pastes into the app;
 * `input` (optional) says what the tool takes today, where a person could
 * expect more. `site` in a prompt is this server's address.
 */
export const RECIPES = [
  { id: "research", task: "Research a topic", slug: "answer", prompt: () => "Use Agent402 web answer to research how solar panels are recycled today, and list the sources it cites." },
  { id: "summarize", task: "Summarize a link", slug: "summarize", prompt: () => "Use Agent402 to summarize this page in five bullet points: https://en.wikipedia.org/wiki/Honey_bee" },
  { id: "photo-text", task: "Read the text in an image", slug: "image-ocr", prompt: (site) => `Use Agent402 image OCR to read the text in the image at ${site}/card.png`, input: "It reads an image from a public link or from base64 data. A photo attached to the chat does not reach it, so give it a link." },
  { id: "image", task: "Make an image", slug: "image-gen", prompt: () => "Use Agent402 to generate an image of a lighthouse at sunrise, painted in watercolor." },
  { id: "qr", task: "Make a QR code", slug: "qr", prompt: () => "Use Agent402 to make a QR code for https://example.com" },
  { id: "time-zones", task: "Convert a meeting time", slug: "timezone-convert", prompt: () => "Use Agent402 to convert 2:00 PM on June 23, 2026 in New York to Tokyo time." },
  { id: "readability", task: "Check how easy your writing is to read", slug: "readability", prompt: () => "Use Agent402 to score how easy this is to read: The cat sat on the mat. It was warm." },
  { id: "units", task: "Convert units", slug: "unit-convert", prompt: () => "Use Agent402 to convert 10 kilometers to miles." },
];

/** A catalog price as a person reads it: a trailing zero past the cents is dropped, a tenth of a cent is kept. */
export function readablePrice(price) {
  const n = Number(String(price ?? "").replace(/[^0-9.]/g, ""));
  if (!Number.isFinite(n) || n <= 0) return null;
  return `$${n.toFixed(3).replace(/0$/, "")}`;
}

/** The recipes this catalog serves, each with its tool, access and price. */
export function servedRecipes(baseUrl, catalog = {}) {
  const bySlug = new Map(Object.values(catalog || {}).filter((d) => d && d.slug).map((d) => [d.slug, d]));
  return RECIPES.flatMap((r) => {
    const def = bySlug.get(r.slug);
    if (!def) return [];
    const free = isComputePayable(def);
    const price = free ? null : readablePrice(def.price);
    if (!free && !price) return [];
    return [{ ...r, prompt: r.prompt(baseUrl), name: def.name || def.slug, free, price, modelBacked: Boolean(def.modelBacked) }];
  });
}

const H2 = 'style="font-family:var(--font-body);font-weight:600;font-size:var(--fs-xl);margin:0 0 6px;"';
const P = 'style="color:var(--muted);font-size:var(--fs-base);line-height:1.6;margin:0 0 12px;"';
const A = 'style="color:var(--ink);text-decoration:none;border-bottom:1px solid var(--accent);"';
const META = 'style="color:var(--muted);font-size:var(--fs-sm);line-height:1.5;margin:0 0 12px;"';
const MONO = 'style="font-family:var(--font-mono);font-size:var(--fs-sm);color:var(--ink);"';

/** The page. `connector` defaults to this boot's switches; a test passes it to render each variant. */
export function recipesPage(baseUrl, catalog = {}, { connector = creditsConnectorOn() } = {}) {
  const canonical = `${baseUrl}${RECIPES_PATH}`;
  const title = "Things you can do with Agent402";
  const description = "Prompts to copy into Claude or any app with Agent402 added: research a topic, summarize a link, read text in an image, make an image or a QR code, and more.";
  const recipes = servedRecipes(baseUrl, catalog);
  const paidLine = connector
    ? `paid ones are paid from prepaid credits after an email sign-in (<a href="${START_APPS_PATH}" ${A}>connect your app</a>).`
    : `paid ones are paid from a wallet (<a href="${START_WALLET_PATH}" ${A}>set one up</a>).`;
  const card = (r) => {
    const access = r.free
      ? `<span ${MONO}>Free</span>`
      : `<span ${MONO}>${esc(r.price)}</span> a call`;
    const kind = r.modelBacked ? " · model-backed" : "";
    return `<div id="${esc(r.id)}" class="rc-card" style="border:1px solid var(--hairline);background:var(--card);border-radius:var(--radius);padding:18px 20px;">
        <h2 ${H2}>${esc(r.task)}</h2>
        <p ${META}><a href="/tools/${esc(r.slug)}" ${A}>${esc(r.name)}</a> · ${access}${kind}</p>
        ${r.input ? `<p ${P}>${esc(r.input)}</p>` : ""}
        ${codeBlock(r.prompt, { name: `the ${r.task.toLowerCase()} prompt`, wrap: true, style: "margin:0" })}
      </div>`;
  };
  const pageLd = {
    "@context": "https://schema.org", "@type": "ItemList", name: title, description, url: canonical, author: siteOrgRef(baseUrl),
    itemListElement: recipes.map((r, i) => ({ "@type": "ListItem", position: i + 1, name: r.task, url: `${canonical}#${r.id}` })),
  };
  const body = `
  <div style="max-width:1180px;margin:0 auto;padding:50px 30px 64px;">
    <h1 style="font-family:var(--font-display);font-weight:400;letter-spacing:-.01em;font-size:var(--fs-4xl);line-height:1.02;margin:0 0 20px;text-wrap:balance;">${esc(RECIPES_TITLE)}</h1>
    <p class="ml-measure" ${P}>Copy a prompt into an app with Agent402 added (<a href="/start" ${A}>start here</a>, or <a href="${START_PHONE_PATH}" ${A}>on your phone</a>). Free tools run with no wallet; ${paidLine} Model-backed means a model writes the answer.</p>
    <div class="rc-grid" style="display:grid;grid-template-columns:repeat(2,minmax(0,1fr));align-items:start;gap:14px;margin-top:28px;">
      ${recipes.map(card).join("\n      ")}
    </div>
  </div>
  ${ledgerFooterCompact()}`;
  // The copy buttons are tapped on a phone: each is a 44px target, as on /start.
  const extraCss = `main .ml-code-copy{min-height:44px;min-width:44px}@media (max-width:900px){.rc-grid{grid-template-columns:minmax(0,1fr)!important}}`;
  return ledgerShell({ title, description, canonical, baseUrl, activePath: RECIPES_PATH, jsonLd: [pageLd, breadcrumbLd(baseUrl, [["Agent402", "/"], [RECIPES_TITLE, RECIPES_PATH]])], extraCss, body });
}
