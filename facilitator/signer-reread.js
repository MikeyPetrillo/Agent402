// Reread the facilitator's own signer account when an RPC node says it does
// not exist.
//
// A public RPC endpoint can answer from several backend nodes, and a node
// that has not ingested an account yet answers "Account not found" for it.
// For any other address that is an answer; for the signer it never is: the
// signer pays every settlement, so the facilitator cannot run without it.
// So a not-found for the signer is reread a bounded number of times before
// it is surfaced. Only rpc.Server.prototype.getAccount for that one address
// is touched, and only on that error, so every other call is unchanged.
import { rpc } from "@stellar/stellar-sdk";

const NOT_FOUND = /Account not found/i;

export function installSignerReread(signerAddress, { attempts = 3, pauseMs = 1_000, proto = rpc.Server.prototype, log = console.log } = {}) {
  if (!signerAddress || typeof proto?.getAccount !== "function" || proto.getAccount.__signerReread) return false;
  const original = proto.getAccount;
  const wrapped = async function getAccount(address, ...rest) {
    if (address !== signerAddress) return original.call(this, address, ...rest);
    for (let i = 1; ; i++) {
      try { return await original.call(this, address, ...rest); } catch (err) {
        if (i >= attempts || !NOT_FOUND.test(String(err?.message || err))) throw err;
        log(`[rpc] signer account not served by this node (read ${i} of ${attempts}), reading again`);
        await new Promise((r) => setTimeout(r, pauseMs));
      }
    }
  };
  wrapped.__signerReread = true;
  proto.getAccount = wrapped;
  return true;
}
