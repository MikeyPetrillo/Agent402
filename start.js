// Single-image entrypoint dispatcher (worker isolation — audit F02/F04/F06).
//
// The API server and the secretless browser/media worker ship in ONE image. The
// root railway.toml pins EVERY service to `Dockerfile`, so a per-service
// "config file path" pointer (railway.worker.json) isn't needed — and that
// pointer proved fragile in practice (a service that doesn't have it set silently
// falls back to railway.toml and builds the main server). Instead the worker
// service is distinguished ONLY by `WORKER_MODE=true` in its own env.
//
// We `import` the chosen server (never spawn a child process), so the gosu
// privilege-drop entrypoint (A402-01) still owns PID 1 and the server still
// receives SIGTERM directly for the graceful drain. WORKER_MODE unset →
// byte-identical main-server boot.
// DECIDE_MODE=true boots the decide service (services/decide) the same way.
const on = (v) => /^(1|true|yes|on)$/i.test((v || "").trim());
if (on(process.env.DECIDE_MODE)) {
  const { boot } = await import("./services/decide/server.js");
  await boot().catch((e) => { console.error("[decide] boot failed:", e); process.exit(1); });
} else {
  await import(on(process.env.WORKER_MODE) ? "./worker/server.js" : "./src/server.js");
}
