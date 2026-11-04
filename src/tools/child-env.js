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
