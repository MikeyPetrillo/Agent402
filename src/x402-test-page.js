// /x402-test - point your x402 client at us and find out exactly why it failed.
//
// WHY THIS PAGE EXISTS. We built a full payment-refusal classifier in August
// (src/payment-reject.js) and wired it into the 402 body, so a client that
// cannot pay us already gets told which field is wrong, in that response,
// free. Then we told nobody. Measured 2026-09-12: the busiest x402 seller by
// buyer count is a test endpoint - most of its ~1,900 buyers are developers
// paying a cent to check their client works - and being the endpoint people
// test against is how it collected them. We have the better version of that
// and no front door to it. This is the front door.
//
// The reason table is DERIVED from the classifier's own exported list, and a
// test scans that module for `reason:` literals, so this page cannot end up
// teaching a vocabulary the server no longer speaks.
import { ledgerShell, ledgerFooterCompact, esc } from "./ledger-chrome.js";
import { REJECTION_REASONS } from "./payment-reject.js";

import { repoUrl } from "./repo-link.js";
// The cheapest real route we sell: pure CPU, a fraction of a cent, no upstream
// to burn. A conformance probe should cost the buyer nothing to get wrong and
// almost nothing to get right.
const PROBE_PATH = "/api/hash";
const PROBE_PRICE = "$0.001";

