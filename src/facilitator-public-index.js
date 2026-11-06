// FACILITATOR_PUBLIC_INDEX_CHAINS (comma list; `robinhood` and `ink` are the
// known chains; unset = none): the chains on which a facilitator we settle
// through publishes each settlement it relays on its own public index.
// /privacy, /terms, /.well-known/x402, llms.txt and the listed chains' rail
// pages read it at render time, so the disclosure appears only while it
// applies: a listed chain renders only while this server offers it (the
// payments boot reports the offer); a listed chain that is not offered is
// named in a boot warning. Any other value renders nothing and is named in a boot warning.
// Each known chain names the facilitator that settles it first, read from
// its own ordered list (ROBINHOOD_FACILITATOR_URL, INK_FACILITATOR_URL).
//
// Optional, read with it (each validated; an invalid value is ignored and
// warned about at boot):
//   FACILITATOR_PUBLIC_INDEX_NAME        the facilitator's display name, printed escaped
//   FACILITATOR_PUBLIC_INDEX_POLICY_URL  its privacy policy, linked only as a parsed https URL
//   FACILITATOR_PUBLIC_INDEX_SINCE       YYYY-MM-DD the disclosure took effect; while it
//                                        renders, /privacy and /terms print the later of
//                                        their own date and this one (once it is reached)
const KNOWN = ["robinhood", "ink"];
// Display names and the variable each chain's facilitator list is read from.
const CHAIN_NAMES = { robinhood: "Robinhood Chain", ink: "Ink" };
const URL_VARS = { robinhood: "ROBINHOOD_FACILITATOR_URL", ink: "INK_FACILITATOR_URL" };
/** "A", "A and B", "A, B and C". */
const andList = (xs) => (xs.length > 1 ? `${xs.slice(0, -1).join(", ")} and ${xs.at(-1)}` : xs.join(""));
const NAME_MAX = 60;

export const PUBLIC_INDEX_ANCHOR = "public-settlement-index";

const listed = (env) => String(env.FACILITATOR_PUBLIC_INDEX_CHAINS || "").split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);

/** The listed known chains, in a fixed order, offered or not. */
function listedKnown(env) {
  const set = new Set(listed(env));
  return KNOWN.filter((c) => set.has(c));
}

// The known chains this server offers, set by the payments boot from its
// final offer. Empty until then (and in free mode, which offers no chain).
const offered = new Set();
/** Called by the payments boot with the known chains in its final offer. */
export function setPublicIndexOfferedChains(chains) {
  offered.clear();
  for (const c of chains || []) if (KNOWN.includes(c)) offered.add(c);
}

/** The listed known chains this server offers, in a fixed order: the only
 *  ones any disclosure names. */
export function publicIndexChains(env = process.env) {
  return listedKnown(env).filter((c) => offered.has(c));
}

/** Warnings for listed chains the final offer left out (nothing renders for
 *  them); read once the offer is known. */
export function publicIndexUnofferedWarnings(env = process.env) {
  return listedKnown(env).filter((c) => !offered.has(c))
    .map((c) => `WARNING: FACILITATOR_PUBLIC_INDEX_CHAINS lists ${c} but ${CHAIN_NAMES[c]} is not offered; nothing renders for it while it is not`);
}

const escHtml = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");

// A URL's hostname, or "" when it does not parse. Only a parsed hostname is
// printed (letters, digits, dots, hyphens), never the raw variable.
function hostOf(url) {
  try {
    const u = new URL(String(url || "").trim());
    if (u.protocol !== "https:" && u.protocol !== "http:") return "";
    const h = u.hostname.toLowerCase();
    return /^[a-z0-9.-]+$/.test(h) ? h : "";
  } catch { return ""; }
}

// The facilitator the payments boot chose to settle each chain first (it may
// be a later listed one when the first is down at boot), set by src/payments.js.
const bootUrls = { robinhood: "", ink: "" };
/** Called at boot with the URL of the facilitator that settles `chain` first. */
export function setPublicIndexBootFacilitator(chain, url) {
  if (Object.hasOwn(bootUrls, chain)) bootUrls[chain] = String(url || "").trim().replace(/\/+$/, "");
}

