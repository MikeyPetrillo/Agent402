// Test preload: answers the web answer upstream's stream with a canned,
// deliberately hostile answer, so a booted server can run GET /api/answer to
// a 200 (and so reach settlement) with no network and nothing spent. Every
// other request goes to the real fetch untouched.
//
// Loaded with `node --import ./scripts/lib/brave-answer-stub-preload.js src/server.js`
// by scripts/test-answer-share.js. The answer carries markup, a script tag,
// an image, a javascript: link and a link to a host no citation names; the
// citations carry a hostile snippet and a non-http URL.
const realFetch = globalThis.fetch;
const ANSWER_URL = "https://api.search.brave.com/res/v1/chat/completions";
export const STUB_ANSWER = [
  "x402 is an open payment standard [1]. See [the spec](https://www.x402.org/spec) for **details**.",
  "<script>alert('pwned')</script><img src=x onerror=alert(1)>",
  "![tracker](https://evil.example/pixel.png) ![cited-host image](https://www.x402.org/pixel.png) Read [more](javascript:alert(2)) or [this](https://evil.example/phish) or https://evil.example/raw.",
  "- first point [2]\n- second point",
].join("\n\n");
export const STUB_CITATIONS = [
  { url: "https://www.x402.org/", snippet: "An open standard <b onmouseover=alert(3)>for</b> payments.", favicon: "https://imgs.example/f.png", number: 1 },
  { url: "https://docs.example.org/x402", snippet: "Second source.", favicon: null, number: 2 },
  { url: "javascript:alert(4)", snippet: "not a web source", favicon: null, number: 3 },
];
globalThis.fetch = async function stubbedAnswer(input, init) {
  const url = typeof input === "string" ? input : input?.url || String(input);
  if (url === ANSWER_URL) {
    const text = STUB_ANSWER + STUB_CITATIONS.map((c) => `<citation>${JSON.stringify(c)}</citation>`).join("");
    const frames = [`data: ${JSON.stringify({ choices: [{ delta: { content: text } }] })}\n\n`, "data: [DONE]\n\n"].join("");
    return new Response(frames, { status: 200, headers: { "content-type": "text/event-stream" } });
  }
  return realFetch(input, init);
};
