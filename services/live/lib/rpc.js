// Minimal JSON-RPC over fetch with endpoint failover. No keys: public
// endpoints only, so this service never draws on production's RPC budget.
export function makeRpc(urls, { timeoutMs = 10_000, fetchImpl = fetch } = {}) {
  const list = urls.filter(Boolean);
  let preferred = 0;
  return async function rpc(method, params) {
    let lastErr;
    for (let k = 0; k < list.length; k++) {
      const i = (preferred + k) % list.length;
      try {
        const res = await fetchImpl(list[i], {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
          signal: AbortSignal.timeout(timeoutMs),
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const j = await res.json();
        if (j.error) throw new Error(`${j.error.code}: ${String(j.error.message).slice(0, 120)}`);
        preferred = i;
        return j.result;
      } catch (e) {
        lastErr = e;
      }
    }
    throw lastErr || new Error("no rpc endpoint");
  };
}

export const hexToBig = (h) => BigInt(h || "0x0");
export const toHex = (n) => "0x" + BigInt(n).toString(16);
export const topicAddr = (t) => "0x" + String(t || "").slice(-40).toLowerCase();
export const addrTopic = (a) => "0x" + "0".repeat(24) + String(a).toLowerCase().replace(/^0x/, "");
