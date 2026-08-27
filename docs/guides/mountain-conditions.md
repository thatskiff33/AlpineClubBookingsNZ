# Mountain Conditions

Audience: Operator

## What it is

The editor for the cached Whakapapa mountain-conditions payload that drives the
public Snow.nz conditions widget — road status, lifts, facilities, food & drink,
trails, and general conditions. Find it at **Admin → Setup & Configuration → Site
Appearance & Content → Mountain Conditions** (`/admin/mountain-conditions`). It
has no direct sidebar entry — open it from the **Mountain Conditions** card on
the Site Appearance & Content hub.

The page is gated by the **`skifieldConditions`** module (Admin → Modules),
which is on by default. Turning that module off hides both this page and the
public conditions widget. Mountain Conditions is edited under the **content**
permission area.

## When you'd use it

- The upstream Snow.nz feed is wrong or stale and you want to correct what
  visitors see.
- You want to hide a section (e.g. Lifts) from the public widget.
- You need to force a fresh pull from the upstream source.
- The upstream page structure changed and the scraper stopped picking up a
  section, so you need to point it at a new URL or adjust a selector.

## Step-by-step

### Refresh, curate, or edit the payload

1. Open **Mountain Conditions**. The **Whakapapa cache** panel shows the current
   state (**Auto refresh active**, **Last fetched**, **Frozen until**, **Last
   updated in DB**). Click **Update from upstream** to pull the latest feed
   immediately.

   ![Mountain Conditions showing the Whakapapa cache panel with the Update from upstream button, the Section visibility checkboxes (Road Status, Lifts, Facilities, Food & Drink, Mountain Conditions, Trails), the Raw JSON editor, and the Source & selectors card with the Report URL field, the collapsed Advanced element selectors section, and the Preview and Save configuration buttons](../images/admin/admin-mountain-conditions.png)

2. Under **Section visibility**, tick the articles that should appear on the
   public widget — **Road Status**, **Lifts**, **Facilities**, **Food & Drink**,
   **Mountain Conditions**, **Trails**. Unticked sections are hidden from
   visitors. Click **Save visibility**.
3. To edit the content directly, use the **Raw JSON** editor to change the stored
   payload (`roadStatus`, `lifts`, `facilities`, `foodAndDrink`, `conditions`,
   `trails`, and the `visibility` map), then click **Save**. **Saving freezes
   automatic upstream updates for 12 hours** so your edits are not overwritten.

   Each trail carries a `difficulty` of `Beginner`, `Intermediate`, `Advanced`,
   or `Expert`. On the public widget these render as the standard ski symbols —
   green circle (Beginner), blue square (Intermediate), black diamond
   (Advanced), red diamond (Expert) — with a matching key shown in the top-right
   of the Trails section.

### Point the scraper at a new URL or fix a selector

The upstream report is built with rotating style-name suffixes, so the scraper
matches on the stable parts of the page and does not need updating for a routine
upstream rebuild. When the page structure changes more deeply, use the
**Source & selectors** panel at the bottom of the page:

1. Set the **Report URL** the site scrapes. It must be an `https` URL on
   `whakapapa.com` or `snow.nz` — other hosts are rejected.
2. Under **Advanced: element selectors**, override individual selectors only if a
   section stops appearing. Leave a field blank to use the built-in default.
   One section is special: **Trails**. Whakapapa's 2026 UI update moved the
   trail lists behind collapsible panels whose content is not in the page at
   all (it is drawn in the browser), so when the selectors find no trails the
   scraper automatically reads the same `/api/report` data feed the panels
   draw from — no selector change needed, and the trail selectors resume
   working by themselves if the upstream page ever includes trails again.
3. Click **Preview** to fetch and parse with the current URL and selectors
   **without saving** — the parsed result is shown so you can confirm the
   sections populate. When it looks right, click **Save configuration**. The URL
   and overrides are stored separately from the cached data, so an upstream
   refresh never wipes them.

### Share selectors between sites (import / export)

The built-in default selectors are **seeded into the database** (via migration),
so every site starts with the complete set already stored — the code defaults
are only a fallback for a brand-new, un-migrated database.

Under **Advanced: element selectors**:

- **Export selectors** reads the stored Report URL and the **full** selector set
  from the database and downloads them as a JSON file.
- **Import selectors** loads such a file and **saves it straight to the
  database**, so another site's admin does not have to re-enter the values by
  hand. An off-allowlist URL in the file is ignored (the current URL is kept);
  unknown fields are dropped.

