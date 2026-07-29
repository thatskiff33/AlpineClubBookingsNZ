# State Machines

This is a first-pass map for review planning. It intentionally marks uncertain
or implementation-specific details as "to verify in later review" rather than
inventing certainty.

## Booking Lifecycle

Known schema statuses: `DRAFT`, `PENDING`, `PAYMENT_PENDING`, `CONFIRMED`,
`PAID`, `BUMPED`, `CANCELLED`, `COMPLETED`, `WAITLISTED`,
`WAITLIST_OFFERED`, `AWAITING_REVIEW`.

```text
DRAFT -> PENDING or PAYMENT_PENDING -> CONFIRMED or PAID -> COMPLETED
PENDING -> CONFIRMED/PAID or BUMPED/CANCELLED
WAITLISTED -> WAITLIST_OFFERED -> CONFIRMED/PAID or WAITLISTED/CANCELLED
AWAITING_REVIEW -> PENDING (quote accepted, #1254) or CONFIRMED/PAID or CANCELLED
```

Waitlist confirmation and expiry serialize on the offered booking's lodge lock.
Confirmation re-reads `WAITLIST_OFFERED` and the deadline after acquiring the
lock and uses a status/deadline-guarded claim, so an expiry that wins first
cannot be resurrected. The route's separate zero-dollar `PAYMENT_PENDING ->
PAID` capacity claim takes global then lodge locks; if capacity disappeared,
it restores `WAITLISTED` in that transaction so normal re-offering can retry.
Generic `PAYMENT_PENDING` does not hold a bed.

Capacity-holding is not a pure function of status (#1254, refining #737). A
booking holds beds when its status is capacity-holding (PAID, COMPLETED,
CONFIRMED, AWAITING_REVIEW), **or** it is PENDING and is the converted booking
of a `BookingRequest` (an accepted-but-unpaid quote / approved request), **or**
it is PAYMENT_PENDING and carries an **admin capacity hold** (#1764,
`adminCapacityHoldAt` set — an orthogonal flag, NOT a status: the lifecycle
status keeps meaning what it means). Generic PENDING (split-booking children
#738, member "only-if-my-guests-come" holds) still does not hold and stays
bumpable, and PAYMENT_PENDING without an admin hold stays non-holding. The
single source of truth is `capacityHoldingBookingFilter()` in
`src/lib/booking-status.ts`; every availability query uses it.

Admin capacity hold interaction (#1764): Hold is admin-only
(`POST /api/admin/bookings/[id]/capacity-hold`), allowed only on a
PAYMENT_PENDING booking that does not already hold capacity, taken under the
per-lodge advisory lock with a capacity re-check (409 CAPACITY_EXCEEDED unless
an explicit overbook is confirmed, mirroring force-confirm). Unhold (`DELETE`
on the same route) releases the beds and is refused (409) once the booking
holds capacity naturally — releasing a paid/confirmed booking's capacity stays
impossible. A natural transition (payment success -> PAID etc.) needs no hold
handshake: the filter's clauses are OR'd, so capacity is counted exactly once
and the hold record simply becomes inert; if a settlement failure later
reverts the booking to PAYMENT_PENDING (group-settlement reaper), the still-set
hold re-engages seamlessly — capacity was continuously held either way. Every
cancel-shaped transition (cancel routes, group-child cancel, settlement
reaper expiry, Internet Banking hold release, capacity-failed settlement)
clears the hold fields via the shared `RELEASE_ADMIN_CAPACITY_HOLD_UPDATE`
fragment — no orphaned holds. Both actions write audit rows
(`booking.admin_capacity_hold.placed[_overbook]` / `.released`). Consequence: an accepted-but-unpaid quote booking
keeps its bed until it is paid, expires, or is cancelled, and a later member
booking can no longer bump it. One deliberate exception (owner-ratified, #1317):
an accepted-but-unpaid hold is NOT protected against a *capacity reduction* — if
an admin lowers the lodge capacity for those nights below what is booked, the
`cron-confirm-pending` job bumps/cancels the still-unpaid hold at its hold
deadline (no charge). Only an admin capacity cut can reclaim the bed; competing
member bookings still cannot. The admin "Confirm pending guests" override
(`/api/admin/bookings/[id]/confirm-pending-guests`) now runs the same
global `pg_advisory_xact_lock(1)` -> per-lodge capacity-lock -> mutable re-read
and capacity re-check before flipping a booking to a capacity-holding status on
its zero-dollar and charge-saved-card branches, returning 409 unless an explicit
overbook is requested (#1366, #1881). Its
charge-saved-card branch follows the cron's claim-first shape (#1418): claim
`PENDING -> CONFIRMED` (hold cleared) under the lock, charge outside it, then
promote to PAID. A failed or requires-action charge releases the claim back to
`PENDING` with the hold restored and (on failure) alerts admins; a captured
charge is durably recorded as a PRIMARY payment transaction before promotion,
so if the promotion fails the booking stays CONFIRMED holding its beds, admins
are alerted, and the Stripe webhook finishes the promotion idempotently —
captured money is never silently orphaned.

Split-booking guest-portion settlement with no card on file (#1967). A split
non-member child (#738) is normally auto-charged at its hold deadline to the
member's saved card inherited from the parent payment
(`savedPaymentMethodForBooking`). But a `PAYMENT_PENDING` parent can legitimately
pay by **Internet Banking** (switch-at-pay flips the parent to `CONFIRMED` with
an IB-source payment), which leaves the parent payment with no
`stripeCustomerId`/`stripePaymentMethodId` — so the child resolves to no saved
card and is not `originBookingRequest`. Rather than stranding the guests (the old
`missing_payment_method` path only logged), `cron-confirm-pending.ts` now mirrors
the #707 request-origin path — but only for a **genuine split child whose parent
is genuinely settled without a card** (an IB-source payment on a live parent, or
a parent already `CONFIRMED`/`PAID`/`COMPLETED`). #796 group joiners also carry
`parentBookingId` but always have a `GroupBookingJoin` row written atomically at
creation; that row is the discriminator, and joiners keep the pre-existing
`missing_payment_method` log path. When the gate passes the cron extends the
hold, mints a tokenised `/pay/<token>` PaymentLink (reusing the #707 machinery)
so the member can settle the guest portion, and emails the member that link.
The **member email fires once per mint** — `mintSplitGuestPaymentLinkIfAbsent`
is guarded on the absence of an active (unrevoked, unused, unexpired)
PaymentLink for the child — while the **admin alert
(`sendAdminSplitSettlementUnpaidAlert`) follows a derived cadence** (#1993 Part
B): it fires on hold-extension windows 1, 2 and 3, then every 7th window
thereafter, capping the previously-uncapped ~2-daily alert. The window number is
a pure function of elapsed time — `floor((now − originalHoldExpiry) /
REQUEST_HOLD_EXTENSION_MS) + 1`, where `originalHoldExpiry` is re-derived (no
schema, no counter) as `max(checkIn − holdDays, createdAt)` — and the upstream
extension CAS still fires exactly once per ~2-day window, so a cron rerun in the
same window never re-alerts. If the parent is NOT settled (e.g. an abandoned-card
`PAYMENT_PENDING` parent), no link is minted or emailed — the guest portion must
not settle ahead of the member's own place — and the same capped admin alert
fires with parent-unpaid wording instead.

Payment-link recovery and supersession (#1967). Raw tokens are never stored, so
a minted-but-undelivered link would otherwise stall settlement forever behind
the active-link sentinel. Recovery is revoke-and-remint: (a) if the cron's
post-commit member email throws or is suppressed, the cron revokes the
just-minted link **by row id** (never the whole booking, so a newer concurrent
link survives) and the next extension run re-mints and re-sends; (b) the
on-demand button (`POST /api/bookings/[id]/send-guest-payment-link` →
`issueSplitGuestPaymentLink`) is a true send/RE-SEND — it revokes the existing
active link and mints+emails a fresh one atomically under the per-lodge
advisory lock, except that an active link minted within the last minute
short-circuits as just-sent (the double-click guard); (c) an EXPIRED link is
not active (matching #707's `expired_payable` re-issue convention), so a child
whose dates moved out after its link lapsed gets a fresh link, while a child
whose check-in day has already ended never gets one minted at all. Every mint
site (cron, button, `/pay` re-issue) revokes-then-creates under the per-lodge
advisory lock, so at most one live token can exist per booking. Conversely,
once a saved card appears (e.g. the member later pays the parent by card), the
cron's auto-charge claim revokes the child's active links inside the claim
transaction and the `/pay` intent path re-reads the link under the same lock —
the tokenised link and the saved-card charge are never both live. The on-demand
issue path refuses (`not_payable`) whenever a saved card exists for the same
reason.

Reachable composite states (#1967): the parent and child settle independently,
so a child can be PAID while its parent is still unpaid (IB transfer never
reconciled) or after the parent is CANCELLED — the parent-cancel sweep
(`cancelLinkedProvisionalChildBookings`) only cancels children still PENDING
(and revokes their links); an already-PAID child deliberately survives, exactly
like any other paid booking (captured-money invariant), and needs the ordinary
cancel/refund flow if the party is not coming.

Terminal state at check-in (#1993 Part A, owner-selected Option 1). A split
child still `PENDING` (unsettled, no saved card) once its check-in day has ended
is **auto-cancelled** by the settlement cron: `PENDING -> CANCELLED`. The boundary
is the same one the link-mint stop uses
(`endOfDateOnlyForTimeZone(formatDateOnly(checkIn)) <= now`), so the two can never
disagree about "check-in has passed". Because the child holds no capacity this is
bookkeeping + notification, not a capacity change: under the per-lodge lock a
guarded `updateMany({ status: PENDING } -> CANCELLED)` CAS (count 0 => a payment
won the lock seconds earlier — `already_processed`, safe), then bed reconcile and
payment-link revocation, in the same transaction. Post-commit (outside the tx,
per `booking-events.ts` — an in-tx narrative INSERT failure would abort the whole
transaction and block the cancel) the `CANCELLED` booking event is recorded, the
member gets a **dedicated** guest-portion-cancelled email
(`split-guest-portion-cancelled`: nothing was ever charged, their own booking is
untouched — and it only promises "remains confirmed" when the parent is genuinely
settled), and admins get ONE **dedicated** terminal notice
(`sendAdminSplitSettlementCancelledAlert` / the `admin-split-settlement-cancelled`
template — its own registry entry, so an override or mute of the recurring
`admin-split-settlement-unpaid` alert cannot rewrite or suppress it). The recurring
alert itself now fires on a capped cadence (hold-extension windows 1, 2, 3, then
every 7th) and the terminal cancel ends that series. A **PAID child is never reached** (it is
not `PENDING`); the **parent is never touched**; and there is **no Xero void** —
an unsettled child never had an invoice. A split child that DOES have a saved
card is still auto-charged at its hold deadline as before (that path settles it,
so the terminal cancel is only for the no-card link path). The child otherwise
stays PENDING and holds no capacity throughout; if the lodge fills first, the
capacity re-check bumps it and revokes its link like any other provisional child.
Paying the parent by card instead keeps the automatic saved-card settlement path
unchanged.

Terminal state at check-in for request-origin holds (#2012, the #1993 sibling).
A request-origin booking (`originBookingRequest` set, request `CONVERTED`) still
`PENDING` with no saved card once its check-in day has ended is likewise
**auto-cancelled** by the settlement cron under the same boundary and the same
per-lodge-lock + guarded `PENDING -> CANCELLED` CAS discipline (count 0 => a
`/pay` settlement won — `already_processed`, zero side effects). The structural
difference from the split child: a request booking **holds real capacity**, so
the in-transaction bed reconcile genuinely RELEASES beds (mirroring the `bumped`
path), promo redemptions are cleaned up, and the post-commit waitlist wake has
real freed capacity to offer. The `CONVERTED` request row is deliberately left
as the historical record — the booking's CANCELLED status is the capacity source
of truth (a CONVERTED request is not declinable, so the decline flow cannot and
does not run here). Post-commit the requester gets a **dedicated**
`booking-request-payment-expired` email (no payment link — it is dead past
check-in; the path back is a new request) and admins get ONE dedicated
`admin-booking-request-hold-cancelled` notice with its own registry entry
(independently mutable/overridable from the recurring hold alert). The recurring
request-hold alert now follows the same capped cadence (extension windows 1, 2,
3, then every 7th), and the terminal cancel ends the series. A booking whose
parent request path acquired a saved card still auto-charges as before; `$0`
request bookings still auto-confirm.

Lodge check-in gate (F27 / #1372 + #1422) — status-preserving. A booking that
carries a pending admin review (`requiresAdminReview` true and
`adminReviewStatus = PENDING`) is BLOCKED from lodge check-in, but the block
never changes the booking's status. The canonical case is a paid booking edited
down to only under-18 guests (no adult): it stays PAID (captured-money
invariant, #1100) yet cannot arrive until an admin clears the review. The block
is reason-agnostic (#1422): any pending admin review gates check-in — today
adult-supervision is the only such reason, but a future review type inherits the
gate automatically. Enforcement is a single shared where-fragment
(`checkinNotBlockedByPendingReviewFilter` in `src/lib/booking-review.ts`) applied
to the arrive/depart and roster generate/confirm queries, so a blocked booking's
guest resolves to null server-side (arrive returns 404, roster-confirm 400) — the
block is safe because every lodge query already restricts to the operational
stay statuses (PAID/COMPLETED), so no parked `AWAITING_REVIEW` booking is
over-blocked. The lodge guest list (the check-in roster staff read on the kiosk)
INCLUDES the blocked booking but flags it "Blocked from Check-In — see Booking
Officer" and disables its arrival toggle — shown, not hidden, yet still
un-arrivable server-side (defense in depth). The check-in reminder cron skips
blocked bookings, and the review-required admin alert fires on its own
notification preference so muting routine new-booking alerts does not silence it.

To verify in later review: exact terminal transitions, non-member hold expiry,
school group `CONFIRMED` semantics, and payment-failure back paths.

Organiser-pays group children add one cron-driven back path: the
`group-settlement-reaper` reverts CONFIRMED-unpaid children to
`PAYMENT_PENDING` when the settlement expires, and cancels those reverted
children (`PAYMENT_PENDING -> CANCELLED`, #1094) if the settlement is still
FAILED after a second full window — a settlement retry always wins.

The same cron also resumes an organiser-cancel group cleanup interrupted by a
crash (#1236). Cancelling the organiser booking is single-flight, so a
re-invoked cancel 409s and never re-enters the joiner cleanup. Group cleanup now
persists `GroupBooking.CANCELLED` first under the settlement lock as its durable
settlement fence, then performs provider work outside the transaction; a third
reaper phase therefore re-drives any ORGANISER_PAYS group under a `CANCELLED`
organiser booking that still has active organiser-settled children after the
short grace (regardless of the already-fenced group status). The re-drive is
idempotent because the first run persists the per-child refund plan
(`{childId: cents}`) on the settlement **before** the Stripe refund and
**before** the settlement flips to `REFUNDED`/`PARTIALLY_REFUNDED`: a re-drive
reconstructs that plan verbatim (never recomputes — a >24h re-drive can land in
a different cancellation tier) and applies the per-child `refundedAmountCents`
mirror, and the `SUCCEEDED` guard plus the Stripe idempotency key fire the
refund at most once. Each child's Xero refund credit-note outbox row is enqueued
**inside the same transaction** as that child's cancel + refund mirror
(#1257/#1377), so a crash can never leave a `CANCELLED` child with its mirror
written but no credit-note operation queued — durable for every source,
including Internet-Banking children the #1354 self-heal cannot recover. Only the
outbox worker kick stays best-effort and post-commit.

Internet Banking settlement initiation writes `GroupBookingSettlement.PENDING`
and its Xero invoice outbox operation in the same transaction. The worker checks
the group fence under `lock(1)` before calling Xero. If cancellation is already
durable it completes without creating an invoice; if cancellation commits while
`createInvoices` is in flight, the worker persists the returned Xero identity,
voids it under a stable idempotency key, suppresses invoice email, and leaves a
failed compensation retryable through the same outbox row.

A transient Stripe failure during that settlement refund no longer abandons it
(#1351, owner-decided durable auto-retry). A recovery operation is persisted
**before** the inline refund (closed on the happy path) and the frozen plan is
kept, never nulled: the payment-recovery cron replays the refund under the
same `group_cancel_refund_<settlementId>` Stripe key — so an ambiguous failure
where Stripe actually refunded is replayed, not repeated — flips the
settlement, applies the per-child `refundedAmountCents` mirrors idempotently
(only to already-`CANCELLED` plan children whose mirror is still zero; ACTIVE
children stay owned by the reaper resume path), and enqueues the per-child
Xero credit notes. Admins are alerted only when the retries exhaust, and the
stuck-state dashboard flags any `SUCCEEDED` settlement under a `CANCELLED`
group whose refund plan has not executed.

Booking quote and create paths reject a linked member who is already present on
another live booking for any requested lodge night. The guard covers draft,
pending, confirmed/paid/completed, waitlist, offered, and admin-review bookings,
but does not change capacity-holding status rules. A member can open their own
conflicting booking, and a linked guest can remove only themselves from another
future booking when they are not the last guest.

Cancelling a paid booking is single-flight (#1160). The refund plan is frozen
from a re-read taken under the global booking advisory lock, and the status
flips to `CANCELLED` atomically with the credit-path ledger writes (refund
allocation + cancellation credit) — or, on the card path, with the durable
refund-recovery operation carrying the per-transaction allocation frozen from
that same locked read (#1349) — inside that same transaction. A concurrent
cancel or a retry that loses the claim re-reads the already-cancelled booking
and returns HTTP 409 without moving any money — no description-string
idempotency guard is needed because the claim itself guarantees the credit
writers run exactly once. Stripe/Xero work runs only after the claim commits.
Because the card-refund debt is persisted *before* the inline Stripe call, a
process death anywhere between the claim commit and the refund leaves a
`PENDING` recovery operation the payment-recovery cron replays — not a
silently lost refund (the pre-#1349 catch-only enqueue recorded the debt only
if the refund *threw*). The inline refund executes the operation's frozen
slices and marks it `SUCCEEDED` on completion; inline and cron therefore mint
identical `booking_cancel_refund_<bookingId>` Stripe idempotency keys **and send
a byte-identical request body** (#1494) — both build the refund metadata from
the shared `buildBookingCancellationRefundMetadata` helper
(`{ bookingId, reason: "cancellation" }`, deliberately carrying no
per-cancellation value the cron cannot reconstruct from the persisted
operation), so a Stripe-succeeded-but-unrecorded refund (or a cron tick racing
the inline call) is replayed by Stripe, never repeated and never rejected as an
`idempotency_error` for a reused key with mismatched parameters. An outstanding additional
PaymentIntent is retired durably (#1350): the claim transaction persists a
`CANCEL_PAYMENT_INTENT` recovery operation alongside the FAILED flip, the
Phase-2 inline Stripe cancel stays best-effort (logged, never allowed to
abort the committed claim), and the recovery cron finishes the job — a
still-cancellable intent is cancelled, while one Stripe already captured is
handed off to a full refund. A capture that races the webhook is caught
twice over: the `payment_intent.succeeded` superseded-intent hook routes
intents with a cancellation-recovery row straight to refund recovery, and the
`modification_additional` handler status-guards CANCELLED bookings — the
capture is recorded truthfully, refunded in full under the idempotent
`late_cancel_refund_<bookingId>_<intentId>` key, alerted to admins, and the
supplementary Xero invoice is never released (a race that already released it
gets a delta-capped corrective refund credit note instead). As a backstop
detector, the admin stuck-state dashboard flags recent `CANCELLED` bookings
whose captured payment shows no recorded refund, no recovery operation, and
no cancellation narrative event — the crash-window signature that previously
fired nothing.

Cancelling a no-payment booking (`WAITLISTED`, `WAITLIST_OFFERED`,
`AWAITING_REVIEW`) is likewise status-guarded claim-first under the SAME global
booking advisory lock (#1311). This path takes no Stripe/Xero call, so the only
hazard is a state clobber, not a double money-move: a held `AWAITING_REVIEW`
booking can be converted to `PENDING` by a concurrent quote-accept, which holds
that lock and re-writes the held booking by id only. The cancel therefore takes
the same lock, re-reads the status under it, and flips to `CANCELLED` only while
the status is still one of the three no-payment states; if a concurrent accept
(or another cancel) has moved it out of that set the loser returns HTTP 409 and
runs no side effects (no status flip, pointer detach, bed reconcile, audit,
email, or waitlist re-process), so a just-accepted booking is never clobbered
back to `CANCELLED`.

The linked provisional-child sweep triggered by a successful parent cancel is
also claim-first (#1881 residual). A pre-lock `PENDING` child is only a
candidate: cancellation takes global `lock(1)`, then that child's per-lodge
capacity lock, re-reads it, and conditionally claims `PENDING -> CANCELLED`.
The hold-resolution cron shares the per-lodge lock. If it has already confirmed
or charged the child, cancellation loses the claim and emits no stale bed,
credit, payment-link, audit, event, email, promo, or waitlist side effect.

That under-lock re-guard catches an accept committing AFTER the cancel's
under-lock read, but the cancel *dispatches its branch* from an earlier OUTER,
un-locked read. So the two callers that exist to release a held request — the
admin **Release hold** route and the decline path — pass a `requireRequestHold`
flag: if that outer read already shows the hold has left `AWAITING_REVIEW` (e.g.
a concurrent quote-accept flipped it to `PENDING`), the cancel refuses with HTTP
409 and takes no side effect, rather than dispatching into the generic `PENDING`
cancel branch and cancelling the just-accepted booking / revoking its brand-new
payment links (#1406). The two guards close the race together: the flag covers
an accept that commits before the outer read, the under-lock re-read covers one
that commits after it. Callers cancelling a genuine member-created `PENDING`
booking (member self-cancel, account-deletion cleanup) never set the flag and
are unaffected.

Every cancel path restores previously applied account credit (#1547) — all
`cancelBooking` branches plus the Internet-Banking hold-expiry release
(`internet-banking-payment-cron.ts`), the one automatic cancel outside
`cancelBooking`. A member can apply account credit to a booking (a negative
`BOOKING_APPLIED` ledger row); if the booking is then cancelled that row MUST
be reversed or the credit is silently lost. The paid path restores the applied slice at the
cancellation tier (#1164). The never-captured / no-refund path
(`PAYMENT_PENDING`/`CONFIRMED`/`PAID` with no paid-path payment) and the
`PENDING` and no-payment paths restore it at **100%** — nothing was captured, so
no cancellation-policy tiering applies (the same capacity-failure system-void
precedent). To make that restore exactly-once, the never-captured branch and the
generic `PENDING` branch are now themselves status-guarded claim-first under the
same booking advisory lock (previously the `PENDING` branch was unlocked with no
status re-guard); `restoreCreditFromBooking` carries no internal replay guard, so
each branch's atomic status flip is its only idempotency guarantee. A CANCELLED
booking may legitimately hold consumed credit with no restore row ONLY when its
payment captured money (0%-tier paid cancels write no restore row; held-as-credit
refunds keep the applied rows) or settled without cash (the fully-credit-covered
$0 SUCCEEDED payment, whose cancel takes the paid path and may tier the restore
to 0). The daily credit-reconciliation cron alerts
(alert-only, no auto-heal — a post-fix hit is a new regression) on any CANCELLED
booking still holding orphaned applied credit, and
`scripts/backfill-orphaned-applied-credits.ts` heals pre-fix orphans.

### BookingEvent Scope

`BookingEvent` is a durable narrative fact store, not the complete transition
ledger. It stores the facts needed to explain member/admin-visible events such
as creation, payment, bumping, cancellation, refund, and credit outcomes after
AuditLog retention pruning.

Transitions that do not need a narrative fact remain durable through their
own state fields or operational ledgers. For example, waitlist offers and
expiries use booking waitlist fields plus waitlist/audit records, admin review
and force-confirm actions use booking status/admin review fields plus AuditLog,
scheduled completion uses booking status plus CronJobRun, and money/provider
work uses payment, transaction, refund, recovery, and Xero outbox ledgers.

Admin force-confirm records are written in the same transaction as the booking
status change. Explicit overbook overrides use the
`waitlist.force_confirmed_overbook` action with critical severity, preserved
retention, overbooked date-only nights, and an admin waitlist completion report
linking directly to the filtered audit record.

## Booking Modification Lifecycle

Known change request statuses: `REQUESTED`, `APPROVED`, `REJECTED`.

```text
member/admin starts edit -> quoted delta -> local booking mutation
positive delta -> additional payment or supplementary Xero invoice
negative delta -> Stripe refund or source-linked member credit
admin review path -> REQUESTED -> APPROVED or REJECTED
```

Edit-eligibility is governed by a date-window edit policy
(`getBookingEditPolicy`), whose `mode` selects what a request may change:

```text
checkIn > today                     -> "future"        (edit dates/guests freely)
checkIn <= today <= checkOut        -> "in-progress"   (extend future nights only;
                                                         check-in locked; #2029:
                                                         the whole check-out day
                                                         is still editable)
