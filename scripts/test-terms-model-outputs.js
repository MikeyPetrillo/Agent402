// /terms passes the model providers' terms on to everyone who uses a
// model-backed tool or a /v1 route: the "Model outputs" section names the
// providers' usage terms (with links), no training of competing models on
// outputs, no presenting AI output (synthetic speech included) as made by a
// person, and no licensed professional advice built on outputs. It renders
// whatever the optional switches say, and the gateway bullet describes the
// routes as this service's own (routing, fallback, metering).
//
//   node scripts/test-terms-model-outputs.js
import "./lib/offline-stores.js"; // per-process and file backends whatever the caller exports (see the file)

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log(`ok - ${m}`); } else { fail++; console.error(`FAIL - ${m}`); } };
const { termsPage } = await import("../src/terms.js");

const SWITCHES = ["CREDITS_SALES", "MCP_OAUTH", "WEB_BOT_AUTH"];
const keep = Object.fromEntries(SWITCHES.map((k) => [k, process.env[k]]));
for (const variant of ["off", "on"]) {
  for (const k of SWITCHES) { if (variant === "on") process.env[k] = "on"; else delete process.env[k]; }
  const html = termsPage("https://agent402.tools");
  const m = /<h2 id="model-outputs">Model outputs<\/h2>([\s\S]*?)<h2/.exec(html);
  ok(Boolean(m), `${variant}: /terms has the Model outputs section`);
  const sec = (m ? m[1] : "").replace(/\s+/g, " ");
  ok(/model-backed/.test(sec) && /<code>\/v1<\/code>/.test(sec), `${variant}: it covers the model-backed tools and the /v1 routes`);
  ok(/href="https:\/\/openai\.com\/policies\/usage-policies\/"/.test(sec) && /href="https:\/\/openrouter\.ai\/docs\/features\/provider-routing#terms-of-service"/.test(sec), `${variant}: it links the providers' usage terms and the model terms list`);
  ok(/train or improve an AI model that competes/.test(sec), `${variant}: no training competing models on outputs`);
  ok(/don't present AI output as made by a person/.test(sec) && /Synthetic speech[^.]*must always be disclosed as AI-generated/.test(sec), `${variant}: AI output is never presented as human-made, and synthetic speech is always disclosed`);
  ok(/video clip that depicts a real person[^.]*image-animate[^.]*: it needs the consent of the person it depicts and must always be disclosed as AI-generated/.test(sec) && /offer that speech or those clips to your own users, you must require them to get the same consent and disclose it the same way/.test(sec), `${variant}: a clip of a real person needs that person's consent and an AI disclosure, passed on to the buyer's own users`);
  ok(/advice that requires a professional license/.test(sec), `${variant}: no licensed professional advice built on outputs`);
  const gw = /<li><b>AI gateway:<\/b>([\s\S]*?)<\/li>/.exec(html)?.[1] || "";
  ok(/our gateway service/.test(gw) && /priced before it runs/.test(gw) && !/proxy/.test(gw), `${variant}: the gateway bullet describes the routes as our service`);
  // Fallback is a chat-tier behavior (src/gateway-product-copy.js); embeddings
  // run the model the request names. The bullet scopes both.
  const fb = gw.match(/[^.;]*fall(?:s)? back[^.;]*/g) || [];
  ok(fb.length > 0 && fb.every((c) => /chat tier/.test(c)) && /embeddings[^.;]*the model the request names/.test(gw) && !/fall back to another when one fails, and meter/.test(gw), `${variant}: the bullet scopes fallback to the chat tiers and names the embeddings model accurately (${fb.join(" | ")})`);
  ok(!/—/.test(sec + gw), `${variant}: no em dash`);
}
for (const [k, v] of Object.entries(keep)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }

console.log(`\ntest-terms-model-outputs: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
