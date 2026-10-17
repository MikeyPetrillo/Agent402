// agent402-mcp: resend a paid request once, unchanged, when its answer was lost.
//
// The fetch the x402 wrapper (index.js getPayFetch) sends with. A paid send
// whose connection drops before the answer arrives may still have settled;
// the server keeps such an answer and returns it to a resend of the SAME signed request (same payment
// header, URL and body) without settling again, and answers 409 with
// Retry-After while the first request is still finishing. So a paid send is
// resent once, byte for byte, on a dropped connection or on that 409. A send
// without a payment header, or one the caller aborted, is never resent.
export const RESEND_MAX_WAIT_MS = 10_000;
export async function resendSamePaymentOnce(input, init, { fetchImpl = fetch, sleep = (ms) => new Promise((r) => setTimeout(r, ms)) } = {}) {
  const request = new Request(input, init);
  if (!request.headers.has("payment-signature") && !request.headers.has("x-payment")) return fetchImpl(request);
  const spare = request.clone();
  let first;
  try {
    first = await fetchImpl(request);
  } catch (err) {
    if (request.signal?.aborted) throw err;
    return fetchImpl(spare);
  }
  if (first.status !== 409 || !first.headers.get("retry-after")) return first;
  const body = await first.clone().json().catch(() => null);
  if (body?.error !== "payment_settling") return first;
  const seconds = Number(first.headers.get("retry-after"));
  await sleep(Math.min(RESEND_MAX_WAIT_MS, Number.isFinite(seconds) && seconds > 0 ? seconds * 1000 : 1000));
  return fetchImpl(spare);
}
