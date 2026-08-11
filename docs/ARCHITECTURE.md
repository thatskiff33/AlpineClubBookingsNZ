# Architecture

AlpineClubBookingsNZ is a full-stack TypeScript monolith for club booking and membership
operations. It is built around Next.js App Router route handlers,
Prisma/PostgreSQL, Stripe, Xero, AWS SES, cron jobs, and Docker Compose
deployment.

PageContent embeds use one server-only registry and renderer across home,
code-backed, catch-all, and database-backed 404 routes. Authoritative fee and
policy loaders return narrow display view models only. Default-false persisted
visibility gates and exact active-lodge lookup prevent accidental publication,
cross-lodge fallback, and leakage of provider or internal configuration fields.

## Runtime Shape

```text
Browser
  |
  v
Caddy reverse proxy
  |
  v
Next.js app container
  |
  +-- PostgreSQL 16
  +-- Stripe API and webhooks
  +-- Xero API and webhooks
  +-- AWS SES SMTP and SNS feedback
  +-- Sentry and structured logs
```

The production Compose model runs:

- `caddy` for HTTP/HTTPS routing
- `app` as the cron leader and warm fallback upstream
- `app_blue` and `app_green` as web-only blue/green slots
- `postgres` as the database
- `migrate` as an explicit Prisma migration runner

The same runtime shape as a diagram (the `app` container is the cron leader and
warm fallback; `app_blue`/`app_green` are web-only slots that disable cron):

```mermaid
flowchart TD
    Browser["Browser"] --> Caddy["Caddy reverse proxy"]
    Caddy --> AppBlue["app_blue (web only)"]
    Caddy --> AppGreen["app_green (web only)"]
    Caddy --> App["app (cron leader + warm fallback)"]
    AppBlue --> PG[("PostgreSQL 16")]
    AppGreen --> PG
    App --> PG
    App -->|cron leader only| Cron["Scheduled jobs"]
    App --> Stripe["Stripe API + webhooks"]
    App --> Xero["Xero API + webhooks"]
    App --> SES["AWS SES SMTP + SNS feedback"]
    App --> Obs["Sentry + structured logs"]
    Migrate["migrate (explicit Prisma runner)"] --> PG
```

## Project Structure

```text
prisma/
  schema.prisma                 database schema
  migrations/                   deployable migration history
  seed.ts                       local/staging seed data
  demo-seed.ts                  destructive local-only showcase seed data
src/
  app/                          Next.js App Router pages and API routes
  components/                   shared UI and feature components
  config/                       club identity, module flags, and runtime config
  data/                         static public-page content
  lib/                          business logic, integrations, cron helpers
  types/                        project type augmentation
docs/                           public architecture and runbooks
scripts/                        deploy, migration, staging, and repair helpers
deploy/                         production proxy/runtime support files
```

Important route groups:

- `src/app/(public)` contains unauthenticated pages such as login, register,
  password reset, email verification, payment, and public token flows.
- `src/app/(authenticated)` contains member dashboard, booking, profile, family,
  and booking-detail pages.
- `src/app/(admin)` contains administrative operations for members, member CSV
  import, bookings, bed allocation, payments, reports, lodge, Xero, audit logs,
  and policies.
- `src/app/api` contains route handlers for auth, bookings, payments, admin,
  finance, lodge, webhooks, cron, and health checks.

