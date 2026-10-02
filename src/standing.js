// The one paragraph that frames what these pages are measuring.
//
// WHY THIS EXISTS. A positioning review walked the site as an outsider doing
// diligence and found the same thing on three nav-linked pages: /revenue
// headlines lifetime external revenue, /proof shows the external settlements
// behind it, and /leaderboard ranks other sellers - one of whom settled more in
// a week than we have earned in total. Each number is true and each is
// published on purpose. None of them is framed, so a reader supplies the frame
// themselves, and the frame they reach for is "this is a small business".
//
// The frame that is actually correct is different and the evidence for it was
// already on the site, unstated: this host indexes the market, publishes a
// leaderboard it excludes itself from, and settles on twelve rails. Being small
// in revenue and central in infrastructure are not in tension - they are the
// position. The leaderboard ranking a rival above us is the strongest possible
// evidence the index is neutral, which is the whole reason to trust it.
//
// EVERY FIGURE IS DERIVED. Nothing here is typed: a framing paragraph that goes
// stale is worse than none, because it is the sentence asking to be trusted.
// A number that cannot be read is omitted rather than guessed.
import { esc } from "./ledger-chrome.js";

const int = (n) => Number(n || 0).toLocaleString("en-US");
// Below this the crawl cache is cold or still filling, and the band stays silent.
const MIN_SELLERS_TO_FRAME = 50;

/**
 * @param {object} f
 *  sellers   distinct seller origins in the index, the host left out
 *  listings  tool listings across them, the host's own left out
 *  settled   settlements observed through these gates, ours included
 *  rails     how many payment rails settle here
 *
 * The host's own revenue is NOT restated here. It is the headline of /revenue
 * and the subject of /proof already, and an earlier draft appended "Of that,
 * $N is ours" to a list of COUNTS (sellers, listings, settlements, rails) - a
 * dollar figure with no dollar total to be "of", which read as a non sequitur.
 */
/**
 * The band's seller and listing counts with the HOST LEFT OUT. The index
 * totals count the local row (always sellers[0], local:true) and its tools,
 * and the band says the host is excluded from every count, so the band reads
 * its figures through this. Pure.
 */
export function standingCountsExcludingHost(snapshot) {
  const t = snapshot?.totals || {};
  const local = (Array.isArray(snapshot?.sellers) ? snapshot.sellers : []).find((x) => x && x.local) || null;
  const n = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0);
  return {
    sellers: Math.max(0, n(t.sellers) - (local ? 1 : 0)),
    listings: Math.max(0, n(t.tools) - (local ? n(local.toolCount) : 0)),
  };
}

export function standingBand({ sellers, listings, settled, rails } = {}) {
  // A COLD OR HALF-LOADED INDEX MUST SAY NOTHING.
  //
  // The crawl cache warm-starts incrementally and is empty on a fresh boot, so
  // the honest figure for the first seconds is "1 seller origin indexed" - our
  // own. Publishing that as a framing claim is worse than publishing no frame:
  // it is a sentence asking to be trusted, stating a number that is wrong by
  // three orders of magnitude. The floor is deliberately far below the real
  // index (thousands) and far above a cold one, so it can only ever suppress
  // the band, never shape what it says.
  if (!(sellers >= MIN_SELLERS_TO_FRAME)) return "";
  const bits = [`${int(sellers)} seller origins indexed`];
  if (listings > 0) bits.push(`${int(listings)} tool listings`);
  if (settled > 0) bits.push(`${int(settled)} settlement${settled === 1 ? "" : "s"} through these gates`);
  if (rails > 0) bits.push(`${int(rails)} payment rail${rails === 1 ? "" : "s"}`);
  return `
<section style="max-width:1180px;margin:0 auto;padding:22px 30px 0;">
  <div style="border:1px solid var(--hairline);border-left:3px solid var(--accent);background:var(--card);padding:18px 22px;">
    <p style="font-size:15px;line-height:1.6;color:var(--muted);margin:0;max-width:900px;">
      <span style="font-family:var(--font-mono);font-size:11px;letter-spacing:.1em;color:var(--accent);display:block;margin-bottom:6px;">WHAT THIS PAGE IS MEASURING</span>
      ${esc(bits.join(" · "))}. We index this market, we are not trying to be it.
      The leaderboard on this site ranks other sellers above this one and excludes the host from every count, because an index that ranks itself first proves nothing.
    </p>
  </div>
</section>`;
}
