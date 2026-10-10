// credits - PREPAID CARD CREDITS for the tool catalog: a person buys a $20/$50/$100 pack by card (Stripe
// Checkout), gets an `a402_...` key ONCE, and spends it across every paid tool
// with `Authorization: Bearer a402_...` - the card-native equivalent of the
// per-call x402 model, for buyers who will not hold a wallet.
//
// Money discipline (mirrors the x402 paywall):
// - A key is minted only for a Stripe-verified PAID session, exactly once per
//   session (the session id is indexed; a second claim returns "claimed" and
//   never re-shows the key).
// - The gate AUTHORIZES before the handler (balance >= the route's list price)
//   and DEBITS only on a final 200 (res "finish"); a 4xx/5xx is never charged.
//   A buyer whose connection closes before the first response byte is not
//   charged while the run holds a forgiveness ticket (the same rule and budget
//   as every other rail, src/hangup-settlement.js); without one the hold
//   settles and is booked as owed. A stream that already began is settled.
//   Balances are integer micro-dollars (sub-cent prices like $0.001 are exact).
// - Keys are stored HASHED (sha256); the plaintext exists only in the claim
//   response / email. Per-key files under /data/credits, atomic tmp+rename.
// - Accounting: every debit is a sale on the "credits" rail (PAYING_RAILS) with
//   the key id as classification-grade payer; stats count it as viaCredits.
// Rollout switch = STRIPE_SECRET_KEY (shared with the human checkout).
//
// STATE DATABASE. With STATE_DATABASE_URL set (src/state-db.js) every key
// record is a row of the `records` table (collection "credits", id = the key
// file's stem, `k_<hash>`; the claim index is the row `_sessions`), and every
// method that reads or moves money RETURNS A PROMISE: authorize, settle,
// release, charge, balance, status, setDisabled, disableByPaymentIntent,
// keyIdOf, balanceById (claim always did). The gate is then an async
// middleware. Without the database every method answers synchronously, from
// the files, exactly as before. The hold, the debit and the release are each
// one short transaction that locks the key's row (SELECT ... FOR UPDATE), so
// two containers can never double-debit a key; a session is claimed by one
// conditional statement on the index row, so a key is minted once. Reads come
// from the rows (no cache); the first boot with the database on imports the
// directory once. While the directory exists, every row write is also written
// to the key's file (best effort, never the verdict), so a rollback to the
// previous build reads current balances.
import { readFileSync, writeFileSync, renameSync, existsSync, mkdirSync, readdirSync, statSync } from "node:fs";
import { join, basename } from "node:path";
import { createHash, randomBytes } from "node:crypto";
import { sendEmail } from "./email.js";
import { creditsTopupFields } from "./credits-sales.js";
import { chargeCancelledForClientGone } from "./hangup-settlement.js";
import { stateDbEnabled, stateDbSchema, stateQuery, withStateTx, importOnce, imports, trackStoreReady } from "./state-db.js";
import { retryingLoad } from "./store-retry.js";

// A hold whose buyer left before the first byte is decided when the response
// ends; one that nothing ends within this long is released (call-time read,
// CREDITS_ABANDONED_HOLD_MS, default 10 minutes).
const abandonedHoldMs = () => { const n = Number(process.env.CREDITS_ABANDONED_HOLD_MS); return Number.isFinite(n) && n > 0 ? n : 10 * 60 * 1000; };

export const CREDIT_PACKS = {
  "credits-20": { label: "Starter", cents: 2000 },
  "credits-50": { label: "Builder", cents: 5000 },
  "credits-100": { label: "Pro", cents: 10000 },
};
export const KEY_RE = /^a402_[A-Za-z0-9_-]{32,64}$/;
const SESSION_RE = /^cs_[A-Za-z0-9_]+$/;
const MICRO = 1_000_000;
// A file written this much later than the newest row was written by a build
// that used the files alone (a rollback); write-through lands within milliseconds.
export const ROLL_FORWARD_GRACE_MS = 60_000;

const DATA_ROOT = () => (existsSync("/data") ? "/data" : "/tmp");
const DEFAULT_DIR = () => join(DATA_ROOT(), "credits");
const readJson = (p) => { try { return JSON.parse(readFileSync(p, "utf8")); } catch { return null; } };
function writeJsonAtomic(p, obj) {
  try { const tmp = `${p}.${process.pid}.tmp`; writeFileSync(tmp, JSON.stringify(obj)); renameSync(tmp, p); return true; } catch { return false; }
}
export const hashKey = (key) => createHash("sha256").update(String(key)).digest("hex");
export const usdToMicro = (usd) => Math.round(Number(usd) * MICRO);
export const microToUsd = (m) => Math.round(Number(m) / 100) / 10000; // 4 dp

/**
 * @param {object} deps
 * @param {import("stripe")} deps.stripe
 * @param {string} deps.baseUrl
 * @param {string} [deps.storeDir]
 * @param {(sale:object)=>void} [deps.onDebit]   accounting hook per charged call
 * @param {(sale:object)=>void} [deps.onLoad]    accounting hook per pack purchase
 * @param {()=>number} [deps.now]
 * @param {(s:string)=>void} [deps.log]
 */
