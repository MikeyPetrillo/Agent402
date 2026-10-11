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
    display: "'Instrument Serif', 'Instrument Serif Fallback', Georgia, 'Times New Roman', serif"   # --font-display, h1 at --fs-4xl and up only
  weights: [300, 400, 500, 600, 700, 800]  # Instrument Serif ships 400 only: never set it heavier
  headings:                                # one weight per level, enforced by the guard
    h1-display: { family: --font-display, weight: 400, tracking: "-0.01em", sizes: [4xl, 5xl, hero] }
    h1: { family: --font-body, weight: 800, sizes: [2xl, 3xl] }
    h2: { family: --font-body, weight: 700 }
    h3: { family: --font-body, weight: 600 }
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
    code-inline: .88em   # inline code relative to its paragraph
  line-height: { tight: 0.98, heading: 1.02, body: 1.55, dense: 1.4 }
  tracking: { display: "-0.03em", heading: "-0.02em", eyebrow: "0.12em to 0.14em uppercase mono" }
spacing:          # px; the steps in use, in order of frequency
  scale: [4, 8, 12, 14, 16, 18, 22, 30, 56]
  page-gutter: 30px desktop, 16px phone
  section: 56px between sections
  container: 1180px
radius:           # stance: square-ish surfaces, one expressive shape for the money action
  radius: 4px     # --radius: every surface, card, panel, input, chip, tab, secondary button
  pill: 999px     # --radius-pill: the primary button only
  dot: 50%        # status dots, nothing else
  none: 0         # tables, bars, the bottom of a receipt-edge surface
elevation:
  signature: "0 18px 40px rgba(17,19,21,.10)"   # --shadow-lg (dark: rgba(0,0,0,.35)); one shadow, on feature cards only
  button: --btn-shadow
surfaces:
  milled: { bg: --milled-bg, border: --milled-border, note: "light brushed-metal card; dark theme gets a graphite version" }
  obsidian: { bg: --obsidian-bg, border: --obsidian-border, text: --on-panel*, note: "dark in both themes" }
components:
  button-primary: { class: "btn btn-primary", bg: --btn-bg, fg: --btn-fg, radius: pill, shadow: --btn-shadow, font: "Geist 500 md", use: "the one main action of a view: buy, subscribe, add to your agent, list your API" }
  button-secondary: { class: "btn btn-secondary", bg: transparent, border: 1px --dash, fg: --ink, radius: 4px, font: "Geist 500 md", use: "everything else: docs, quickstart, playground, browse, submit a form" }
  button-on-panel: { class: "on-panel (on the wrapper or the button)", primary: "--accent-lit on --on-accent-lit", secondary: "--on-panel text, --panel-rule-2 border" }
  button-small: { class: btn-sm, font: "sm", padding: "9px 14px" }
  card: { bg: --card, border: 1px --hairline, radius: 4px, padding: 18-24px }
  receipt-edge: { class: receipt, what: "half-circle notches in --receipt-ground (default --paper) along the bottom edge plus a dashed tear line 13px above it; gradients only", where: "home live panel, report product cards on /reports, the pricing pair; nowhere else", needs: ">= 20px bottom padding" }
  table: { head: "2xs mono uppercase --faint", body: "md", rule: 1px --hairline, zebra: --card-zebra, numbers: tabular }
  chip: { bg: --chip-bg, border: 1px --hairline, radius: 4px, size: sm }
  nav: { bg: --nav-bg (glass), link: "md --muted, active --ink with 1.5px underline", cta: button-primary, wrap: never }
  code-block: { bg: --panel, fg: --on-panel, comment: --on-panel-faint, string: --accent-lit, number: --on-panel-warn, keyword: --on-panel-violet, size: xs-sm mono }
  status-badge: { ok: --ok, degraded: --warn, failed: --bad, unknown: --dash; on a panel use --accent-lit / --on-panel-warn / --on-panel-bad }
---

# Agent402 design rules

