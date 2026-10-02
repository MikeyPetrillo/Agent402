// Whether prepaid card credits are on sale, in a leaf module so page renderers
// can state it without importing server.js. Off unless CREDITS_SALES is set;
// existing keys keep spending either way.
export const creditsSalesEnabled = () => /^(1|true|on|yes)$/i.test(String(process.env.CREDITS_SALES || "").trim());
