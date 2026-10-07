// Code execution kit — two tiers of x402-paywalled sandboxed code execution
// via E2B. Each call spins up an isolated VM, runs user code, returns
// stdout/stderr/result, and destroys the VM. No state leaks between callers.
// Env-gated: missing E2B_API_KEY -> 503 at call time, not boot failure.
//
// Tiers:
//   code-run      $0.02  — 30s timeout, 10k chars, Python/JS
//   code-run-pro  $0.05  — 60s timeout, 50k chars, Python/JS

import { redactSecrets } from "./redact.js";
import { payerFromRequest } from "../payer.js";

let Sandbox;

const E2B_KEY = () => (process.env.E2B_API_KEY || "").trim();

function bad(message, statusCode = 400) {
  return Object.assign(new Error(message), { statusCode });
}

const LANGUAGES = new Set(["python", "javascript"]);

const TIERS = {
  "code-run":     { timeoutMs: 30_000, maxCodeChars: 10_000, maxOutputBytes: 256 * 1024 },
  "code-run-pro": { timeoutMs: 60_000, maxCodeChars: 50_000, maxOutputBytes: 1024 * 1024 },
};

// F12: cap total concurrent E2B sandboxes app-wide. Without this, cheap paid
// calls (or one buyer in a loop) can spin up unbounded sandboxes and burn the
// E2B quota + our memory. Checked BEFORE Sandbox.create so we never pay to
// start one we can't afford.
const E2B_MAX_CONCURRENT = Number(process.env.E2B_MAX_CONCURRENT) || 8;
let e2bInFlight = 0;

// Per-payer concurrency: one caller cannot hold every sandbox slot. Keyed on
// the payer's own identity where the request carries one (signed EVM payer,
// credits key, Tempo sender); otherwise on the client IP, with a looser limit
// because many callers can share one address.
const PER_PAYER_MAX_CONCURRENT = 2;
const PER_IP_MAX_CONCURRENT = 4;
const payerInFlight = new Map();
function payerKeyOf(req) {
  if (!req) return null;
  const payer = payerFromRequest(req);
  if (payer) return `payer:${payer}`;
  if (req.creditsKeyId) return `credits:${req.creditsKeyId}`;
  if (req.mppTempoSender) return `tempo:${String(req.mppTempoSender).toLowerCase()}`;
  return req.ip ? `ip:${req.ip}` : null;
}
const limitFor = (key) => (key?.startsWith("ip:") ? PER_IP_MAX_CONCURRENT : PER_PAYER_MAX_CONCURRENT);

// F12: aggregate UTF-8 output cap. stdout/stderr/result/traceback are otherwise
// returned unbounded — a one-line `print("x"*10**9)` would balloon the response
// and our memory. Budget bytes across the fields and mark truncation explicitly.
function capUtf8(value, budget) {
  const s = String(value ?? "");
  const buf = Buffer.from(s, "utf8");
  if (buf.length <= budget) return { text: s, used: buf.length, truncated: false };
  // Cutting at an arbitrary byte can split a multibyte char; toString then emits
  // a trailing U+FFFD replacement char. Strip that truncation artifact (only a
  // TRAILING one — genuine U+FFFD inside the content is preserved).
  const cut = buf.subarray(0, Math.max(0, budget)).toString("utf8").replace(/�+$/, "");
  return { text: `${cut}\n…[output truncated at ${budget} bytes]`, used: budget, truncated: true };
}

function validateInput(input, tierSlug) {
  const code = typeof input.code === "string" ? input.code.trim() : "";
  if (!code) throw bad('"code" is required - the source code to execute');

  const cap = TIERS[tierSlug].maxCodeChars;
  if (code.length > cap) {
    throw bad(`Code too long (${code.length} chars). The ${tierSlug} tier allows up to ${cap} chars`);
  }

  const language = typeof input.language === "string"
    ? input.language.trim().toLowerCase()
    : "python";
  if (!LANGUAGES.has(language)) {
    throw bad(`Unsupported language "${language}". Supported: python, javascript`);
  }

  return { code, language };
}

