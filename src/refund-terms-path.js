// Where the refund terms document is served (src/refund-terms-doc.js), in a
// leaf module so the 402 body, /api/pricing and the pages can link it
// without importing the payment stack.
export const REFUND_TERMS_PATH = "/.well-known/agent402-refund-terms.json";
