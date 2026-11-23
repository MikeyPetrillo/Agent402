// Test preload for scripts/test-visa-tap.js: the booted server reads its TAP
// registry listings from TAP_TEST_REGISTRY (a JSON object, keyid -> listing
// text) instead of the network, and every web_bot_auth rollup it would send to
// analytics is appended to TAP_TEST_OUT as one JSON line, so the suite can see
// that a signed request was verified (the control beside "answered alike").
// Loaded with `node --import ./scripts/lib/tap-registry-preload.js src/server.js`.
import { appendFileSync } from "node:fs";
import { _setTapRegistryFetchForTest } from "../../src/web-bot-auth.js";
import { _setSinkForTest, flushWebBotAuthRollup, flushObservability } from "../../src/posthog-observability.js";

const listings = JSON.parse(process.env.TAP_TEST_REGISTRY || "{}");
const out = process.env.TAP_TEST_OUT || "";
_setTapRegistryFetchForTest(async (url) => {
  const keyid = String(url).split("/").pop();
  if (out) appendFileSync(out, JSON.stringify({ registry: url }) + "\n");
  if (!listings[keyid]) throw new Error("not listed");
  return { text: listings[keyid], maxAgeS: 60 };
});
const capture = (event, props) => { if (out && event === "web_bot_auth") appendFileSync(out, JSON.stringify({ event, ...props }) + "\n"); };
setInterval(() => { _setSinkForTest(capture, () => true); flushWebBotAuthRollup(); flushObservability(); }, 100).unref();
_setSinkForTest(capture, () => true);
