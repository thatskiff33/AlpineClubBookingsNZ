# Xero API Audit and Reduction Plan

Date: 2026-04-13

## Progress Update

Last updated: 2026-04-14

Completed in this pass:

- Added Phase 0 feature flags in `src/lib/xero-feature-flags.ts` and documented them in `.env.example`:
  - `XERO_ENABLE_DAILY_MEMBERSHIP_REFRESH`
  - `XERO_ENABLE_LIVE_MEMBER_GROUP_LOOKUPS`
  - `XERO_ENABLE_AUTOLOAD_XERO_CONTACT_GROUPS`
- Disabled the scheduled 2 AM membership refresh by default in `src/instrumentation.ts`.
- Gated `/api/cron/xero` membership refresh execution behind `XERO_ENABLE_DAILY_MEMBERSHIP_REFRESH`, while leaving explicit manual membership sync tooling untouched.
- Removed automatic contact-group loading from `src/app/(admin)/admin/members/page.tsx` unless both member-group feature flags are enabled.
- Stopped live Xero contact-group enrichment and live Xero contact-group filtering in:
  - `src/app/api/admin/members/route.ts`
  - `src/app/api/admin/members/[id]/route.ts`
  when `XERO_ENABLE_LIVE_MEMBER_GROUP_LOOKUPS` is off.
- Added temporary UI fallback states on the admin members list and member detail pages so linked members show a local-only "groups not loaded" state instead of triggering live Xero reads.
- Added test coverage for the default-off behavior and the flag-enabled paths:
  - `src/lib/__tests__/xero-cron-route.test.ts`
  - `src/lib/__tests__/xero-member-management.test.ts`
  - `src/lib/__tests__/phase3-admin-members.test.ts`
- Added persisted Phase 1 Xero API metering models plus migration:
  - `XeroApiUsageDaily`
  - `XeroApiUsageEvent`
  in `prisma/schema.prisma` and `prisma/migrations/20260414113000_add_xero_api_usage_metering/`.
- Added `src/lib/xero-api-usage.ts` to:
  - persist one usage event per metered Xero SDK call
  - maintain daily aggregate counters
  - compute rolling 24-hour hotspots and recent failures for the admin dashboard
  - apply 70/85/95 percent budget thresholds against the 1000-calls-per-day budget.
- Added `callXeroApi()` in `src/lib/xero.ts` as the shared metered wrapper layered on top of `withXeroRetry()`, including rate-limit-category capture from retried calls.
- Routed all current non-test Xero SDK call sites through the shared metered wrapper, including:
  - `src/lib/xero.ts`
  - `src/lib/xero-inbound-reconciliation.ts`
  - `src/app/api/admin/xero/chart-of-accounts/route.ts`
  - `src/app/api/admin/xero/items/route.ts`
  - `src/app/api/admin/xero/search-contacts/route.ts`
  - `src/app/api/admin/members/[id]/xero-link/route.ts`
- Added `GET /api/admin/xero/usage` in `src/app/api/admin/xero/usage/route.ts`.
- Added a new Xero API Budget panel to `src/app/(admin)/admin/xero/page.tsx` showing:
  - calls today versus the daily budget
  - success/failure counts
  - rate-limit hits
  - rolling 24-hour top operations
  - rolling 24-hour top workflows
  - recent failed Xero calls
  - a manual refresh action for the dashboard.
- Added targeted test coverage for the new metering and summary logic:
  - `src/lib/__tests__/xero.test.ts`
  - `src/lib/__tests__/xero-api-usage.test.ts`
- Added operator-facing stored inbound event inspection and targeted replay:
  - `GET /api/admin/xero/inbound-events`
  - `POST /api/admin/xero/inbound-events/[id]/replay`
  - inbound events panel on `src/app/(admin)/admin/xero/page.tsx`