## Settings reference

| Setting                                                                                             | What it controls                                                  | Default                            | Notes / constraints                                          |
| --------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------- | ---------------------------------- | ------------------------------------------------------------ |
| Update from upstream                                                                                | Pulls the latest Snow.nz feed now                                 | —                                  | Refreshes immediately; does not freeze                       |
| Section visibility (Road Status / Lifts / Facilities / Food & Drink / Mountain Conditions / Trails) | Which articles show on the public widget                          | All on                             | Unticked sections are hidden from visitors                   |
| Raw JSON payload                                                                                    | The stored conditions content                                     | Upstream feed                      | Must be valid JSON; saving freezes auto-refresh for 12 hours |
| Report URL                                                                                          | The page the scraper fetches                                      | `https://www.whakapapa.com/report` | Must be https on whakapapa.com / snow.nz                     |
| Element selectors (Advanced)                                                                        | Per-section overrides used to locate content on the source page   | Built-in hash-agnostic defaults    | Blank = use default; test with **Preview** before saving     |
| Import / Export selectors (Advanced)                                                                | Transfer the URL + full selector set between sites as a JSON file | Defaults seeded into the DB        | Export reads the DB; Import writes to the DB.                |
| `skifieldConditions` module                                                                         | Whether this page and the public widget exist at all              | On                                 | Toggled at **Admin → Modules**; off hides both               |

## Troubleshooting

| Symptom                                           | Likely cause                                                 | Fix                                                                                                            |
| ------------------------------------------------- | ------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------- |
| The page 404s or the card is missing              | The `skifieldConditions` module is off                       | Enable it at **Admin → Modules**                                                                               |
| My edits were overwritten                         | Auto-refresh replaced them                                   | Save via the Raw JSON editor — that freezes upstream updates for 12 hours                                      |
| A section still shows publicly after unticking    | Visibility wasn't saved                                      | Click **Save visibility** after changing the checkboxes                                                        |
| A whole section is empty after an upstream change | The scraper can't locate it                                  | Use **Preview** in **Source & selectors** to test, override the affected selector, then **Save configuration** |
| The report URL is rejected                        | It's not https or not on whakapapa.com / snow.nz             | Enter an https URL on an allowed host                                                                          |
| Save is rejected                                  | The Raw JSON is malformed                                    | Fix the JSON syntax and save again                                                                             |
| Everything is read-only                           | Your admin role can view but not edit under the content area | Ask a full admin for content edit access                                                                       |

## Appearance: the "Whakapapa Conditions" panel skin (Raw CSS)

The public conditions widget (`SkifieldWhakapapaWidget`) ships with stable
`wcx-*` class hooks on the panel, its header, the at-a-glance summary row, each
section and title, the facility/trail cards, and the conditions table. That lets
you restyle the panel from **Admin → Setup & Configuration → Site Appearance &
Content → [Site Style](site-style.md) → Raw CSS** with no code change or deploy.

Below is the club's house **"Option A — editorial light"** skin: a white card
lifted off the snow ground, a teal keyline and section underlines, an eyebrow and
a "Live" cue, a four-stat summary strip, and a cleaner conditions table. Paste it
into the **Raw CSS** field and save.

Two things worth knowing before you paste it:

- **It needs the `wcx-*` hooks to be present**, which means the widget code that
  emits them must be deployed. Pasting it earlier is harmless — the rules that
  restyle existing structure apply immediately and the new-structure rules simply
  find nothing yet.
- **It uses explicit, self-consistent colours** (not the site theme variables) and
  scopes everything under `#conditions` with `!important`, so the panel stays
  dark-text-on-light and readable **regardless of the club's configured palette**.
  Tweak the palette in the first `#conditions { --w-* }` block to taste.

