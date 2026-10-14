// Captcha-kit — the LEGITIMATE slice of the "captcha" demand cluster (#471):
// help an agent RUN bot protection, never defeat someone else's.
//
//   captcha-generate  (pure-CPU, PoW-eligible): mint a stateless challenge to
//                     gate YOUR OWN endpoint — a prompt to show the user plus a
//                     salted answer hash the caller keeps and checks later, no
//                     server state, no shared secret.
//   captcha-verify    (egress, wallet-only): validate a Cloudflare Turnstile /
//                     Google reCAPTCHA / hCaptcha token server-side by relaying
//                     the caller's OWN provider secret to that provider's fixed
//                     siteverify endpoint. The secret is never logged.
//
// Explicitly NOT here: a captcha SOLVER (getting past a third party's
// challenge). That's the abuse-enabling half of the cluster and stays declined.
import { createHash, randomInt, randomBytes } from "node:crypto";
import { upstreamFetch, bodyUnderDeadline, underBudgetAll } from "../upstream-deadline.js";

function bad(message, statusCode = 400) {
  return Object.assign(new Error(message), { statusCode });
}

// --- captcha-generate -------------------------------------------------------
// Stateless: the caller shows `prompt` to the user, keeps {salt, answerHash},
// and later verifies with sha256(salt + normalized(userAnswer)) === answerHash.
// The end user only ever sees `prompt`; the hash+salt live with the caller, so
// there's nothing to rainbow-table from the user's side. No server storage, no
// shared key — a pure function of crypto randomness.
const normalizeAnswer = (s) => String(s).trim().toLowerCase().replace(/\s+/g, "");
const ALNUM = "abcdefghjkmnpqrstuvwxyz23456789"; // no ambiguous 0/O/1/l/i

function makeChallenge(type, difficulty) {
  const d = Math.min(Math.max(parseInt(difficulty, 10) || 1, 1), 3);
  if (type === "math") {
    // difficulty scales the operand range; answer is the integer sum/product.
    const max = [9, 20, 50][d - 1];
    const a = randomInt(1, max + 1), b = randomInt(1, max + 1);
    const op = d >= 3 && randomInt(0, 2) ? "*" : "+";
    const answer = op === "*" ? a * b : a + b;
    return { prompt: `What is ${a} ${op === "*" ? "×" : "+"} ${b}?`, answer: String(answer) };
  }
  // alnum code — length scales with difficulty
  const len = [5, 7, 9][d - 1];
  let code = "";
  for (let i = 0; i < len; i++) code += ALNUM[randomInt(0, ALNUM.length)];
  return { prompt: `Type these characters: ${code}`, answer: code };
}

// --- captcha-verify ---------------------------------------------------------
// Provider allowlist: a FIXED map of provider -> siteverify URL. The caller
// picks a provider name (never a URL), so there is no SSRF surface at all —
// the connection target is server-controlled. All three take a form-encoded
// POST of {secret, response, remoteip?} and answer 200 {success, ...}.
const PROVIDERS = {
  turnstile: "https://challenges.cloudflare.com/turnstile/v0/siteverify",
  recaptcha: "https://www.google.com/recaptcha/api/siteverify",
  hcaptcha: "https://hcaptcha.com/siteverify",
};

