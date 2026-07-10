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

Capacity-holding is not a pure function of status (#1254, refining #737). A
booking holds beds when its status is capacity-holding (PAID, COMPLETED,
CONFIRMED, AWAITING_REVIEW) **or** it is PENDING and is the converted booking of
a `BookingRequest` (an accepted-but-unpaid quote / approved request). Generic
PENDING (split-booking children #738, member "only-if-my-guests-come" holds)
still does not hold and stays bumpable. The single source of truth is
`capacityHoldingBookingFilter()` in `src/lib/booking-status.ts`; every
availability query uses it. Consequence: an accepted-but-unpaid quote booking
keeps its bed until it is paid, expires, or is cancelled, and a later member
booking can no longer bump it. One deliberate exception (owner-ratified, #1317):
an accepted-but-unpaid hold is NOT protected against a *capacity reduction* — if
an admin lowers the lodge capacity for those nights below what is booked, the
`cron-confirm-pending` job bumps/cancels the still-unpaid hold at its hold
deadline (no charge). Only an admin capacity cut can reclaim the bed; competing
member bookings still cannot. The admin "Confirm pending guests" override
(`/api/admin/bookings/[id]/confirm-pending-guests`) now runs the same
`pg_advisory_xact_lock(1)` re-read + capacity re-check before flipping a booking
to a capacity-holding status on its zero-dollar and charge-saved-card branches,
returning 409 unless an explicit overbook is requested (#1366). Its
charge-saved-card branch follows the cron's claim-first shape (#1418): claim
`PENDING -> CONFIRMED` (hold cleared) under the lock, charge outside it, then
promote to PAID. A failed or requires-action charge releases the claim back to
`PENDING` with the hold restored and (on failure) alerts admins; a captured
charge is durably recorded as a PRIMARY payment transaction before promotion,
so if the promotion fails the booking stays CONFIRMED holding its beds, admins
are alerted, and the Stripe webhook finishes the promotion idempotently —
captured money is never silently orphaned.

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
re-invoked cancel 409s and never re-enters the joiner cleanup; a third reaper
phase re-drives it, keying on an ORGANISER_PAYS group still not `CANCELLED`
under a `CANCELLED` organiser booking older than a short grace. The re-drive is
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

Independently of the money path, an admin cancelling on-behalf may choose per
action whether the member is emailed (#1705): `cancelBooking` takes an optional
`notifyMember` (default `true`) that, when `false`, suppresses every
member-facing cancellation email this cancel would send — the member email, the
linked provisional-child email, and the group-joiner emails on an organiser
cancel — and records `notifyMember: false` in the `booking.cancel` audit
metadata. The choice is honoured **only for an admin-on-behalf actor**: the
cancel route forwards it only when the actor holds `bookings:edit`, so a member
self-cancel is always notified, and the group-settlement reaper and every other
automated caller leave it unset (always notify). The refund/credit/Xero outcome
is unchanged by the choice.

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
checkIn <= today < checkOut         -> "in-progress"   (extend future nights only;
                                                         check-in locked)
checkOut <= today                   -> null            (not self-editable)

adminOverride && role === "ADMIN"   -> "admin-override" (issue #1668: date-window
                                                         locks lifted; status
                                                         eligibility + capacity
                                                         lock still enforced)
```

The admin-override mode is date-only and takes one of two pricing modes:
`shift` (pure relocation, all cents frozen, night count preserved, no fee /
settlement / Stripe / Xero — a `BookingModification` of type `ADMIN_DATE_SHIFT`
with zero deltas) or `recalculate` (the standard reprice with locked-period
clamps lifted). An over-capacity override is warn-and-confirm: the first apply
raises `OverCapacityConfirmationRequiredError` (409,
`OVER_CAPACITY_CONFIRM_REQUIRED`) and only proceeds when resubmitted with
`confirmOverCapacity: true`, recording `capacityOverridden`. Every override move
is audited as `booking.modify.admin_override` (including the admin's explicit
member-notification choice, `notifyMember`) and linked, best-effort, to the
booking's most recent APPROVED-but-unlinked change request that the move
fulfils (date-only request whose named dates equal the applied values).

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
```

Booking cancellation honors these transitions (#1473): only a never-captured
payment flips to FAILED at cancel, decided on transaction-ledger capture
evidence — the aggregate mirror alone can lie, because inbound reconciliation
folds modification credit notes into `refundedAmountCents` /
`PARTIALLY_REFUNDED` on never-captured Internet Banking payments (see
`docs/DOMAIN_INVARIANTS.md`). Genuinely captured payments survive the cancel
unchanged — there is no transition out of the refunded states.

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

## Bed Allocation Lifecycle

Known allocation source: `AUTO` or `MANUAL`.

```text
booking confirmed/paid -> auto allocation proposal
admin manually adjusts -> MANUAL allocation
admin approves -> approved allocation metadata set
booking modified/cancelled/completed/deleted -> allocation reconciliation
```

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
   displacement here still uses the whole-booking primitive.

Reconciliation widens its loads to the envelope of every booking overlapping
the reconcile range (`min(checkIn) .. max(checkOut)` union the range) so the
planner sees whole stays, while the set of bookings planned stays restricted
to those overlapping the original range (no cascade).

On the admin allocation board, dragging or menu-moving the first visible
allocated night for a guest reassigns that guest's visible allocated nights to
the target bed while preserving each date-only lodge night. Later-night moves
remain single-night adjustments. The board's "Run Auto Allocation" uses the
same whole-stay planner without displacement, and the board raises a
stay-level `ROOM_SWITCH` warning when a booking's rooms change between nights.

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
without deleting raw subscription, payment, or Xero invoice history. `ADMIN` and
`LODGE` operational subscription exemptions remain governed by access-role
helpers, separate from seasonal type policy. The optional assignment `applyFrom`
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

To verify: financial blockers, future booking blockers, family cleanup, Xero
group/archive behavior, and email visibility.

## Family And Dependent Lifecycle

```text
family group created -> dependents/adults linked
adult invitation/request -> pending -> accepted/rejected
member creates group -> memberless FamilyGroup + PENDING GROUP_CREATE (+ bundled child requests) -> admin approve (ADMIN membership created, partner ADULT_INVITE auto-filed) | reject (bundle cascade-rejected, group stays inert)
dependent inherits email or has explicit email inheritance source
family removal/cancellation/delete -> relationship cleanup while preserving history
```

A `CHILD_REQUEST` whose family group still has zero memberships (a bundled
group-creation child) cannot be approved until the `GROUP_CREATE` request for
that group is approved first (422 guard).

To verify: non-login adult confirmation, dependent age-up behavior, inherited
email changes, and Xero contact synchronization.

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