- Extended `src/lib/xero-inbound-reconciliation.ts` so a single stored inbound event can be replayed safely by:
  - clearing the previous dedupe claim in `ProcessedWebhookEvent`
  - resetting the selected `XeroInboundEvent` row back to `RECEIVED`
  - reprocessing only the targeted event ID through the existing worker path
- Added targeted replay and admin-route coverage in:
  - `src/lib/__tests__/xero-inbound-reconciliation.test.ts`
  - `src/lib/__tests__/xero-inbound-events-routes.test.ts`
- Added Phase 6 field-diff logic for TAC-to-Xero contact sync so local-only or no-op member edits stop emitting unnecessary Xero writes:
  - new shared helper `src/lib/xero-contact-sync.ts`
  - admin member edits now skip `updateXeroContact()` unless Xero-mapped fields actually changed in `src/app/api/admin/members/[id]/route.ts`
  - profile edits now skip `updateXeroContact()` when the stored Xero payload is unchanged in `src/app/api/profile/route.ts`
  - email-change confirmation now reuses the shared Xero contact payload builder in `src/app/api/auth/confirm-email-change/route.ts`
- Added the next Phase 6 write-path reduction in `src/lib/xero.ts`:
  - `findOrCreateXeroContact()` now trusts an existing `member.xeroContactId` on steady-state write paths instead of issuing a `getContact()` verification read first
  - explicit repair/relookup mode can now re-search by email and relink a stale member contact when retry/replay flows opt in
  - Xero operation retries now opt into that repair path for booking invoices, refund credit notes, supplementary invoices, modification credit notes, and entrance-fee invoices in `src/lib/xero-operation-retry.ts`
- Completed the remaining Phase 6 inline repair step in `src/lib/xero.ts`:
  - added shared stale-contact detection plus one-shot relink/retry when Xero returns a contact not-found / invalid-reference error
  - first-pass steady-state writes now auto-repair and retry for:
    - `updateXeroContact()`
    - `createXeroInvoiceForBooking()`
    - `createXeroCreditNote()`
    - `createUnappliedXeroCreditNote()`
    - `createXeroSupplementaryInvoice()`
    - `createXeroCreditNoteForModification()`
    - `createXeroEntranceFeeInvoice()`
  - when a repair changes the contact ID mid-flight, the running `XeroSyncOperation` request payload is updated before the retry so reconciliation history reflects the repaired write target
- Added targeted test coverage for the Phase 6 write-overhead reduction:
  - `src/lib/__tests__/xero-contact-sync.test.ts`
  - `src/lib/__tests__/phase3b-member-detail-edit.test.ts`
  - `src/lib/__tests__/phone-address-sync.test.ts`
  - `src/lib/__tests__/xero-find-or-create-contact.test.ts`
  - updated retry expectations in `src/lib/__tests__/xero-operation-retry.test.ts`
- Added focused helper coverage for the inline repair path in `src/lib/__tests__/xero.test.ts`.
- Expanded Phase 7 inbound reconciliation beyond contact and invoice events:
  - added `PAYMENT` webhook reconciliation in `src/lib/xero-inbound-reconciliation.ts` to restore payment links, refresh linked invoice metadata, and refresh linked subscriptions
  - added `CREDIT_NOTE` webhook reconciliation in `src/lib/xero-inbound-reconciliation.ts` to restore refund-credit-note links, allocation links, and refund payment links
  - added record-scoped inbound-event loading and replay controls in `src/lib/xero-record-activity.ts`, `src/lib/xero-record-types.ts`, and `src/components/admin/xero-record-activity-panel.tsx`
- Added targeted test coverage for the broader inbound reconciliation and record activity surface:
  - `src/lib/__tests__/xero-inbound-reconciliation.test.ts`
  - `src/lib/__tests__/xero-record-activity.test.ts`

Work remaining after this pass:

- Phase 2: incremental invoice sync to replace full daily membership polling.
- Phase 3: local cache tables for Xero contact groups and memberships so member pages and filters can stay local-only without the temporary "not loaded" fallback.
- Phase 4: incremental contact sync and group import so default admin syncs stop doing full scans plus per-contact invoice lookups.
- Phase 6 still remaining:
  - add a durable local claim/outbox so invoice and credit-note writes do not get re-attempted from multiple booking/payment trigger paths
  - reduce duplicate write attempts across booking creation, confirm-draft, waitlist confirmation, saved-card charging, Stripe webhooks, and pending-confirmation cron
- Phase 7 still remaining:
  - webhook-driven targeted updates for any remaining local business state that is not yet advanced from inbound events
  - cached contact-group membership refresh driven from inbound changes where applicable
  - reducing daily polling to a safety net rather than the primary reconciliation path
- Phase 8: durable shared cache for chart-of-accounts and items remains unstarted.

## Goal

Reduce TACBookings' Xero API usage so normal operation stays comfortably below the 1000-calls-per-day limit, while also making Xero sync more reliable, more incremental, and less dependent on full scans.

This plan is intentionally implementation-oriented so it can be handed to Codex phase by phase.

## Executive Summary

The current codebase still mixes three expensive patterns:

- full-scan jobs that read Xero contact or invoice data for every relevant record
- live admin/UI enrichment that calls Xero during normal page loads
- write flows that do extra validation reads or can be triggered from multiple entry points

The single biggest likely budget consumer is the daily membership refresh:

- `src/instrumentation.ts:108-148`
- `src/lib/xero.ts:1989-2301`

That path does at least one `getInvoices` call per linked member, plus another `getOnlineInvoice` call when a subscription invoice is found. With roughly 410 linked members, one daily run can plausibly cost about 410 to 820 Xero calls by itself.

The next biggest sources are:

- live Xero group loading on admin member pages
- full contact sync/import flows that also fetch first-invoice dates per contact
- duplicate-contact scanning that re-reads invoices per duplicate contact
- extra `getContact` verification reads on normal write paths via `findOrCreateXeroContact()`

If those flows happen on the same day as the membership refresh, hitting 1000 is expected even before the system is fully live.

## Confirmed Hotspots

### 1. Daily membership refresh is still an O(member-count) polling job

Files:

- `src/instrumentation.ts:108-148`
- `src/app/api/cron/xero/route.ts:36-44`
- `src/lib/xero.ts:1989-2301`

Current behavior:

- `refreshAllMembershipStatuses()` fetches all active members with `xeroContactId`.
- It loops every member and calls `checkMembershipStatus()`.
- `checkMembershipStatus()` calls `getInvoices(...)` for that contact and season.
- When a matching subscription invoice is found, it also calls `getOnlineInvoice(...)`.

Why this is expensive:

- Approximate cost for 410 linked members is about 410 `getInvoices` calls plus up to 410 `getOnlineInvoice` calls.
- This is a "check everything every day" approach rather than "check what changed."

### 2. Admin member pages make live Xero reads during ordinary browsing

Files:

- `src/app/(admin)/admin/members/page.tsx:158-175`
- `src/app/(admin)/admin/members/page.tsx:188-205`
- `src/app/api/admin/members/route.ts:207-223`
- `src/app/api/admin/members/route.ts:283-299`
- `src/app/api/admin/members/[id]/route.ts:189-207`
- `src/lib/xero.ts:1159-1247`

Current behavior:

- Visiting `/admin/members` auto-loads `/api/admin/xero/contact-groups`.
- The members list API fetches live Xero contact-group memberships for the linked contacts on the current page.
- The member detail API fetches live Xero contact-group memberships for that one member.
- Filtering members by Xero group also hits Xero live.

Why this is expensive:

- Normal admin browsing consumes Xero budget.
- `getXeroContactGroups()` does an N+1 pattern: one group list call, then one detail call per group to get counts.
- Each members list fetch can trigger another `getContacts(ids...)` batch call to populate group memberships.

Important note:

- "Load Contact Groups from Xero" on `/admin/xero` is not the only source here.
- The members admin page already loads contact-group data automatically on mount.

