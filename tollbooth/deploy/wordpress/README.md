# Agent402 Tollbooth for WordPress

Open-source pay-per-crawl for WordPress that settles straight to your own
wallet. Drop the plugin in, paste your Base USDC wallet, and AI
crawlers (GPTBot, ClaudeBot, CCBot, PerplexityBot, Bytespider,
Google-Extended, …) start getting `HTTP 402 Payment Required` while
humans and classic search indexers (Googlebot, Bingbot) keep browsing
free.

> **Status: beta.** Tested on WP 6.5+ / PHP 7.4+. Ships with a real
> classifier and an observe-mode dashboard, those are pure PHP and
> work standalone. The free **proof-of-work** rail and the paid **USDC
> (x402)** rail delegate verification to a verifier service you run because
> a single PHP process can't safely share the HMAC + single-use replay
> store across requests. See "Wire the rails" below.

## What it does (and doesn't)

- Mirrors the same 25-UA classifier, mode flags (`observe` / `bots` /
  `all` / `strict`), and stats vocabulary as the
  [`agent402-tollbooth`](https://www.npmjs.com/package/agent402-tollbooth)
  npm package. An agency running mixed WordPress + Node clients sees one
  consistent dashboard.
- **Runs as pure observe-or-block out of the box.** No verifier required
  for the basic "deter AI-training scrapers" job. That's what most
  publishers want today anyway, the USDC payday turns on once AI
  vendors ship buyer-side x402.
- **Delegates the cryptographic rails to a verifier** when you want the
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
   classifier, the same UA list, but crawlers now get 402.

**Keep PHP patched.** The plugin runs inside your site's PHP, so your
host's PHP version is part of its security. Run a PHP release that still
receives security updates, and apply PHP security releases as soon as your
host offers them. A vulnerability in PHP itself is fixed by updating PHP;
no plugin setting can mitigate it.

## Settings

| Field | What it does |
|---|---|
| Enabled | Master kill switch. Off = the gate is a no-op. |
| Mode | `observe` / `bots` / `all` / `strict`. See the bullet table in the [main Tollbooth docs](https://github.com/MikeyPetrillo/Agent402/tree/main/tollbooth#how-it-decides-who-pays). |
| USDC wallet | Your own Base wallet. USDC settles to it directly and we never hold it. Optional in `observe` mode. |
| Price | Price per request (e.g. `$0.002`) advertised in the 402. |
| Network | `base` (mainnet, default) / `base-sepolia` / `polygon` / `arbitrum`. |
| Verifier URL | Optional verifier service you run for the PoW + x402 rails (see "Wire the rails"). |
| Verifier secret | Shared HMAC key; every verifier pass must be signed with it. Required for the Verifier URL to be used. |
| Site ID | A label for this site, kept with the plugin settings. The plugin does not send it anywhere yet (see Roadmap). Default: your domain. |

## Stats

The plugin keeps a small set of counters in `wp_options` (key
`agent402_tollbooth_stats`):

- `requests`: every non-admin request the gate sees
- `freeAllowed`: humans / non-bots that passed
- `wouldCharge`: observe-mode classification of "would have been 402"
- `charged`: actual 402s sent (enforcement mode)
- `powSolved`: successful proof-of-work submissions (needs verifier)
- `x402Paid`: settled USDC payments (needs verifier)

Plus a `lastReset` timestamp. The dashboard widget on **Settings →
Agent402 Tollbooth** renders these live.

## Wire the rails (optional)

The PoW + USDC rails are delegated to a verifier service you run. No
verifier ships with this plugin or with the Cloudflare Worker template
(that Worker is a gate in front of an origin, not a verifier), so the
verifier is yours to build against the contract below. Set two fields:

- **Verifier URL**: where the plugin POSTs.
- **Verifier secret**: a random string of 32 characters or more, shared
  with the verifier. The plugin ignores the Verifier URL until it is set.

On every gated request that carries `X-Pow-Solution` or `X-Payment`, the
plugin POSTs `{kind, token, resource, nonce, payTo, price, network}`,
where `nonce` is 32 fresh hex characters. The request passes only when
the verifier answers `200` with:

```json
{ "ok": true, "nonce": "<the same nonce>", "sig": "<hex HMAC-SHA256>" }
```

`sig` is HMAC-SHA256, keyed with the verifier secret, over these five
lines joined with `\n`:

```
agent402-tollbooth-verify.v1
<kind>
<resource>
<nonce>
<hex sha256 of token>
```

A bare `{"ok": true}`, a wrong or missing `sig`, a different nonce, an
error, a non-200 or an 8 s timeout all fail closed (the plugin sends
402). The verifier owns the hard parts: checking the proof-of-work
against its own challenge secret, settling the x402 payment, and making
each credential single use.

On a pass the plugin bumps `powSolved` / `x402Paid` and lets the request
through with the `X-Tollbooth-Paid` header set.

If you don't want to run a verifier, leave Verifier URL blank: the plugin
still works as a pure observe-or-block gate, which is enough to deter
AI training crawl today. For a gate that verifies on its own, run the
[`agent402-tollbooth`](https://www.npmjs.com/package/agent402-tollbooth)
npm package in front of the site (proof-of-work, and x402 settlement
through a facilitator), or the [Cloudflare Worker template](../cloudflare/)
(proof-of-work).

## What's skipped

The gate explicitly **does not** charge:

- The admin screens (`is_admin()`, which covers `/wp-admin`)
- The login page, when `wp-login.php` is the script serving the request
- `wp-cli` and cron contexts

The decision reads what WordPress is serving, not the text of the URL.

The REST API and the public site (pages, posts, the home page, the
public REST routes) **are** gated.

## Multi-site / agencies

The plugin keeps its counts in this site's `wp_options` and does not
push them anywhere yet. To roll up many sites today, run the
`agent402-tollbooth` npm package (Express middleware, or
`createEdgeTollbooth` in your own Worker) with `httpStatsSink` pointed at a
collector you run; see
[Tollbooth for Agencies](https://github.com/MikeyPetrillo/Agent402/wiki/Tollbooth-for-Agencies).

## Privacy

The gate logs nothing per-request. The stats above are aggregate
integers in `wp_options`. If you point the plugin at a verifier URL,
exactly one JSON envelope per gated request that carries a credential
goes to that verifier: `{kind, token, resource, nonce, payTo, price,
network}`. Nothing else. The verifier secret never leaves the site.

## Roadmap

- 0.2: HTTP stats push to an ingest URL you run, tagged with the Site ID.
- 0.3: Per-path overrides via a WP filter (charge a paywall page more
  than a homepage, e.g.).
- 0.4: WordPress.org submission (after the WP plugin team review). For
  now, install from this folder.

## License

MIT, same as the parent project. Source:
[`MikeyPetrillo/Agent402/tree/main/tollbooth/deploy/wordpress`](https://github.com/MikeyPetrillo/Agent402/tree/main/tollbooth/deploy/wordpress).
