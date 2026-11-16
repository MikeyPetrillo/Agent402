// The operator's referral reconciliation (GET /__operator/referral-reconciliation.json):
// per tool, over one window, the answers served on its referral copy
// (/ref/<slug>) against the sales booked for it in the sales ledger and the
// entries the referral book holds for it. Three sources that should agree:
// an answer served with no sale booked is a run given away, a sale booked
// with no answer served is a refund owed, and an entry still open is a
// payment the chain has not settled either way yet.
//
// Pure: the caller reads each source and passes it in, so the figures are
// tested against a seeded book and ledger without a server. Operator only:
// the net and the commission it implies never leave this report.

const OPEN_STATES = Object.freeze({
  intent: "intent",
  "in-doubt": "inDoubt",
  "charged-undelivered": "charged",
  unconfirmed: "unconfirmed",
  contradicted: "contradicted",
  "refund-owed": "refundOwed",
  delivering: "delivering",
});

export const RECONCILE_DAYS_DEFAULT = 30;
export const RECONCILE_DAYS_MAX = 90;

/** The window a request asks for, in whole days: default 30, at least 1, at most 90. */
export function reconcileDays(raw) {
  const n = parseInt(String(raw ?? ""), 10);
  if (!Number.isFinite(n)) return RECONCILE_DAYS_DEFAULT;
  return Math.min(RECONCILE_DAYS_MAX, Math.max(1, n));
}

const emptyRow = () => ({
  served: 0,
  booked: { sales: 0, external: 0, internal: 0, grossUsd: 0, netUsd: 0, payers: 0 },
  book: { settled: 0, open: 0, charged: 0, unconfirmed: 0, inDoubt: 0, intent: 0, contradicted: 0, refundOwed: 0, delivering: 0, other: 0 },
  servedMinusBooked: 0,
});

/**
 * Build the report.
 *   days      the window in days (reconcileDays)
 *   now       ms; the window is [now - days, now)
 *   slugs     the slugs served under /ref (listed even with nothing in the window)
 *   served    { slug: answers served } over the window's UTC days
 *   sales     { slug: { sales, external, internal, grossUsd, netUsd, payers } } over the window
 *   open      the book's open entries ({ slug, state, at })
 *   sold      the book's booked-payment marks ({ key: { slug, at } })
 */
export function referralReconciliation({ days = RECONCILE_DAYS_DEFAULT, now = Date.now(), slugs = [], served = {}, sales = {}, open = [], sold = {}, enabled = true } = {}) {
  const since = now - days * 86_400_000;
  const rows = new Map();
  const row = (slug) => { const k = String(slug); if (!rows.has(k)) rows.set(k, emptyRow()); return rows.get(k); };
  for (const s of slugs) row(s);
  for (const [slug, n] of Object.entries(served || {})) row(slug).served += Number(n) || 0;
  for (const [slug, v] of Object.entries(sales || {})) {
    const b = row(slug).booked;
    b.sales += Number(v?.sales) || 0;
    b.external += Number(v?.external) || 0;
    b.internal += Number(v?.internal) || 0;
    b.grossUsd = +(b.grossUsd + (Number(v?.grossUsd) || 0)).toFixed(6);
    b.netUsd = +(b.netUsd + (Number(v?.netUsd) || 0)).toFixed(6);
    b.payers += Number(v?.payers) || 0;
  }
  for (const e of Array.isArray(open) ? open : []) {
    if (!e || !e.slug || !(Number(e.at) >= since && Number(e.at) < now)) continue;
    const b = row(e.slug).book;
    b.open++;
    const k = OPEN_STATES[e.state];
    if (k) b[k]++; else b.other++;
  }
  for (const m of Object.values(sold || {})) {
    if (!m || !m.slug || !(Number(m.at) >= since && Number(m.at) < now)) continue;
    row(m.slug).book.settled++;
  }
  const tools = [...rows].map(([slug, r]) => ({ slug, ...r, servedMinusBooked: r.served - r.booked.sales }))
    .sort((a, b) => b.served + b.booked.sales + b.book.open - (a.served + a.booked.sales + a.book.open) || (a.slug < b.slug ? -1 : a.slug > b.slug ? 1 : 0));
  const totals = emptyRow();
  for (const t of tools) {
    totals.served += t.served;
    for (const k of Object.keys(totals.booked)) totals.booked[k] = k.endsWith("Usd") ? +(totals.booked[k] + t.booked[k]).toFixed(6) : totals.booked[k] + t.booked[k];
    for (const k of Object.keys(totals.book)) totals.book[k] += t.book[k];
  }
  totals.servedMinusBooked = totals.served - totals.booked.sales;
  delete totals.booked.payers; // a distinct count is never summed across tools
  return {
    enabled: enabled === true,
    window: { days, from: new Date(since).toISOString(), to: new Date(now).toISOString() },
    totals,
    tools,
    // Mismatches first: a tool whose served answers and booked sales differ, or with an entry still open.
    attention: tools.filter((t) => t.servedMinusBooked !== 0 || t.book.open > 0).map((t) => t.slug),
    scope: {
      served: "200 answers sent on the tool's referral copy, per UTC day of the window; a re-send of a paid answer counts again, so served can exceed booked by the re-sends",
      booked: "sales booked on the referral rail in the sales ledger over the window: gross is what buyers paid, net what reached us (operator only)",
      bookOpen: "entries open in the referral book now, opened inside the window, by state (charged = charged and undelivered)",
      bookSettled: "booked-payment marks the book still holds (kept one hour), inside the window",
    },
  };
}