/** The host each known chain publishes through: the facilitator that chain
 *  settles through first. That is the one the boot chose when it is still
 *  listed in the chain's facilitator list, otherwise (before boot) the first
 *  listed http(s) one. "" when unset or unparsable. */
export function publicIndexHosts(env = process.env) {
  const out = {};
  for (const chain of KNOWN) {
    const list = String(env[URL_VARS[chain]] || "").split(",").map((s) => s.trim().replace(/\/+$/, ""));
    const boot = bootUrls[chain];
    const chosen = boot && list.includes(boot) && hostOf(boot) ? boot : "";
    out[chain] = hostOf(chosen || list.find((s) => hostOf(s)) || "");
  }
  return out;
}

/** The display name, control and invisible characters removed, whitespace
 *  collapsed, at most NAME_MAX characters; "" when unset. Escape to print. */
export function publicIndexName(env = process.env) {
  return String(env.FACILITATOR_PUBLIC_INDEX_NAME || "")
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f\u007f-\u009f­​-‏‪-‮⁠-⁤⁦-⁩︀-️﻿]|[\u{e0000}-\u{e007f}]/gu, "")
    .replace(/\s+/g, " ").trim().slice(0, NAME_MAX).trim();
}

/** The policy URL as a parsed https href with no credentials; "" otherwise. */
export function publicIndexPolicyUrl(env = process.env) {
  const raw = String(env.FACILITATOR_PUBLIC_INDEX_POLICY_URL || "").trim();
  if (!raw) return "";
  try {
    const u = new URL(raw);
    if (u.protocol !== "https:" || u.username || u.password || !/^[a-z0-9.-]+$/i.test(u.hostname)) return "";
    return u.href;
  } catch { return ""; }
}

const ISO_DAY = /^(\d{4})-(\d{2})-(\d{2})$/;
/** FACILITATOR_PUBLIC_INDEX_SINCE as a real calendar day, or "". */
export function publicIndexSince(env = process.env) {
  const raw = String(env.FACILITATOR_PUBLIC_INDEX_SINCE || "").trim();
  const m = raw.match(ISO_DAY);
  if (!m) return "";
  const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
  return d.toISOString().slice(0, 10) === raw ? raw : "";
}

/** True while the disclosure renders on any page. */
export function publicIndexRenders(env = process.env) {
  return publicIndexChains(env).length > 0;
}

/** The date a legal page prints: its own `own`, or, while the disclosure
 *  renders, FACILITATOR_PUBLIC_INDEX_SINCE when that is later and not after
 *  `today` (UTC). */
export function publicIndexPageDate(own, env = process.env, today = new Date().toISOString().slice(0, 10)) {
  if (!publicIndexRenders(env)) return own;
  const since = publicIndexSince(env);
  return since && since > own && since <= today ? since : own;
}

const DATE_LINE = /last updated (\d{4}-\d{2}-\d{2})\./;
/** A rendered legal page with its "last updated" date moved to publicIndexPageDate. */
export function withPublicIndexDate(html, env = process.env) {
  return String(html).replace(DATE_LINE, (m, own) => `last updated ${publicIndexPageDate(own, env)}.`);
}

/** The privacy page's paragraph (HTML, every env-supplied value escaped), or
 *  "" when no chain is listed. */
export function publicIndexPrivacyText(chains = publicIndexChains(), hosts = publicIndexHosts(), { name = publicIndexName(), policyUrl = publicIndexPolicyUrl() } = {}) {
  const listed = KNOWN.filter((c) => chains.includes(c));
  if (!listed.length) return "";
  // One host for every listed chain is named once; different hosts are each
  // named with their chain.
  const named = listed.filter((c) => hosts[c]);
  const distinct = [...new Set(named.map((c) => hosts[c]))];
  const hostText = distinct.length > 1 ? named.map((c) => `${escHtml(hosts[c])} on ${CHAIN_NAMES[c]}`).join(", ") : distinct.length ? escHtml(distinct[0]) : "";
  const parts = [name ? escHtml(name) : "", hostText, policyUrl ? `<a href="${escHtml(policyUrl)}" rel="noopener">its privacy policy</a>` : ""].filter(Boolean);
  const who = `the facilitator that settles the payment${parts.length ? ` (${parts.join(", ")})` : ""}`;
  return `On ${andList(listed.map((c) => CHAIN_NAMES[c]))}, ${who} publishes each settlement it relays on its public index: payer and payee wallets, amount, time, transaction hash, the service name, and the endpoint host and price paid. It also keeps a page for each seller that lists that seller's frequent payers. Entries on that index are permanent and outside our control, and the data sent to it is processed where that facilitator operates. Pay on another chain to keep a payment off that index.`;
}

