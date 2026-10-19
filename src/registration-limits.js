// Self-serve seller registration limits (POST /api/index/register and
// /api/mpp-index/register): per IP and global, per rolling window, counted
// across every replica through the shared-limits windows (src/shared-limits.js)
// with this process's own counts as the floor.
//
// Each limit is decided on the larger of the two counts: the shared window
// (every replica's registrations) and this process's own list (what one
// replica alone would count). A shared store that does not answer leaves the
// process's own count deciding, which is the one-replica behaviour. A slot is
// taken in both places and can be given back in both (a call that fetched
// nothing returns its global slot).
import { randomBytes } from "node:crypto";
import { shared as defaultShared, sharedLimitsEnabled, noteSharedLimitsDegraded, sharedWrite } from "./shared-limits.js";

export function createRegistrationLimiter({ name, perIpMax = 5, globalMax = 300, windowMs = 3600_000, store = defaultShared, enabled = sharedLimitsEnabled, maxKeys = 5000 } = {}) {
  if (!name) throw new Error("createRegistrationLimiter needs a name");
  const byIp = new Map(); // ip -> [{ at, id }]
  let global = [];        // [{ at, id }]
  const control = `registration-${name}`;
  const ipName = `reg-${name}-ip`, globalName = `reg-${name}-global`;
  const live = (list, now) => list.filter((e) => now - e.at < windowMs);
  const on = () => (typeof enabled === "function" ? enabled() : !!enabled);
  function sweep(now = Date.now()) {
    for (const [k, list] of byIp) { const l = live(list, now); if (l.length) byIp.set(k, l); else byIp.delete(k); }
    global = live(global, now);
  }
  async function sharedCount(nameOf, key, now) {
    if (!on()) return 0;
    const r = await store.windowRead(nameOf, key, { windowMs, now });
    if (!r?.ok) { noteSharedLimitsDegraded(control, r); return 0; }
    return Number(r.count) || 0;
  }
  return {
    perIpMax, globalMax, windowMs,
    /** Is this IP under its limit? (A read: nothing is taken.) */
    async ipAllowed(ip, now = Date.now()) {
      if (byIp.size > maxKeys) sweep(now);
      const local = live(byIp.get(ip) || [], now).length;
      if (local >= perIpMax) return false;
      return (await sharedCount(ipName, ip, now)) < perIpMax;
    },
    /**
     * Take one slot for `ip` against both limits. Resolves { ok: true, slot }
     * or { ok: false, reason: "ip" | "global" }. The global slot is claimed
     * with an add-then-check on the shared window, so two replicas racing for
     * the last slot cannot both get it.
     */
    async take(ip, now = Date.now()) {
      global = live(global, now);
      if (global.length >= globalMax) return { ok: false, reason: "global" };
      const mineLocal = live(byIp.get(ip) || [], now);
      if (mineLocal.length >= perIpMax) return { ok: false, reason: "ip" };
      const id = `${now}-${randomBytes(6).toString("hex")}`;
      if (on()) {
        const g = await store.windowAdd(globalName, "all", { windowMs, member: id, now });
        if (g?.ok && g.count > globalMax) { void sharedWrite(control, store.windowRemove(globalName, "all", { member: id })); return { ok: false, reason: "global" }; }
        if (!g?.ok) noteSharedLimitsDegraded(control, g);
        const p = await store.windowAdd(ipName, ip, { windowMs, member: id, now });
        if (p?.ok && p.count > perIpMax) {
          void sharedWrite(control, store.windowRemove(ipName, ip, { member: id }));
          if (g?.ok) void sharedWrite(control, store.windowRemove(globalName, "all", { member: id }));
          return { ok: false, reason: "ip" };
        }
        if (!p?.ok) noteSharedLimitsDegraded(control, p);
      }
      const slot = { at: now, id, ip };
      mineLocal.push(slot); byIp.set(ip, mineLocal); global.push(slot);
      return { ok: true, slot };
    },
    /** Give back the global slot (the call fetched nothing). */
    giveBackGlobal(slot) {
      if (!slot) return;
      const i = global.indexOf(slot); if (i >= 0) global.splice(i, 1);
      if (on()) void sharedWrite(control, store.windowRemove(globalName, "all", { member: slot.id }));
    },
    /** Give back both slots (nothing was done at all). */
    giveBack(slot) {
      if (!slot) return;
      this.giveBackGlobal(slot);
      const list = byIp.get(slot.ip); if (list) { const i = list.indexOf(slot); if (i >= 0) list.splice(i, 1); }
      if (on()) void sharedWrite(control, store.windowRemove(ipName, slot.ip, { member: slot.id }));
    },
    /** This process's live global count (for the operator log line). */
    globalCount(now = Date.now()) { global = live(global, now); return global.length; },
    sweep,
    /** Tests only. */
    _localCounts(ip, now = Date.now()) { return { ip: live(byIp.get(ip) || [], now).length, global: live(global, now).length }; },
  };
}
