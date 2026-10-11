---
name: Agent402 Machine Ledger
version: 1
source: src/ledger-chrome.js   # LEDGER_CSS: the only place a color or size is defined
guard: scripts/test-design-tokens.js
themes:
  default: light               # bare :root; dark is :root[data-theme="dark"], set by /js/site-chrome.js
colors:
  # token: { light, dark }  (both themes define every token; test-theme.js enforces parity)
  page:
    paper:        { light: "#F3F4F5", dark: "#0B0C0E" }   # page ground
    card:         { light: "#FFFFFF", dark: "#141619" }   # raised surface
    card-zebra:   { light: "#EDEFF1", dark: "#1A1D21" }   # alternate row, hover
    footer-bg:    { light: "#E8EAEC", dark: "#0E1012" }
    ink:          { light: "#111315", dark: "#E9EAEC" }   # primary text
    ink-panel:    { light: "#0C0D0F", dark: "#F3F4F5" }   # strongest ink (inverts)
    muted:        { light: "#3A3F45", dark: "#B3B9C0" }   # secondary text
    faint:        { light: "#626970", dark: "#8B929A" }   # tertiary text, AA at 11px+
    hairline:     { light: "#D9DDE1", dark: "#24282C" }   # 1px rules, card borders
    dash:         { light: "#C3C9CF", dark: "#353B41" }   # dashed/dotted rules, empty bars
  accent:
    accent:       { light: "#0F5E43", dark: "#34A877" }   # the ONE saturated color
    accent-lit:   { light: "#9EF0B0", dark: "#9EF0B0" }   # accent on dark panels only
    on-accent:    { light: "#FFFFFF", dark: "#0B0C0E" }
    on-accent-lit:{ light: "#0B0C0E", dark: "#0B0C0E" }
  status:
    ok:           { light: "#23774F", dark: "#6FCF97" }
    warn:         { light: "#8A5A12", dark: "#E0A040" }
    bad:          { light: "#B4402F", dark: "#FF8A7A" }
  panel:          # obsidian panels are dark in BOTH themes, so these never flip
    panel:            { light: "#0C0D0F", dark: "#16191D" }
    panel-rule:       { light: "#24282C", dark: "#2C3136" }
    panel-rule-2:     { light: "#353B41", dark: "#3A4148" }
    on-panel:         "#E9EAEC"
    on-panel-soft:    "#C9CED3"
    on-panel-muted:   "#B3B9C0"
    on-panel-dim:     "#9AA1A9"
    on-panel-faint:   "#868D95"
    on-panel-bad:     "#FF8A7A"
    on-panel-warn:    "#E0A040"
    on-panel-violet:  "#A78BFA"
    on-panel-mark:    "#ffffff10"   # the outlined 402 watermark stroke
  terminal:       # dense market surfaces (--t-*), AA at 11-12px, pinned by test-terminal-tokens.js
    t-bg:   { light: "#EEF2F6", dark: "#0A0E14" }
    t-ink:  { light: "#0E1721", dark: "#DCE4EE" }
    t-cyan: { light: "#0E6F78", dark: "#4FD1D9" }
    t-violet: { light: "#5B3FBF", dark: "#A78BFA" }
    t-up:   { light: "#0F7A54", dark: "#6EE7A8" }
    t-down: { light: "#B4402F", dark: "#FF8A7A" }
    t-warn: { light: "#8A5A12", dark: "#F5C97B" }
typography:
  families:
    body: "'Geist', 'Geist Fallback', system-ui, sans-serif"          # --font-body
    mono: "'Geist Mono', 'Geist Mono Fallback', monospace"            # --font-mono
  weights: [400, 500, 600, 700, 800]       # 900 only on the 402 watermark
  scale:                                   # --fs-*; nothing between two steps
    2xs: 11px     # mono eyebrows, table heads, legal fine print
    xs: 12px      # mono meta, captions, code in dense tables
    sm: 13px      # secondary UI text, mono links, chips
    md: 14px      # table body, form controls, nav
    base: 15px    # running text
    lg: 17px      # lede, card titles
    xl: 22px      # h3, panel titles
    2xl: 28px     # h2 in dense pages
    3xl: 38px     # page h1 on inner pages, section h2, mobile h1
    4xl: 48px     # marketing h1
    5xl: 58px     # hero-scale h1 and big numbers
    hero: 72px    # home hero only; 404 code
    mark: 220px   # decorative outlined watermark, never text to read
    code-inline: .88em   # inline code relative to its paragraph
  line-height: { tight: 0.98, heading: 1.02, body: 1.55, dense: 1.4 }
  tracking: { display: "-0.03em", heading: "-0.02em", eyebrow: "0.12em to 0.14em uppercase mono" }
spacing:          # px; the steps in use, in order of frequency
  scale: [4, 8, 12, 14, 16, 18, 22, 30, 56]
  page-gutter: 30px desktop, 16px phone
  section: 56px between sections
  container: 1180px
radius:           # current stance, documented as-is (see proposals before changing it)
  xs: 2px         # status cards, data panels
  sm: 8px         # inputs, chips, menu buttons
  md: 12px        # small cards
  lg: 18px        # milled / obsidian feature cards
  pill: 999px     # primary and secondary buttons, nav CTA, tabs
