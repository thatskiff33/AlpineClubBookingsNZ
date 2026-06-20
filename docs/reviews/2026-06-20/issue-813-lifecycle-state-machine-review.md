# Issue #813 Lifecycle State-Machine Review

Date: 2026-06-20

Mode: review-only planning task. No application code was edited, no live
providers or production data were used, no broad tests or browser automation were
run, and no follow-up issues were created.

## Scope Reviewed

Reviewed the documented and implemented lifecycle/state-machine boundaries for:

- Booking creation, draft expiry, payment confirmation, completion, deletion,
  modification, and cancellation.
- Payment, payment transaction, refund, credit, payment recovery, and payment
  link state.
- Waitlist offer, expiry, confirmation, admin force-confirm, and waitlist admin
  visibility.
- Bed allocation reconciliation and allocatable-status ownership.
- Membership application, nomination, approval/rejection, entrance-fee/Xero
  side effects, and induction setup.
- Membership cancellation requests, participant confirmation, admin approval,
  request completion, and Xero cancellation touchpoints.
- Member archive/delete lifecycle requests and blockers.
- Family/dependent join, child, adult, removal, and profile-confirmation flows.
- Cron and recovery jobs that can change booking/payment/membership state.
- Xero, Stripe, and email touchpoints only where they affect the above states.

## Files/Directories Inspected

Required policy and context:

- `AGENTS.md`
- `README.md`
- `CONFIGURATION.md`
- `docs/README.md`
- `docs/ARCHITECTURE.md`
- `docs/agents/CODEX_WORKFLOW.md`
- `docs/agents/ISSUE_WORKFLOW.md`
- `docs/agents/PROMPT_INJECTION_GUIDE.md`
- `docs/agents/REVIEW_SEVERITY.md`
- `docs/DOMAIN_INVARIANTS.md`
- `docs/STATE_MACHINES.md`
- `docs/END_TO_END_TEST_MATRIX.md`
- `docs/UX_FLOW_MAP.md`
- `docs/MAINTENANCE.md`
- `docs/reviews/2026-06-20/REVIEW_ISSUE_BACKLOG.md`
- `docs/reviews/2026-06-20/ISSUE_CREATION_PLAN.md`
- `package.json`
- `prisma/schema.prisma`
- `gh issue view 813 --json number,title,labels,body`

Targeted implementation:

- `src/lib/booking-status.ts`
- `src/lib/capacity.ts`
- `src/lib/booking-create.ts`
- `src/lib/booking-modify.ts`
- `src/lib/booking-date-modification-service.ts`
- `src/lib/booking-modification-settlement.ts`
- `src/lib/booking-cancel.ts`
- `src/lib/booking-delete.ts`
- `src/lib/draft-booking-cleanup.ts`
- `src/lib/booking-events.ts`
- `src/lib/booking-narrative.ts`
- `src/lib/payment-reconciliation.ts`
- `src/lib/payment-transactions.ts`
- `src/lib/payment-recovery.ts`
- `src/lib/booking-payment-cleanup.ts`
- `src/lib/payment-link.ts`
- `src/lib/waitlist.ts`
- `src/lib/cron-waitlist.ts`
- `src/lib/bed-allocation-lifecycle.ts`
- `src/lib/nomination.ts`
- `src/lib/membership-cancellation-requests.ts`
- `src/lib/membership-cancellation-admin.ts`
- `src/lib/membership-cancellation-blockers.ts`
- `src/lib/member-lifecycle-actions.ts`
- `src/lib/admin-family-group-requests-service.ts`
- `src/lib/member-family-service.ts`
- `src/lib/cron-confirm-pending.ts`
- `src/lib/cron-complete-bookings.ts`
- `src/lib/cron-credit-reconciliation.ts`
- `src/lib/cron-job-run.ts`
- `src/lib/admin-cron-health.ts`
- `src/instrumentation.node.ts`
- `src/app/api/cron/route.ts`
- `src/app/api/cron/payments/route.ts`
- `src/app/api/cron/xero/route.ts`
- `src/app/api/bookings/[id]/waitlist-confirm/route.ts`
- `src/app/api/bookings/[id]/guests/[guestId]/route.ts`
- `src/app/api/bookings/[id]/refund-request/route.ts`
- `src/app/api/admin/refund-requests/[id]/route.ts`
- `src/app/api/admin/waitlist/route.ts`
- `src/app/api/admin/bookings/[id]/force-confirm/route.ts`
- `src/app/api/admin/bookings/[id]/review/route.ts`
- `src/app/api/admin/member-applications/route.ts`
- `src/app/api/admin/member-applications/[id]/route.ts`
- `src/app/(admin)/admin/member-applications/page.tsx`
- `src/app/(authenticated)/nominations/[token]/page.tsx`

