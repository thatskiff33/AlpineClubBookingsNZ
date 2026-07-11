# Changelog

All notable public reference-release changes should be recorded here.

## Unreleased

- **Shared `Alert` status-banner primitive (#1802, epic #1800 phase 1).** A new
  `src/components/ui/alert.tsx` renders persistent inline status banners with an
  `info | success | warning | error` variant — each pairing a lucide icon with
  text (colour is never the sole signal) and reading only from the semantic
  status tokens (`--success`/`--warning`/`--destructive` plus a new calm
  slate-blue `--info` trio added to `globals.css` for light and dark). The
  ad-hoc coloured `<div>` banners on the login form, the booking wizard, and the
  admin members and payments pages now use it. Presentation-only for product
  behaviour: no message, conditional, focus/scroll, or money/capacity/lifecycle/
  auth/schema/provider behaviour changed — the admin members error banner keeps
  its ref, `role="alert"`, `scroll-mt-20`, and programmatic focus/scroll-into-view.
  The one assistive-technology-visible change is additive: banners that
  previously carried no ARIA role now announce through the variant's live-region
  role (warning/error assertive, info/success polite), so screen-reader users
  hear errors that were previously silent — an a11y improvement, and a caller can
  pass an explicit `role` to override it. Establishes the "inline `Alert` for
  persistent state, `sonner` toast for transient" convention for the rest of
  the epic.

- **Admin email-notify choice extended across the remaining admin-initiated
  member emails (#1780 / #1769b, completing the sweep).** The canonical
  `notifyMember` two-button pattern (#1705/#1769a) now covers: membership
  application approve/reject (#1786), membership cancellation review
  approve/reject (#1787), member archive review + account-deletion reject
  (#1788), family-group child-request & group-create approve/reject (#1789),
  booking review (minors) approve/reject (#1790), public booking-request
  decline (#1791), and refund-appeal approve/reject (#1792). Each admin decision
  now asks, per action, whether the affected member/applicant/requester receives
  the standard outcome email — default is to notify; "without emailing" skips
  the send and records `notifyMember: false` in the audit metadata, recorded
  only on paths that would truly have emailed (honesty rule). Token-bearing and
  pipeline-critical sends keep always-send: membership-application induction
  sign-off requests, the family group-create partner invite, booking-request
  approve/quote links, and the account-deletion approval receipt. Member
  self-service flows and admin-facing alerts are untouched. No money, booking
  capacity, or provider (Stripe/Xero) behaviour changes.

- **Manual-board `MINOR_ADULT_MIX` warning-only behaviour documented as
  intended.** The deferred owner decision from #1768/PR #1775 is closed:
  automated placement paths enforce the cross-booking minor/adult invariant
  hard, while the manual allocation board deliberately stays warn-not-block as
  an admin-judgment escape hatch. `docs/DOMAIN_INVARIANTS.md` and
  `docs/STATE_MACHINES.md` now record this as the intended function
  (docs-only; no behaviour change).

- **Admin can choose whether to email members on force-confirm,
  confirm-pending-guests, and admin guest-add (#1769b).** Part of #1780 /
  #1769b, extending the #1705 cancel notify pattern to three more admin
  booking actions. The waitlist "Force Confirm" and the "Confirm pending guests
  now" tool now ask, per action, whether the member receives the standard
  booking-confirmation email — a two-button dialog ("Confirm and email member"
  vs "Confirm without emailing") shown only when an email would actually be
  sent (a force-confirm that lands PAID, i.e. a $0 stay with review resolved;
  and the confirm-pending zero-amount or charged-card outcomes). The
  admin-actor guest-add route (`POST /api/bookings/[id]/guests`) honours the
  same `notifyMember` flag at the route level (no admin UI caller). The default
  is to notify; "without emailing" skips the email and records
  `notifyMember: false` in the audit metadata (recorded only on the outcomes
  that truly send, per the honesty rule). A non-admin caller carrying the flag
  on the guest-add route is refused with a 403, so a member can never suppress
  their own booking email; member self-service behaviour is otherwise
  unchanged. Booking capacity, charges, and settlement are identical either
  way — only the member email differs.

- **Admin can choose whether to email guests when sending the chore roster
  (#1785, part of the #1769b sweep).** The "Email Roster to Guests" action on
  `/admin/roster` now asks, per send, whether to email — a two-button dialog
  ("Email guests the roster" vs "Don’t email — keep existing links"), reusing
  the retroactive-create / cancel / partner-link notify pattern
  (#1695/#1705/#1769a). The default is to notify: every affected guest is
  emailed a fresh 48-hour chore link, reissuing tokens exactly as before.
  Suppressing skips the whole send **and** leaves existing guest chore
  tokens/links intact — no token deletion, no new tokens, no email — so
  previously-emailed links keep working; the suppression is recorded in the
  audit log as `notifyMember: false` (`ADMIN_CHORE_ROSTER_EMAIL_SUPPRESSED`).
  The per-member `choreRoster` opt-out still applies on top of the notify path.

- **Email message registry completeness pass (#1780 docs child).**
  `docs/EMAIL_MESSAGE_REGISTRY.md` now documents the 12 live templates it was
  missing: `two-factor-code`, `booking-review-approved` /
  `booking-review-rejected`, `induction-sign-off-request`,
  `school-attendee-confirmation`, `admin-school-manual-invoice`, and the six
  group-booking settlement/join messages (`group-booking-join-verification`,
  `group-settlement-receipt`, `group-join-settled`,
  `group-settlement-expired`, `group-join-released`, `group-join-cancelled`).
  These senders are hardcoded (no admin-editable template), so they live in a
  new "Hardcoded Messages" section outside the `###` sections that the
  registry contract test keeps in sync with `EMAIL_TEMPLATE_DEFINITIONS`.
  Docs-only; no behaviour change.

- **A deliberately over-capacity booking is no longer destroyed when payment
  lands (#1771).** Every admin over-capacity admission — on-behalf create
  (#1668/#1695/#1767), date/batch modification (#1668), waitlist force-confirm,
  confirm-pending-guests overbook (#1366), and admin capacity-hold (#1764) —
  now persists the decision on the booking (`capacityOverriddenAt` +
  `capacityOverriddenByMemberId`). Every payment-time / settlement capacity
  re-check (`markBookingPaymentSucceeded`, payment links, the non-member-hold
  cron, saved-card charge, switch-to-Internet-Banking, the Internet Banking
  invoice-paid reconcile, and group settlement) now honours that marker and
  settles the booking to its correct terminal state instead of
  cancelling+refunding, 409ing, or bumping it. This retires the #1767 v1
  carve-out that hard-blocked a non-member hold-eligible (PENDING) on-behalf
  overbook — the hold cron now confirms rather than bumps it. Members can never
  overbook; the marker only ever appears behind an explicit, audited admin act.

- **Admin can choose whether to email members when assigning or removing a
  partner link (#1769a).** The Partner card on `/admin/members/[id]` now asks,
  per action, whether the members receive the standard partner-relationship
  email — a two-button dialog ("Assign/Remove and email members" vs "…without
  emailing"), reusing the retroactive-create / cancel notify pattern
  (#1695/#1705). The default is to notify; suppressing is recorded in the audit
  log as `notifyMember: false`. The dialog appears only when an email would
  otherwise be sent: assign always, remove only for a CONFIRMED link — removing
  a still-pending link emails no one, so it removes directly and records no
  notify field. Member-facing partner flows (request/confirm/dissolve/invite
  claim, and the family one-step declare) keep their existing always-notify
  behaviour; the broader admin-email sweep is tracked separately as #1769b.

- **Admin book-on-behalf can overbook with an explicit confirmation (#1767).**
  A forward-dated on-behalf create that exceeds lodge capacity now follows the
  same warn-and-confirm contract as retroactive creates and admin date edits
  (#1668/#1695): full days stay selectable on the admin calendar, the guest
  step warns, and submitting prompts "Confirm over-capacity and create"
  (audited as `capacityOverridden`). An on-behalf create that opted into the
  waitlist fallback still waitlists instead of prompting. (#1771 persists and
  honours the override, so a priced overridden booking is no longer cancelled
  when payment lands over capacity, and the former non-member hold-eligible
  (PENDING) carve-out is retired.) The admin guest caps now follow the selected
  lodge's resolved capacity, and over-capacity parties cannot be saved as
  drafts. Member self-books are unchanged — members can never overbook.

- **Auto bed allocation no longer strands large groups (#1768).** The split
  fallback used to cap rooms-with-minors at the booking's adult count — a
  school group with two teachers filled exactly two rooms and reported the
  remaining students `NO_BED_AVAILABLE` with rooms empty. Minors now overflow
  into rooms of their own once the booking has an adult on-site that night
  (the Phase-0 night-level rule is unchanged), SCHOOL-request bookings room
  their teachers together and students separately, and a new hard invariant
  is enforced on every placement path in both directions: a room-night
  holding one booking's minors never also holds another booking's adult —
  displacement evicts a conflicting provisional booking whole or backs off,
  relocation falls back to unallocating rather than moving anyone beside a
  stranger, and persisted violations surface as a `MINOR_ADULT_MIX` board
  warning.

- **Admins can add a confirmed partner to a full lodge (#1746, completing the
  double-bed epic #1741).** The admin edit-booking panel now offers the
  confirmed partners of a booking's member guests as "partner (shares a
  double bed)" quick-adds; the added partner is admitted through the reserved
  partner-shared slots (#1745) even when the lodge is full by beds — bounded
  per night by the double count — and is then placed as the double's second
  occupant on the allocation board as before. Admin-only end to end: the
  `partnerSharedGuests` flags are rejected for non-admin callers at both the
  modify routes and the service, the public wizard is unchanged, and a
  rejected admission shows the capacity check's reason rather than the
  over-capacity overbook confirm.

- **Lodge capacity gains reserved partner-shared headroom (#1745, part of the
  double-bed epic #1741).** Each active shareable `DOUBLE` bed now contributes
  one admission slot **above** the base lodge capacity — reserved for a guest
  whose CONFIRMED partner (#1742/#1744) holds an ordinary place on the same
  nights, bounded by the double count per night, and never past an explicit
  per-lodge capacity (a fire/licence people-ceiling zeroes the headroom, so a
  capped lodge is unaffected). Public and member booking paths are untouched:
  the base figure they read is unchanged, and only the admin-initiated
  partner-shared admission check (`checkCapacityForPartnerSharedAdmission`;
  initiation surface lands with #1746) can use the extra slots. The admin
  lodge Capacity card breaks the figure out ("10 beds + up to 1 partner
  spot") rather than showing a combined number.

- Added the declared **Partner/Husband/Wife relationship** (#1742, part of the
  double-bed shared-occupancy epic #1741): a symmetric, consent-based
  `MemberPartnerLink` between two adult members with a request→confirm flow
  mirroring family invitations. Members declare a partner from the profile
  Partner card (the partner confirms or declines from their own profile); a
  family-group admin can declare a no-login adult member of their group in one
  step; admins can assign or remove a partnership directly from the member
  detail page (recorded as admin-assigned); and the family create-group form
  can mark the named partner so an unregistered partner's invite token (#1682)
  forms the link when claimed — the claim page discloses the partnership
  before the invitee accepts. Invariants: at most one confirmed partner per
  member (advisory-locked, with DB partial-unique backstops), adults only, no
  self-partnering; removed/declined links are hard-deleted with full audit
  history, and the affected partner is emailed on removal. New emails:
  `partner-link-request`, `partner-link-confirmed`, `partner-link-removed`.
  Expand-only migration (`MemberPartnerLink` table +
  `PartnerInviteToken.createPartnerLink`). This link is the eligibility signal
  the bed-share children consume: double-bed placement eligibility (#1744)
  and the partner-shared capacity headroom (#1745) both read it via
  `mayShareDoubleBed`. A by-email partner request always answers with the generic
  "If they're eligible, we've sent them a partner request." so a member cannot
  probe whether someone already has a confirmed partner (D9 owner decision);
  and the inviter of an unregistered declared partner can cancel their own
  outstanding invitation from the profile Partner card before it is claimed
  (#1754).

- **Behaviour change — lodge capacity now honours a max-sleeping-capacity
  ceiling (#1653).** A per-lodge `LodgeSettings.capacity` value now caps the bed
  count when Bed Allocation is on: effective capacity is the lower of the
  installed active beds and the capacity, so a lodge may have more beds than it
  is allowed to sleep. Previously the capacity was *ignored* whenever beds were
  configured. **Operator action:** if a lodge has both configured beds **and** a
  capacity set *below* its bed count, its bookable capacity will drop to that
  value on upgrade. Run the read-only detection query in
  `docs/CAPACITY_MODEL.md` to list any affected lodge and confirm the cap is
  intended before deploying. No schema migration; code-only. See
  `docs/CAPACITY_MODEL.md` for the full resolution table.
- Promoted the two-lodge `E2E multi-lodge` CI job from advisory to a blocking
  required status check (#1655; launched advisory in #1623 for #1568, its one
  observed flake class root-caused and fixed test-side in #1650). Cross-lodge
  E2E regressions now block merges the same way the single-lodge Playwright
  suite does. CI-only; no application behaviour change.
- Added **Configuration Export & Import** (config transfer): a full-admin tool
  (Admin → Setup & Configuration → Export & Import) to export a club's
  configuration, site content, and lodge setup as a portable, database-id-free
  `.zip` bundle and import it into another (or the same) instance through a
  mandatory dry-run → confirm flow. Import is upsert-only (never deletes), takes
  a `pg_dump` backup before applying, runs under a single-flight advisory lock,
  and is audited. Categories: site content (pages/site-content/theme, with
  embedded-image bundling + reference remap), club settings singletons, lodge
  configuration (each lodge a self-contained `lodge-config/lodges/<slug>/`
  folder — `lodge.json` + rooms/beds/seasons/rates/instructions/chore-template
  CSVs, lodge implied by folder), committee **role definitions** (the legacy
  standalone member directory and member-linked assignments are excluded),
  induction checklist templates, and Xero account/item-code mappings (source
  org id in a sealed `xero-config/source.json`). Bundles are hand-editable:
  manifest checksums/row counts are advisory (mismatches warn in the dry-run,
  never block; import is files-first), with a "reseal" action to regenerate the
  manifest; only structural/safety problems are hard-refused (resource caps are
  enforced before inflation). Import has a per-run **write mode** (default
  **merge**): merge writes only fields that carry a value in the bundle
  (blank/omitted fields keep the record's existing value, so a partial or
  skeleton bundle patches rather than wipes); overwrite makes the bundle fully
  define each record (blanks clear). The **dry-run is mode-aware** and
  **strictly validates every row** — malformed dates/enums/money are errors
  (named by file, row, and field) that block apply until the bundle is fixed.
  The dry-run also offers a **match picker** for renamed seasons, chore
  templates, and induction templates, **per-category selection at import**, and
  prominently names any lodge whose door code would change. The plan
  fingerprint binds the bundle bytes, mode, selection, and resolutions, and is
  re-verified inside the apply transaction under the advisory lock — what was
  previewed is exactly what is applied. Success AND refused applies are
  audited (with bundle sha256, a bounded per-item diff, and the lodges whose
  door codes were actually written). Lodge folders carry the `isDefault`
  default-lodge marker (adopted from fork #15), applied via a safe
  clear-then-set. Never carries secrets, members, transactional data, or (by
  default) door codes. Not a
  database backup; the `pg_dump` subsystem remains the disaster-recovery tool.
  No schema migration. See `docs/config-transfer/`.

## 0.10.1 - 2026-07-07

- Release classification: patch public reference release. Four
  payment/booking-recovery hardening changes and one operator cleanup script on
  top of `0.10.0`; no database migrations, no schema changes, no new features,
  and no behaviour changes outside the raced/edge shapes described below. Safe
  to deploy tag-to-tag from `v0.10.0` with the standard backup-first procedure
  (`docs/UPGRADING.md`).
- Guarded the booking-request quote re-send status flip against a concurrent
  decline: the flip to `QUOTE_SENT` is now a claim-first, status-guarded update
  placed first in the existing transaction, so a re-send racing a decline can
  no longer resurrect a `DECLINED`/`CANCELLED` request or send its quote
  email — the losing re-send rolls back with a 409 (#1504).
- Converged the refund-request and booking-modification recovery replays with
  their inline Stripe refund bodies via shared per-path body builders. The
  replays previously sent a different `reason` under the same idempotency key,
  so Stripe rejected the replay with `idempotency_error` and the recovery
  retried to exhaustion instead of converging (safe-failing — never a double
  refund); replays now send byte-identical bodies and converge (#1507).
- Froze the refund-appeal Stripe allocation plan: the approve route computes
  the per-transaction refund allocation once, uses it for the inline refund,
  and on inline failure persists those same slices to the recovery operation,
  so the replay re-requests exactly the original slices under the original
  idempotency keys. This supersedes the previous completed-refund remainder
  heuristic and closes the last refund-recovery path that re-derived its
  allocation at replay time. In the exotic mixed Stripe + Internet-Banking
  appeal shape, the route now refunds the plannable Stripe portion inline and
  logs any shortfall instead of pushing the mismatch into recovery — net
  Stripe money is unchanged and the Internet-Banking portion still settles via
  credit note (#1510).
- Capped the never-settled Internet-Banking credit mint per invoice in
  aggregate: multiple never-settled IB payments matched to a single invoice can
  no longer collectively mint account credit above that invoice's cash. The
  previous clamp was per-payment; no current app flow produces the aggregate
  shape, so real-flow mint amounts are unchanged (#1505).
- Added `npm run payments:backfill-cancel-flattened`, a one-off, idempotent,
  dry-run-by-default operator script that restores the stored `Payment.status`
  on rows the pre-#1489 cancel defect flattened to `FAILED` on cancelled
  bookings (the read path already synthesizes the correct captured status from
  the intact ledger/mirror). It makes no Xero and no Stripe calls and is
  documented in `docs/MAINTENANCE.md` (#1506).
- Migration/deployment notes: **this release contains no database migrations**
  and requires no post-upgrade actions; `docs/BLUE_GREEN_MIGRATION_SAFETY.tsv`
  gains no rows and either app color can serve throughout the deploy. Optional
  cleanup: forks that ever ran a pre-`v0.10.0` (pre-#1489) build can restore
  cancel-flattened stored payment statuses with the #1506 backfill above —
  dry-run first, per `docs/MAINTENANCE.md`.

## 0.10.0 - 2026-07-07

- Release classification: minor public reference release. The change set since
  `0.9.0` is a large quality-and-hardening wave layered on top of new public
  booking, membership, and finance capabilities, followed by a remediation wave
  (epic #1348) that closed the post-wave audit findings and a live-feedback
  admin-UX wave (epic #1438), all preserving the existing public deployment
  shape. Highlights below; individual behavior changes are called out inline.
  Forks upgrading from `0.9.0` must read `docs/UPGRADING.md` and the
  Migration/deployment notes at the end of this section before deploying: this
  release includes two destructive/behaviour migrations (module defaults switch
  off, in-flight induction results cleared) and other hot-table migrations.
- Ran a best-in-class quality wave (epic #1125): dead-code sweeps and a bundle
  audit, large file splits for the booking wizard, booking create/modify,
  member detail, and email modules, native UI primitives (confirm/prompt
  dialogs, loading skeletons) replacing browser `alert`/`confirm`, an
  observability and cron-health parity pass, database query-performance work, a
  consolidated settlement-math path, a Xero architecture review, and an
  access-role/authorization matrix cleanup. New automated test layers landed as
  part of the wave: a Playwright end-to-end foundation with Critical/High test
  matrix coverage, an authorization-matrix route test, property-based tests for
  pricing/settlement invariants, and a typecheck gate that now also covers test
  files. Notable decision: colour contrast on the configurable site-style
  palette is now enforced (blocking, server-side, for both hex and `oklch`)
  rather than left advisory.
- Added a public booking quote system with a member-facing quote workflow,
  quote TTL and reminder emails, quote/booking reprice paths, night-price
  locking, and waitlist-offer repricing.
- Hardened payment, refund, and settlement recovery: refund recovery
  allocation, refund revert recovery, credit-note delta handling, refund prefix
  reuse, a settlement reaper for stale intents with reaped-children expiry,
  durable payment-intent retry, group-settlement superseded/stale-total fixes,
  and queuing the Xero invoice after card payment.
- Expanded membership and family lifecycle: seasonal membership types with a
  membership-type editor, enforcement, and name guards; a member removal
  lifecycle with collection handling; committee assignments with contact
  privacy and committee email; member-import identity contract, address UX, and
  audit rollback; school attendee confirmation with resendable links and
  non-member school role types; hut-leader eligibility and look-ahead; and an
  induction redesign.
- Added two-factor authentication (TOTP) with server-side verification, and
  hardened security boundaries: webhook hardening, a privileged-email gate,
  shared and degraded-mode rate limiting, token URL-scheme tightening, a backup
  fire-drill, and a migration audit.
- Reworked public site and content management: a structured public-content
  editor with a publish/hide toggle, CMS policy pages, site banners and footer
  content, an FAQ accordion, help screens, public safety-UX parity, an
  address-autocomplete module, and analytics-consent handling.
- Improved admin and member UX: an admin dashboard and sidebar refresh, booking
  filters, a bed-allocation board, member-night conflict surfacing, minors-only
  booking review, approval person-night handling, loading skeletons, and
  clearer feedback conventions.
- Deepened accessibility: a staging accessibility pass with axe findings fixes,
  booking-calendar keyboard/screen-reader labelling, and a booking-wizard and
  admin-members deep pass that also enforces the site-style colour contrast
  described above (epic #1125).
- Extended Xero and finance surfaces: a Xero architecture review, granular Xero
  report scopes, a finance report account-mappings UI, finance surfacing, and
  unpaid-invoice reduction.
- Refreshed dependencies with minor/patch updates and dependency triage.
- Added editable admin access roles. The six seeded bundles (Read-only Admin,
  Booking Officer, Membership Officer, Content Manager, Finance Viewer,
  Treasurer) are now database-backed definitions that a Full Admin can rename,
  re-permission, or delete at `/admin/access-roles`, and brand-new custom
  roles can be created with their own per-area permission matrix. Full Admin,
  Lodge, User, and Organisation remain protected system roles. Custom roles
  fall under the existing Full-Admin separation-of-duties gate, definition
  deletion is blocked while members hold the role, and all definition changes
  write critical-severity audit entries.
- Behavior change: finance-portal access now derives from the merged finance
  area level of the admin permission matrix instead of the two finance enum
  roles. Full Admin is now a finance manager in `/finance`; Read-only Admin,
  Booking Officer, and Membership Officer (finance view in their seeded
  matrices) can open the finance portal read-only and see the Finance nav
  link; Finance Viewer additionally gains read-only access to the finance
  admin area pages (for example `/admin/payments`).
- Renamed the `ADMIN_BOOKINGS` access-role display label from "Booking
  Office" to "Booking Officer" (display copy only; the stored enum value is
  unchanged).
- Ran a second hardening wave (epic #1204) that closed out every wave-1
  residual surfaced by the quality-epic audits. Grouped highlights below.
- Money and booking correctness: made booking cancellation single-flight
  (#1160) and booking-request quote acceptance idempotent so a retry or timeout
  can no longer double-book, double-charge, or double-invoice (#1232); extended
  the person-night conflict guard to the date-change flow
  (#1157) and to booking-request approval, quote-hold, and school-request
  approval (#1158), and froze the advisory-lock-before-guard ordering for every
  member-linked guest-night writer by test (#1159); fixed Xero invoice-line
  rounding drift (#1163); hardened group settlement/cancel and the cancellation
  tier boundary (#1165, #1166); added a defensive promo-cap allocation assertion
  (#1206); added layered money-path idempotency defenses — atomic
  credit-allocation repair under the booking advisory lock and a
  supplementary-invoice idempotency-key guard, with the Xero outbox dedup kept
  status-based by design (#1234); made group-cancel refunds resumable via
  a persisted refund plan and reaper (#1236); and de-duplicated stale
  payment-recovery alerts with a claim-first cooldown (#1211). Behavior/policy
  change: credit-paid bookings now follow the same cancellation-penalty tiers as
  card-paid bookings (#1164); the cancellation help text and email copy shipped
  with it and the committee was flagged for a heads-up.
- Xero and books integrity: a second refund on a payment now always receives a
  refund credit note, with a health check (#1162); the late inbound
  capacity-fail credit note is now enqueued inside the reconcile transaction so a
  crash can no longer leave a local credit with no Xero mirror (#1233); the
  reconciliation report surfaces failing inbound events (#1196); the money-path
  invariant audit was
  extended to the previously-unaudited surfaces (#1205); and the Xero subsystem
  was split into cohesive modules behaviour-identically (#1208).
- Platform, security, and hygiene: next-auth dependency hygiene (dropped a dead
  adapter and narrowed an override) (#1182); fixed the React Compiler lint
  findings (#1175); cut the admin client zod bundle (#1197); root-caused and
  fixed the login-page hydration double-render behind the flaky 2FA E2E spec
  (#1207); added a scoped `pino → Sentry` bridge for the cron and webhook
  loggers (#1214); made the Stripe payment E2E robust to Stripe's inline-vs-
  redirect confirmation path (#1220); and stopped raw Stripe initialization
  errors (which could carry partial key material) from reaching members on the
  pay step — generic copy is shown and the detail goes only to scrubbed Sentry
  telemetry (#1223).
- Maintainability: extracted the `/book` wizard state machine into a hook
  (#1209); split the admin-alerts email module (#1210); made admin bookings sort
  by lifecycle status (#1215); and triaged the 197 used-only-by-tests exports,
  annotating each as an intentional test seam (#1216).
- Accessibility, UX, and copy: exempted the single-action nomination
  confirmation flow from the mandatory profile-completion gate (#1221); fixed
  the duplicated "Postal Postal Code" address labels and aligned them to
  "Postcode" (#1222); added the remaining page `h1`s and fixed the website-footer
  heading order, then verified the booking-wizard and admin-members keyboard
  accessibility live (#1242, #1295); and noted on the site-style setup screen
  that the public site — including the membership application form — stays hidden
  until saved (#1245); and aligned transactional email theming with the
  configured site theme (#1186). Config: a one-time idempotent data migration
  bumps any
  persisted site-style theme still on the old sub-AA default gold `#7a8f6a` to
  the AA-compliant `#8fa87c` so those installs can save again (#1244).
- Verification and docs: refreshed `DOMAIN_INVARIANTS.md` and
  `SECURITY-ATTACK-SURFACE.md` to the true wave-2 end state and re-ran the
  concurrency audit (#1212, #1159).
- Recorded as deliberately-unchanged, owner-ratified wave-1 trade-offs
  (decision-menu rows D1, D2, D3, D5, D8, D9b): the CSP `style-src
  'unsafe-inline'` and broad `img-src https:` breadth; `getClientIp` trusting
  `x-real-ip` under the "Caddy always fronts" deployment invariant; deferring a
  finer split of `booking-modify-plan.ts` until after #1159; and holding the
  Node 26 LTS + `@types/node` 26 upgrade for its own maintenance window (#1176).
- Completed the configurable site-style dark-mode contrast work started in the
  quality wave: fixed colored-opacity tokens that failed contrast in dark mode
  (#1307) and the `red-500` dark-mode contrast on destructive controls (#1310).
- Behaviour change — Booking Officer and on-behalf booking authorization scope:
  the member-detail admin route and booking-detail viewer now gate on
  area-level admin access (`hasAdminAreaAccess`/`canViewAsAdmin`) instead of
  Full-Admin-only, so Booking Officers regain the booking views their seeded
  matrix grants (#1325, #1343); admin and member payment controls were separated
  on the booking-detail surface (#1326); the member booking and quote APIs were
  widened so `bookings:edit` holders can create and quote on behalf of members,
  with the caller's own bookings still routed through normal member payment
  paths and a quote that refuses to silently price the caller when `forMemberId`
  is supplied (#1345, with the dual-hat booking follow-up #1467); custom
  access-role definitions now flow through the session (#1388) and view-role
  admins get the correct read-only controls (#1394).
- Behaviour change — email preference enforcement: transactional preference
  checks (`shouldSendEmail`) are now wired into the cron check-in reminders and
  the chores email paths so member opt-outs are honoured, and the
  chore/roster dependent-preference handling was aligned (#1328, #1344).
- Behaviour change — non-member hold policy: added the admin toggle governing
  whether public/non-member bookings may hold capacity, with the matching
  stale-copy nudge and copy updates (#1329, #1337).
- Booking-request and approval flows: mapped approval contacts correctly when
  converting requests into bookings (#1304); surfaced a confirm-guests success
  toast (#1312); and made the decline flow record its "quote sent" transition
  cleanly (#1434).
- Bed allocation: reworked the allocation-board UX (#1324), added
  capacity-holding priority so a booking that needs a bed deprioritises
  provisional occupants (#1410), hid the manual-hold control where it did not
  apply (#1405), and gated the bed-allocation board behind its Admin Module
  toggle (#1454); added the link-time conflict advisory and its on-load
  sequencing (#1332, #1340).
- Quote and hold lifecycle: corrected the lapsed-hold banner copy (#1331),
  documented the quote-hold semantics (#1338), and released the hold on a
  declined booking request (#1421).
- Xero and books integrity: split the Xero inbound-reconciliation module into
  cohesive units behaviour-identically (#1330); ran a Xero invoice-line rounding
  audit (#1341); added a persisted `queueType` column to the Xero operation
  outbox, switched the outbox scan to it, and extracted a shared claim helper
  (#1347, #1380, #1381); floored the inbound-repair ledger so a repair cannot
  drive a balance negative (#1408); built a refund-delta pipeline for
  modification refunds (#1414); rejected stale cached Xero refresh tokens
  instead of looping on them (#1416); moved Xero writes out of the booking
  transaction (#1420); handled mixed-sign booking edits (#1428); closed a
  missing refund-credit-note gap (#1477); and hardened mixed cash-plus-credit
  settlement minting (#1486).
- Cancellation and refund money-path (remediation epic #1348): made the
  no-payment cancel claim-first with a fresh re-read under the advisory lock
  (#1334, #1339); closed a cancel-refund crash window with a frozen refund plan
  (#1384); recovered late captures on already-cancelled bookings (#1390); made
  group-settlement refunds retry durably (#1396); closed a cancel
  time-of-check/time-of-use race (#1426); made Internet-Banking hold-expiry
  durable (#1436); guarded the cancelled-booking uncollected path (#1437); sized
  operator repair credit notes correctly and made them manual-review (#1472);
  preserved payment status/refund history through a cancel instead of
  flattening it (#1489); converged the inline and recovery-cron Stripe refund
  request bodies so a frozen-plan cancel-refund replay after a lost recording
  converges at Stripe instead of retrying to exhaustion (#1499); and queued the
  Xero refund credit note for the completed slices when a forced late-capture
  repair refund partially fails (#1501). Behaviour/policy change (decision D7
  refinement): a
  booking cancelled with a captured-but-partially-refunded payment now takes the
  paid cancellation path and receives the policy tier of the remaining captured
  value, instead of forfeiting it until an operator repair run refunded it at
  100%; the repair pass's late-capture refund is now confirm-only and never
  auto-applied (#1493). The committee heads-up on the underlying tiered
  credit-restore cancellation policy is owed before wider rollout.
- Capacity, family, and booking hardening: reused capacity from school-held
  bookings correctly (#1398); confirmed capacity on the confirm-guests path
  (#1413); scoped family lookups on the bookings surface (#1415); blocked minor
  check-ins and followed up on the guard (#1417, #1424); cleaned up orphaned
  family links (#1425); and made confirm-guests recovery resumable (#1432).
- Admin member-detail and members-list UX (live-feedback epic #1438): a
  multi-part member-detail refresh (header, grouped sections, inline edit, and a
  final polish pass) (#1429, #1430, #1431, #1433); a derived User Type dropdown
  with progressive Access Roles disclosure and an "Also a club member" toggle
  (#1460); a single Access column showing the login-journey stage (#1488); a
  real Membership Type filter and a combined "Type – Tier" column (#1490);
  in-dialog bulk-invite errors and progress with the 10-minute cooldown removed
  (#1470); surfaced zod field-validation errors on the member edit/create paths
  (#1461); a global "permanently hide" for family suggestions with a master
  reset (#1466); a shared admin occupancy calendar adopted by Hut Leaders and
  Roster (#1463); a full sidebar restructure into Setup & Configuration hubs
  with Chores moved (#1457); and a Membership Types page redesign (#1464).
- Membership lifecycle — AgeTier N/A (epic #1438): added a `NOT_APPLICABLE`
  age tier for organisation-type members via a two-step enum + backfill
  migration, with server-forced N/A for organisations (422 for people), a
  DOB-derived restore on reclassification, and audits of the age-up cron, Xero
  age-tier groups, and subscription paths to skip N/A (#1484); organisations are
  now exempt from entrance fees (#1492). See the Migration/deployment notes
  below for the quiet-window/deferral deploy plan.
- Xero admin surfaces (epic #1438): the mismatch panels' Refresh now resyncs the
  listed contacts from Xero (targeted, batched, budget-metered) (#1487); a
  contextual "groups last refreshed" hint replaced the persistent banner
  (#1481); and Xero operation payloads gained plain-English request/response
  summaries with a raw-JSON toggle (#1456).
- Finance dashboard rework and hardening: rebuilt the finance dashboard on a
  monthly-facts dataset (#1455), cut over to the reworked dashboard (#1474),
  swept finance number formatting (#1482), added finance-sync health signals
  (#1485), moved the admin payment windows onto the club timezone (#1496), and
  fixed six verified minors from the monthly-facts adversarial review — loud
  partial-parse/partial-resolution sync failures instead of silent data loss,
  bounded backfills that walk through dormant years, and dashboard consistency
  fixes (#1500).
- Settlement and payments: gated settlement behind a cash check (#1458).
- Platform, security, and operations hardening (remediation epic #1348):
  recorded the blue/green migration-safety ledger entry whose absence had
  hard-blocked a fork upgrade from `v0.9.0` (#1382); guarded the demo seed from
  running against real data (#1383); refreshed the deployment docs (#1391);
  surfaced account-deletion state (#1399); documented the custodian workaround
  (#1401); added backup-health signals (#1403); tightened the agent
  guardrails/docs (#1404); fixed a paid-status name typo (#1409); added
  dashboard deep-links (#1395); fixed the `www` canonical redirect (#1412);
  root-caused and fixed a streamed duplicate-mount that broke post-reload
  assertions (#1462); ran a member-UX pass with unpaid-refund copy and
  hard-reload race fixes (#1389, #1392, #1397); polished the hut-leader label
  and fixed its CMS token (#1335, #1342); lazy-loaded the site-style zod bundle
  (#1323); and documented `AUTH_SECRET` rotation plus an owner subscription
  alert (#1465, #1476).
- Planning and research (owner-ratified as research-only, no runtime change):
  recorded the Node 26 LTS upgrade plan (#1497) and the better-auth evaluation
  (#1498).
- Added the fork-facing production upgrade runbook
  (`docs/PRODUCTION_UPGRADE_RUNBOOK.md`) for the v0.9.0-era → v0.10.0 window:
  pre-flight backup and prediction queries, blue/green migrate with the AgeTier
  quiet-window plan, post-upgrade checklist, rollback, and rehearsal/execution
  records (#1502).
- Testing, CI, and release hygiene: added end-to-end coverage for the
  bed-allocation module gate (#1314), route-map drift tests (#1333), email/2FA
  E2E coverage (#1336), made Playwright E2E blocking in CI (#1346), added E2E
  matrix concurrency handling and new journey specs (#1393, #1453), deflaked the
  Internet-Banking E2E (#1407), and landed the Wave-4 independent-review
  regression fixes (#1480).
- Refreshed dependencies with a minor/patch update batch (#1309).
- Migration/deployment notes (read `docs/UPGRADING.md` first; always back up the
  database before migrating):
  - `20260627120000_core_module_defaults_off` switches the high-risk capability
    modules — kiosk, chores, finance dashboard, waitlist, Xero integration, bed
    allocation, and Internet Banking payments — to default `false` and repairs
    only the untouched singleton `ClubModuleSettings` default row (where
    `updatedByMemberId IS NULL`). Any fork whose Module settings were never
    admin-saved will see these features switch OFF on upgrade; re-enable them in
    Admin > Modules after provider/setup readiness. Rows an admin has saved are
    preserved, and general-purpose modules stay default-on.
  - `20260702100000_induction_workflow_types` adds the `HUT_LEADER` induction
    kind and per-kind template activation, and **clears in-flight
    (`DRAFT`/`IN_PROGRESS`) self-assessment and per-item induction result state**
    that the new single-Pass flow no longer uses; completed historical rows are
    preserved. Complete or export any in-flight inductions before upgrading.
  - `20260630120000_rename_member_role_to_user` (contract) collapses the legacy
    `Member.role` `MEMBER`/`ASSOCIATE`/`LIFE` values into `USER` and recreates
    the `Role` enum. It assumes no live deployment used the intermediate
    Access-Roles window; forks that deployed intermediate `main` between
    2026-06-28 and 2026-06-30 should run `npm run db:audit-access-role-cleanup`
    after upgrading.
  - `20260707000000_add_age_tier_not_applicable` and
    `20260707000100_backfill_org_age_tier_not_applicable` add the
    `NOT_APPLICABLE` age tier and flip ADULT organisation-type members to it.
    Pre-#1440 app colors cannot deserialize `NOT_APPLICABLE`, so old-color reads
    of the flipped rows (admin members list, that member's detail, school flows)
    can error between migrate and cutover. Per the owner decision on epic #1438
    (2026-07-07), deploy both migrations in a **quiet window** and cut over
    promptly, or **defer** the backfill migration until the old color drains
    (the UPDATE is idempotent and safe to run late). See
    `docs/BLUE_GREEN_MIGRATION_SAFETY.tsv` and `docs/UPGRADING.md`.
  - Verified blue/green-safe, no re-audit needed: the `ClubTheme` sub-AA gold
    theme bump is conditional on the persisted value (#1244), the
    `BookingGuestNight` backfill is automatic and old-code-compatible, and the
    access-role backfills keep old code reading
    `Member.role`/`financeAccessLevel` unchanged. All are recorded in
    `docs/BLUE_GREEN_MIGRATION_SAFETY.tsv`.

## 0.9.0 - 2026-06-27

- Release classification: minor public reference release. The change set since
  `0.8.0` adds public join flows, module controls, induction, locker,
  finance-dashboard, provider-recovery, and security hardening while preserving
  the existing public deployment shape.
- Added group-booking join flows and APIs, including organiser-owned join
  codes, member self-add, non-member email verification, organiser management,
  organiser cancellation cleanup, public join pages, member dashboard context,
  and protected route/API coverage for group joinability.
- Added group-booking settlement options for both each-pays-own and
  organiser-pays modes. Organisers can collect one combined Stripe payment or
  one Internet Banking/Xero invoice for joined bookings, while joiners remain
  linked to their own child bookings for capacity, status, and audit purposes.
- Added lodge induction and sign-off workflows with induction templates,
  section/item results, assigned signers, self-assessment capture, member
  sign-off records, route access hardening, and nomination settings support for
  deployments that require induction before membership completion.
- Added member locker administration and allocation, including API validation,
  unique locker names, dashboard/member context, and admin controls that can be
  disabled through Admin Modules.
- Added database-backed Admin Modules toggles for group bookings, lockers,
  induction, work parties, promo codes, hut leaders, communications, and
  skifield conditions, keeping deploy-time `.env` capabilities as the outer
  operator gate.
- Added member category and profile metadata support, including Life and
  Associate member categories, title, gender, occupation, life-member date,
  comments, configurable member-field visibility, CSV import/export hardening,
  and refreshed member edit/detail screens.
- Added subscription booking lockout controls so clubs can block bookings for
  members with unpaid annual subscriptions, configure the lockout behavior in
  admin, and align the subscription year with either Xero's financial year or
  an explicit local override.
- Reworked the finance dashboard to use the single operational Xero connection
  already used by bookings, payments, and subscriptions. Finance-specific Xero
  OAuth routes, token storage, and finance Xero usage metering were removed,
  while finance reports gained revenue reconciliation, chart-of-accounts
  snapshots, KPI cards, trend/mix charts, balance-sheet, cash, costs, working
  capital, pricing-sensitivity, and booking metric views.
- Added Whakapapa/skifield condition widgets and admin cache controls with
  cached report payloads, freeze windows, public endpoint handling, and module
  gating for deployments that do not expose mountain-condition content.
- Fixed image upload/runtime storage and visual-editor behavior, including
  read-only root filesystem upload handling, image resizing, admin toolbar and
  alignment tests, photo-gallery token rendering, and safer upload trace
  redaction.
- Improved email/provider recovery visibility with token-email recovery
  actions, undeliverable admin-alert escalation, waitlist-offer email failure
  surfacing, Xero amount-mismatch repair alerts, missing Xero refund credit-note
  reporting, stale Xero operation/inbound-event recovery, exhausted payment
  recovery health signals, and the consolidated operator queue.
- Hardened security and idempotency boundaries, including source-scoped
  processed webhook event claims, SES SNS SignatureVersion 2 enforcement,
  Xero token refresh leases, payment-link/client-secret ownership tests,
  group-join response neutralisation, mixed-method route boundary coverage,
  public rate-limit proxy assumptions, and high-severity dependency refreshes.
- Migration/deployment notes:
  - `20260615110000_add_lodge_induction_signoff` creates induction template,
    result, signer, and settings tables plus `Member.requiresInduction`; run
    during low membership-admin traffic before enabling induction-gated flows.
  - `20260616120000_induction_assigned_signers_and_self_assessment` adds
    induction self-assessment fields and assigned-signer records; avoid active
    induction edits during cutover.
  - `20260618120000_add_group_booking` adds group-booking and join staging
    tables for shareable join codes; open new group joins only after the new
    runtime is live.
  - `20260619120000_add_booking_organiser_settled` adds
    `Booking.organiserSettled` for organiser-pays child bookings; run during
    low booking traffic and do not create organiser-pays joins until old app
    colors have drained.
  - `20260619130000_add_group_booking_settlement` and
    `20260620120000_add_group_settlement_internet_banking` add combined group
    settlement records for Stripe and Internet Banking/Xero settlement.
  - `20260620121500_add_whakapapa_report_cache` and
    `20260620133000_add_whakapapa_cache_frozen_until` add cached skifield
    report payloads and freeze-window controls.
  - `20260620145000_add_lockers` and `20260622100000_harden_locker_names` add
    member locker allocation and then enforce unique, bounded locker names;
    resolve duplicate locker names before the hardening migration.
  - `20260621150000_scope_processed_webhook_event_idempotency` replaces the
    global webhook-event idempotency key with a `(source, eventId)` key so
    Stripe, Xero, and SES events cannot collide across providers.
  - `20260621160000_add_xero_token_refresh_lease` adds the operational Xero
    token refresh lease used to prevent parallel refresh-token rotation.
  - `20260622120000_add_module_toggles` adds Admin Modules activation booleans
    for the newly modularised features, all defaulting on for upgraded installs.
  - `20260623120000_add_member_status_fields`,
    `20260623130000_add_member_gender_title`, and
    `20260626120000_member_field_visibility_and_categories` add the new member
    metadata/category fields and settings; avoid assigning new enum categories
    until the new runtime is serving traffic.
  - `20260626120000_add_membership_lockout_settings` adds the singleton
    subscription booking-lockout settings row used by admin controls.
  - `20260626120000_add_chart_of_accounts_finance_snapshot_type` adds the
    finance chart-of-accounts snapshot type used by revenue reconciliation.
  - `20260626121000_drop_finance_xero_storage_and_usage` drops the retired
    finance-specific Xero token and usage tables after the runtime has moved to
    the single operational Xero connection.

## 0.8.0 - 2026-06-15

- Release classification: minor public reference release. The change set since
  `0.7.0` adds major booking, content-management, public-request, lodge
  operations, and payment-link capabilities without an intentional public API or
  deployment-contract break that would justify `1.0.0`.
- Added admin-managed public website content, replacing hard-coded public pages
  with database-backed `PageContent` records, dynamic website routing, rich
  HTML editing, starter page backfills for deploy-only environments, and a
  first-class 404 content row.
- Added the page-content editor and image-picker workflow so admins can manage
  home, about, join, rules, contact, committee, membership-application, and 404
  content from the admin app while keeping special blocks such as member
  applications, contact forms, and committee cards available in managed pages.
- Added database-backed image management with upload APIs, public image
  delivery, image-library admin views, deletion coverage, metadata, alt text,
  and persistent storage that survives Docker redeploys instead of relying on
  ephemeral container filesystem paths.
- Added the site style wizard and theme storage with editable brand colours,
  heading/body font choices, logo data, raw CSS support, and seeded defaults
  that preserve an existing deployment's completed theme while giving new
  adopters generic starter branding.
- Added public non-member booking requests, including quote discovery, email
  verification tokens, admin review/pricing/approval/decline flows, conversion
  into bookings, admin notifications, and public payment links that do not
  require a member login.
- Added school group booking requests with school-name capture, teacher
  snapshots, school-specific public request routes, admin review support, and
  conversion paths that can create the required booking/member records for
  supervised school stays.
- Added secure public payment-link pages with token-hash storage, expiry,
  refresh and PaymentIntent creation routes, booking/payment narrative display,
  and shared member/non-member booking status copy.
- Changed booking capacity rules so only paid or confirmed bookings hold
  capacity, members pay up front, and provisional non-member records can expire
  cleanly without holding beds indefinitely.
- Added linked mixed-party booking handling: mixed member/non-member stays can
  split into a paid member parent booking plus a provisional non-member child
  booking, keeping member capacity and payment state separate from guests who
  still need to confirm or pay.
- Added cron-driven provisional non-member hold expiry with booking events,
  parent/child booking handling, payment-link revocation, and visible admin
  narratives when holds expire.
- Added durable `BookingEvent` records and a shared booking/payment-link
  narrative layer so created, paid, confirmed, bumped, cancelled, refunded, and
  credited events survive audit-log pruning and show consistently across
  booking and payment-link views.
- Added multi-date-range stays with a per-guest night grid, persisted
  `BookingGuestNight` rows, per-night integer-cent pricing, non-contiguous
  night support, booking creation/editing support, quote validation, Xero
  invoice line grouping, bed allocation support, and reporting compatibility.
- Added default partial-bump handling for capacity-constrained member bookings:
  members can keep their own paid stay while non-member guests are dropped and
  repriced unless the new "only book if my guests can come" flag asks for the
  whole booking to be cancelled.
- Added admin override and follow-up actions for pending guests, including
  confirm-pending-guests routes, UI controls, tests, and payment/narrative
  updates for the revised capacity model.
- Added preferred room requests at booking time, admin editing for requested
  rooms, route coverage, and auto-allocation support so the bed allocator tries
  the requested room before falling back to family-aware first-fit allocation.
- Reworked bed allocation into a drag-and-drop board with per-night guest
  chips, bucket views, room/bed tables, allocation chips, requested-room badges,
  and support for the new per-guest night model.
- Moved rooms and beds into admin configuration with import-from-config support
  so lodge inventory is managed through the app instead of requiring source-code
  changes.
- Added work party/working bee events with date ranges, admin CRUD, internal
  auto-applied promo codes, active public work-party discovery, CodeQL-safe code
  generation, and promo validation for volunteer discount stays.
- Expanded promo scope handling with assigned-member own-night restrictions,
  per-guest redemption targets, configurable fixed-nightly group promo pricing,
  hidden internal promo codes for work parties, and stronger promo route tests.
- Added protected lodge instructions for hut leaders, including open, close, and
  day-to-day documents stored separately from public page content, admin editing
  APIs, hut-leader/authenticated views, and kiosk display support.
- Added rolling door-code pre-arrival reminders with email-template support,
  per-booking sent timestamps, cron coverage, and subject-line hardening so
  sensitive door codes cannot be exposed in email subjects.
- Genericised seed data and first-run defaults for public adopters, including
  starter page content, account/default subscription rows, explicit member
  import no-op results, and setup/subscription handling when Xero is disabled.
- Hardened admin API boundaries with consolidated `requireAdmin` guard usage,
  query validation coverage, removed brittle exact API route counts, safer
  Prisma migration whitespace handling, and more focused tests for changed
  routes.
- Fixed admin daily revenue reports dropping the final day across DST and
  continued the release-wide NZ date-only hardening so booking/report dates do
  not drift through browser-local or timezone-sensitive parsing.
- Fixed migration drift by adding a follow-up migration that drops DB-level
  defaults from `@updatedAt` columns now managed by Prisma Client.
- Updated dependency and security posture with an npm minor/patch dependency
  refresh, an `esbuild` advisory fix, and release-follow-up changes for GitHub
  Actions/static-analysis failures.
- Migration/deployment notes:
  - `20260607171000_add_promo_assignment_scope` adds
    `PromoCode.assignedMembersOnlyOwnNights` with a default of `true`; deploy
    during low promo-booking traffic and review assigned-member promo behaviour
    before enabling new scoped promotions.
  - `20260608103000_add_promo_redemption_guest_targets` creates
    `PromoRedemptionGuestTarget` so redemptions can be tied to individual guest
    nights; deploy before using own-night promo enforcement.
  - `20260611100000_add_page_content`,
    `20260611101500_backfill_starter_page_content`, and
    `20260614110000_backfill_404_page_content` add and seed database-backed
    public pages for environments that run migrations without the seed.
  - `20260611120000_add_door_code_pre_arrival_reminders` adds
    `Booking.preArrivalReminderSentAt`, `EmailMessageSetting.doorCode`, and a
    booking status/reminder/check-in index for the new cron reminder path.
  - `20260611123000_add_club_theme` and
    `20260614100000_add_club_theme_raw_css` add the singleton theme record,
    fonts, logo storage, colours, and raw CSS customisation used by the style
    wizard.
  - `20260611150000_add_lodge_instructions` creates the protected lodge
    instruction documents and backfills open, close, and day-to-day rows.
  - `20260612090000_add_booking_requested_room` adds a nullable
    `Booking.requestedRoomId` foreign key into lodge-room inventory; run during
    low booking traffic.
  - `20260612100000_add_work_party_events` adds hidden internal promo support
    and `WorkPartyEvent` records; create work-party events only after the new
    runtime is serving traffic.
  - `20260612110000_add_media_image` stores uploaded images in Postgres; verify
    database storage/backups are sized for image uploads before opening the
    admin image manager broadly.
  - `20260612120000_add_cancel_if_guests_bumped` adds the member opt-in
    whole-booking cancellation flag for capacity bump handling.
  - `20260612130000_add_booking_request_flow` creates booking request,
    payment-link, settings, verification, and notification structures used by
    the public non-member request flow.
  - `20260613090000_add_school_booking_request` adds the `SCHOOL` request type
    and school-specific request columns.
  - `20260613090000_update_starter_home_page_content` updates only untouched
    starter home-page copy; admin-edited rows are left unchanged.
  - `20260613100000_add_booking_group_link` adds
    `Booking.parentBookingId` for linked member/non-member bookings; run during
    low booking traffic and let the deploy guard stop on lock timeout.
  - `20260614090000_add_booking_guest_night` backfills one
    `BookingGuestNight` row per historical guest night and splits existing
    integer-cent guest totals exactly across nights. Run during low booking
    traffic, avoid booking/guest writes during migration and cutover, and
    verify every active guest has night rows before enabling multi-date ranges.
  - `20260614153000_add_booking_event` creates the durable booking event store;
    no historical event backfill is attempted, so narratives become complete
    from the first runtime write after deployment.
  - `20260615090000_drop_updatedat_column_defaults` reconciles database defaults
    with Prisma `@updatedAt` semantics for `BedAllocationSettings` and
    `ClubTheme`; it is intended to clear migration-drift checks without
    changing application behaviour.

## 0.7.0 - 2026-06-08

- Added room and bed allocation management with admin room/bed inventory,
  first-fit family-aware allocation planning, automatic lifecycle
  reconciliation for booking confirmation/edit/cancel/waitlist flows, manual
  allocation controls, approval tracking, and focused bed-allocation filters.
- Added per-guest booking date ranges to the live booking and modification
  flows, including capacity accounting, quote validation, waitlist, roster, and
  finance/reporting paths that count only each guest's actual stay nights.
- Added fixed-nightly-price promo codes with set-price and cap-only modes,
  integer-cent promo adjustment tracking, member/profile display, booking edit
  support, Xero invoice handling, and promo-admin validation.
- Added Internet Banking payment support backed by operational Xero invoices,
  first-class `PaymentSource` typing, payment option discovery, booking-detail
  invoice/reference display, and inbound Xero reconciliation for settlement
  instead of routing bank-transfer bookings through Stripe.
- Added booking reduction settlement choices so negative booking modifications
  can become either Stripe refund work or idempotent member account credits,
  with source-linked modification credits and Xero settlement payload coverage.
- Added the member CSV import wizard with column mapping, date-format handling,
  preview/failure reporting, skip counts, and hardened import validation.
- Added admin operational filters and drilldowns for booking payment source,
  Xero sync state, bed allocation state, per-guest ranges, change/refund state,
  payment settlement kind, Xero operations, and inbound Xero events.
- Hardened payment and accounting boundaries so Internet Banking bookings do
  not enter Stripe-only PaymentIntent, refund, or recovery paths and Xero
  invoice settlement is driven by the inbound reconciliation path.
- Hardened API and operational surfaces with centralized malformed-JSON
  responses on changed routes, cron/payment/Xero audit visibility, and a pinned
  Turbopack root for predictable Next.js 16 builds.
- Migration/deployment notes:
  - New optional module gates are `FEATURE_BED_ALLOCATION` and
    `FEATURE_INTERNET_BANKING_PAYMENTS`; Internet Banking also requires
    operational Xero capability, credentials, and tenant connection.
  - `20260607120000_add_bed_allocation_and_internet_banking_modules` adds the
    Admin Modules activation booleans for bed allocation and Internet Banking.
  - `20260607130000_add_fixed_nightly_promo_adjustments` adds fixed-nightly
    promo types and integer-cent adjustment columns on booking/promo redemption
    records; deploy during low promo-booking traffic.
  - `20260607133000_add_bed_allocation_inventory` and
    `20260607142000_add_bed_allocation_settings` add the room, bed, allocation,
    and settings tables used by admin bed allocation.
  - `20260607150000_add_payment_source_foundation` adds first-class Stripe vs
    Internet Banking payment source fields; do not enable Internet Banking
    payments for members until old app colors have drained.
  - `20260607164000_add_booking_modification_credit_source` and
    `20260607165000_make_booking_modification_credit_unique` add source-linked,
    idempotent member credits for booking reductions.

## 0.6.0 - 2026-06-03

- Added booking review and approval workflows, including `AWAITING_REVIEW`
  booking status handling, member justification capture, admin review APIs,
  approval queue views, and route coverage for review, modify, cancel,
  force-confirm, and report paths.
- Added child family request dependant creation, no-adult booking review
  handling, unpaid cancelled booking deletion, and clearer admin queue
  navigation for booking and family-group review work.
- Added promo-code finance improvements with per-promo-code Xero coding,
  split per-booking and lifetime free-night caps, partial discount support,
  and migration coverage for promo and review data changes.
- Hardened privileged, public, webhook, payment, Xero, runtime-status, cron,
  route-guard, and external-service boundaries with focused tests and security
  documentation.
- Updated CI and deployment hardening, including gitleaks v3, dependency review,
  static analysis, Docker image scanning, migration-safety documentation, and
  production image runtime dependency packaging.
- Refreshed minor and patch dependencies across the application stack, including
  Next.js, React, Sentry, Stripe, Nodemailer, Vitest, ESLint, and related lockfile
  entries, while retaining explicit security overrides for vulnerable transitive
  packages.

## 0.5.0 - 2026-05-28

- Added safe booking deletion with nullable booking soft-delete fields, admin
  visibility filtering, deletion audit coverage, and a migration safety ledger
  entry for the hot `Booking` table.
- Added the archive lifecycle review queue and admin/member lifecycle surfaces
  for governed archive handling.
- Fixed promo beneficiary cap accounting with per-member promo redemption
  allocations, allocation-aware redemption counts, and migration coverage for
  existing redemptions.
- Fixed placeholder subscription delete blockers so draft and placeholder guest
  subscriptions no longer block legitimate member cleanup paths.
- Folded the blue/green deploy engine into
  `scripts/run-production-blue-green-deploy.sh` and removed the old
  `scripts/blue-green-deploy.sh` entrypoint.
- Extracted focused helpers and tests for family admin UI behavior, booking
  guest removal, membership cancellation blockers, admin audit queries, finance
  booking metrics, and Xero outbox payload parsing.
- Migration/deployment notes:
  - `20260527090000_add_booking_soft_delete_fields` adds nullable
    `Booking.deletedAt`, `Booking.deletedById`, and `Booking.deletedReason`
    columns, supporting indexes, and a `SET NULL` member foreign key. The
    ledger marks it as an expand migration that old code ignores; deploy during
    low booking traffic and let the deploy guard stop on lock timeout or
    migration failure before cutover.
  - `20260527120000_add_promo_redemption_allocations` creates
    `PromoRedemptionAllocation`, backfills one allocation per existing
    `PromoRedemption`, recalculates `PromoCode.currentRedemptions`, and installs
    insert/update triggers so old app colors continue writing one-booker
    allocations during blue/green drain. Run it during low promo-booking
    traffic.
  - `docs/BLUE_GREEN_MIGRATION_SAFETY.tsv` records both new migrations as
    expand-phase and old-code-compatible. They do not require a breaking
    migration override.
  - The production wrapper now resolves the deploy ref, derives SHA-tagged GHCR
    image references unless both `APP_IMAGE` and `MIGRATE_IMAGE` are supplied,
    creates a clean archive workspace, preserves the live Caddy upstream state,
    runs the integrated internal blue/green flow, syncs the source checkout to
    the deployed commit, and prunes stale deploy workspaces.

## 0.4.0 - 2026-05-26

- Added adopter-focused implementation and documentation index guides.
- Made public GHCR image publishing easier to reuse from forks.
- Removed completed repository-split planning artifacts from the public tree.
- Replaced remaining public-facing legacy TACBookings wording with generic
  booking-system language.
- Added admin-initiated membership cancellation requests and cancellation
  refund-policy copy in member/admin email paths.
- Expanded booking-change request handling with review-queue alignment, linked
  executed modifications, notification preferences, and refund-recovery
  coverage.
- Hardened payment, Xero, and external-service operations with Stripe webhook
  observability, stale recovery alerts, token redaction, and safer error
  handling.
- Continued maintainability work across booking creation/modification services,
  route boundaries, admin member pages, admin Xero panels, Xero integration
  modules, and the quality-report baseline.
- Added migration safety coverage for post-0.3.0 changes, including
  BookingGuest stay-range constraints and the promo-code per-individual
  redesign.

## 0.3.0 - 2026-05-24

- Added admin-managed email message configuration, previews, resets, delivery
  policies, and email message audit documentation.
- Added durable Stripe payment recovery and cleanup for superseded zero-dollar
  booking intents.
- Expanded booking editing with guest stay ranges, future-night edits,
  member/admin change requests, and Xero booking-edit settlement handling.
- Added membership cancellation workflows for member requests, confirmations,
  admin approval, participant handling, configurable settings, and Xero
  cancellation handling.
- Added governed member lifecycle flows for safe delete and archive requests.
- Improved admin and operational surfaces, including setup readiness, cron and
  payment maintenance, kiosk/lodge date scoping, finance metrics, and dark mode.

## 0.2.0 - 2026-05-21

- Added the setup wizard and Admin Modules settings/effective-state workflow.
- Tightened public onboarding, security headers, and issue-report origin
  handling.
- Ported generic public-site and module-migration fixes back to the shared
  reference application.
- Extracted booking policy and member credit ledger rules for clearer
  maintenance.
- Fixed cron health reporting for expected job history.
- Fixed zero-dollar booking batch edits so payment-pending bookings that become
  free are settled as paid.

## 0.1.0 - 2026-05-17

- Prepared the repository for a public MIT reference release.
- Added public governance, support, security, and contribution documents.
- Removed private audit queues, agent handoffs, and internal review artifacts
  from the public tree.
- Added public GitHub issue and pull request templates.
- Renamed public GHCR image packages to `alpineclubbookingsnz-app` and
  `alpineclubbookingsnz-migrate`.
- Published the initial AlpineClubBookingsNZ production application baseline.