export function x402TestPage(baseUrl) {
  const canonical = `${baseUrl}/x402-test`;
  const title = "Test your x402 client";
  const description =
    "Point any x402 or MPP client at a real paid endpoint and get told exactly why it was refused: which field differs, which scheme and network are offered, whether the signature recovered. Free, because a refusal is never charged.";

  const mono = "font-family:var(--font-mono);font-size:13px;";
  const pre = (s) => `<pre style="background:var(--surface);color:var(--on-dark);padding:18px 20px;overflow-x:auto;${mono}line-height:1.6;margin:0 0 18px;">${esc(s)}</pre>`;

  const rows = REJECTION_REASONS.map((r) => `
    <tr>
      <td style="padding:10px 14px 10px 0;vertical-align:top;${mono}color:var(--ink);white-space:nowrap;">${esc(r.reason)}</td>
      <td style="padding:10px 0;vertical-align:top;font-size:15px;line-height:1.6;color:var(--muted);">${esc(r.means)}</td>
    </tr>`).join("");

  const body = `
<header style="border-bottom:1px solid var(--hairline);">
  <div style="max-width:1180px;margin:0 auto;padding:52px 30px 44px;">
    <nav aria-label="Breadcrumb" style="${mono}font-size:12px;color:var(--faint);margin-bottom:22px;">
      <a href="/" style="color:var(--muted);text-decoration:none;">agent402</a> / <span style="color:var(--ink);">test your client</span>
    </nav>
    <h1 style="font-weight:800;font-size:52px;line-height:.96;letter-spacing:-.035em;margin:0 0 22px;color:var(--ink);max-width:900px;">Test your x402 client against a real endpoint.</h1>
    <p style="font-size:18px;line-height:1.55;color:var(--muted);max-width:820px;margin:0;">Every refusal here tells you what was actually wrong: which field differs from what was advertised, which schemes and networks the route offers, whether the amount or the validity window is the problem. Refusals are free, because an error status cancels settlement. You pay only when it works, and then it costs ${esc(PROBE_PRICE)}.</p>
  </div>
</header>

<section style="max-width:1180px;margin:0 auto;padding:44px 30px 0;">
  <h2 style="font-weight:800;font-size:30px;letter-spacing:-.02em;margin:0 0 16px;color:var(--ink);">1. Get a challenge</h2>
  <p style="font-size:16px;line-height:1.65;color:var(--muted);max-width:820px;margin:0 0 18px;">Any paid route answers one. This is the cheapest: pure computation, no upstream.</p>
  ${pre(`curl -sD - -X POST ${baseUrl}${PROBE_PATH} \\\n  -H 'content-type: application/json' \\\n  -d '{"text":"hello"}'`)}
  <p style="font-size:16px;line-height:1.65;color:var(--muted);max-width:820px;margin:0 0 18px;">The terms are in the <code>PAYMENT-REQUIRED</code> response header as base64 JSON, which is where the x402 v2 spec puts them, and the JSON body carries the same object, so a client that reads either one finds the offer. The header is authoritative. MPP clients get <code>WWW-Authenticate: Payment</code> challenges on the same response.</p>
</section>

<section style="max-width:1180px;margin:0 auto;padding:36px 30px 0;">
  <h2 style="font-weight:800;font-size:30px;letter-spacing:-.02em;margin:0 0 16px;color:var(--ink);">2. Pay it, and read the refusal</h2>
  <p style="font-size:16px;line-height:1.65;color:var(--muted);max-width:820px;margin:0 0 18px;">Retry with your client's <code>PAYMENT-SIGNATURE</code> header. If it is wrong, the 402 body carries a <code>reason</code>, a <code>hint</code> in words, and a <code>retry</code> telling you what kind of change is needed, ahead of the same offer the header carries. The header's one-line <code>error</code> is left out of a refusal's body, so a client that reads <code>error</code> first reads the hint instead. Here is a real one, with the offer trimmed. A route that also takes proof-of-work puts an <code>altPayment</code> pointer first.</p>
  ${pre(`{
  "reason": "unsupported-scheme",
  "hint": "Scheme \\"lightning\\" is not offered on this route. Offered: exact, upto.",
  "retry": "choose-offered-option",
  "x402Version": 2,
  "resource": { ... },
  "accepts": [ ... ],
  "extensions": { ... }
}`)}
  <p style="font-size:16px;line-height:1.65;color:var(--muted);max-width:820px;margin:0 0 18px;">Field <em>names</em> are echoed so you can compare them; values never are. A payment header is a credential.</p>
</section>

<section style="max-width:1180px;margin:0 auto;padding:36px 30px 0;">
  <h2 style="font-weight:800;font-size:30px;letter-spacing:-.02em;margin:0 0 16px;color:var(--ink);">Every reason this server emits</h2>
  <div style="overflow-x:auto;">
    <table style="border-collapse:collapse;width:100%;max-width:960px;"><tbody>${rows}</tbody></table>
  </div>
</section>

<section style="max-width:1180px;margin:0 auto;padding:36px 30px 0;">
  <h2 style="font-weight:800;font-size:30px;letter-spacing:-.02em;margin:0 0 16px;color:var(--ink);">3. When it works</h2>
  <p style="font-size:16px;line-height:1.65;color:var(--muted);max-width:820px;margin:0 0 18px;">You get a 200, the tool's answer, and a <code>PAYMENT-RESPONSE</code> receipt naming the settlement transaction, verifiable on the chain you paid on without asking us. At that point your client is integrated with the whole catalog: the same credential pays for 500+ tools, five model tiers on three wires, embeddings, images, speech and finished reports.</p>
  <p style="font-size:16px;line-height:1.65;color:var(--muted);max-width:820px;margin:0 0 18px;">If a receipt says a payment settled and the call still failed to deliver, that payment is recorded as owed and repaid to the paying wallet after review. Check any payment by its settlement transaction at <code>GET /api/refunds/lookup?tx=&lt;hash&gt;</code>: free, and it answers with the refund status and, once sent, our refund transaction.</p>
  <div style="display:flex;gap:18px;flex-wrap:wrap;margin-bottom:8px;">
    <a href="/api/pricing" style="${mono}color:var(--ink);text-decoration:none;border-bottom:1px solid var(--ink);padding-bottom:1px;">every route and price →</a>
    <a href="/.well-known/x402" style="${mono}color:var(--ink);text-decoration:none;border-bottom:1px solid var(--ink);padding-bottom:1px;">the service manifest →</a>
    <a href="/guides/x402-and-mpp" style="${mono}color:var(--ink);text-decoration:none;border-bottom:1px solid var(--ink);padding-bottom:1px;">how the paywall settles →</a>
    <a href="/api/pow" style="${mono}color:var(--ink);text-decoration:none;border-bottom:1px solid var(--ink);padding-bottom:1px;">free tier, no wallet →</a>
  </div>
</section>

<section style="max-width:1180px;margin:0 auto;padding:44px 30px 56px;">
  <div style="background:var(--surface);border:1px solid var(--hairline);padding:44px 40px;">
    <h2 style="font-weight:800;font-size:30px;line-height:1.05;letter-spacing:-.025em;margin:0 0 14px;color:var(--on-dark);">If the refusal looks wrong, it may be ours.</h2>
    <p style="font-size:16px;line-height:1.6;color:var(--dk-muted2);margin:0 0 24px;max-width:640px;">A refusal we cannot classify is as likely to be a defect on this server as a fault in your client, and we would rather hear about it than have you work around it. Two of the classes in the table above exist because someone outside told us their client was being refused for a reason that turned out to be ours.</p>
    <div style="display:flex;gap:11px;flex-wrap:wrap;">
      <a href="${repoUrl("issues/new")}" style="background:var(--accent);color:var(--on-accent);${mono}font-weight:700;font-size:14px;text-decoration:none;padding:14px 24px;">TELL US →</a>
      <a href="/status" style="background:transparent;border:1.5px solid var(--dark-border2);color:var(--on-dark);${mono}font-weight:700;font-size:14px;text-decoration:none;padding:13px 24px;">UPTIME, MEASURED OUTSIDE</a>
    </div>
  </div>
</section>
${ledgerFooterCompact()}`;

  const jsonLd = [
    { "@type": "BreadcrumbList", itemListElement: [{ "@type": "ListItem", position: 1, name: "Agent402", item: `${baseUrl}/` }, { "@type": "ListItem", position: 2, name: "Test your x402 client", item: canonical }] },
    { "@type": "TechArticle", "@id": canonical, headline: title, description, publisher: { "@type": "Organization", name: "Havok Holdings LLC", url: "https://havok.holdings" } },
  ];
  const extraCss = `@media (max-width:900px){h1{font-size:38px!important}}`;
  return ledgerShell({ title, description, canonical, baseUrl, activePath: "/x402-test", extraCss, jsonLd, body });
}