Existing nearby tests were inspected by targeted search only, not executed.

## Lifecycle/State-Machine Map

### Booking lifecycle

- `DRAFT`: created when review is not blocking and booking is not yet routed to
  payment/finalization. Expired drafts are hard-deleted by the scheduled
  draft-cleanup path after dependent rows are removed. Member/admin direct
  deletion also hard-deletes only draft bookings.
- `AWAITING_REVIEW`: created when no-adult/admin-review rules require manual
  review. It holds capacity through `CAPACITY_HOLDING_BOOKING_STATUSES`.
  Admin approval moves it to `PAYMENT_PENDING`; rejection uses cancellation.
- `PAYMENT_PENDING`: payment-owed, not capacity-holding in `booking-status.ts`,
  but editable/payment-link eligible and can become `PAID` through Stripe
  reconciliation or Xero inbound reconciliation.
- `PENDING`: provisional non-member/payment-link hold. `confirm-pending` rechecks
  capacity under the booking advisory lock, then either cancels/releases,
  extends request-origin holds, claims `CONFIRMED` for an off-session charge, or
  moves zero-dollar bookings to `PAID`.
- `CONFIRMED`: capacity-holding intermediate/owed state. Used while an
  off-session charge is attempted, for some group settlement states, and for
  paid-but-not-yet-final booking paths.
- `PAID`: confirmed settled state. Cron completion moves `PAID` bookings to
  `COMPLETED` once the check-in date has arrived.
- `COMPLETED`: terminal completed-stay state. It still holds capacity per
  `CAPACITY_HOLDING_BOOKING_STATUSES`.
- `WAITLISTED`: does not hold capacity. FIFO position is stored and recalculated.
- `WAITLIST_OFFERED`: timed offer state. It does not hold booking capacity, but
  see bed-allocation risk below.
- `CANCELLED`: terminal cancelled state. Some cancelled records can be
  admin-soft-deleted only when financial/Xero/recovery blockers are absent.
- `BUMPED`: enum exists, but current hold-expiry bump flow records a `BUMPED`
  event while setting booking status to `CANCELLED`.

### Booking modification lifecycle

- Editable statuses are policy-gated around draft, waitlist, owed, paid, and
  completed states.
- Modification settlement separates zero/positive/negative deltas and uses
  `PaymentTransaction`, `MemberCredit`, direct refunds, and recovery operations.
- Newer refund settlement paths enqueue durable payment recovery on refund
  failure; one legacy guest-removal route appears different, noted below.
- Date and guest changes reconcile bed allocation and trigger waitlist processing
  where dates/capacity are affected.

### Booking cancellation lifecycle

- Waitlisted/offered/review-only cancellations clear waitlist fields and record
  cancellation events without payment work.
- Provisional `PENDING` cancellations revoke payment links, release promo
  redemption, clear provisional fields, reconcile beds, and process waitlist.
- Confirmed/paid cancellations branch by payment/refund/credit eligibility.
  Stripe refunds go through `refundPaymentTransactions`; credit outcomes use the
  local member-credit ledger; Xero credit-note work is queued best-effort.