export function createCredits({ stripe, baseUrl, storeDir, onDebit, onLoad, now = () => Date.now(), log = console.log, digestLinkFor = null }) {
  const dir = storeDir || DEFAULT_DIR();
  try { mkdirSync(dir, { recursive: true }); } catch { /* writes fail loudly below */ }
  const SESSIONS = join(dir, "_sessions.json"); // sessionId -> key hash (claim-once)
  const recPath = (hash) => join(dir, `k_${hash}.json`);
  const usePg = stateDbEnabled();
  const cache = new Map(); // hash -> record (write-through; file backend only)

  const load = (hash) => cache.get(hash) || (() => { const r = readJson(recPath(hash)); if (r) cache.set(hash, r); return r; })();
  function save(hash, rec) { cache.set(hash, rec); writeJsonAtomic(recPath(hash), rec); }
  const sessionsIdx = () => readJson(SESSIONS) || {};
  const keyFiles = () => { try { return readdirSync(dir).filter((f) => f.startsWith("k_") && f.endsWith(".json")); } catch { return []; } };

  // ---- state database primitives ------------------------------------------
  const COLL = "credits";
  const recId = (hash) => `k_${hash}`;
  const RT = () => `${stateDbSchema()}.records`;
  const pgGet = async (id) => (await stateQuery(`SELECT body FROM ${RT()} WHERE collection = $1 AND id = $2`, [COLL, id])).rows[0]?.body ?? null;
  const pgPutIfAbsent = async (id, body) => (await stateQuery(`INSERT INTO ${RT()} (collection, id, body) VALUES ($1, $2, $3::jsonb) ON CONFLICT (collection, id) DO NOTHING`, [COLL, id, JSON.stringify(body)])).rowCount === 1;
  const pgDel = async (id) => { await stateQuery(`DELETE FROM ${RT()} WHERE collection = $1 AND id = $2`, [COLL, id]); };
  // Every key row: the underscore in the prefix is literal.
  const pgKeys = async () => (await stateQuery(`SELECT id, body FROM ${RT()} WHERE collection = $1 AND id LIKE 'k\\_%' ESCAPE '\\' ORDER BY id`, [COLL])).rows.map((r) => ({ hash: r.id.slice(2), rec: r.body }));
  // Write-through to the directory while it is there, so a rollback reads
  // current balances. Best effort: a failure is logged once, never the verdict.
  let throughWarned = false;
  const through = (path, body) => {
    if (!usePg || !existsSync(dir)) return;
    if (!writeJsonAtomic(path, body) && !throughWarned) { throughWarned = true; log(`[credits] write-through to ${dir} failed (the database row is the record)`); }
  };
  async function importDir() {
    const files = (() => { try { return readdirSync(dir); } catch { return []; } })();
    let bytes = 0, n = 0;
    for (const f of files) {
      const id = f.startsWith("k_") && f.endsWith(".json") ? f.slice(0, -5) : f === "_sessions.json" ? "_sessions" : null;
      if (!id) continue;
      const body = readJson(join(dir, f));
      if (!body) continue;
      await pgPutIfAbsent(id, body);
      try { bytes += statSync(join(dir, f)).size; } catch { /* counted as 0 */ }
      if (id !== "_sessions") n++;
    }
    log(`[credits] imported ${n} key record(s) from ${dir} into the state database`);
    return { bytes, records: n };
  }
  // Roll-forward (the shape of json-document's reimportIfFileNewer): a key
  // file or the index written after the newest row, beyond the write-through
  // grace, was written by the previous build running on the files alone (a
  // rollback window): every key record and the index are re-read with the
  // FILE WINNING per id, and the replacement is logged.
  async function rollForwardIfFilesNewer() {
    const files = (() => { try { return readdirSync(dir).filter((f) => (f.startsWith("k_") && f.endsWith(".json")) || f === "_sessions.json"); } catch { return []; } })();
    let mtime = 0;
    for (const f of files) { try { mtime = Math.max(mtime, statSync(join(dir, f)).mtimeMs); } catch { /* gone */ } }
    if (!mtime) return 0;
    const newest = await stateQuery(`SELECT max(updated_at) AS at FROM ${RT()} WHERE collection = $1`, [COLL]);
    let rowAt = newest.rows[0]?.at ? new Date(newest.rows[0].at).getTime() : 0;
    if (!rowAt) { const mark = await imports.done(basename(dir)); rowAt = mark?.importedAt ? new Date(mark.importedAt).getTime() : 0; }
    if (!rowAt || mtime <= rowAt + ROLL_FORWARD_GRACE_MS) return 0;
    let keys = 0, index = 0;
    for (const f of files) {
      const body = readJson(join(dir, f));
      if (!body) continue;
      const id = f === "_sessions.json" ? "_sessions" : f.slice(0, -5);
      await stateQuery(`INSERT INTO ${RT()} (collection, id, body) VALUES ($1, $2, $3::jsonb) ON CONFLICT (collection, id) DO UPDATE SET body = EXCLUDED.body, updated_at = now()`, [COLL, id, JSON.stringify(body)]);
      if (id === "_sessions") index++; else keys++;
    }
    log(`[credits] rolled forward ${keys} key record(s) and ${index} index from ${dir}: the files were written ${Math.round((mtime - rowAt) / 1000)} s after the newest row (a rollback window), the files win`);
    return keys + index;
  }
  // The first load (import once, roll forward, sweep abandoned holds) is
  // retried until it lands: a failed attempt is forgotten, so the next call
  // tries again, and a background timer retries for a store nobody calls.
  const loader = usePg ? retryingLoad("[credits]", async () => {
    await importOnce(basename(dir), { source: dir, run: importDir });
    await rollForwardIfFilesNewer();
    await sweepAbandonedHolds().catch((e) => log(`[credits] hold sweep failed: ${String(e?.message || e).slice(0, 120)}`));
  }, { log }) : null;
  const readyP = () => (loader ? loader.ready() : Promise.resolve());
  if (loader) { trackStoreReady(loader.eventually); readyP().catch(() => {}); }

  // ---- abandoned holds (database only) --------------------------------------
  // Each hold on the database is also an entry `holds[id] = { m, at }` on the
  // key's row. A settle or release that could not land after its retries
  // leaves the entry (and the money in heldMicro); the sweep, at the first
  // load and every few minutes, returns every entry older than
  // CREDITS_ABANDONED_HOLD_MS that no request in this process still holds,
  // and logs it. Held micro-dollars with no entry (holds placed by a build
  // without entries) are returned the same way once the row has been quiet
  // for that long. A settle that arrives for a swept hold takes nothing.
  const liveHolds = new Set(); // hold ids of requests in flight here
  const holdTotal = (holds) => Object.values(holds || {}).reduce((a, h) => a + (Number(h?.m) || 0), 0);
  async function sweepAbandonedHolds() {
    if (!usePg) return { released: 0, micro: 0 };
    const age = abandonedHoldMs();
    const cut = now() - age;
    const rows = (await stateQuery(`SELECT id, updated_at FROM ${RT()} WHERE collection = $1 AND id LIKE 'k\\_%' ESCAPE '\\' AND (body->>'heldMicro')::bigint > 0`, [COLL])).rows;
    let released = 0, micro = 0;
    for (const row of rows) {
      const hash = row.id.slice(2);
      const quietRow = new Date(row.updated_at).getTime() < cut;
      const out = await mutatePgNow(hash, (rec) => {
        if (!rec || !(rec.heldMicro > 0)) return { result: null };
        const holds = { ...(rec.holds || {}) };
        let back = 0, n = 0;
        for (const [id, h] of Object.entries(holds)) {
          if (liveHolds.has(id) || !(Number(h?.at) < cut)) continue;
          back += Number(h.m) || 0; n++; delete holds[id];
        }
        // Held money no entry accounts for, on a row nobody has touched for the whole window.
        const untracked = rec.heldMicro - back - holdTotal(holds);
        if (quietRow && untracked > 0 && ![...liveHolds].some((id) => id.startsWith(`${hash.slice(0, 12)}:`))) { back += untracked; n++; }
        back = Math.min(back, rec.heldMicro);
        if (!n || back <= 0) return { result: null };
        rec.holds = holds;
        rec.heldMicro -= back; rec.balanceMicro += back;
        return { rec, result: { n, back, keyId: rec.keyId } };
      });
      if (out) { released += out.n; micro += out.back; log(`[credits] released ${out.n} abandoned hold(s) on key ${out.keyId} ($${microToUsd(out.back)}): no settle or release landed within ${Math.round(age / 1000)} s`); }
    }
    return { released, micro };
  }
  if (usePg) {
    const every = Math.max(60_000, Math.min(15 * 60_000, Math.floor(abandonedHoldMs() / 2)));
    const t = setInterval(() => { if (loader.isLoaded()) sweepAbandonedHolds().catch((e) => log(`[credits] hold sweep failed: ${String(e?.message || e).slice(0, 120)}`)); }, every);
    t.unref?.();
  }
  // One key's record, moved under its row lock: `fn(rec)` answers
  // { rec?, result, after? }; `rec` is written back, `after` runs once it is.
  async function mutatePg(hash, fn) {
    await readyP();
    return mutatePgNow(hash, fn);
  }
  async function mutatePgNow(hash, fn) {
    const out = await withStateTx(async (c) => {
      const r = await c.query(`SELECT body FROM ${RT()} WHERE collection = $1 AND id = $2 FOR UPDATE`, [COLL, recId(hash)]);
      const o = fn(r.rows[0]?.body ?? null);
      if (o.rec) await c.query(`UPDATE ${RT()} SET body = $3::jsonb, updated_at = now() WHERE collection = $1 AND id = $2`, [COLL, recId(hash), JSON.stringify(o.rec)]);
      return o;
    });
    if (out.rec) through(recPath(hash), out.rec);
    if (out.after) { try { out.after(); } catch { /* accounting never breaks serving */ } }
    return out.result;
  }
  function mutateFile(hash, fn) {
    const out = fn(load(hash));
    if (out.rec) save(hash, out.rec);
    if (out.after) { try { out.after(); } catch { /* accounting never breaks serving */ } }
    return out.result;
  }
  const mutate = usePg ? mutatePg : mutateFile;
  const readRec = usePg ? async (hash) => { await readyP(); return pgGet(recId(hash)); } : load;
  const allKeys = usePg ? async () => { await readyP(); return pgKeys(); } : () => keyFiles().map((f) => ({ hash: f.slice(2, -5), rec: readJson(join(dir, f)) })).filter((x) => x.rec);
  const answer = (v) => (usePg ? Promise.resolve(v) : v);

  async function createCheckout(packKey) {
    const p = Object.hasOwn(CREDIT_PACKS, String(packKey)) ? CREDIT_PACKS[packKey] : null;
    if (!p) {
      // Self-correcting: an agent cannot guess "credits-20" from a bare 20,
      // and /api/pricing used to publish the dollar amounts only (found by an
      // outside reviewer 2026-08-28, who brute-forced the id).
      const e = new Error(`Unknown credit pack. Valid packs: ${Object.keys(CREDIT_PACKS).join(", ")}`);
      e.statusCode = 400; e.validPacks = Object.keys(CREDIT_PACKS); e.buyerSafe = true; throw e;
    }
    const session = await stripe.checkout.sessions.create({
      mode: "payment",
      ...(String(process.env.STRIPE_AUTOMATIC_TAX || "").toLowerCase() === "true" ? { automatic_tax: { enabled: true } } : {}),
      line_items: [{ quantity: 1, price_data: { currency: "usd", unit_amount: p.cents, product_data: { name: `Agent402 credits - ${p.label} ($${(p.cents / 100).toFixed(0)})`, description: "Prepaid credits for pay-per-call tools. Spent per request at list price; never expire." } } }],
      metadata: { credits_pack: packKey },
      success_url: `${baseUrl}/credits/thanks?session={CHECKOUT_SESSION_ID}`,
      cancel_url: `${baseUrl}/credits?canceled=1`,
      payment_intent_data: { description: `Agent402 credits ${p.label}` },
    });
    return { id: session.id, url: session.url };
  }

  // The answer for a session somebody already claimed: the key is never re-shown.
  const claimedAnswer = (rec) => ({ status: "claimed", keyId: rec?.keyId || null, balanceUsd: rec ? microToUsd(rec.balanceMicro) : null });
  // Claim-once on the database: the index row gains this session only when it
  // does not carry it yet (one conditional statement). Resolves the index
  // body when this call claimed it, null when another one did.
  async function claimSessionPg(sessionId, hash) {
    const r = await stateQuery(
      `INSERT INTO ${RT()} (collection, id, body) VALUES ($1, '_sessions', jsonb_build_object($2::text, $3::text))
       ON CONFLICT (collection, id) DO UPDATE SET body = ${RT()}.body || jsonb_build_object($2::text, $3::text), updated_at = now()
       WHERE NOT (${RT()}.body ? $2::text)
       RETURNING body`,
      [COLL, sessionId, hash],
    );
    return r.rowCount === 1 ? r.rows[0].body : null;
  }

  // Claim the key for a paid session: mints ONCE; later claims say "claimed".
  async function claim(sessionId) {
    if (typeof sessionId !== "string" || !SESSION_RE.test(sessionId)) return { status: "invalid" };
    if (usePg) await readyP();
    const idx = usePg ? (await pgGet("_sessions")) || {} : sessionsIdx();
    if (idx[sessionId]) return claimedAnswer(await readRec(idx[sessionId]));
    let session;
    try { session = await stripe.checkout.sessions.retrieve(sessionId); } catch { return { status: "not_found" }; }
    if (!session || session.mode !== "payment" || session.payment_status !== "paid") return { status: "unpaid" };
    const packKey = session.metadata?.credits_pack;
    const p = Object.hasOwn(CREDIT_PACKS, String(packKey)) ? CREDIT_PACKS[packKey] : null;
    if (!p) return { status: "invalid" };
    // Re-check the index right before minting (two tabs claiming at once).
    const again = usePg ? (await pgGet("_sessions")) || {} : sessionsIdx();
    if (again[sessionId]) return claimedAnswer(await readRec(again[sessionId]));
    const key = `a402_${randomBytes(24).toString("base64url")}`;
    const hash = hashKey(key);
    const keyId = hash.slice(0, 12);
    const email = session.customer_details?.email || session.customer_email || null;
    const loadedMicro = p.cents * 10_000;
    const paymentIntent = typeof session.payment_intent === "string" ? session.payment_intent : session.payment_intent?.id || null;
    const rec = { keyId, balanceMicro: loadedMicro, loadedMicro, spentMicro: 0, calls: 0, createdAt: new Date(now()).toISOString(), email, sessions: [sessionId], paymentIntents: paymentIntent ? [paymentIntent] : [], pack: packKey, lastUsedAt: null };
    if (usePg) {
      // The record first (nobody holds its key yet), then the claim; a claim
      // another container won in between leaves an orphan row, removed here.
      await pgPutIfAbsent(recId(hash), rec);
      const index = await claimSessionPg(sessionId, hash);
      if (!index) {
        await pgDel(recId(hash)).catch(() => {});
        const theirs = (await pgGet("_sessions")) || {};
        return claimedAnswer(theirs[sessionId] ? await pgGet(recId(theirs[sessionId])) : null);
      }
      through(recPath(hash), rec);
      through(SESSIONS, index);
    } else {
      save(hash, rec);
      again[sessionId] = hash; writeJsonAtomic(SESSIONS, again);
    }
    try { onLoad?.({ sessionId, pack: packKey, priceUsd: p.cents / 100, keyId, paymentIntent }); } catch { /* accounting never breaks minting */ }
    // Weekly spend digest (src/wallet-digest.js): the claim email carries a
    // signed confirm link for THIS key; the click is the consent.
    let digestUrl = null;
    try { digestUrl = typeof digestLinkFor === "function" && email ? digestLinkFor({ keyId, email }) : null; } catch { digestUrl = null; }
    const digestText = digestUrl ? `\n\nWant one email a week with what this key spent (calls, dollars, tools, balance)? Confirm here: ${digestUrl}` : "";
    const digestHtml = digestUrl ? `<p style="margin-top:18px;font-size:14px;color:#5C6963">Want one email a week with what this key spent (calls, dollars, tools, balance)? <a href="${digestUrl}">Confirm the weekly digest</a>. Nothing is sent for a quiet week.</p>` : "";
    if (email) {
      sendEmail({ to: email, subject: "Your Agent402 credits key",
        text: `Your prepaid credits are ready: $${(p.cents / 100).toFixed(2)} loaded.\n\nYour key (keep it secret, it is shown only here and on the thanks page):\n\n${key}\n\nUse it on any paid tool:\ncurl -H "Authorization: Bearer ${key}" ${baseUrl}/api/whois?domain=example.com\n\nBalance: GET ${baseUrl}/api/credits/balance with the same header.\nTop up: ${baseUrl}/credits${digestText}\n\nAgent402`,
        html: `<div style="font-family:system-ui,sans-serif;max-width:560px;margin:0 auto;color:#14201b"><h2 style="font-weight:500">Your Agent402 credits key</h2><p>$${(p.cents / 100).toFixed(2)} loaded. Keep the key secret - it is shown only here and on the thanks page.</p><pre style="background:#0c0d0f;color:#e9eaec;padding:14px 16px;border-radius:10px;font-size:13px;overflow:auto">${key}</pre><p>Use it on any paid tool:</p><pre style="background:#f3f4f5;padding:12px 14px;border-radius:10px;font-size:12.5px;overflow:auto">curl -H "Authorization: Bearer ${key}" ${baseUrl}/api/whois?domain=example.com</pre><p style="color:#62696f;font-size:13px">Balance: <code>GET ${baseUrl}/api/credits/balance</code> with the same header · Top up at <a href="${baseUrl}/credits">${baseUrl}/credits</a></p>${digestHtml}</div>` }).catch(() => {});
    }
    log(`[credits] minted key ${keyId} ($${(p.cents / 100).toFixed(2)}) for session ${sessionId}`);
    return { status: "minted", key, keyId, balanceUsd: microToUsd(loadedMicro) };
  }

  // ---- the money moves, as pure steps on one record --------------------------
  // Each answers { rec?, result, after? }: `rec` is the record to write back
  // (absent when nothing changed), `after` the accounting hook to run once it
  // is written. The file and the database backends apply them the same way.
  function authorizeOn(rec, hash, need, priceUsd, holdId = null) {
    if (!rec) return { result: { ok: false, reason: "unknown" } };
    if (rec.disabled) return { result: { ok: false, reason: "disabled", balanceUsd: microToUsd(rec.balanceMicro) } };
    if (rec.balanceMicro < need) return { result: { ok: false, reason: "insufficient", balanceUsd: microToUsd(rec.balanceMicro), priceUsd } };
    rec.balanceMicro -= need; rec.heldMicro = (rec.heldMicro || 0) + need;
    if (holdId) rec.holds = { ...(rec.holds || {}), [holdId]: { m: need, at: now() } };
    return { rec, result: { ok: true, hash, keyId: rec.keyId, heldMicro: need, balanceUsd: microToUsd(rec.balanceMicro), priceUsd, ...(holdId ? { holdId } : {}) } };
  }
  // A hold the sweep already returned (its entry is gone) is worth nothing
  // now: the settle or release that finally arrives moves no money.
  // A caller that names no hold ends the oldest entry of that size, so the
  // entries keep matching heldMicro and the sweep never returns money twice.
  function takeHold(rec, heldMicro, holdId) {
    if (!rec.holds) return heldMicro;
    if (!holdId) {
      const hit = Object.entries(rec.holds).filter(([, h]) => Number(h?.m) === Number(heldMicro)).sort((a, b) => a[1].at - b[1].at)[0];
      if (hit) delete rec.holds[hit[0]];
      return heldMicro;
    }
    if (!Object.hasOwn(rec.holds, holdId)) { log(`[credits] key ${rec.keyId}: hold ${holdId.slice(-8)} was already returned by the sweep; nothing moves`); return 0; }
    delete rec.holds[holdId];
    return heldMicro;
  }
  function settleOn(rec, heldMicro, slug, chargeUsd, holdId = null) {
    if (!rec) return { result: null };
    heldMicro = takeHold(rec, heldMicro, holdId);
    const held = Math.min(heldMicro, rec.heldMicro || 0);
    const want = Number.isFinite(Number(chargeUsd)) && Number(chargeUsd) > 0 ? usdToMicro(Number(chargeUsd)) : held;
    const taken = Math.min(held, want);
    const returned = held - taken;
    rec.heldMicro = (rec.heldMicro || 0) - held; rec.balanceMicro += returned; rec.spentMicro += taken; rec.calls += 1; rec.lastUsedAt = new Date(now()).toISOString();
    return { rec, result: { balanceUsd: microToUsd(rec.balanceMicro), chargedUsd: microToUsd(taken), heldUsd: microToUsd(held), returnedUsd: microToUsd(returned) }, after: () => onDebit?.({ slug, priceUsd: microToUsd(taken), keyId: rec.keyId }) };
  }
  function releaseOn(rec, heldMicro, holdId = null) {
    if (!rec) return { result: null };
    heldMicro = takeHold(rec, heldMicro, holdId);
    const back = Math.min(heldMicro, rec.heldMicro || 0);
    rec.heldMicro = (rec.heldMicro || 0) - back; rec.balanceMicro += back;
    return { rec, result: { balanceUsd: microToUsd(rec.balanceMicro) } };
  }
  function chargeOn(a, priceUsd, slug) {
    if (!a) return { result: null };
    const need = usdToMicro(priceUsd);
    const taken = Math.min(need, a.balanceMicro);
    a.balanceMicro -= taken; a.spentMicro += taken; a.calls += 1; a.lastUsedAt = new Date(now()).toISOString();
    return { rec: a, result: { balanceUsd: microToUsd(a.balanceMicro), chargedUsd: microToUsd(taken) }, after: () => onDebit?.({ slug, priceUsd: microToUsd(taken), keyId: a.keyId }) };
  }

  // Pre-handler authorization WITH RESERVATION: the list price is moved from
  // the available balance into a hold before the handler runs, so N concurrent
  // calls on one key can never collectively exceed the balance (without the
  // hold, every call passed the balance check and only floor(balance/price)
  // debits landed - the rest were served free). settle() converts the hold to
  // spend on a final 200; release() returns it on any other outcome.
  function authorize(keyString, priceUsd) {
    if (typeof keyString !== "string" || !KEY_RE.test(keyString)) return answer({ ok: false, reason: "malformed" });
    const hash = hashKey(keyString);
    const need = usdToMicro(priceUsd);
    const holdId = usePg ? `${hash.slice(0, 12)}:${randomBytes(8).toString("hex")}` : null;
    return mutate(hash, (rec) => authorizeOn(rec, hash, need, priceUsd, holdId));
  }
  // Final 200: the hold becomes spend. `chargeUsd` (the meter's actual x
  // markup on a metered route) takes LESS than the hold and returns the rest
  // to the balance; it can never take more than was held.
  function settle(hash, heldMicro, slug, chargeUsd = null, holdId = null) {
    return mutate(hash, (rec) => settleOn(rec, heldMicro, slug, chargeUsd, holdId));
  }
  // Any non-200 outcome (4xx/5xx, client abort before the response finished):
  // the hold goes back to the balance - nothing was charged.
  function release(hash, heldMicro, holdId = null) {
    return mutate(hash, (rec) => releaseOn(rec, heldMicro, holdId));
  }
  // Kept for direct callers/tests: an immediate debit without a prior hold.
  function charge(hash, priceUsd, slug) {
    return mutate(hash, (a) => chargeOn(a, priceUsd, slug));
  }

  const balanceOf = (rec) => (rec ? { keyId: rec.keyId, balanceUsd: microToUsd(rec.balanceMicro), heldUsd: microToUsd(rec.heldMicro || 0), loadedUsd: microToUsd(rec.loadedMicro), spentUsd: microToUsd(rec.spentMicro), calls: rec.calls, createdAt: rec.createdAt, lastUsedAt: rec.lastUsedAt, disabled: !!rec.disabled } : null);
  function balance(keyString) {
    if (typeof keyString !== "string" || !KEY_RE.test(keyString)) return answer(null);
    const rec = readRec(hashKey(keyString));
    return usePg ? rec.then(balanceOf) : balanceOf(rec);
  }

  // Operator: totals + per-key rows (key id only - never the key or its hash).
  const statusOf = (keys) => {
    const tot = (k) => keys.reduce((a, r) => a + (Number(r[k]) || 0), 0);
    return {
      keys: keys.length, loadedUsd: microToUsd(tot("loadedMicro")), spentUsd: microToUsd(tot("spentMicro")), outstandingUsd: microToUsd(tot("balanceMicro")), heldUsd: microToUsd(tot("heldMicro")), calls: tot("calls"),
      rows: keys.sort((a, b) => String(b.lastUsedAt || b.createdAt).localeCompare(String(a.lastUsedAt || a.createdAt))).slice(0, 200).map((r) => ({ keyId: r.keyId, balanceUsd: microToUsd(r.balanceMicro), spentUsd: microToUsd(r.spentMicro), calls: r.calls, createdAt: r.createdAt, lastUsedAt: r.lastUsedAt, disabled: !!r.disabled })),
    };
  };
  function status() {
    if (usePg) return allKeys().then((xs) => statusOf(xs.map((x) => x.rec)));
    return statusOf(allKeys().map((x) => x.rec));
  }
  function setDisabled(keyId, disabled) {
    if (usePg) return allKeys().then((xs) => { const hit = xs.find((x) => x.rec?.keyId === keyId); return hit ? mutatePg(hit.hash, (r) => (r ? { rec: Object.assign(r, { disabled: !!disabled }), result: true } : { result: false })) : false; });
    for (const { hash, rec: r } of allKeys()) { if (r?.keyId === keyId) { r.disabled = !!disabled; save(hash, r); return true; } }
    return false;
  }

  // A refunded or disputed pack payment disables its key (clawback). Looked
  // up by PaymentIntent id from the Stripe webhook (charge.refunded /
  // charge.dispute.created). Returns the key id or null.
  const paidBy = (r, paymentIntent) => r && Array.isArray(r.paymentIntents) && r.paymentIntents.includes(paymentIntent);
  function disableByPaymentIntent(paymentIntent, reason = "refunded") {
    if (!paymentIntent) return answer(null);
    const clawback = (r) => { r.disabled = true; r.disabledReason = reason; log(`[credits] key ${r.keyId} disabled (${reason}, ${paymentIntent})`); return r.keyId; };
    if (usePg) return allKeys().then((xs) => { const hit = xs.find((x) => paidBy(x.rec, paymentIntent)); return hit ? mutatePg(hit.hash, (r) => (paidBy(r, paymentIntent) ? { rec: r, result: clawback(r) } : { result: null })) : null; });
    for (const { hash, rec: r } of allKeys()) {
      if (paidBy(r, paymentIntent)) { const id = clawback(r); save(hash, r); return id; }
    }
    return null;
  }

  // On the database, a settle or release after the answer is a promise nobody
  // awaits: it is retried a few times, and a failure is logged (the hold then
  // stays on the row, which the operator view shows as held).
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  // The hold stays in `liveHolds` until its settle or release has landed or
  // given up; the sweep then returns one that never landed.
  function later(label, fn, onDone = null, holdId = null) {
    (async () => {
      try {
        for (let i = 0; i < 3; i++) {
          try { const c = await fn(); onDone?.(c); return; }
          catch (e) { if (i === 2) log(`[credits] ${label} failed after retries (the sweep returns the hold after ${Math.round(abandonedHoldMs() / 1000)} s): ${String(e?.message || e).slice(0, 120)}`); else await sleep(500 * (i + 1)); }
        }
      } finally { if (holdId) liveHolds.delete(holdId); }
    })();
  }

  // Express gate: mount BEFORE the x402 paywall. `priceFor(method, path)` ->
  // { priceUsd } for catalog routes, null otherwise. A Bearer a402_ key on a
  // priced route either authorizes (req.creditsSettling = true, debit on 200)
  // or answers 402 with the balance and a top-up link; non-credit requests
  // pass through untouched. On the database the middleware is async (the
  // hold is a row lock away); on the files it is synchronous, as before.
  function gate(priceFor) {
    // What every request does before the hold: null = not ours, pass through;
    // `{ done: true }` = answered here; else the key and the priced item.
    const begin = (req, res) => {
      const auth = String(req.headers?.authorization || "");
      if (!/^Bearer a402_/.test(auth)) return null;
      const key = auth.slice(7).trim();
      const item = priceFor(req.method, req.path, req);
      if (!item) return null; // not a priced catalog route - let the site handle it
      // Identity-bound routes (wallet-keyed memory, my-usage) derive the caller
      // from a SIGNED x402 payer; a credits key carries no verified wallet, so
      // they are refused here (same rule as the Tempo and Stripe gates).
      if (item.identityBound) {
        res.setHeader("X-Credits-Error", "identity-bound");
        res.status(402).json({ error: "This route is wallet-identity bound (the payment IS the identity); prepaid credits carry no verified wallet. Pay it over an x402 rail.", reason: "identity-bound" });
        return { done: true };
      }
      return { key, item };
    };
    // After the hold: the refusal, or the settle-on-finish wiring.
    const arm = (req, res, next, a, item) => {
      if (!a.ok) {
        res.setHeader("X-Credits-Error", a.reason);
        return res.status(402).json({ error: a.reason === "insufficient" ? `Insufficient credits: this call costs $${item.priceUsd} and the key holds $${a.balanceUsd}.` : a.reason === "unknown" ? "Unknown credits key." : a.reason === "disabled" ? "This credits key is disabled." : "Malformed credits key.", reason: a.reason, balanceUsd: a.balanceUsd ?? null, priceUsd: item.priceUsd, ...creditsTopupFields(baseUrl) });
      }
      // Accepted: the x402 dispatcher is bypassed for this request, so any
      // UNSIGNED payment headers riding alongside must not survive to a handler
      // that reads authorization.from (payerFromRequest) - strip them, exactly
      // as the Tempo and Stripe gates do on acceptance.
      for (const h of ["payment-signature", "x-payment", "payment-identifier", "x-pow-solution"]) { if (req.headers && h in req.headers) delete req.headers[h]; }
      req.creditsSettling = true; req.creditsSettled = true; req.creditsKeyId = a.keyId; req.creditsPriceUsd = item.priceUsd;
      if (a.holdId) liveHolds.add(a.holdId);
      res.setHeader("X-Credits-Balance", String(a.balanceUsd));
      const slug = item.slug || req.path;
      // The two outcomes of the hold. On the files they answer at once; on the
      // database they are scheduled (and retried), and the charged amount is
      // recorded when the debit lands.
      const settleHold = (chargeUsd = null) => {
        if (!usePg) { const c = settle(a.hash, a.heldMicro, slug, chargeUsd); if (c) req.creditsCharged = c.chargedUsd; return; }
        later(`debit of key ${a.keyId}`, () => settle(a.hash, a.heldMicro, slug, chargeUsd, a.holdId), (c) => { if (c) req.creditsCharged = c.chargedUsd; }, a.holdId);
      };
      const releaseHold = () => {
        if (!usePg) { release(a.hash, a.heldMicro); return; }
        later(`release of key ${a.keyId}`, () => release(a.hash, a.heldMicro, a.holdId), null, a.holdId);
      };
      let done = false;
      // Debit ONLY when the response actually finished with a 200 (Node's default
      // statusCode is 200 before anything is written, so a client abort before
      // the first byte would otherwise read as a served 200 and be charged).
      res.on("finish", () => {
        if (done) return; done = true;
        // A prompt-cache hit (X-Cache: hit) cost nothing upstream and is served
        // free to x402 buyers pre-paywall - credits buyers get the same.
        // An idempotent REPLAY (X-Idempotent-Replay: true, server.js) served the
        // stored body of a call this key already paid for: no handler ran, no
        // upstream spend, so it is released like a cache hit. Before this the
        // replay middleware, mounted AFTER this gate, answered 200 into a live
        // hold and a credits buyer's keyed retry was debited a second time - on
        // a metered route at the FULL worst-case hold, since no X-Metered-Usd
        // header exists on a replay (found in the 2026-08-26 security review).
        const cacheHit = String(res.getHeader?.("X-Cache") || "").toLowerCase() === "hit"
          || String(res.getHeader?.("X-Idempotent-Replay") || "").toLowerCase() === "true";
        // A metered route reports actual usage x markup on X-Metered-Usd
        // (gateway-meter.js); the debit is that, never more than the hold.
        const metered = Number(res.getHeader?.("X-Metered-Usd"));
        if (res.statusCode === 200 && !cacheHit) settleHold(Number.isFinite(metered) && metered > 0 ? metered : null);
        else releaseHold();
      });
      // A client that drops the socket before the response finished (`finish`
      // never fires on a destroyed socket). After the first byte (a stream
      // that began) the response was partly delivered: the hold settles, once.
      //
      // Before the FIRST byte the close alone decides nothing: the handler may
      // still be running, and what happens to the hold is the same rule every
      // other rail follows (src/hangup-settlement.js), read when the abandoned
      // response ENDS - its final status is known then:
      //   - a >= 400 (the dispatcher refusing to start a handler for a client
      //     already gone, or a handler that failed) is never charged;
      //   - a run holding a granted forgiveness ticket is not charged;
      //   - otherwise (the forgiveness budget is spent, or the route reserved
      //     no ticket) the hold settles, exactly as before this rule, and
      //     creditsChargedOnClose tells the hang-up hook to book it as owed.
      //     That keeps an abort from being a free expensive run on this rail
      //     (the 2026-08-28 finding: /v1/research ran, nothing was debited).
      // The dispatcher always ends a response; a hold nobody ends within
      // CREDITS_ABANDONED_HOLD_MS is released (nothing was delivered).
      let goneEarly = false;
      const decideGone = () => {
        if (done) return; done = true;
        const cacheHit = String(res.getHeader?.("X-Cache") || "").toLowerCase() === "hit"
          || String(res.getHeader?.("X-Idempotent-Replay") || "").toLowerCase() === "true";
        if (res.statusCode >= 400 || cacheHit || chargeCancelledForClientGone(req)) { releaseHold(); return; }
        if (usePg) {
          // The hang-up hook reads the owed amount as the response ends, before
          // the row is written: the hold is what this debit takes.
          req.creditsCharged = microToUsd(a.heldMicro); req.creditsChargedOnClose = microToUsd(a.heldMicro);
          settleHold();
          return;
        }
        const c = settle(a.hash, a.heldMicro, slug);
        if (c) { req.creditsCharged = c.chargedUsd; req.creditsChargedOnClose = c.chargedUsd; }
      };
      const priorEnd = res.end;
      res.end = function creditsAwareEnd(...args) {
        if (goneEarly) decideGone();
        return priorEnd.apply(this, args);
      };
      res.on("close", () => {
        if (done) return;
        if (res.headersSent) { done = true; settleHold(); return; }
        goneEarly = true;
        const t = setTimeout(() => { if (!done) { done = true; releaseHold(); } }, abandonedHoldMs());
        t.unref?.();
      });
      return next();
    };
    if (!usePg) {
      return (req, res, next) => {
        const b = begin(req, res);
        if (!b) return next();
        if (b.done) return;
        return arm(req, res, next, authorize(b.key, b.item.priceUsd), b.item);
      };
    }
    return async (req, res, next) => {
      const b = begin(req, res);
      if (!b) return next();
      if (b.done) return;
      let a;
      try { a = await authorize(b.key, b.item.priceUsd); }
      catch (e) {
        // No hold could be placed: nothing is charged and nothing is served.
        log(`[credits] hold failed: ${String(e?.message || e).slice(0, 120)}`);
        res.setHeader("X-Credits-Error", "unavailable");
        return res.status(503).json({ error: "Prepaid credits are unavailable right now; nothing was charged. Retry shortly.", reason: "unavailable" });
      }
      return arm(req, res, next, a, b.item);
    };
  }

  /** A presented key -> its id (null for an unknown key). Used by the digest signup: presenting the key is the proof. */
  function keyIdOf(keyString) {
    if (typeof keyString !== "string" || !KEY_RE.test(keyString)) return answer(null);
    const rec = readRec(hashKey(keyString));
    return usePg ? rec.then((r) => (r ? r.keyId : null)) : rec ? rec.keyId : null;
  }
  /** USD balance for a key id (the digest never holds the key itself). */
  function balanceById(keyId) {
    const pick = (xs) => { const hit = xs.find((x) => x.rec && x.rec.keyId === keyId); return hit ? microToUsd(hit.rec.balanceMicro) : null; };
    return usePg ? allKeys().then(pick) : pick(allKeys());
  }
  return { createCheckout, claim, authorize, settle, release, charge, balance, status, setDisabled, disableByPaymentIntent, gate, keyIdOf, balanceById, _dir: dir, ready: () => readyP(), sweepAbandonedHolds, backend: usePg ? "pg" : "file" };
}
