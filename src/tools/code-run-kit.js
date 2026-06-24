// Code execution kit — two tiers of x402-paywalled sandboxed code execution
// via E2B. Each call spins up an isolated VM, runs user code, returns
// stdout/stderr/result, and destroys the VM. No state leaks between callers.
// Env-gated: missing E2B_API_KEY -> 503 at call time, not boot failure.
//
// Tiers:
//   code-run      $0.02  — 30s timeout, 10k chars, Python/JS
//   code-run-pro  $0.05  — 60s timeout, 50k chars, Python/JS

let Sandbox;

const E2B_KEY = () => (process.env.E2B_API_KEY || "").trim();

function bad(message, statusCode = 400) {
  return Object.assign(new Error(message), { statusCode });
}

const LANGUAGES = new Set(["python", "javascript"]);

const TIERS = {
  "code-run":     { timeoutMs: 30_000, maxCodeChars: 10_000 },
  "code-run-pro": { timeoutMs: 60_000, maxCodeChars: 50_000 },
};

function validateInput(input, tierSlug) {
  const code = typeof input.code === "string" ? input.code.trim() : "";
  if (!code) throw bad('"code" is required — the source code to execute');

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
  let sbx;
  try {
    sbx = await Sandbox.create({ apiKey: key, timeoutMs: tier.timeoutMs + 10_000 });
  } catch (e) {
    throw bad(`Sandbox creation failed: ${e.message}`, 502);
  }

  try {
    const execution = await sbx.runCode(code, {
      language,
      timeoutMs: tier.timeoutMs,
    });

    return {
      language,
      stdout: execution.logs?.stdout?.join("") ?? "",
      stderr: execution.logs?.stderr?.join("") ?? "",
      result: execution.text ?? null,
      error: execution.error
        ? {
            name: execution.error.name ?? "Error",
            message: execution.error.value ?? "",
            traceback: execution.error.traceback ?? "",
          }
        : null,
    };
  } catch (e) {
    if (e.statusCode) throw e;
    // Timeout or SDK error
    const isTimeout = /timeout/i.test(e.message);
    throw bad(
      isTimeout ? `Execution timed out after ${tier.timeoutMs / 1000}s` : `Execution failed: ${e.message}`,
      isTimeout ? 504 : 502,
    );
  } finally {
    try { await sbx.kill(); } catch {}
  }
}

function makeHandler(tierSlug) {
  return async (input) => {
    const { code, language } = validateInput(input, tierSlug);
    return runInSandbox(code, language, tierSlug);
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
      "Execute Python or JavaScript code in a secure, isolated cloud sandbox. Returns stdout, stderr, and the expression result. No setup needed; pay per call via x402. 30s timeout, 10k char code limit.",
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
      "Execute Python or JavaScript code in a secure, isolated cloud sandbox (Pro tier). Same as /api/code-run but with 60s timeout and 50k char code limit for longer computations. Returns stdout, stderr, and the expression result.",
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
