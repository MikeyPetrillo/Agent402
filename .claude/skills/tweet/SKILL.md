---
name: tweet
description: Post to X from chat with no repo commit - dispatches the Announce workflow with inline text. Handles quote tweets, media, delete/replace, and X's URL character weighting. Use when the user says /tweet, "tweet this", "post to X", "quote tweet <url>", or asks to delete/replace a post.
---

# /tweet — post to X via the Announce workflow

Posts go out through the `Announce` GitHub Actions workflow (`announce.yml` on
`main`), which runs `scripts/tweet.js` with the X credentials stored in Actions
secrets. Nothing is committed to the repo; a tweet is one `workflow_dispatch`
call. Credentials never touch the local machine.

## House style

- **No em dashes.** Use periods, colons, or commas instead.
- Plain text, no hashtag spam. `agent402.tools` on its own line as the closer
  when the post is about the product.
- Marketing counts are evergreen: say "500+ tools", never an exact number.

## Character counting (do this before every post)

X weighs **every URL as 23 characters** (including `agent402.tools`), no matter
its real length. `tweet.js` counts raw string length, so URL-heavy copy can be
over 280 raw but fine on X. Compute both:

```bash
node -e '
const text = process.argv[1];
const urls = text.match(/(?:https?:\/\/\S+|\b[\w-]+\.(?:tools|com|org|dev|xyz|network|io)\b(?:\/\S*)?)/g) || [];
let w = text.length; for (const u of urls) w += 23 - u.length;
console.log("raw:", text.length, "| weighted:", w);
' "$TEXT"
```

- weighted > 280 → trim the copy.
- raw > 280 but weighted ≤ 280 → pass `force: "true"` to the dispatch.

## Posting flow

1. **Draft the copy** (or take the user's). Apply house style. Show the exact
   final text plus both character counts, and get the user's explicit OK
   before dispatching. Posting is public; never skip confirmation.
2. **Dispatch** `announce.yml` on ref `main`:
   - GitHub MCP: `actions_run_trigger` with `method: run_workflow`,
     `workflow_id: announce.yml`, `ref: main`, `inputs: {text: "<copy>"}`.
   - Or gh CLI: `gh workflow run announce.yml --ref main -f text="$TEXT"`
     (add `-f force=true` when needed).
3. **Verify**: poll the run's job (name `post`), read its logs. Success prints
   `Posted ✓ https://x.com/i/web/status/<id>`. Report that URL to the user.
   On failure, show the `X API <status>` line from the logs.

## Quote tweets

The X app is on the Free API tier: `quote` input / `tweet.js --quote` returns
403 unless quoting our own post or one that mentions us. For anyone else's
post, **append the post's URL as the last line of the text** - X renders a
trailing status URL as a real quote embed (verified live). The URL costs 23
weighted chars. Use the `quote` input only for our own posts.

To see what a post says before quoting it (X blocks sandboxed fetches),
dispatch the `X Read` workflow: `x-read.yml` on `main`, input
`status: <id or full URL>`. The job log prints the post's full JSON (text,
author, quoted post, media).

## Media

`media` input: an image URL or a repo path. Mutually exclusive with `card`
(which live-renders the bestsellers card; see announce.yml header).

## Delete / replace

- **Replace** a bad post: dispatch with `delete_id: <old id>` plus the new
  `text` - the delete runs first, then the new post goes out. Deleting an
  already-gone id is a no-op, not an error.
- **Delete only**: the workflow has no delete-without-posting mode; ask the
  user to delete from the X app, or (with local X keys) run
  `node scripts/tweet.js --delete <id>`.

## Failure modes

- `X API 403` on quote → Free-tier restriction; switch to the URL-embed method.
- `Tweet is N chars (> 280)` → local raw-length guard; recheck weighted count,
  pass `force: "true"` if actually fine.
- `X API 401` → bad/expired credentials; verify with the `X Verify` workflow
  (`x-verify.yml`, reads nothing, posts nothing).
- `X API 403` on a plain post → duplicate content or app permission issue.
