// The environment a spawned helper binary (ffmpeg, ffprobe, Chromium) gets:
// an allowlist of the variables a binary needs to find itself, its libraries,
// fonts, a temp directory and a locale. Nothing else in process.env (payment
// keys, provider keys, database URLs, tokens) reaches the child's own
// environment.
//
// This is defense in depth, not a boundary: a child runs as the same user as
// the server, so a compromised decoder or renderer can still read the
// parent's environment from /proc/<ppid>/environ (and, under the default
// ptrace scope, its memory). The boundary for buyer-supplied media and pages
// is the secretless render worker (RENDER_WORKER_URL, worker/server.js),
// which holds no payment, provider or database credential.
const CHILD_ENV_KEYS = [
  "PATH", "HOME", "TMPDIR", "TMP", "TEMP", "LANG", "LC_ALL", "LC_CTYPE", "TZ",
  "LD_LIBRARY_PATH", "PLAYWRIGHT_BROWSERS_PATH", "FONTCONFIG_PATH", "FONTCONFIG_FILE",
  "XDG_CACHE_HOME", "XDG_CONFIG_HOME", "XDG_RUNTIME_DIR",
];

export function childEnv(source = process.env) {
  const env = {};
  for (const k of CHILD_ENV_KEYS) if (typeof source[k] === "string") env[k] = source[k];
  return env;
}

// The environment a parser worker thread (node:worker_threads) gets. Without
// an `env` option a Worker starts with a copy of the whole process
// environment, so code running over buyer bytes (a PDF, an image, HTML, a
// regex) could read every key in it. `threadEnv(own)` is the same allowlist
// as above (a worker that spawns a helper passes it on with childEnv) plus:
//   NODE_ENV      modules read it at import
//   NODE_OPTIONS  with an `env` option Node builds the worker's options from
//                 this variable instead of the parent's, so leaving it out
//                 would drop flags the parent runs with
// and the worker's `own` knobs: the variables its import graph reads, named
// where each worker is created. The same caveat applies as for a child: a
// thread shares the process, so this narrows what a parser bug can read from
// its own globals; it is not a boundary.
const THREAD_ENV_KEYS = [...CHILD_ENV_KEYS, "NODE_ENV", "NODE_OPTIONS"];
export function threadEnv(own = [], source = process.env) {
  const env = {};
  for (const k of [...THREAD_ENV_KEYS, ...own]) if (typeof source[k] === "string") env[k] = source[k];
  return env;
}
