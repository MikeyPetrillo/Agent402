// "Watch a call get paid": the figure on the home page, /101 and every tool
// page. One paid call, step by step: the request, the 402 with its price, the
// signature, the settlement, the answer and (while the server signs them) the
// signed receipt. Plain HTML and CSS on the design tokens; no library.
//
// The server renders every step lit, so the figure is whole with no script and
// under reduced motion. assets/js/paid-call.js, where motion is allowed, lights
// the steps in order one beat (--dur-beat) apart while the figure is on screen,
// and fills the live figures from /api/stats: the 24-hour median latency and the
// count of settled payments from outside buyers. A figure the server and the
// poll have no reading for stays hidden. No cost or revenue figure is shown.
import { esc, jsSrc } from "./ledger-chrome.js";
import { liveRails } from "./rails.js";
import { receiptsServed, RECEIPT_HEADER } from "./receipt-signing.js";

const fmt = (n) => Math.round(Number(n)).toLocaleString("en-US");

/** The steps for one call: [key, label, value, meter key, meter text]. */
export function paidCallSteps({ method = "GET", path = "/api/uuid", price = "$0.001", chains = liveRails().length, receipts = receiptsServed(), latencyMs = null, settled = null } = {}) {
  const n = Number(chains) || 0;
  const steps = [
    ["request", "Request", `${method} ${path}`],
    ["402", "402", `${price} USDC`],
    ["sign", "Sign", "PAYMENT-SIGNATURE"],
    ["settle", "Settle", typeof chains === "string" ? chains : `on ${n} ${n === 1 ? "chain" : "chains"}`, "settled", Number(settled) > 0 ? `${fmt(settled)} settled` : ""],
    ["answer", "Answer", "200 OK", "latency", Number(latencyMs) > 0 ? `p50 ${fmt(latencyMs)} ms` : ""],
  ];
  if (receipts) steps.push(["receipt", "Receipt", RECEIPT_HEADER, "sig", "Ed25519"]);
  return steps;
}

/** The figure's markup. `label` names it for assistive technology. */
export function paidCallFigure(opts = {}) {
  const steps = paidCallSteps(opts);
  const names = steps.map((s) => s[1]).join(", ");
  const items = steps.map(([key, label, value, meterKey, meter], i) => `<div class="pc-step" role="listitem" data-pc-step="${esc(key)}"><span class="pc-rail" aria-hidden="true"><span class="pc-dot">${i + 1}</span></span><span class="pc-k">${esc(label)}</span><code class="pc-v">${esc(value)}</code>${meterKey ? `<span class="pc-m" data-pc-m="${esc(meterKey)}"${meter ? "" : " hidden"}>${esc(meter || "")}</span>` : ""}</div>`).join("");
  return `<figure class="pc" data-pc aria-label="A paid call, step by step: ${esc(names)}"><div class="pc-track" role="list">${items}</div></figure>`;
}

/** The figure's script tag (served under script-src 'self' from assets/js). */
export const paidCallScript = () => `<script src="${jsSrc("paid-call.js")}" defer></script>`;

// Desktop: three steps a row, a rail through the dots. Phone: one column, the
// rail runs down the left. Under paid-call.js (.pc-run) a step not yet reached
// is drawn hollow and faint; without it every step is lit.
export const PAID_CALL_CSS = `
.pc{margin:0;padding:22px 20px 6px;border:1px solid var(--hairline);border-radius:var(--radius);background:var(--card)}
.pc-track{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));row-gap:6px}
.pc-step{display:flex;flex-direction:column;align-items:flex-start;gap:6px;min-width:0;padding:0 14px 16px 0}
.pc-rail{display:flex;align-items:center;align-self:stretch;height:24px;margin-bottom:4px}
.pc-rail::after{content:"";flex:1;height:1px;margin-left:10px;background:var(--accent);transition:background-color var(--dur-base) var(--ease-out)}
.pc-step:nth-child(3n) .pc-rail::after,.pc-step:last-child .pc-rail::after{visibility:hidden}
.pc-dot{position:relative;flex:none;display:inline-flex;align-items:center;justify-content:center;width:24px;height:24px;border-radius:50%;border:1.5px solid var(--accent);background:var(--accent);color:var(--on-accent);font-family:var(--font-mono);font-size:var(--fs-2xs);font-variant-numeric:tabular-nums;transition:background-color var(--dur-base) var(--ease-out),border-color var(--dur-base) var(--ease-out),color var(--dur-base) var(--ease-out)}
.pc-dot::after{content:"";position:absolute;inset:-6px;border-radius:50%;border:1.5px solid var(--accent);opacity:0;transform:scale(.6);transition:opacity var(--dur-base-exit) var(--ease-in),transform var(--dur-base-exit) var(--ease-in)}
.pc-k{font-family:var(--font-mono);font-size:var(--fs-2xs);letter-spacing:.12em;text-transform:uppercase;color:var(--muted);white-space:nowrap;transition:color var(--dur-base) var(--ease-out)}
.pc-v{font-family:var(--font-mono);font-size:var(--fs-xs);color:var(--ink);background:none;border:0;padding:0;white-space:nowrap;transition:color var(--dur-base) var(--ease-out)}
.pc-m{font-family:var(--font-mono);font-size:var(--fs-2xs);color:var(--faint);font-variant-numeric:tabular-nums;white-space:nowrap}
.pc-m[hidden]{display:none}
.pc-run .pc-step:not(.is-on) .pc-dot{background:var(--card);border-color:var(--control);color:var(--faint)}
.pc-run .pc-step:not(.is-on) .pc-k,.pc-run .pc-step:not(.is-on) .pc-v{color:var(--faint)}
.pc-run .pc-step .pc-rail::after{background:var(--hairline)}
.pc-run .pc-step.is-on:not(.is-now) .pc-rail::after{background:var(--accent)}
.pc-run .pc-step.is-now .pc-dot::after{opacity:1;transform:none;transition-duration:var(--dur-base);transition-timing-function:var(--ease-out)}
@media (max-width:640px){
.pc{padding:18px 16px 4px}
.pc-track{grid-template-columns:minmax(0,1fr);row-gap:0}
.pc-step{display:grid;grid-template-columns:24px minmax(0,1fr);column-gap:12px;row-gap:4px;align-items:start;padding:0 0 14px}
.pc-step>.pc-k,.pc-step>.pc-v,.pc-step>.pc-m{grid-column:2}
.pc-rail{grid-column:1;grid-row:1/span 3;flex-direction:column;height:auto;margin:0}
.pc-rail::after{width:1px;height:auto;min-height:12px;margin:6px 0 -14px}
.pc-step:nth-child(3n) .pc-rail::after{visibility:visible}
.pc-step:last-child .pc-rail::after{visibility:hidden}
}
`;
