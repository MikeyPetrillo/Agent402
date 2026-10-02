// App attribution for every OpenRouter request we make. OpenRouter files a
// call under the app named in X-Title; a request without these headers still
// works but lands in the activity export (and the logs page) with no app
// name, where no margin review can place it. Its own module so the decide
// service can send it without loading the model gateway.
// scripts/test-openrouter-attribution.js checks every call site in src/ and
// services/.
export const OPENROUTER_ATTRIBUTION = Object.freeze({
  "HTTP-Referer": "https://agent402.tools",
  "X-Title": "Agent402.Tools x402 gateway",
  "X-OpenRouter-Title": "Agent402.Tools x402 gateway",
  "X-OpenRouter-Categories": "personal-agent,api",
});
