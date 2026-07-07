# Proposed-tweets bot

A daily "propose → you approve → it posts" loop for the Agent402 account. Claude
drafts 2–3 candidate tweets from the last 24h of repo + revenue activity and sends
them to your phone; you reply to approve; the approved one is posted to X with
[`scripts/tweet.js`](../scripts/tweet.js). Nothing is ever posted without your
explicit go-ahead.

## Parts

1. **Trigger** — a daily scheduled Routine (claude-code-remote) that fires a fresh
   Claude session and hands it the drafting task below.
2. **Draft** — Claude reads merged PRs, the tool count, the revenue digest
   (issue #199), and PostHog stats, then writes candidate tweets in your voice.
3. **Approve + post** — you get a push notification with the numbered drafts;
   reply `post 2` (or edit first). Claude runs `scripts/tweet.js` to publish.

## One-time setup (the only part Claude can't do for you)

You need an X developer App so the poster can authenticate as your account.

1. Go to <https://developer.x.com> → sign in with the account you want to post
   from → **Developer Portal**. The **Free** tier is enough for a few posts/day.
2. Create a **Project**, then an **App** inside it.
3. In the App's **Settings → User authentication settings**, set app permissions
   to **Read and write** (default is read-only — posting fails with 403 otherwise).
   Type of App: *Web App / Automated App or Bot* is fine. A callback URL is
   required by the form even though we don't use OAuth redirect — put
   `https://agent402.tools` or `http://localhost`.
4. In **Keys and tokens**, generate/copy all four:
   - **API Key** and **API Key Secret** (the App's consumer credentials)
   - **Access Token** and **Access Token Secret** (for *your* account — regenerate
     these *after* setting Read-and-write permissions, or they'll be read-only).
5. Put the four on Railway (Service → **Variables**), never in the repo:

   ```
   X_API_KEY=...
   X_API_SECRET=...
   X_ACCESS_TOKEN=...
   X_ACCESS_SECRET=...
   ```

That's it. Until these are set, drafting still works; the post step fails safe
with a clear "credential required" message.

## Using the poster directly

```bash
# See exactly what would be sent, without posting:
DRY_RUN=1 node scripts/tweet.js --text "gm — Agent402 now ships 1,410 tools"

# Post for real (needs the four env vars):
node scripts/tweet.js --text "gm — Agent402 now ships 1,410 tools"

# From a file, or piped:
node scripts/tweet.js --file /tmp/tweet.txt
echo "…" | node scripts/tweet.js

# Continue a thread (reply to a tweet id):
node scripts/tweet.js --text "2/ and here's why it matters…" --reply-to 1966...
```

Guards: refuses empty text; refuses >280 chars unless `--force` (for accounts
with long-post access). Exit `0` = posted / dry-run OK, `1` = usage/credential/
length error, `2` = X API error (401 = bad creds or clock skew, 403 = app is
read-only or duplicate content).

## The daily Routine

Set up via the `create_trigger` tool with `create_new_session_on_fire: true` and
push + email notifications. Suggested prompt for the fired session:

> Draft 3 short tweets promoting Agent402, grounded in the **last 24h** of real
> activity. Sources: merged PRs on `main`, the current tool count, the revenue
> digest (issue #199), and PostHog stats. Match the account's voice: concrete,
> builder-to-builder, no hype, occasional dry humor; lead with a specific fact or
> number; ≤280 chars; at most one link; no more than one hashtag. Present them
> numbered with a one-line rationale each. **Do not post anything.** Wait for me
> to reply `post N` (I may edit the text first). On approval, publish with
> `node scripts/tweet.js --text "<final text>"` and reply with the tweet URL. If
> the last 24h had nothing worth posting, say so and propose nothing.

Change the cadence by editing the Routine's cron; pause it anytime by disabling
the Routine or telling Claude to stop.
