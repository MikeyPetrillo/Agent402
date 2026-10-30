# AGENTS.md

Project memory and conventions live in [`CLAUDE.md`](CLAUDE.md); dev quickstart,
the tool contract, and the test commands live in [`CONTRIBUTING.md`](CONTRIBUTING.md).
Read those first. This file only adds cloud-agent setup/run caveats.

## Cursor Cloud specific instructions

Agent402 is a single Node/Express service (`src/server.js`) exposing 500+ tools
over HTTP + a hosted MCP connector at `/mcp`. It runs standalone: Redis, Postgres,
the render worker, Stripe (the card front door: `/reports`, `/monitors`, `/credits`,
mounted only with `STRIPE_SECRET_KEY`), and all x402 / MPP facilitators and relays
are optional and no-op when their env vars are unset. `mcp/`, `tollbooth/`, and `client/` are separate npm packages
(clients/SDKs), not backing services.

- **Node version.** The repo requires `node >=22.22.2` (`jsdom` and others enforce
  it via EBADENGINE warnings). A fresh login shell resolves to `v22.22.2` via nvm
  automatically (`bash -lc 'node -v'`), which is what tmux sessions and the update
  script use. If a command instead picks up the `/exec-daemon/node` shim (`v22.14.0`)
  and you hit engine/jsdom errors, run it under a login shell or prepend the nvm bin:
  `export PATH="$HOME/.nvm/versions/node/v22.22.2/bin:$PATH"`.

- **Run the server (dev).** Always use `FREE_MODE=true`, which disables the paywall
  so no wallet or facilitator config is needed:
  `FREE_MODE=true PORT=3000 node src/server.js`. Serves the HTTP API and `/mcp` on
  `:3000`. Verify with `curl -s localhost:3000/health` (expects
  `{"ok":true,"meta":{"toolCount":...}}`). A quick end-to-end tool call:
  `curl -s -X POST localhost:3000/api/hash -H 'content-type: application/json' -d '{"text":"hello","algo":"sha256"}'`.

- **`/mcp` is rate-limited at the server.** The MCP sweep `scripts/test-mcp-all.js`
  drives the whole 500+ catalog and WILL trip the limiter unless the raised limits are set on
  the **server at boot** (not on the test client). Boot it as:
  `AGENT402_MCP_MAX_PER_MIN=999999 AGENT402_MCP_MAX_PER_HOUR=9999999 FREE_MODE=true PORT=3000 node src/server.js`.
  Without this the sweep reports every tool as "no content" / "got EXECUTION" - that
  is the rate limiter, not a real failure. If you already tripped it, wait ~60s for
  the window to reset before rerunning.

- **Tests run against a running server** via `TARGET_URL`. With the server up:
  `TARGET_URL=http://localhost:3000 node scripts/test-all.js` (every tool answers its
  own example), `node scripts/test-mcp-http.js`, and `node scripts/test-mcp-all.js`.
  Offline unit tests need no server: `npm test` (kit2/convert/memory) plus the other
  `scripts/test-*.js`. `test-all.js` skips Brave (20) and E2B (2) routes unless
  `BRAVE_LIVE_TEST=1` / `E2B_LIVE_TEST=1` is set, keys or not; those are covered by
  the paid canary/dedicated CI steps.

- **No linter.** The project has no ESLint/Prettier config or `lint` script; its
  quality gate is the `scripts/test-*.js` suite above.

- **Browser / render tools need Playwright Chromium** (installed by the update
  script into `~/.cache/ms-playwright`). Install it as the normal user, never with
  `sudo` - a root-owned cache makes later non-sudo `npx playwright install` fail with
  `EACCES` on `__dirlock`. If Chromium is missing, `POST /api/render` returns
  "Browser unavailable"; the rest of the catalog is unaffected. Chromium system
  libraries are present in the base image; if a future image lacks them, run
  `sudo npx playwright install --with-deps chromium` once.

- **Auxiliary packages** install and test independently:
  `cd client && node test.js`; `cd tollbooth && npm install && npm test`.