async function runInSandbox(code, language, tierSlug) {
  const key = E2B_KEY();
  if (!key) throw bad("E2B not configured", 503);

  // Lazy-load the SDK so the server boots normally without the dependency
  // in environments that don't offer code execution (self-hosters, CI).
  if (!Sandbox) {
    try {
      const mod = await import("@e2b/code-interpreter");
      Sandbox = mod.Sandbox;
    } catch {
      throw bad("E2B SDK not installed", 503);
    }
  }

  const tier = TIERS[tierSlug];
  // F12: global concurrency gate — refuse BEFORE creating a sandbox so a burst
  // can't run us (and the E2B account) out of capacity.
  if (e2bInFlight >= E2B_MAX_CONCURRENT) throw bad("code execution is at capacity - retry shortly", 503);
  e2bInFlight++;
  let sbx;
  try {
    try {
      sbx = await Sandbox.create({ apiKey: key, timeoutMs: tier.timeoutMs + 10_000 });
    } catch (e) {
      // The SDK text wraps the upstream error body (account state, the key):
      // log it redacted, answer the buyer generically.
      console.warn(`[code-run] sandbox creation failed: ${redactSecrets(String(e?.message || e)).slice(0, 300)}`);
      throw bad("Code execution is temporarily unavailable (the sandbox could not start) - retry shortly. Nothing was charged.", 503);
    }

    // Output streamed so far, kept for a run that hits the time limit.
    const partial = { stdout: [], stderr: [], bytes: 0 };
    try {
      const execution = await sbx.runCode(code, {
        language,
        timeoutMs: tier.timeoutMs,
        onStdout: (m) => { if (partial.bytes < tier.maxOutputBytes) { const l = String(m?.line ?? m ?? ""); partial.bytes += l.length; partial.stdout.push(l); } },
        onStderr: (m) => { if (partial.bytes < tier.maxOutputBytes) { const l = String(m?.line ?? m ?? ""); partial.bytes += l.length; partial.stderr.push(l); } },
      });

      // F12: budget the output byte cap across the fields, in priority order,
      // and surface an explicit truncation flag.
      let budget = tier.maxOutputBytes;
      const take = (v) => { const c = capUtf8(v, Math.max(0, budget)); budget -= c.used; return c; };
      const stdout = take(execution.logs?.stdout?.join("") ?? "");
      const stderr = take(execution.logs?.stderr?.join("") ?? "");
      const result = execution.text != null ? take(execution.text) : { text: null, truncated: false };
      // FR4-09: the error name AND message (execution.error.value) go through the
      // SAME aggregate budget — a multi-megabyte thrown error must not bypass the
      // output cap.
      const errName = execution.error ? take(execution.error.name ?? "Error") : { text: "Error", truncated: false };
      const errMsg = execution.error ? take(execution.error.value ?? "") : { text: "", truncated: false };
      const traceback = execution.error ? take(execution.error.traceback ?? "") : { text: "", truncated: false };
      const truncated = stdout.truncated || stderr.truncated || result.truncated || errName.truncated || errMsg.truncated || traceback.truncated;

      return {
        language,
        stdout: stdout.text,
        stderr: stderr.text,
        result: result.text,
        error: execution.error
          ? { name: errName.text ?? "Error", message: errMsg.text ?? "", traceback: traceback.text }
          : null,
        ...(truncated ? { truncated: true } : {}),
      };
    } catch (e) {
      if (e.statusCode) throw e;
      // The buyer's code ran to the time limit: the sandbox did the work, so
      // the run is answered (and charged) with what it printed.
      if (/^Execution timed out/i.test(String(e?.message))) {
        let budget = tier.maxOutputBytes;
        const take = (v) => { const c = capUtf8(v, Math.max(0, budget)); budget -= c.used; return c; };
        const stdout = take(partial.stdout.join(partial.stdout.every((l) => l.endsWith("\n")) ? "" : "\n"));
        const stderr = take(partial.stderr.join(partial.stderr.every((l) => l.endsWith("\n")) ? "" : "\n"));
        return {
          language,
          stdout: stdout.text,
          stderr: stderr.text,
          result: null,
          error: null,
          timedOut: true,
          timeLimitSeconds: tier.timeoutMs / 1000,
          ...(stdout.truncated || stderr.truncated ? { truncated: true } : {}),
        };
      }
      // Timeout or SDK error
      const isTimeout = /timeout/i.test(e.message);
      // Non-timeout branch echoes E2B-SDK-derived text (upstream error body) —
      // redact any configured secret (E2B_API_KEY) before it reaches the buyer.
      throw bad(
        isTimeout ? `Execution timed out after ${tier.timeoutMs / 1000}s` : `Execution failed: ${redactSecrets(e.message)}`,
        isTimeout ? 504 : 502,
      );
    } finally {
      try { await sbx?.kill(); } catch { /* */ }
    }
  } finally {
    e2bInFlight--;
  }
}

