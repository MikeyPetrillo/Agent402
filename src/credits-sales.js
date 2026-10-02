// Whether prepaid card credits are on sale, in a leaf module so page renderers
// can state it without importing server.js. Off unless CREDITS_SALES is set;
// existing keys keep spending either way.
export const creditsSalesEnabled = () => /^(1|true|on|yes)$/i.test(String(process.env.CREDITS_SALES || "").trim());

// The pointer a credits refusal carries. While packs are on sale it is the
// top-up page; while they are not, that page sells nothing, so the answer
// says so and names the paths that do take payment.
export function creditsTopupFields(baseUrl) {
  if (creditsSalesEnabled()) return { topup: `${baseUrl}/credits` };
  return { topup: null, topupNote: "New credits are not on sale; a key already issued keeps working. Pay per call with a wallet over x402 or MPP instead.", pay: `${baseUrl}/api/pricing` };
}