export const CAPTCHA_TOOLS = [
  {
    route: "POST /api/captcha-generate",
    name: "Captcha generate",
    slug: "captcha-generate",
    category: "api",
    price: "$0.001",
    description:
      "Mint a stateless captcha challenge to gate your OWN endpoint: returns a human prompt plus a salted sha256 answer hash you keep and verify later (sha256(salt + normalized answer) === answerHash) - no server state, no shared secret. Types: math (arithmetic) or alnum (character code), difficulty 1–3. Deterministic tooling for running bot protection, not defeating it.",
    tags: ["captcha", "challenge", "bot-protection", "verification", "signup", "gate", "anti-abuse"],
    discovery: {
      bodyType: "json",
      input: { type: "math", difficulty: 1 },
      inputSchema: {
        properties: {
          type: { type: "string", description: "math | alnum (default math)" },
          difficulty: { type: "integer", description: "1–3 (default 1)" },
        },
      },
      output: { example: { type: "math", prompt: "What is 3 + 4?", salt: "…", answerHash: "…", algo: "sha256", verify: "sha256(salt + answer.trim().toLowerCase().replace(/\\s+/g,'')) === answerHash" } },
    },
    handler: (input) => {
      const type = input?.type === undefined || input?.type === null || input?.type === "" ? "math" : String(input.type).trim().toLowerCase();
      if (type !== "math" && type !== "alnum") { const e = new Error('"type" must be math or alnum'); e.statusCode = 400; throw e; }
      const { prompt, answer } = makeChallenge(type, input?.difficulty);
      const salt = randomBytes(16).toString("hex");
      const answerHash = createHash("sha256").update(salt + normalizeAnswer(answer)).digest("hex");
      return {
        type,
        prompt,
        salt,
        answerHash,
        algo: "sha256",
        // How the caller checks a user's answer — stateless, no re-call needed.
        verify: "sha256(salt + userAnswer.trim().toLowerCase().replace(/\\s+/g,'')) === answerHash",
      };
    },
  },
  {
    route: "POST /api/captcha-verify",
    name: "Captcha verify",
    slug: "captcha-verify",
    category: "api",
    price: "$0.002",
    description:
      "Validate a Cloudflare Turnstile, Google reCAPTCHA, or hCaptcha token server-side. You pass your OWN provider secret plus the token from the client; we relay to the provider's siteverify endpoint (never logged) and return the normalized verdict (success, hostname, action, score, error codes). The legitimate backend half of bot protection - no solving, no bypass.",
    tags: ["captcha", "turnstile", "recaptcha", "hcaptcha", "verify", "bot-protection", "siteverify", "signup"],
    discovery: {
      bodyType: "json",
      // Cloudflare publishes always-pass test keys, so the example is a REAL
      // green verify: 1x0000000000000000000000000000000AA is their
      // "always passes" secret + "XXXX.DUMMY.TOKEN.XXXX" the dummy token, so
      // the tool answers its own example with a true 200 verdict.
      input: { provider: "turnstile", secret: "1x0000000000000000000000000000000AA", token: "XXXX.DUMMY.TOKEN.XXXX" },
      inputSchema: {
        properties: {
          provider: { type: "string", description: "turnstile | recaptcha | hcaptcha" },
          secret: { type: "string", description: "your provider secret key (relayed to the provider, never stored/logged)" },
          token: { type: "string", description: "the captcha response token from the client" },
          remoteip: { type: "string", description: "optional client IP to pass through" },
        },
        required: ["provider", "secret", "token"],
      },
      output: { example: { provider: "turnstile", success: true, hostname: "example.com", errorCodes: [] } },
    },
    handler: async (input) => {
      const provider = String(input?.provider || "").trim().toLowerCase();
      const url = PROVIDERS[provider];
      if (!url) throw bad(`Unknown provider "${provider}" - one of: ${Object.keys(PROVIDERS).join(", ")}`);
      const secret = String(input?.secret || "");
      const token = String(input?.token || "");
      if (!secret) throw bad('Missing "secret" (your provider secret key)');
      if (!token) throw bad('Missing "token" (the client captcha response)');
      const form = new URLSearchParams({ secret, response: token });
      if (input?.remoteip) form.set("remoteip", String(input.remoteip));
      // One siteverify read under its own cap and the handler budget
      // (src/upstream-deadline.js): a provider that outlives it, or cannot be
      // reached, is a 503 naming the provider and the step, attributed upstream.
      // The body carries the caller's secret and is never logged.
      const ctx = { label: "Captcha provider", step: "siteverify", timeoutMs: 8_000, tag: "[captcha]" };
      const res = await upstreamFetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: form.toString(),
      }, ctx);
      if (!res.ok) throw bad(`Captcha provider returned HTTP ${res.status}`, 502);
      let j;
      try { j = await bodyUnderDeadline(res.json(), ctx); } catch (err) { if (err?.statusCode) throw err; throw bad("Captcha provider returned non-JSON", 502); }
      // Normalize the three providers' fields into one shape.
      return {
        provider,
        success: !!j.success,
        hostname: j.hostname ?? null,
        challengeTs: j.challenge_ts ?? null,
        action: j.action ?? null,
        score: typeof j.score === "number" ? j.score : null, // reCAPTCHA v3
        errorCodes: j["error-codes"] || j.errorCodes || [],
      };
    },
  },
];

// Every handler runs under one budget (src/upstream-deadline.js).
underBudgetAll(CAPTCHA_TOOLS);