### 3. Contact sync/import are still full-scan flows with per-contact invoice lookups

Files:

- `src/lib/xero.ts:939-1149`
- `src/lib/xero.ts:1493-1859`
- `src/lib/xero.ts:797-832`
- `src/app/api/admin/xero/sync-contacts/route.ts:24-26`
- `src/app/api/admin/xero/import-members/route.ts:49-56`

Current behavior:

- `syncContactsFromXero()` paginates through all contacts.
- For contacts missing `joinedDate`, it calls `getContactFirstInvoiceDate()`, which does a per-contact invoice query.
- `importMembersFromXeroGroups()` fetches group detail, fetches full contact details in batches, and also fetches first invoice dates per contact when backfilling `joinedDate`.

Why this is expensive:

- A full contact sync of about 410 contacts is already about 5 contact-page reads.
- If many records are missing `joinedDate`, that same run can add up to about 410 invoice queries.
- The joined-date backfill is coupled to the main contact sync, which turns a reasonable sync into a very expensive one.

### 4. Duplicate scan is a manual tool, but it is still a very heavy full-read workflow

Files:

- `src/lib/xero.ts:3912-4165`
- `src/app/api/admin/xero/duplicate-contacts/route.ts:23-25`

Current behavior:

- Reads all Xero contacts.
- Groups them by email.
- For every duplicate contact, fetches invoice data to decide whether invoices exist and how many.

Why this is expensive:

- Full contact scan plus per-duplicate invoice reads.
- Invoice counting can be one to two extra Xero calls per duplicate contact.

This is acceptable as a rare, explicit admin tool, but not as a default or frequent workflow.

### 5. Normal write flows do extra contact-validation reads

Files:

- `src/lib/xero.ts:547-687`
- `src/lib/xero.ts:2589-2838`
- `src/lib/xero.ts:2852-3117`
- `src/lib/xero.ts:3345-3543`
- `src/lib/xero.ts:3551-3743`
- `src/lib/xero.ts:3760-3878`

Current behavior:

- `findOrCreateXeroContact()` checks `member.xeroContactId`.
- If a local Xero contact ID exists, it still calls `getContact()` to verify the contact exists before proceeding.
- That helper is called from booking invoice creation, refund credit notes, supplementary invoices, modification credit notes, and entrance fee invoices.

Why this is expensive:

- A normal write often starts with a read that should usually be avoidable.
- In steady state, linked contacts should be trusted locally and repaired only on explicit drift or on a Xero-side "not found" failure.

### 6. Some member updates send Xero writes even when only local-only fields changed

Files:

- `src/app/api/admin/members/[id]/route.ts:412-445`
- `src/app/api/profile/route.ts:159-191`

Current behavior:

- If a linked member is updated, the route sends `updateXeroContact(...)`.
- The admin route does this even when the changed fields may be local-only, such as `role`, `active`, `canLogin`, `forcePasswordChange`, or email inheritance metadata.

Why this is expensive:

- It creates unnecessary Xero writes for edits that do not matter to Xero.

### 7. Booking/payment write triggers come from several entry points

Files:

- `src/app/api/bookings/route.ts:745-778`
- `src/app/api/bookings/[id]/confirm-draft/route.ts`
- `src/app/api/bookings/[id]/waitlist-confirm/route.ts`
- `src/app/api/payments/charge-saved-method/route.ts:178-195`
- `src/app/api/webhooks/stripe/route.ts:249-264`
- `src/lib/cron-confirm-pending.ts:123-135`
- `src/lib/cron-confirm-pending.ts:200-213`

Current behavior:

- The same logical booking invoice creation can be triggered by synchronous request handlers, Stripe webhook handling, and cron-based confirmation flows.
- Idempotency keys reduce duplicate artifacts, but duplicate attempts can still consume Xero calls.

Why this is expensive:

- Duplicate trigger paths are not the biggest current problem, but they are a real source of avoidable call volume and retry noise.