elevation:
  signature: "0 18px 40px rgba(17,19,21,.10)"   # --shadow-lg (dark: rgba(0,0,0,.35)); one shadow, on feature cards only
  button: --btn-shadow
surfaces:
  milled: { bg: --milled-bg, border: --milled-border, note: "light brushed-metal card; dark theme gets a graphite version" }
  obsidian: { bg: --obsidian-bg, border: --obsidian-border, text: --on-panel*, note: "dark in both themes" }
components:
  button-primary: { bg: --btn-bg, fg: --btn-fg, radius: pill, shadow: --btn-shadow, size: sm-md, weight: 500 }
  button-secondary: { bg: transparent, border: 1px --hairline, fg: --ink, radius: pill }
  button-on-panel: { bg: --accent-lit, fg: --on-accent-lit, radius: pill }
  card: { bg: --card, border: 1px --hairline, radius: xs or lg (feature), padding: 18-24px }
  table: { head: "2xs mono uppercase --faint", body: "md", rule: 1px --hairline, zebra: --card-zebra, numbers: tabular }
  chip: { bg: --chip-bg, border: 1px --hairline, radius: pill, size: sm }
  nav: { bg: --nav-bg (glass), link: "md --muted, active --ink with 1.5px underline", cta: button-primary, wrap: never }
  code-block: { bg: --panel, fg: --on-panel, comment: --on-panel-faint, string: --accent-lit, number: --on-panel-warn, keyword: --on-panel-violet, size: xs-sm mono }
  status-badge: { ok: --ok, degraded: --warn, failed: --bad, unknown: --dash; on a panel use --accent-lit / --on-panel-warn / --on-panel-bad }
---

# Agent402 design rules

This file is the contract for every page the server renders. The values above are the
values in `src/ledger-chrome.js`; when one changes, change both in the same commit.
`scripts/test-design-tokens.js` fails CI when a page module uses a raw hex color or a font
size off the scale.

## Color
- **One saturated accent.** `--accent` is the only brand color. It marks the primary path:
  the selected tab, the price, the live dot, a link the reader should follow. Never use it to
  mean "failed", "warning" or "error"; those are `--bad` and `--warn`.
- **Secondary actions carry no color.** A secondary button is ink on transparent with a
  hairline border. If two buttons sit together, at most one is filled.
- **Status is semantic.** `--ok`, `--warn`, `--bad`, and `--dash` for "no data". Never use the
  accent green as a status color: users read it as "fine".
- **Panels never borrow page tokens.** Inside an obsidian panel (`--panel`, `--obsidian-bg`)
  text is `--on-panel*` and rules are `--panel-rule*`, because the panel is dark in both
  themes. Page tokens (`--ink`, `--muted`, `--hairline`, `--footer-bg`) on a panel are
  invisible in one theme.
- New color: add a token to both theme blocks in `ledger-chrome.js` and to this file. A page
  never defines its own palette. `rgba()` overlays and `color-mix()` over a token are fine.

## Type
- Two families only: Geist for language, Geist Mono for things that are literal.
- **Mono means literal**: routes, commands, prices in tables, hashes, addresses, numbers in a
  ledger, eyebrows. Prose is never mono, even short notes under a table.
- **Numbers are tabular**: any column or stat of figures uses
  `font-variant-numeric: tabular-nums` (Geist Mono is already fixed-width).
- Use only `var(--fs-*)`. Body text is `--fs-base`; a lede is `--fs-lg`; inner-page h1 is
  `--fs-3xl` to `--fs-5xl`. Headings use weight 700 or 800 with negative tracking; one weight
  per heading level across the site.
- Eyebrows: `--fs-2xs` mono, uppercase, 0.12em tracking, `--faint`.

## Layout
- Container 1180px, 30px gutter (16px on phones). Sections 56px apart.
- Nothing scrolls the page sideways at 390px; wide tables scroll inside their own wrapper.
- Radius follows the stance in the front matter; do not introduce a new radius value.

## Voice (from CLAUDE.md)
- First-party and affirmative; no competitor names; no em dashes.
- Say **"500+ tools"** on marketing and static surfaces; exact counts only where derived at
  runtime.
- Model-backed tools are labeled as model-backed. Any claim about determinism or about models
  being absent is scoped to the utility tools it is true of (scripts/test-copy-absolutes.js
  lists the phrasings it refuses).
- Copy that offers something reads the switch that sells it.

## Allowed literals (the guard's allowlist)
- Email HTML (`src/email.js`, `followups.js`, `free-alerts.js`, `wallet-digest.js`, and lines
  marked `design-tokens: literal`): inline styles with palette values and scale px only.
- Print CSS, the standalone fallback page in `server.js`, the public SVG badges: palette
  literals inside a `design-tokens: literal-start` region.
- Rasterized SVG (`og-cards.js`, `aifi-card.js`, the brand mark, server.js `BRAND`) and the
  revenue chart's categorical series: `design-tokens: off-start` regions, each with a reason.
