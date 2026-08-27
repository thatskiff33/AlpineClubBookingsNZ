# Documentation Coverage Matrix

Audience: Developer, Agent (workplan input)

This matrix enumerates **every admin route area** under
`src/app/(admin)/admin/*` and records, for each, the reference documentation
that exists today and whether a dedicated **operator guide** (per the skeleton
in [`STYLE_GUIDE.md`](STYLE_GUIDE.md)) exists yet.

It was the authoritative workplan input for the operator-guide programme (issue
#2050), and is now its maintenance checklist. "Reference coverage" means
architecture/runbook prose that describes the behaviour; it is **not** the same as
a task-focused operator guide with screenshots. #2049 laid the foundation and
#2050 filled every gap, so each admin row now links a guide (no `GAP` remains) —
keep the links current as areas change.

The area list is generated from the actual route directories (excluding
`__tests__`), so it is exhaustive and will not silently miss a surface. The
count that used to stand here said 70 and was measured once; it had already
drifted from the table below by the time #2989 added a row, so it is stated as a
rule rather than as a figure nobody re-measures.

When a new admin area is added, add a row here in the same PR (this is part of
the docs-lockstep rule in `AGENTS.md`).

**Where the guides go:** every operator guide lands in **`docs/guides/`**, one
file per area named after the route (`docs/guides/bookings.md`), per
[`STYLE_GUIDE.md`](STYLE_GUIDE.md) ("Where operator guides live"). When you fill
a `GAP`, replace it with a relative link to that file (e.g.
`[guide](guides/bookings.md)`).

## How to read the columns

- **Area** — the route directory, i.e. `/admin/<area>`.
- **Permission area** — the `ADMIN_PERMISSION_AREAS` bucket it resolves to (see
  `ARCHITECTURE.md` → "Admin and Lodge"). Useful for grouping guides.
- **Reference coverage** — existing doc(s) that describe the behaviour, or `—`.
- **Operator guide** — `GAP` (no guide yet, planned in #2050), or a link once
  the guide lands.
- **Batch** — which #2050 delivery batch (1–4) this admin area belongs to; see
  [Delivery batches](#delivery-batches-2050) below. (Batch 5, member-facing
  journeys, is the public/member surface and has no admin rows here — it has
  **shipped** as the member/guest guides under
  [`user-guide/`](user-guide/README.md).)

## Matrix

| Area (`/admin/…`) | Permission area | Reference coverage | Operator guide | Batch |
| --- | --- | --- | --- | --- |
| `access-roles` | support | `ARCHITECTURE.md` (access roles / definitions) | [guide](guides/access-roles.md) | 4 |
| `age-tier-settings` | bookings | `ARCHITECTURE.md`, `AUTHORITATIVE_FEES.md` | [guide](guides/age-tier-settings.md) | 1 |
| `ai-diagnostics` | overview (page); support (API) | [architecture](ai-diagnostics/architecture.md), [deployment](ai-diagnostics/deployment.md), [ux](ai-diagnostics/ux.md), [e2e-matrix](ai-diagnostics/e2e-matrix.md), [hub](ai-diagnostics/README.md) | [deployment/operator guide](ai-diagnostics/deployment.md) | — (AID module, off by default; outside #2050) |
| `alpine-server` | finance | [`guides/integrations.md`](guides/integrations.md), `DEPLOYMENT.md` (cron endpoint), `SECURITY-ATTACK-SURFACE.md` (provider list) | [guide](guides/integrations.md) | — (Alpine Central Server module, off by default) |
| `appearance` | content | — | [guide](guides/appearance.md) (incl. `appearance/identity`) | 4 |
| `audit-log` | support | `AUDIT_RETENTION_ARCHIVE_RUNBOOK.md` | [guide](guides/audit-log.md) | 4 |
| `background-jobs` | support | `ARCHITECTURE.md` (Cron Jobs) | [guide](guides/background-jobs.md) | 4 |
| `backups` | support | `CONFIGURATION.md`, `DEPLOYMENT.md`, `MAINTENANCE.md`, `SECURITY-ATTACK-SURFACE.md` | [guide](guides/backups.md) | 4 |
| `bed-allocation` | bookings | `ARCHITECTURE.md` (bed allocation), `CAPACITY_MODEL.md` | [guide](guides/bed-allocation.md) | 1 |
| `book` | bookings | — (admin book-on-behalf) | [guide](guides/book.md) | 1 |
| `booking-approvals` | bookings | `STATE_MACHINES.md` | [guide](guides/booking-requests.md) (redirect → Approvals tab) | 1 |
| `booking-change-requests` | bookings | `STATE_MACHINES.md` | [guide](guides/booking-requests.md) (redirect → Changes tab) | 1 |
| `booking-messages` | support | — | [guide](guides/booking-messages.md) | 1 |
| `booking-policies` | bookings | `ARCHITECTURE.md` (booking policies), `CANCELLATIONS.md` | [guide](guides/booking-policies.md) | 1 |
| `booking-requests` | bookings | `ARCHITECTURE.md` (public booking requests) | [guide](guides/booking-requests.md) | 1 |
| `bookings` | bookings | `ARCHITECTURE.md` (booking/payment flow), `STATE_MACHINES.md` | [guide](guides/bookings.md) | 1 |
| `bookings-setup` | bookings | — | [guide](guides/bookings-setup.md) | 1 |
| `chores` | lodge | — | [guide](guides/chores.md) | 3 |
| `club-time` | support (route map); **Full Admin** enforced in the routes | [`invariants/product-configuration.md`](invariants/product-configuration.md) (`INV-CONFIG-002`), [`CONFIGURATION.md`](../CONFIGURATION.md) | [guide](guides/club-time.md) | — (CT-1 #2989, epic #2988; postdates #2050) |
| `environment` | support (route map); **Full Admin** enforced in the routes | [`invariants/product-configuration.md`](invariants/product-configuration.md) (`INV-CONFIG-003`), [`CONFIGURATION.md`](../CONFIGURATION.md) | [guide](guides/environment-role.md) | — (ENV-SAFETY 1 #3034, epic #2986; postdates #2050) |
| `committee` | membership | `ARCHITECTURE.md` (committee roles/assignments) | [guide](guides/committee.md) | 2 |
| `communications` | membership | `src/lib/email-message-registry.ts` | [guide](guides/communications.md) | 4 |
| `config-transfer` | support | `config-transfer/README.md` (planned feature) | [guide](guides/config-transfer.md) | 4 |
| `dashboard` | overview | `ARCHITECTURE.md` (Needs Attention / badges) | [guide](guides/dashboard.md) | 4 |
| `message-board` | membership | `multi-lodge/lodge-scoping-contract.md` (club-wide scoping, D-C1) | [guide](guides/message-board.md) | — (commsPortal module, off by default) |
| `notices` | membership | `src/lib/notices.ts` (audience resolution + visibility predicate) | [guide](guides/member-notices.md) | 5 |
| `deletion-requests` | membership | `ARCHITECTURE.md` (member lifecycle delete) | [guide](guides/deletion-requests.md) | 2 |
| `display` | content | `lobby-display/README.md`, `lobby-display/operating.md` | [guide](guides/display.md) (+ [feature hub](lobby-display/README.md), [operating](lobby-display/operating.md)) | 4 |
| `email-deliverability` | support | `ARCHITECTURE.md` (email), email registry | [guide](guides/email-deliverability.md) | 4 |
| `email-messages` | support | `src/lib/email-message-registry.ts` | [guide](guides/email-messages.md) | 4 |
| `family-groups` | membership | `ARCHITECTURE.md` (family groups / billing) | [guide](guides/family-groups.md) | 2 |
| `family-suggestions` | membership | `ARCHITECTURE.md` (hidden family suggestions) | [guide](guides/family-suggestions.md) | 2 |
| `fee-configuration` | finance | `AUTHORITATIVE_FEES.md` | [guide](guides/fees.md) (redirect → Fees) | 2 |
| `fees` | finance | `AUTHORITATIVE_FEES.md` | [guide](guides/fees.md) | 2 |
| `health` | support | — | [guide](guides/health.md) | 4 |
| `hut-leaders` | lodge | `ARCHITECTURE.md` (hut-leader auto-assign cron) | [guide](guides/hut-leaders.md) | 3 |
| `image-manager` | content | — | [guide](guides/image-manager.md) | 4 |
| `induction` | membership | — | [guide](guides/induction.md) | 2 |
| `integrations` | support | `CONFIGURATION.md`, `DEPLOYMENT.md` | [guide](guides/integrations.md) | 4 |
| `internet-banking` | finance | `ARCHITECTURE.md` (Internet Banking), `xero/ARCHITECTURE.md` | [guide](guides/internet-banking.md) | 2 |
| `issue-reports` | support | `ARCHITECTURE.md` (issue reports / stuck states) | [guide](guides/issue-reports.md) | 4 |
| `lockers` | membership | — | [guide](guides/lockers.md) | 2 |
| `lodge` | lodge | `ARCHITECTURE.md` (lodge kiosk / operations) | [guide](guides/lodge.md) | 3 |
| `lodge-instructions` | lodge | `src/lib/token-catalogue.ts`, `PUBLIC_PAGE_CONTENT_TOKENS.md` | [guide](guides/lodge-instructions.md) | 3 |
| `lodges` | lodge | `multi-lodge/README.md`, `multi-lodge/feature-overview.md` | [guide](guides/lodges.md) (+ [feature hub](multi-lodge/README.md)) | 3 |
| `maintenance-reports` | lodge | `multi-lodge/lodge-scoping-contract.md` (scoping), `SECURITY.md` (QR bearer token) | [guide](guides/maintenance-reports.md) | — (maintenanceReports module, on by default; outside #2050) |
| `member-applications` | membership | `ARCHITECTURE.md` (membership application / nominations) | [guide](guides/member-applications.md) | 2 |
| `member-fields` | membership | — | [guide](guides/member-fields.md) | 2 |
| `members` | membership | `ARCHITECTURE.md` (members, CSV import, roles) | [guide](guides/members.md) | 2 |
| `membership-cancellation` | membership | `CANCELLATIONS.md` | [guide](guides/membership-cancellations.md) (settings folded in) | 2 |
| `membership-cancellations` | membership | `CANCELLATIONS.md`, `ARCHITECTURE.md` (cancellation review queue) | [guide](guides/membership-cancellations.md) | 2 |
| `membership-setup` | membership | `ARCHITECTURE.md` (membership types) | [guide](guides/membership-setup.md) | 2 |
| `membership-types` | membership | `ARCHITECTURE.md` (seasonal membership types) | [guide](guides/membership-types.md) | 2 |
| `modules` | support | `CONFIGURATION.md` (module flags) | [guide](guides/modules.md) | 4 |
| `mountain-conditions` | content | — | [guide](guides/mountain-conditions.md) | 4 |
| `notification-recipients` | support | `ARCHITECTURE.md` (email / notifications) | [guide](guides/notification-recipients.md) | 4 |
| `notification-rules` | support | `ARCHITECTURE.md` (email / notifications) | [guide](guides/notification-rules.md) | 4 |
| `notifications` | support | email registry, `ARCHITECTURE.md` (email) | [guide](guides/notifications.md) | 4 |
| `page-content` | content | `PUBLIC_PAGE_CONTENT_TOKENS.md` | [guide](guides/page-content.md) | 4 |
| `payments` | finance | `ARCHITECTURE.md` (Stripe), `finance-dashboard/README.md` | [guide](guides/payments.md) | 1 |
| `promo-codes` | bookings | `ARCHITECTURE.md` (promo codes / redemptions) | [guide](guides/promo-codes.md) | 1 |
| `refund-requests` | finance | `CANCELLATIONS.md`, `ARCHITECTURE.md` (refund recovery) | [guide](guides/refund-requests.md) | 2 |
| `reports` | finance | `finance-dashboard/README.md` | [guide](guides/reports.md) | 1 |
| `rooms-beds` | lodge | `CAPACITY_MODEL.md`, `ARCHITECTURE.md` (bed inventory) | [guide](guides/rooms-beds.md) | 3 |
| `roster` | lodge | `ARCHITECTURE.md` (roster/chores) | [guide](guides/roster.md) | 3 |
| `seasons` | bookings | `ARCHITECTURE.md` (seasons / season rates) | [guide](guides/seasons.md) | 1 |
| `security` | support | `SECURITY.md`, `docs/SECURITY.md` | [guide](guides/security.md) | 4 |
| `setup` | support | `CONFIGURATION.md`, `IMPLEMENTATION_GUIDE.md` | [guide](guides/setup.md) | 4 |
| `site-banners` | content | `ARCHITECTURE.md` (SiteBanner) | [guide](guides/site-banners.md) | 4 |
| `site-content` | content | `PUBLIC_PAGE_CONTENT_TOKENS.md` | [guide](guides/site-content.md) | 4 |
| `site-style` | content | — | [guide](guides/site-style.md) | 4 |
| `stuck-states` | support | `ARCHITECTURE.md` (stuck-state dashboard) | [guide](guides/stuck-states.md) | 4 |
| `subscription-lockout` | finance | `ARCHITECTURE.md` (subscription lockout) | [guide](guides/subscription-lockout.md) | 2 |
| `subscriptions` | finance | `ARCHITECTURE.md` (membership subscription billing) | [guide](guides/subscriptions.md) | 2 |
| `waitlist` | bookings | `ARCHITECTURE.md` (waitlist), `E2E_PLAYWRIGHT.md` | [guide](guides/waitlist.md) | 1 |
| `work-parties` | lodge | — | [guide](guides/work-parties.md) | 3 |
| `xero` | finance | `xero/ARCHITECTURE.md`, `XERO_MEMBER_GROUPING_RUNBOOK.md` | [guide](guides/xero.md) | 2 |

## Summary

- **69** admin route areas total.
- **2** areas are already served by a **feature hub** (`display` → lobby-display,
  `lodges` → multi-lodge). #2050 should extend, not duplicate, those hubs.
- **~16** areas have **no reference coverage at all** (`—` above): `appearance`,
  `book`, `booking-messages`, `bookings-setup`, `chores`, `health`,
  `image-manager`, `induction`, `lockers`, `member-fields`,
  `mountain-conditions`, `site-style`, `work-parties`, and the thin
  `*-setup`/config surfaces. These are the highest-value operator-guide targets.
- **Every** area now has a task-focused operator guide (with screenshots). That
  was the #2050 deliverable, and it is complete: every admin row above links a
  guide (no `GAP` remains), batches 1–4 have all shipped, and batch 5's
  member/guest journey guides have shipped under
  [`user-guide/`](user-guide/README.md). This file is now the **maintenance
  checklist** — keep the guides current as areas change (the docs-lockstep rule
  in `AGENTS.md`), and add a row here in the same PR whenever a new admin area
  lands.

### Notes vs the ~20 gaps the initial audit named

The audit's gap list mapped cleanly onto real route dirs with two nuances worth
flagging for #2050 scoping:

- **"school-bookings" is not its own route area.** School group handling is a
  behaviour spread across `bookings`, `booking-requests`, and the
  `school-attendee-confirmations` cron (`ARCHITECTURE.md`), not a
  `/admin/school-bookings` page. Cover it as a cross-cutting topic within the
  bookings-cluster guide rather than expecting a standalone page.
- **"membership-types/setup" is two adjacent routes**, `membership-types` and
  `membership-setup` (plus `member-fields`). Decide in #2050 whether they are
  one guide or three; they share the Membership permission area.
- The audit under-counted: there are **69** areas, not ~20 — the ~20 was the
  "obviously uncovered" subset. This matrix is the exhaustive version.

### Batch 1 route realities (#2050)

Two batch-1 route dirs are pure `redirect()` pages, so they are **folded** into
the [Booking Requests](guides/booking-requests.md) guide rather than given their
own page: `booking-approvals` redirects to `/admin/booking-requests?tab=approvals`
and `booking-change-requests` to `?tab=changes`. Their matrix rows link to that
guide with the redirect noted. `seasons` has **no direct sidebar entry** (ADR-005)
— it is reached from **Fees → Hut Fees** or the lodge hub, and the
[Seasons](guides/seasons.md) guide documents that navigation. `booking-messages`
is edited under the **support** permission area (via Notifications & Email /
Bookings Setup), not bookings, even though it belongs to the bookings cluster.

### Batch 2 route realities (#2050)

Two batch-2 areas are **folded** into a sibling guide rather than given their own
page, matching the batch-1 pattern:

- `fee-configuration` is a pure `redirect()` to `/admin/fees`, so its row links to
  the [Fees](guides/fees.md) guide (redirect noted).
- `membership-cancellation` (singular) is a small **settings** panel (cancellation
  copy + Xero handling) reached from **Notifications & Email**, distinct from the
  `membership-cancellations` (plural) review queue. To avoid a confusing
  near-identical filename, its settings are documented as a section inside the
  [Cancellation Requests](guides/membership-cancellations.md) guide, and its row
  links there.

Several batch-2 areas have **no direct sidebar entry**: `membership-types`,
`member-fields`, and `subscription-lockout` are reached from the **Membership &
Members** hub (`/admin/membership-setup`) and their guides open with the hub nav
path; `lockers` is lodge-scoped (ADR-005), reached from the lodge configuration
hub's **Lockers** card, and its guide correctly opens route-first (the
`seasons.md` precedent — there is no clean `Admin → X` path without first
picking a lodge). Note also that `subscription-lockout`'s page admission is
gated to the **support** area even though its settings span membership/finance/
bookings — the guide documents this. `fees` sits under both **bookings** and **finance**: its admission is OR
(bookings *or* finance view), and it self-gates editing per section (hut fees need
bookings edit; joining/annual/family fees need finance edit). The `subscription-lockout`
page's own route is **support**, but it embeds membership, finance, and (read-only)
bookings settings — the Batch column tracks the finance grouping used for #2050
delivery.

### Batch 3 route realities (#2050)

Batch 3 (lodge operations) mixes direct sidebar pages, lodge-scoped hub-card
pages, and a feature-gated display cluster; the guides document the reality:

- **The Lodge Operations sidebar section owns six pages** with direct sidebar
  entries, so their guides open with the canonical line: `hut-leaders`, `roster`,
  `lodge` (**Lodge Kiosk**), `work-parties`, `lodge-instructions`, and
  `maintenance-reports` (**Lodge Maintenance**) (**Admin → Lodge Operations →
  …**). The Lobby Display hub also lives in this section but opens its own cluster.
- **`chores` has no sidebar entry, and opens route-first** (the
  `lockers`/`seasons`/`rooms-beds` lodge-scoped precedent). It is lodge-scoped
  (ADR-005) with no clean `Admin → X` click path — there is no direct sidebar
  entry — so its guide leads with `/admin/chores` and then gives the lodge
  configuration hub's **Chores** card as the way in (`Admin → Setup &
  Configuration → Lodges → a lodge → Chores`).
- **`rooms-beds` opens route-first** (the `lockers`/`seasons` lodge-scoped
  precedent): it is reached from the lodge hub's **Rooms & Beds** card and from
  **Bookings Setup**. Note the permission split — the page sits in the **Lodge**
  nav area, but its data flows through the bed-allocation APIs, which enforce the
  **bookings** area, so editing rooms/beds needs **bookings edit** (a `#1548`
  precedent the guide calls out), not lodge edit.
- **`lodges` gets its own operator guide *and* keeps the multi-lodge feature
  hub.** The guide covers the properties list, identity fields, deactivation
  pre-flight, and the per-lodge configuration hub; it extends, not duplicates, the
  [multi-lodge hub](multi-lodge/README.md).
- **Module gating on the capture stack.** `chores`/`roster` (`chores`), the lodge
  kiosk (`kiosk`), and `rooms-beds` (`bedAllocation`) default **off** in the
  schema but are turned **on** by the E2E prepare step
  (`e2e/setup/enable-e2e-modules.ts`), so they capture on the seeded stack;
  `work-parties` (`workParties`) and `hut-leaders` (`hutLeaders`) default **on**.
- **The lobby display guide is epic-sequenced into batch 3** (its matrix row
  stays under batch 4 by permission grouping). The `lobbyDisplay` module is **off
  by default**, so `/admin/display` 404s in the seed; the capture stack had the
  module **enabled** to shoot the hub plus **Devices**, **Layouts**,
  **Templates**, **Reference**, and the template **preview**. On current `main`
  the hub is a **five-card** hub — Devices, **Visual builder** (#2048),
  Layouts (Advanced), Templates, Reference — and the guide documents the Visual
  builder card at hub level (the no-HTML authoring path most operators should
  use), deferring the full builder walk-through to the `lobby-display/` feature
  hub rather than duplicating it. Because the committed `admin-display` capture
  predates the builder card (and `admin-display-templates` predates the #2047
  pack, the #2247 **Restore built-in boards** control beside *New template*, and
  the #2247 hub-card definitions of Layout/Template/board), both need re-capture
  at batch-3 finalisation once the stack is rebuilt from a `main` carrying
  #2047 + #2247 + #2248 (see the harness comment).
- **Display template pack correction (#2047).** At capture time the stack's
  template gallery showed the original three built-ins (**Everyday board**,
  **Whole lodge**, **Singles house**); the #2047 pack (**Room by room**, **Nights
  ahead**, **Lodge operations**, **Welcome kiosk**) was not yet seeded on it. The
  display guide therefore describes the gallery **mechanic** and defers the full
  built-in catalogue to the [lobby-display feature hub](lobby-display/README.md),
  so it stays correct once the pack's templates are re-seeded and the
  `admin-display-templates` capture is refreshed.

### Batch 4 route realities (#2050)

Batch 4 (comms, content & support platform) has several hub-and-spoke and
feature-gated surfaces; the guides document the reality:

- **Two content/comms hubs own most of the spoke pages.** The
  [Site Appearance & Content](guides/appearance.md) hub (`/admin/appearance`) and
  the [Notifications & Email](guides/notifications.md) hub (`/admin/notifications`)
  are the only two with a direct sidebar entry. Their spoke pages have **no
  sidebar entry** and are reached from a hub card, so those guides open
  **hub-path-first** — the canonical convention: the full click path through the
  hub (`Admin → Setup & Configuration → Site Appearance & Content → …` /
  `Admin → Setup & Configuration → Notifications & Email → …`): `site-style`,
  `site-content`, `page-content`,
  `site-banners`, `mountain-conditions`, `image-manager` (content hub) and
  `notification-rules`, `notification-recipients`, `email-messages`
  (notifications hub). The notifications hub also cards to `booking-messages`
  (batch 1) and `membership-cancellation` (batch 2), which keep their own guides.
- **`appearance/identity` is folded** into the [appearance](guides/appearance.md)
  guide (the Club Identity sub-page) rather than given its own row — the matrix
  row notes it.
- **`integrations` is feature-gated and prose-only.** It is gated by the
  `xeroIntegration` module (`src/config/feature-routes.ts`), which the demo seed
  leaves **off** (schema default), so the route 404s and the harness captures no
  screenshot — the [Integrations](guides/integrations.md) guide describes it in
  prose, matching the batch-2 Xero pattern. The page is now a thin hub with a
  single **Xero Setup** card.
- **`communications` and `mountain-conditions` are gated but ON by default.**
  Their modules (`communications`, `skifieldConditions`) default **on** in the
  seed, so both render and are captured. `communications` lives in the **Members**
  sidebar section (permission area `membership`), not support.
- **`display` stays a feature hub.** The lobby TV display module (`lobbyDisplay`)
  is **off** by default, so `/admin/display` 404s in the seed; rather than a new
  guide it keeps its existing [feature hub](lobby-display/README.md) and
  [operating runbook](lobby-display/operating.md), linked from the operators hub.
- **`dashboard` and `setup` reuse existing screenshots.** Their captures
  (`admin-dashboard.png`, `admin-setup.png`) were added by the #2049 harness
  foundation, so batch 4 references them without re-capturing.
- **`access-roles` and `config-transfer` are Full-Admin-only** sidebar entries;
  their guides say so.

### Batch 5 route realities (#2050)

Batch 5 (member-facing journeys) is the public/member surface, so it has **no
`/admin/*` rows** in the matrix above and is not tracked per-row here. It ships
as the [Member & Guest Guide](user-guide/README.md) under `docs/user-guide/`
(audience **Member/Guest**, not Operator), scoped from
[`UX_FLOW_MAP.md`](UX_FLOW_MAP.md) and the public route tree. Route realities the
guides document:

- **Two guest paths need no login, and whether either is advertised is the
  club's choice.** The sign-in page (`/login`) links to *Request a school group
  booking* (`/school-bookings`). Both that page and the general guest quote flow
  (`/booking-requests`, `/booking-requests/respond/[token]`) are editable CMS
  pages that ship **unlisted by default** (#2421, #2818): each seeds an empty
  menu title, which keeps it out of the site menu *and* out of search engines —
  one field drives both, so the two can never disagree. `robots.txt` deliberately
  does not disallow either path, so a crawler fetches the page and sees the
  `noindex` rather than merely listing the bare URL. On that default the club
  shares the direct URL only with guests it has agreed to host — an admin copies
  it from the **Public Requests** tab of `/admin/booking-requests` — and the only
  other path in is the rebook button on a tokenised `/pay/[token]` link the club
  itself emailed a past requester. A club that wants the form advertised gives
  the page a menu title under **Site Appearance & Content → Page Content**, and
  it joins the navigation and becomes indexable together.
  The
  [Booking a stay](user-guide/booking-a-stay.md) guide covers both as the guest
  journey, and says plainly that whether a non-member can stay is the club's own
  policy; operators handle them via
  [Booking Requests](guides/booking-requests.md).
- **The booking wizard is a client-side flow.** `/book` renders four steps
  (Select Dates → Add Guests → Review & Confirm → Pay); only the landing (Select
  Dates) is a capturable URL, so the guests/review/pay steps are documented in
  prose per the STYLE_GUIDE screenshot-density rule.
- **Alternative sign-in methods are module-gated.** *Email me a sign-in link*
  (`/login/magic`) and *Continue with Google* appear on `/login` only when the
  club enables those modules and (for Google) configures OAuth; the demo seed
  leaves them off, so the login capture shows password sign-in only and the
  [account guide](user-guide/your-account.md) describes them in prose.
- **Member captures use a member persona.** The member-authenticated pages
  (`/dashboard`, `/profile`, `/bookings`, `/book`) are captured as the seeded
  complete-profile member (WAITLISTER / Wanda) via a `persona: "member"` context
  added to the shared harness; public pages (`/login`, `/join/apply`) capture
  without auth. Member-surface images live under `docs/images/public/` with a
  `member-` prefix, alongside the anonymous `public-` shots.

## Delivery batches (#2050)

The operator-guide programme ships in **five batches**. Every admin row above
carries its batch number in the **Batch** column, so an orchestrator can derive
a batch's worklist directly from this file (filter the table by batch). Batches
1–4 are admin areas; batch 5 is the member-facing/public surface, which has no
`/admin/*` rows and is scoped separately below.

| Batch | Theme | Scope | Admin areas |
| --- | --- | --- | --- |
| **1** | Bookings & capacity | The booking lifecycle, capacity/beds, seasons, promos, and booking money (payments, booking reports). | 15 |
| **2** | Membership & applications | Members, applications, family/committee, membership lifecycle & cancellations, and membership billing (fees, subscriptions, refunds, Xero, internet banking). | 20 |
| **3** | Lodge operations | Physical-lodge day-to-day: rooms/beds inventory, chores, roster, work parties, hut leaders, lodge kiosk/instructions, and multi-lodge management. | 8 |
| **4** | Comms & content | Outbound comms (email/notifications), public content & appearance, and the platform/support admin surfaces (access roles, audit, security, health, modules, integrations, backups, setup, config-transfer, dashboard). | 27 |
| **5** | Member-facing journeys | The public and member-facing routes (`/`, booking flow, member dashboard, applications, self-service) — **not** admin areas, so not enumerated in the matrix above. Scoped from `UX_FLOW_MAP.md` and the public route tree. **Shipped** as the [Member & Guest Guide](user-guide/README.md). | — |

To pull one batch's admin worklist, take every row whose **Batch** equals that
number. Batch sizes: **1 → 15**, **2 → 20**, **3 → 8**, **4 → 26** (total 69).
Where a permission area does not map 1:1 to a batch (finance splits between batch
1 booking-money and batch 2 membership-billing; support/content platform surfaces
sit in batch 4), the Batch column is authoritative — read it, don't re-derive
from the permission area.