### 8. Account/item caches are only in-memory

Files:

- `src/app/(admin)/admin/xero/page.tsx:333-367`
- `src/app/api/admin/xero/chart-of-accounts/route.ts:27-50`
- `src/app/api/admin/xero/items/route.ts:26-49`
- `src/lib/xero-admin-cache.ts`

Current behavior:

- `/admin/xero` auto-fetches chart of accounts and items when connected.
- Those endpoints use a one-hour in-memory cache only.

Why this matters:

- This is lower priority than the other hotspots.
- It still causes repeated Xero reads on restarts, multiple processes, or multiple app instances.

## What Is Not the Main Problem

These are not the priority call-budget issues right now:

- `GET /api/admin/xero/status` reads local token state only.
- Xero operations/history pages mostly read local reconciliation tables.
- Search contacts is on-demand and bounded to 20 results.
- Booking/refund write flows are meaningful business writes; the problem there is overhead and duplicate triggers, not the existence of the writes themselves.

## Design Principles For The Fix

- No admin list or detail page should require live Xero reads to render normal state.
- Default jobs must be incremental. Full scans should be explicit repair tools.
- A sync that enriches local data should not also do unrelated backfills in the same pass.
- Every Xero SDK call should go through one metered wrapper so call volume is visible by operation.
- Webhooks and cursors should drive reconciliation; per-member polling should be the exception.
- A linked Xero object should be trusted locally until Xero proves otherwise.

## Phased Build Plan

### Phase 0: Stop The Bleeding

Status:

- Completed on 2026-04-14 for the default-off gates and UI fallback state.
- Remaining related structural work is intentionally deferred to Phase 3, where the temporary "not loaded" state will be replaced by durable local cache tables.

Goal:

- Cut the biggest avoidable reads immediately before doing structural work.

Implementation steps:

- Add feature flags for the expensive read paths:
  - `XERO_ENABLE_DAILY_MEMBERSHIP_REFRESH`
  - `XERO_ENABLE_LIVE_MEMBER_GROUP_LOOKUPS`
  - `XERO_ENABLE_AUTOLOAD_XERO_CONTACT_GROUPS`
- Disable the daily membership refresh by default until Phase 2 lands.
- Remove automatic `/api/admin/xero/contact-groups` loading from `src/app/(admin)/admin/members/page.tsx`.
- Stop live Xero group enrichment in:
  - `src/app/api/admin/members/route.ts`
  - `src/app/api/admin/members/[id]/route.ts`
- Temporarily show one of:
  - cached/local group data if available
  - "not loaded" / "refresh from Xero" state

Acceptance criteria:

- Opening `/admin/members` makes zero live Xero calls by default.
- Opening member detail makes zero live Xero calls by default.
- The 2 AM membership cron can be disabled without code surgery.

Primary files:

- `src/instrumentation.ts`
- `src/app/(admin)/admin/members/page.tsx`
- `src/app/api/admin/members/route.ts`
- `src/app/api/admin/members/[id]/route.ts`

### Phase 1: Add Xero Call Metering And A Daily Budget Dashboard

Status:

- Completed on 2026-04-14.
- Shared metering now persists per-call events and daily aggregates locally.
- `/admin/xero` now has a budget panel backed by local data plus rolling 24-hour hotspot/failure summaries.
- All current non-test Xero SDK call sites are routed through `callXeroApi()` on top of `withXeroRetry()`.

Goal:

- Make call usage measurable before deeper refactors.

Implementation steps:

- Create a single wrapper around all Xero SDK calls, layered on top of `withXeroRetry()`.
- Record at least:
  - date
  - operation name
  - Xero resource type
  - success/failure
  - rate-limit category if present
- Persist counts in the database, not only in logs.
- Add a budget panel on `/admin/xero` showing:
  - calls today
  - calls by operation
  - top expensive workflows
  - last daily-limit event