- Cancellation records durable `BookingEvent` rows for the high-level narrative,
  but not every non-terminal transition has a booking event type.

### Payment lifecycle

- `Payment` is one-to-one with booking. `PaymentTransaction` captures primary,
  additional, and refund transaction history.
- Stripe checkout/webhook and confirm-payment paths converge through
  `markBookingPaymentSucceeded`, which uses an advisory lock, verifies amount,
  performs a final capacity check, updates payment/booking state, records a
  payment event, reconciles bed allocation, and queues Xero invoice work.
- Internet Banking/Xero settlement is represented by local `Payment` and Xero
  sync/inbound reconciliation; it remains distinct from Stripe card settlement.
- Payment recovery has first-class `PaymentRecoveryOperation` rows with
  idempotency keys, attempts, `PENDING`/`PROCESSING`/`FAILED`/`SUCCEEDED`
  states, stale-processing reset, retry backoff, and admin/health visibility.

### Refund and credit lifecycle

- Direct Stripe refunds use `refundPaymentTransactions`, which creates
  `PaymentRefund` rows keyed by Stripe refund id and updates payment/refunded
  totals.
- Booking modification refunds enqueue a `REFUND_BOOKING_MODIFICATION`
  recovery operation if the immediate refund fails.
- Superseded/cancelled payment-intent cleanup is represented by recovery
  operation types.
- Member credits are durable `MemberCredit` rows; cancellation and modification
  credit notes use Xero outbox touchpoints.
- Refund appeals are represented by `RefundRequest` with
  `PENDING`/`APPROVED`/`REJECTED` status and admin review endpoints.

### Waitlist lifecycle

- `WAITLISTED` bookings get a FIFO `waitlistPosition`.
- `processWaitlistForDates` moves the first eligible booking to
  `WAITLIST_OFFERED`, sets `waitlistOfferedAt` and
  `waitlistOfferExpiresAt`, clears position, sends member/admin email, records
  audit, and reconciles beds.
- Offer confirmation rechecks capacity and moves the booking to `PENDING` when
  a non-member setup/hold is needed or `PAYMENT_PENDING` when immediate payment
  is required.
- Expired offers move back to `WAITLISTED`, get a recalculated position, email
  the member, record audit, reconcile beds, and reprocess the waitlist.
- Waitlist cron also auto-cancels waitlisted/offered rows whose requested dates
  are fully in the past.
- Admin visibility exists through `/admin/waitlist` and the admin waitlist API.

### Bed allocation lifecycle

- Capacity is owned by `CAPACITY_HOLDING_BOOKING_STATUSES`: `PAID`,
  `COMPLETED`, `CONFIRMED`, and `AWAITING_REVIEW`.
- Bed allocation currently considers a wider set allocatable:
  `PENDING`, `PAYMENT_PENDING`, `CONFIRMED`, `PAID`, `COMPLETED`,
  `AWAITING_REVIEW`, and `WAITLIST_OFFERED`.
- `BedAllocation` rows are unique per bed/night and guest/night, so allocation
  state can affect operator perception and future allocation attempts even when
  booking capacity rules do not treat a status as capacity-holding.

### Membership application and nomination lifecycle

- Application creation validates two distinct eligible nominators, creates a
  `PENDING_NOMINATORS` application and two expiring nomination tokens.
- Each nomination confirmation is guarded by token/member/status/expiry checks
  and an application advisory lock.
- When both nominators confirm, the application moves to `PENDING_ADMIN` and an
  admin notification is attempted.
- Admin approval creates the applicant member, dependent members/family group
  where applicable, a password setup token, marks the application `APPROVED`,
  then attempts Xero contact sync, entrance-fee invoice outbox, approval email,
  and induction setup.
- Admin rejection is available for `PENDING_ADMIN` applications only.
- Admin UI can list `PENDING_NOMINATORS`, but approve/reject buttons are rendered
  only for `PENDING_ADMIN`.

