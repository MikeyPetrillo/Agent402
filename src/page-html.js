// HTML builders the long-form guide pages (/how-to-pay, /speech) share: the
// heading, prose, code and table pieces, styled from DESIGN.md tokens only.
import { esc, codeBlock } from "./ledger-chrome.js";

export const listAnd = (xs) => (xs.length <= 1 ? xs.join("") : xs.length === 2 ? `${xs[0]} and ${xs[1]}` : `${xs.slice(0, -1).join(", ")} and ${xs.at(-1)}`);

export const mono = "font-family:var(--font-mono);";
export const eyebrow = (t, lit = false) => `<div style="${mono}font-size:var(--fs-sm);color:var(--${lit ? "accent-lit" : "accent"});margin-bottom:12px;">${esc(t)}</div>`;
export const h2 = (t, panel = false) => `<h2 style="font-weight:700;font-size:var(--fs-3xl);line-height:1.02;letter-spacing:-.025em;margin:0 0 20px;color:var(--${panel ? "on-panel" : "ink"});">${t}</h2>`;
export const h3 = (t) => `<h3 style="font-weight:600;font-size:var(--fs-xl);margin:28px 0 10px;color:var(--ink);">${t}</h3>`;
export const p = (t, extra = "") => `<p style="font-size:var(--fs-lg);line-height:1.65;color:var(--muted);max-width:820px;margin:0 0 18px;${extra}">${t}</p>`;
export const link = (href, t) => `<a href="${esc(href)}" style="color:var(--ink);text-decoration:none;border-bottom:1px solid var(--accent);">${t}</a>`;
export const code = (t) => `<code style="${mono}font-size:var(--fs-code-inline);color:var(--ink);">${esc(t)}</code>`;
export const pre = (label, s) => codeBlock(s, { label, wrap: true, size: "xs", style: "max-width:820px;margin:0 0 22px" });
export const section = (id, inner, wide = false) => `<section id="${id}" style="max-width:${wide ? 1180 : 900}px;margin:0 auto;padding:64px 30px 0;">${inner}</section>`;
export const th = (t, right = false) => `<th scope="col" style="text-align:${right ? "right" : "left"};font-weight:700;padding:13px 18px;">${esc(t)}</th>`;
export const thead = (cols) => `<thead><tr style="border-bottom:1px solid var(--hairline);${mono}font-size:var(--fs-2xs);letter-spacing:.12em;text-transform:uppercase;color:var(--faint);">${cols.map((c) => (Array.isArray(c) ? th(c[0], c[1]) : th(c))).join("")}</tr></thead>`;
/** A table in a horizontal-scroll wrapper; `scrollClass` is the page's own scroll rule. */
export const table = (cols, rows, scrollClass) => `<div class="${scrollClass}"><table style="font-size:var(--fs-base);border:1px solid var(--hairline);background:var(--card);border-collapse:collapse;width:100%;">${thead(cols)}<tbody>${rows}</tbody></table></div>`;
export const td = (t, style = "") => `<td style="padding:12px 18px;color:var(--muted);vertical-align:top;${style}">${t}</td>`;
export const row = (cells) => `<tr style="border-bottom:1px solid var(--hairline);">${cells.join("")}</tr>`;