- Add warning thresholds at 70 percent, 85 percent, and 95 percent of daily budget.

Suggested schema additions:

- `XeroApiUsageDaily`
- `XeroApiUsageEvent` or a lighter-weight aggregate model

Acceptance criteria:

- We can answer "what burned the last 24 hours of Xero budget" from local data.
- Every Xero call site is routed through the shared metered wrapper.

Primary files:

- `prisma/schema.prisma`
- `src/lib/xero.ts`
- `src/app/(admin)/admin/xero/page.tsx`
- new helper such as `src/lib/xero-api-usage.ts`

### Phase 2: Replace Full Membership Polling With Incremental Invoice Sync

Goal:

- Remove the O(member-count) daily membership refresh.

Implementation steps:

- Introduce a durable sync cursor model, for example `XeroSyncCursor`, keyed by resource and scope.
- Replace `refreshAllMembershipStatuses()` with a job that reads only invoices changed since the last successful cursor using `ifModifiedSince`.
- Scope the invoice query to the relevant subscription date window instead of all members.
- Map changed invoices back to local members via `Contact.ContactID -> Member.xeroContactId`.
- Update only affected `MemberSubscription` rows.
- Fetch `getOnlineInvoice(...)` only when:
  - a matching subscription invoice is first discovered
  - the invoice changed
  - or an explicit repair action asks for it
- Update `/api/member/subscription-status` to remain local-read-only during normal page loads.

Suggested interim fallback before full webhook support:

- If incremental invoice sync is not ready, limit the daily job to stale rows only, such as:
  - unpaid/overdue subscriptions
  - rows missing `xeroOnlineInvoiceUrl`
  - rows not checked in N days

Acceptance criteria:

- The daily membership job no longer calls Xero once per linked member.
- A "no changes since last sync" day costs only a small, bounded number of calls.
- Member booking page loads do not trigger Xero reads.

Primary files:

- `src/lib/xero.ts`
- `src/instrumentation.ts`
- `src/app/api/cron/xero/route.ts`
- `src/app/api/member/subscription-status/route.ts`
- `src/app/(authenticated)/book/page.tsx`
- `prisma/schema.prisma`

### Phase 3: Move Contact Groups And Group Memberships To Local Cache Tables

Goal:

- Remove live contact-group reads from normal admin usage.

Implementation steps:

- Add local cache tables for:
  - Xero contact groups
  - Xero contact-group membership by contact ID
- Change `/api/admin/xero/contact-groups` to read local cache by default.
- Add an explicit "Refresh from Xero" admin action that updates the cache.
- Stop calling `getXeroContactGroupMemberships()` from member list/detail APIs.
- Make the Xero group filter in `/api/admin/members` use local cached membership rows.
- Derive group counts locally from cached memberships instead of calling `getContactGroup()` per group on each load.

Suggested schema additions:

- `XeroContactGroupCache`
- `XeroContactGroupMembershipCache`
- or equivalent names

Acceptance criteria:

- `/admin/members` and `/admin/members/[id]` are local-only for Xero group display.
- `/api/admin/xero/contact-groups` can serve cached data without hitting Xero.
- Group counts no longer require N+1 Xero calls.

Primary files:

- `prisma/schema.prisma`
- `src/lib/xero.ts`
- `src/app/api/admin/xero/contact-groups/route.ts`
- `src/app/api/admin/members/route.ts`
- `src/app/api/admin/members/[id]/route.ts`
- `src/app/(admin)/admin/members/page.tsx`
- `src/app/(admin)/admin/xero/page.tsx`

### Phase 4: Make Contact Sync And Group Import Incremental

Goal:

- Convert bulk contact workflows from "read everything" to "read changes."

Implementation steps:

- Add a contact sync cursor and use `ifModifiedSince` in `syncContactsFromXero()`.
- Persist the Xero-side `updatedDateUTC` or equivalent sync marker locally.
- Split "joined date from first invoice" into a separate repair/backfill job.
- Make the default contact sync update only:
  - new links
  - changed phone/address/email-derived fields
  - other explicit mapped fields