```css
/* ============================================================================
   Whakapapa Conditions panel — Option A "Editorial light" skin
   Paste into: Admin -> Setup & Configuration -> Site Appearance & Content
               -> Site Style -> Raw CSS
   ----------------------------------------------------------------------------
   Uses EXPLICIT, self-consistent colours instead of the site theme variables,
   so the panel is always dark-text-on-light-surface and readable no matter what
   palette the club has configured. Everything is scoped under #conditions and
   uses !important on colours/backgrounds so it reliably wins. Tweak the palette
   in the first block to taste.
   ============================================================================ */

/* Neutralise EVERY themed border inside the panel to the light line colour, so
   a dark club --border can never show through as a black line (e.g. between the
   Mountain Conditions rows). */
#conditions .border-border,
#conditions [class*="border-border"] { border-color: var(--w-line) !important; }

#conditions {
  --w-paper:   #ffffff;   /* panel + summary tiles                     */
  --w-snow:    #f5f8f6;   /* nested chips / trails / road box          */
  --w-mist:    #e9ebe9;   /* table header + zebra                      */
  --w-line:    #d8ded9;   /* borders / dividers                        */
  --w-ink:     #1c211d;   /* body text                                 */
  --w-charcoal:#21362b;   /* headings / key figures                    */
  --w-muted:   #566058;   /* muted text (AA on white and snow)         */
  --w-teal:    #57b3ab;   /* keyline / underline / live ring (accents) */
  --w-teal-ink:#2b7a72;   /* accent used AS TEXT (passes contrast)     */
  --w-ok:   #1f7a3d;  --w-ok-bg:   #e4f3e9;
  --w-warn: #8a5a10;  --w-warn-bg: #f7eed7;
  --w-bad:  #b4271f;  --w-bad-bg:  #f7e0de;
  --w-soon: #566058;  --w-soon-bg: #eceeec;
}

/* ---- the panel: a white card lifted off the page ------------------------ */
#conditions.wcx-panel {
  background: var(--w-paper) !important;
  border: 1px solid var(--w-line) !important;
  border-radius: 14px;
  box-shadow: 0 1px 2px rgba(23,35,28,.06), 0 10px 26px -14px rgba(23,35,28,.22);
  padding: 0 !important;
  overflow: hidden;
}

/* ---- header ------------------------------------------------------------- */
#conditions .wcx-head {
  position: relative;
  align-items: flex-end;
  gap: 12px 20px;
  margin: 0;
  padding: 20px 22px 16px;
  border-bottom: 1px solid var(--w-line);
}
#conditions .wcx-head::before {
  content: ""; position: absolute; left: 0; top: 0; bottom: 0;
  width: 4px; background: var(--w-teal);
}
#conditions .wcx-eyebrow {
  margin: 0 0 3px;
  color: var(--w-teal-ink) !important;
  letter-spacing: .14em; font-size: 11px;
}
#conditions .wcx-title {
  margin: 0;
  color: var(--w-charcoal) !important;
  font-size: clamp(20px, 3.6vw, 26px);
  line-height: 1.06; letter-spacing: -.03em;
}
#conditions .wcx-updated { margin-top: 4px; font-size: 12.5px; color: var(--w-muted) !important; }
#conditions .wcx-head-meta { flex-direction: column; align-items: flex-end; gap: 6px; }

/* live cue */
#conditions .wcx-live {
  color: var(--w-ok) !important;
  letter-spacing: .1em; text-transform: uppercase; font-size: 11px;
}
#conditions .wcx-live-dot { background-color: var(--w-ok) !important; animation: wcx-pulse 2.4s ease-out infinite; }
@keyframes wcx-pulse {
  0%   { box-shadow: 0 0 0 0 rgba(31,122,61,.5); }
  70%  { box-shadow: 0 0 0 7px rgba(31,122,61,0); }
  100% { box-shadow: 0 0 0 0 rgba(31,122,61,0); }
}
@media (prefers-reduced-motion: reduce) { #conditions .wcx-live-dot { animation: none; } }

/* ---- body spacing ------------------------------------------------------- */
#conditions .wcx-summary,
#conditions > .grid,
#conditions > #whakapapa-mountain-conditions { margin-left: 22px; margin-right: 22px; }
#conditions > #whakapapa-mountain-conditions { margin-bottom: 22px; }
#conditions .wcx-summary { margin-top: 18px; }

/* ---- summary strip: all four stats on ONE line, white tiles + hairlines -- */
#conditions .wcx-summary {
  grid-template-columns: repeat(4, 1fr) !important;   /* one line, always      */
  gap: 1px;
  background: var(--w-line);
  border: 1px solid var(--w-line);
  border-radius: 12px;
  overflow: hidden;
}
#conditions .wcx-stat {
  background: var(--w-paper) !important;
  border: 0 !important; border-radius: 0;
  padding: 13px 15px;
}
#conditions .wcx-stat-label { color: var(--w-muted) !important; letter-spacing: .08em; margin-bottom: 2px; }
#conditions .wcx-stat-value {
  color: var(--w-charcoal) !important;
  font-size: 22px; line-height: 1.1; letter-spacing: -.02em;
  font-variant-numeric: tabular-nums;
}
#conditions .wcx-stat-value.wcx-tone-ok     { color: var(--w-ok) !important; }
#conditions .wcx-stat-value.wcx-tone-accent { color: var(--w-teal-ink) !important; }
#conditions .wcx-stat-sub { color: var(--w-muted) !important; margin-top: 1px; }

/* ---- grouped sections: transparent, with a teal-underlined title -------- */
#conditions .wcx-group {
  background: transparent !important;
  border: 0 !important;
  border-radius: 0;
  padding: 4px 0 0 !important;
}
#conditions .wcx-group-title {
  display: inline-block;
  margin: 0 0 12px;
  padding-bottom: 7px;
  border-bottom: 2px solid var(--w-teal);
  color: var(--w-charcoal) !important;
  font-size: 13px; letter-spacing: -.01em; text-transform: uppercase;
}

/* nested cards (facility items, trails) sit on snow */
#conditions .wcx-item,
#conditions .wcx-trail {
  background: var(--w-snow) !important;
  border: 1px solid var(--w-line) !important;
  border-radius: 10px;
  padding: 10px 12px;
}
#conditions .conditions-trail-name,
#conditions [class$="-status-description"] { color: var(--w-ink) !important; font-size: 13.5px; }
#conditions .conditions-trail-details { color: var(--w-muted) !important; }
#conditions #whakapapa-trails h4 { color: var(--w-muted) !important; }

/* road box on snow */
#conditions #whakapapa-road-status > div {
  background: var(--w-snow);
  border: 1px solid var(--w-line);
  border-radius: 10px;
  padding: 12px 14px;
}
#conditions #whakapapa-road-status dt { color: var(--w-muted) !important; }
#conditions #whakapapa-road-status dd,
#conditions #whakapapa-road-status .text-muted-foreground { color: var(--w-ink) !important; }

/* ---- status pills: explicit, readable semantic colours ----------------- */
#conditions .bg-success-3 { background-color: var(--w-ok-bg)  !important; color: var(--w-ok)  !important; }
#conditions .bg-danger-3  { background-color: var(--w-bad-bg) !important; color: var(--w-bad) !important; }
#conditions .bg-warning-3 { background-color: var(--w-warn-bg)!important; color: var(--w-warn)!important; }
#conditions .bg-muted     { background-color: var(--w-soon-bg)!important; color: var(--w-soon)!important; }
#conditions .conditions-trail-status {
  width: auto; align-self: flex-start;
  padding: 3px 10px; font-size: 11px; font-weight: 700;
}

/* ---- conditions table --------------------------------------------------- */
#conditions .wcx-conditions-table { font-size: 13.5px; }
#conditions .wcx-conditions-table thead th {
  padding: 11px 14px;
  background: var(--w-mist) !important;
  color: var(--w-muted) !important;
  border-bottom: 1px solid var(--w-line);
  letter-spacing: .06em;
}
#conditions .wcx-conditions-table tr { border-color: var(--w-line) !important; }
#conditions .wcx-conditions-table td {
  padding: 11px 14px;
  color: var(--w-ink) !important;
  font-variant-numeric: tabular-nums;
  border-top: 1px solid var(--w-line) !important;
}
/* explicit row fills so a dark theme surface can never show through */
#conditions .wcx-conditions-table tbody tr:nth-child(odd) td  { background: var(--w-paper) !important; }
#conditions .wcx-conditions-table tbody tr:nth-child(even) td { background: var(--w-snow) !important; }
#conditions .wcx-conditions-table td:first-child { color: var(--w-charcoal) !important; font-weight: 600; }
#conditions .wcx-conditions-table td:nth-child(5) { color: var(--w-teal-ink) !important; font-weight: 700; }
```

The summary strip is set to four columns. On very narrow phones that is tight; if
you prefer a 2×2 grid below a width, add a media query overriding
`#conditions .wcx-summary { grid-template-columns: repeat(2, 1fr) !important; }`.

## Related links

- Back to the [documentation hub](../README.md).
- Parent hub: [Site Appearance & Content](appearance.md).
- Sibling guides: [Site Banners](site-banners.md),
  [Page Content](page-content.md), [Site Style](site-style.md) (the Raw CSS
  field this skin is pasted into).
- Reference: the module switchboard in [Modules](modules.md).