### Membership cancellation lifecycle

- Member-initiated cancellation requests include selected eligible family
  members. Members who require their own confirmation receive a token and sit in
  participant status `PENDING_CONFIRMATION`; others start as `REQUESTED`.
- Confirmation uses a guarded `updateMany` claim, clears the token, and changes
  the participant to `REQUESTED` or `DECLINED`.
- Admin approval requires an independent admin, rechecks future booking/guest
  blockers, marks the member inactive/non-login/cancelled, clears family/parent
  links, sets participant `CANCELLED`, and updates request lifecycle.
- Admin rejection sets participant `REJECTED`.
- Request lifecycle is derived from participant statuses. Any cancelled
  participant causes request `COMPLETED`; all rejected/declined paths complete as
  rejected.
- Xero membership cancellation operations are queued after local cancellation,
  with errors logged.

### Archive/delete lifecycle

- Member hard-delete is intentionally narrow. It requires a request, independent
  admin approval, a member-lifecycle advisory lock, and a fresh delete
  eligibility pass inside the transaction.
- Delete blockers cover owned bookings, guest appearances, payments, refunds,
  payment recovery, credits, subscriptions with invoice/payment history, promo
  history, nominations, applications, cancellation requests, unresolved family
  requests, dependents, email inheritance, Xero links, and other references.
- Archive requires a cancelled member, independent admin approval, an advisory
  lock, and an atomic `archivedAt: null` claim. It clears family/parent/email
  inheritance links and keeps the member row/history.
- Cancelled booking deletion is soft-delete only and is blocked by financial,
  Xero, refund, credit, modification, and recovery history.

### Family/dependent lifecycle

- Admin family request review covers join, child, adult, and removal requests.
- Pending requests are listed for admin review and are also surfaced in member
  family views as blockers to booking profile actions.
- Approval creates or links member records, upserts/removes family group
  membership, links parent/email inheritance, marks the request `APPROVED`, and
  sends best-effort outcome email for child flows.
- Rejection marks request `REJECTED` and records audit/email where applicable.

### Cron/recovery lifecycle

- API-triggered cron routes record `CronJobRun` through `recordCronJobRunSafe`.
- In-process scheduled jobs in `instrumentation.node.ts` use a local
  `recordCronRun` helper that writes the same `CronJobRun` table.
- Admin cron health defines freshness expectations for confirm-pending, payment
  recovery, Xero jobs, backup, data pruning, draft cleanup, deadline alerts,
  reminders, complete-bookings, age-up, credit reconciliation, waitlist
  processor, email retry, and related jobs.
- Payment recovery and Xero outbox/retry/inbound routes expose explicit
  recovery task endpoints. Waitlist, draft cleanup, complete-bookings, and
  credit reconciliation run through scheduled registration.

## Key Domain Invariants Checked

- Money values remain integer cents in inspected payment, refund, credit,
  entrance-fee, and booking price fields.
- NZ date-only booking nights are represented with date-only helpers in the
  inspected booking/waitlist/admin query paths.
- Capacity should be consumed only by documented capacity-holding booking
  statuses.
- Waitlisted and offered bookings should not consume booking capacity until
  confirmed.
- Stripe and Internet Banking/Xero payment paths remain distinct.
- Webhook/cron/provider retry paths should be idempotent and visible.
- Provider calls should stay outside long transactions unless there is a
  documented reason.
- Financial, booking, Xero, audit, family/dependent, and recovery history should
  block hard delete.
- Membership cancellation should not proceed while future booking/guest
  blockers exist.
- Admin repair/recovery paths should surface stuck provider or cron state.

## Likely Stuck/Lost/Orphaned/Duplicated-State Risks

