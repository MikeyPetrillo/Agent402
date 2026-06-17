# Agent402 Tollbooth for WordPress

Open-source pay-per-crawl for WordPress, with no Cloudflare or Stripe in
the middle. Drop the plugin in, paste your Base USDC wallet, and AI
crawlers (GPTBot, ClaudeBot, CCBot, PerplexityBot, Bytespider,
Google-Extended, …) start getting `HTTP 402 Payment Required` while
humans and classic search indexers (Googlebot, Bingbot) keep browsing
free.

> **Status: beta.** Tested on WP 6.5+ / PHP 7.4+. Ships with a real
> classifier and an observe-mode dashboard — those are pure PHP and
> work standalone. The free **proof-of-work** rail and the paid **USDC
> (x402)** rail delegate verification to a tiny external Worker because
> a single PHP process can't safely share the HMAC + single-use replay
> store across requests. See "Wire the rails" below.

## What it does (and doesn't)

- Mirrors the same 25-UA classifier, mode flags (`observe` / `bots` /
  `all` / `strict`), and stats vocabulary as the
  [`agent402-tollbooth`](https://www.npmjs.com/package/agent402-tollbooth)
  npm package. An agency running mixed WordPress + Node clients sees one
  consistent dashboard.
- **Runs as pure observe-or-block out of the box.** No Worker required
  for the basic "deter AI-training scrapers" job. That's what most
  publishers want today anyway — the USDC payday turns on once AI
  vendors ship buyer-side x402.
- **Delegates the cryptographic rails to a Worker** when you want the
  free PoW + paid USDC tiers (so a crawler with no wallet can still
  pass by burning CPU, and a crawler with a wallet can pay you USDC).
  See "Wire the rails."

## Install

1. Copy this folder into `wp-content/plugins/agent402-tollbooth/`. Or
   zip it and upload via **Plugins → Add New → Upload Plugin**.
2. **Activate** the plugin.
3. Go to **Settings → Agent402 Tollbooth**.
4. Leave the mode on `observe` for the first 7-14 days. The dashboard
   fills in with classification counts. Don't enable enforcement until
   the numbers look right.
5. When you're ready, change mode to `bots` and save. The same
   classifier, the same UA list — but crawlers now get 402.

## Settings

| Field | What it does |
|---|---|
| Enabled | Master kill switch. Off = the gate is a no-op. |
| Mode | `observe` / `bots` / `all` / `strict`. See the bullet table in the [main Tollbooth docs](https://github.com/MikeyPetrillo/Agent402/tree/main/tollbooth#how-it-decides-who-pays). |
| USDC wallet | Your own Base wallet — Agent402 never holds funds. Optional in `observe` mode. |
| Price | Price per request (e.g. `$0.002`) advertised in the 402. |
| Network | `base` (mainnet, default) / `base-sepolia` / `polygon` / `arbitrum`. |
| Verifier URL | Optional external verifier (a Worker) for PoW + x402 rails. |
| Site ID | Tag used when this site reports stats to a multi-site dashboard (Cloud). Default: your domain. |

## Stats

The plugin keeps a small set of counters in `wp_options` (key
`agent402_tollbooth_stats`):

- `requests` — every non-admin request the gate sees
- `freeAllowed` — humans / non-bots that passed
- `wouldCharge` — observe-mode classification of "would have been 402"
- `charged` — actual 402s sent (enforcement mode)
- `powSolved` — successful proof-of-work submissions (needs verifier)
- `x402Paid` — settled USDC payments (needs verifier)

Plus a `lastReset` timestamp. The dashboard widget on **Settings →
Agent402 Tollbooth** renders these live.

## Wire the rails (optional)

The PoW + USDC rails are delegated to a verifier URL. Deploy the
[Cloudflare Worker template](../cloudflare/) — it's ~150 lines of code
that exposes a `POST /verify` endpoint and signs/verifies tokens with
its own `TOLLBOOTH_SECRET`. Paste the worker URL into the plugin's
**Verifier URL** field. The plugin will:

- POST `{kind, token, resource, payTo, price, network}` to the
  verifier on every gated request.
- Trust a `{"ok": true}` response (8s timeout, conservative — any
  failure or non-200 = fail-closed = send 402).
- Bump `powSolved` / `x402Paid` on success and pass the request through
  with the `X-Tollbooth-Paid` header set.

If you don't want to run a Worker, leave Verifier URL blank: the plugin
still works as a pure observe-or-block gate, which is enough to deter
AI training crawl today.

## What's skipped

The gate explicitly **does not** charge:

- `/wp-admin` and `/wp-login.php` (you want to log in)
- `wp-cli` and cron contexts
- The admin UI itself (`is_admin()`)

The REST API and the public site (pages, posts, the home page, the
public REST routes) **are** gated.

## Multi-site / agencies

For multi-site rollups and white-label dashboards, see
[Tollbooth for Agencies](https://github.com/MikeyPetrillo/Agent402/wiki/Tollbooth-for-Agencies).
The plugin already tags every stat with `site_id` (defaults to the
site's domain), so an agency-side ingest endpoint can group across
sites automatically.

## Privacy

The gate logs nothing per-request. The stats above are aggregate
integers in `wp_options`. If you point the plugin at a verifier URL,
exactly one JSON envelope per gated request goes to that Worker:
`{kind, token, resource, payTo, price, network}`. Nothing else.

## Roadmap

- 0.2 — Multi-site Cloud sink (HTTP push to a configured ingest URL).
- 0.3 — Per-path overrides via a WP filter (charge a paywall page more
  than a homepage, e.g.).
- 0.4 — WordPress.org submission (after the WP plugin team review). For
  now, install from this folder.

## License

MIT, same as the parent project. Source:
[`MikeyPetrillo/Agent402/tree/main/tollbooth/deploy/wordpress`](https://github.com/MikeyPetrillo/Agent402/tree/main/tollbooth/deploy/wordpress).
