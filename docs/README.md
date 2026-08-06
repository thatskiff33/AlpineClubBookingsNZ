# Documentation

This is the documentation hub for AlpineClubBookingsNZ. It is organised
**audience-first**: find your role below, follow its "Start here" path, then
branch into the reference and feature docs. Every document in `docs/` is
reachable from this page, directly or through a feature hub.

New to the docs? Read [`STYLE_GUIDE.md`](STYLE_GUIDE.md) to see how these pages
are written and structured, and [`COVERAGE_MATRIX.md`](COVERAGE_MATRIX.md) for
what is and is not yet documented per admin area.

## Pick your audience

| You are… | Start here |
| --- | --- |
| **Using** the club as a member or guest | [Members and guests](#members-and-guests) |
| **Adopting / forking** the platform for your club | [New Adopters](#new-adopters) |
| **Operating** a live club day to day | [Operators](#operators) |
| **Developing** / changing the code | [Developers](#developers) |
| An **automated agent** (Claude Code, Codex) | [Agents](#agents) |

---

## Members and guests

Using the club: members signing in to book a stay, and guests staying without a
login.

**Start here:** the [Member & Guest Guide](user-guide/README.md) — plain-English,
step-by-step guides for the public and member-facing side of the app (the
website, sign-in, your dashboard, the booking wizard, your profile). The
journeys:

- [Joining the club](user-guide/joining-the-club.md) — apply, get nominated,
  approved, and sign in for the first time.
- [Booking a stay](user-guide/booking-a-stay.md) — the booking wizard, member and
  non-member guests, and the Members First vs First Paid, First In hold policies.
- [Paying for your stay](user-guide/paying-for-your-stay.md) — card, internet
  banking, account credit, and split charges.
- [Managing your family & household](user-guide/managing-your-family.md) — family
  groups, dependents, and partners.
- [Managing your account](user-guide/your-account.md) — profile, email/password,
  two-factor, sign-in methods, notifications, and privacy/deletion.
- [The waitlist & offers](user-guide/waitlist-and-offers.md) — join a full night
  and accept an offer.
- [Changing or cancelling a booking](user-guide/changing-or-cancelling-a-booking.md)
  — changes, cancellations, refunds, and credit.

## New Adopters

Evaluating or configuring a fork for your own club.

**Start here, in order:**

1. [`../README.md`](../README.md) — product scope, stack, and quick setup.
2. [`IMPLEMENTATION_GUIDE.md`](IMPLEMENTATION_GUIDE.md) — configure a fork for
   your own club.
3. [`../CONFIGURATION.md`](../CONFIGURATION.md) — the environment and
   `config/club.json` reference.
4. [`../DEPLOYMENT.md`](../DEPLOYMENT.md) — read before putting a shared or
   production environment online. (This file lives at the repository root, not
   in `docs/`.)
5. [`UPGRADING.md`](UPGRADING.md) — how to take downstream releases into your
   fork.

Then skim [Developers](#developers) for the architecture and [Operators](#operators)
for the runbooks you will use once you are live.

## Operators

Running a live club: admins, treasurers, and committee members.

**Start here:** [`../DEPLOYMENT.md`](../DEPLOYMENT.md) for bootstrap and
blue/green deployment, then the runbook for whatever you are doing.

Per-area, task-focused **operator guides** (with screenshots) were produced under
issue #2050 on the foundation this hub establishes, and now cover every admin
area. See [`COVERAGE_MATRIX.md`](COVERAGE_MATRIX.md) for the per-admin-area
index; every guide is linked below.

**Bookings & capacity guides** (batch 1 — the booking lifecycle, capacity/beds,
seasons, promos, and booking money):

- [Bookings](guides/bookings.md) — the master booking list, filters, and
  availability calendar.
- [Book on Behalf](guides/book.md) — create a booking for a member or
  non-member.
- [Booking Requests](guides/booking-requests.md) — approvals, locked-period
  change requests, and public (non-member) requests. (Also covers the
  `booking-approvals` and `booking-change-requests` routes, which redirect
  here.)
- [Booking Policies](guides/booking-policies.md) — cancellation refunds,
  date-specific periods, group discount, minimum stay, and public-request
  settings.
- [Booking Messages](guides/booking-messages.md) — member-facing booking,
  payment, and cancellation copy.
- [Bookings Setup](guides/bookings-setup.md) — the rooms/beds and booking-copy
  setup hub.
- [Seasons](guides/seasons.md) — season windows per lodge.
- [Age Groups](guides/age-tier-settings.md) — membership age tiers and their
  booking rules.
- [Promo Codes](guides/promo-codes.md) — discount codes and vouchers.
- [Bed Allocation](guides/bed-allocation.md) — the drag-and-drop bed board and
  per-lodge auto-allocation preferences.
- [Waitlist](guides/waitlist.md) — the waitlist queue and force-confirm.
- [Payments](guides/payments.md) — the booking-payment ledger and Xero invoice
  state.
- [Reports](guides/reports.md) — stay-night occupancy, booked revenue,
  payment-derived collected cash, outstanding additions, and member analytics.

**Membership & applications guides** (batch 2 — members, applications,
family/committee, the membership lifecycle, and membership billing):

- [Members](guides/members.md) — the member directory, login-readiness status,
  safe read-only opening, CSV import, roles, seasonal membership, and merge.
- [Member Applications](guides/member-applications.md) — the join/nomination
  review queue and how approval maps people to member records.
- [Member Fields](guides/member-fields.md) — which extra profile fields are
  collected from members and applicants.
- [Membership Types](guides/membership-types.md) — seasonal membership
  categories, their booking and subscription policy, and roll-forward.
- [Membership & Members setup](guides/membership-setup.md) — the setup hub for
  types, fields, and subscription lockout.
- [Subscription Lockout](guides/subscription-lockout.md) — the unpaid-subscription
  booking lockout, financial year, and Xero paid-detection.
- [Cancellation Requests](guides/membership-cancellations.md) — the membership
  cancellation and archive review queue, plus the cancellation copy/Xero
  settings.
- [Committee](guides/committee.md) — committee roles, assignments, and the
  public contact routing.
- [Family Groups](guides/family-groups.md) — households, the billing member, and
  the family-link request queue.
- [Family Suggestions](guides/family-suggestions.md) — auto-detected family
  groupings to confirm or dismiss.
- [Induction](guides/induction.md) — the induction register, sign-offs, and
  induction settings.
- [Trusted legacy induction baseline](INDUCTION_BASELINE_RUNBOOK.md) — the
  dry-run-first maintenance runbook for recording an authorised historical
  induction baseline.
- [Deletion Requests](guides/deletion-requests.md) — member self-service
  deletions and admin-initiated hard-delete review (two-admin rule).
- [Lockers](guides/lockers.md) — locker inventory and member allocation
  (lodge-scoped).
- [Fees](guides/fees.md) — the consolidated hut, joining, and annual fee console
  and family billing. (Also covers the `fee-configuration` route, which
  redirects here.)
- [Subscriptions](guides/subscriptions.md) — annual membership-fee billing,
  shared member Access status, permission-safe member links, family billing
  mode, and manual mark-paid.
- [Refunds & Credits](guides/refund-requests.md) — the refund-appeal and
  credit-approval review queue.
- [Internet Banking](guides/internet-banking.md) — bed holds and lead-time rules
  for Xero-invoiced bank-transfer payments.
- [Xero Sync](guides/xero.md) — the Xero connection, sync, reconciliation
  ledger, and records browser.

**Comms, content & support-platform guides** (batch 4 — outbound comms, public
content and appearance, and the platform/support admin surfaces):

- [Notifications & Email](guides/notifications.md) — the delivery-rules,
  recipients, email-messages, and message-copy hub.
- [Delivery Rules](guides/notification-rules.md) — which admin and system emails
  are sent when jobs or alerts run.
- [Recipients](guides/notification-recipients.md) — which system alerts each
  admin receives.
- [Email Messages](guides/email-messages.md) — shared email variables and the
  wording of audited email templates.
- [Communications](guides/communications.md) — admin bulk email to opted-in
  members.
- [Member Notices](guides/member-notices.md) — committee news notices targeted
  to member audiences, shown on the dashboard with read/acknowledge tracking.
- [Email Deliverability](guides/email-deliverability.md) — suppressions and
  exhausted delivery failures.
- [Site Appearance & Content](guides/appearance.md) — the content hub and club
  identity.
- [Site Style](guides/site-style.md) — public theme, logo, colours, and fonts.
- [Site Content](guides/site-content.md) — shared public site chrome and
  reusable text.
- [Page Content](guides/page-content.md) — public website pages, menus, rich
  text, and tokens.
- [Site Banners](guides/site-banners.md) — dated notice banners for visitors and
  members.
- [Mountain Conditions](guides/mountain-conditions.md) — the Whakapapa
  conditions cache and public widget.
- [Image Manager](guides/image-manager.md) — filesystem images for public
  content editors.
- [Admin Dashboard](guides/dashboard.md) — the attention cards, stat cards, and
  quick actions.
- [Access Roles](guides/access-roles.md) — custom admin roles and their
  permissions (Full Admin only).
- [Audit Log](guides/audit-log.md) — the searchable activity timeline.
- [System Health](guides/health.md) — service checks, system info, and webhooks.
- [Background Jobs](guides/background-jobs.md) — cron job health and run history.
- [Stuck States](guides/stuck-states.md) — the operator queue for stuck records.
- [Issue Reports](guides/issue-reports.md) — the member issue-report triage
  queue.
- [Modules](guides/modules.md) — the on/off panel for every optional feature.
- [Login & Security](guides/security.md) — password policy and sign-in methods.
- [Setup](guides/setup.md) — the installation checklist and configuration hub.
- [Integrations](guides/integrations.md) — connected services (Xero;
  feature-gated).
- [AI Help Assistant](guides/ai-help.md) — the in-app help widget and the
  optional paid AI assistant (module, key, spend cap, and privacy).
- [Export & Import](guides/config-transfer.md) — portable configuration/content
  bundles (Full Admin only).

**Lodge-operations guides** (batch 3 — physical-lodge day-to-day: rooms/beds,
chores, roster, work parties, hut leaders, the lodge kiosk/instructions,
multi-lodge management, and the lobby display):

- [Rooms & Beds](guides/rooms-beds.md) — the room/bed inventory and the capacity
  it derives (lodge-scoped).
- [Chore Templates](guides/chores.md) — the chore library the roster draws from
  (lodge-scoped).
- [Chore Roster](guides/roster.md) — the daily chore board: generate, confirm,
  print, and email.
- [Hut Leaders](guides/hut-leaders.md) — assigning on-site leaders for the nights
  that need cover, and their kiosk PINs.
- [Work Parties](guides/work-parties.md) — working-bee events and their automatic
  booking discount.
- [Events Calendar](guides/calendar.md) — the club events calendar, recurring
  events, per-instance vs series edits, MiroTalk video meetings, and the
  Events calendar module switch.
- [Lodge Kiosk](guides/lodge.md) — the shared lodge-tablet sign-in for check-in
  and lodge info.
- [Lodge Instructions](guides/lodge-instructions.md) — the protected opening,
  closing, and day-to-day documents.
- [Lodges](guides/lodges.md) — the lodge properties list and per-lodge
  configuration hub.
- [Lobby Display](guides/display.md) — pairing lobby screens and authoring the
  boards they show (the optional `lobbyDisplay` module).

The lobby TV display also keeps its own [feature hub](lobby-display/README.md)
(with the [operating guide](lobby-display/operating.md)) for the deeper design;
it is an optional module, off by default.

The operator guides now cover every admin area (all five #2050 batches have
shipped); the reference docs below remain the deep-detail layer beneath them —
reach for a guide for the task-focused walkthrough, and these for the underlying
policy, runbook, and architecture detail.

- [`../DEPLOYMENT.md`](../DEPLOYMENT.md) — bootstrap and blue/green deployment
  reference (repository root).
- [`UPGRADING.md`](UPGRADING.md) — downstream release upgrades for deployment
  forks.
- [`PRODUCTION_UPGRADE_RUNBOOK.md`](PRODUCTION_UPGRADE_RUNBOOK.md) — owner-driven
  runbook for upgrading a live deployment across a release (pre-flight backup,
  blue/green migrate, post-upgrade checklist, and rollback).
- [`BLUE_GREEN_MIGRATION_POLICY.md`](BLUE_GREEN_MIGRATION_POLICY.md) — how
  migrations must be structured for safe cutover, and the verification fixture a
  migration that rewrites existing club data must ship with it.
- [`CANCELLATIONS.md`](CANCELLATIONS.md) — membership cancellation refund,
  credit-note, and GST policy.
- [`AUTHORITATIVE_FEES.md`](AUTHORITATIVE_FEES.md) — membership/entrance fee
  schedules, public listing review, and family billing exceptions.
- [`AUDIT_RETENTION_ARCHIVE_RUNBOOK.md`](AUDIT_RETENTION_ARCHIVE_RUNBOOK.md) —
  audit-log retention and optional archival.
- [`TOKEN_HASHING.md`](TOKEN_HASHING.md) — the current hash-at-rest token design.
- [`XERO_MEMBER_GROUPING_RUNBOOK.md`](XERO_MEMBER_GROUPING_RUNBOOK.md) —
  operating the Xero member-grouping cutover.
- [`PUBLIC_PAGE_CONTENT_TOKENS.md`](PUBLIC_PAGE_CONTENT_TOKENS.md) — content
  editor/operator guide for publishing authoritative membership, fee, booking,
  and cancellation blocks.
- [`MAINTENANCE.md`](MAINTENANCE.md) — the public validation and release
  checklist, and the documented operator CLIs.
- [`STAGING_ACCESSIBILITY.md`](STAGING_ACCESSIBILITY.md) — non-production browser
  and Lighthouse checks.
- [`LOAD_TESTING.md`](LOAD_TESTING.md) — the k6 HTTP load harness in
  [`../load/`](../load/README.md), thresholds, and safety rails.

## Developers

- [Dataset Reset inventory](agents/DATASET_RESET_INVENTORY.md) - included admin/finance datasets, true defaults, preserved context, and exclusions.

Changing the code.

**Start here:** [`ARCHITECTURE.md`](ARCHITECTURE.md) for the runtime shape,
module boundaries, data model, integrations, cron jobs, and the mermaid maps.

**Domain and review map:**

- [`DOMAIN_INVARIANTS.md`](DOMAIN_INVARIANTS.md),
  [`STATE_MACHINES.md`](STATE_MACHINES.md),
  [`END_TO_END_TEST_MATRIX.md`](END_TO_END_TEST_MATRIX.md), and
  [`UX_FLOW_MAP.md`](UX_FLOW_MAP.md) — the domain and review map used by issue
  work.
- [`CONCURRENCY_AND_LOCKING.md`](CONCURRENCY_AND_LOCKING.md) — the advisory-lock
  families (capacity, credit, member-night, single-domain), what each protects,
  and the ordering disciplines. Read before changing any lock key or capacity/
  credit write path.
- [`CAPACITY_MODEL.md`](CAPACITY_MODEL.md) — how each lodge's bookable capacity
  is decided in every configuration.

**Testing, security, and workflow:**

- [`TESTING.md`](TESTING.md) — the Vitest unit harness: the frozen test clock
  (every run has a fixed "today"), how to write a date-bearing test, the counted
  opt-out, and the rollover canary. Read before adding any test that mentions a
  date.
- [`E2E_PLAYWRIGHT.md`](E2E_PLAYWRIGHT.md) — the Playwright browser E2E suite
  driving the Critical journeys against the staging compose stack.
- [`SECURITY-ATTACK-SURFACE.md`](SECURITY-ATTACK-SURFACE.md) and
  [`SECURITY.md`](SECURITY.md) — the attack-surface map and security notes
  (see also [`../SECURITY.md`](../SECURITY.md) for the disclosure policy).
- [`diagnostics/KNOWLEDGE_BUNDLE.md`](diagnostics/KNOWLEDGE_BUNDLE.md) — the
  deterministic, fail-closed deployed-code knowledge bundle (AID-3, #2372) that
  lets AI Diagnostics answer code/docs/schema questions from the running
  artifact, with cited-evidence retrieval and the deployment-owned overlay.
- [`ai-diagnostics/page-context.md`](ai-diagnostics/page-context.md) — the typed
  structured page context (AID-4, #2373): the untrusted selector, the route
  registry, the fresh permission-checked server re-fetch, the personal-detail
  opt-in, and the untrusted-evidence render.
- [`ai-diagnostics/tools.md`](ai-diagnostics/tools.md) — the SELECT-only tool
  substrate (AID-5, #2374): the server-owned typed registry with no model SQL, the
  ten fail-closed gates, per-invocation `area:view` re-checks, the row/byte/loop
  bounds, and the approved audit metadata.
- [`ai-diagnostics/tool-pack-support.md`](ai-diagnostics/tool-pack-support.md) — the
  support tool pack (AID-6A, #2375): the registered deployment, configuration,
  readiness, budget, background-job and audit-correlation tools, the permission each
  requires, the column-restricted `AuditLog` grant they argue for, the shared
  evidence-state and diagnostic-case contracts, and an operator troubleshooting table.
- [`ai-diagnostics/deployment.md`](ai-diagnostics/deployment.md) — the operator
  guide for AI Diagnostics: setup order, provisioning and rotating the dedicated
  non-superuser SELECT-only database role, what the role may read, and how to read the
  readiness endpoint.
- [`ONGOING_DEVELOPMENT_WORKFLOW.md`](ONGOING_DEVELOPMENT_WORKFLOW.md) — how
  generic public changes and private deployment-fork changes flow.
- [`STYLE_GUIDE.md`](STYLE_GUIDE.md) — documentation style, the operator-guide
  skeleton, and screenshot/mermaid/linking conventions. Follow it whenever you
  add or change docs.
- [`COVERAGE_MATRIX.md`](COVERAGE_MATRIX.md) — every admin route area mapped to
  its documentation or gap.
- [`../CONTRIBUTING.md`](../CONTRIBUTING.md) — validation commands and the
  dead-code (knip) gate.

**Authoritative in-code references:** the TypeScript registry in
[`../src/lib/email-message-registry.ts`](../src/lib/email-message-registry.ts)
is the catalogue of admin-editable outbound email templates, approved tokens,
and subject/body safety rules.

## Agents

Automated coding agents working in this repository.

**Start here:** [`../AGENTS.md`](../AGENTS.md) — the agent contract and the
source of truth. [`../CLAUDE.md`](../CLAUDE.md) highlights the parts that matter
most for an interactive Claude Code session.

- [`agents/CODEX_WORKFLOW.md`](agents/CODEX_WORKFLOW.md) — the operating guide for
  Codex agents.
- [`agents/ISSUE_WORKFLOW.md`](agents/ISSUE_WORKFLOW.md) — issue contracts.
- [`agents/CODEX_PROMPTS.md`](agents/CODEX_PROMPTS.md) — invocation prompts.
- [`agents/PROFILE_GUIDE.md`](agents/PROFILE_GUIDE.md) — execution profiles.
- [`agents/SUBAGENT_GUIDE.md`](agents/SUBAGENT_GUIDE.md) — subagent use.
- [`agents/REVIEW_SEVERITY.md`](agents/REVIEW_SEVERITY.md) — review severity.
- [`agents/PROMPT_INJECTION_GUIDE.md`](agents/PROMPT_INJECTION_GUIDE.md) —
  prompt-injection handling.

---

## Feature hubs

Larger subsystems keep their own hub. Each links back to this page.

- **Finance dashboard** — reporting contracts, architecture decisions, data
  contracts, and test plan. Start with
  [`finance-dashboard/README.md`](finance-dashboard/README.md).
- **Multi-lodge support** — design, scoping contract, implementation plan, and
  test plan for more than one lodge property. Start with
  [`multi-lodge/README.md`](multi-lodge/README.md).
- **Lobby display** — the lobby/kiosk display subsystem brief, design, and
  operating guide. Start with [`lobby-display/README.md`](lobby-display/README.md).
- **Operational Xero** — module map, reconciliation-ledger data model, and
  sequence diagrams for the outbound, inbound, and repair flows. Start with
  [`xero/ARCHITECTURE.md`](xero/ARCHITECTURE.md).
- **Configuration export & import (planned)** — decision records for the
  portable configuration/content/lodge-setup tool. Start with
  [`config-transfer/README.md`](config-transfer/README.md).
- **Exclusive whole-lodge hold (design)** —
  [`exclusive-booking/decisions/ADR-001-exclusive-whole-lodge-hold.md`](exclusive-booking/decisions/ADR-001-exclusive-whole-lodge-hold.md).
- **AI Diagnostics (design/foundation)** — the admin-only, read-only diagnostics
  assistant's security, privacy, authority, and evidence contracts: ADRs, the
  STRIDE threat model, the permission matrix, and the documentation plan. Start
  with [`ai-diagnostics/README.md`](ai-diagnostics/README.md). Separate from the
  member-facing [AI Help Assistant](guides/ai-help.md).

## Release notes

Per-release notes and the owner-review communication drafts are indexed in
[`releases/README.md`](releases/README.md) (newest first — currently
[`releases/v0.13.2.md`](releases/v0.13.2.md)).