- Rework `importMembersFromXeroGroups()` so it uses cached group membership and cached contact snapshots when available.
- Keep "full rescan" as an explicit admin repair tool with a cost estimate and confirmation step.

Acceptance criteria:

- A second contact sync with no upstream changes is cheap.
- Mainline contact sync no longer does one invoice lookup per contact.
- Group import can run without re-fetching full live Xero data for every contact every time.

Primary files:

- `src/lib/xero.ts`
- `src/app/api/admin/xero/sync-contacts/route.ts`
- `src/app/api/admin/xero/import-members/route.ts`
- `src/app/(admin)/admin/xero/page.tsx`
- `prisma/schema.prisma`

### Phase 5: Make Duplicate Scan Cheap By Default

Goal:

- Keep the feature, but remove its dependence on live full scans plus per-contact invoice reads.

Implementation steps:

- Build duplicate detection from the local Xero contact mirror/cache.
- Remove per-contact live invoice counting from the initial scan.
- Replace invoice counts with one of:
  - local linked-financial-object counts from `XeroObjectLink`
  - lazy on-demand detail loading for one duplicate group
  - or a simpler "has linked local Xero financial artifacts" indicator
- Keep a manual deep-inspection option if operators truly need live Xero counts.

Acceptance criteria:

- Initial duplicate scan is local-only.
- Any live Xero reads are opt-in and scoped to a single group, not the whole result set.

Primary files:

- `src/lib/xero.ts`
- `src/app/api/admin/xero/duplicate-contacts/route.ts`
- `src/app/(admin)/admin/xero/page.tsx`

### Phase 6: Trim Write-Path Overhead And Remove Duplicate Trigger Attempts

Status:

- Partially implemented.
- The field-diff portion is now in place for member/profile contact sync, so unchanged or local-only edits stop emitting unnecessary Xero contact updates.
- Steady-state write paths now trust an existing `member.xeroContactId` without a `getContact()` preflight read, retry/replay flows can explicitly relink stale contacts before recreating invoices or credit notes, and the initial steady-state write now auto-repairs once when Xero rejects a stale contact reference.
- The remaining work in this phase is now the durable claim/outbox and duplicate-trigger consolidation for invoice and credit-note creation paths.

Goal:

- Keep necessary writes, but remove avoidable reads and duplicate attempts.

Implementation steps:

- `findOrCreateXeroContact()` now trusts an existing `member.xeroContactId` by default on normal write paths.
- `getContact()` preflight verification has now been removed from the normal write paths that rely on `findOrCreateXeroContact()`.
- Retry/replay flows can now run an explicit relink pass before recreating invoice and credit-note writes.
- Initial steady-state writes now also run an inline one-shot relink/retry when Xero returns a not-found / invalid-reference contact error.
- Add field-diff logic before `updateXeroContact()`:
  - only sync when Xero-mapped fields changed
  - skip when only local-only fields changed
- Add a durable local claim/outbox for invoice/credit-note creation so the same local event is not attempted from multiple handlers at once.
- Review duplicate trigger sources across:
  - booking creation
  - confirm-draft
  - waitlist confirmation
  - saved-card charging
  - Stripe webhooks
  - pending-confirmation cron

Acceptance criteria:

- A normal booking invoice or refund write does not start with an avoidable `getContact()` read.
- A stale `member.xeroContactId` self-heals on the first steady-state write attempt instead of waiting for an operator-triggered retry.
- Editing member-local fields does not produce Xero writes.
- Booking/payment Xero writes have one primary execution path and durable local claim semantics.

Primary files:

- `src/lib/xero.ts`
- `src/lib/xero-operation-retry.ts`
- `src/app/api/admin/members/[id]/route.ts`
- `src/app/api/profile/route.ts`
- booking/payment/webhook routes listed in the hotspot section

### Phase 7: Turn Xero Webhooks Into The Main Reconciliation Trigger

