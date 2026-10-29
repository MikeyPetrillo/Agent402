// The environment a spawned helper binary (ffmpeg, ffprobe, Chromium) gets:
// an allowlist of the variables a binary needs to find itself, its libraries,
// fonts, a temp directory and a locale. Nothing else in process.env (payment
// keys, provider keys, database URLs, tokens) reaches the child, so a
// compromised decoder or renderer process has no credential to read.
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
