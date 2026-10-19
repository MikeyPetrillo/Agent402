// "Already subscribed? Manage or cancel" on /monitors: a card subscriber who no
// longer has their monitor emails enters the checkout email, and if it has a
// subscription that can still be managed, we email a fresh signed manage link
// per subscription (the same keyed bearer as the link in monitor emails, over
// the subscription id with an expiry). Every well-formed request gets the same
// answer, and the lookup and the send run after the answer is written, so
// neither the body nor the timing says whether an address has a subscription.
// Nothing here charges anything or calls Stripe; the portal is minted only
// when the link is opened (/monitors/manage).
import { createHash } from "node:crypto";

export const MANAGE_LINK_TTL_MS = 7 * 86_400_000;
export const MANAGE_LINK_ANSWER = "If that email has an active monitor subscription, we are emailing it a link to manage or cancel. The link works for 7 days.";
const EMAIL_RE = /^[^\s@<>"]{1,64}@[^\s@<>"]{1,190}\.[^\s@<>"]{2,}$/;
const MAX_LINKS = 10;

/** The message a sub-keyed manage token signs. A colon never appears in a
 *  report id, so a report-keyed token can never verify as one of these. */
export const subManageMessage = (subId, exp) => `sub:${subId}:${exp}`;

/** One email listing a manage link per subscription. Plain HTML: mail clients
 *  strip stylesheets, so the few styles are palette literals. */
export function buildManageLinkEmail({ links }) {
  const subject = "Your Agent402 monitor: manage or cancel";
  const lead = "Here is a new link to manage your Agent402 monitor subscription. It opens the Stripe Customer Portal, where you can change your card or cancel. Each link works for 7 days.";
  const why = "You are getting this because someone asked for a manage link for this email address on agent402.tools/monitors. If that was not you, you can ignore this email; nothing changes.";
  const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  // design-tokens: literal-start (email HTML: mail clients strip stylesheets)
  const items = links.map((l) => `<li style="margin:0 0 10px"><b>${esc(l.label)}</b> for ${esc(l.target)}<br><a href="${esc(l.url)}" style="color:#0F5E43">Manage or cancel</a></li>`).join("");
  const html = `<div style="font-family:system-ui,-apple-system,sans-serif;max-width:520px;margin:0 auto;color:#111315">
    <h2 style="font-weight:700;color:#111315">${esc(subject)}</h2>
    <p style="color:#3A3F45">${esc(lead)}</p>
    <ul style="color:#3A3F45;padding-left:18px">${items}</ul>
    <p style="color:#626970;font-size:12px;margin-top:26px">${esc(why)}</p>
  </div>`;
  // design-tokens: literal-end
  const text = `${subject}\n\n${lead}\n\n${links.map((l) => `${l.label} for ${l.target}:\n${l.url}`).join("\n\n")}\n\n${why}\n\nAgent402`;
  return { subject, html, text };
}

/**
 * The POST /monitors/manage-link handler.
 * @param {object} d
 * @param {(email:string)=>Promise<object[]>} d.findSubs  manageable records for an email ({subId, product, target})
 * @param {(msg:{to,subject,html,text})=>Promise<boolean>} d.send  the email sender
 * @param {(subId:string, exp:number)=>string} d.linkFor  the signed manage URL
 * @param {(product:string)=>string} d.labelOf
 * @param {{check:(k:string)=>{limited:boolean}}} d.ipLimiter
 * @param {{check:(k:string)=>{limited:boolean}}} d.emailLimiter
 * @param {(req)=>string} d.clientIp
 * @param {(title:string, bodyHtml:string)=>string} d.page  HTML answer for a plain form post
 */
export function createManageLinkHandler({ findSubs, send, linkFor, labelOf = (p) => p || "monitor", ipLimiter, emailLimiter, clientIp, page, now = () => Date.now() }) {
  return function manageLinkHandler(req, res) {
    res.set("Cache-Control", "no-store").set("X-Robots-Tag", "noindex, nofollow");
    const wantsJson = req.is("application/json") || /application\/json/.test(String(req.get("accept") || ""));
    const answer = (status, msg) => {
      res.status(status);
      if (wantsJson) return res.json(status === 200 ? { ok: true, message: msg } : { error: msg });
      return res.type("html").send(page(status === 200 ? "Check your email" : status === 429 ? "Please try again later" : "Check the address", `<p>${msg}</p><p><a href="/monitors">Back to monitors</a></p>`));
    };
    if (ipLimiter.check(clientIp(req)).limited) return answer(429, "Too many requests. Please try again in a few minutes.");
    const email = String(req.body?.email ?? "").trim().toLowerCase();
    if (email.length > 254 || !EMAIL_RE.test(email)) return answer(400, "Enter the email address you used at checkout.");
    const emailKey = createHash("sha256").update(email).digest("hex").slice(0, 32);
    if (emailLimiter.check(`e:${emailKey}`).limited) return answer(429, "Too many requests. Please try again in a few minutes.");
    answer(200, MANAGE_LINK_ANSWER);
    // After the answer: the same work-free response for every address.
    void (async () => {
      const subs = (await findSubs(email)).slice(0, MAX_LINKS);
      if (!subs.length) return;
      const exp = Math.floor((now() + MANAGE_LINK_TTL_MS) / 1000);
      const links = subs.map((r) => ({ label: labelOf(r.product), target: r.target || "your subject", url: linkFor(r.subId, exp) }));
      const sent = await send({ to: email, ...buildManageLinkEmail({ links }) });
      if (!sent) console.warn("[monitors] manage-link email was not sent");
    })().catch((e) => console.warn("[monitors] manage-link failed:", String(e?.message || e).slice(0, 160)));
  };
}