function makeHandler(tierSlug) {
  return async (input, req) => {
    const { code, language } = validateInput(input, tierSlug);
    const who = payerKeyOf(req);
    if (who) {
      const n = payerInFlight.get(who) || 0;
      if (n >= limitFor(who)) throw bad(`Too many concurrent runs: at most ${limitFor(who)} at a time per caller. Nothing was charged.`, 429);
      payerInFlight.set(who, n + 1);
    }
    try {
      return await runInSandbox(code, language, tierSlug);
    } finally {
      if (who) {
        const n = (payerInFlight.get(who) || 1) - 1;
        if (n > 0) payerInFlight.set(who, n); else payerInFlight.delete(who);
      }
    }
  };
}

const SHARED_TAGS = ["code", "execution", "sandbox", "interpreter", "e2b", "python", "javascript"];

export const CODE_RUN_TOOLS = [
  {
    route: "POST /api/code-run",
    name: "Code execution",
    slug: "code-run",
    category: "ai",
    price: "$0.020",
    description:
      "Execute Python or JavaScript code in a secure, isolated cloud sandbox. Returns stdout, stderr, and the expression result. No setup needed; pay per call via x402. 30s timeout, 10k char code limit. A run that hits the time limit is returned with timedOut: true and the output it printed, and is charged.",
    tags: [...SHARED_TAGS],
    discovery: {
      bodyType: "json",
      input: { code: "print('Hello from Agent402!')", language: "python" },
      inputSchema: {
        properties: {
          code: { type: "string", description: "Source code to execute (max 10,000 chars)" },
          language: { type: "string", description: "Language: python (default) or javascript" },
        },
        required: ["code"],
      },
      output: {
        example: {
          language: "python",
          stdout: "Hello from Agent402!\n",
          stderr: "",
          result: null,
          error: null,
        },
      },
    },
    handler: makeHandler("code-run"),
  },
  {
    route: "POST /api/code-run-pro",
    name: "Code execution (Pro)",
    slug: "code-run-pro",
    category: "ai",
    price: "$0.050",
    description:
      "Execute Python or JavaScript code in a secure, isolated cloud sandbox (Pro tier). Same as /api/code-run but with 60s timeout and 50k char code limit for longer computations. Returns stdout, stderr, and the expression result. A run that hits the time limit is returned with timedOut: true and the output it printed, and is charged.",
    tags: [...SHARED_TAGS, "pro"],
    discovery: {
      bodyType: "json",
      input: { code: "print('Hello from Agent402!')", language: "python" },
      inputSchema: {
        properties: {
          code: { type: "string", description: "Source code to execute (max 50,000 chars)" },
          language: { type: "string", description: "Language: python (default) or javascript" },
        },
        required: ["code"],
      },
      output: {
        example: {
          language: "python",
          stdout: "Hello from Agent402!\n",
          stderr: "",
          result: null,
          error: null,
        },
      },
    },
    handler: makeHandler("code-run-pro"),
  },
];

// Test hooks (F12): the aggregate-output cap logic + tier budgets, exercised
// offline without an E2B sandbox. Concurrency gating (E2B_MAX_CONCURRENT) is a
// straight-line counter checked before Sandbox.create.
export const __test = { capUtf8, TIERS, E2B_MAX_CONCURRENT, PER_PAYER_MAX_CONCURRENT, PER_IP_MAX_CONCURRENT, setSandbox: (S) => { Sandbox = S; } };
