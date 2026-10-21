// Reread the facilitator's own signer account when an RPC node answers that
// it does not exist.
//
// A public RPC endpoint can answer from several backend nodes, and a node
// that has not ingested an account yet answers "Account not found" for it.
// For any other address that is an answer; for the signer it is not: the
// signer pays every settlement, so the facilitator cannot run without it.
//
// The SDK's getAccount reports every failed read as "Account not found",
// a timeout or a 5xx included. A read that failed only after fastMs was not
// a node answering, so it is surfaced as before, and no reread starts once
// budgetMs has passed since the first read, which keeps the worst case well
// inside the settle bound. Only rpc.Server.prototype.getAccount for the
// signer is touched.
import { rpc } from "@stellar/stellar-sdk";

const NOT_FOUND = /Account not found/i;

export function installSignerReread(signerAddress, {
  attempts = 3, pauseMs = 1_000, fastMs = 2_000, budgetMs = 5_000,
  proto = rpc.Server.prototype, log = console.log, now = Date.now,
} = {}) {
  if (!signerAddress || typeof proto?.getAccount !== "function" || proto.getAccount.__signerReread) return false;
  const original = proto.getAccount;
  const wrapped = async function getAccount(address, ...rest) {
    if (address !== signerAddress) return original.call(this, address, ...rest);
    const started = now();
    for (let i = 1; ; i++) {
      const readStarted = now();
      try { return await original.call(this, address, ...rest); } catch (err) {
        const answered = now() - readStarted < fastMs;
        if (i >= attempts || !answered || now() - started + pauseMs > budgetMs || !NOT_FOUND.test(String(err?.message || err))) throw err;
        log(`[rpc] signer account not found on read ${i} of ${attempts}, reading again`);
        await new Promise((r) => setTimeout(r, pauseMs));
      }
    }
  };
  wrapped.__signerReread = true;
  proto.getAccount = wrapped;
  return true;
}
