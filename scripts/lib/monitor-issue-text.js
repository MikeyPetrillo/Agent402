// The fixed text of an issue a scheduled check opens, comments on or closes.
//
// A public issue says that a scheduled check needs review and links the run.
// Which reading, route, model or upstream it was stays in the run log (or, for
// the status Worker, the Worker's own log): never in a title or a body.
// scripts/test-monitor-issue-wording.js holds every workflow and the status
// Worker to this text.
export const TITLE_PREFIX = "Scheduled check needs review: ";
// "<prefix><check name>", an optional letter for a second issue of one check,
// and an optional date or month for a check that files one issue per period.
export const TITLE_RE = /^Scheduled check needs review: [a-z][a-z0-9]*(?:-[a-z0-9]+)*(?: \([a-z]\))?(?: \((?:\$[A-Z_]+|\$\(date -u \+%[A-Za-z%-]+\))\))?$/;
export const RUN_LINK = "$GITHUB_SERVER_URL/$GITHUB_REPOSITORY/actions/runs/$GITHUB_RUN_ID";
export const OPEN_BODY = `A scheduled check reported a result that needs review. Run: ${RUN_LINK}. This issue closes when the check next passes, or by hand after review.`;
export const STILL_BODY = `Still needs review at $(date -u +%FT%TZ). Run: ${RUN_LINK}`;
export const CLOSE_BODY = `Closed by the scheduled check at $(date -u +%FT%TZ). Run: ${RUN_LINK}`;
// A comment may end with one state mark the next run reads back: an opaque
// keyed mark, or one fixed word.
export const STILL_SUFFIXES = Object.freeze([" reasons mark $MARK", " state: unmarked", " state: clean", " state: again"]);
// Names that never appear in a check name.
export const NAMES_OUT = Object.freeze(["openrouter", "payai", "cdp", "coinbase", "brave", "redis", "postgres", "cloudflare", "openclaw", "stripe", "railway", "bazaar", "elevenlabs", "openai"]);
// The same texts as a step posts them (the shell has expanded the run link and
// the time), for suites that run a step against a stub `gh`.
export const OPEN_BODY_RE = /^A scheduled check reported a result that needs review\. Run: \S*\. This issue closes when the check next passes, or by hand after review\.$/;
export const STILL_BODY_RE = /^Still needs review at \d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z\. Run: \S*(?: reasons mark [0-9a-f]{24}| state: (?:unmarked|clean|again))?$/;
export const CLOSE_BODY_RE = /^Closed by the scheduled check at \d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z\. Run: \S*$/;
// A workflow files a check's issue through one script, which comments on the
// open one, reopens one closed within the reopen window, or files a new one
// (scripts/check-issue.js); no workflow calls `gh issue create` itself.
export const OPENER = "node scripts/check-issue.js";
export const OPENS_ISSUE_RE = /node scripts\/check-issue\.js --title /;