This file is the contract for every page the server renders. The values above are the
values in `src/ledger-chrome.js`; when one changes, change both in the same commit.
`scripts/test-design-tokens.js` fails CI when a page module uses a raw hex color or a font
size off the scale, and when a radius, a heading weight or the display serif leaves the
rules below.

## Color
- **One saturated accent.** `--accent` is the only brand color. It marks the primary path:
  the selected tab, the price, the live dot, a link the reader should follow. Never use it to
  mean "failed", "warning" or "error"; those are `--bad` and `--warn`.
- **Secondary actions carry no color.** A secondary button is ink on transparent with a
  hairline border. If two buttons sit together, at most one is filled.

## Buttons
- Two kinds only, both from the shared classes in `ledger-chrome.js`: `.btn.btn-primary`
  (pill, filled) and `.btn.btn-secondary` (4px, outlined, no color). No page styles its own
  button, and button labels are sentence case Geist, not uppercase mono.
- **Primary is the one main action of a view**: buy, subscribe, add to your agent (pay per
  call), or list your API (get paid) in a band that exists to sign up sellers. One primary
  per view. When a view offers a buyer path and a seller path side by side as equal choices,
  both are secondary. Docs, quickstart, playground, browse and navigation are secondary.
- On an obsidian panel add `.on-panel`: the primary turns `--accent-lit`, the secondary
  takes panel ink and rules.
- **Status is semantic.** `--ok`, `--warn`, `--bad`, and `--dash` for "no data". Never use the
  accent green as a status color: users read it as "fine".
- **Panels never borrow page tokens.** Inside an obsidian panel (`--panel`, `--obsidian-bg`)
  text is `--on-panel*` and rules are `--panel-rule*`, because the panel is dark in both
  themes. Page tokens (`--ink`, `--muted`, `--hairline`, `--footer-bg`) on a panel are
  invisible in one theme.
- New color: add a token to both theme blocks in `ledger-chrome.js` and to this file. A page
  never defines its own palette. `rgba()` overlays and `color-mix()` over a token are fine.

## Type
- Three families, each with one job: Geist for language, Geist Mono for things that are
  literal, Instrument Serif (`--font-display`) for the largest headline on a page.
- **The serif is for h1 at `--fs-4xl` and up only**, at weight 400 with -0.01em tracking.
  Smaller h1s, every h2 and h3, and all UI stay Geist. The guard rejects the serif anywhere
  but an h1.
- **Mono means literal**: routes, commands, prices in tables, hashes, addresses, numbers in a
  ledger, eyebrows. Prose is never mono, even short notes under a table.
- **Numbers are tabular**: any column or stat of figures uses
  `font-variant-numeric: tabular-nums` (Geist Mono is already fixed-width).
- Use only `var(--fs-*)`. Body text is `--fs-base`; a lede is `--fs-lg`; inner-page h1 is
  `--fs-3xl` to `--fs-5xl` (`--fs-2xl` on a phone for a template h1 that carries a catalog
  name: tool, skill pack, guide).
- **One weight per heading level**: display h1 400 (serif), other h1 800, h2 700, h3 600.
  The guard reads inline `<hN style>` and any CSS rule whose selector names the level.
- Eyebrows: `--fs-2xs` mono, uppercase, 0.12em tracking, `--faint`.

## Layout
- Container 1180px, 30px gutter (16px on phones). Sections 56px apart.
- Nothing scrolls the page sideways at 390px; wide tables scroll inside their own wrapper.
- Radius: `var(--radius)` (4px) on every surface and control, `var(--radius-pill)` on the
  primary button alone, 50% for dots. The guard rejects any other radius.