1. Bed allocation and capacity may disagree for provisional/offered statuses.
   `CAPACITY_HOLDING_BOOKING_STATUSES` excludes `PENDING`,
   `PAYMENT_PENDING`, and `WAITLIST_OFFERED`, but
   `BED_ALLOCATABLE_BOOKING_STATUSES` includes them and writes unique
   `BedAllocation` rows. This may be intentional pre-assignment, but it creates
   a plausible operator-visible mismatch where a row that does not hold booking
   capacity can still occupy a bed/night allocation slot. Proposed follow-up
   should decide whether this is intended and document/test the ownership
   boundary.

2. Legacy guest-removal refund failure lacks the durable payment recovery path
   used by booking modification settlement. Sensitive follow-up required. The
   guest removal API attempts a refund and logs manual reconciliation on
   failure, while the newer modification settlement path enqueues
   `REFUND_BOOKING_MODIFICATION` recovery. That can leave a modified local
   booking and an unresolved provider refund without the same retry/admin queue.

3. Refund appeal approval performs external refund work before the local
   `RefundRequest` is claimed as approved. Sensitive follow-up required. The
   Stripe refund helper is idempotent at the transaction/refund layer, but a
   local failure after refund creation can leave the request `PENDING` while
   money movement has occurred. A follow-up should claim/process the request in
   a durable local state before or around provider work.

4. Membership nomination tokens can expire while the application remains
   `PENDING_NOMINATORS` and continues blocking a fresh application for the same
   applicant email. Admins can list "Waiting on nominators", but the inspected
   admin UI only renders approve/reject actions for `PENDING_ADMIN`, and no
   automatic expiry/reissue/reject path was found in the targeted pass. This is
   a likely stuck application state to verify.

5. Durable `BookingEvent` coverage is not a full transition ledger. It records
   creation, paid/confirmed, bumped, cancelled, refunded, and credited facts,
   but waitlist offers/confirmations, admin review approval, and admin
   force-confirm transitions rely on audit/status fields rather than
   `BookingEvent`. This may be intentional because `BookingEventType` is a
   narrative subset, but docs should not describe it as every transition unless
   those gaps are covered elsewhere.

6. Waitlist offer email delivery is best-effort while state changes immediately
   to `WAITLIST_OFFERED`. Email retry may cover template/audit paths generally,
   but this review did not prove that a failed waitlist-offer email has a
   durable retry tied to the offer. Admin visibility exists, so this is a
   to-verify notification/recovery gap rather than a confirmed state-loss bug.

7. Membership cancellation participant confirmation tokens expire without an
   automatic participant/request status transition in the inspected flow.
   Admin token reissue exists and the request stays visible, but pending
   confirmation can block overlapping cancellation requests until an operator
   intervenes. This appears recoverable but should be explicitly tested and
   documented.

8. Several Xero/email side effects after durable local transitions are
   intentionally best-effort. This is usually acceptable when there is outbox,
   retry, audit, warning, or admin health visibility. Follow-up reviews should
   verify each state-changing side effect has one of those visibility/retry
   mechanisms, especially cancellation credit-note queueing and membership
   cancellation Xero operation queueing.

## Areas That Look Intentionally Safe

- Primary Stripe payment success converges through `markBookingPaymentSucceeded`
  with an advisory lock, final capacity check, payment transaction upsert,
  payment/booking state update, booking event, bed allocation reconciliation,
  and Xero invoice enqueue.
- Confirm-pending cron claims capacity before off-session charging, releases the
  claim if the charge does not succeed, and leaves successful-charge/local-fail
  cases for webhook/admin recovery.
- Payment recovery has durable operations, idempotency keys, processing claims,
  stale reset, bounded retry attempts, failure alerts, and cron/health
  visibility.
- Booking cancellation releases capacity/bed allocation and triggers waitlist
  processing in the inspected branches.
- Booking deletion is tightly limited: drafts can be hard-deleted after
  dependent cleanup; cancelled booking soft-delete is blocked by financial,
  Xero, refund, credit, modification, and recovery history.