/** The privacy page's no-sale line: scoped to the list while the disclosure renders. */
export function publicIndexNoSaleText(chains = publicIndexChains()) {
  return chains.length
    ? "We do not sell or share data with anyone for advertising, or for any purpose beyond what this list describes."
    : "We do not sell or share data with anyone for advertising or any other purpose.";
}

/** The terms page's pointer to that paragraph, or "" when no chain is listed. */
export function publicIndexTermsText(chains = publicIndexChains()) {
  const listed = KNOWN.filter((c) => chains.includes(c));
  if (!listed.length) return "";
  return `On ${andList(listed.map((c) => CHAIN_NAMES[c]))}, the facilitator that settles a payment publishes it on its public index, as the <a href="/privacy#${PUBLIC_INDEX_ANCHOR}">privacy policy</a> describes.`;
}

/** The /.well-known/x402 privacy field, or null when no chain is listed. */
export function publicIndexManifest(baseUrl = "", env = process.env) {
  const chains = publicIndexChains(env);
  if (!chains.length) return null;
  const hosts = publicIndexHosts(env);
  return { chains, hosts: [...new Set(chains.map((c) => hosts[c]).filter(Boolean))], policy: `${baseUrl}/privacy#${PUBLIC_INDEX_ANCHOR}` };
}

/** Boot warnings for a switch that cannot do what its value says. */
export function publicIndexBootWarnings(env = process.env) {
  const out = [];
  const unknown = [...new Set(listed(env).filter((c) => !KNOWN.includes(c)))];
  if (unknown.length) out.push(`WARNING: FACILITATOR_PUBLIC_INDEX_CHAINS lists ${unknown.join(", ")}: only ${andList(KNOWN)} are known; nothing renders for ${unknown.length > 1 ? "them" : "it"}`);
  const chains = listedKnown(env);
  const hosts = publicIndexHosts(env);
  for (const c of chains) if (!hosts[c]) out.push(`WARNING: FACILITATOR_PUBLIC_INDEX_CHAINS lists ${c} but ${URL_VARS[c]} has no parsable first host; the /privacy paragraph names no host${chains.length > 1 ? ` for ${CHAIN_NAMES[c]}` : ""}`);
  const set = (k) => String(env[k] || "").trim() !== "";
  if (set("FACILITATOR_PUBLIC_INDEX_POLICY_URL") && !publicIndexPolicyUrl(env)) out.push("WARNING: FACILITATOR_PUBLIC_INDEX_POLICY_URL is not an https URL; it is not linked");
  if (set("FACILITATOR_PUBLIC_INDEX_SINCE") && !publicIndexSince(env)) out.push("WARNING: FACILITATOR_PUBLIC_INDEX_SINCE is not a YYYY-MM-DD date; the legal pages keep their own dates");
  else if (publicIndexSince(env) && publicIndexSince(env) > new Date().toISOString().slice(0, 10)) out.push("WARNING: FACILITATOR_PUBLIC_INDEX_SINCE is after today; the legal pages keep their own dates until that day");
  if (!chains.length) {
    const idle = ["FACILITATOR_PUBLIC_INDEX_NAME", "FACILITATOR_PUBLIC_INDEX_POLICY_URL", "FACILITATOR_PUBLIC_INDEX_SINCE"].filter(set);
    if (idle.length) out.push(`WARNING: ${idle.join(", ")} has no effect while FACILITATOR_PUBLIC_INDEX_CHAINS lists no known chain`);
  }
  return out;
}
