# Run this for your club

Audience: Adopter, Operator

This is one of the repository's two documentation entry points. It is everything
a club needs to **evaluate, configure, deploy and run** AlpineClubBookingsNZ.
You can read this path end to end without opening `AGENTS.md`, `CLAUDE.md`, the
invariant files, or any other contributor material. The other entry point,
[Change the code](../contributors/README.md), is for people and agents changing
the product.

Members and guests of a club that already runs this platform want the
[Member & Guest Guide](../user-guide/README.md) instead.

## Start here

One deployment serves **one club**. This repository is the generic product every
club deploys, and it does not encode which club — your club's identity, rates,
capacity, branding, wording and feature set are all configuration you supply.
[Configure, don't fork](configure-or-fork.md) explains the four levers and how
to tell which one your change needs; read it before you write any code.

Then work through these in order:

1. [`../../README.md`](../../README.md) — what the product is and what it does.
2. [`../IMPLEMENTATION_GUIDE.md`](../IMPLEMENTATION_GUIDE.md) — the practical
   path from clone to a configured club: club identity, environment, database,
   providers in test mode, and validation before you share it with anyone.
3. [`../../CONFIGURATION.md`](../../CONFIGURATION.md) — the reference for every
   environment variable and the `config/club.json` schema.
4. [`../../DEPLOYMENT.md`](../../DEPLOYMENT.md) — read before any shared or
   production environment goes online. Docker Compose, a reverse proxy, GHCR
   images, backups, and the blue/green deploy script. (It lives at the
   repository root, not under `docs/`.)
5. [`../UPGRADING.md`](../UPGRADING.md) — how to take a new upstream release
   into your deployment, release by release, including the manual steps a
   release needs.
6. [Contribute a change upstream](upstream-contributions.md) — when your club
   builds something reusable, how to get it into the product instead of
   maintaining it forever in your own fork.

## Configuring the product

- [Configure, don't fork](configure-or-fork.md) — module toggle, setting,
  seed default, or genuine code change: the canonical guide to which lever a
  change belongs on.
- [Modules](../guides/modules.md) — the live list of every optional capability
  and its out-of-the-box default, on one admin page.
- [Setup](../guides/setup.md) — the in-app installation checklist and
  configuration hub at `/admin/setup`.
- [Site Appearance & Content](../guides/appearance.md), [Site Style](../guides/site-style.md),
  [Site Content](../guides/site-content.md), [Page Content](../guides/page-content.md),
  [Site Banners](../guides/site-banners.md), [Image Manager](../guides/image-manager.md)
  — branding, the public website, and its content, all editable in-app with no
  redeploy.
- [Export & Import](../guides/config-transfer.md) — portable
  configuration/content bundles for moving a configured setup between
  environments (Full Admin only).
- [`../PUBLIC_PAGE_CONTENT_TOKENS.md`](../PUBLIC_PAGE_CONTENT_TOKENS.md) —
  publishing authoritative membership, fee, booking and cancellation blocks
  through content tokens rather than hand-typed copy.

## Operating a live club

Task-focused, illustrated guides, one per admin area. They cover every admin
area of the product; [`../COVERAGE_MATRIX.md`](../COVERAGE_MATRIX.md) is the
per-route index if you would rather start from a URL.

### Bookings and capacity

- [Bookings](../guides/bookings.md) — the master booking list, filters, and
  availability calendar.
- [Book on Behalf](../guides/book.md) — create a booking for a member or
  non-member.
- [Booking Requests](../guides/booking-requests.md) — approvals, locked-period
  change requests, and public (non-member) requests. (Also covers the
  `booking-approvals` and `booking-change-requests` routes, which redirect
  here.)
- [Booking Policies](../guides/booking-policies.md) — cancellation refunds,
  date-specific periods, group discount, minimum stay, and public-request
  settings.
- [Booking Messages](../guides/booking-messages.md) — member-facing booking,
  payment, and cancellation copy.
- [Bookings Setup](../guides/bookings-setup.md) — the rooms/beds and
  booking-copy setup hub.
- [Seasons](../guides/seasons.md) — season windows per lodge.
- [Age Groups](../guides/age-tier-settings.md) — membership age tiers and their
  booking rules.
- [Promo Codes](../guides/promo-codes.md) — discount codes and vouchers.
- [Bed Allocation](../guides/bed-allocation.md) — the drag-and-drop bed board
  and per-lodge auto-allocation preferences.
- [Waitlist](../guides/waitlist.md) — the waitlist queue and force-confirm.
- [Payments](../guides/payments.md) — the booking-payment ledger and Xero
  invoice state.
- [Reports](../guides/reports.md) — stay-night occupancy, booked revenue,
  payment-derived collected cash, outstanding additions, and member analytics.

### Membership and applications

- [Members](../guides/members.md) — the member directory, login-readiness
  status, safe read-only opening, CSV import, roles, seasonal membership, and
  merge.
- [Member Applications](../guides/member-applications.md) — the join/nomination
  review queue and how approval maps people to member records.
- [Member Fields](../guides/member-fields.md) — which extra profile fields are
  collected from members and applicants.
- [Membership Types](../guides/membership-types.md) — seasonal membership
  categories, their booking and subscription policy, and roll-forward.
- [Membership & Members setup](../guides/membership-setup.md) — the setup hub
  for types, fields, and subscription lockout.
- [Subscription Lockout](../guides/subscription-lockout.md) — the
  unpaid-subscription booking lockout, financial year, and Xero paid-detection.
- [Cancellation Requests](../guides/membership-cancellations.md) — the
  membership cancellation and archive review queue, plus the cancellation
  copy/Xero settings.
- [Committee](../guides/committee.md) — committee roles, assignments, and the
  public contact routing.
- [Family Groups](../guides/family-groups.md) — households, the billing member,
  and the family-link request queue.
- [Family Suggestions](../guides/family-suggestions.md) — auto-detected family
  groupings to confirm or dismiss.
- [Induction](../guides/induction.md) — the induction register, sign-offs, and
  induction settings.
- [Deletion Requests](../guides/deletion-requests.md) — member self-service
  deletions and admin-initiated hard-delete review (two-admin rule).
- [Lockers](../guides/lockers.md) — locker inventory and member allocation
  (lodge-scoped).
- [Fees](../guides/fees.md) — the consolidated hut, joining, and annual fee
  console and family billing. (Also covers the `fee-configuration` route, which
  redirects here.)
- [Subscriptions](../guides/subscriptions.md) — annual membership-fee billing,
  shared member Access status, permission-safe member links, family billing
  mode, and manual mark-paid.
- [Refunds & Credits](../guides/refund-requests.md) — the refund-appeal and
  credit-approval review queue.
- [Internet Banking](../guides/internet-banking.md) — bed holds and lead-time
  rules for Xero-invoiced bank-transfer payments.
- [Xero Sync](../guides/xero.md) — the Xero connection, sync, reconciliation
  ledger, and records browser.

### Lodge operations

- [Rooms & Beds](../guides/rooms-beds.md) — the room/bed inventory and the
  capacity it derives (lodge-scoped).
- [Chore Templates](../guides/chores.md) — the chore library the roster draws
  from (lodge-scoped).
- [Chore Roster](../guides/roster.md) — the daily chore board: generate,
  confirm, print, and email.
- [Hut Leaders](../guides/hut-leaders.md) — assigning on-site leaders for the
  nights that need cover, and their kiosk PINs.
- [Work Parties](../guides/work-parties.md) — working-bee events and their
  automatic booking discount.
- [Events Calendar](../guides/calendar.md) — the club events calendar, recurring
  events, per-instance vs series edits, MiroTalk video meetings, and the Events
  calendar module switch.
- [Lodge Kiosk](../guides/lodge.md) — the shared lodge-tablet sign-in for
  check-in and lodge info.
- [Lodge Instructions](../guides/lodge-instructions.md) — the protected opening,
  closing, and day-to-day documents.
- [Lodges](../guides/lodges.md) — the lodge properties list and per-lodge
  configuration hub.
- [Lobby Display](../guides/display.md) — pairing lobby screens and authoring
  the boards they show (the optional `lobbyDisplay` module). Its
  [operating guide](../lobby-display/operating.md) covers the day-to-day running
  of a paired screen.

### Communications, content and the support console

- [Notifications & Email](../guides/notifications.md) — the delivery-rules,
  recipients, email-messages, and message-copy hub.
- [Delivery Rules](../guides/notification-rules.md) — which admin and system
  emails are sent when jobs or alerts run.
- [Recipients](../guides/notification-recipients.md) — which system alerts each
  admin receives.
- [Email Messages](../guides/email-messages.md) — shared email variables and the
  wording of audited email templates.
- [Communications](../guides/communications.md) — admin bulk email to opted-in
  members.
- [Member Notices](../guides/member-notices.md) — committee news notices
  targeted to member audiences, shown on the dashboard with read/acknowledge
  tracking.
- [Email Deliverability](../guides/email-deliverability.md) — suppressions and
  exhausted delivery failures.
- [Mountain Conditions](../guides/mountain-conditions.md) — the ski-field
  conditions cache and public widget.
- [Admin Dashboard](../guides/dashboard.md) — the attention cards, stat cards,
  and quick actions.
- [Access Roles](../guides/access-roles.md) — custom admin roles and their
  permissions (Full Admin only).
- [Audit Log](../guides/audit-log.md) — the searchable activity timeline.
- [System Health](../guides/health.md) — service checks, system info, and
  webhooks.
- [Background Jobs](../guides/background-jobs.md) — cron job health and run
  history.
- [Stuck States](../guides/stuck-states.md) — the operator queue for stuck
  records.
- [Issue Reports](../guides/issue-reports.md) — the member issue-report triage
  queue.
- [Login & Security](../guides/security.md) — password policy and sign-in
  methods.
- [Integrations](../guides/integrations.md) — connected services (Xero,
  analytics, backups; feature-gated).
- [AI Help Assistant](../guides/ai-help.md) — the in-app help widget and the
  optional paid AI assistant (module, key, spend cap, and privacy).
- [AI Diagnostics deployment](../ai-diagnostics/deployment.md) — the operator
  setup order for the separate admin-only diagnostics assistant: provisioning
  and rotating its SELECT-only database role, and reading its readiness
  endpoint.

## Policy, runbooks and recovery

The deep-detail layer beneath the guides. Reach for a guide for the
task-focused walkthrough, and these for the underlying policy or the recovery
procedure.

- [`../CANCELLATIONS.md`](../CANCELLATIONS.md) — membership cancellation refund,
  credit-note, and GST policy.
- [`../AUTHORITATIVE_FEES.md`](../AUTHORITATIVE_FEES.md) — membership/entrance
  fee schedules, public listing review, and family billing exceptions.
- [`../MAINTENANCE.md`](../MAINTENANCE.md) — the public validation and release
  checklist, and the documented operator CLIs.
- [`../PRODUCTION_UPGRADE_RUNBOOK.md`](../PRODUCTION_UPGRADE_RUNBOOK.md) — the
  owner-driven runbook for upgrading a live deployment across a release:
  pre-flight backup, blue/green migrate, post-upgrade checklist, and rollback.
- [`../AUDIT_RETENTION_ARCHIVE_RUNBOOK.md`](../AUDIT_RETENTION_ARCHIVE_RUNBOOK.md)
  — audit-log retention and optional archival.
- [`../INDUCTION_BASELINE_RUNBOOK.md`](../INDUCTION_BASELINE_RUNBOOK.md) — the
  dry-run-first runbook for recording an authorised historical induction
  baseline.
- [`../XERO_MEMBER_GROUPING_RUNBOOK.md`](../XERO_MEMBER_GROUPING_RUNBOOK.md) —
  operating the Xero member-grouping cutover.
- [Backups](../guides/backups.md) — S3-backed PostgreSQL backups, configured
  in-app, run on demand or nightly, with a scripted restore drill.
- [Club Time Zone](../guides/club-time.md) — the one time zone the club runs on,
  recorded in-app rather than taken from the server's clock. Full Administrator
  only, confirmed and audited, and it rewrites nothing already recorded.
- [Environment Safety](../guides/environment-role.md) — whether this
  installation is the club's live site or a copy of it, declared explicitly and
  never inferred. What "not configured" means, why a copy of the live database is
  the case that matters, and what an existing live site must add before it can be
  upgraded.

## Releases

- [`../releases/README.md`](../releases/README.md) — per-release notes, newest
  first.
- [`../../CHANGELOG.md`](../../CHANGELOG.md) — the full change history.
- [`../UPGRADING.md`](../UPGRADING.md) — the release-by-release upgrade steps,
  including anything manual a release needs.

## Getting help, reporting problems, and the licence

- [`../../SUPPORT.md`](../../SUPPORT.md) — where to ask a question.
- [`../../SECURITY.md`](../../SECURITY.md) — report a suspected vulnerability
  **privately**. Never post secrets, personal data, or accounting records in a
  public issue.
- [`../../CODE_OF_CONDUCT.md`](../../CODE_OF_CONDUCT.md) — how this project
  expects people to behave.
- [`../../NOTICE.md`](../../NOTICE.md) — the club branding, logos, copy, and
  domains included in this repository are there for context only. Replace them
  with your own before you run this for another organisation.