checkOut < today                    -> null            (not self-editable)

adminOverride && role === "ADMIN"   -> "admin-override" (issue #1668: date-window
                                                         locks lifted; status
                                                         eligibility + capacity
                                                         lock still enforced)
```

Self-service cancellation of a **started** stay is blocked (#2029). Once
`checkIn <= todayNZ`, the member-facing cancel route
(`enforceStartedStayBlock`) refuses cancellation for a booking owner or Booking
Officer with a clear "edit to shorten your remaining nights, or contact the
club" message; a Full Admin (`sessionUserRole === "ADMIN"`) keeps full
cancellation capability, and every internal/admin cancel path (decline,
release-hold, review-reject, account-deletion) is unaffected. This restores the
invariant that a started stay is not member-cancellable — previously implicit
because the completion cron flipped a started PAID booking to the
non-cancellable COMPLETED state on day one, an implicit guard #2029's widened
PAID window removed. Leaving early is done by shrinking the remaining future
nights through the in-progress edit path (policy-retained), never an
irreversible `PAID -> CANCELLED` that releases beds with guests present.

The admin-override mode is date-only and takes one of two pricing modes:
`shift` (pure relocation, all cents frozen, night count preserved, no fee /
settlement / Stripe / Xero — a `BookingModification` of type `ADMIN_DATE_SHIFT`
with zero deltas) or `recalculate` (the standard reprice with locked-period
clamps lifted). An over-capacity override is warn-and-confirm: the first apply
raises `OverCapacityConfirmationRequiredError` (409,
`OVER_CAPACITY_CONFIRM_REQUIRED`) and only proceeds when resubmitted with
`confirmOverCapacity: true`, recording `capacityOverridden`. The same
warn-and-confirm contract covers **every admin on-behalf create** — past-dated
(#1695) and future-dated (#1767) — except a create that opted into the
waitlist fallback (which keeps the capacity-exceeded outcome so the
WAITLISTED booking is created instead); a member self-create keeps the hard
capacity block and can never overbook. (The former v1 hard block on a
non-member hold-eligible (PENDING) party was retired by #1771 — the persisted
override now lets the hold cron confirm rather than bump the overbook.) Every
override move is audited as `booking.modify.admin_override` (including the
admin's explicit member-notification choice, `notifyMember`) and linked,
best-effort, to the booking's most recent APPROVED-but-unlinked change request
that the move fulfils (date-only request whose named dates equal the applied
values).

**Persisted capacity override (#1771).** Every over-capacity admission stamps
`Booking.capacityOverriddenAt` + `capacityOverriddenByMemberId` (immutable, set
only when the override fires, never cleared on cancel). The payment-time and
settlement capacity re-checks — `markBookingPaymentSucceeded`, payment links,
`cron-confirm-pending`, `charge-saved-method`, `switch-to-internet-banking`, the
Internet Banking invoice-paid reconcile, and group settlement — now consult
`bookingHasCapacityOverride` and, when set, settle/advance the booking to its
correct terminal state (PAID / CONFIRMED / payment proceeds) instead of
cancelling+refunding, 409ing, or bumping it. Previously a *priced* overridden
booking self-destructed when payment landed over capacity; $0/credit-covered
overridden creates settled at create time and were never affected. The
DRAFT-scoped re-checks (`create-payment-intent`, `confirm-draft`) are exempt (a
DRAFT can never carry an override).

To verify: failed post-transaction refund recovery, Xero credit-note creation,
additional-payment cleanup, and bed-allocation reconciliation.

Cancelled-booking soft-delete is an admin cleanup state, not hard erasure. It
keeps the booking record and remains blocked by captured/refunded/credited
payment, refund, member-credit, payment-recovery, or Xero history. Internal
modification rows with positive and negative cent deltas may be soft-deleted
when those deltas net to zero and no external financial history exists. The
member-credit blocker follows the same net-zero rule (#1547, owner decision
2026-07-07): applied credit that was fully reversed (net-zero, only
`BOOKING_APPLIED`/`CANCELLATION_REFUND` rows, and no row carrying a Xero
credit-note id) no longer blocks — and the coincident `payment.creditAppliedCents`
mirror is waived with it — but an `ADMIN_ADJUSTMENT`/`BOOKING_MODIFICATION_REFUND`
row, a net-non-zero ledger, or any Xero-linked credit note still blocks, as does
any independently captured/refunded payment.

## Public Booking Request Quote Lifecycle

A `BookingRequest` from the public form can be priced through one or more
`BookingRequestQuote` versions. Known quote statuses: `DRAFT`, `SENT`,
`ACCEPTED`, `CANCELLED`, `SUPERSEDED`.

```text
DRAFT -> SENT (admin sends; a SHA-256 response token is issued, time-limited; the
               beds are auto-held as an AWAITING_REVIEW booking, #1254)
SENT  -> ACCEPTED (requester accepts an option; booking conversion runs; the held
               booking stays capacity-holding until payment)
SENT  -> CANCELLED (requester cancels; the held booking is released and heldBookingId detached)
SENT  -> SUPERSEDED (requester asks a question / requests changes, or admin issues a newer quote;
               the hold is retained across a re-quote for the same dates, but if the request
               settles in MODIFICATION_REQUESTED / QUERY_PENDING with no outstanding quote the
               quote-expiry cron auto-releases the hold once the last response window lapses, #1254)
SENT  -> SUPERSEDED (admin DECLINES the request; the outstanding quote is retired in the SAME
               transaction as the DECLINED claim so no requester action or reminder cron can act
               on it — SUPERSEDED = admin retired it, distinct from a requester-cancel CANCELLED, #1423)
SENT  -> (link expires; the quote-expiry cron releases the held booking, frees the beds, and
          detaches heldBookingId — the request stays QUOTE_SENT so an admin can re-quote)
```

The whole quote lifecycle holds capacity (#1254). Sending a quote reserves the
beds/guest-nights before the send is finalized, so a quote is never emailed for
dates it cannot reserve: if the lodge is full the send fails with `409` and no
quote is marked SENT. The hold spans accept (the held row becomes the converted
PENDING booking and keeps holding, see the booking-status section above) and is
released on cancel, expiry, or a capacity-reduction bump (see the #1317 note in
the booking-status section above).

Decline and the hold (#1365, broadened #1423): the admin **decline** route
declines a request in any of the six held/editor states its status-guarded flip
claims — `VERIFIED`, `PRICED`, `QUOTED`, `QUOTE_SENT`, `QUERY_PENDING`,
`MODIFICATION_REQUESTED` (`DECLINABLE_BOOKING_REQUEST_STATUSES`). This is the same
set the admin panel shows the Decline button for, and every one can carry a live
`AWAITING_REVIEW` hold (a SCHOOL **manual** hold via `holdBookingRequestSlots`, or
the auto-hold-on-send #1280). A terminal/converted state
(`APPROVED`/`CONVERTED`/`DECLINED`/`CANCELLED`) or `NEW` is NOT in that set, so
decline `409`s and leaves any hold untouched. It runs **claim-first**: the
`DECLINED` flip happens FIRST, so a wrong-state decline never touches the held
booking; only AFTER the request is actually claimed does it release the hold via
the shared cancel path — cancelling the `AWAITING_REVIEW` held booking,
reconciling away its beds, and detaching `heldBookingId`, with the requester's
cancellation email suppressed (an admin decision, not a requester cancellation).
A held pointer that is stale or no longer a live `AWAITING_REVIEW` hold is simply
detached. SCHOOL requests use the same function (no type branch).

Because `QUOTE_SENT` (and other quote-bearing states) DO carry a live `SENT`
quote a requester could still act on, broadening decline reintroduces a
decline-vs-requester race. A DECLINED request is made untouchable by every other
actor:

- **Primary — retire the quote atomically with the claim.** The decline flips the
  outstanding `SENT` quote to `SUPERSEDED` in the SAME transaction as the
  `DECLINED` claim (and only when the claim actually landed, so a wrong-state
  decline still touches nothing). Since `loadSentQuoteByToken` requires
  `status === SENT`, this alone `409`s all four requester quote actions
  (accept / modify / query / cancel) on a still-live link, and makes the
  pre-expiry reminder cron — which selects only `SENT` quotes — skip the declined
  request instead of nudging it.
- **accept-wins-first:** the requester accept converts the held booking to a live
  `PENDING` booking before the decline runs. Decline passes `requireRequestHold:
  true` to the shared cancel path (#1406), which then refuses (`409`, no side
  effect) rather than clobber the just-converted booking.
- **decline-wins-first (defence-in-depth for a POST already past its token
  load):** the decline claims `DECLINED` and releases the hold first
  (`heldBookingId` detached, `convertedBookingId` still null). The concurrent
  requester's accept re-arm to `PRICED`, its modify/query re-status to
  `MODIFICATION_REQUESTED`/`QUERY_PENDING`, and the losing-accept capacity revert
  to `QUOTE_SENT` are each a **status-guarded** `updateMany` with `status notIn
  [DECLINED, CANCELLED]`. A late accept or modify/query `409`s (no new booking and
  no resurrection), and the revert simply does not un-decline the request. The
  guards deliberately still allow a re-arm from `CONVERTED`/`APPROVED` so approve's
  `convertedBookingId` idempotency replay (#1232 double-accept) keeps returning the
  one existing booking.
- **admin re-send (symmetric admin-side backstop, #1504):** the admin quote
  re-send (`sendBookingRequestQuote`) closes the same narrow TOCTOU on the admin
  side. Its flip to `QUOTE_SENT` is a **status-guarded** `updateMany` that claims
  the request only while it is still in a quoteable state (the same live set
  `holdBookingRequestSlots` requires), committed BEFORE the quote email. So an
  admin re-send racing a concurrent decline in the narrow window after the hold's
  own status check `409`s ("...has been declined or cancelled.") and delivers no
  email, instead of resurrecting the just-`DECLINED` request to `QUOTE_SENT`.

**Lock-ordering invariant (#1423):** every transaction that writes both a
`BookingRequest` row and its `BookingRequestQuote` row(s) — the decline claim +
quote retirement, quote create, quote send, and the requester cancel /
modify / query — must lock the `BookingRequest` row FIRST, then the quote row(s).
Decline is claim-first and cannot swap, so all the others match its order; a
mismatched order lets a concurrent decline deadlock them (Postgres `40P01`), which
would surface as an unhandled `500` instead of a clean `409`. Preserve this order
when editing these paths.

As of #1385 the manual **Hold slots** admin UI entry is hidden on the generic
(non-SCHOOL) quote flow: auto-hold-on-send (#1280) reserves the beds across the
whole quote lifecycle, so a separate manual hold there is redundant and confusing.
This **supersedes** the earlier #1317 stance that the manual hold was deliberately
kept for all flows — that "kept for all flows" position now applies to SCHOOL only.
The manual Hold slots button is retained ONLY for SCHOOL requests, where it stays
meaningful: a school can be approved DIRECTLY without a sent quote and school
approval reuses the held booking (#1352), so the admin may need to reserve
capacity before that direct approval. The hold action itself (the
`/api/admin/booking-requests/[id]/hold` route and `holdBookingRequestSlots`) is
unchanged and stays type-agnostic — only the UI entry point is gated, and sending
a quote still reuses any existing hold idempotently. The hold scope covers every
request-converted PENDING booking, including requests approved DIRECTLY without a
quote — intended.

Token-link outcomes the requester can see:

- Valid `SENT` link: the quote is shown with options, price, and an expiry hint.
- Not found: `404` "This quote is not valid."
- Status no longer `SENT`: `409` "This quote is no longer active." (use the latest quote email).
- Past expiry: `410` "This quote has expired." with a recover-by-contacting-the-club path.
- Accept after the lodge fills: the request reverts to `QUOTE_SENT`, the link stays
  active, and the requester is told which nights are now full.
- Any action after an admin declined the request (#1423): the decline retired the
  quote (`SENT` -> `SUPERSEDED`), so the link now returns the `409` "This quote is
  no longer active." above for accept / modify / query / cancel alike. In the rare
  case a requester POST loaded the still-`SENT` quote a moment before the
  retirement committed, the status-guarded re-arm / re-status is the backstop and
  `409`s ("...has been declined or cancelled."), creating no booking and never
  resurrecting the request.
- Accept racing the expiry / hold-release cron (owner-ratified, #1317): harmless.
  The accept and the cron both serialize on the booking advisory lock, so at most
  one side wins; the loser gets a safe conflict response it can retry, the quote
  link stays active, and no double-booking or data loss occurs.

Every requester transition (accept, cancel, modification request, question) and the
capacity-blocked accept revert is written to AuditLog with `actor: "requester"`. The
parent `BookingRequest` moves NEW -> VERIFIED -> QUOTED -> QUOTE_SENT and then PRICED
(accept), CANCELLED (cancel), MODIFICATION_REQUESTED, or QUERY_PENDING. When an admin
sends a quote, the email-delivery result is recorded so the team can tell whether the
requester actually received the link.

The response window (default 14 days) and a pre-expiry reminder lead time are
admin-configurable under Booking Policies -> Public Booking Requests. The
`quote-expiry-reminders` cron sends one reminder per quote inside the lead window,
rotating the response token so the reminder email carries a fresh working link
(set the reminder lead to 0 to disable reminders). The same cron also releases
the auto-hold behind any SENT quote whose link has expired (#1254): it cancels
the AWAITING_REVIEW held booking, reconciles away its beds, and detaches
`heldBookingId` so the freed capacity is reusable and a re-quote never reuses a
released row. This release runs even when reminders are disabled. The same cron
phase also frees holds stuck behind a MODIFICATION_REQUESTED / QUERY_PENDING
request that has no outstanding SENT quote, once the latest response window
(`max(responseTokenExpiresAt)` across its quotes) has lapsed — otherwise a
"please change X" / "I have a question" bounce would hold a bed indefinitely.
This release only fires when the held booking was itself placed on or before
that deadline: a hold that post-dates the lapsed window — e.g. an admin manually
re-held a SCHOOL request via "Hold slots" (now a school-only UI action, #1385)
after its original quote window had passed — is kept, so the next cron tick never
undoes the deliberate re-hold (#1296).

Because an admin can cancel a held booking directly (every sent quote leaves one,
tagged "Held" on the bed board), `heldBookingId` is detached wherever such a hold
is cancelled — both in the booking-cancel service and defensively in
`holdBookingRequestSlots`, which re-validates the pointed-to booking is still a
live AWAITING_REVIEW hold before reusing it and otherwise creates a fresh hold.
This stops a re-quote from reusing a cancelled row and 409-ing on accept (#1254).

School group requests share this quote lifecycle. The public form shows a soft
warning above 25 total students, teachers, and parent helpers because a club
member must host larger groups, but the hard submission limit remains lodge
capacity. Before approval, admins can adjust the bulk child counts; approval
regenerates the school guest list from the preserved teachers/parent helpers and
the adjusted counts, then reprices and rechecks capacity against that final list.
The non-login records these flows create are classified by `Member.role`, not
counted as paying members: school groups (the school contact and each teacher)
get role `SCHOOL`, and general public booking-request contacts get `NON_MEMBER`.
Both non-member roles grant no access, are excluded from member rosters, and never
owe a membership subscription (see Member roles in `docs/ARCHITECTURE.md`).

After conversion (or while a hold booking exists), the resulting booking keeps
the negotiated flat price and the standard edit endpoints refuse it — editing
a quoted booking's dates or party is done by re-pricing or issuing a revised
quote from the booking request, never by season-rate repricing
(`docs/DOMAIN_INVARIANTS.md`, #1032).

## Payment Lifecycle

Known statuses: `PENDING`, `PROCESSING`, `SUCCEEDED`, `FAILED`, `REFUNDED`,
`PARTIALLY_REFUNDED`. Known sources: `STRIPE`, `INTERNET_BANKING`.

```text
PENDING -> PROCESSING -> SUCCEEDED
PENDING/PROCESSING -> FAILED
SUCCEEDED -> PARTIALLY_REFUNDED -> REFUNDED
REFUNDED/PARTIALLY_REFUNDED -> (repay, #1765) fresh PRIMARY transaction on the
  same Payment: PENDING/PROCESSING -> SUCCEEDED
```

Booking cancellation honors these transitions (#1473): only a never-captured
payment flips to FAILED at cancel, decided on transaction-ledger capture
evidence — the aggregate mirror alone can lie, because inbound reconciliation
folds modification credit notes into `refundedAmountCents` /
`PARTIALLY_REFUNDED` on never-captured Internet Banking payments (see
`docs/DOMAIN_INVARIANTS.md`). Genuinely captured payments survive the cancel
unchanged — no *transaction* ever leaves the refunded states.

Repay-after-refund (#1765): a booking that was paid, then deliberately
refunded, then left (or re-put) in a payable status legitimately owes a fresh
payment — refund + promo reprice can produce this. The model is a **fresh
`PRIMARY` `PaymentTransaction` on the same `Payment` row**; the refunded
transaction is immutable history. Because a fully refunded Stripe
PaymentIntent keeps `status: "succeeded"` forever (refunds hang off the
charge), every reconciliation entry point discriminates *refund history* from
*crashed-webhook recovery* on the local transaction ledger, never on the
intent status: a transaction in `REFUNDED`/`PARTIALLY_REFUNDED` is history and
is never re-admitted as settlement (`markBookingPaymentSucceeded` throws;
`create-payment-intent` supersedes the stale pointer and mints a fresh
card-entry intent at the current effective price under a per-repay-generation
idempotency key `pi_<bookingId>_repay_<supersededIntentId>`), while a
transaction still `PENDING`/`PROCESSING` against a succeeded intent is genuine
recovery and reconciles exactly as before. After a repay settles, the Payment
AGGREGATE returns to `PARTIALLY_REFUNDED` (gross captured across generations
minus what was refunded), so the mirror invariant is net-based —
`(amountCents − refundedAmountCents) + creditAppliedCents = finalPriceCents`
at repay settlement (see `docs/DOMAIN_INVARIANTS.md`). The repay path assumes
no saved card: it always goes through the immediate card-entry PaymentIntent
flow.

Duplicate capture on an already-PAID booking (#1992): when a success arrives
carrying the SAME intent the booking settled with, every reconciliation path
returns `already_paid` unchanged (webhook redelivery, confirm-payment racing
the webhook, payment-link reconcile, charge-saved-method / cron reruns
replaying their `pending_charge_` Stripe idempotency key,
confirm-pending-guests retries). A success carrying a DIFFERENT intent while
another captured PRIMARY transaction still holds net cash is double money (the
residual #1967 split-child link-vs-auto-charge window) and is auto-refunded:
the duplicate's transaction goes `SUCCEEDED -> REFUNDED` via a durable
`duplicate_capture_<bookingId>_<pi>` recovery operation, the settlement
transaction and the booking's PAID status are untouched, and
`markBookingPaymentSucceeded` reports `duplicate_capture_refunded` /
`duplicate_capture_refund_failed`. A fully `REFUNDED` prior capture is history
(#1765), never a settlement a repay generation could "duplicate", and at most
one side of a capture pair is ever refunded (adjudicated under `lock(1)`).

Audit trail (#2008): the auto-refund is recorded as a durable, ADMIN-ONLY
`BookingEvent` once its recovery operation reaches `SUCCEEDED` — a `REFUNDED`
event carrying a `duplicate_capture_refund` discriminator in its `snapshot`
(`src/lib/duplicate-capture-refund-event.ts`). It is written exactly once
across the inline and cron-replay paths, each gated on the operation's terminal
`SUCCEEDED` transition (`count > 0`). Because the discriminator makes
`isDuplicateCaptureRefundEvent` true, `resolveBookingNarrative` EXCLUDES it from
the settlement finder, so a later member cancellation never misreads it as its
own refund clause. The admin booking-history timeline renders it with honest
copy ("Duplicate capture auto-refunded — the booking's settlement is
unaffected"), while the shared member/guest narrative and every member-facing
surface show nothing new. The rest of the audit trail (recovery-operation row,
`PaymentRefund` ledger entries, error log, and the dedicated #2007 admin alert)
is unchanged.

To verify: whether Internet Banking uses the same `PaymentStatus` transitions
or Xero invoice state as the effective settlement state.

## Seasonal Membership Assignment Lifecycle

```text
seed/backfill creates current-season assignment
admin previews member seasonal type change
admin enters reason and saves with matching preview token
audited assignment create/update
season roll-forward dry-run -> reviewed exceptions -> idempotent copy
```

The preview reports future confirmed bookings, draft bookings, waitlist records,
current subscription state, recent subscription history, and resulting booking
and subscription behavior. The save does not reprice existing future bookings,
rewrite subscription/payment/Xero history, or call provider systems. The saved
assignment is enforced the next time a booking is quoted, created, confirmed
from draft, joined, or repriced by an allowed modification path.

## Fee Configuration Lifecycle

```text
migration -> public membership types hidden
legacy entrance amount -> authoritative row at migration-date boundary
membership editor -> public copy/listing review -> audited save -> cache invalidation
finance editor -> validate cents/dates -> lock schedule key -> reject overlap | audited save
family billing mode = via billing member -> family recipient removed -> billing member cleared -> visible billing exception
family billing mode = members individually -> family-billing card hidden, no billing-member exceptions, PER_FAMILY create/update rejected server-side
```

The `familyBillingMode` setting on `MembershipSubscriptionBillingSettings` (edited
from `/admin/subscriptions`) selects between the two branches above. It defaults
to `BILL_FAMILY_VIA_BILLING_MEMBER`, so existing clubs keep today's behaviour.

This lifecycle creates no invoice and calls no provider. During the one-release
bridge, a category with no current entrance schedule reads its deprecated
granular/flat mapping amount; a current schedule always wins.

## Membership Subscription Charge Lifecycle

```text
annual preview (read-only) -> explicit unchanged-token confirmation -> QUEUED
new-member approval -> configured plan -> QUEUED
new-member approval -> incomplete plan -> OPEN billing exception (approval stays APPROVED)
QUEUED -> outbox claim -> invoice create OR exact existing-invoice adoption
invoice identity persisted locally -> INVOICE_CREATED -> Xero email -> EMAILED
INVOICE_CREATED -> email fails -> EMAIL_FAILED -> retry -> same invoice -> EMAILED
provider reference exists but snapshot differs -> CONFLICT (no provider rewrite)
provider reference exists but is not AUTHORISED -> CONFLICT (never emailed)
late member joins already-billed family -> FAMILY_ALREADY_BILLED exception (old coverage unchanged; no second invoice)
stale per-family schedule under individual billing -> PER_FAMILY_FEE_IN_INDIVIDUAL_MODE exception (no invoice; basis must change)
NO_INVOICE -> NOT_REQUIRED (zero-cent durable snapshot; no provider work)
age-tier not subscription-liable, no PER_MEMBER fee due -> Exempt (no charge, no MISSING_FEE_SCHEDULE; confirm writes NOT_REQUIRED; PER_FAMILY child stays family-covered)
OPEN exception -> superseding confirm run -> RESOLVED (resolvedVia CONFIRM)
OPEN exception -> edit-gated preview refresh no longer regenerates it -> RESOLVED (resolvedVia PREVIEW_RECONCILE; whole-club refresh resolves every superseded OPEN row, member-specific and club-level null-member alike; read-only GET never resolves)
```

To verify: preview digest changes with fee/recipient/due-day inputs; only finance
edit can confirm/retry/configure; explicit account/item mapping is frozen;
concurrent/replayed confirmation creates one
coverage row; fee/family changes do not mutate history; invoice identity commits
before email; email retry never calls create for a persisted invoice; exact
existing invoices are adopted; amount/contact/account mismatch becomes visible
`CONFLICT`; automatic post-approval failures never roll back approval.

## Member Subscription Status Transitions

`MemberSubscription.status` is one of `NOT_INVOICED`, `NOT_REQUIRED`, `UNPAID`,
`PAID`, `OVERDUE`.

```text
(no row) -> NOT_REQUIRED            membership type never owes (ensureDefaultSeasonSubscriptionForNewMember, billing NO_INVOICE)
(no row) -> NOT_INVOICED            billing sweep creates a billable-but-uninvoiced row
NOT_REQUIRED -> NOT_INVOICED        REQUIRED-type season assignment supersedes a stale creation-seeded NOT_REQUIRED row (reconcileSeasonSubscriptionForAssignment, #2149)
NOT_INVOICED -> UNPAID              Xero subscription invoice created (xero-subscription-invoices)
UNPAID/OVERDUE <-> PAID             Xero discovery/webhook reflects the invoice's real payment state
UNPAID/OVERDUE/PAID -> NOT_INVOICED Xero invoice observed VOIDED/DELETED (#2147): invoice link nulled, member re-billable — deliberately reads NOT locked out (was UNPAID/locked out pre-#2147)
NOT_INVOICED -> PAID (manual)       manual mark-paid (finance:edit) — sets manuallyMarkedPaidAt/By/Note, never calls Xero
PAID (manual) -> NOT_INVOICED      manual reversal when no Xero invoice link exists (clears provenance)
PAID (manual) -> UNPAID            manual reversal on a legacy row that somehow carries an invoice link (clears provenance)
PAID (manual) -> Xero-derived       a real Xero invoice links: Xero is authoritative again and the write clears the manual provenance columns
```

Guards: manual mark-paid exists for cash payments where NO Xero invoice exists,
so it is rejected (409) when the row carries a Xero invoice link ("record the
payment against the invoice in Xero instead"), when the row is already `PAID`,
and on `NOT_REQUIRED` rows (nothing to pay); manual reversal is allowed only on
a row with `manuallyMarkedPaidAt` set. Both manual writes are status-fenced
conditional updates (409 when the row changed concurrently). The annual-invoice
sweep never invoices a row already `PAID` (manual or Xero), and
`createXeroMembershipSubscriptionInvoice` conflicts
(`SUBSCRIPTION_ALREADY_PAID`) instead of minting an invoice for a charge whose
covered subscription became `PAID` while it was queued. `checkMembershipStatus`
never downgrades a manually marked-paid row that carries no Xero invoice link
(enforced by a write-time fence, not just an up-front read), and
`flushMemberSubscriptionHistory` never deletes a manual-PAID row on contact
link/push/unlink. The assignment reconcile
(`reconcileSeasonSubscriptionForAssignment`, #2149) only ever flips a row that is
still the untouched creation-seeded `NOT_REQUIRED` default (null Xero invoice, no
ACTIVE charge-coverage claim — `releasedAt IS NULL`, the #2147 "already billed"
rule, so a released claim from a voided invoice does not block the re-billable
member — and no manual mark-paid) and only when the newly-effective
type is `REQUIRED`; it is a status-guarded, idempotent `updateMany` (no advisory
lock, no provider call) that runs inside the assignment transaction, so it can
never downgrade a paid/invoiced/covered/manual row and never fires for a
`BASED_ON_AGE_TIER` type (whose `NOT_REQUIRED` row is the authoritative #2041
season-start exemption). Every manual transition is audited with the acting admin.

The annual sweep (#2147) skips a member who is already `PAID` **OR** holds a LIVE
Xero invoice link (any of UNPAID/OVERDUE/PAID) — an additive dedup guard so an
invoiced-but-unpaid member is never double-billed, while a manually marked-paid
member (PAID, null invoice link) is still skipped. On a void/delete the sync
marks the covering `MembershipSubscriptionCharge` `VOIDED` (kept for audit, never
re-enqueued), releases its coverage claim (`releasedAt` set — row kept), and
bumps `MemberSubscription.voidGeneration` so a re-bill mints a NEW charge with a
fresh idempotency key.

To verify: manual mark-paid sets PAID + provenance and never calls Xero; the
sweep skips a manual-PAID member and an invoiced-but-unpaid member; a Xero
force-sync leaves a manual-PAID row untouched; a contact link/unlink resync
leaves a manual-PAID row in place; reversal restores UNPAID vs NOT_INVOICED by
invoice-link presence; a voided invoice makes the member NOT_INVOICED and
re-billable with a new charge.

## Committee Assignment Lifecycle

```text
seed/migration creates committee master roles with role email aliases
admin creates or archives master role
admin links member to role from member detail
new assignment starts hidden/unpublished
admin edits blurb/sort/published/show-phone/contactable flags
audited assignment update or deactivate
published assignment appears on public committee surfaces
contactable published assignment can receive server-routed contact form mail through the role email alias, or the linked member email when the role email is blank
```

## Refund And Credit Lifecycle

Known credit types: `CANCELLATION_REFUND`,
`BOOKING_MODIFICATION_REFUND`, `ADMIN_ADJUSTMENT`, `BOOKING_APPLIED`.
Known admin credit adjustment statuses: `PENDING`, `APPROVED`, `REJECTED`.
Known refund request statuses: `PENDING`, `APPROVED`, `REJECTED`.

```text
refund requested -> approved/rejected -> Stripe refund or Xero credit/member credit
admin credit requested -> approved/rejected -> MemberCredit created/applied
MemberCredit available -> applied to booking -> ledger remains linked
```

To verify: all paths that update refunded totals and whether completed refund
requests are represented by status, payment/refund rows, or both.

## Waitlist Lifecycle

```text
capacity unavailable -> WAITLISTED
capacity opens/admin offers -> WAITLIST_OFFERED
offer accepted -> confirmed or paid booking
offer expires/declined -> WAITLISTED or CANCELLED
```

Cross-lodge offers (ADR-004, `waitlistOfferedLodgeId` set) accept
differently: the entry never changes lodge. Confirming re-checks the
quoted price, creates a fresh booking at the offered lodge through the
standard creation path, and cancels the waitlist entry with audit links
between the two (`WAITLIST_OFFERED -> CANCELLED` + new booking). Price
drift at confirm refreshes the stored quote and asks the member to
confirm the updated figure; every revert to `WAITLISTED` clears the
offered-lodge fields.

The admin waitlist view decorates active `WAITLIST_OFFERED` rows with the latest
`waitlist-offer` EmailLog status. Failed, exhausted, bounced, or missing delivery
records are surfaced beside the offer with a link to email-deliverability
recovery, so state changes are not hidden behind best-effort email delivery.
A booking carrying the per-booking "No emails" switch (#2258) is excluded from
waitlist candidacy, so no NEW offer is made to a member who would not be told.
The exclusion is not retroactive: a switch turned on while an offer is already
live does not retract it, and the offer commits before its email is sent, so a
flip in between leaves a live offer with a withheld send. An entry in
`WAITLIST_OFFERED` whose offer is still unexpired therefore reports
`suppressed_live_offer` with `needsOperatorAction: true` (a held bed the member
was never told about); one whose offer has already lapsed reports the benign
`suppressed`. A silenced entry still in `WAITLISTED` has no EmailLog row at all
and is marked on the board from the flag; it keeps its queue place and still
counts toward other members' positions.

## Bed Allocation Lifecycle

Known allocation source: `AUTO` or `MANUAL`.

```text
booking confirmed/paid -> auto allocation proposal
admin manually adjusts -> MANUAL allocation
admin approves -> approved allocation metadata set
booking modified/cancelled/completed/deleted -> allocation reconciliation
exclusive whole-lodge hold SET -> allocation reconciliation (pure prune)
exclusive whole-lodge hold CLEARED -> allocation reconciliation (re-plan)
```

The exclusive whole-lodge hold is a first-class reconciliation trigger on BOTH
directions (ADR-001, #2285). A held booking implicitly occupies every bed, so it
owns **no** `BedAllocation` rows: reconciliation short-circuits on the
`wholeLodgeHold` flag (not the status — a held booking sits in an ordinary
bed-allocatable status), which makes the SET a whole-booking prune that creates
nothing, and makes any later reconcile of a still-held booking a no-op that also
self-heals rows an older lifecycle wrongly created. Clearing the hold makes the
booking ordinary again, so the same reconcile re-plans its guests through the
auto-allocator — beds may come back different, and other bookings' provisional
placements may be moved or unallocated by that re-plan. Both directions run
inside the exclusive-hold route's transaction, under the per-lodge capacity
lock, so the flag and the rows can never commit apart; a school approval that
grants exclusivity prunes the same way after stamping the hold. Every write path
additionally re-reads the bookings it is about to write rows for immediately
before the write, so a hold (or cancel, or soft delete) landing between planning
and writing cannot be undone by a re-insert.

Auto-allocation plans booking-first and whole-stay-first (issue #1677). Per
booking (capacity-holding first on the lifecycle path, then createdAt/id), the
planner runs three phases after an adult-coverage carve-out (Phase 0: a
minor-night without a party adult that night or an existing adult allocation is
reported `NO_BOOKING_ADULT` and removed from demand):

1. **Whole-stay in free space** — the first candidate room (rooms already
   holding the booking's allocations, then the requested room, then sort
   order) with enough free beds on EVERY night of the stay takes the whole
   party, with best-effort per-guest bed stability (one bed across the stay
   when possible, within-room bed switches otherwise).
2. **Whole-stay via displacement** (capacity-holding bookings on the lifecycle
   path only; #1387 preserved) — a room is feasible when free beds plus beds
   held by wholly-displaceable provisional bookings cover every night. The
   displacement UNIT is a provisional booking's entire visible stay: evicted
   bookings (newest first) are relocated whole to ONE other room (`MOVE`) or
   wholly unallocated (`UNALLOCATE`) — never night-split, never a MOVE/
   UNALLOCATE mix. A booking with an admin-approved night anywhere, or a stay
   extending beyond the load envelope, is never displaced.
3. **Per-night split fallback** — the legacy whole-night/split logic for
   bookings no single room can host, reported in
   `BedAllocationPlan.roomContinuityFallbackBookingIds`; held-booking
   displacement here still uses the whole-booking primitive. Within a night
   (#1768): minors join rooms already holding the booking's adults, one adult
   then heads each further room with minors while adults last (family
   pairing), leftover adults spread first-fit, and remaining minors **overflow
   into rooms of their own** — the booking's adult count no longer caps how
   many rooms its minors may fill (pre-#1768 a school group with two teachers
   got exactly two rooms and stranded the rest as `NO_BED_AVAILABLE`). A
   booking created from a SCHOOL request (`isSchoolGroup`, derived from the
   origin or held `BookingRequest.type`) inverts the pairing preference:
   its adults room together (one room when they fit) and its students take
   their own rooms.

**Cross-booking age-mix invariant (#1768, all phases and both placement
directions):** a room-night holding minors from booking X never also holds an
adult from a DIFFERENT booking — the planner neither places a minor beside
another booking's adult nor an adult beside another booking's minor,
displacement evicts a conflicting provisional booking whole (or deems the room
infeasible when it cannot), a relocated booking is never MOVEd into a
conflicting room-night (it is wholly UNALLOCATEd instead), and an occupant row
with no booking attribution conservatively blocks minors but not adults.
Persisted rows that already violate the invariant (manual moves, pre-#1768
plans) surface on the board as `MINOR_ADULT_MIX` warnings rather than being
rewritten — warning-only on the manual board is the intended function (owner
decision 2026-07-11), not a pending hard-block. Same-booking mixing is unrestricted — Phase 0 remains the
night-level adult-coverage rule, and minors-only ROOMS are allowed whenever
the booking has an adult on-site that night.

Reconciliation widens its loads to the envelope of every booking overlapping
the reconcile range (`min(checkIn) .. max(checkOut)` union the range) so the
planner sees whole stays, while the set of bookings planned stays restricted
to those overlapping the original range (no cascade).

On the admin allocation board, dragging or menu-moving the first visible
allocated night for a guest reassigns that guest's visible allocated nights to
the target bed while preserving each date-only lodge night. Later-night moves
remain single-night adjustments. The board's "Run Auto Allocation" uses the
same whole-stay planner without displacement, and the board raises a
stay-level `ROOM_SWITCH` warning when a booking's rooms change between nights,
plus a `MINOR_ADULT_MIX` warning on any persisted room-night that mixes one
booking's minors with another booking's adults (#1768).

To verify: approval status representation, conflict handling, per-night guest
uniqueness, room continuity and whole-booking displacement behavior, and
module-disabled behavior.

## Membership Application Lifecycle

Known statuses: `PENDING_NOMINATORS`, `PENDING_ADMIN`, `APPROVED`, `REJECTED`.

```text
application submitted -> PENDING_NOMINATORS
nominations complete -> PENDING_ADMIN
admin approves -> APPROVED -> member/setup/invoice path
admin refreshes pending nomination workflow -> PENDING_NOMINATORS with fresh links
admin replaces an unconfirmed nominator -> PENDING_NOMINATORS with a fresh link
admin rejects (fallback from PENDING_NOMINATORS or PENDING_ADMIN) -> REJECTED
```

On the `admin approves` transition each person (the applicant and every family
member) is either created new (default, unchanged) or **mapped onto an existing
member** — a link + field overwrite gated by a previewed, HMAC-token-bound
second check. Mapping recomputes the outcome from advisory-locked, reloaded rows
inside the approval transaction and 409s on any drift (row or recomputed value),
so concurrent approvals of the same target serialize. A mapped applicant with an
existing login keeps its auth; a mapped non-login applicant is promoted to a
login account; mapped family members never have auth/email rewritten. Mapped
targets that already hold season coverage are excluded from new subscription
billing, and a mapped applicant defaults the joining fee to skip. Approving with
no mapping decisions is byte-identical to the create-everyone path.

An admin may reject from either pending state, but `PENDING_NOMINATORS`
applications have non-destructive recovery first. The reminder cron renews each
unconfirmed nominator link weekly for up to four automatic reminders. The admin
member-applications screen can refresh all pending nominator links immediately,
resetting that four-reminder cycle, or replace an unconfirmed nominator with
another eligible member. Rejecting a `PENDING_NOMINATORS` application remains
the fallback withdrawal/clearance path; `REJECTED` is excluded from the
duplicate-application check, so the applicant can submit a fresh application
when needed. Approval stays restricted to `PENDING_ADMIN`.

To verify: duplicate applicant behavior, nomination expiry, setup invite
creation, Xero entrance-fee invoice path, reminder renewal, admin refresh,
nominator replacement, and email retry behavior.

## Seasonal Membership Type Policy

```text
built-in type seeded -> admin reviews policy -> type edited/reordered
custom type created -> active -> archived -> reactivated
member role backfill -> current-season assignment created if missing
type assignment preview -> apply-from date/reason saved -> audited assignment update
booking quote/create/modify -> resolve season assignment/default -> member rate, non-member rate, or block
subscription display/gate -> resolve season assignment/default -> required or not required
```

Runtime booking paths resolve the policy for the booking season. `BLOCK_BOOKING`
stops owners or linked member guests with a structured policy error.
`NON_MEMBER_RATE` uses non-member nightly rates while keeping the stored member
identity. `NOT_REQUIRED` changes effective subscription lockout and display
without deleting raw subscription, payment, or Xero invoice history. Membership
type is the sole authority for the subscription-required answer (#2149): access
**role carries no exemption of its own**. `ADMIN` and `LODGE` accounts are exempt
only because — with no explicit season assignment — they resolve via the
role→default-type fallback to their own built-in `NOT_REQUIRED` types (`ADMIN` =
BLOCK_BOOKING, `LODGE` = MEMBER_RATE so the kiosk still books); a fee-paying
human holding the admin permission carries a normal REQUIRED type and owes a
subscription like anyone else. The optional assignment `applyFrom`
date is date-only metadata for mid-season changeover reporting and audit; the
guarded preview remains the required save path and existing future bookings are
not automatically repriced by a type or apply-from change.

## Nomination Lifecycle

```text
nomination token created -> nominator opens token while signed in
token expires before confirmation -> weekly reminder issues a fresh token
four automatic reminders exhausted -> admin refresh or replacement path
token accepted -> nomination recorded
all required nominations complete -> application moves to admin review
token expired/invalid/wrong user/replaced -> safe error and retry/admin path
```

To verify: token fields, expiry, reminder counters, ownership checks, replaced
token rejection, and duplicate nomination prevention.

## Partner Invite Token Lifecycle (unregistered partner)

```text
create-group names an unregistered partner email -> single-use PartnerInviteToken minted (hashed at rest) + invite email
invitee opens claim link, not signed in -> routed to /join/apply (normal membership process), then back to the link
invitee signed in with a different email -> refused (invitation was sent to invitedEmail)
GROUP_CREATE not yet approved (group memberless) -> claim refused (group not available yet)
invitee signed in with the invited email, group approved -> ADULT_INVITE filed + accepted, token confirmedAt set (single use)
token expired -> claim refused; daily cron sweep hard-deletes expired rows
admin revokes -> token hard-deleted, claim link stops working
inviter cancels own declared-partner invitation from the profile Partner card (#1754) -> token hard-deleted (own createPartnerLink tokens, unclaimed only, audited)
```

To verify: hash-at-rest, single-use `confirmedAt` guard, email-match ownership
check, memberless-group refusal, expiry sweep idempotency, admin revocation,
and the member-side cancel scope (own, unclaimed, `createPartnerLink` only).

A token minted with `createPartnerLink` (#1742) additionally forms the
CONFIRMED `MemberPartnerLink` between inviter and claimer inside the claim
transaction — see Partner Link Lifecycle below. A business conflict skips the
link (audited) without failing the family-group join.

## Partner Link Lifecycle (declared Partner/Husband/Wife, #1742)

Known statuses: `PENDING`, `CONFIRMED`. Declined, withdrawn, and dissolved
links are hard-deleted (audit log keeps history), so the pair can re-form.

```text
member requests partner by email (registered login adult) -> PENDING + email to target
target confirms from profile -> CONFIRMED (one-confirmed-partner invariant re-checked under advisory lock; other PENDING requests involving either member pruned)
target declines -> row hard-deleted (no email), initiator may re-request
initiator withdraws own PENDING -> row hard-deleted
family-group ADMIN declares a NO-LOGIN adult member of their group -> CONFIRMED in one step (no consent round-trip; "one login manages the family")
admin assigns directly (admin member-detail card) -> CONFIRMED immediately, assignedByAdminId recorded; an existing PENDING for the pair is promoted; both members emailed unless the admin chose not to notify (#1769a)
unregistered partner claims a createPartnerLink invite token -> CONFIRMED inside the claim transaction (claim = consent)
either CONFIRMED partner removes the link -> row hard-deleted, other partner emailed
admin removes any link -> row hard-deleted, both partners emailed when it was CONFIRMED unless the admin chose not to notify (#1769a); a PENDING removal emails no one
CONFIRMED link deleted (either dissolve path) -> pair's FUTURE shared double-bed second-occupant allocations swept back to the awaiting-allocation queue in the same transaction (#1756; both bookings audited, admins alerted post-commit)
member deactivated / anonymised / re-tiered off ADULT -> same sweep, single-member scope (either side of the shared bed)
```

To verify: canonical pair ordering (`memberAId < memberBId` CHECK), the
one-CONFIRMED-partner-per-member invariant (advisory locks + partial unique
indexes), ADULT-only + no-self-partner guards, pending pruning on confirm,
one outstanding outgoing request per member, the memberId-target
shared-family-group guard on the member API, and the stale-share sweep
invariant (#1756): no future `isSecondOccupant` allocation may outlive its
partner link or the active-adult precondition (see
docs/DOMAIN_INVARIANTS.md, "Double-bed shared occupancy").

## Lodge Induction Lifecycle

Known induction statuses: `DRAFT`, `IN_PROGRESS`, `COMPLETED`, `VOIDED`.
Known workflow kinds: `NEW_MEMBER`, `HUT_LEADER`, `YOUTH_TO_FULL`,
`RE_INDUCTION`.

```text
admin/application creates induction -> assigned signers review checklist
signer records overall Pass -> sign-off count increments
required sign-offs reached -> COMPLETED
admin override -> COMPLETED
admin void -> VOIDED
```

Checklist templates are versioned and active per workflow kind, so a Hut Leader
Induction can use different checklist wording from a New Member Induction.
Completing a `HUT_LEADER` induction sets the member's hut-leader eligibility
flag. Actual `HutLeaderAssignment` rows remain separate dated roster/coverage
records and are not created by induction completion.

## Membership Cancellation, Archive, And Delete Lifecycle

Known request statuses: `REQUESTED`, `APPROVED`, `REJECTED`, `WITHDRAWN`,
`COMPLETED`.
Known participant statuses: `REQUESTED`, `PENDING_CONFIRMATION`, `DECLINED`,
`APPROVED`, `REJECTED`, `CANCELLED`, `REJOINED`.
Known lifecycle action statuses: `REQUESTED`, `APPROVED`, `REJECTED`.

```text
cancellation requested -> participant confirmations -> admin review
admin approves -> local account/family changes -> Xero cancellation queued -> completed
admin rejects/withdraws -> request closed without lifecycle mutation
archive/delete requested -> second-admin review -> approved/rejected
delete approval -> eligibility re-check -> hard delete only when safe
```

Surfacing (#1938): ARCHIVE requests are reviewed on
`/admin/membership-cancellations`; DELETE requests are reviewed in the
"Admin-initiated deletion requests" section of `/admin/deletion-requests`. Both
badge the sidebar. The DELETE review enforces separation of duties — a
different admin than the requester must approve/reject (server 403 on
self-review); the queue disables the requester's own buttons to make the rule
visible. The list API (`/api/admin/member-lifecycle-action-requests`) takes an
`action` of `ARCHIVE` (default) or `DELETE` and maps the page-filter status
`PENDING` onto the lifecycle `REQUESTED` state.

To verify: financial blockers, future booking blockers, family cleanup, Xero
group/archive behavior, and email visibility.

Direct import into the cancelled end-state (#1946): the admin member CSV import
accepts an optional **Cancelled Date** column. A row with a cancelled date is
created directly as a cancelled member — `active = false`, `canLogin = false`,
`cancelledAt` = the given NZ date-only value, `cancelledReason` and
`cancelledViaRequestId` null (no `MembershipCancellationRequest` exists for a
legacy import). This produces the same terminal member fields the normal
approval transition writes, minus side effects: the import sends no cancellation
email and queues no Xero cancellation operation (a freshly imported member has
no Xero contact to cancel), and never sends a setup invite. A cancelled import
row does not claim the login for a shared email (an active member keeps it), and
a cancelled date in the future is rejected (mirrors the flow's `cancelledAt =
now`). Because the import only ever creates members and skips a row whose
email+name identity already exists, it cannot cancel an existing active member —
that remains an admin cancellation-flow action, with its blockers, confirmations,
and Xero handling. The import establishes no family links, so there is no
cross-row cancellation cascade between a cancelled primary and active family
rows in the same file; each row's status is independent.

## Family And Dependent Lifecycle

```text
family group created -> dependents/adults linked
adult invitation/request -> pending -> accepted/rejected
member creates group -> memberless FamilyGroup + PENDING GROUP_CREATE (+ bundled child requests) -> admin approve (ADMIN membership created, partner ADULT_INVITE auto-filed) | reject (bundle cascade-rejected, group stays inert)
create-group names an unregistered partner email -> single-use PartnerInviteToken minted + emailed (see Partner Invite Token Lifecycle) instead of an invitedMemberId
create-group marks the named partner as a declared partner (#1742) -> registered partner gets a PENDING MemberPartnerLink request; unregistered partner's token carries createPartnerLink (see Partner Link Lifecycle)
dependent inherits email or has explicit email inheritance source
parent link requested -> ancestors(parent) + 1 + descendants(child) <= 3 links -> linked | 422 (four-generation cap) | 422 (would close a family loop)
dependent inherits email -> walk up from the chosen parent to the nearest adult, non-archived, real-address ancestor -> store that terminal source | 422 (nobody reachable)
family removal/cancellation/delete -> relationship cleanup while preserving history
cancellation approved for a middle generation -> its dependants' links cleared, NOT re-parented -> detached members named in the response and the audit log
```

A `CHILD_REQUEST` whose family group still has zero memberships (a bundled
group-creation child) cannot be approved until the `GROUP_CREATE` request for
that group is approved first (422 guard).

Family links run to at most **four generations** (great-grandparent →
grandparent → parent → child) and two parents per member, checked symmetrically
at link time so the verdict does not depend on the order links were created in.
See `docs/DOMAIN_INVARIANTS.md` → parent/dependant links for the rule, the
writers that enforce it, and the transitive-but-flat email inheritance that goes
with it.

To verify: non-login adult confirmation, dependent age-up behavior, inherited
email changes, the four-generation cap and its cycle guard at depth, and Xero
contact synchronization.

## Email Retry Lifecycle

Known email log statuses: `QUEUED`, `SENT`, `FAILED`, `BOUNCED`.

```text
email queued -> send attempted -> sent
send failure -> retryable failed -> retried by cron
exhausted or suppressed -> admin-visible failure/suppression
```

To verify: retry backoff, suppression handling, and which business-critical
emails require admin alerts.

## Xero Outbox And Reconciliation Lifecycle

```text
local business event -> Xero outbox operation queued
worker claims operation -> provider call -> success or retryable failure
inbound webhook/event recorded -> reconciliation worker processes event
failure -> retry/backoff/admin visibility
```

To verify: status strings, stale processing reset, tenant selection, link
cleanup, and exact retry exhaustion alerts.

## Cron And Recovery Lifecycle

```text
cron request authenticated by CRON_SECRET -> task allowlist/module gate
task records run/claim -> processes due rows
success -> durable state updated
failure -> run/failure visible and retryable where business-critical
```

To verify: which cron jobs record `CronJobRun`, exact statuses, stale queue
health thresholds, and skipped-module reporting.

## Two-Factor Login Lifecycle

```text
password accepted -> JWT session issued with twoFactorVerified=false
module off -> session treated verified for normal routing
module on + unenrolled -> protected layout redirects to /login/enroll
module on + enrolled -> protected layout redirects to /login/verify
valid TOTP/email/recovery code -> server mints single-use challenge token (hashed, short TTL)
session update carrying that token -> jwt callback consumes it -> twoFactorVerified=true
client-forged session update without a valid token -> ignored, session stays unverified
invalid attempts -> per-member counter increments -> 15 minute lockout after 5 failures
```

To verify: Auth.js JWT callback claim handling, challenge-token single-use
consumption, protected route-group layout redirects, API guard rejection,
email-code expiry, TOTP skew window, recovery code single-use consumption, and
lockout reset after successful verification.

## Magic-Link Sign-In Lifecycle

Passwordless email sign-in (issue #2034, epic #2030). Additive to password
login, module-gated (`magicLink`, default off), and never an email-verification
bypass. The token is a single-use, SHA-256-hashed `MagicLinkToken` (the same
primitive as password reset).

```text
member requests link (POST /api/auth/magic-link) -> ALWAYS {success:true} (enumeration-safe)
  module off, unknown, canLogin=false, inactive, or unverified -> silent no-op, zero email
  module on + active + verified -> old tokens deleted, one fresh token minted, link emailed (magic-link-login, sensitive-log redacted)
click /login/magic?token=… -> signIn("magic-link") verify provider:
  bad format / missing / used / expired token -> rejected (generic failure)
  conditional claim updateMany({id, used:false}) count===1 -> claimed (two concurrent clicks -> at most one session)
  member gate: canLogin && active (else reject); unverified -> EMAIL_NOT_VERIFIED; forcePasswordChange -> refuse, point to Forgot password
  success -> JWT issued with twoFactorVerified=false (2FA member still routed to /login/verify)
TTL: read from LoginSecuritySetting.magicLinkTtlMinutes (#2033) via loadLoginSecuritySettings(), default 15, clamped 5..60
```

To verify: enumeration safety (4 no-op cases + zero email), module-off no-op,
the conditional-claim single-use race, expired/tampered rejection, the
archived/dependent and forcePasswordChange refusals, the unverified block, that
the emailed link's HTML never persists in `EmailLog`, and that a 2FA-enrolled
member still lands on `/login/verify`.

## Google Sign-In Lifecycle (profile-initiated linking)

Google OAuth sign-in (issue #2035, epic #2030). JWT strategy, NO adapter.
Additive to password login, module-gated (`googleLogin`, default off, plus
`GOOGLE_CLIENT_ID`/`GOOGLE_CLIENT_SECRET`). **Profile-initiated linking only** —
no account is ever created from Google, and login never matches by email
(closes the Workspace-domain takeover). Sign-in resolves a member solely by the
pinned subject id `Member.googleSub`. The single Google provider serves both
login and linking; the `signIn` callback disambiguates via a short-lived,
HttpOnly, HMAC-signed link-intent cookie set by the authenticated
`POST /api/profile/google/link/start`.

```text
LINK (signed-in member, profile > Connected accounts > Connect Google):
  POST /api/profile/google/link/start -> sets signed link-intent cookie (binds memberId), then signIn("google")
  Google OAuth round-trip -> signIn callback sees the intent cookie:
    module off -> refuse -> /profile?googleError=disabled
    email_verified !== true -> refuse -> /profile?googleError=unverified
    sub already linked to ANOTHER member -> refuse (audited) -> /profile?googleError=already_linked
    member already linked to a DIFFERENT sub -> refuse (audited) -> /profile?googleError=account_conflict
    else -> pin Member.googleSub = profile.sub (audited, security), RETURN redirect STRING
            -> Auth.js redirects BEFORE minting a session (no identity switch) -> /profile?googleLinked=1
UNLINK: POST /api/profile/google/unlink -> googleSub = null (audited); password login always remains

LOGIN (/login "Continue with Google", shown only when module on + creds present):
  Google OAuth round-trip -> provider profile() resolves by googleSub === profile.sub (login-capable only):
    no match -> unlinked -> /login?error=google_unlinked (NEVER email-match, NEVER provision)
    inactive or unverified -> refused -> /login?error=google_refused
    forcePasswordChange -> /login?error=google_password_change
    resolver throws (DB error mid-resolve) -> failed (fail-closed sentinel) -> /login?error=google_failed
    eligible -> same user shape as password login -> lastLoginAt bumped
  signIn callback: module off -> /login?error=google_disabled (even for linked members)
    lastLoginAt bump hits P2025 (member row gone -> id would dangle) -> refuse -> /login?error=google_failed
    eligible -> allow -> JWT issued with twoFactorVerified=false (2FA member still routed to /login/verify)
  jwt callback (every request): token.id resolves to NO member row -> sessionInvalidated=true
    -> auth() reads null everywhere -> single redirect to /login rendering the form
       (breaks the /dashboard<->/login loop for dangling sessions; #2229)
```

To verify: sub-path sign-in; the email-match-without-link refusal (takeover
regression — no auto-link, no provision); the unverified-email link block; the
link/unlink/re-link audited flows; the sub-already-linked-to-another and
member-already-linked refusals; archived/dependent/forcePasswordChange refusals
even when linked; the module kill-switch in both directions; that a linked
2FA-enrolled member still lands on `/login/verify`; that a resolver throw or a
dangling member id refuses/invalidates instead of minting a session (#2229);
and that every refusal renders a visible friendly message via the
`/login?error=…` wiring.

## Analytics Consent Lifecycle

Client-side state machine for the GA4 consent banner (issue #975). The module
must be enabled and `NEXT_PUBLIC_GA_MEASUREMENT_ID` configured before anything
renders at all.

```text
unknown (null) -> banner shown, Google Consent Mode defaults ALL storage to denied
visitor accepts -> choice "accepted" persisted (localStorage analytics-consent.v1) -> GA4 loader script renders + consent update granted
visitor declines or dismisses -> choice "declined" persisted -> GA4 never loads, consent stays denied
stored choice on revisit -> banner suppressed, prior choice honoured
```

To verify: the consent-mode bootstrap (`wait_for_update: 500`, default denied),
the loader rendering only when module enabled + measurement id present +
choice === "accepted", and decline/dismiss both mapping to denied.

## Site Banner Display Lifecycle

Site banners (issue #994) travel a date-window lifecycle plus a per-browser
dismissal state.

```text
upcoming -> current -> past   (inclusive NZ date-only startDate..endDate window)
active toggle off -> hidden regardless of window
visitor dismisses -> hidden in that browser (localStorage site-banners.dismissed.v1)
admin edits the banner -> updatedAt changes -> dismissal invalidated, banner re-shown
```

To verify: the admin page's current/upcoming/past split, the inclusive
date-only comparison in NZ time, and dismissal invalidation keyed on
`updatedAt`.