Status:

- Partially implemented.
- Current supporting pieces now include:
  - stored `XeroInboundEvent` persistence
  - claim / dedupe before handler execution
  - webhook-driven linked contact, invoice, payment, and credit-note reconciliation handlers
  - operator-facing inbound-event inspection and single-event replay from `/admin/xero`
  - record-scoped inbound-event visibility and replay from the Xero record activity panels
- This phase is still incomplete because webhook-driven reconciliation is not yet the main source of truth for the remaining affected business state, and daily polling has not yet been reduced to a pure safety net.

Goal:

- Shift from polling to targeted reconcile.

Implementation steps:

- Extend `XeroInboundEvent` processing beyond logging.
- Claim and dedupe inbound events before handling.
- Enqueue targeted jobs for:
  - contact updates
  - invoice updates
  - payment updates if relevant
- Reconcile only the affected local records from the webhook resource IDs.
- Use webhook-triggered reconcile to advance:
  - subscription status updates
  - contact field refresh
  - cached contact-group membership refresh where applicable

Acceptance criteria:

- Xero webhook events trigger local targeted reconciliation.
- Daily polling is reduced to a safety net, not the primary source of truth.

Primary files:

- `src/app/api/webhooks/xero/route.ts`
- `src/lib/xero-sync.ts`
- `src/lib/xero.ts`
- `src/app/api/cron/xero/route.ts`
- `prisma/schema.prisma`

### Phase 8: Finish The Remaining Low-Priority Read Paths

Goal:

- Clean up the remaining smaller sources of avoidable Xero reads.

Implementation steps:

- Move chart-of-accounts and items caching to a durable shared cache if the deployment is multi-process or multi-instance.
- Route those endpoints through the shared metered Xero wrapper.
- Add manual refresh controls and last-refreshed timestamps to `/admin/xero`.
- Review any remaining direct SDK calls that are not using the shared wrapper and cursor/cache strategy.

Acceptance criteria:

- Account/item lookups are cheap across restarts and deployments.
- No direct Xero SDK call remains outside the metered wrapper without a documented reason.

Primary files:

- `src/lib/xero-admin-cache.ts`
- `src/app/api/admin/xero/chart-of-accounts/route.ts`
- `src/app/api/admin/xero/items/route.ts`
- `src/app/(admin)/admin/xero/page.tsx`

## Recommended Execution Order

Build in this order:

1. Phase 0
2. Phase 1
3. Phase 2
4. Phase 3
5. Phase 4
6. Phase 5
7. Phase 6
8. Phase 7
9. Phase 8

Rationale:

- Phase 0 and Phase 2 produce the fastest budget relief.
- Phase 1 makes the rest measurable.
- Phase 3 and Phase 4 remove the major full-scan admin workflows.
- Phase 6 and Phase 7 improve steady-state efficiency and correctness.

## Suggested Test And Verification Checklist

- Add unit tests that assert no Xero call is made when:
  - `/api/admin/members` is served from local cache
  - `/api/admin/members/[id]` is served from local cache
  - member-local-only fields are updated
- Add sync tests that assert:
  - delta contact sync performs minimal calls on a second run
  - delta membership sync performs minimal calls when nothing changed
- Add integration tests for:
  - webhook-driven targeted membership updates
  - group-cache refresh and members-page rendering from cache
  - duplicate scan from local cache
- Add admin-visible reporting for:
  - calls today
  - calls by feature
  - last full scan time
  - last delta cursor time

## Immediate Recommendation Before Any Other Xero Work

If the goal is to stop hitting the 1000/day limit as soon as possible, do these first:

1. Disable the scheduled full membership refresh.
2. Remove live Xero group reads from the members list and member detail pages.
3. Stop auto-loading Xero contact groups on `/admin/members`.
4. Add call metering so the next day of usage confirms the drop.

Those four changes should materially reduce call volume before the deeper incremental-sync work starts.
