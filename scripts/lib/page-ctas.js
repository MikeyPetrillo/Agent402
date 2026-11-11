// A page's own calls to action, for the "one call to action per target" checks.
//
// The rule exists so a page does not repeat itself: two buttons on one page
// that go to the same place ("Browse the packs" twice, a second /docs#add)
// split the reader's attention for nothing. The header's primary action
// (NAV_PRIMARY_ACTION in src/ledger-chrome.js, drawn once in the bar and once
// in the mobile menu) is site chrome, like the nav links: it is the same on
// every page and sits outside <main>, so it does not count against a page's
// own buttons. A page that is a bare fragment (no <main>) is read whole.

/** The page's own markup: the inside of <main>, or the whole string when there is none. */
export function inPageHtml(html) {
  const s = String(html ?? "");
  const m = /<main\b[^>]*>([\s\S]*)<\/main>/i.exec(s);
  return m ? m[1] : s;
}

/** The href of every button-styled link (`<a class="btn ..." href>`) inside the page's own markup, in order. */
export function pageCtaHrefs(html) {
  return [...inPageHtml(html).matchAll(/<a class="btn[^"]*" href="([^"]+)"/g)].map((m) => m[1]);
}

/** Targets that more than one of the page's own buttons point to. */
export function duplicateCtaTargets(html) {
  const seen = new Set(), dup = new Set();
  for (const h of pageCtaHrefs(html)) (seen.has(h) ? dup : seen).add(h);
  return [...dup];
}