- Member hard-delete is heavily blocked, snapshot-backed, independently
  approved, and serialized by a member-lifecycle advisory lock.
- Member archive is restricted to cancelled members, independently approved,
  atomically claimed, and clears family/parent/email inheritance links.
- Membership cancellation approval rechecks future booking and guest blockers
  before deactivating a member.
- Family/dependent request approval uses transactional upsert/delete patterns
  for family membership and validates active/age/parent/email-inheritance
  constraints.
- Cron run status is visible through `CronJobRun` and admin cron health for the
  major scheduled recovery/state jobs.

## Proposed Follow-up Issues

These are candidate issue scopes only. No issues were created.

1. Clarify and test bed allocation ownership for non-capacity-holding booking
   statuses.
2. Add durable recovery/admin visibility for the legacy guest-removal refund
   failure path. Sensitive follow-up required.
3. Make refund appeal approval locally claimable/recoverable before external
   refund side effects. Sensitive follow-up required.
4. Add an expiry/reissue/reject lifecycle for stale membership applications
   stuck in `PENDING_NOMINATORS`.
5. Decide whether `BookingEvent` is a full lifecycle ledger or a narrative
   subset, then document/test admin review, force-confirm, and waitlist
   transition coverage accordingly.
6. Verify durable retry/admin visibility for business-critical waitlist,
   membership-cancellation, and cancellation/Xero notification side effects.
7. Document and test membership cancellation expired-confirmation recovery and
   overlapping-request behavior.

## Tests/Static Checks Recommended

For follow-up implementation issues, use targeted tests rather than broad test
sweeps:

- Bed allocation/capacity unit tests proving whether `PENDING`,
  `PAYMENT_PENDING`, and `WAITLIST_OFFERED` may create or retain allocation
  rows and what happens when a confirmed/paid booking competes for the same
  bed/night.
- Route/service tests for guest removal refund failure that assert recovery
  operation creation or an equivalent admin-visible durable state.
- Admin refund-request review tests for concurrent approval/rejection and local
  failure after provider refund, using mocked Stripe only.
- Membership application tests for expired nomination tokens, duplicate
  applicant submission, admin reissue/reject, and visibility of stale
  `PENDING_NOMINATORS` rows.
- Booking lifecycle ledger tests that compare `BookingEvent`, audit log, and
  booking status transitions for admin review approval, force-confirm, waitlist
  offer, waitlist expiry, and waitlist confirmation.
- Membership cancellation tests for expired confirmation tokens, token reissue,
  declined participant, confirmed participant, request lifecycle derivation, and
  future booking blocker rechecks.
- Cron health tests that confirm each state-changing scheduled job writes
  `CronJobRun` success/failure/skipped records and appears in admin health.
- Static schema validation with a safe placeholder `DATABASE_URL` in follow-up
  implementation branches where Prisma behavior is touched.

## Uncertainty/To-Verify List

- Whether bed allocation for `PENDING`, `PAYMENT_PENDING`, and
  `WAITLIST_OFFERED` is intended as operator pre-assignment or is accidental
  capacity ownership drift.
- Whether the legacy guest removal route is still active for user-facing
  modification flows or only retained for old UI/API compatibility.
- Whether email audit/retry infrastructure durably covers waitlist offer and
  membership cancellation confirmation emails, or whether failures are log-only.
- Whether operators have a documented runbook for stale `PENDING_NOMINATORS`
  applications with expired nomination tokens.
- Whether membership cancellation expired participant tokens should
  auto-decline, remain pending with admin reissue, or expire the whole request.
- Whether Xero queue failures after local cancellation/approval are always
  visible in admin health or Xero operation pages.
- Whether `BookingEvent` documentation should be narrowed to "durable narrative
  facts" instead of "every booking/payment transition".
- Whether admin force-confirm overbooking semantics and bed allocation behavior
  are covered by targeted tests.
- Whether `complete-bookings` should also record a booking event or remain a
  pure status transition with cron history only.
