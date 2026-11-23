// The Base gas fact, one sentence for every surface that explains paying on
// Base (the /start and /base pages, llms.txt, the connector's payment.info, the
// README, the wiki and the agent402-client README; scripts/test-start-page.js
// reads each one).
//
// What makes it true: the x402 `exact` accept on Base (eip155:8453) sets no
// assetTransferMethod (src/payments.js), so @x402/evm signs the default EIP-3009
// transferWithAuthorization off chain, and the facilitator that settles it
// submits the transaction and pays its gas. It is scoped to `exact` because the
// `upto` scheme moves tokens through Permit2, whose one-time approval is an
// on-chain transaction unless a facilitator sponsors it (src/upto-gas-sponsoring.js).
// It is said of Base alone; each other rail states its own fee handling.
export const BASE_NO_GAS_SENTENCE = "On Base, an x402 exact payment is a signature (EIP-3009): the facilitator submits it and pays the gas, so the paying wallet needs only USDC, no ETH.";

// The same fact in a few words, for the one place size is held tight: the
// Base line of /llms.txt (scripts/test-front-door.js holds the file's size).
export const BASE_NO_GAS_SHORT = "An x402 exact payment needs no ETH.";
