// One "container" for scripts/test-avm-subcent-shared-redis.js: a child process
// that loads the real Algorand sub-cent gate with the parent's REDIS_URL, runs
// one named operation from argv (JSON: { op, payTo, req }) and prints its
// result as the last JSON line. The parent passes data only, never code.
const m = await import("../../src/avm-sponsorship.js");
const { shared } = await import("../../src/shared-limits.js");

const { op, payTo, req } = JSON.parse(process.argv[2] || "{}");
m._resetAvmSponsorshipForTest({ logger: () => {}, installed: true });
const pair = () => [req, { ...req, network: "eip155:8453" }];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// Bounded polling: a cold Redis connection can take longer than any fixed sleep.
const until = async (fn) => { for (let i = 0; i < 100; i++) { if (await fn()) return true; await sleep(100); } return false; };

async function run() {
  switch (op) {
    // B before any refusal: what it offers.
    case "offer": {
      const n = await m.syncSharedSubcentPause([payTo]);
      return { n, paused: m.isSubcentPaused(payTo), kept: m.withoutPausedSubcentAvm(pair()).length };
    }
    // A records a settle refusal and stays up until the shared flag is readable
    // (the refusal's shared write is fire-and-forget on the settle path).
    case "refuse": {
      const p = m.noteAvmSettleRefusal({ network: "algorand:mainnet", payTo, errorReason: "subcent_quota_exceeded" });
      const landed = await until(async () => { const r = await shared.flagGet("avm-subcent-refusal", payTo); return !!(r?.ok && r.until > 0); });
      return { p, landed, paused: m.isSubcentPaused(payTo) };
    }
    // B reads the shared refusal once.
    case "read": {
      const before = m.isSubcentPaused(payTo);
      const n = await m.syncSharedSubcentPause([payTo]);
      return { before, n, paused: m.isSubcentPaused(payTo), kept: m.withoutPausedSubcentAvm(pair()).map((r) => r.network), rails: m.avmSubcentOfferStatus().length };
    }
    // A fresh container's 402 path: the gate's first build kicks the shared read.
    case "gate": {
      class RS { async buildPaymentRequirementsFromOptions() { return pair(); } }
      m.installAvmSubcentGate(RS);
      const rs = new RS();
      const first = (await rs.buildPaymentRequirementsFromOptions([], {})).length;
      await until(() => m.isSubcentPaused(payTo));
      const second = (await rs.buildPaymentRequirementsFromOptions([], {})).map((r) => r.network);
      return { first, second };
    }
    // A headroom read inside the hold window.
    case "headroom": {
      await m.syncSharedSubcentPause([payTo]);
      const v = m.noteSponsorshipStatus(payTo, { quota: 1000, usedMonth: 10, purchasedRemaining: 0, updatedTs: new Date().toISOString() });
      return { v, paused: m.isSubcentPaused(payTo) };
    }
    // A shared refusal older than the hold window.
    case "old": return { applied: m.applySharedSubcentRefusal(payTo, Date.now() - 31 * 60_000) };
    // A plain shared read (used with the shared store switched off).
    case "sync": {
      const n = await m.syncSharedSubcentPause([payTo]);
      return { n, paused: m.isSubcentPaused(payTo) };
    }
    default: return { error: `unknown op ${op}` };
  }
}

console.log(JSON.stringify(await run()));
process.exit(0);