> **Theme substrate — the 3-seed model (epic #2181, P1–P4 complete).** Site Style
> stores THREE seed colours, not seven: `brandGold` (the required accent),
> `brandDeep` (an optional neutral character whose hue tints the grey ramp), and
> `brandSafety` (an optional support accent), defined by
> `CLUB_THEME_COLOUR_FIELDS` in `src/lib/club-theme-schema.ts`. The wizard's
> colour step is 1 required + 2 optional **hex-only** pickers (`isValidThemeColour`
> is a hex regex; the oklch paste-in user-input path is gone — the only surviving
> oklch is internal MEASUREMENT maths that measures the curated dark
> semantic-muted surfaces). Those seeds feed the vendored Radix custom-palette
> generator (`src/lib/theme/theme-substrate.ts`, `buildThemeSubstrate`), which
> derives the full 12-step light/dark substrate with cross-colour text contrast
> guaranteed by construction — swept by `src/lib/theme/guarantees.ts` +
> `__tests__/guarantee-sweep.test.ts` (guarantees G1–G5, several split into
> lettered sub-guarantees). Shadcn/app token names are declared as ALIASES onto
> generated steps in `src/lib/theme/aliases.ts` (assembled by `app-tokens.ts`).
> A low-contrast pick is **adjusted and disclosed (before → after), not rejected**
> — the old blocking contrast gate is gone (`getBlockingContrastWarnings` survives
> only as an advisory helper that gates no save). The four former columns
> (`brandCharcoal`/`brandRidge`/`brandMist`/`brandSnow`) were dead to code from P1
> and were **DROPPED by P4's contract migration**
> (`prisma/migrations/20260722160000_contract_drop_club_theme_orphan_columns`);
> `ClubTheme` now stores only the three seeds plus the fonts, logo, raw CSS, and
> timestamps. The additive EXPAND migration had kept the columns behind a default
> so pre-#2187 code stayed compatible across the blue/green cutover; the contract
> drop ran once no code read them. The `--brand-*` values still ship as DERIVED
> shims (`deriveBrandShims`, from the substrate neutral ramp); the app scope's
> generated token block carries **no `--brand-*` reference** (F1), and #2217 P4
> re-mapped the website `.website-theme` role tokens off their `color-mix()`
> recipes onto resolved generated steps too (`serializeWebsiteRoleTokens`,
> injected by `buildClubThemeCss`), preserving the branded public look (gold
> primary/ring, dark nav). The shims stay because the EMAIL palette still derives
> from them and the app brand utilities / wizard preview / muted-tone clamp still
> read them (the website's legal-callout and mobile-menu `bg-brand-*` utilities
> are a small remaining consumer, left for their own render review). Config-transfer
> bundles are **format version 4** (`CONFIG_TRANSFER_FORMAT_VERSION`) and require
> an exact version match. Version 3 added the destructive, fully previewed
> minimum-stay policy replace-set and version 4 adds a second required file to
> that category, the adult-member hosting policy; both older and newer bundle
> versions are refused rather than interpreted under the wrong semantics, because
> an older reader would silently ignore a file it does not know while reporting
> that it had replaced the club's complete booking-policy set.

Every app-shell layout (`(public)`, `(authenticated)`, `(admin)`, `(finance)`)
injects the admin-configured theme via `getWebsiteThemeRenderState()` inside an
`app-theme-scope` wrapper, so never hardcode the brand accent (e.g. Tailwind
`teal-*`) in components: reach it through semantic tokens (`--primary`,
`bg-primary`, `text-primary-foreground`, `border-primary/30`, ...) so the saved
site colours apply in light and dark, and use the generated categorical scales
`cat1..cat6` (via `CHIP_TONE_CLASSES` or `bg/text-cat<N>-<step>`) for categorical
status hues. (#2218 P4 added a sixth categorical scale, `cat6` — a teal H≈183
chosen for maximum separation from cat1-5 and the four semantic hues — and
retired the legacy `--hue-*` accent pairs entirely; every categorical chip now
reaches a generated cat scale.)

The Members and Subscriptions tables are a worked identity-versus-state case.
Their **Access** chip is semantic state from `member-login-stage.ts`: No login →
neutral, Not invited → warning, Invited → info, Can log in → success. Role is
deliberately absent. Xero contact groups are identities, not severity, so both
tables call `getXeroContactGroupTone`, which selects `cat1..cat6` from a
stable-id hash modulo six. Catalog availability, filtering, and row order do
not participate, so pages with different catalog-loading policies cannot
drift. Collisions are intentional and the visible group name remains
authoritative.

The same rule applies to raw NEUTRALS, though for a narrower reason than the
brand accent — and the reason is worth stating precisely, because a safety net
already exists.

Historically `globals.css` carried a **`.dark .app-theme-scope` neutral remap**
(the #1263 follow-up block) that rewrote literal `bg-white`,
`bg-{neutral}-50/100/200`, `text-{neutral}-300..950`, `border-{neutral}-100..300`
and their `divide-`/`hover:` variants onto `--card`, `--muted`, `--border`,
`--foreground`, `--muted-foreground` and `--accent`, treating
slate/gray/zinc/neutral/stone as one family. That shim covered dark mode only —
in LIGHT mode a literal `slate-*`/`bg-white` stayed slate/white and ignored a
strongly non-default club theme, so surfaces were correct-by-shim rather than at
source. **#2188 P2 removed the shim entirely** (see below); code inside
`app-theme-scope` now uses the semantic surface tokens at source:
`bg-card` / `text-card-foreground` for card surfaces, `bg-popover` /
`text-popover-foreground` for floating panels such as chart tooltips,
`text-muted-foreground` for secondary labels and footnotes, `bg-muted` for
tinted rows and recessed insets, and `border-border` for rules. Colored surfaces
likewise reach their hue through the signed-off scale vocabulary — the semantic
`bg/text/border-<success|warning|info|danger>-<step>` scales, the categorical
`cat1..cat6` scales, or `CHIP_TONE_CLASSES` — never raw Tailwind colour
utilities. The finance tree migrated in #2137, admin in #2144, the member-facing
`(authenticated)`/`(public)` trees in #2187 P1 (B4), and the remaining trees
(lodge, website, shared components, root) in #2188 P2, so the source is
token-only repo-wide and gated by
`src/lib/__tests__/brand-color-source-contract.test.ts`.

**Insets use `bg-muted`, outer surfaces use `bg-card`** (#2144 owner decision).
The shim's raw→token table maps `bg-white`/`bg-{neutral}-50` onto `--card`, but
inside `app-theme-scope` `--card` and `--background` share the same colour in
light mode, so a nested strip converted to `bg-card` renders flat against its
page. The #2137 finance precedent (`finance-dashboard-client.tsx`,
`ratio-explorer.tsx`) answers this: a Card/section root, page-level panel, or
popover takes `bg-card`; a nested strip inside a card, a zebra row, a table
header band, a read-only field fill, or a recessed well takes `bg-muted`.

**#2188 P2 completed the migration and deleted both `.dark .app-theme-scope`
remap blocks** — the neutral remap and the colored-callout remap — so
`grep "\.dark .app-theme-scope" globals.css` now returns only P1's generated
dark core-token block and the A6 J8 card-shadow rule, never a remap. The source
contract is now **repo-wide** (both the neutral contract and the new 16-family
colored contract), with a temporary kiosk-tree exclusion (B8) removed in P3.
The surfaces that legitimately keep raw neutrals are per-file allowlisted with a
stated reason: the roster/induction print pages and reports print variants
(paper output, not theme), the site-style wizard's raw-CSS editor pane, the
display/signage surfaces, solid opaque status chips, deliberate dark surfaces
(the roster-setup and kiosk-style instruction panels, same shape as the kiosk),
the un-themed React error/404 boundaries (rendered outside `app-theme-scope`),
and the Radix overlay scrims (`bg-black/80`). The kiosk tree itself is migrated
onto `--kiosk-*` tokens in P3.

**The app tokens resolve from a GENERATED substrate** (#2187 P1, the restyle
event). A club now picks three seeds (accent + optional neutral-character +
optional support); `buildThemeSubstrate` (`src/lib/theme/theme-substrate.ts`)
turns them into the full 12-step light/dark Radix-style scales, and
`buildClubThemeAppCss` emits the whole generated custom-property set —
`--gen-<scale>-<step>` raw steps plus the resolved role tokens
`--gen-<token>` (light) / `--gen-<token>-dark` (dark), per the data alias map
in `src/lib/theme/aliases.ts` (`src/lib/theme/app-tokens.ts` assembles them).
`globals.css`'s static `.app-theme-scope` (light) and `.dark .app-theme-scope`
(dark) blocks CONSUME those props via `var(--gen-<token>, <default-fallback>)`,
so an un-themed page still paints the shipped default palette. `--accent`
(neutral-4) is deliberately one band off `--muted`/`--secondary` (neutral-3) in
BOTH modes — the structural fix for the seven hover-dead `bg-muted
hover:bg-accent` #2144 buttons — and the dark core-token block is rewired onto
generated dark steps with **no `--brand-*` reference left inside it** (F1). The
legacy `--brand-*` values still ship as derived SHIMS (`deriveBrandShims`, from
the substrate neutral ramp). #2217 P4 re-mapped the website `.website-theme`
(and `.website-mobile-menu`) role tokens off their `color-mix()` recipes onto
RESOLVED generated substrate steps via `serializeWebsiteRoleTokens` (injected by
`buildClubThemeCss`, with default-palette static fallbacks in `globals.css`),
preserving the branded look (accent-9 gold primary + focus ring, neutral-12 dark
nav) — so no `.website-theme` `color-mix()` or `var(--brand-*)` remains. The
shims are still load-bearing: the EMAIL palette derives from them, and the app
brand utilities, the site-style wizard preview, and the muted-tone clamp read
them (plus the website legal-callout / mobile-menu `bg-brand-*` utilities, a small
consumer left for a separate render review). The `.dark`
neutral/colored remap blocks described above were deleted by #2188 P2 once every
tree was migrated at source.

The member-facing `src/app/(authenticated)` and `src/app/(public)` trees were
migrated off raw neutrals onto the semantic surface tokens in the same event
(#2187 B4), so at restyle their light mode follows the club theme at source
rather than by shim; the remaining raw neutrals live under `src/components`,
the kiosk/lodge display trees, and the allowlisted admin files.

**`--muted-foreground` is a DERIVED tone, not a brand colour** (#2145). Every
other app text token in the `.app-theme-scope` block resolves to a solid
generated-substrate endpoint (`--foreground` is the club ramp's neutral-12 in
each mode).
`--muted-foreground` used to do the same — which made it byte-identical to
`--foreground`, so `text-muted-foreground` rendered as primary text and the
`muted` role was inert. It is now computed by `deriveAppMutedForeground` in
`src/lib/club-theme-schema.ts` and injected as `--app-muted-foreground` /
`--app-muted-foreground-dark` by `buildClubThemeAppCss`; `globals.css` reads
those with a static fallback for the case where no ClubTheme stylesheet is
injected.

The derivation mixes each mode's foreground 30% toward that mode's base surface
(the same 70/30 sRGB mix `.website-theme` already uses for its own
`--muted-foreground`) and then steps the tone BACK toward the foreground until
it clears WCAG AA 4.5:1 against a **named, finite list** of surfaces. The list is
the whole substance of the guard, so it is stated here in full — it is
`APP_MUTED_FOREGROUND_LIGHT_SURFACE_TOKENS` /
`APP_MUTED_FOREGROUND_DARK_SURFACE_TOKENS` in `club-theme-schema.ts`:

| Mode  | Checked surfaces |
| ----- | ---------------- |
| Light | `--brand-snow` (`--background`/`--card`/`--popover`), `--brand-mist` (`--muted`/`--secondary`), `--accent` (neutral-4), and the curated `--warning-muted` / `--info-muted` / `--success-muted` / `--danger-muted` panel fills |
| Dark  | `--brand-deep` (`--background`), `--brand-charcoal` (`--card`/`--popover`/`--muted`/`--secondary`), `--accent` (neutral-4), and the same four curated `*-muted` fills in their `.dark` values |

Both **brand** surfaces are checked per mode, not only the base one, because
that is what makes the guard hold for an endpoint-crossing palette, where moving
toward one surface moves away from the other. **`--accent`** is checked as its
own surface because #2144 split it off `--muted`/`--secondary`: it is neutral-4,
one band DARKER than `--brand-mist` (neutral-3) in light and one band lighter in
dark, and it is a genuine muted-text background — dropdown and command-menu
shortcuts render `text-muted-foreground` inside `focus:bg-accent` items. Clamping
against `--brand-mist` alone left the Tokoroa light tone at 4.37:1 on the hover
surface; reading the true neutral-4 from each mode's substrate ramp restores it
to 4.64:1. The guarantee sweep (`guarantee-sweep.test.ts`, G2c) measures the
shipped derived tone against neutral steps 1–4 in both modes for both reference
seeds, so a sub-AA step-4 cell fails CI. The four **curated** `*-muted`
fills are checked because #1808 deliberately leaves them out of
`app-theme-scope`: they are fixed while the derived tone slides with the brand
ramp, which is the one pairing that can drift apart with nothing watching. They
are genuine muted-text backgrounds — `bg-warning-muted` and friends carry
`text-muted-foreground` footnotes in roughly 35 places across bed-allocation,
waitlist, committee, and family-suggestions.

Deliberately **not** in the list:

- `--border` / `--input`. Dark mode used to remap `bg-{neutral}-200` onto
  `--border` (the shim #2188 P2 deleted, when the trees moved to source tokens),
  so a `bg-slate-200` badge would be a muted-text surface — but the only such
  badge (`page-content-panel.tsx`) was moved to `bg-muted text-muted-foreground`
  instead. A mid-luminance hairline colour is the wrong background for body text
  at any weight, and a mid-luminance surface leaves the derived tone almost no
  headroom: clamping against it would force the tone to walk all the way back
  onto `--foreground` for a materially larger share of palettes than the muted
  derivation collapses on today — defeating #2145 (a distinct muted tone) for a
  surface no text should sit on. The AA guarantee that IS enforced (the
  neutral-ramp sweep in `club-theme-schema.test.ts`) covers only the surfaces in
  the clamp set; `--border`/`--input` are deliberately outside it.
- The (now-deleted, #2188 P2) dark coloured hue remaps. The `-50`
  (`oklch(0.29 …)`) and `-100` (`oklch(0.33 …)`) tiers sat at or below the
  `*-muted` tier already checked, so
  in dark mode — where the derived tone is the LIGHT one — clearing AA on
  `--success-muted` clears them too. The `-200` tier does NOT follow from that
  reasoning and is excluded on evidence instead: `bg-{hue}-200` remaps to
  `oklch(0.38 …)`, which is LIGHTER than the checked `oklch(0.33 …)` tier and so
  is the HARDER background for a light tone. The default dark tone measures
  6.10:1 on `--warning-muted` but 5.00:1 on `bg-amber-200` and 4.93:1 on
  `bg-sky-200`. Both shipped palettes still clear 4.5:1 there, and the only
  coloured `-200` background in the app
  (`admin-exclusive-hold-controls.tsx`) carries `text-amber-900`, not muted
  text — so nothing fails today. But a `bg-*-200` + `text-muted-foreground`
  pairing is NOT covered by the guard; on a lower-headroom palette it could drop
  below AA, so measure before shipping one.

Four things about this guard are worth stating precisely, because it is easy to
read more into it than it delivers:

- **It guarantees** a TWO-BRANCH outcome, over the surfaces **in the table
  above** and no others. Where `--foreground` itself clears 4.5:1 on a listed
  surface, the derived tone clears 4.5:1 there too. Where `--foreground` itself
  FAILS AA on a listed surface — an inherited failure the derivation cannot
  repair, because #1808 pins the curated `*-muted` fills while the brand ramp
  moves — the derived tone is no worse than `--foreground` there. It is computed
  from the saved palette every time the app stylesheet is rendered, so it also
  covers palettes already stored in the database — not only newly saved ones. It
  says nothing about a surface not in the table; a new always-on background that
  hosts muted text has to be added to the list.
- **It is deliberately LESS readable than `--foreground`, and that is the
  point.** Carrying measurably less contrast than the token it softens is the
  whole feature, so no clause here should be read as parity with `--foreground`.
  `club-theme-schema.test.ts` pins the shipped tones at 0.41 / 0.53 (default
  light/dark) and 0.51 / 0.59 (Tokoroa) of `--foreground`'s ratio on the same
  surface, and fails if that fraction ever climbs past 0.75 — which is what stops
  the role being tuned back into an invisible near-copy of `--foreground`.
- **It does not guarantee** that the tone is visually DISTINCT from
  `--foreground`. A palette with no contrast headroom walks all the way back and
  the two coincide again, exactly as before #2145. Accessibility wins over the
  semantic distinction. Nothing blocks such a palette from being saved any more:
  the substrate generator adjusts a pathological seed (disclosed before → after)
  so the shipped scale clears contrast by construction, and
  `getBlockingContrastWarnings` survives only as an advisory helper that gates no
  save.
- **It says nothing about ALPHA uses of the token.** Every ratio above is
  measured on the opaque tone. Where a call site applies an alpha — the dashed
  `border-muted-foreground/70` and `/80` provisional-chip outlines in
  bed-allocation, `border-muted-foreground/30` on the display-builder drop zone,
  the `text-muted-foreground/60` empty-state icon on the member dashboard — the
  composited colour is materially fainter than the token, and #2145 made those
  composites fainter still (the dashed chip outline went from 4.26:1 to 2.76:1
  in dark mode at `/50`, which is why it is now `/70`). None of them is a WCAG
  1.4.11 failure: each is either purely decorative alongside full-strength text,
  or redundantly encoded by border style, icon, and label — the reasoning is
  recorded at `allocation-chip.tsx`. But do not read the opaque guarantee onto
  an alpha variant; measure it. An opaque non-text use (the `bg-muted-foreground`
  meter fill on a `bg-muted` track in the Xero panel, 4.77:1 / 4.63:1) does
  inherit the stricter-than-3:1 bar.

The tone is computed in TypeScript and emitted as a resolved colour rather than
written as a CSS `color-mix()` on purpose: a mix is unmeasurable from the
contrast gate, and "app text tokens are solid, measurable endpoints" is the same
invariant that keeps `--foreground` / `--card-foreground` off interpolated
values. `src/lib/__tests__/club-theme-schema.test.ts` gates the derived values
(including a sweep over configurable neutral ramps) and
`src/lib/__tests__/app-theme-layout-contract.test.ts` pins the `globals.css`
wiring and its static fallback.

Two of the source contracts in
`src/lib/__tests__/brand-color-source-contract.test.ts` are worth stating in
detail (the file now carries five — brand accent, the 16-family colored contract,
the on-solid AA pair guard, themed neutrals, and print-light):

- **Brand accent.** No literal Tailwind `bg-`, `text-`, or `border-` `teal-*`
  utility under `src/` (the check is scoped to those three prefixes; `ring-`,
  `divide-`, `fill-`, and gradient `from-`/`to-` teal are not currently
  matched). The `CATEGORICAL_TEAL_ALLOWLIST` is now **EMPTY**: #2190 P4 moved its
  last entry — `admin-booking-calendar.tsx`, which painted the `WAITLIST_OFFERED`
  status as a solid `bg-teal-500` swatch — onto the categorical `bg-cat6-9` step
  token, so no source file names a raw teal utility. The dashboard Chore Roster
  tile was migrated onto the brand role tokens (`bg-accent` / `text-primary`, M9,
  #2188 P2). #2218 P4 retired the legacy `--hue-*` accent pairs ENTIRELY: cat6
  gave the booking column its sixth distinguisher (`WAITLIST_OFFERED` →
  `CHIP_TONE_CLASSES.cat6`), and every other former hue consumer (payments
  settlement/xero chips, the Internet-Banking chips, member-table badges,
  status-chip PROCESSING/REFUNDED/PARTIALLY_REFUNDED, the audit `family` and
  family-group `GROUP_CREATE` badges, the bed-type icons) moved onto a cat scale.
  `CHIP_TONE_CLASSES` (`src/lib/chip-tones.ts`, the single source of truth for
  chip tone classes) now carries only the five semantic tones plus `cat1..cat6` —
  no `--hue-*` remains anywhere.
- **Themed neutrals.** No raw `slate-`/`gray-`/`zinc-`/`neutral-`/`stone-`
  utility, `bg-white`, or `bg-`/`text-black` anywhere in source — the contract is
  **repo-wide** via `listRepoSourceFiles()` (the member-facing
  `(authenticated)`/`(public)`, `(lodge)`, `(website)`, `(admin)`, `(finance)`,
  shared `components`, and root trees are all migrated onto the shadcn role tokens
  at source). Four admin-only leaves (`admin-booking-calendar.tsx`,
  `admin-hub-page.tsx`, `admin-permission-matrix-table.tsx`,
  `src/lib/admin-family-group-ui-helpers.ts`) are additionally pinned by name as a
  `THEMED_TOKEN_ONLY_FILES` existence guard, so a rename surfaces as a clear
  failure rather than silently dropping coverage; they pass token-only. The
  `THEMED_NEUTRAL_ALLOWLIST` is a small set of PER-FILE exceptions, each with a
  stated reason: the site-style code-preview panes that `app-theme-layout-contract`
  pins as literal slate, the roster/induction/reports print (paper) surfaces, the
  display builder/preview `bg-black` letterboxes, the un-themed `error.tsx` /
  `not-found.tsx` boundaries (rendered outside `app-theme-scope`), the Radix
  overlay scrims (`dialog.tsx` / `sheet.tsx`), and `site-banners.tsx`. #2190 P4
  evicted the last three entries that were deferred work wearing an allowlist
  badge — `xero-record-activity-panel.tsx` (→ `bg-foreground` / `text-background`),
  `member-import-dialog.tsx` (→ `border-foreground`), and
  `admin-booking-calendar.tsx`'s DRAFT/fallback swatches (→ `bg-muted`) — so every
  remaining entry is a principled fixed surface. Per-file granularity means an
  entry forfeits gate coverage on that file's other occurrences — prefer fixing a
  stray over adding an entry. #2189 P3 removed the last carve-out — the kiosk
  family — so all five source contracts now run **truly repo-wide** with no kiosk
  exclusion (see "Kiosk / wall-display" below).

The dark-mode colored-callout pass (#1248) that used to re-tint literal Tailwind
`bg-{family}-50/100/200` / `text-{family}-600..950` / `border-{family}-100..300`
inside `app-theme-scope` was **deleted in #2188 P2** — every colored surface now
carries a scale token at source (`bg-danger-3` / `text-danger-11` / the `cat1..6`
scales) that adapts per mode by construction, so no re-tint pass is needed. The
dashboard Chore Roster tile that used to depend on that pass (its `bg-teal-50` /
`text-teal-600` were what it re-tinted) was migrated onto the brand role tokens
(`bg-accent` / `text-primary`, M9) in the same phase. #2190 P4 evicted the last
raw teal — the booking calendar's `bg-teal-500` `WAITLIST_OFFERED` swatch, moved
onto `bg-cat2-9` — so no literal teal utility remains in source and the
`CATEGORICAL_TEAL_ALLOWLIST` is empty.

**Print and PDF always render the LIGHT palette** (#2146). Paper and the
generated PDF page are white, so dark mode must never reach them. Rather than
stacking `!important` overrides on the print block — which cannot win against a
token a descendant sets on itself, such as `Card`'s own `text-card-foreground` —
every rule that installs the dark palette is wrapped in `@media not print`: the
`:root`-level `.dark` token ramp and the `.dark .app-theme-scope` generated
core-token block (the two surviving dark blocks after #2188 P2 deleted the
neutral and colored-callout remaps). The `@media print` block then only pins
`color-scheme: light`
(the one `!important` it needs, because `next-themes` writes `color-scheme` as an
inline style on `<html>`) plus the page/section layout rules. The
`html2canvas`-based **Download PDF** path (`src/lib/report-pdf.ts`) is the same
hazard in a different medium: it composites onto a hard-coded white page, so its
`onclone` hook strips the theme class from the cloned capture document.

Two rules follow for anyone adding dark-mode styling, because the guarantee has
two halves with different enforcement:

1. **In `globals.css`:** wrap any new `.dark`-gated rule in `@media not print`,
   unless every value it assigns is a `var(--token)` for a token the light
   blocks genuinely restate. That qualifier is the whole point and is easy to
   get wrong: `--card` / `--foreground` are light/dark PAIRS, so excluding the
   `.dark` block from print leaves the light `:root` value standing and the rule
   self-heals — which is why the token-driven neutral remap is deliberately left
   unwrapped. `--brand-charcoal` / `-deep` / `-snow` / `-gold` / `-mist` are NOT
   pairs: they are fixed brand colours declared once on `:root` that no `.dark`
   block restates, so `background: var(--brand-deep)` in an unwrapped
   `.dark`-gated rule prints a near-black card. The contract test
   `src/lib/__tests__/print-light-palette-contract.test.ts` parses this file and
   fails on any `.dark`-gated rule left visible to print media that assigns
   anything else — a literal colour in any syntax, a fixed brand token, or a
   colourless but theme-dependent declaration such as `outline: none`. It
   derives the set of self-healing tokens from the stylesheet itself (declared
   by a print-visible light block AND by a `.dark`-gated block), so the set
   cannot drift away from what this file actually declares. Note the
   granularity, which pre-dates #2145 and #2146: the derived set is keyed by
   token NAME across the whole stylesheet, not per block. A token stays
   "healed" as long as *some* print-visible light rule and *some* `.dark` rule
   declare it — so `--muted-foreground` would still count as healed via
   `:root`/`.dark` even if the light `app-theme-scope` block stopped declaring
   it, and would then quietly fall back to the `:root` value on paper without
   the contract test objecting. A corollary that
   bites when a token stops being a plain brand alias: the derived
   `--muted-foreground` (#2145) reads a DIFFERENT injected variable per mode
   (`--app-muted-foreground` vs `--app-muted-foreground-dark`), but both blocks
   still declare `--muted-foreground` itself, so it stays a light/dark pair and
   paper keeps the light derived tone. Splitting a paired token across two
   differently-named declarations — light in one block, dark in the other, with
   no shared name — would silently drop it out of the healed set.
2. **In a class string, wherever it lives:** a Tailwind `dark:` utility carrying
   a **literal palette colour** — a named shade (`dark:bg-slate-900`,
   `dark:text-amber-200`) or an arbitrary value (`dark:bg-[#0b1220]`,
   `dark:text-[rgb(2,6,23)]`) — must not go on a printable surface, whatever
   variants are stacked in front of it. This is the half `globals.css` cannot
   protect: `dark:` utilities compile into Tailwind's own generated stylesheet,
   never into `globals.css`, so no `@media not print` wrapper here can ever
   reach them — they print exactly as written. Token-driven variants
   (`dark:bg-input/30`, `dark:checked:bg-primary`, `dark:bg-[var(--card)]`) are
   fine, since they resolve to `var(--token)` and self-heal like the rules
   above. The same contract test enforces this by scanning the printable trees
   (`(finance)`, `components/finance`, `admin/reports`, `admin/roster`,
   `admin/induction`, `lodge-instructions`, `hut-leader-instructions`, and
   `components/ui`, plus the shared components that render on a printable page)
   and keeps the handful of non-printable files that legitimately carry such
   utilities on an enumerated list. The scan covers `.ts` as well as `.tsx`,
   because this repo already keeps palette class strings in plain modules
   (`bed-allocation/_components/booking-accent.ts`). On a printable surface,
   reach the colour through a semantic token or a categorical `cat1..cat6` scale instead.

   **What the class-string scan does and does not see.** It is a regex over
   source text, not a Tailwind parse, so the boundary is worth stating exactly
   rather than implying it is total. It recognises any stack of variants in
   front of the utility — named (`dark:hover:`, `dark:md:`), the `*:` / `**:`
   descendant variants, bare arbitrary variants (`dark:[&>tr]:`), and functional
   bracket variants (`dark:data-[state=open]:`, `dark:has-[:checked]:`,
   `dark:aria-[…]:`, `dark:group-[…]:`, `dark:supports-[…]:`) — and, on the
   value side, named palette shades, `black` / `white`, and any arbitrary value
   containing a colour token anywhere in it (hex, or `rgb`/`hsl`/`hwb`/`oklch`/
   `oklab`/`lab`/`lch`/`color`/`color-mix`/`light-dark`/`theme(…)`, nested or
   not). It deliberately does NOT flag arbitrary values that reach a token
   (`dark:bg-[var(--card)]`) or that are not colours at all
   (`dark:text-[14px]`). What it cannot see is a class name that does not exist
   as literal text in the source: one assembled at runtime from fragments, or
   arriving from data or a CMS field. Keep printable-surface classes written out
   literally so this check can do its job.

`e2e/print-dark-mode.spec.ts` backs the CSS and class-string halves at the
medium the bug actually lives in: it renders `/admin/reports` and `/finance`
under `emulateMedia({ media: "print", colorScheme: "dark" })` and asserts the
computed ink is dark on a light surface, and that the printed result is
identical with and without the theme class.

**The `report-pdf.ts` Download PDF path has no browser-level coverage.**
`emulateMedia` changes the print medium; it does not exercise `html2canvas`, and
the spec never clicks Download PDF. What is covered is the jsdom unit test in
the contract file, which calls `forceLightPaletteInClone` on a hand-built
document and asserts the DOM mutation, plus a source-string assertion that the
hook is still wired as `onclone`. That is the function's behaviour and the
wiring — not the actual `html2canvas` contract, and not the produced PDF. Since
Download PDF is the button operators actually press (and was the second half of
#2146), a change to that path warrants a manual export check in both themes
until real coverage exists.

Chart colours are a documented carve-out. `FINANCE_MIX_COLORS` in
`src/components/finance/charts/finance-chart-theme.ts` resolves to concrete hex
at module load, because the values feed Recharts `fill`/`stroke` SVG presentation
attributes where `var()` does not resolve. As of **#2190 P4** those eight slots
are no longer hand-picked literals: `buildFinanceMixColors()` DERIVES them from
the signed-off categorical scales (`buildThemeSubstrate` over a fixed reference
seed, mapping the `cat1..cat5` steps in `CHART_FINANCE_8SLOT`), so no fork brand
literal is baked in — `finance-chart-theme.test.ts` pins this and asserts the
palette contains no Tokoroa gold. They remain categorical tones chosen to stay
distinguishable independent of the live club theme.
Chart neutrals (grid, axis, ticks) are themed in `globals.css` through the
`.finance-trend-chart .recharts-*` selectors, which override the light-mode
literal fallbacks that `trend-chart.tsx` passes as attributes.

**Kiosk / wall-display is the fixed-seed, mode-invariant exception** (#2189 P3,
epic #2181 A5/J4). The lodge kiosk (`src/app/(lodge)/lodge/kiosk/**`) and its two
sibling surfaces reached from it — the roster-setup wizard
(`lodge/roster/[date]/setup/page.tsx`) and `components/kiosk-lodge-instructions.tsx`
— are a glare-proof wall display, NOT a club-themed page. They are deliberately
literalist and must **not** follow the club accent and must **not** change with
the operator's light/dark toggle. So instead of the club-themed role/scale tokens,
they paint through a dedicated fixed **`--kiosk-*`** token set (`bg-kiosk-page`,
`text-kiosk-fg`, `bg-kiosk-card`, `border-kiosk-border`, `bg-kiosk-accent`, the
`kiosk-{danger,success,warning,orange}-{bg,fg,border,solid,solid-fg}` status
tokens, …). The set is generated ONCE from the fixed A5 kiosk seed (near-black
`#0a0a0b` page, neutral grey ramp from `#808080`, `#7dd3fc` accent) by
`buildKioskTokens()` in `src/lib/theme/kiosk-tokens.ts`; the status hues are
generated in that same fixed context. Because the values are static and club- AND
mode-independent, `globals.css` carries them as literal `--kiosk-*` custom
properties on `:root` plus `@theme` `--color-kiosk-*` utilities — declared once,
un-gated — and `src/lib/__tests__/kiosk-token-contract.test.ts` pins every literal
against the derivation (R9 fallback-pin). This is the **principled replacement for
the old #1249 light-mode kiosk readability remap**: that block existed only because
the kiosk was authored in literal dark slate/colour utilities that turned
unreadable under the LIGHT palette, so it re-mapped them whenever the document was
not in dark mode. With the kiosk authored on mode-invariant fixed tokens the remap
is unnecessary and has been deleted (grep-proof: `globals.css` matches neither
`theme-aware-kiosk` nor `html:not(.dark)`). The `theme-aware-kiosk` class remains
in the kiosk markup only as an inert semantic marker; it no longer keys any rule.
Mode invariance applies **on screen**; **on paper** the discipline still holds —
a near-black wall page is an ink flood, and the roster-setup wizard is realistically
printed — so a single `@media print { :root { … } }` block re-declares the neutral
surface + text `--kiosk-*` tokens as a light paper palette (page/card → white,
insets → light grey, foregrounds → ink), which every `bg-kiosk-*`/`text-kiosk-*`
utility then resolves light with no per-element print rules. The status and accent
tokens keep their tints on paper (small self-consistent badges/buttons/callouts,
not a flood). That print block is not `.dark`-gated, so it sits outside the
`print-light-palette` self-healing contract and does not perturb it. Note this is
distinct from the separate `display`
route (`src/app/display/`, `components/lodge-display`, `lib/lodge-display`), which
already paints via its own `--display-*` CSS custom properties in
`src/app/display/display.css` (a non-Tailwind, already-principled CSS-var surface)
and carries **zero** raw colour utilities, so P3 left it untouched.

### Form field hints and placeholder ink (#2257)

**An example value belongs UNDER a field, not inside it.** Grey example text in
a control reads as a value the form already holds, and it disappears the moment
the operator starts typing — exactly when the example is still wanted. Every
`placeholder` that carried an example of a name or value the operator invents
was moved to helper text rendered by
`FieldHint` (`src/components/ui/field-hint.tsx`), with one consistent phrasing:
`Example: <value>` (prefixed with the field name — `Version example: 2026.1` —
in the one place where the layout forces the hint away from its field). What
remains in a `placeholder` is everything else: instructions ("First name",
"Search name or email", "Optional — defaults to the club name") and format
samples ("member@example.com", "0.00"). Two example-bearing placeholders
survived that pass on screens it excluded (the display Templates page's HTML
sample, and the page-content panel's "Width (px, e.g. 300)") — which is why
the italic restyle mattered: it covered the ones #2257 did not move. **#2264
has since moved both**: the Templates HTML sample now folds into that field's
existing helper paragraph, and the size field was split into a `Width (px)`
name plus an `e.g. 300` example in the row's one hint. What remains in a
`placeholder` anywhere in the repo is an instruction, a blank-state statement,
or a field name — never a specimen answer.

`FieldHint` exists because the visually-obvious half of that move is the easy
half. A `<p>` sitting below an input is invisible to a screen reader focused on
that input, so the primitive owns the association: `useFieldHint()` returns
`hintProps` (the generated id) and `fieldProps` (the matching
`aria-describedby`), which can only be spread as a pair. `aria-describedby` is a
LIST — a validation error, a view-only reason (#2160) and a hint can all describe
one field — so ids passed to `useFieldHint(...)` are announced BEFORE the hint;
"this is wrong" must be heard ahead of "here is an example". Rows rendered inside
a `.map()` cannot call a hook per row and pass a deterministic id to
`describedByFieldHint()` instead. `id` is required on `FieldHint`, which removes
the "hint with no id to point at" state — it cannot prove association, because
the type system cannot see across from the hint to the input. The one remaining
failure mode, a caller that spreads `hintProps` and forgets `fieldProps`, is
caught by a count contract in `field-hint.test.tsx`: `useFieldHint(`,
`.fieldProps` and `.hintProps` must occur the same number of times across
`src/`.

**Placeholder ink is its own token.** `--placeholder-foreground` is declared in
every scope that restates `--muted-foreground` — a `var()`-bearing custom
property is substituted on the element that DECLARES it and then inherits as
that fixed value, so a single `:root` entry would freeze the base palette inside
`.app-theme-scope` / `.website-theme` / `.dark`. Its value deliberately TRACKS
`--muted-foreground` rather than going lighter: placeholder text is text, WCAG
1.4.3 applies to it, and every `--muted-foreground` here already sits on the
4.5:1 floor (`deriveAppMutedForeground` steps back until it just clears). The
"not content" signal is carried by **italics** instead, which costs no contrast
and survives colour-blindness and forced-colours modes. The token remains the
seam a fork retunes without touching the muted labels and captions
`--muted-foreground` also paints.

Placeholder styling is hand-copied across five files, so
`src/components/ui/__tests__/placeholder-styling-contract.test.ts` pins them.
Note the `SelectTrigger` case: it is a Radix `<button>`, `::placeholder` exists
only on `<input>`/`<textarea>`, and the `placeholder:` utility copied there was
therefore **inert** — `<SelectValue placeholder="…" />` rendered in full
foreground ink, indistinguishable from a chosen value. It now styles through
`data-[placeholder]:`, which is the attribute Radix actually stamps.

The repo-wide sweep of the remaining placeholders (including the raw
`<input>`/`<textarea>` elements that bypass the styled primitives) landed as
**#2264**; the display screens are rewritten by **#2248** and adopt
`FieldHint` there.

**What #2264 settled, so the next conversion does not have to re-decide it.**
Every remaining `placeholder` in `src/` was classified into exactly one of
three buckets, and the boundary between them is the rule to reuse:

- **An example value converts.** A specimen of what a correct entry looks like
  — `president@example.org`, `Lobby TV`, `75.00`, `sk_test_…`, `Locker A1`,
  `64 27 123 4567`. The test is whether a reasonable operator could mistake it
  for something already entered.
- **An instruction stays inside the control.** Text describing what the control
  DOES (`Search name or email`), or what leaving it blank MEANS
  (`Use configured amount`, `Unlimited`, `Leave blank …`), or what a set
  credential field now expects (`Enter a new value to replace`). Moving those
  below the field would be a regression: they are about the box, not about the
  answer.
- **A name stays until the field has a real one.** Where the placeholder was
  the field's only accessible name, the fix is a `<Label htmlFor>` or an
  `aria-label` added in the SAME edit — never a bare removal.

Three corollaries worth keeping:

1. **A ternary placeholder is almost always two different things** and must be
   split, not blanket-converted: the unset branch is usually an example, while
   the set/disabled branch is live state. `non-member-contact-form.tsx` is the
   worked example — `guest@example.com` converted, `No email address` stayed.
2. **`<SelectValue placeholder>` is not an input placeholder.** It is the
   Radix trigger's empty-state label; `FieldHint` does not apply to it, and
   none were touched.
3. **A row of micro-inputs gets one hint, not one per box** (phone
   country/area/number, amount min/max). One hook cannot serve three controls
   — the wiring contract pairs each `useFieldHint()` with exactly one
   `fieldProps` spread — so those rows use `describedByFieldHint()` with a
   deterministic id, the same mechanism the `.map()` rows use.

#2264 also re-selected the tests and Playwright specs that had been reaching
these fields through `getByPlaceholder`, because a placeholder is not a
selector: a field whose only handle is its placeholder is a field with no
accessible name. Each of those now selects by role and accessible name, and
the components gained the names to make that possible — including a per-device
name on the display pairing box and a named group per guest card, both of which
also keep the selector unambiguous once a second row exists.

### What a browser may say about a write it never saw an answer to (#2668)

`fetch` rejects for two situations a client cannot tell apart: the request never
reached the server, and the request reached the server, was processed, and the
connection dropped before the response came back. A message that states the
first one as fact — "your room request was not saved", "nothing was recorded" —
is therefore a guess about the database made by the one party that cannot see
it, and on a flaky mobile connection it is wrong often enough to send someone
back to redo a write that already happened. For a non-idempotent write (cash
recorded by hand, a refund task closed) that invites a duplicate. The same
applies to a response that ARRIVES and cannot be read: the server has already
done whatever it was going to do.

**The line is between the attempt and the record.** Reporting that the attempt
failed is honest and stays as it is — `arrival-time-editor.tsx`'s "Failed to
save arrival time" claims nothing about the stored row. Reporting that the
record did not move is the claim a client is not entitled to make. A refusal the
SERVER reported (403, 409, a validation 400) is unaffected: there the server is
making the claim, and it knows.

The wording is built by `unverifiedWriteMessage()`
(`src/lib/unverified-write-copy.ts`), which produces the sentence the waitlist
offer card shipped first (#2623 T8): *"The service response could not be read,
so we could not verify whether …"* plus a second sentence routing the person at
the server's own value rather than at the screen in front of them. Six surfaces
were converted with it in #2668 — the requested-room and roster editors, the
manual cash-payment control, the manual-refund queue, the reviewed
bed-allocation removal dialog, and the built-in-board restore. Every other
surface that speaks this sentence reads it from the same builder rather than
typing it out: the waitlist offer card, the waitlist force-confirm action, the
draft-confirm button, and the display wizard's board bind. Nine in all, and
membership is pinned, because "one wording" that four files happen to agree on
is a coincidence waiting to be broken by the first re-wording.

Three behaviours follow from the copy rather than merely accompanying it. An
unread outcome must **not revert a control** to a value the server may no longer
hold (that is screen-versus-row drift reintroduced on the path with the least
information), and it must not be **re-baselined** as though it were confirmed:
the admin notification panel keeps such a card exactly as the operator left it
and leaves Save live, while a card the server actually refused still rolls back.
Re-baselining is the half that fails silently — a re-baselined card is clean, so
the next Save sends nothing and the panel leaves edit mode as though the guess
were confirmed — so it is pinned behaviourally: after an unread outcome, pressing
Save again must send a second request. And on the **two money surfaces** (the
manual cash-payment control and the manual-refund queue) the sentence is *held*
in the open dialog with the confirming button disarmed behind it, rather than
thrown as a transient toast: the operator's likeliest next act is a second press
on a still-armed button, which is the act the message exists to prevent. The
server refuses the duplicate in both cases, so the ledger is safe either way; the
delivery is about the operator doing the right thing rather than about the ledger.

Enforced on the current tree by
`src/lib/__tests__/unverified-write-copy-contract.test.ts`, which walks `src/`,
bounds every `catch` body and every falsy guard on a name bound to a `fetch`
result in a `"use client"` file, resolves module-scope constants (the house style
for this copy — two of the converted surfaces hold their sentence in one), and
fails if any of those branches asserts the stored record did not move. A guard
must be on the binding (`if (!res)`) or through an optional chain
(`if (!res?.ok)`) to count: `if (!res.ok)` means a response is in hand, so the
server answered, and its refusals keep their confident wording.

It is a **floor, not a proof**, and the gaps are known and deliberate rather than
undiscovered: a claim rendered from error state in JSX rather than written in the
branch, a `fetch` behind an imported helper module, a message assembled at run
time, and browser code in a file carrying no `"use client"` marker of its own
(`src/lib/admin-member-xero-actions.ts` is one; its copy is honest today, and the
walk is not what keeps it so) all pass. That is why every converted surface has a
behavioural test as well — see the "Client honesty" row of
`docs/END_TO_END_TEST_MATRIX.md`.

Allowlist entries are scoped to **one branch, not a file**. The single entry is
the display setup wizard's module-settings GET, whose "nothing was changed" is a
fact about the client's own control flow because the function returns before its
PUT is built; the five write fetches in that same file — the module-settings
PUT, the lodge-config PUT, the device create, the board bind and the pairing
arm — are walked like anything else.

## Module Boundaries

This application is intentionally still a single Next.js monolith. The
important boundary is not process separation; it is keeping route handlers thin,
business rules testable, and integration code behind narrow helpers.

The curated module-boundary map below shows the allowed dependency direction:
the route boundary (`src/app`) delegates into business logic (`src/lib`), which
owns the database and the external providers. UI and config are leaf
dependencies; providers and the database are the sinks. Arrows point from the
depender to its dependency — there is no arrow back up from `src/lib` into
`src/app`.

```mermaid
flowchart LR
    subgraph Edge["Route boundary — src/app"]
        Pages["Pages / Server Components"]
        API["API route handlers /api/**"]
    end
    subgraph Lib["Business logic — src/lib"]
        BookingSvc["booking-create / booking-modify"]
        Beds["bed-allocation*"]
        Policies["policies/*"]
        Status["booking-status<br/>(capacity source of truth)"]
        Locks["advisory locks<br/>(concurrency)"]
        MemberSvc["member-* / membership-*"]
        XeroLib["xero-* modules"]
        EmailSvc["email registry / sendEmail"]
    end
    Config["config/ + src/config<br/>(club identity, module flags)"]
    UI["src/components<br/>(shared UI)"]
    DB[("Prisma / PostgreSQL")]
    Providers["Stripe / Xero / SES / Sentry"]

    Pages --> UI
    Pages --> BookingSvc
    Pages --> MemberSvc
    API --> BookingSvc
    API --> MemberSvc
    API --> Config
    Pages --> Config
    BookingSvc --> Status
    BookingSvc --> Policies
    BookingSvc --> Locks
    BookingSvc --> Beds
    Beds --> Locks
    BookingSvc --> XeroLib
    BookingSvc --> EmailSvc
    MemberSvc --> XeroLib
    Lib --> DB
    XeroLib --> Providers
    EmailSvc --> Providers
    BookingSvc --> Providers
```

Use these ownership boundaries when adding new code:

| Area | Primary paths | Rule of thumb |
| --- | --- | --- |
| Club configuration | `config/`, `src/config/` | Club identity, capacities, rates, and feature switches must come from config or environment, not hard-coded deployment values. |
| Pages and route handlers | `src/app/` | Validate input and session state near the route boundary, then delegate decisions to `src/lib/`. |
| Route-private page UI | `src/app/(admin)/admin/xero/_components`, `src/app/(admin)/admin/xero/_hooks`, `src/app/(admin)/admin/members/**/_components`, `src/app/(admin)/admin/members/**/_hooks`, `src/app/(authenticated)/book/_components` | Large routes should be route shells plus local components/hooks before moving anything to shared UI. |
| Shared UI | `src/components/` | Reusable view pieces live here; route-specific view state can stay beside the page until it is reused. |
| Booking lifecycle | `src/lib/booking-create.ts`, `src/lib/booking-create-types.ts`, `src/lib/booking-create-promo.ts`, `src/lib/booking-create-guests.ts`, `src/lib/booking-modify.ts` (barrel over `booking-modify-validation` / `booking-modify-plan` / `booking-modify-settlement`), `src/lib/booking-payment-cleanup.ts`, `src/lib/payment-recovery.ts` | Keep route handlers thin; booking orchestration and durable payment recovery live behind these services. |
| Bed allocation | `src/lib/bed-allocation.ts`, `src/lib/bed-allocation-lifecycle.ts`, `src/lib/admin-bed-allocation.ts`, `src/lib/bed-allocation-removal.ts` | Room/bed inventory, family-aware allocation planning, lifecycle reconciliation, manual admin allocation, reviewed removal, and approval state live behind focused services. Each `LodgeBed` carries a descriptive **bed type** (`SINGLE` / `BUNK_TOP` / `BUNK_BOTTOM` / `DOUBLE`) and an optional `bunkGroup` label; a group holds at most two beds — one top and one bottom — enforced in `admin-bed-allocation.ts` (serialised by a room-row lock, no partial index) and shown as an icon on the setup list and allocation board (#1675). Bed type is mostly descriptive, with one capacity exception (#1701): a **DOUBLE** bed may hold **two** occupants for a night when they are declared partners (two `ADULT` members holding a **CONFIRMED** `MemberPartnerLink` (#1742/#1744), the single-source `mayShareDoubleBed()` rule in `double-bed-sharing.ts`), added by an admin on the board onto a bed whose primary already holds capacity. Every other bed type stays one person per night. The bed-night uniqueness is `@@unique([bedId, stayDate, isSecondOccupant])` (≤1 primary + ≤1 second occupant) plus a raw-SQL partial unique index capping non-DOUBLE beds at exactly one (`WHERE "bedType" <> 'DOUBLE'`, in `prisma/partial-unique-indexes.tsv`); `BedAllocation.bedType` is a denormalized copy the partial index reads. The **base** capacity figure is unchanged — a shared double is still **one bed** of `activeBedCount` and each occupant is a full person-night — but each active DOUBLE adds one reserved, bounded **partner-shared admission slot** above it (#1745: `getLodgePartnerSharedCapacityStatus` + `checkCapacityForPartnerSharedAdmission`, admin-initiated only, never visible to public availability; see docs/CAPACITY_MODEL.md); auto-allocation never creates a second occupant. Beds may be pre-assigned on provisional statuses (`BED_ALLOCATABLE_BOOKING_STATUSES`) before a booking holds capacity, so the admin board tags each bed **Held** vs **Provisional** (#1251). The state is a server-computed flag from `bookingHoldsCapacity` (booking-status.ts) — not a per-row status check — because holding is no longer purely status-based: an accepted-but-unpaid quote is `PENDING` but holds (#1254). In the AUTOMATIC on-payment/confirmation reconcile (`bed-allocation-lifecycle.ts` → the planner's `prioritizeCapacityHolding` mode), **capacity-holding bookings get first claim**: they are allocated before provisional ones, and a held booking blocked only by a **Provisional** allocation moves that provisional aside (to a free bed) — or, if the night is otherwise full, unallocates it back to the awaiting-allocation queue — then takes the freed bed. A **Held** or admin-**approved** (#776 lock) allocation is never displaced, and displacement never strands a same-booking minor; each displacement is applied atomically and writes a `lodge` audit row on the displaced provisional booking (#1387). The planner keeps bed-night **capacity** (`bedId:stayDate` — is this bed taken?) separate from occupant **identity** (`bedId:stayDate:bookingGuestId` — who is in it?), because a shared DOUBLE holds two occupant rows on one bed-night, possibly from two different bookings (#2656): an eviction releases the physical bed-night only when no occupant remains, displacement credit is counted in beds actually freed rather than rows or bookings displaced, a bed-night whose occupants span two bookings is never a *single-bed* displacement target (the whole-stay room path instead makes every occupant a candidate and gains the bed only once ALL of them are being evicted — so both bookings on a shared double go together or the room is not chosen; see docs/CAPACITY_MODEL.md rule 3), and the apply path promotes any second occupant its displacements orphan and refuses to write onto a bed-night the database still shows as occupied rather than relying on `skipDuplicates`. The planner enforces the cross-booking age-mix invariant on every placement path (#1768): a room-night holding one booking's minors never also holds another booking's adult (in either direction), minors may fill rooms of their own once the booking has an adult on-site that night (the adult count no longer caps the rooms a large group fills), a SCHOOL-request booking rooms its adults together and its students separately (`isSchoolGroup`), and persisted violations surface as `MINOR_ADULT_MIX` board warnings. That automatic reconcile auto-places **only the reconciled booking's own** guests on its current nights (#1686): editing, confirming, promoting, or cancelling one booking never opportunistically drafts *other* bookings' guests into idle or freed beds — a cancellation's freed beds stay in the awaiting-allocation queue rather than being auto-refilled. It still loads lodge-wide occupancy so it can seat that booking whole-stay and displace blocking provisionals to seat a held booking (#1387/#1677); opportunistic lodge-wide re-planning of *everyone* is exclusively the explicit board action below. The manual board **Run auto-allocation** button (`runAutoBedAllocation`) runs pure first-fit and does NOT displace — only the automatic reconcile does. One further occupancy class has **no `BedAllocation` row at all** (#2286): a `HutLeaderAssignment` carrying a `bedId` is a **custodian bed hold**, which takes that bed out of both the bookable and the allocatable pool for every night from `startDate` to `endDate` *inclusive*, with no `Booking`, no `BookingGuest` and no allocation row anywhere (`src/lib/custodian-occupancy.ts` read side, `src/lib/custodian-assignment.ts` write side). It is counted as an **occupant** rather than as a smaller lodge, so `occupiedBeds + availableBeds === lodgeCapacity` still holds; it is fed to the planner as a #1768 blocking, never-evictable unknown occupant; and because nothing in the database enforces it, every placing write re-reads the live holds on its own client immediately before writing, inside the per-lodge advisory lock where it owns the transaction. `custodian-write-path-contract.test.ts` scans the whole `src/` tree and fails CI when a `bedAllocation.create*` site appears undeclared. See docs/CAPACITY_MODEL.md and DOMAIN_INVARIANTS.md. |
| Member-guest consent | `src/lib/member-guest-consent.ts`, `src/lib/member-guest-settings.ts`, `src/lib/booking-guests.ts` | Adding another club member as a guest ("+ Add Member Guest", epic #2305). `member-guest-consent.ts` is the pure model: the named widening predicate `MEMBER_GUEST_WIDENING_ENABLED`, the `FAMILY` / `BEYOND_FAMILY` boundary types, and the eight-shape consent sub-state table with its classifier. `booking-guests.ts` computes each prospective guest's boundary scope on **every** path — the admin `skipAuthorization` paths included — so no caller can end up persisting a consent-free cross-family row by default. Policy lives in the `MemberGuestSettings` singleton (`member-guest-settings.ts`, lazily created, read through the shared defaults in `src/config/club-settings-defaults.ts`) alongside the other club-settings singletons; its two open-search privacy toggles are excluded from config transfer. **The feature is live behind the `memberGuests` module** (MG2 #2307 turned MG1's dark constant into the per-club flag; MG3 #2308 added the finder; MG4 #2309 covered the edit path, admin parity and the booking-request pipeline). With the module off — the shipped default — a cross-family add is refused with the byte-for-byte pre-existing error and nothing writes a non-null `BookingGuest.consentStatus`, so a club that never opts in sees no change. Every persisting path plans its consent columns through the single writer in `member-guest-consent.ts` by way of `member-guest-add-policy.ts`, and every one of them dispatches its notifications AFTER the transaction commits. |
| Policy rules | `src/lib/policies/` | Pricing, age-tier, cancellation, change-fee, minimum-stay, member-credit, and booking-route decisions live as testable policy helpers. |
| Operational Xero | `src/lib/xero-*.ts`, `src/lib/xero.ts` | `src/lib/xero.ts` is a compatibility facade. New code should import from the focused module that owns the behavior, not from the facade. |
| Admin/member services | `src/lib/admin-member-xero-actions.ts`, `src/lib/member-serialization.ts`, `src/lib/member-lifecycle-actions.ts`, `src/lib/membership-cancellation-*.ts` | Shared admin/member request wrappers, DTO shape, lifecycle actions, and cancellation workflows live outside page files. |
| Business logic | `src/lib/` | Keep money in integer cents, dates as New Zealand date-only lodge nights, and external calls outside long database transactions where practical. |
| Database | `prisma/schema.prisma`, `prisma/migrations/` | Schema changes must include deployable migrations and respect the blue/green migration policy. |
| Operations | `scripts/`, `deploy/`, Compose files | Deployment helpers should be reusable by forks through environment overrides. |

### Bed-allocation preference resolution

`src/lib/bed-allocation-settings.ts` is the closed-vocabulary boundary and the
single effective-settings resolver for the board, explicit board run, and
booking-lifecycle reconcile. `BedAllocationSettings.id = lodgeId` is the
authoritative per-lodge row. During the expand-compatible transition, the
legacy `id = "default"` row applies only when it is unlinked or linked to the
same lodge; otherwise the resolver uses code defaults. A lodge never inherits
another lodge's row, and the settings API requires one active `lodgeId` for
both reads and writes. Reads require `bookings:view`; writes require
`bookings:edit` and use the standard per-section Edit → dirty Save/Cancel UI.

The ordered values are `BOOKING_COHESION`, `STAY_CONTINUITY`,
`REQUESTED_ROOM`, and `FAMILY_COHESION`. Missing settings use that historical
order; an explicitly saved empty array is valid neutral ordering. Invalid,
unknown, or duplicate persisted values fail closed instead of silently
changing planner behavior. Preferences are lexicographic after hard placement
count and invariant scores: the split matcher maximizes guest-night cardinality
for each bounded candidate, and at most 24 matching-layout candidates are
executed per booking. Those candidates include a capacity-aware, direct-family
high-affinity packing order as well as connected-component, direct-group,
direct-pair, and maximum-cardinality pairing orders. Whole-room, legacy, and
displacement trials remain
separate and may scale with room count. The overall booking-first planner is a
bounded deterministic heuristic, not a global optimum across all bookings.
Changing preferences affects future suggestions and lifecycle reconciliation;
it never rewrites existing allocation rows by itself.

Migration `20260806020000_add_bed_allocation_priority_order` is an additive
EXPAND on the cold settings table: one non-null `TEXT[]` column with the
historical constant default. Old-colour clients omit and ignore it; old-colour
inserts receive that default; no `BedAllocation` row is touched or replanned.
The exact lock/rollback and migration-prefix coordination statement is recorded
in [`BLUE_GREEN_MIGRATION_SAFETY.tsv`](BLUE_GREEN_MIGRATION_SAFETY.tsv).

### Reviewed bed-allocation removal

`src/lib/bed-allocation-removal.ts` owns the destructive #2594 contract. The
single `/api/admin/bed-allocation/allocations/removal` route uses `POST` for a
read-only preview (`bookings:view`) and `PUT` to apply exactly that preview
(`bookings:edit`). The four scopes are one anchored allocation, one person on
one booking, a whole booking, and one lodge's half-open visible window (at most
31 NZ lodge nights). Person and booking scopes intentionally include off-screen
rows; window scope never does. The three mutually exclusive row categories are
unapproved `AUTO`, unapproved `MANUAL`, and approved regardless of source.

The `v1:<sha256>` digest binds the canonical scope and sorted categories to the
mutable identity of every matching row, every approved row on an affected
booking, and every surviving shared-double second occupant whose primary would
be removed. Apply first resolves the booking's immutable lodge plus the
reviewed anchor lodge, then takes global `lock(1)` → sorted lodge locks →
sorted `BedAllocation` row locks. Expanded bed-night, row-lock, delete, and
promotion queries are split into deterministic 10,000-value chunks so supported
booking scopes cannot cross PostgreSQL's 65,535 bind-parameter ceiling; all
chunks remain in the same transaction and sorted lock order. An authoritative under-lock check refuses any
historical third-lodge anomaly rather than deleting it without that lodge's
lock. Apply rebuilds the preview under those locks and refuses with a refreshed
preview when the anchor or digest drifted; an aggregate booking/person preview
whose opening row disappeared is re-anchored to the lowest-id matching survivor
so the refreshed preview can be reviewed and applied. A successful transaction deletes the exact
rows, promotes causal shared-double occupants, and writes the bounded
`BED_ALLOCATION_REMOVAL_APPLIED` plus (when needed)
`BED_ALLOCATION_PARTNERS_PROMOTED` audits together. It does not call either
planner: freed nights stay unallocated until a later explicit admin action.

Approval is a lock-compatible counterpart. A lodge-scoped approval locks that
one immutable lodge; the supported legacy club-wide selector conservatively
locks the sorted immutable superset of all lodge ids before it locks matching
allocation rows, then re-applies its `approvedAt: null` selector. Requested-room
writes take the same global key plus the booking row, re-read the requested room
after those locks and the authority check, and keep a guarded
"no approved allocation exists" predicate for member writes. Consequently a
removal cannot race an approval or room-request edit into an outcome no actor
reviewed: one transaction wins, and the other re-reads or fails its guard.

The old `DELETE /api/admin/bed-allocation/allocations/[id]` route is retired.
The board chip/pool drop, board **Reset allocations…**, and booking-detail
**Remove** action all open the shared
`src/components/admin/bed-allocation-removal-dialog.tsx`; none keeps an
optimistic or per-night delete path.

### Reviewed bed-allocation moves

`src/lib/bed-allocation-move.ts` owns the #2595 move contract. Read-only
`POST /api/admin/bed-allocation/allocations/move` requires `bookings:view` and
returns an authoritative preview. `PATCH
/api/admin/bed-allocation/allocations` accepts an exclusive union: the reviewed
shape carries `anchorAllocationId`, `destinationBedId`, `scope`, and
`previewDigest`; the unchanged legacy `{ allocationIds, bedId }` path remains
available to older callers and remains capped at the 31-night board window.
Reviewed apply requires `bookings:edit`.

The reviewed scopes are exactly one existing allocation night or every
existing row for the same booking guest (up to 366), including sparse and
off-screen rows. They never create a missing guest-night or allocation. The
preview separates changed and unchanged rows, shows approval-to-draft and
shared-double promotion consequences, and reports every hard refusal without
exposing counterpart guest identities. Its `v1:<sha256>` digest binds the
scope, anchor, destination, complete selected and relevant occupant sets,
exact guest nights, booking and consent state, active/member age facts,
confirmed partner links, custodian and whole-lodge holds, promotions, and the
derived conflict result.

Apply takes global -> complete sorted lodge union -> sorted member-lifecycle ->
sorted member-partner-link -> deterministic allocation-row locks, then rebuilds
and compares that preview. It uses guarded updates and one transaction for
every move, shared-double promotion, and bounded aggregate audit. Changed rows
are applied by one guarded `UPDATE ... FROM (VALUES ...)` statement under an
explicit 30-second transaction/10-second acquisition budget, and become
unapproved `MANUAL` drafts while unchanged rows remain byte-for-byte
untouched. An all-noop confirmation is successful and audit-free. Drift returns
a refreshed 409 preview and requires a second confirmation; no planner runs.

Every drag/drop destination and chip **Move to bed** item opens
`src/components/admin/bed-allocation-move-dialog.tsx`. That is the only board
move write seam: there is no optimistic or direct typed move. One pointer or
keyboard interaction opens one dialog, the current bed remains selectable for
person-scope consolidation/noop review, and closing or succeeding restores
focus to the originating chip/menu control. The in-booking allocation panel
does not expose these move scopes.

The largest current files are historical consolidation points rather than a
preferred style. When changing them, extract focused helpers around the code
being touched and keep tests close to the extracted domain helper so public
adopters can find the contract without reading the whole application.

### Xero integration layers

`src/lib/xero.ts` is a compatibility facade (re-exports only) for older
imports. Prefer direct imports from the focused modules below for new code.
[`docs/xero/ARCHITECTURE.md`](xero/ARCHITECTURE.md) maps the subsystem in
depth: runtime dataflow, ledger data model, and sequence diagrams for the
outbound-document, inbound-reconciliation, and repair flows.

| Concern | Focused modules | Notes |
| --- | --- | --- |
| Infrastructure | `xero-oauth`, `xero-token-store`, `xero-api-client`, `xero-mappings`, `xero-sync-cursors` | OAuth, encrypted tokens, metered/retried API calls, mapping lookup, and sync cursors. |
| Contacts | `xero-contacts`, `xero-contact-cache`, `xero-contact-groups`, `xero-duplicate-contacts`, `xero-bulk-contact-sync`, `xero-member-import` | Contact CRUD, local caches, managed groups, duplicate suggestions, bulk sync, and member import. |
| Membership | `xero-membership-sync` | Subscription invoice discovery, status checks, history flushing, and linked-contact sync. |
| Invoice documents | `xero-invoice-helpers`, `xero-invoice-payments`, `xero-booking-invoices`, `xero-credit-notes`, `xero-supplementary-invoices`, `xero-modification-credit-notes`, `xero-entrance-fee-invoices` | Booking invoices, entrance-fee invoices, supplementary invoices, payments, refunds, credit notes, and allocation helpers. |
| Operations and admin support | `xero-sync`, `xero-operation-outbox`, `xero-operation-retry`, `xero-operation-queue`, `xero-record-activity`, `xero-record-links`, `xero-hardening`, `xero-inbound-reconciliation`, `xero-booking-repair`, `xero-contact-link-mismatches`, `xero-contact-sync`, `xero-booking-edit-settlement`, `xero-admin-cache`, `xero-admin-failures`, `xero-admin-health`, `xero-api-usage`, `xero-api-errors`, `xero-config`, `xero-error-alert`, `xero-error-shape`, `xero-feature-flags`, `xero-links`, `xero-oauth-state`, `xero-record-types` | Existing boundaries for queues, reconciliation, repair tooling, admin health, diagnostics, config, links, and error handling. |

### Booking lifecycle boundary

`src/lib/booking-create.ts` owns booking creation orchestration after route
validation: capacity locking, pricing, promo/member-credit decisions,
persistence, audit, emails, and Xero queueing. It keeps the three creation
orchestrators (`createDraftBooking`, `createConfirmedBooking`,
`createWaitlistedBooking` — the advisory-lock transactions, person-night guard,
and capacity checks) and re-exports the pure helpers now split into
`src/lib/booking-create-types.ts` (shared input/result types and errors),
`src/lib/booking-create-promo.ts` (promo/pricing resolution), and
`src/lib/booking-create-guests.ts` (guest-persistence, capacity-range, and
admin-review helpers), so `@/lib/booking-create` keeps its exact import surface.
`src/lib/booking-modify.ts` owns
the modification boundary for date/guest/promo changes and delegates reusable
decisions to helpers and `src/lib/policies/`. It is a barrel over three
modules split out in issue #1138 — `booking-modify-validation.ts`
(edit-eligibility gates and shared loaded types), `booking-modify-plan.ts`
(the in-transaction guest/pricing/promo pipeline), and
`booking-modify-settlement.ts` (settlement handoff and lifecycle
transitions) — so importers keep using `@/lib/booking-modify` unchanged.

`src/lib/booking-payment-cleanup.ts` queues superseded Stripe PaymentIntents
when booking edits replace or zero out pending payment work.
`src/lib/payment-recovery.ts` is the durable recovery queue that cancels open
intents, treats already-cancelled intents as complete, and refunds late
captures without re-entering the normal booking-confirmation path.

### Admin/member layer

`/admin/stuck-states` is the consolidated operator queue for cross-domain
recovery visibility. `src/lib/stuck-state-dashboard.ts` aggregates local
payment recovery, operational Xero, email deliverability, waitlist,
bed-allocation, hut-leader, and issue-report signals into severity, owner, and
target links without making live provider calls during page render.
`src/lib/booking-provider-mismatches.ts` answers the same provider-divergence
questions for a single booking (paid with no completed Xero invoice operation,
Stripe refund with no Xero credit note, waitlist offer whose email needs
operator action) and feeds the amber "Provider state out of step" block on the
booking detail Admin tools card — read-only detection mirroring the
stuck-state queries.

Admin settings sections follow one canonical edit model (developer rule, binding
for new or modified sections; `AGENTS.md` → Change Discipline and its routing
table both send you here for it, and this page is where it is stated in full).
A section
renders read-only on mount and stages every change behind a per-section Edit →
Save/Cancel step: no individual control auto-persists on toggle, Cancel reverts
to the last saved snapshot, and Save writes once. Save is **dirty-gated as well
as view-gated**: booking write routes log an audit entry and revalidate public
content unconditionally, so a pristine re-save would record a change that never
happened (#2143). That gate belongs at the FORM layer, through the hook's
`isDirty` — routes deliberately keep no ad-hoc no-op comparison, so a direct API
caller holding `area:edit` can still write an unchanged body. Edit affordances
gate on the tri-state `useAdminAreaEditAccess(area)` through
`ViewOnlyActionButton` / `AdminViewOnlySectionBanner` (so the resolving
`undefined` window stays neutral), and the backing write route enforces the
matching `area:edit` permission. The section renders an
`AdminViewOnlySectionBanner` and its buttons pass `describeReason={false}`:
the view-only reason is then stated once, at the top of the section, in a
permanently-mounted `role="status"` region, rather than on disabled buttons that
are out of the tab order and whose `title` never fires at all (the shared
`buttonVariants` set `disabled:pointer-events-none`). That region
gates only the content, because a polite live region injected already-populated
is silently dropped by some screen-reader/browser pairings.
"Permanently mounted" is a
POSITION rule as much as a rendering one, and it covers `PolicyFeedback`'s
`role="alert"` / `role="status"` pair too: the section has a FRAME — banner,
feedback regions, and, where the fetch is scope-keyed, the scope select — that
is rendered in EVERY state, with only the cards below it swapped. A loading
early return above that frame re-creates both defects it exists to prevent: a
failed FIRST load mounts the section together with an already-populated alert in
one commit, and because a scope change is itself a load it unmounts the
`PolicyScopeSelect` the admin just operated, dropping keyboard focus to `<body>`
for the duration of the round trip. That banner shape started in the five
Booking Policies sections (#2142) and is now the **default across the admin
tree** (#2160, extended by #2168 and #2324) — not a claim that nothing is left.
Measured
on the current tree by `view-only-banner-contract.test.ts`, which asserts these
figures rather than trusting a hand count: **84 components render a banner, and
268 of the 319 `ViewOnlyActionButton` call sites opt out** of the per-button
reason. (Earlier revisions of this page published 76/232/264/211 — those were
upstream-historical and had drifted; the numbers here are the ones the contract
test currently pins, which is the only authority.) Those 268 split by WHICH rule
covers them: **237** pass the literal
`describeReason={false}` and are covered by a banner in the same file, and **31**
pass `describeReason={!ancestorRendersViewOnlyBanner}` and are covered by a
verified vouching parent — 26 by a parent's own JSX render site (#2168), 5 by the
guided-setup shell (#2324); see *Vouching for a child's coverage* and *Vouching
through the wizard shell* below. The
remaining **51 controls across 28 files deliberately keep the per-button
default** (`describeReason` left at `true`), in three shapes:

- **Controls inside a dialog, sheet, popover, or dropdown menu.** These live in
  a separate accessibility container — focus is trapped and the page behind is
  commonly inert — so a banner rendered in the page body does not reach them.
  (10 controls across 5 files, including the confirmed bed-allocation move
  dialog, which the test enumerates by name; three further
  controls of this shape live in files counted under the next bucket, see
  there.)
- **Leaf components with no section of their own**, which a parent drops into
  someone else's layout (for example the member detail header's action toolbar,
  the booking capacity/exclusive hold controls, the family-group login-holder
  and request-review sub-sections, and the non-member contact form). Nothing
  local proves an ancestor renders a banner above them, so the reason stays on
  the control. (37 controls across 22 files.) Nine of those 37 sit inside a
  setup wizard and are **scope** exceptions rather than indirection ones: each is
  gated on a permission NARROWER than the banner its shell renders, so an admin
  who has the wizard's area but not that narrower one meets no banner at all.
  Eight are new to this bucket with #2324, and are the four provider wizards'
  credential-ish writes — Xero credentials and webhook key, Stripe keys and
  signing secret, Google credentials and verify, the backups credentials and
  destination — all of which additionally need Full Admin. The ninth, the Lodge
  Display wizard's `support`-gated module switch under a `lodge` banner, has been
  an exception since #2249 and stays one for the same reason; #2324 moved its
  three lodge-gated siblings out of this bucket and into the vouched one. Before
  those, the per-booking "No emails" switch (#2259), dropped into the Admin tools
  card's layout beside the capacity and exclusive holds. Newest are the
  cash / off-Xero payment feature's four controls (#2262): Record and Reverse
  manual payment, a leaf dropped into that same Admin tools card, and the
  manual-refund-task queue's Mark-paid-back and Dismiss pair, a card on the
  Payments page with no banner of its own. Read that
  bucket as the
  REMAINDER — everything that is neither a member detail card nor one of the
  five dialog-only files — rather than as a claim that all 36 are leaves.
  Thirteen of the twenty-one files are (24 controls); six are the wizard step
  files just described (9 controls); and the last two, `page-content-panel.tsx`
  and `site-banners-panel.tsx`, are full banner-bearing panels whose last 3
  controls sit inside their own edit/create `Dialog`, so those 3 are really the
  first shape occurring inside a file that also has the third. Nothing is
  mis-gated either way — the point is only that the bucket boundary is where the
  test can draw one mechanically, not a clean taxonomy.
- **A member detail per-record card gated on a DIFFERENT permission area than
  the page banner** — today exactly one: `member-credit-card.tsx` (4 controls
  across 1 file). The other eight cards in
  `src/app/(admin)/admin/members/[id]/_components/` were converted under #2168
  and now take their coverage from the page banner. The credit card did not,
  and that is deliberate rather than a leftover: the page banner states the
  **membership** area, the credit card's controls are gated on **finance**, so
  vouching for it would name the wrong permission — and an admin with membership
  edit but finance view-only would meet no banner at all while looking at four
  dead buttons. Any second banner for the finance scope would break the owner's
  one-banner-per-page decision and trip the nesting rule, so the per-button
  reason stays. Bucket by SCOPE, not by folder, when reading this figure.

Every figure in this section is asserted mechanically by
`src/components/admin/__tests__/view-only-banner-contract.test.ts` — the totals,
the static/vouched split, and all three buckets — so they can not drift out of
step with the tree. Since #2168 the figures themselves are counted over the
parsed AST, where an attribute is a node and prose is trivia, so a
`describeReason={false}` written in a comment cannot reach a total at all. That
was the miscount to beat: both `view-only-action.tsx`'s JSDoc and
`public-booking-requests-section.tsx`'s JSX commentary quote
`describeReason={false}` while explaining it, and each was counted as an opt-out
once. The text-based assertions in the same file still strip comments first, and
that stripper runs TypeScript's own PARSER, not its scanner: a bare
`ts.createScanner` cannot resume a template literal after a `${…}` substitution
(that is the parser's job), so a ``className={`…${…}`}`` above a JSX comment
opened a bogus template that swallowed the comment's opening `/*` and left its
quoted `describeReason={false}` in the "code" the text checks read — which is
how `public-booking-requests-section.tsx` slipped past the stripper a SECOND
time, caught and fixed in #2166. If you add or convert a gated control, that
test fails and the numbers here, in `AGENTS.md`, in `docs/STYLE_GUIDE.md` (which
publishes the exception TOTAL only), in
`CHANGELOG.md` and in the `ViewOnlyActionButton` JSDoc all need updating
together.

**Banner or Notice: which component states the reason.** Two components are
live here and they are not two names for one thing, which is why both appear in
this page and in `AGENTS.md`. Since #2160 the **`AdminViewOnlySectionBanner` is
the default for the admin tree**: a section that gates controls through
`ViewOnlyActionButton` heads them with one banner and passes
`describeReason={false}`, so the reason is stated once, in the reading order,
ahead of the controls. `AdminViewOnlyNotice` — the older, per-section notice —
is **retained deliberately in three cases**, and a developer who deletes one on
sight removes an explanation nothing else gives:

- **A surface that states view-only access WITHOUT gating a control through
  `ViewOnlyActionButton`.** With no gated control there is nothing for the
  banner to head.
- **A section whose Notice is CONDITIONAL on no ancestor covering it.**
  `member-lodge-access-card`, `member-committee-assignments-card` and
  `member-seasonal-membership-card` each render their Notice only when
  `ancestorRendersViewOnlyBanner` is false (#2168), so the member detail page —
  which banners the whole page — sees no Notice, while the same card rendered
  anywhere else still states the reason itself. The lodge-access Notice also
  covers disabled CHECKBOXES, which are not `ViewOnlyActionButton`s and which no
  banner rule reaches; that is why it is kept rather than deleted.
- **A NARROWER permission scope nested inside a section the banner already
  heads.** The banner states the section's own scope once at the top; a Notice
  further down carries a DIFFERENT permission's reason for a subset of the
  controls, so the two are not the same statement and the Notice is not
  redundant. `backups/backups-client.tsx` is the clearest example — a
  support-scoped banner heads the page, and the Credentials card carries a
  Full-Admin-scoped Notice ("Only a Full Admin can set backup credentials") for
  the fields only a Full Admin may write — and
  `subscription-lockout-settings-panel.tsx` does the same with a finance-scoped
  Notice over the subscription account and item codes inside a
  membership-scoped section. Both render banner AND Notice AND gated buttons at
  once.

**Having both components in one file does not make it the third case.**
`fees/_components/hut-fees-section.tsx` is the example to keep straight: its
banner and its Notice are MUTUALLY EXCLUSIVE by construction
(`{!forbidden && viewOnlyBanner}` against
`{forbidden && <AdminViewOnlyNotice canEdit={false}>}`), the Notice is the
stronger *you cannot even read this section* statement, and the `forbidden`
branch renders no controls at all — so it is the FIRST case, in a branch, not a
narrower scope nested under a banner. The file's own comment says showing both
"would contradict itself". The test to apply is not "does this file have both
components?" but "can both appear at the same time, naming different
permissions?".

So "a section with gated controls replaces its Notice with the banner" holds
only for a Notice covering the SAME scope. Before deleting a Notice from a
section that has a banner, check which permission its text names — if it is not
the banner's, it is carrying a reason nothing else states. The nesting rule
further down is banner-to-banner and does not forbid the third case: a Notice
under a banner is not the same sentence twice. This distinction is also stated
next to the code, in `AdminViewOnlySectionBanner`'s JSDoc in
`src/components/admin/view-only-action.tsx`, which is where a developer meets it
while writing; the two are the same rule and must be changed together.

**Vouching for a child's coverage (#2168).** The coverage rule below is asserted
per FILE, which the member detail page cannot satisfy: the owner's decision is
ONE banner for that page, so the banner is in `page.tsx` and the opt-outs are in
the card files. The rule was **not** relaxed to allow that — "some ancestor
might render a banner" would reopen the orphan-opt-out hazard the rule exists to
prevent. Instead a parent gets an explicit way to vouch, and the vouch is
verified:

- the child declares `ancestorRendersViewOnlyBanner?: boolean` (the shared
  `AncestorViewOnlyBannerProps` in `view-only-action.tsx`), **defaults it to
  `false`**, and writes `describeReason={!ancestorRendersViewOnlyBanner}`;
- a covering parent passes the literal `true` at the render site.

The default is the safety property, not the documentation: the opt-out cannot
happen unless a parent asks for it, at the line a reader sees. A card rendered
standalone, in a dialog, or by a new parent keeps its per-button reason
automatically, and so does a NEW gated control added to a converted card.

This is the mirror of `renderViewOnlyBanner` (#2160), and the two compose: there
a component owns a banner and a covering parent suppresses it; here a component
owns no banner and a covering parent vouches that it renders one. Both default
to the self-sufficient behaviour.

The contract test then closes each way the vouch could be a lie:

- `describeReason` accepts **only** the literal `{false}`, the vouched
  `{!ancestorRendersViewOnlyBanner}`, or the `true` default. A third spelling
  fails, so no coverage rule can be escaped by inventing one. #2324 added a
  third *rule* without adding a third spelling — see *Vouching through the
  wizard shell* below.
- the child must default the prop to `false`, and may read it only in
  `describeReason={!prop}` or as the guard on its own `AdminViewOnlyNotice`. It
  may not FORWARD it, so coverage never becomes transitive across a hop the test
  does not check.
- the vouching parent must render the banner — the element, or the hoisted
  `const` idiom — in the **same returned JSX tree** as the child, reached
  **unconditionally** (no `? :`, no `&&`, no callback). A banner that appears
  only in some states does not cover a child that appears in all of them.
- the vouch value must be the literal `true`, and a JSX spread at a vouched
  child's render site fails outright, because `{...props}` could carry the prop
  invisibly past every other check.
- wherever the attribute NAME appears, its tag must resolve to a known vouched
  child through a named import. An aliased, default, barrel or dynamic import
  fails here rather than quietly leaving the vouch unverified — the one blind
  spot the nesting check still has is closed for this mechanism.
- a child that declares the prop but is never vouched for anywhere fails too, so
  the plumbing cannot sit there implying coverage that never happens.
- the covering banner's `canEdit` may not be the literal `true` (nor a bare
  `canEdit`, which JSX reads as true). `AdminViewOnlySectionBanner` emits its
  sentence only when `canEdit === false`, so a banner hardcoded editable renders
  an empty live region and orphans every opt-out beneath it.

What it does **not** prove, and reviewers must still check. The checks establish
that the banner ELEMENT renders; they say nothing about whether it ever
DISPLAYS. The gap holds four things:

- **which permission area the parent's banner names.** A parent vouching with a
  banner for a different area is a real defect no static check here can see — it
  is exactly why `member-credit-card` is excluded above, and the reasoning is
  written at the render site as well as here.
- **source ORDER**, so "the banner precedes the controls it explains" remains a
  review concern.
- **whether `canEdit`'s expression can ever be false.** Only the literal is
  rejected; a non-literal expression that never resolves to false produces the
  same orphaned opt-outs at runtime.
- **whether the banner has `children`.** A vouching banner with none passes
  everything, and its page-specific sentence silently degrades to the generic
  shared heading.

Two scope limits apply to the whole contract test, not only these checks: it
scans **only paths containing `admin`**, so a vouching parent or vouched child
moved outside one would become invisible to every check (zero such files exist
today); and the vouched-child rule reads `describeReason={!prop}` on any
component, not only `ViewOnlyActionButton` — not exploitable, since no other
component declares the prop and a planted use fails to compile, but worth
knowing when reading the check. The behavioural
half — that an unvouched card really does keep its reason, and a vouched one
really does drop it while staying disabled — is verified by rendering the real
components in `src/lib/__tests__/admin-view-only-controls.test.tsx`, so a bug in
the static analysis cannot make the property vacuous.

**Vouching through the wizard shell (#2324).** The #2168 mechanism is verified at
the child's JSX render site, and the shared guided-setup shell
(`IntegrationWizard`, #2080 — the frame behind the Xero, Stripe, Google, backups
and Lodge Display setups) structurally cannot use it. A step is supplied by the
provider's config as a `render(context, helpers)` callback and **called from the
shell's file**, so nowhere in the source does a parent element sit above a step's
control. Both coverage rules were blind to the relationship, and the result was a
shared frame where the easiest thing to write was the least accessible one: the
Lodge Display steps carried per-button reasons and sat in the exception list,
while the other four wizards used plain disabled `Button`s that said nothing at
all and were invisible to the contract test.

Owner decision on #2324 (option **A + A1**, all five flows in one change) closed
it **without a third `describeReason` spelling** — there are still exactly two,
and a third still fails. What is new is the CHANNEL the existing vouch travels
down:

- `WizardStepHelpers` carries `ancestorRendersViewOnlyBanner`, typed as the
  **required literal `true`**. The shell therefore cannot hand a step a false
  vouch, and a provider cannot fabricate one from something weaker — the forward
  is compiler-proved, not merely plausible.
- the shell sets it, because it renders the banner in **every** branch, the
  loading early-return included.
- a provider config forwards it at the step's render site as
  `ancestorRendersViewOnlyBanner={helpers.ancestorRendersViewOnlyBanner}`, where
  `helpers` is that `WizardStepConfig.render` callback's own second parameter.
- the step body then reads it in the ordinary #2168 shape: a prop defaulting to
  `false`, used only as `describeReason={!prop}`.

Decision A1 is what keeps the blast radius small, and the test enforces it: the
channel is honoured **only** inside a real `WizardStepConfig.render` — an object
literal that also declares `id` and `isVerified`, both required members of
`WizardStepConfig` — read from that callback's own parameter, in a file that
really renders `<IntegrationWizard>` with a non-literal `canEdit` and its own
`viewOnlyBanner` sentence. The shell's half is re-proved rather than trusted: the
flag's type and requiredness, the shell setting it to `true`, and an
unconditional banner in every branch the shell can return. A JSX spread at the
render site fails, and the child must still resolve through a named, non-aliased
import to a file that declares the prop with a `= false` default.

**Scope, for this channel only, is mechanical.** #2168 cannot check scope: a
vouching parent's banner and its child's `canEdit` are two unrelated expressions
in two files, and whether they name the same permission area is a judgement. The
wizard channel is different, and this is the one real guarantee it buys. The
shell passes **one** `canEdit` to both the banner and `helpers`, so a step
control that reads `canEdit` from that same `helpers` object shares the banner's
value *by construction* — the two cannot disagree, because they are the same
value. The contract test enforces exactly that, in two halves that only mean
something together:

- inside a wizard-vouched component, a control that opts out via the vouch must
  read `canEdit` off an identifier the component received as a parameter whose
  DECLARED type is `WizardStepHelpers` — not from an independent source, and not
  merely off "some parameter" (which would accept a second, independently derived
  access flag with a different scope, the very defect this catches); and
- **only the shell may construct a `WizardStepHelpers` at all.** Outside
  `integration-wizard.tsx`, an object property named
  `ancestorRendersViewOnlyBanner` and an object literal annotated
  `WizardStepHelpers` (`: T`, `as T`, `satisfies T`) both fail the test. Without
  this, a provider config could mint its own helpers object with the vouch set to
  `true` and hand it to a step body — satisfying every other check while no
  banner rendered anywhere. Step unit tests are outside the scan, deliberately:
  they must build a helpers object to render a step at all, and they cannot make
  a production step opt out (the step's own `= false` default is what covers
  that).

A control that calls `useAdminAreaEditAccess(...)` itself therefore cannot be
vouched for even by accident — it is neither a parameter nor typed as the
helpers — which is precisely the mismatch this issue's review flagged.

What stays a review call is the other direction: deciding a control should **not**
take the vouch. Five controls take it today: the Lodge Display wizard's
restore-boards, save-lodge-details and pair-the-screen (all reading the wizard's
`lodge` access) and the backups wizard's turn-it-on and run-verification (both
`support`). Nine keep their own reason because their gate is NARROWER than the
area their wizard's banner names, and they now say which permission that is: the
Xero, Stripe, Google and backups
credential-ish writes additionally need **Full Admin** on top of the wizard's
area, and the Lodge Display module switch is **support**-gated under a `lodge`
banner. Before #2324 eight of those nine were plain disabled `Button`s carrying
no per-control explanation at all.

Those nine also state the narrower reason **visibly**, in their step's own prose,
and that is not redundant with the per-control reason: a disabled button's
`title` never fires (`disabled:pointer-events-none`) and its `aria-describedby`
line is not visible, so the two serve different readers. What the visible half
must not do is guess. The Xero, Stripe and Google Full-Admin flag is derived from
the session rather than from the wizard's own fetch, and reading an unresolved
session as "not a Full Admin" made those notices appear and then vanish for an
actual Full Admin; it is now tri-state (`boolean | undefined`) like every other
edit-access signal (#2065), so the notice renders only on a resolved `false`.
The backups equivalent (`canManageDestination`) comes from the server fetch the
shell already waits on, so it was never able to flash.

The mirror-image edit went with it: **a step must not repeat what the banner
already says**, and two sentences in the backups steps did. "You need support
edit access" beside the verification button and "your admin role can view these
settings but cannot change them" beside the nightly-backups switch both stated
the wizard's own `support` scope — exactly what the banner above them states,
once, in the reading order. Both were also keyed off `!canEdit` rather than
`canEdit === false`, so both appeared for a moment even for an admin who *can*
change those settings. Both are deleted; the vouched buttons under them now lean
on the banner. That is the general rule from #2160's `AdminViewOnlyNotice`
guidance — stated above under *Banner or Notice* — applied to a wizard step: keep
a second sentence only when it names a DIFFERENT permission from the banner's
(which is exactly what the nine exceptions above do).

Two things were deliberately left alone. `xero/_components/connection-status-panel.tsx`'s
connect / reconnect / disconnect buttons ARE finance-gated, matching the Xero
wizard's banner, but the panel is a GRANDCHILD (the Connect step renders it) and
is also used standalone outside the wizard; forwarding the vouch through two hops
is forbidden, so its plain `Button`s stay. And the disabled `Input`s and
`select`s inside the wizard steps stay as they are — this contract polices
`ViewOnlyActionButton`, and text inputs have never been in its scope.

The behavioural half is checked independently of the static analysis, in
`src/components/admin/integration-wizard/__tests__/integration-wizard.test.tsx`:
the real shell is rendered and asked whether the banner is mounted in the
loading branch as well as the loaded one, whether the helpers really carry
`true`, and whether a step control that uses the vouch drops its reason while
STAYING disabled. Gating never depends on the flag; only who states the reason
does.

**Where the banner goes: first child, every branch.** The banner is the first
child of a section's outermost wrapper, rendered identically in the loading,
error and loaded branches. The "every branch" half is asserted mechanically, per
component and over the AST: a loading-guarded branch must mount the banner, and
so must every branch below the first one that mounts it. (Terminal branches
ABOVE the first mount — `lodge-details-panel`'s `accessDenied` and `multiLodge`
returns, say — carry no banner on purpose: they explain in their own words that
the section is unavailable, and there are no controls there to gate.) That
position is load-bearing, not cosmetic: it is
what keeps the `role="status"` wrapper at the same place in the DOM when a fetch
settles. Put a heading above the banner in the loaded branch only, and React
reconciles child 0 from the live region into the heading and mounts a fresh,
already-populated region below it — the exact defect the mount-order rule exists
to prevent. Two pages, `/admin/book` and `/admin/roster`, put their page heading
above the banner instead, so a screen-reader user hears which area they are on
before hearing that it is view-only; both render in a single branch, so the
reorder costs nothing there. That is a local exception with a comment at each
site, **not** a rule to spread: other single-branch sections have deliberately
been left alone rather than make the banner's position depend on whether a
section happens to have a loading branch, which is not visible at the render
site. Making heading-before-banner uniform would mean moving the announcement
out of the sections entirely (for example, one banner in the admin shell below
the page title) — a design change with a visible-UI consequence, and a fresh
owner decision rather than something to retrofit page by page.

Two further invariants are enforced by the same test. First,
coverage: a file may only use `describeReason={false}` if it also renders an
`AdminViewOnlySectionBanner`. That is asserted per FILE, because that is the
only scope in which a reader — and the test — can see that the banner really
does render above the control. The single sanctioned way out of that scope is
the #2168 vouching prop described above, which replaces the missing local proof
with a checked one rather than dropping the requirement. Second, and because the
coverage rule is by
construction blind to it, **nesting**: a component that renders a banner may not
also render a child component that renders one, or a view-only admin meets the
same sentence twice in two `role="status"` regions. Where a child is legitimately
reused in a container no ancestor banner reaches (a dialog), it keeps its own
banner by default and the covering parent passes `renderViewOnlyBanner={false}`
at the render site — `FamilyGroupEditor` is the worked example: banner-bearing
inside the member-detail dialog, suppressed on `/admin/family-groups`, which
already banners the whole page. The check reads EVERY render site of the child,
not just the first, so a second copy added below a compliant one can not ride on
it. It follows the house import style (a named import rendered as `<Child …>`)
and would not see a component reached by an aliased or default import, a barrel
re-export, or `next/dynamic`; none are used for banner-bearing admin components
today, but a refactor to one of those forms would quietly take the pair out of
the test's view rather than fail it.

**Once per section, NOT once per screen.** The nesting rule is about parent and
child — one banner covering the same controls as another — and that is all it
is. It does not, and structurally can not, say anything about SIBLINGS. Several
banner-bearing sections sitting side by side on one page each render their own,
so a view-only admin meets the sentence once per section: `/admin/security`
(`password-policy-card`, `magic-link-security-card`, `google-security-card`) and
`/admin/booking-requests` (approvals, change requests, public requests) show it
three times each, and `/admin/appearance/identity`,
`/admin/induction/settings` and `/admin/page-content` twice. That is inherited
from the #2142 shape rather than introduced by the rollout, and nothing in the
contract test flags it. Whether stacked sibling banners should collapse into one
page-level banner is still an open design question with a visible-UI
consequence. **#2168 answered it for the member detail page only** — one banner
there, with the eight membership-scoped cards vouched for — and deliberately did
NOT generalise the answer to sibling stacking elsewhere. The vouching mechanism
it built is what a settings page would need to collapse its siblings, so the
tooling now exists; whether to use it is a fresh owner decision, because the
sibling case differs in kind (side-by-side sections of equal weight, each with
its own scope, rather than one page's worth of per-record cards). Until that is
decided, do not dedupe siblings ad hoc, and do not write docs that promise one
banner per screen.

**Known limitation, accepted by the owner as Decision 1 on #2160.** Gated
controls keep the `disabled` attribute rather than moving to
`aria-disabled="true"`, so they remain **out of the keyboard tab order**. The
banner puts the reason in the reading order ahead of the controls; it does NOT
make those controls focusable, and a keyboard user still cannot tab to a gated
button to discover it. That was weighed against the cost of making every gated
control clickable-but-neutralised (each call site's click path would need
auditing so no write slips through) and the banner was judged the better trade.
Revisiting it is a fresh owner decision, not a silent edit — the contract test
asserts `disabled` is still what ships. Any card
that shares a strict whole-object PUT with a sibling card must GET the fresh
settings and merge only the fields the admin actually CHANGED before writing, so
a save cannot overwrite a change made while the page was open. Merging its own
fields is not narrow enough on its own: it protects the fields the card does not
own, but a field the card DOES own and the admin never touched still goes out
from a stale draft and reverts whoever moved it. Send the changed fields only —
the schema still receives every field, the untouched ones just come from the
fresh read. Where the card owns both halves of a cross-field rule, re-check the
COMPOSED pair after the fresh read: sending only the changed half can assemble a
pair the admin never saw. This NARROWS the
read-modify-write window to the milliseconds between that GET and the PUT; it
does not close it. There is no ETag or `If-Match` on the route, so two genuinely
simultaneous writes still resolve last-writer-wins — the same property the
`/api/admin/modules` precedent has. Do not write it up as a guarantee. That
covers the module toggles
sharing `PUT /api/admin/modules` (for example the magic-link and Google cards on
`/admin/security`) and all three cards sharing
`PUT /api/admin/booking-requests/settings` (#2162, #2166). It also constrains
what a save may re-seed: re-seeding a snapshot from a fresh read can move a field
the admin never touched, and a snapshot that ends up out of step with the editor
draft compared against it arms a dirty-gated Save the admin never armed, one
click from reverting the other admin's change. The structural fix is preferred
and is what #2166 adopted here: give each card its OWN `useSectionEditState`, so
its draft and its snapshot are only ever re-seeded together, by that card's own
load or its own save, and no save can leave a sibling dirty. Where a snapshot
genuinely is shared across editors, re-seed the draft of every field the admin
had NOT edited along with it, and leave a draft they HAD typed into alone —
that is their own in-progress input. Either way the residue is display staleness
in a card the admin did not touch, which is accepted — the same property
`/admin/modules` has. Be exact about what an Edit gate does and does not do
about it: `startEditing` only flips a flag, so opening a card does NOT re-fetch
and the boxes can already be out of date. What keeps stale display from becoming
a stale WRITE is the changed-fields-only patch above, not the gate. What the
gate adds is that the dirty comparison is against the card's own snapshot, which
is what is on screen, so a stale box never arms Save by itself.
The rule binds sections that are NEW
or MODIFIED, so four pre-existing surfaces are acknowledged divergents it does
not retrofit on its own: the `/admin/modules` grid (deliberate bulk toggles), the
older staged-but-ungated settings forms, and the age-tier and notification
settings panels — the last two were previously written up as blanket exemptions
"because they are list sections", which is no longer the reason: list sections
are in scope (see the per-row shape below), those two simply have not been
touched since. Booking Policies has NO divergent left. Every settings control in
the area now stages behind a per-card Edit → Save/Cancel: the **Show indicative
pricing** checkbox in `public-booking-requests-section.tsx` stopped persisting on
change in #2162, and the two timing cards beside it (quote window / reminder
lead, and the school-attendee prompts) — always editable with a dirty-gated Save
and no Edit or Cancel until then — were Edit-gated in #2166 on the owner's
decision. The only direct writes left in the area are discrete ACTIONS rather
than staged fields: row-level Activate/Deactivate and Delete on the
booking-period and minimum-stay lists, and the confirm-gated **Remove override**
on the default cancellation card. The per-row shape below sanctions the row-level
ones. **Remove override** is not a row action and the per-row shape does not
reach it; it is justified in its own right, in the JSDoc on
`handleRemoveOverride` in `default-cancellation-policy-section.tsx` — it deletes
the lodge's rows regardless of what the open editor holds, so it is a
destructive action rather than a draft/snapshot save and deliberately bypasses
`section.save()` and its dirty gate. None of them is a licence to auto-persist a
settings FIELD.

That section is the worked example of the two rules that meet awkwardly here.
All five public-booking-request settings live in ONE row behind ONE whole-object
PUT, so a single hook instance for the section would match storage exactly — but
the hook carries one `editing` flag, and one Edit unlocking all three cards, one
Cancel discarding all three drafts, and one Save writing all five fields is not
what #2166 decided. Each card therefore takes its OWN instance and pays for the
shared write object the documented way: every save GETs the fresh settings and
merges only the fields the admin CHANGED, exactly as the module-toggle cards
below do, so no card can persist a sibling's uncommitted draft or its own
load-time snapshot of one, and an untouched box — in this card or another —
never reaches the wire at all, so it cannot revert whoever moved it. The
narrowing has one consequence worth naming: the quote card's two fields carry
the route's cross-field rule, so sending only the changed one can compose a pair
the admin never saw (their new reminder beside a window a second admin moved).
The card checks the composed pair after its fresh read and refuses it with an
explanation rather than letting the route answer "Invalid input".
Three instances would mean
three identical mount-time GETs and three snapshots a concurrent write could
leave disagreeing, so the section holds ONE in-flight load in a ref and all
three `load` callbacks seed from that single response. That shared read
deliberately carries no `AbortSignal`: the ref holding it is only cleared in a
microtask, while React StrictMode's mount → cleanup → re-mount is synchronous,
so a signal-bound promise would be handed to the re-mounted hooks already
aborted — and every hook would swallow the `AbortError`, clear `loading`, and
render the hardcoded fallback as though it were stored. None of the three carries
a first-save exception even though the read synthesises defaults on a miss: those
synthesised defaults ARE the effective settings at every read site and no
behaviour keys on the row existing, so the exception would only unlock a
pristine, audit-writing no-op (#2143). (Config-transfer used to be the one thing
that DID observe the row: `club-settings.ts` skipped a singleton with none, so a
club that had never saved these settings exported no
`booking-request-settings.json`. #2171 closed that for the whole `SINGLETONS`
set — the exporter now emits an entry for every singleton and fills a missing
row with the same effective defaults the read sites synthesise, read from the
shared constants in `src/config/club-settings-defaults.ts` rather than a second
copy. Nothing in THESE cards changed — the getters moved their inline `?? x`
defaults to those shared constants and read them, which is value-identical, and
nothing here depends on the row existing. Import-side there IS a consequence:
materialising a singleton flips the setup-readiness signals that key on row
existence — see `docs/config-transfer/README.md`.)
Validation stays in each card's click
handler rather than the hook's `isValid`, so an out-of-range or
reminder-not-shorter-than-window draft gets an explanation instead of a greyed
button with no reason. The four number boxes take the reference section's
read-only styling (`bg-muted text-muted-foreground` while not editing — moved
off raw `bg-slate-50 text-slate-700` by #2144, deliberately onto `bg-muted`
rather than the raw→token table's `bg-card`, which is invisible against the
themed light background), because
Tailwind's preflight resets `color`, `background-color`, and `opacity` on
`input` at author origin and so erases the browser's own disabled presentation —
without it a gated box looks exactly like an editable one. The three Edit and
three Cancel buttons carry an `aria-label` naming their card, so a screen
reader's button list does not show three identical "Edit"s. That is the same
FAMILY of defect as the look-alike "Deactivate" buttons #2142 fixed, but not the
same fix: #2142 changed the VISIBLE text, whereas here only the accessible name
differs and a sighted admin still sees three buttons reading "Edit". That is
accepted, because each sits in its own card header beside a distinct title.
Reference:
`src/components/admin/booking-policies/group-discount-section.tsx` — it carries
the section banner, which since #2160 is what every banner-hostable admin
surface does. For the surviving per-button treatment, look at a control inside a
dialog (`src/app/(admin)/admin/issue-reports/page.tsx`) or a leaf toolbar
component (`src/components/admin/admin-capacity-hold-controls.tsx`).

The draft/snapshot half of that pattern lives in the shared
`useSectionEditState` hook (`src/hooks/use-section-edit-state.ts`), which new
sections should use instead of hand-rolling the state: it holds the draft and
the saved snapshot together, so Cancel restores every field at once, and it
re-seeds both from whatever the card's `save` callback returns rather than from
the submitted draft. That re-seed is only as authoritative as the callback makes
it. A callback should return the parsed SERVER response wherever the write
echoes the stored row back — the group discount and password policy cards do —
so a value the route clamps or normalises is never left misreported in the form.
Returning locally-computed values instead (as the email sign-in link and Google
sign-in cards do, because neither route returns the stored row) is safe only
while those routes cannot normalise what they store: they reject out-of-range
input rather than clamping it, so the client value always matches storage. The
same shortcut against a normalising route would silently diverge. Each card
keeps its own `save` callback — the
GET-fresh-then-merge step above, multi-endpoint writes, and per-endpoint failure
copy all stay local — and throws the hook's `ForbiddenSaveError` for a 403 so it
maps to the shared `ADMIN_FORBIDDEN_SAVE_REASON` copy. Feedback rendering stays
in the component, because booking-policy sections use `PolicyFeedback` while the
security cards use `Alert`. A section whose snapshot is a LIST with per-row
edits is not out of scope, but the hook belongs one level down: the OPEN EDITOR
gets its own instance, keyed on the row being edited AND on an instance counter
bumped every time an editor is opened
(`` key={`${rowId ?? "new"}:${editorInstance}`} ``), while the list itself stays
ordinary state and its row-level actions stay plain direct writes. The counter
is not cosmetic: with the bare `key={rowId ?? "new"}` the key is unchanged when
Edit is clicked again on the row already open, so React reuses the instance, the
fresh `initial` is ignored, and the abandoned draft silently survives. Row-level
actions that WRITE also need an in-flight guard held in a ref rather than only a
disabled button, because a double-click dispatched inside one tick gives both
handlers the same pre-update row and the second write becomes a no-op audit
entry of the #2143 kind. The booking-periods and minimum-night-stay sections are
the reference for that shape (#2142). Wherever the read endpoint SYNTHESISES
defaults on a miss — or the editor is creating a row that does not exist yet —
carry the first-save exception: count the draft as dirty so committing the
defaults stays reachable, but
never extend it to a FAILED load, where the same fallback values would let one
click blind-write over a real stored policy. For the same reason a snapshot is
authoritative only for the scope it was loaded for: a section whose fetch is
keyed on something else (a lodge scope) must track that key WITH the snapshot
and treat a mismatch as unknown — no editor, no destructive affordances, no
first-save exception — because a failed re-fetch leaves the previous
key's value in place. That binds LIST sections just as hard — there the stale
value is a set of rows whose Edit, Delete, and Activate/Deactivate buttons all
act on a row id belonging to the partition the admin has navigated away from —
and the never-loaded state needs a SENTINEL key distinct from every real one,
because `null` already means "club-wide" and a `null` seed makes a failed FIRST
load compare equal to the scope the section mounts on. The unknown state must
also be RECOVERABLE without leaving the page: it carries a **Try again** action
that re-runs the current key's load in place. All three keyed booking-policy
sections (default cancellation, booking periods, minimum night stay) carry this.

The `/admin/xero` and `/admin/members` routes are route shells with local
`_components` and `_hooks` folders; the member `/book` wizard follows the same
shape, keeping its wizard-step views in `src/app/(authenticated)/book/_components`
and its state machine (all wizard state, effects, and handlers) in the
`src/app/(authenticated)/book/_hooks/use-booking-wizard` hook, with the page
shell as a thin consumer that renders the step views. Shared admin/member logic lives in
`src/lib/`: `admin-member-xero-actions` wraps the Xero contact actions used by
both the members list and detail page, `member-serialization` centralises DTO
shape, `member-lifecycle-actions` owns archive/delete request handling, and
`membership-cancellation-*` owns the cancellation request, confirmation,
approval, Xero, settings, and status-label flow.

Browser-facing API routes treat an unexpected exception as operator-only
diagnostic data: the complete error is sent to the structured logger, while the
JSON response uses a fixed route-specific message. Validation and domain
guidance may reach the browser only through an explicit error type (for example
`ApiError` or a domain service error), so a new Prisma/provider/runtime message
cannot become public merely because it was thrown inside a route. Authenticated
cron/webhook clients and the explicit Admin provider-test / finance-sync
diagnostic endpoints retain their separate machine/diagnostic response
contracts. Xero's shared error classifier makes that boundary structural:
`clientMessage` is fixed browser-safe copy, while `diagnosticMessage` may hold
provider Detail/Message/Title fields, raw runtime text, HTTP status, or a Xero
correlation ID and is restricted to structured server logs.

## Core Data Model

The source of truth is `prisma/schema.prisma`. Key domains are:

- Members, family groups, hidden family-suggestion member sets, dependent
  relationships, declared partner links (consent-based member↔member
  Partner/Husband/Wife pairs, #1742), nominations, membership cancellation
  requests, setup invites, password/email tokens, two-factor enrollment state,
  hashed email OTP/recovery-code rows, notification preferences, deletion
  requests, and audit logs.
- Seasons, season rates, booking periods, minimum-stay policies, group
  discounts, age-tier settings, promo codes, fixed-nightly promo adjustments,
  and promo redemptions.
- Bookings, guests, payments, refunds, booking modifications, waitlist offers,
  account-credit ledger entries, chores, hut-leader assignments, lodge PIN
  sessions, and issue reports.
- Lodge rooms, lodge beds, bed allocations, allocation settings, and allocation
  approval metadata.
- Operational Xero tokens, object links, cache tables, inbound events,
  operation queues, account/item mappings, and API usage metering.
- Finance sync runs, finance snapshots, chart-of-accounts snapshots, finance
  report diagnostics, and finance access levels, all using the operational Xero
  connection rather than a separate finance token store.
- Cron run records, email logs, webhook logs, processed webhook events, and
  backup/audit-retention support records.
- Public website content records: `PageContent` owns routable page
  header/body/menu content, while `SiteContent` owns shared public chrome such
  as the editable footer columns that never appear in the website menu.
- `SiteBanner` records: admin-managed plain-text notices with
  `URGENT`/`WARNING`/`NOTIFY` priority and an inclusive NZ date-only display
  window, rendered above the public and member site headers.

### Reading a unique-constraint failure (P2002) — measured, not assumed

Prisma 7 reaches PostgreSQL through the `pg` driver adapter (`PrismaPg`, wired
in `src/lib/prisma-adapter.ts`), and that changes the shape of a P2002 from what
most Prisma documentation and older code assume. Measured on 1 Aug 2026 against
PostgreSQL 16 with Prisma 7.9.0 and this repo's real migration tree:

- **`meta.target` is never populated.** It was the old Rust query engine's
  field. Any code that reads only `meta.target` to decide which constraint fired
  is dead code on this stack — that is exactly how the join-code collision retry
  in `src/lib/group-booking.ts` silently stopped firing (#2412).
- **The colliding columns arrive at
  `meta.driverAdapterError.cause.constraint.fields`.** The adapter parses them
  out of the `Key (…)` detail of the SQLSTATE 23505 error, so the list holds
  COLUMN names, never the index name. The index name appears only inside
  `cause.originalMessage`.
- **Column names keep whatever quoting Postgres used.** A camelCase column comes
  back as `"joinCode"` with literal double quotes; a lowercase one as `email`.
  Compare case-insensitively and strip quotes.
- **A raw partial index is indistinguishable from a schema-level `@unique`.**
  `Member_email_login_unique` (hand-written SQL, `WHERE "canLogin" = true`)
  reports its column `email` exactly the way `GroupBooking.joinCode`
  (`@unique` in the schema) reports `"joinCode"`. The long-assumed "the two
  index kinds surface differently" distinction is not real, and cost two
  separate sessions' reasoning before it was measured.

Do not re-derive this by reading adapter source. Use
`describeUniqueConstraintTarget` in `src/lib/prisma-errors.ts`, which reads every
shape most-trustworthy-first (so it keeps working if the adapter is ever dropped
and `meta.target` returns, or if Postgres withholds the `Key (…)` detail and only
the rendered message is left) and normalises the quoting, case and composite
separator away, so one constraint always describes itself the same way whichever
shape carried it. Verbatim captured errors live in
`src/lib/__tests__/helpers/p2002-fixtures.ts`.

Two limits on that advice. All of the above is about **unique** constraints
(SQLSTATE 23505) only: for a CHECK or trigger violation the adapter drops the
Postgres `constraint` field altogether, so the helper has nothing to return and
the booking-envelope triggers are matched on their `RAISE EXCEPTION` text instead
(`src/lib/booking-envelope-invariants.ts`). And the rendered message echoes the
call arguments, so any match against it is made on Prisma's whole sentence —
member free text can otherwise supply a convincing-looking field list of its own.

## Booking and Payment Flow

The happy-path request/data flow for a card booking. Capacity is claimed under
a per-lodge advisory lock inside the transaction; the Stripe call and any Xero
queueing happen outside it (the durable-recovery and webhook paths are covered
in [Integrations](#integrations)):

```mermaid
sequenceDiagram
    participant M as Member (browser)
    participant R as /api/bookings route
    participant B as booking-create (src/lib)
    participant L as acquireLodgeCapacityLock
    participant DB as PostgreSQL
    participant S as Stripe
    participant X as Xero outbox

    M->>R: POST booking (dates, guests)
    R->>B: validate session/input, delegate
    B->>L: acquire per-lodge capacity lock
    B->>DB: re-read capacity, apply policy + pricing
    B->>DB: persist booking + guests + audit (one txn)
    B-->>L: commit releases the lock
    B->>S: create PaymentIntent (outside txn)
    B->>X: queue invoice op (Internet Banking path)
    R-->>M: booking + client secret
    S-->>R: webhook confirms payment (idempotent)
```

### Booking-policy exception foundation

Minimum-stay evaluation now produces a stable review snapshot, but it does not
yet create an exception request or change booking state. The closed soft-policy
allowlist in `src/lib/booking-policy-exceptions.ts` contains only
`MINIMUM_STAY` and the contract reserved for the follow-up hosting evaluator,
`ADULT_MEMBER_HOSTING_REQUIRED`. Every violation freezes the reason, policy id
and version, resolved club-wide/lodge scope, exact affected NZ lodge nights,
typed requirements, eligibility, and the policy's `HOLD` or `NO_HOLD` capacity
mode. Aggregation is deterministic and **HOLD wins** when any eligible violation
requires it. A runtime object carrying a non-allowlisted reason is rejected.

`MinimumStayPolicy.capacityMode` is required and existing rows migrate to
`HOLD`; `MinimumStayPolicy.version` is the optimistic concurrency token for
admin writes and config transfer. Enforcement is server-side on every
member-facing mutation path, for non-admin actors only: booking create, member
group join, the live member date modification (`PUT /api/bookings/[id]/modify` →
`modifyBookingBatch`, checked before the guest plan, pricing and capacity) and
its `modify-dates` sibling all return their blocking HTTP 400 with the frozen
`violations` and `exceptionReview`. The public non-member group join enforces at
**both** stages: staging refuses before a verification token, join row or email
exists, and verification re-reads the current policy set and fails closed with a
409 `minimum_stay` outcome before any member, booking, payment or pay link is
created — the emailed link lives 48 hours, long enough for a rule to change
under it. Waitlist-offer confirmation enforces on both offer kinds: a same-lodge
confirm against the booking's own lodge and a cross-lodge confirm (ADR-004)
against the **offered** lodge, whose policy set replaces rather than merges with
the club-wide one. Both run outside any transaction and fail closed without
consuming the offer — the entry reverts to `WAITLISTED` under the relevant
lodge's capacity lock and the member gets a plain sentence with code
`MINIMUM_STAY_VIOLATION`. On the batch modify path the check runs only when the
edit actually moves a night (`resolveTargetDates().datesChanged`, the resolved
envelope after any `guestStayRanges` widening); a guest add, removal, name fix
or credit election leaves the nights alone, cannot admit a new violation, and is
exempt. `modify-quote` gates its advisory check on the identical
`targetDatesChanged`, so preview and apply agree on every request shape. Modify quote and policy check
expose the same structure as advisory data; policy check first resolves omitted
lodge context to the active default and rejects an unknown/inactive explicit
lodge. All evaluators receive the resolved booking lodge, so a lodge-specific
policy cannot silently fall back to the club default.

This is intentionally not the approval workflow. No exception row is persisted,
no `HOLD` capacity is reserved, no hard failure becomes reviewable, and no
caller continues into admission after a minimum-stay block. Durable requests,
approval/revalidation, capacity reservation, and the combined soft-plus-hard
admission order belong to #2365. Hard failures such as capacity exhaustion,
subscription/membership eligibility, duplicate member-nights, payment,
authentication/privacy, invalid dates, and data-integrity faults remain outside
the soft allowlist structurally.

### Adult-member hosting policy

The second consumer of that foundation now has two independently inherited
dimensions. The CONSEQUENCE is `DISABLED`, `ADMIN_REVIEW_REQUIRED`, or
`ENFORCED`; the host-scope set enables `SAME_BOOKING`,
`SAME_BOOKING_OWNER`, or both. `AdultMemberHostingPolicy` holds one row per
configuration scope (club-wide plus per-lodge override), with scope identity
pinned by a CHECK on `scopeKey`, an explicit `capacityMode` carrying no database
default, and a revision that every write compare-and-swaps on under the
`adult-member-hosting-policy-set` advisory key. A lodge may inherit either
dimension while overriding the other. Existing NULL scope columns resolve to
same-booking only, so the expansion does not broaden an existing club's policy.

The evaluator in `src/lib/policies/adult-member-hosting.ts` is pure: it takes a
resolved consequence/scope set and participant facts stamped with the scope by
which they may qualify, then returns the frozen
`ADULT_MEMBER_HOSTING_REQUIRED` violation with exact uncovered guest+night pairs
and qualifying member ids. Same-owner candidates come only from another
eligible booking with the exact same `Booking.memberId`, lodge, and night;
ownership alone never proves attendance. The live `Member` row — not the guest
row's `isMember` snapshot — decides who qualifies, and unrelated members,
shared emails, and Family Groups never supply cover.

`src/lib/adult-member-hosting-review.ts` is the only module that turns a
persisted booking into evaluator input and the answer back into review state.
Because it derives everything from live rows and is idempotent, every booking
path that can change the party simply calls it at the end of its own transaction:
create (draft, confirmed, waitlisted, and the #738 split child, which borrows its
parent's adults as host-only participants), batch modify, date modify, admin date
shift, guest add, guest removal and waitlist confirm, plus every path that
creates a whole party of its own — the booking-request approval and its
held-booking conversion, the quote-time hold, the school and member whole-lodge
approvals, and the verified non-member group joiner. A hazard clears the moment
current facts cover every night, and reopens only when the uncovered set or the
policy revision materially differs.

Because the split child borrows its parent's rows, the dependency runs both ways,
so mutation paths call `reconcileAdultMemberHostingReviewWithSiblings`: it
reconciles the mutated booking and then the live same-member siblings the borrow
reads, one level deep, in the same transaction. Without that, shortening the
member's own stay on the parent would silently drop the child's hazard and
extending it would leave a stale review nobody could clear. Two source-contract
tests hold the shape: every module containing a `booking.create(` must reach a
hosting recorder, and only the review service itself may call the single-booking
reconciler.

The review is deliberately NOT folded into `requiresAdminReview` /
`adminReviewStatus`: those carry the minors-only rule, several paths wipe them
when it stops applying, and a hosting hazard has a different lifecycle. The two
are reported together as structured codes at read time instead. In review mode
the booking exists while an officer decides; in enforced mode a non-compliant
member create or modification throws the waivable 409 inside its transaction,
so the write rolls back and the signed-in exception-request flow becomes the
door forward. School and organisation approval stays review-only, while
member-owned flows — including member whole-lodge approval — remain enforced.
An admin booking for somebody else may supply an explicit reason, which records
an attributable APPROVED review; `/admin/book` renders that reason panel for
confirm and save-as-draft. `adultMemberHostingReviewedById` is a real `SetNull`
relation to `Member` with a `member-merge.ts` spec, so that attribution survives
a merge and does not dangle after deletion. Once an accepted booking loses
same-owner cover, a separate urgent incident opens without changing
`Booking.status` and resolves automatically when cover returns.

1. A member selects a lodge (implicit when only one active lodge exists) and
   check-in and check-out dates.
2. Capacity is calculated per lodge as that lodge's beds minus its
   capacity-holding guests per night; capacity is never summed across lodges,
   and a booking at one lodge never consumes another lodge's beds.
   Capacity-holding statuses are `PAID`, `COMPLETED`, `CONFIRMED`
   (pay-on-account school groups + accepted-but-unpaid school quotes), and
   `AWAITING_REVIEW` (a bed is reserved while an admin decides, and for the
   "sent quote" hold). Generic `PENDING` does not hold capacity (a provisional
   non-member hold) — but a `PENDING` booking that is the converted booking of a
   `BookingRequest` (an accepted-but-unpaid quote or a directly-approved
   request) DOES hold until it is paid, expires, or is cancelled (issue #1254,
   refining #737). The single source of truth is `capacityHoldingBookingFilter()`
   (query form) and `bookingHoldsCapacity()` (per-row form) in
   `src/lib/booking-status.ts`, composed under `AND` with the per-lodge scope.
3. Minimum-stay, booking-window, age-tier, membership, group-discount, fixed or
   percentage promo, and account-credit rules are applied.
4. Booking Policies resolve the effective non-member hold policy from the
   check-in date: a date-specific `BookingPeriod` can override both the
   default enabled flag and the confirmation threshold. Existing clubs default
   to Members First (`nonMemberHoldEnabled=true`), while First Paid, First In
   disables provisional non-member holds for that policy row. The Default
   Cancellation Policy admin page nudges operators to refresh their public
   Terms/FAQ when that copy still describes the old hold behaviour and omits the
   First Paid, First In option (`detectStaleHoldPolicyCopy` in
   `src/lib/hold-policy-copy.ts`).
5. If all guests are members, the non-member hold policy is disabled, or
   check-in is inside the configured hold window, the whole booking proceeds to
   normal payment immediately.
6. If non-members are included outside an enabled Members First hold window, a
   card can be saved and the non-member portion remains pending until the hold
   date. Mixed member/non-member parties split only in this pending case; inside
   the window or under First Paid, First In they stay one normal booking.
7. `BookingGuest.stayStart` and `BookingGuest.stayEnd` record the actual
   date-only range for each guest inside the parent booking envelope, with
   `BookingGuestNight` rows as the authoritative night set when present.
   Capacity and booking-derived finance metrics count a guest only on nights in
   that individual range — the NIGHT model. Operational surfaces that ask "who
   is in the lodge today" read the OPERATIONAL-DAY model instead (#2622): a
   guest occupies a day's morning half if the previous night was theirs and its
   evening half if the day itself is, so someone checking out this morning is
   present for the morning. Chore-roster generation, roster validation and chore
   cleanup all read one named rule in
   `src/lib/booking-guest-stay-ranges.ts` through a single eligibility query
   (`src/lib/roster-eligibility.ts`), and the allocator's arriving/departing
   routing is a derived label off that rule, never separate data.
   `docs/DOMAIN_INVARIANTS.md` owns which surfaces belong to which model.
8. Capacity-sensitive writes use a PostgreSQL advisory transaction lock keyed
   per lodge (`acquireLodgeCapacityLock`), so overlapping booking decisions at
   the same lodge serialise while bookings at different lodges never contend.
   `CONCURRENCY_AND_LOCKING.md` maps the full advisory-lock landscape (all seven
   lock families, which paths take which, and the ordering disciplines).
   Member lifecycle approval (delete / archive) acquires
   `pg_advisory_xact_lock(hashtext('member-lifecycle:<memberId>'))` inside
   the transaction. Future approve / reject paths that recount eligibility
   then mutate the member graph should follow the same idiom so a parallel
   write cannot race the re-check.
9. Payment state records an explicit source. Stripe payments stay on Stripe
   PaymentIntent, refund, and recovery paths; Internet Banking payments issue a
   Xero invoice and settle through inbound Xero reconciliation. By default,
   Internet Banking bookings do not hold capacity until reconciliation performs
   the final capacity claim. Admin settings can opt into bed-slot holding for a
   bounded number of days, in which case the booking is `CONFIRMED` while the
   Xero invoice remains unpaid.
10. Bed allocations reconcile when bookings are confirmed, modified, waitlist
   confirmed, force-confirmed, cancelled, completed, or deleted. That reconcile
   auto-fills missing guest nights from active room/bed inventory for the
   reconciled booking **only** (#1686) — it never opportunistically re-plans
   other bookings into idle or freed beds; lodge-wide re-planning is the
   explicit admin "Run auto-allocation" board action. Admins can also manually
   move, approve, or reviewed-remove allocations. Reviewed removal never invokes
   either planner, so its freed nights remain in the awaiting-allocation pool.
   Existing-chip moves are bed-only operations: the reviewed request carries an
   anchor allocation, destination bed, night-or-person scope, and preview digest,
   never a target date. Person scope resolves every existing row for that guest
   on the booking, including sparse and off-screen nights, but creates none. The
   service takes global booking `lock(1)` first, then the complete sorted lodge,
   member-lifecycle, member-partner-link and allocation-row tiers before its
   authoritative re-read. It commits all changed rows, shared-double partner
   promotions and audit rows in one transaction; unchanged rows are digest-bound
   noops. Sharing cancellation's global key prevents a move from resurrecting an
   allocation after cancellation pruned it. A stale preview or conflict rolls a
   reviewed move back wholesale; bucket-to-board bulk placement retains its
   separate per-night partial-conflict contract.

In-progress member self-service edits are limited to future unused nights from
NZ tomorrow onward. NZ today and earlier are locked for admin review through
booking change requests. Positive booking-edit deltas use supplementary Xero
invoices after additional Stripe payment succeeds — carrying signed component
lines (a mixed-sign reduction-plus-fee edit includes its negative price
adjustment) so the invoice and recorded payment equal the net actually charged
(#1356) — while negative deltas use a settlement choice: Stripe refund work
where applicable or an idempotent source-linked member account credit. Both
avoid unsafe financial mutation of a paid, part-paid, credited, or locked
original invoice.

Money values are integer cents. Booking dates are New Zealand date-only lodge
nights rather than timestamps.

## Booking Statuses

Common booking states include:

- `DRAFT` for unconfirmed drafts with a time-to-live
- `PENDING` for non-member hold bookings
- `CONFIRMED` and `PAID` for accepted bookings
- `WAITLISTED` and `WAITLIST_OFFERED` for capacity waitlist flows
- `BUMPED`, `CANCELLED`, and `COMPLETED` for lifecycle transitions

Waitlisted and offered bookings do not consume capacity until confirmed.
Completed bookings continue to consume capacity for their remaining stay nights.
Admins can soft-delete cancelled bookings to hide operational duplicates while
preserving the booking row, audit snapshot, guests, events, and modification
history. Soft-delete remains blocked when captured/refunded/credited payment,
refund, member-credit, payment-recovery, or Xero history exists. Internal
booking modifications do not block this cleanup when their net cent effect is
zero and no external financial or Xero history exists.

## Admin and Lodge

Admin pages cover member management, member CSV import, bookings, operational
booking filters, bed allocation, payments, seasons, policies, refund requests,
promo codes, communications, health, audit logs, reports, Xero operations and
inbound-event drilldowns, committee data, issue reports, waitlist, lodge
operations, hut leaders, and roster/chores. `LodgeSettings` holds each lodge's
operational defaults such as its fallback capacity override and school-group
soft cap; the hut-leader lookahead window used by dashboard and Needs Attention
warnings stays a club-wide knob on the legacy row. Single-lodge clubs keep one
row (ADR-002); additional lodges get their own keyed by lodge id.
The sidebar's Needs Attention Booking Requests badge sums pending internal
booking reviews, requested change requests, and queued public booking requests.
Pending self-service account deletion requests are also counted there and link
admins to the deletion request queue. Unpaid finished stays (#1709/#1731) —
`PAYMENT_PENDING` bookings whose check-out is on or before NZ today — badge an
"Unpaid Finished Stays" entry deep-linking to the pre-filtered bookings list;
its predicate and href live in `src/lib/unpaid-finished-stays.ts`, shared with
the admin dashboard attention card so the two surfaces never drift. The
sibling queue "Unpaid Stay Additions" (#1723) — settled
(`CONFIRMED`/`PAID`/`COMPLETED`, deliberately never `PAYMENT_PENDING` so the
two queues stay disjoint) finished stays whose upward-modification delta was
never collected (`additionalAmountCents > 0`, `additionalPaymentStatus` null
or not `SUCCEEDED`) — follows the same pattern: its predicate/href helpers
live in the same module, badge the sidebar, drive a second dashboard
attention card, and deep-link to the bookings list's `additionalOwed=owed`
filter. #2350 widened that queue past finished stays: the same uncollected
delta on a stay whose check-out is still ahead is counted too
(`buildUnsettledAdditionalUpcomingStaysWhere`, disjoint from the finished
predicate by the direction of its check-out bound), the dashboard card carries
a split "N upcoming, M finished" label, the sidebar badge shows the sum, and
both link to `buildUnsettledAdditionalStaysHref()` - the owed filter with no
date bound, which is the only link that covers both halves. The in-memory twin
of that predicate is `isAdditionalPaymentOwed`
(`src/lib/additional-payment-chase.ts`), which takes the booking status as a
required argument and shares one status list with the SQL builder, so no
surface can read a cancelled booking's untouched delta columns as money owed.
All sidebar badge counts come from the single `GET /api/admin/pending-counts`
endpoint (`src/lib/admin-pending-counts.ts`), whose per-queue where-clauses
mirror the individual queue routes. Sidebar sections render expanded by
default; a per-section collapse preference persists in localStorage.

The admin command palette (#2092, `src/components/admin-command-palette.tsx`)
opens on Ctrl/Cmd-K or the sidebar header "Search…" button (wired through a
window event in `src/lib/admin-command-palette-events.ts`) and lets admins jump
to any page they can access. Its index is derived at runtime by
`getAdminFeatureSearchIndex`, which **reuses** `getVisibleAdminNavSections` and
de-duplicates by href — so the palette applies exactly the sidebar's four
visibility rules (module flag, `fullAdminOnly`, `orAccess`, permission matrix)
plus the hut-leader relabel, and can never surface an href the admin is not
permitted to open. The index is a deliberate **superset** of what the sidebar
renders at any given moment, not a mirror of it: the two queue-driven "Needs
Attention" deep links (Unpaid Finished Stays / Unpaid Stay Additions) stay
searchable as always-accessible, pre-filtered views even when their queue is
empty, whereas the sidebar reveals them only while their queue is non-empty. As
defence in depth, `getAdminFeatureSearchIndex` fails **closed** — a missing
permission matrix yields an empty index — even though `getVisibleAdminNavSections`
keeps its pre-existing fail-open contract. There is no second registry to drift:
`navSections` remains the single source of truth, optionally enriched with a
per-entry `keywords` field that only widens palette matching.

`src/lib/token-catalogue.ts` is the client-safe single source of truth for the
`{{token}}` placeholders supported in admin HTML content (page bodies and lodge
instructions); the embed/text matching regexes in `src/lib/page-content-embeds.ts`
and the WysiwygEditor token help dialog are both derived from it. Lodge
instruction reader/kiosk routes resolve text tokens on read; the admin editor
route returns them unresolved so edits round-trip.

In-app help is a single chat-style widget (`src/components/help-widget/`) mounted
on every shell — member, admin, finance, and the public website — via its
per-surface wrapper (`HelpWidgetMember` / `HelpWidgetAdmin` / `HelpWidgetPublic`).
A floating launcher opens a non-portalled, non-modal card (`role="dialog"
aria-modal="false"`) with two tabs: **Ask**, a transcript of curated
question/answer chips distilled from the corpus, and **Page guide**, the full
templated page help. It is templated-only today — the free-text LLM path is dead
code behind an `llmEnabled={false}` prop until epic #2094 C3/C4 ships the route.
The corpus lives under `src/lib/help/` (`getHelpForPage` / `match.ts`): admin and
finance delegate to the `src/lib/contextual-help.ts` registry (client-safe, most
specific matching route wins so nested Admin pages inherit their parent menu
help), while member and public use the hand-distilled corpora in that folder. A
page can inject extra sections/questions and a chip-ordering hint through
`HelpWidgetProvider` + `useHelpWidgetExtras`/`useHelpWidgetHint`; the booking
detail page uses this (`booking-help-extras.tsx`) to re-surface the booking status
glossary and cancellation refund schedule (#1371). This widget replaced the
retired per-shell `ContextualHelpButton` and the booking `BookingHelpDialog`
(epic #2094 C2).

Site banners are managed at `/admin/site-banners` (Setup & Configuration).
Admins create plain-text notices with a priority (URGENT/WARNING/NOTIFY) and
an inclusive NZ date-only display window; current active banners render above
the site header on the public, website, and authenticated member shells (not
admin/finance/lodge shells). Visitors can dismiss a banner per browser via
localStorage; editing a banner invalidates prior dismissals. All banner
create/update/delete actions write structured audit logs.

Member CSV import allows distinct identities to share an email address while
preserving the database invariant that only one member per email can have
`canLogin: true`. Duplicate detection uses normalized email plus first and last
name, and setup invites are sent only to imported members that can log in.
Member, dependent, profile, onboarding, and application address forms submit a
`postalSameAsPhysical` flag; route handlers copy physical address fields into
postal fields before persistence when that flag is true.
Address autocomplete is an optional Addy-backed public proxy module. It defaults
off, is gated by Admin Modules and `src/proxy.ts` before route handlers run, and
never replaces manual address entry.

Access roles live in `MemberAccessRole` and are the normalized login/permission
axis. An assignment row carries the legacy enum value (`USER`, `ADMIN`,
`ADMIN_READONLY`, `ADMIN_BOOKINGS`, `ADMIN_MEMBERSHIP`, `ADMIN_CONTENT`,
`LODGE`, `FINANCE_USER`, `FINANCE_ADMIN`, `ORG`) and/or a link to an
`AccessRoleDefinition` row. Definitions are the club-editable roles managed at
`/admin/access-roles`: label, description, and a per-area permission matrix.
The six seeded defaults (Read-only Admin, Booking Officer, Membership
Officer, Content Manager, Finance Viewer, Treasurer) keep their enum value in
`AccessRoleDefinition.systemRole` and can be edited or deleted; brand-new
custom roles are definition-only rows (`role` is NULL). `ADMIN` (Full Admin),
`LODGE`, `USER`, and `ORG` are protected system roles with no definition row:
code-defined, never editable or deletable, and Full Admin always keeps full
permissions.
`Member.role` remains a synchronized compatibility/classification field with
`USER`, `ADMIN`, `LODGE`, `NON_MEMBER`, and `SCHOOL`; Associate, Life, and
club-created categories are membership types, not role enum values.
`Member.financeAccessLevel` remains synchronized for compatibility visibility
(derived from the merged matrix finance level on role writes), but runtime
finance guards ignore it. Non-login records simply have no
access-role rows. The canonical access-role constants and compatibility helpers
live in `src/lib/access-roles.ts`; compatibility role constants stay in
`src/lib/member-roles.ts` for old imports, membership classification, and
provider-created non-member records.

Admin authorization is area-based in `src/lib/admin-permissions.ts`. `ADMIN`
has edit access everywhere (hardcoded, never database-resolved); every other
role resolves per assignment row: a joined `AccessRoleDefinition` is
authoritative, a bare enum value falls back to the legacy hardcoded bundle
(identical to the seeded definitions until the club edits them), and an
unresolved row contributes nothing — the resolver fails closed, never wider.
Roles merge by taking the maximum level per area when assigned together.
Finance-portal access derives from the merged `finance` area level (view ⇒
finance viewer, edit ⇒ finance manager) via `hasFinanceViewerAccess` and
`hasFinanceManagerAccess` in `src/lib/admin-permissions.ts` — Full Admin is
therefore a finance manager, and any role whose matrix grants finance view
(including Read-only Admin, Booking Officer, and Membership Officer as
seeded) can open the finance portal read-only. The member-facing booking
detail route (`/bookings/[id]`) mirrors the admin bookings list gate: any
role with bookings-area view (Booking Officer, Read-only Admin, Full Admin,
and the other seeded booking-capable roles) opens any booking detail
read-only, while every mutation (cancel, pay, modify, notes, delete, and the
Full-Admin-only Admin tools card) stays gated on booking ownership or Full
Admin (issue #1289). `requireAdmin()` infers the
requested admin path and HTTP method from proxy headers and enforces
view/edit requirements centrally, selecting assignment rows with their
definitions joined (`MEMBER_ACCESS_ROLE_SELECT` in
`src/lib/access-role-definitions.ts`); the admin layout precomputes the
matrix server-side and passes it to the sidebar, because definitions cannot
resolve client-side. Member-facing surfaces that gate on `session.user`
(the `/bookings/[id]` detail page and the widened member-facing booking APIs
from #1289/#1313) resolve through the session's embedded
`adminPermissionMatrix` (#1367): `session.user.accessRoles` is enum-only —
definition-backed custom roles carry `role: NULL` and vanish from it — so the
auth `jwt` callback computes the merged matrix from the DB-joined member on
every token refresh and embeds it, and `getAdminPermissionMatrix` treats an
embedded matrix as authoritative (never widened by enum-bundle fallback, so a
club-narrowed seeded definition stays narrowed). Editing a definition applies
to every holder on their next request — `requireAdmin()` and the layouts
re-read roles and definitions from the database, and the session-embedded
matrix is itself recomputed from that same database join per request rather
than trusted from an old token.

The seven areas and what each governs (from `ADMIN_PERMISSION_AREAS`, with the
notable members that live under a broader-sounding prefix called out):

| Area key | Label | Governs |
| --- | --- | --- |
| `overview` | Admin Overview | The dashboard and cross-area entry points. The only `/api/admin` route here is the `pending-counts` badge aggregate (the resolver catch-all — see below). |
| `bookings` | Bookings & Beds | Bookings, public booking requests, booking policy, waitlist, and bed allocation — plus seasons, age tiers, and promo codes. |
| `membership` | Membership | Members, applications, family links, memberships, inductions, and communications — plus committee roles/contacts, lockers, and per-member lodge-access. |
| `finance` | Finance | Payments, subscriptions, refunds, reports, Xero sync, and accounting setup — plus the member-prefix carve-outs (member credits and member Xero link/push/unlink). |
| `lodge` | Lodge Operations | Hut leaders, rosters, chores, work parties, lodge settings, and lodges (multi-lodge). The rooms-beds admin *page* is lodge-area, while its bed-allocation *APIs* sit under `bookings`. |
| `content` | Content | Page content, site chrome, banners, public images, and site style. |
| `support` | Support & System | Setup, modules, health, deliverability, audit, issue reports, and operational diagnostics — plus booking-messages and access-role management. |

The six seeded editable roles from `src/lib/access-role-definitions.ts`, plus
the protected Full Admin bundle, resolve to this baseline matrix (`—` = no
access). Definitions are club-editable, so this is the SEEDED starting point,
not a fixed policy; a club may narrow or widen any row except Full Admin:

| Role | overview | bookings | membership | finance | lodge | content | support |
| --- | --- | --- | --- | --- | --- | --- | --- |
| Full Admin (`ADMIN`, protected) | edit | edit | edit | edit | edit | edit | edit |
| Read-only Admin | view | view | view | view | view | view | view |
| Booking Officer | view | edit | view | view | edit | — | view |
| Membership Officer | view | view | edit | view | — | — | view |
| Content Manager | view | — | — | — | — | edit | — |
| Treasurer | view | view | view | edit | — | — | view |
| Finance Viewer | — | — | — | view | — | — | — |

A few route groupings are intentional and adjudicated (issue #1548), not bugs
to "fix" by remapping — any remap silently changes the effective access of every
custom role already deployed: module toggling and booking-messages are system
configuration and sit under `support`; committee records and per-member
lodge-access are member data and sit under `membership`; and `pending-counts` is
the deliberate `overview` catch-all. `src/lib/__tests__/admin-route-area-matrix.test.ts`
pins the full `/api/admin` route → area assignment to a frozen snapshot, so any
prefix edit that moves a route between areas fails CI with a precise diff.

When you add a new admin page (`src/app/(admin)`) or `/api/admin/**` route,
update **both** central route maps: the permission-area map in
`src/lib/admin-permissions.ts` (`ROUTE_AREA_PREFIXES`, or
`SPECIAL_ROUTE_AREA_PATTERNS` when the route needs a different area than its
prefix) so `getAdminRouteRequirement()` gives it the right area/level, and — if
it belongs to an optional module — the feature-gate map
`FEATURE_ROUTE_RULES` in `src/config/feature-routes.ts`. The permission map's
last entry, `overview`, is a catch-all (`/admin`, `/api/admin`): a route that
matches no more specific area silently resolves to `overview`, so a
finance-sensitive route that forgets its prefix would be readable at plain
overview access. `src/lib/__tests__/admin-route-map-drift.test.ts` enforces
this: it enumerates every admin page and `/api/admin` route and fails the build
if one lands on the overview catch-all without an intentional entry in that
test's small, justified `OVERVIEW_ALLOWLIST`. The guard catches *unmapped*
routes; it cannot catch a route *mis-mapped* by inheriting an existing wrong
prefix, so still add a `SPECIAL_ROUTE_AREA_PATTERNS` entry by hand when a
sensitive action lands under a broader prefix. New optional-module surfaces at
brand-new prefixes must be added to `FEATURE_ROUTE_RULES` by hand — the guard
only verifies existing feature prefixes still point at real files.

A `FEATURE_ROUTE_RULES` entry for an **API** route usually needs a second edit to
take effect: `config.matcher` in `src/proxy.ts` excludes the whole of `/api` bar
an explicit list, so an `/api` path must be *covered by some entry* on that list
or the proxy never runs on it and the module gate is dead code. A broad existing
entry may already cover it (anything under `/api/admin/*` is covered by
`/api/admin/:path*`, `/api/lodge/foo` by `/api/lodge/:path*`); what a new entry
has to get right is its shape — a rule written as a **prefix** gates the whole
subtree, so its entry must end in `:path*`, while a bare literal leaves every
child gated-but-unmatched. That bit the member-guest consent endpoint (#2435),
whose gate was written as a regex with no matcher entry at all.

`src/lib/__tests__/csp-proxy.test.ts` guards both halves against drift. Every
gated prefix must be a URL `config.matcher` runs on **at the prefix itself and at
a child path below it**; every gated pattern must be one too, probed through
`PATTERN_SAMPLE_PATHS` — a concrete sample per address shape the regex accepts,
one per alternation branch — and that map is itself asserted, in both
directions, to be exactly the set of live patterns, so a new pattern rule with no
sample fails the suite rather than slipping past it.

### Public website render modes and the fixed CSP nonce (#2352 slice 1)

The public website is **two route groups sharing one chrome component**, and the
only difference between them is where the CSP nonce comes from:

- `src/app/(website)` holds exactly the five addresses owner decision D1 approved
  (`/`, the `[...slug]` CMS catch-all, `/join`, `/contact`, `/join/apply`) and
  carries the **fixed per-release** nonce;
- `src/app/(website-dynamic)` holds `/hut-leader-instructions`, `/join/[code]` and
  `/join/verify/[token]`, which are `force-dynamic` for permanent reasons of their
  own and therefore keep a **freshly minted per-request** nonce, like every member
  and admin page. The owner narrowed D1 back to the five on 3 Aug 2026: a fixed
  nonce is a real, if small, loss of defence, and it buys nothing on a page that is
  never stored.

Both groups' layouts are three lines around `src/components/website/website-chrome.tsx`
— header, footer, banners, help widget, analytics consent, theme class, skip link and
the pre-setup holding screen, defined ONCE. The owner's direction for the split was
explicit: no duplicated markup.

That shared chrome reads **neither the session nor the request headers**, and that
is a deliberate, enforced property rather than a coincidence of its current
contents. Those two calls — `auth()` and `headers()` — were the only things forcing
every public page to be rendered from scratch on every visit, and a production build
prerendered zero pages because of them. The per-request group's layout is the one
place `headers()` is allowed, and it is safe precisely because it is a SIBLING of
`(website)/layout.tsx` rather than a parent: the read opts that group's routes out of
static rendering, which is what they already are, and it cannot reach the five.

With those reads gone, each route states its own mode:

- `(website)/[...slug]` — the admin-authored CMS pages — is served from
  **full-route ISR**: `generateStaticParams()` returns `[]` (nothing is prerendered
  at build, because a Docker build has no database), each path is generated on its
  first request and stored, and `revalidate = 300` triggers a background rebuild. An
  admin edit clears the store outright through `revalidatePublicSite()`, which is
  what makes an edit instant. `revalidate` is deliberately NOT described as a
  staleness bound: `ResponseCache.handleGet()` resolves the stale entry to the
  requester and only then revalidates in the background
  (`next/dist/server/response-cache/index.js`), so a change with no write behind it
  appears from the request AFTER the one that trips the window — and a Link prefetch
  (`isPrefetch`) is served stale without triggering a rebuild at all. Only a tag
  expiry, which `revalidatePath` produces, forces a blocking regeneration.
- That route's territory is deliberately narrowed to match the CSP nonce split. The
  catch-all claims every URL no other route claims, which is wider than the set the
  proxy hands the fixed per-release nonce to (`isFixedNonceWebsitePath()`: the five
  approved routes and nothing else). A page stored outside it would carry a nonce no
  later response names, so `isCmsServablePageSlug()`
  (`src/lib/public-website-paths.ts`) makes both the catch-all's loader and the
  admin slug validator refuse the difference. `/pay` was the live shape. The same
  predicate also filters the two surfaces that ADVERTISE a page — the site menu
  (`listWebsiteMenuPages()`) and the Book Now page target — so a row saved before
  the rule existed stops being linked to rather than pointing every visitor at a
  404 (slice-1 security re-review). The narrowing tightened it a little further:
  `hut-leader-instructions`, `join/<code>` and `join/verify/<token>` are refused as
  slugs too, because a real route claims those addresses, while
  `trips/hut-leader-instructions` — which no route claims — is still a perfectly good
  page.
- `/`, `/join`, `/contact` and `/join/apply` declare
  `export const dynamic = "force-dynamic"` as a hold pending #2352 slices 2 and 3.
- The three `(website-dynamic)` routes declare it permanently, and their group layout
  declares it as well so a page added there is per-request by default rather than by
  remembering: a per-assignment PIN-gated page and two token-bearing screens must
  never be stored.

Two things replaced the chrome's request reads. The CSP nonce arrives as a **prop**,
which is what lets one component serve two nonce territories: `(website)/layout.tsx`
passes the fixed per-release value from `src/lib/release-nonce.ts` (derived from the
`RELEASE_ID` build arg — a stored page can carry only one nonce, and Next stamps it
at render time from the request's own CSP header), and
`(website-dynamic)/layout.tsx` passes the per-request value out of the CSP nonce
header. The public header's one signed-in boolean is resolved in the browser from a
non-secret marker cookie (`src/lib/signed-in-hint.ts`), and the footer's page slug
comes from `usePathname()` instead of an `x-page-slug` request header, which was
removed. The full security reasoning, the rejected alternatives and the scope of
the nonce trade are in `docs/SECURITY-ATTACK-SURFACE.md` → "The Public Website's
Fixed CSP Nonce"; the operator view is in `DEPLOYMENT.md` → "Public website page
cache".

One predicate used to answer three questions, and the narrowing separated them
(`src/lib/public-website-paths.ts`). They are not the same question and the
difference is load-bearing: `isPublicWebsitePath()` answers the #2420 setup gate and
still claims BOTH public groups, so the three moved pages are answered with the
pre-setup 503 holding screen exactly as the five are (verified on a real container:
`completedAt` NULL gives 503 on all three); `isFixedNonceWebsitePath()` answers the
nonce; `isCmsServablePageSlug()` answers the catch-all's territory. The Stripe
tightening in the policy deliberately follows the WIDE predicate — Stripe.js has no
business on a PIN-gated instructions page either, and following the nonce there would
have handed those three pages a looser policy as a side effect of tightening their
nonce.

`src/app/(public)/layout.tsx` declares `export const dynamic = "force-dynamic"` for
its whole group, and that line is measured rather than tidy: the `auth()` call it no
longer makes was what kept those routes out of build-time prerendering, and without
a replacement `npm run build` fails on `Error occurred prerendering page
/booking-requests` — a build has no database, and the layout's `headers()` read
happens only after its own database reads have resolved, too late to bail out first.
Login is out of scope permanently (D7) and the rest are token-bearing screens, so a
group-level declaration is the right shape there; `(website)` states its modes per
route because exactly one of them is deliberately different.

Two CI gates keep all of this from drifting, and they answer different questions.
`scripts/ci/check-website-render-modes.mjs` reads the source: every route in either
group declares its mode, the catch-all keeps `generateStaticParams() => []` plus its
`revalidate`, nothing in `(website-dynamic)` mentions `generateStaticParams` or
`revalidate` at all, and no `loading.tsx`, `template.tsx`, `default.tsx` or Partial
Prerendering appears in either group — each of those introduces a boundary that could
commit a 200 before the catch-all decides an address is a 404, and under ISR that
soft 404 would then be stored. It also holds the three structural properties the
narrowing depends on, because a route group is invisible in a URL and none of these
would fail anything else:

- **the two route censuses** — each group's set of routes must equal the
  corresponding list in `src/lib/public-website-paths.ts`, so a page dropped into
  `(website)` cannot quietly be handed the weaker fixed nonce; adding one fails CI
  until the census is deliberately amended, which is the point;
- **chrome parity** — both layouts must compose the one shared chrome and no chrome
  of their own, so the groups cannot drift apart visually;
- **the chrome's own reads** — it may call neither `auth()`, `cookies()` nor
  `headers()`, and may resolve neither nonce itself. This is new coverage rather than
  preserved coverage: no source-level ban on a request read in the public layout
  existed before the narrowing, only the post-build manifest check. The extraction is
  what made its absence matter, because the chrome is composed by both groups, so the
  ban was written in the same commit as the move.
`scripts/ci/check-website-prerender-manifest.mjs` runs after the build and reads
`.next/prerender-manifest.json`, which is the only place the framework's own answer
is written down. BOTH halves are closed allowlists: the catch-all must still be the
only on-demand-generated route, the only build-time prerendered routes are the
sitemap and Next's own error shell, and the held-back and token-bearing routes must
appear in neither list. The on-demand half being closed is the more important one —
a stored route is one visitor's render handed to the next, and a route outside
`(website)` becoming storable was invisible to both guards before the slice-1
review. That second gate exists because the
failure it catches is silent — any component in the shared chrome or under
`(website)` that calls `auth()`, `cookies()` or `headers()` opts the catch-all out of
the cache with a green build, a green test suite, and no symptom but the returning
CPU cost.

Measured on a real `docker build` of this branch: the route table reported
`● /[...slug]` (SSG) with `ƒ /hut-leader-instructions`, `ƒ /join/[code]`,
`ƒ /join/verify/[token]`, `ƒ /_not-found` and every other app route Dynamic, and both
gates plus `check-prerendered-script-nonces.mjs` passed inside the image.

The rules read a **canonicalised** pathname (`normaliseForRules` in
`src/config/feature-routes.ts`): one trailing slash and one Next data suffix
(`.rsc`/`.json`) are stripped first, because the proxy runs before Next's
canonicalising 308 and the matcher admits those spellings, while the
`$`-anchored patterns would not. Normalisation is input-only — the comparisons
stay exact equality or a `/`-anchored prefix — and exemptions are compared
against the same canonical form.

Managing the definitions themselves is Full-Admin-only: the
`/api/admin/access-roles` mutation handlers enforce an explicit `isFullAdmin`
check on top of `requireAdmin()` (an editable role could otherwise widen
itself past the area gate), deletion is blocked while any member holds the
role (including via a bare enum row), and create/update/delete write
critical-severity audit entries.

Access-role writes carry an additional separation-of-duties gate, independent
of the path-inferred area: only a Full Admin (`ADMIN`) may grant or revoke
privileged access roles (every role other than `USER` and `ORG` — custom
definition-backed roles are always privileged), including via the legacy
`Member.role` and `financeAccessLevel` compatibility fields and the
member-import `role` column. Role writes are token-based: the enum value for
system roles and seeded defaults, the definition id for custom roles. The shared helpers are `isFullAdmin` and
`accessRoleChangeRequiresFullAdmin` in `src/lib/access-roles.ts`; the member
editor, create, bulk-update, and import paths all apply them and return 403
for a non-Full-Admin actor. `requireAdmin()` returns DB-verified access roles
on the session user so these checks never trust a stale JWT claim. A
submission that changes no role field — such as the member editor echoing a
member's unchanged roles back on a contact-only edit — is not a role write:
it neither requires Full Admin nor rewrites a dormant privileged legacy role
still stored on a non-login (archived or cancelled) member. The same
boundary covers the login email: only a Full Admin may change the email of
another member who holds a privileged access role, because an email change
plus a forgot-password request would hand the account and its roles to the
new address (`hasPrivilegedAccess` in `src/lib/access-roles.ts`).

Two further guards protect the admin population itself against being locked
out (issue #1604, extended to three more verbs by #1622), enforced server-side
across every path that can deactivate, disable login for, or archive an existing
account — member edit, bulk update, member lifecycle archive, deletion-request
approval, membership-cancellation approval, family-group login-holder
transfer (`POST /api/admin/family-groups/[id]/login-holder`), and dependent
linking with `disableLogin` (`POST /api/admin/members/[id]/dependents/link`).
The **last-admin guard** blocks any actor, including another Full Admin, from removing the final
active, login-enabled Full Admin; a bulk deactivate is evaluated on its end
state so a selection that collectively removes every remaining Full Admin fails
as a whole. The login-holder transfer both revokes and grants `canLogin` in one
operation, so it evaluates the end state as a raw count of active Full Admins on
its post-write read view (`countActiveFullAdmins` inside the transaction) rather
than the exclude-based helpers — the incoming holder's grant is thereby counted.
The **privileged-target guard** restricts deactivating, de-logging, or
archiving an account that holds — or dormantly stores — a privileged role to
Full Admins only, matching the #1012 role gate and so a scoped admin such as
the seeded Membership Officer can no longer touch admin-holding accounts. A
"Full Admin" here is exactly what `requireAdmin()` grants on: an active,
login-enabled member with the `ADMIN` access-role row (a legacy `Member.role =
ADMIN` without that row is not counted, because it confers no runtime admin
access). The helpers live in `src/lib/admin-account-guards.ts`
(`wouldRemoveLastFullAdmin`, `wouldRemoveAllFullAdmins`, `countActiveFullAdmins`,
`actorIsFullAdmin`) and `memberHoldsPrivilegedRole` in
`src/lib/access-roles.ts`; the last-admin count runs inside each path's mutation
transaction so it sees that transaction's read view. Two concurrent
deactivations of the last two admins remain a narrow residual TOCTOU on the
paths without an advisory lock, acceptable at club scale. The guarantee is
closed-world over de-logins of existing accounts: every other `canLogin` writer
in the codebase either creates a brand-new member (booking-request, school,
group-booking, and Xero-import contacts; nomination and family-request
dependants; admin member-create and CSV member-import rows, whose `canLogin`
value only seeds the new row) or passes `canLogin` as a read/token filter
(`normalizeAssignableAccessRoleTokens`, list/where clauses), and so cannot
strand an existing admin. The one remaining flow
outside these seven paths that can clear `canLogin` on an existing admin and is
not guarded is indirect: the age-down cron via a date-of-birth edit into a minor
tier.

Seasonal membership types are policy records, not access roles. `MembershipType`
stores the stable identifier, display text, active/archive state, sort order,
booking behavior, subscription behavior, allowed age tiers, and optional Xero
contact-group rules for built-in and admin-defined types. It also stores a
distinct `publicDescription` and opt-in `publiclyListed` flag; all existing and
new types start hidden. `MembershipAnnualFee` and `EntranceFee` are inclusive
effective-date schedules with integer-cent amounts and application plus
database overlap guards. Annual rows independently record billing basis and
proration policy per type. `FamilyGroup.billingMembershipId` is an explicit
finance-owned recipient validated against active group members; membered groups
without one are visible billing exceptions. Provider item/account codes remain
Xero mappings. During the one-release bridge, entrance amount reads are
schedule-first and use mapping amounts only as fallback. The admin settings
page presents types as an ordered policy list; create/edit opens a dedicated
editor for identity, behavior, allowed tiers, and Xero rule configuration, while
seasonal assignment roll-forward sits in its own preview/run section. The
built-ins are Full, Associate, Life, School, Non-Member, and Family; Associate
is the single Associate/Reserve-style built-in and can be renamed by the club.
Create and rename requests that would duplicate another type's display name
(case-insensitive exact match) are rejected with a 409. Age tiers stay separate
because the same tier can appear under several membership types. Age Tier Xero
groups are for broad age cohorts, Membership Type Xero groups are for status or
policy labels, and clubs can configure both when Xero needs both labels.
`SeasonalMembershipAssignment` records a member's type for a membership
`seasonYear`, assignment source, and optional date-only `applyFrom` changeover.
The initial backfill maps existing legacy roles to current-season assignments.
Admin changes to an individual member's seasonal type go through a preview that
reports affected future confirmed bookings, draft bookings, waitlist records,
current subscription state, and recent subscription history, then require an
admin reason before the audited save. The membership-type settings page can roll
assignments forward from one season to another idempotently, skipping existing
target-season assignments and reporting missing or inactive-type exceptions.
The Admin > Members list shows the current seasonal Membership Type beside the
Access column so operators can scan access and membership policy separately.
When Xero is connected, the Xero contact-group badges and filters on that page
are served from a local cache; a "Refresh Xero Groups" action repopulates it and
a contextual hint next to the button reports when the cache was last refreshed
(or prompts the operator to populate it when it has never been refreshed).
Booking pricing and booking gates resolve the member's effective seasonal type
for the booking season:
`MEMBER_RATE` uses normal member rates, `NON_MEMBER_RATE` uses non-member
nightly rates while preserving member identity, and `BLOCK_BOOKING` returns a
structured policy error before the booking is created or repriced. Subscription
displays and booking lockout also resolve the seasonal type: `NOT_REQUIRED` is
an effective status layered over the raw `MemberSubscription`/Xero history,
which remains stored and visible for audit. Seasonal type changes do not
automatically reprice existing future bookings. Committee assignments remain
separate public/contact metadata.

Membership subscription creation is snapshot-first. The planner in
`membership-subscription-billing.ts` reads effective fee schedules and seasonal
assignments, groups `PER_FAMILY` coverage only under an explicit active
same-family recipient, calculates integer-cent inclusive-month proration, and
resolves the explicitly configured `subscriptionIncome` account/item identifiers,
and returns a digest-bound preview. Explicit annual confirmation (or the
post-approval new-member hook) writes `MembershipSubscriptionCharge`, immutable
coverage joins, and visible `MembershipBillingException` rows under one
season-scoped advisory transaction lock. Provider calls happen later through a
`MEMBERSHIP_SUBSCRIPTION_INVOICE` Xero outbox operation.

`xero-subscription-invoices.ts` queries by the charge's immutable reference,
adopts only an exact AUTHORISED contact/account/item/amount/due-interval/ACCREC match, or creates
one AUTHORISED GST-inclusive invoice with the snapshotted `subscriptionIncome`
mapping. Draft/submitted/paid matches remain conflicts. It
persists invoice identity to the charge and every covered subscription before
calling Xero email. A retry therefore emails the persisted invoice rather than
creating another. Provider mismatches become local `CONFLICT` state and are
never corrected by an automatic Xero update.
Incremental reconciliation maps changed invoice IDs through charge coverage so
a paid shared-family invoice refreshes every active covered subscription, not
only the invoice contact. Dispatch uses the recipient member's current Xero
contact delivery details while retaining the immutable name/email snapshot for
audit.

`CommitteeRole` stores reusable master positions
and their role email aliases, and `CommitteeAssignment` links members to those
positions with blurb, sort order, published, show-phone, contactable, and active
flags. The public committee API reads only active, published assignments with
active roles, never selects member email, returns phone only when show-phone is
enabled, and exposes contact keys only for contactable assignments. The contact
form resolves those assignment keys server-side to the role email alias, then to
the linked member's email when the role email is blank, and finally to the club
contact address when no recipient email is available. Committee contact email
delivery stores an opaque committee-contact marker in EmailLog instead of the
recipient address.

Membership cancellation is a member-initiated account lifecycle workflow.
Requests can include the requester, dependants, non-login adults, and related
family adults. Login-capable adults receive their own confirmation link before
admin review. Admin approval disables the local membership, clears operational
family/email-inheritance links, preserves financial and lodge history, and
queues Xero cancellation operations.

Cancelled members can be archived through `MemberLifecycleActionRequest` with
the `ARCHIVE` action. Archive requires a reason and approval by a different
admin through the `/admin/membership-cancellations` review queue. Approval keeps
the member record and related history but marks it archived, inactive, and
non-login so default operational lists exclude it.

Member records created in error use `MemberLifecycleActionRequest` with the
`DELETE` action. A delete request requires a reason, approval by a different
admin, a clean eligibility check with no booking, financial, family, Xero, or
membership history blockers, and a retained member snapshot before hard
deletion. Direct `DELETE /api/admin/members/[id]` is intentionally disabled.

The lodge kiosk has its own PIN session model and permission tiers for
view-only, guest, hut-leader, and admin-style lodge actions. It supports guest
arrival/departure, expected arrival times, chores, and issue reporting without
exposing the full admin interface.

## Integrations

The external integration map: what the app calls, what calls back, and the
gate/direction of each. Every provider call stays behind a narrow helper and, by
policy, outside long database transactions.

```mermaid
flowchart LR
    App["Next.js app"]
    App -->|"PaymentIntents, SetupIntents, refunds"| Stripe["Stripe"]
    Stripe -->|"webhooks (idempotent)"| App
    App -->|"invoices, credit notes, contacts, payments"| Xero["Xero"]
    Xero -->|"inbound webhooks + reconciliation"| App
    App -->|"SMTP transactional email"| SES["AWS SES"]
    SES -->|"SNS bounce/complaint feedback"| App
    App -->|"cron/webhook errors via observability-bridge"| Sentry["Sentry"]
    App -->|"address autocomplete (optional, module-gated)"| Addy["Addy proxy"]
```

### Stripe

Stripe is used for PaymentIntents, SetupIntents, saved payment methods, refunds,
and webhook reconciliation. Webhook routes should be idempotent and must not
trust client-supplied payment state. Internet Banking payments are explicitly
excluded from Stripe-only PaymentIntent, refund, and recovery paths.

Superseded Stripe PaymentIntents that can no longer settle a booking are tracked
through `PaymentRecoveryOperation`. The recovery worker cancels still-open
intents, treats already-cancelled intents as complete, and queues/refunds late
captures without running the normal booking-confirmation path.

Refund recovery is exactly-once across multi-transaction payments (#1097): a
failed refund reports how much was refunded-and-recorded so the recovery row
is enqueued for only the remainder, and the worker freezes its
per-transaction allocation on the row (`allocationPlan`) before the first
Stripe call. Retries replay those exact slices with their original
idempotency keys — Stripe answers repeats with the original refund and the
`PaymentRefund` ledger dedupes by refund id — instead of re-deriving a
shifted allocation from whatever progress happens to be recorded. The
booking-cancellation (#1349) and refund-request (#1510) inline paths go
further and freeze the exact slices they execute on the row at **enqueue**
time — before any Stripe call — passing one frozen plan to both the inline
refund and the recovery enqueue, so a multi-transaction partial-progress
replay re-requests byte-identical slices under identical keys rather than a
re-derived allocation. A refund-request row enqueued before #1510 carries no
frozen plan and derives-at-replay (unchanged; post-#1507 single-transaction
payments — the dominant case — already share slice keys). The
recovery row also carries the originating route's Stripe key prefix
(`stripeKeyPrefix`, #1152), so even a refund that succeeded on Stripe but was
never recorded locally is replayed under its original keys rather than
re-minted — the same guarantee refund-request recoveries have had since
#1039. The replay also sends a **byte-identical request body** (#1507, the
refund-request and booking-modification counterpart of the booking-cancellation
convergence #1494): the cron rebuilds the Stripe metadata from the same shared
helpers the inline paths use (`buildRefundRequestRefundMetadata`; and for
modification refunds `buildBookingModificationRefundMetadata`, whose per-path
`reason` is reconstructed from the persisted key prefix), so a reused idempotency
key replays the original refund instead of being rejected as an
`idempotency_error` for mismatched parameters.

Additional PaymentIntent creation has the same durable safety net (#1096):
every price-increasing edit path (batch modify, date change, guest add,
single-guest removal) creates the intent through one shared settlement
helper, and a transient Stripe failure enqueues a
`CREATE_ADDITIONAL_PAYMENT_INTENT` recovery operation keyed to the booking
modification. The worker re-creates the intent with the original
modification-scoped Stripe idempotency key (so route and cron can never
double-mint), skips itself if a later edit already minted a newer additional
intent, and points any supplementary Xero invoice operation still waiting on
the failed intent at the recovered one.

Group-settlement PaymentIntents get the same safety net: switching a group
settlement to Internet Banking or re-attempting a card settlement voids the
superseded intent in Stripe, and if a stale intent still captures, the webhook
handler refunds it in full (with a deterministic idempotency key) and alerts
admins instead of settling anything.

Internet Banking group settlement uses a transactional outbox: the settlement
row and queued Xero invoice operation commit together. The worker fences invoice
issuance against organiser cancellation with global `lock(1)` while keeping the
Xero request outside the transaction. Cancellation that wins before the request
suppresses it; cancellation that wins while `createInvoices` is in flight causes
the worker to persist the provider identity, void the invoice idempotently, and
skip the invoice email. A failed void fails the outbox operation so its normal
retry path re-drives compensation.

### Operational Xero

Operational Xero handles member/contact sync, booking invoices, payments,
credit notes, item codes, contact groups, inbound webhooks, local caches, retry
queues, and usage metering. Xero tokens are encrypted at rest.
OAuth token refresh uses a short database-backed lease on the operational
token row so multiple app workers cannot use the same rotating refresh token.
Internet Banking bookings use this boundary to issue invoice-backed payment
instructions and reconcile settlement from inbound Xero invoice/payment state.
Unheld Internet Banking reconciliation performs the final capacity claim before
marking a booking paid. If the paid booking no longer fits, the payment is
recorded as succeeded, the booking is cancelled, member account credit is
created for the paid amount, Xero account-credit work is queued, admins are
alerted, and waitlists are processed. Held Internet Banking bookings are
released by the payment cron when their hold expiry passes unpaid; the release
cancels the booking, fails the pending payment, queues invoice-clearing
credit-note work, emails the member, records history/audit, and processes
waitlists.

### Finance reporting

Finance reporting uses the same operational Xero connection that booking,
payment, and membership flows use. The finance sync service reads reports,
invoice datasets, bank balances, and chart-of-accounts snapshots through that
connection, then stores `FinanceSnapshot` and `FinanceSyncRun` rows for page
rendering. There is no separate finance Xero OAuth app, token store, callback
route, or usage-metering table.

The simpler Base Reports page at `/admin/reports` is first-party and stay-night
based (#2368). One overlap query applies the selected lodge and deleted scope to
the explicit positive current-status cohort `PENDING`, `PAYMENT_PENDING`,
`CONFIRMED`, `PAID`, `AWAITING_REVIEW`, and `COMPLETED`; that same cohort owns
distinct booking/guest totals, weekly trends, current-status breakdown, and
booked revenue. Booking stay dates are `checkIn` inclusive / `checkOut`
exclusive, while the selected From/To dates are inclusive. Guest totals use each
guest row's own half-open `[stayStart, stayEnd)` envelope; sparse explicit guest
night rows do not override that envelope for this metric.
`Booking.finalPriceCents` is allocated
deterministically over the booking's complete stay before the selected range is
sliced, so $1.00 over three nights is 34/33/33 cents and a one-night slice keeps
its original share. Booked revenue is therefore not collected cash. Net
collected cash is a separate booking-level payment figure derived from captured
`Payment.amountCents` less refunds (#2408), never rebuilt from transaction rows;
outstanding additions remain separately visible (#2350). Reports selects only
captured `ADDITIONAL` transaction evidence to reuse #2408's consistency guard:
when a positive additional amount is marked succeeded without such evidence,
cash arithmetic is unchanged, a bounded server log names the affected booking
IDs, and the API returns only aggregate possible-gap cents/count for the page,
CSV, and PDF warning. Money on those report surfaces is rendered to exact cents.
Occupancy intentionally keeps the pre-existing PAID/COMPLETED-only utilisation
and custodian-exclusion semantics.

### Address autocomplete

Address autocomplete uses server-side Addy credentials only in
`src/lib/addy-api.ts`. Browser code talks to `/api/address-autocomplete/**`,
which is feature-gated by the `addressAutocomplete` Admin Module and rate
limited. Missing credentials and upstream failures return small error payloads;
address forms keep manual inputs editable so saving an address does not depend
on Addy availability.

### Email

AWS SES SMTP sends transactional email. SES SNS feedback is ingested for bounce
and complaint suppression. Email templates should avoid embedding secrets and
should use effective recipient logic for dependents where required. Editable
templates and admin/system delivery policies are registered in the email
message registry and surfaced in Admin Setup and Admin Notifications.
Rendered HTML is not retained in `EmailLog` (or emitted to development HTML
logs) for bearer-token, one-time-code, lodge-access, and other sensitive
templates. This includes every registry template whose required data contains a
`token`, plus the optional tokenized `chore-roster` link; SMTP still receives
the complete rendered message. Keep `SENSITIVE_EMAIL_LOG_TEMPLATES` aligned
whenever a template starts carrying a credential or action token.
Editable subjects reject secret-bearing tokens (including nomination, quote
response, and optional chore links), and the render path strips bearer-link
aliases from legacy stored overrides before SMTP, `EmailLog`, or application
logging receives the subject.
Every send carries a REQUIRED, typed `bookingContext`
(`{ bookingId, recipient } | "none"`) so the mailer knows which booking a
message belongs to and which exact recipient authority it must verify; that is
the choke point
for the per-booking "No emails" switch (`Booking.noEmails`, #2258), which
withholds every member-facing message for a booking, records each withhold as an
`EmailLog` row with status `SKIPPED_NO_EMAILS`, never touches admin-audience or
account/security mail, and fails closed if the switch cannot be read. The retry
cron and the two Xero-sent invoice emails re-check the same switch because they
bypass `sendEmail`. See `docs/DOMAIN_INVARIANTS.md` for the full contract.
For every live registered template in the booking-scoped suppression inventory,
that same choke point may add the canonical encoded
`/bookings/<booking-id>` detail URL (#2362). `booking-email-authority.ts`
re-reads the booking and recipient member, then mirrors the detail page's read
gate: active login-capable owner, linked member, or bookings-area viewer; deleted
bookings remain Full-Admin-only. The actual SMTP destination must also still be
that member's current direct or flattened inherited mailbox. Public/non-login
contacts and aggregate reports are explicit recipient categories and never
receive the authenticated URL. Built-in HTML rewrites or adds one booking CTA
only after authorization. Stored override SOURCE stays byte-for-byte unchanged;
at the final delivery boundary an authorized override is unchanged, while an
unauthorized delivery copy loses any legacy/admin-authored authenticated booking
href. Bearer action URLs are not booking detail URLs and are never removed by
this policy. Retry-safe booking rows persist the checked recipient member id (or
an explicit null for public/aggregate mail), override provenance, and whether
finalized HTML contained a detail href in `EmailLog`. Their retained HTML lives
in `bookingRetryHtmlBody`, not legacy `htmlBody`, so a rolled-back pre-#2362
worker cannot select new-version booking rows. The current worker repeats
mailbox ownership and booking authorization before its guarded claim, then
re-finalizes both built-in and override delivery copies. A legacy row with
unknown context retires fail-closed for manual review.
If an admin/system alert cannot be delivered to any opted-in admin recipient
because every send is suppressed or fails, the app records a critical
communication audit event and surfaces it in Admin Email Deliverability.
Failed token-bearing lifecycle emails for nomination requests, member setup
invites, and membership cancellation confirmations are not auto-retried because
their HTML is redacted; Admin Email Deliverability exposes a reissue action that
creates a fresh token and resends the lifecycle email after any active
suppression has been cleared.
Nomination request links also have workflow-level recovery: expired unconfirmed
links are renewed by the `nomination-reminders` cron weekly for four automatic
reminders, and admins can refresh or replace unconfirmed nominators from the
member-applications queue.
Membership cancellation, archive, and hard-delete lifecycle messages use that
registry so operators can preview and override copy without bypassing the
shared `sendEmail` path.

## Cron Jobs

Cron jobs run inside the `app` cron-leader container. Web-only blue/green slots
disable cron with `CRON_ENABLED=false`.

The jobs grouped by cadence (the table below is the authoritative per-job
reference):

```mermaid
flowchart TD
    Leader["app cron-leader<br/>(CRON_ENABLED=true)"]
    Leader --> Q15["Every 15 min<br/>payment-recovery, xero-outbox,<br/>xero-operation-replay, xero-inbound-reconcile"]
    Leader --> Q30["Every 30 min<br/>waitlist-processor, email-retry"]
    Leader --> Q3h["Every 3 h<br/>additional-payment-reminders, confirm-pending,<br/>placeholder-guest-name-reminders, pre-arrival-reminders,<br/>purge-booking-requests, quote-expiry-reminders,<br/>school-attendee-confirmations, group-settlement-reaper,<br/>policy-exception-hold-reaper, hosting-coverage-reevaluation"]
    Leader --> Daily["Daily<br/>complete-bookings, data-pruning, draft-cleanup,<br/>age-up, capacity-warnings, admin-digest,<br/>credit-reconciliation, hut-leader-auto-assign,<br/>checkin-reminders, pending-deadline-alerts,<br/>member-guest-consent-expiry,<br/>nomination-reminders, finance-daily-sync,<br/>xero-membership-refresh, xero-link-backfill,<br/>xero-link-cleanup, xero-reconciliation-report,<br/>xero-credit-sync-check"]
    Leader --> Cfg["Configurable<br/>backup"]
```

| Job | Schedule | Purpose |
| --- | --- | --- |
| `confirm-pending` | Every 3 hours | Confirm pending bookings after hold deadlines |
| `group-settlement-reaper` | Every 3 hours | Release CONFIRMED-unpaid group children when an organiser-pays settlement stays unpaid past its window (default 48h, clamped to check-in); voids the open intent and notifies the group. Second phase (#1094): cancels the reverted PAYMENT_PENDING children, with a joiner notice, once the FAILED settlement sits unretried through another full window. Third phase (#1236): resumes a crash-interrupted organiser-cancel cleanup (ORGANISER_PAYS group still not CANCELLED under a CANCELLED organiser booking, older than `GROUP_CANCEL_RESUME_GRACE_MINUTES`, default 15m), re-driving the idempotent joiner cleanup — its persisted refund plan reconstructs the per-child refund mirror rather than recomputing |
| `policy-exception-hold-reaper` | Every 3 hours | Release the beds an abandoned policy-exception request is holding (#2553). Scans `REQUESTED` `POLICY_EXCEPTION` requests with a `HOLD` aggregate that still have live `PolicyExceptionReservationNight` rows, and moves each one past its immutable `holdExpiresAt` to `EXPIRED` through `resolvePolicyExceptionRequestTerminal` — the same guarded `version` claim and atomic release the reject/cancel/supersede outcomes use, under global -> per-lodge locks. A request holding no beds is never touched; a decision landing in the same window wins the claim and the reaper releases nothing. Each expiry then writes a `booking-policy-exception-request.expired` audit row and sends the member a `policy-exception-request-expired` courtesy notice, both AFTER the release commits and both isolated, so a failed audit write or a bounced email can neither roll back nor repeat a capacity release nor stop the run's other candidates. A past-deadline row the shared transition refuses outright is counted as `unresolvable` and logged at warn rather than reported as a clean run |
| `additional-payment-reminders` | Every 3 hours | Chase an uncollected additional payment while the stay is still ahead (#2350) |
| `pre-arrival-reminders` | Every 3 hours | Send current directions and door-code reminders before check-in |
| `purge-booking-requests` | Every 3 hours | Delete expired declined and never-verified public booking requests after the retention window |
| `quote-expiry-reminders` | Every 3 hours | Remind public booking-request quote recipients before their quote link expires (sends a fresh working link) |
| `school-attendee-confirmations` | Every 3 hours | Prompt school contacts to confirm their attendee list before check-in (#1101): first email `attendeeConfirmationLeadDays` before arrival, re-sent every `attendeeConfirmationReminderDays` with a fresh tokenized link until confirmed or check-in |
| `placeholder-guest-name-reminders` | Every 3 hours | Chase a member whole-lodge booking whose party is still "Guest 1..N" (#2550). Uses the same `attendeeConfirmationLeadDays` / `attendeeConfirmationReminderDays` settings as the school prompt, escalating to a DAILY final reminder from two days before check-in through the morning of arrival (the window deliberately includes the arrival day), and stops as soon as every guest is named. No token and no public page — the member edits their own guests behind their login. Visibility only: it never withholds check-in, confirmation, or roster generation |
| `hosting-coverage-reevaluation` | Every 3 hours | Drain the bounded hosting-coverage queue (#2576). Every path that can change adult-member qualification records the owner, lodge and exact nights to re-examine inside its own transaction, and drains that inline right after committing; this sweep is the BACKSTOP and authority on completion. Each claimed item re-reads committed facts inside a short transaction so its transaction-scoped owner lock protects incident reconciliation, never a lodge-wide sweep; email runs after that commit under an expiring delivery lease, is stamped only after success, and failed delivery is retryable. It opens, updates or resolves one urgent compliance incident per booking, never changes booking status, and exposes unresolved rows in the Booking Officer's `/admin/bookings` queue. |
| `payment-recovery` | Every 15 minutes | Cancel or refund superseded Stripe PaymentIntents |
| `waitlist-processor` | Every 30 minutes | Expire offers and advance waitlist |
| `email-retry` | Every 30 minutes | Retry failed email sends |
| `xero-outbox` | Every 15 minutes | Process queued Xero outbox operations |
| `xero-operation-replay` | Every 15 minutes | Replay queued Xero retries |
| `xero-inbound-reconcile` | Every 15 minutes | Process inbound Xero events |
| `complete-bookings` | Daily | Mark past bookings completed |
| `xero-membership-refresh` | Daily when enabled | Sync membership invoice state |
| `xero-link-backfill` | Daily | Backfill canonical Xero object links into the ledger |
| `xero-link-cleanup` | Daily | Clean stale canonical Xero object links |
| `xero-reconciliation-report` | Daily | Send the Xero reconciliation report |
| `xero-credit-sync-check` | Daily | Reconcile BookingApp's stamped applied credit against Xero's live invoice allocations and warn admins on drift with the exact amount (#2501); read-only, self-throttled |
| `finance-daily-sync` | Daily when the finance dashboard module is enabled | Refresh finance report/invoice/balance snapshots from the operational Xero connection |
| `data-pruning` | Daily | Prune expired tokens/logs and run audit retention |
| `draft-cleanup` | Daily | Delete expired draft bookings |
| `member-guest-consent-expiry` | Daily at 04:30 NZT when the member-guests module is enabled | Expire lapsed member-guest consent requests, release the bed, and settle the reduction as account credit to the booking owner; rows the shared removal path refuses are counted separately for the admin exception list |
| `pending-deadline-alerts` | Daily | Alert admins about pending bookings approaching deadline |
| `credit-reconciliation` | Daily | Reconcile account-credit ledger state and alert on refunded Stripe payments missing Xero credit notes |
| `hut-leader-auto-assign` | Daily | Suggest hut leaders |
| `age-up` | Daily | Process age-tier/member transitions |
| `capacity-warnings` | Daily | Alert when lodge occupancy approaches limits |
| `admin-digest` | Daily | Send admin summary email |
| `nomination-reminders` | Daily | Renew expired unconfirmed nomination links weekly, up to four automatic reminders |
| `checkin-reminders` | Daily | Send next-day check-in reminders |
| `backup` | Configurable | Upload PostgreSQL dumps to S3 |

### Failure observability (audit gap G5 — partially closed by design)

Cron and webhook FAILURE paths bridge their `logger.error`/`logger.fatal` catch
handlers to Sentry through `reportCronError`/`reportWebhookError` in
`src/lib/observability-bridge.ts`, which log via the pino singleton **and**
forward to Sentry with a stable `fingerprint`. This is a scoped report-helper,
not a global pino transport: ordinary route/request loggers never import the
bridge and stay log-only, so a noisy request path cannot cause alert fatigue —
the objection #1150 raised against a global bridge. The boundary is deliberate:
top-level cron catch handlers (including the general cron runner's per-task
failures) and top-level webhook catch handlers (Stripe, Xero, SES/SNS) are
bridged, while best-effort per-item failures inside those jobs (e.g. a single
joiner email that will be retried, waitlist item failures) stay log-only to
preserve signal-to-noise. An in-process cooldown
(`OBSERVABILITY_SENTRY_DEDUP_COOLDOWN_MS`, default 5 minutes) keyed by the
fingerprint stops a stuck cron/webhook from emitting one Sentry event per tick;
the Sentry fingerprint dedups grouping across processes. Cross-instance
exact-once alerting remains future work (#1211), and which fingerprints page
whom is operator-side Sentry alert-rule configuration.

### Auth-bounce diagnostics (#1669)

When the `(authenticated)` or `(admin)` layout guard is about to redirect to
`/login` because the wrapped `auth()` returned null, `recordAuthBounce()` in
`src/lib/auth-diagnostics.ts` classifies why before the redirect:

- **`no-cookie`** — normal anonymous visit: a `debug`-level pino line only.
  No `AuditLog` row, no Sentry event, no reference code.
- **`session-invalidated`** — the session decoded but the password-change
  revocation gate nulled it: pino `info` plus a durable `AuditLog` row
  (`action=auth.bounce`, `category=auth`, retention
  `diagnostic_high_volume`) capturing `memberId`, session issuance, the
  revoking change time, and their delta. No Sentry.
- **`cookie-present-no-session`** — a session cookie was sent but no server
  session emerged (the real anomaly): pino `warn`, the `AuditLog` row, and
  **one** Sentry event deduped by an in-process cooldown (same
  `OBSERVABILITY_SENTRY_DEDUP_COOLDOWN_MS` knob) under the stable
  fingerprint `["auth-bounce", "cookie-present-no-session"]`.

The Sentry path is deliberately **not** part of `observability-bridge.ts` —
that bridge's contract stays cron/webhook-only; this is a second provably
scoped emitter with exactly one fingerprint. Durable bounces mint a random
8-hex reference code, appended to the login URL as `ref` and shown on the
login page ("Trouble signing in? Reference: …"); the `AuditLog` row is keyed
by it via `requestId`. Token values and raw cookie contents are never read
into any sink (only cookie-name matches, chunk counts, and byte lengths),
the durable record carries `memberId` rather than an email address, and the
whole path is exception-guarded so a logging/DB failure can never turn the
307 redirect into a 500. The audit write runs post-response via `after()`
and is capped per process-minute (`AUTH_BOUNCE_AUDIT_MAX_WRITES_PER_MINUTE`,
default 10) so an unauthenticated junk cookie cannot be spammed into
unbounded `AuditLog` inserts — suppressed rows are tallied onto the next
written row's `suppressedSinceLastWrite`, and the pino line stays
unthrottled so raw bounce volume remains visible in logs. Note for
operators: rotating `AUTH_SECRET` turns every live session cookie into a
`cookie-present-no-session` bounce until those cookies expire (≤8h) — a
row-per-bounce burst in the audit trail and at most one Sentry event per
cooldown per container is expected then, not a regression.

Two front-of-house guarantees close the loop the diagnostics observe. The
login page is session-aware: an already-authenticated visit to `/login`
never renders the sign-in form — it redirects through the same gates as
`login/verify` (forced password change, then the two-factor funnel, then the
sanitised `callbackUrl`), so a tab bounced to `/login` while actually
holding a live session self-heals on its next load instead of stranding on
the form with no error. And a successful password sign-in leaves `/login`
with a full document navigation rather than a client-router push: the soft
push could replay the router's cached logged-out entry for the destination
(the very bounce that produced the `/login` visit), which resurfaced as the
silent login loop investigated in #1669 — the bounced replay carries no
session cookie, so it lands in the deliberately quiet `no-cookie` bucket
above.

## AI Diagnostics knowledge bundle

The admin-only AI Diagnostics product (epic #2369) answers code/docs/schema
questions from the artifact **actually running**, not a working tree or model
memory. It does this through a deterministic, versioned **knowledge bundle**
(#2372): a JSON snapshot of the allowlisted docs, schema, and (optionally by
overlay) source of the deployed commit, with per-file content hashes, sensitivity
tags, symbols, and a bounded, individually-hashed excerpt index.

The bundle is generated inside the Docker builder by `npm run diagnostics:bundle`
(`docs/` and `.git` are dropped from the runtime image, so the commit SHA is
injected at build time via `GIT_COMMIT_SHA`), traced into `.next/standalone`, and
copied into the runner. It is:

- **Deterministic** — a pure function of `(files, commitSha, observedAt)` with
  sorted keys and LF-normalized content, so the same source is byte-identical.
- **Fail-closed** — generation refuses to emit if a secret is detected; the
  runtime loader (`src/lib/diagnostics/knowledge/`) disables code answers on a
  missing, malformed, tampered, hash-mismatched, or unverified-commit bundle,
  never falling back to a working tree.
- **Cited evidence, never authority** — retrieval sends only bounded excerpts,
  each with a citation verifying commit + content hash + excerpt hash, framed as
  verbatim source at a commit and explicitly not a live runtime fact. The bundle
  is untrusted, prompt-injection-capable evidence.

Private/fork knowledge uses a generic, deployment-owned overlay
(`config/diagnostics-knowledge.json`, git-ignored); public code never mandates
any club's paths. Full reference:
[`diagnostics/KNOWLEDGE_BUNDLE.md`](diagnostics/KNOWLEDGE_BUNDLE.md).

## AI Diagnostics typed page context

The same product also needs to know **which admin page** the operator is looking
at. It does not scrape the DOM, take a screenshot, or accept a free-text blob
(the member-facing Page help assistant's flat `pageContext` string is deliberately
left alone and never reused here). Instead the browser sends a strictly typed
**selector** — a key in a server-side route registry, at most one opaque record
id, and a handful of route-allowlisted view tokens — and the server re-derives
every fact itself (#2373, `src/lib/diagnostics/page-context/`).

**A client value selects; it never asserts.** Resolution runs four gates:
parse (strict schema, then the route's own allowlists, rejecting wholesale
rather than dropping a bad token), authorize (the caller's permission matrix
re-read from the database-joined access roles on **every** resolution — never a
JWT or a cache — and AND across every area the route declares), re-fetch (a
fixed, typed, column-allowlisted read of the one record, whose **kind comes from
the registry, never the client**), then bound (redact free text, cap every fact,
stamp observed-at, attach approved audit metadata only). That metadata describes
the **attempt** — a hashed record reference is recorded whether the lookup hit or
missed, so id probing through this path cannot audit as "no record requested".

Identifying fields are **opt-in per record**; without the opt-in the record
resolves to non-identifying state plus an explicit "personal detail omitted"
notice. A registry row can never be gated below the admin route lattice's own
requirement for its path — a contract test resolves each registered pathname
**and each of its allowlisted step sub-paths** through `getAdminRouteRequirement`
and asserts it, which is what keeps a support-gated row from allowlisting a
sub-page gated on finance. The same fresh read also refuses an account the rest of
the admin surface refuses (deactivated, or under a forced password change), so a
session still holding a cookie cannot outlive its own lock-out here. Full
reference: [`ai-diagnostics/page-context.md`](ai-diagnostics/page-context.md).

## AI Diagnostics SELECT-only tool substrate

The third evidence channel is the database, and it is the one that needed its own
database identity (#2374, `src/lib/diagnostics/tools/`). **The model never supplies
SQL.** A tool is a server-owned record pairing a fixed statement with a fixed
parameter binding, a fixed projection, fixed row/byte ceilings, and a fixed
admin-permission requirement; the model chooses an entry by id and supplies
arguments a `.strict()` schema has already accepted, which become positional
parameters and nothing else. No code path concatenates caller text into SQL.

**Reads run as a dedicated non-superuser role**, `AI_DIAGNOSTICS_DATABASE_URL`,
never the application's Prisma client — the Compose app role is a PostgreSQL
superuser, so reusing it would put a diagnostics query one bug away from the
encrypted credential store (ADR-007). The credential is refused unless it is
present, parseable, and demonstrably not the application role; and the *role* is
refused unless the server itself confirms it holds no superuser, `CREATEDB`,
`CREATEROLE`, `REPLICATION`, `BYPASSRLS`, database `TEMPORARY`/`CREATE`, schema
`CREATE`, file-reading function privilege, or escalating predefined-role
membership. Provisioning is an operator step
(`npm run diagnostics:provision-role`), not a migration: a database role is cluster
state, needs a secret the schema must never contain, and its `SELECT` allowlist is
declared in public code so "which tables can Diagnostics read" is answerable by
reading one file. The delivered support, booking/membership and finance packs
(AID-6A/B/C, #2375–#2377) declare **26 relations and 243 columns**, every grant by
column. `AuditLog` is limited to nine stable-code/correlation columns; credentials,
provider payloads, free text and undeclared personal fields remain unreadable. A
column grant makes the refusal PostgreSQL's own, so `SELECT "ipAddress" FROM
"AuditLog"` fails as the diagnostics role. The runtime self-check verifies both
directions of privilege drift: missing declared relations/columns are
`under_provisioned`, while undeclared reads or table-wide SELECT on any
column-restricted declaration are `over_privileged` — including a declaration that
currently happens to name every physical column.

Each read runs inside `BEGIN READ ONLY` with its own `statement_timeout`,
`lock_timeout`, `idle_in_transaction_session_timeout`, and `search_path` pinned to
`public`, and the executor wraps the entry's SQL in its own outermost `LIMIT` so a
tool cannot ship an unbounded scan by omission. Read-only at the transaction level
is the database's own refusal of every write and DDL statement independently of the
role's grants, so both layers must fail before a write is possible.

A registry entry declares one of two closed evidence sources. `select_only_sql` is
the fixed statement above. `server_owned` (AID-6A/B/C, #2375–#2377) reads a fixed, first-party,
read-only calculation the application already exposes to admins — diagnostics
readiness, the monthly budget/usage panel, the authoritative cron health
classification, the deployed bundle's identity — because those answers depend on
encrypted credential state and on a verdict about the diagnostics role's own
connection, which ADR-007 puts permanently out of that role's reach, and because a
second calculation in SQL could drift from the admin screen. It is not a second
privileged path: it runs through the same gates, and the only one it skips is the
SELECT-only credential check, which does not govern it — and must be skipped, or
readiness would become unreportable exactly when that credential is the fault.
The three booking/membership server-owned sources compose multiple ordinary READ
COMMITTED statements without claiming a transaction snapshot: `observedAtUtc`
means assembly completion, facts may span instants, and their model-facing scopes
require a rerun before action or a definitive conclusion.

Ten gates run in a fixed order and every one returns **no rows**: registry, loop
budget, fresh authorization, arguments, metering, credential, read, projection,
size, audit. Authorization runs *before* argument parsing so the difference between
"invalid arguments" and "permission denied" cannot be used as an oracle for a
tool's argument shape, and so an unauthorized invocation never opens a connection;
the audit row is written *before* any evidence is returned, and evidence is
discarded if it cannot be written. An over-size result is a refusal, never a silent
trim. Withholding a tool definition from the model is a usability courtesy — the
per-invocation permission re-read is the control. Full reference:
[`ai-diagnostics/tools.md`](ai-diagnostics/tools.md); the registered tools, their
permissions and their projections in
[`ai-diagnostics/tool-pack-support.md`](ai-diagnostics/tool-pack-support.md),
[`ai-diagnostics/tool-pack-booking-membership.md`](ai-diagnostics/tool-pack-booking-membership.md),
and [`ai-diagnostics/tool-pack-finance.md`](ai-diagnostics/tool-pack-finance.md);
operator setup in
[`ai-diagnostics/deployment.md`](ai-diagnostics/deployment.md).

Every result also carries a **stable evidence state** (`src/lib/diagnostics/case/`),
because an empty result cannot distinguish "we looked and there is nothing" from "you
were not permitted to see it" from "this deployment is not set up for it" — and a
model shown one with no state narrates whichever is most plausible. The same module
holds the shared diagnostic-case contract the domain packs contribute to, where a
permission denial is recorded as an outcome rather than as a missing source and every
finding carries a confidence so an inference cannot be presented as an authoritative
rule result.

## Security and Privacy Boundaries

- Auth uses credentials sessions with explicit admin, admin-area, and finance
  guards.
- Finance access is separate from general admin access; `FINANCE_ADMIN` also
  grants Treasurer edit access to finance admin routes.
- Public bearer tokens are stored hashed or encrypted according to use case.
- Logs, Sentry events, and webhook records should be redacted before storing or
  emitting sensitive values. `src/lib/redact-sensitive-json.ts` is the one
  chokepoint: it strips credentials, tokens, payment identifiers and person
  fields BY KEY NAME, and bounds its own walk so a self-referencing record
  cannot overflow the stack from inside a logging call. Because coverage is by
  key spelling it is a floor rather than a guarantee, and the admin-action audit
  trail deliberately keeps more than a log line does — see
  [`INV-PRIV-011`](invariants/analytics-and-privacy.md#inv-priv-011).
- Mutation routes should validate inputs with structured schemas and enforce
  role/session checks close to the route boundary.
- External service callbacks and webhooks must verify signatures, state, or
  expected origin data before mutating local state.
- Google Analytics is optional and privacy-gated (#2573). Three things gate the
  tag, and the club controls the third: the Analytics module must be on, a valid
  GA4 measurement id must be saved in the database (Admin → Integrations →
  Google Analytics — the environment variable was removed from runtime, with no
  fallback), and the route must be analytics-eligible. With the consent banner
  enabled — the default and the recommended option — the visitor must also have
  accepted, and until then no script, request, cookieless ping or consent-status
  signal reaches Google at all. With the banner disabled the tag loads
  automatically and the visitor opts out afterwards from the footer's Analytics
  preferences control. Advertising consent categories are denied in both modes.
  The eligible-route policy is fixed and application-controlled
  (`src/lib/analytics-route-policy.ts`): the public website only, never `/admin`,
  never an authenticated member page, and never an address carrying a token, PIN
  or personal identifier — and only `origin + pathname` is ever sent, never a
  query string or fragment.

## Deployment and Migrations

Production deployment uses the blue/green runner documented in `DEPLOYMENT.md`.
Database migrations must follow `docs/BLUE_GREEN_MIGRATION_POLICY.md` so old
and new app versions can overlap safely during cutover.

Staging and accessibility checks use `docker-compose.staging.yml`,
`Caddyfile.staging`, `.env.staging.example`, and the workflow in
`docs/STAGING_ACCESSIBILITY.md`.

## Configuration

The environment contract is documented in `.env.example` and
`.env.staging.example`. Use test or demo service credentials outside production.
Do not commit real `.env`, database dumps, generated reports, logs, or build
artifacts.