## Wrap
Measured, not eyeballed: `scripts/test-wrap-quality.js` lays out every page in the sitemap
plus every `/docs/<wiki page>` in Chromium at 1440 and 400 px, reads each block's line boxes
and fails on any of these. CI runs every hand-written page and a fixed sample of 25 per
generated family (tool, category, skill pack and report pages, longest titles and code
names first); `WRAP_ALL=1` runs all of them.
- **No rag**: a block of 2+ lines ends on a line of at least 30% of its widest line and at
  least 3 words (a heading of 5 words or fewer may split 2 + 2 or 3 + 2; punctuation alone
  is not a word). Widow control in `assets/js/site-chrome.js` measures each block's tail
  and binds its last words to about a third of its measure (two words that fit stay
  together; a short cell of a scrolling table stays whole; a URL or code token too wide to
  join a short tail joins it and breaks at its own seams); if a block still rags, the copy
  or the measure is wrong, so shorten the words or widen the column. Text rendered after
  load calls `window.a402BindWidows(root)`.
- **Code keeps whole words**: a code name in prose or a table cell breaks only at its own
  punctuation or a camelCase seam (site-chrome.js adds a `<wbr>` there), never between two
  letters. Inline code is `overflow-wrap: break-word`, never `anywhere` (that collapses a
  table column to one letter); only an unbroken hash or address may split. A short name in
  a table cell stays on one line and a wide table scrolls in its own wrapper.
- **A page's own title is whole**: an h1 wraps with `text-wrap: balance`, never a
  line clamp or an ellipsis; a long catalog name steps down to `--fs-2xl` on a phone.
  Breadcrumbs (`.ml-crumb`) keep each link whole and drop the current page's name on a
  phone, where the h1 below repeats it.
- **A label never breaks inside itself**: small mono text, uppercase letter-spaced labels,
  chips, buttons, kickers, stat labels and each link of a link row stay on one line. A run
  of tags is `.ml-meta` (or `sectionMeta([...])`): one `<span>` per tag, wrapping between
  tags. Shorten a label that does not fit; never shrink it below the type scale or clip it.
- **No stray item**: a row of links or chips does not end on one item under a row of 3+.
  Long rows become a two-column list or a sideways strip at phone width (`.ml-strip` on any
  chip row; a grid column holding one is `minmax(0,1fr)` so the strip scrolls in place).
- **Nothing past the viewport**: a whole label wider than its column is a finding too.
- Prose takes its section's width up to a reading measure: `max-width: 76ch`
  (`.ml-measure`), 64ch inside a CTA panel. Section meta goes under its heading.
- **Side-by-side cards read as a pair**: the same parts in the same order (kicker, heading,
  one short paragraph, `.ml-ticks` list, code, action row pinned to the bottom with
  `margin-top: auto`). A section of claims is a row list (heading left, one sentence and at
  most two links right, the rest behind an expander), not a grid of squeezed cards.
- A list section (FAQ) sits in the 1180px container, left-aligned, its rows capped at 900px.

## Signature: the receipt edge
- A paid call returns a receipt, so the surfaces that sell or prove one end in a perforated
  tear-off: add `class="receipt"`. It is used on exactly three surfaces (the home live panel,
  the report product cards, the pricing pair). Do not add it to tables, nav, or anything
  repeated more than a dozen times on a page. It replaced the outlined "402" watermark.

## Voice (from CLAUDE.md)
- First-party and affirmative; no competitor names; no em dashes.
- Say **"500+ tools"** on marketing and static surfaces; exact counts only where derived at
  runtime.
- Model-backed tools are labeled as model-backed. Any claim about determinism or about models
  being absent is scoped to the utility tools it is true of (scripts/test-copy-absolutes.js
  lists the phrasings it refuses).
- Copy that offers something reads the switch that sells it.

## Allowed literals (the guard's allowlist)
- Email HTML (`src/email.js`, `followups.js`, `free-alerts.js`, and lines
  marked `design-tokens: literal`): inline styles with palette values, scale px, and radii of
  0, 50%, 4px or 999px (the pill only on the money button).
- Print CSS, the standalone fallback page in `server.js`, the public SVG badges: palette
  literals inside a `design-tokens: literal-start` region.
- Rasterized SVG (`og-cards.js`, `aifi-card.js`, the brand mark, server.js `BRAND`) and the
  revenue chart's categorical series: `design-tokens: off-start` regions, each with a reason.
