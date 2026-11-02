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
AWAITING_REVIEW -> PENDING or PAYMENT_PENDING (officer approval after quote acceptance, the only writer of this transition, #3415) or CONFIRMED/PAID or CANCELLED
```

`AWAITING_REVIEW -> CANCELLED` is an officer's or the system's arc (review
reject, request decline, hold release), never a member self-cancel: the
member-facing cancel doors read `MEMBER_CANCELLABLE_BOOKING_STATUSES`, which
excludes it (`INV-MOD-057`, #3497).

### Minimum-stay exception foundation (#2363)

A minimum-stay violation causes **no booking-state transition** in this release.
Member booking create, member group join, and ordinary date modification (on the
live `modify` route as well as `modify-dates`) keep their blocking HTTP 400
behavior for non-admin actors. The public non-member group join now blocks at
both of its stages: the staging request never reaches `GroupBookingJoin` (no
token, no row, no email), and the verification step re-reads the current policy
set and returns a 409 `minimum_stay` outcome instead of creating the non-login
member, the PENDING child booking, the PENDING payment and the pay link — so a
rule tightened during the link's 48-hour life fails closed rather than admitting
the stay. Quote and policy-check endpoints return advisory facts, and the
booking wizard continues to show the existing message without advancing. The
authenticated responses now carry a frozen `exceptionReview` whose violations
include the policy version, so the later workflow can present one combined
review without reconstructing what the member encountered; the two PUBLIC
non-member group-join stages deliberately carry none of it — they answer with a
generic sentence and their code/outcome, and the snapshot reaches the club only
through the server log line each stage writes.

Accepting a waitlist offer can also end in **no transition at all** without
being a refusal: the same-lodge minimum-stay check runs on an unlocked read
before the claiming transaction, so the claim refuses with `CONFIRM_RETRY`
(HTTP 409) when it finds a live offer the check never classified — an entry the
offer sweep moved `WAITLISTED -> WAITLIST_OFFERED` in between, or one that
became a cross-lodge offer. Nothing is written, so the state machine is exactly
where it was and the member simply confirms again.

The `HOLD`/`NO_HOLD` value in that snapshot is policy metadata today. No
exception request is persisted and no capacity is held or released because of
it. #2365 adds the durable request/approval states, revalidation, and capacity
reservation rules. Until that work lands, capacity exhaustion, subscription or
membership refusal, duplicate member-night, authentication, payment, privacy,
invalid-date, and data-integrity failures remain hard stops with no transition
into review.

### Adult-member hosting review (#2364)

In `ADMIN_REVIEW_REQUIRED`, an adult-member hosting hazard causes **no
booking-state transition**: the booking exists and a review lives beside its
lifecycle in dedicated columns. In `ENFORCED`, the non-compliant create or
modification instead rolls back with the waivable 409 and may enter the shared
policy-exception request lifecycle; no booking transition is invented for a
write that did not commit. Once a booking exists through review mode, an approved
exception, or an explicit admin on-behalf reason, its hosting review has this
small state machine:

```
(none) -> PENDING            a hazard appears on a booking that had none
(none) -> APPROVED           create only, and only with an explicit admin
                             on-behalf reason recorded against it (D-R4)
PENDING|APPROVED|REJECTED -> (none)
                             current facts cover every affected night, or the
                             policy stops applying to this booking
PENDING|APPROVED|REJECTED -> PENDING
                             a MATERIALLY different hazard replaced the recorded
                             one (a different uncovered guest-night set, or a
                             different policy revision); the previous decision is
                             dropped with it
```

Two of those edges are the whole point. Clearing is automatic and needs no admin:
adding an adult member to the booking, adding eligible same-owner cover at that
lodge/night, removing the last uncovered guest, moving the nights, reinstating a
cancelled member, switching the policy off, or moving the booking to a lodge that
never had the rule all end the hazard the next time a relevant path touches it.
Reopening is deliberately NARROW: a renamed guest, or an extra host on an
already-covered night, is the same hazard and does not re-prompt an admin who has
already decided.

"Touches it" includes touching its #738 SPLIT SIBLING. The child borrows its
parent's adults, so the parent's own nights and guests move the child's answer;
every mutation path therefore re-derives both halves in one transaction. A
sibling always enters at PENDING — the `(none) -> APPROVED` edge needs an
explicit reason from the admin who was asked, and nobody was asked about a
booking they only reached through another one.

An accepted booking that later loses same-owner cover has a separate durable
incident lifecycle, still without changing `Booking.status`:

```text
(none) -> OPEN                 committed cover loss is reconciled after the write
                               cause: OFFICER_OVERRIDE | SYSTEM_CHANGE |
                               OWNER_DECLINED_LINKED_MOVE (INV-HOST-052)
OPEN -> RESOLVED               COVERAGE_RESTORED | BOOKING_AMENDED |
                               EXCEPTION_APPROVED | BOOKING_CANCELLED
RESOLVED -> OPEN               a later materially different uncovered state appears
```

The cause is recorded, never inferred, for the reason the resolution is: a
member's deliberate decision and an automatic change are the same absence of
cover and a very different story for an officer, and the count of each is what a
club uses to judge its own setting. `OWNER_DECLINED_LINKED_MOVE` (#3232 D3,
#3241) is the owner who was offered the linked move on their own other booking
and chose to move only the one they were editing; the decline arm of the offer is
its ONE writer, and the incident's audit history records the decision in words
beside it. It was REGISTERED ONE RELEASE BEFORE IT WAS WRITTEN, because the
colour draining during a deploy cannot deserialize a third label and the fold
read that drives this whole lifecycle selects `cause` — so a declined offer was
stored as `SYSTEM_CHANGE` until the writer shipped. `INV-HOST-052` is the rule,
the sequencing a new value of this enum owes, and the one-writer census.

A row that reaches several of the owner's bookings gives its cause and reason only
to the booking it is about, and the fold promotes by how much a cause explains —
`OFFICER_OVERRIDE` over `OWNER_DECLINED_LINKED_MOVE` over `SYSTEM_CHANGE`, never
downhill — so for one uncovered state the explained account survives whichever
drain arrives first (`INV-HOST-053`). A materially different uncovered state is a
new state and takes the incoming cause whatever its rank.

Adding a new active covering booking therefore resolves the existing incident as
`COVERAGE_RESTORED`; it does not cancel or recreate the dependent booking. The
queue item that drives this transition is part of the mutation transaction. Under
#2597, a member-standing fan-out first locks its subject `FOR UPDATE NOWAIT`, then
an ordinary producer locks its exact owner/actor Member participants with sorted
`FOR KEY SHARE NOWAIT`. A booking-request hold takes its lodge key and the exact
linked members `FOR KEY SHARE`, then re-reads every row as active and unarchived
before its versioned claim or any guest creation. Hold-first makes the standing
mutation retry; standing-first makes the hold wait and then refuse the now-inactive
member in every hosting consequence mode. Member merge takes one sorted blocking
`FOR UPDATE` set, re-plans, and sweeps late owner and actor rows before deleting the
loser. If either side cannot prove the exact attribution, the complete mutation
returns the safe retry outcome and none of the booking, member, queue or incident
states advance. Merge-generated work is actorless; the critical `MEMBER_MERGED`
audit remains its human attribution.

The “complete mutation” above means the database transaction that contains the
queue write; it is not a promise that an earlier provider or workflow phase can be
undone. Two interactive boundaries expose that distinction explicitly:

```text
Stripe capture succeeded -> confirm-payment participant retry
  -> paymentReceived=true, finalisationPending=true
  -> keep payment UI in place; check booking/payment status before retrying

Xero contact fetched -> local member created -> Xero contact linked
  -> subscription refresh participant retry
  -> memberImported=true, xeroContactLinked=true,
     subscriptionRefreshPending=true
  -> select the created member; repair subscription history; do not import again
```

Booking-approval (including admin waitlist force-confirm), member draft-confirm,
public-request and Xero action consumers announce the fixed 409 in a permanently
mounted alert and focus/scroll the action failure. A participant-fence retry that
proved rollback may restore its control. A network or unreadable waitlist
response cannot prove that, so the member-facing offer suppresses another
confirm and offers only **Reload booking status** until canonical state is read;
the zero-dollar draft and admin waitlist surfaces likewise describe the outcome
as unverified and require reload/status verification before retry. Ordinary Xero
subscription-history failures still complete the import with the existing repair
warning; only the participant-fence code takes the fixed 409 path.

The hosting review itself never reuses the shared `AWAITING_REVIEW` booking status
or the minors-only check-in block. An enforced refusal may instead enter the
durable booking-policy exception lifecycle, whose frozen capacity choice,
approval/revalidation transitions, and member/officer actions are documented in
the policy-exception sections above.

`DRAFT -> PAYMENT_PENDING` is also where a stored account-credit election is
spent (#2265). A draft carries the member's election on
`Booking.creditElectionCents` and consumes no credit while it may still be
abandoned; the pay path (`create-payment-intent`) advances the status, applies
the election clamped to the live balance and the price, and clears the column —
all in one transaction, so the transition and the money move together and a
retry cannot spend the election twice. When the election covers the whole price
the same transaction continues straight to `PAID` with a $0 SUCCEEDED payment
rather than minting a card intent — as does a draft that was repriced to $0
while the member was looking at the pay step. Any booking held in
`AWAITING_REVIEW` keeps its election through review and spends it on the
`AWAITING_REVIEW -> PAYMENT_PENDING` release instead — a transition only the
officer review route (`/api/admin/bookings/[id]/review`) writes, since every
edit door refuses `AWAITING_REVIEW` (#3500, `INV-MOD-013`); that release path claims
capacity before it settles, honouring a persisted capacity override (#1771),
and refuses with a 409 (election intact, nothing charged) when the beds are
gone. `confirm-draft` only ever settles a $0 booking, where credit has nothing
to pay, so it clears the election without consuming any. Switching to Internet
Banking consumes the election too, so the Xero invoice is raised for what the
member actually owes; when credit covers the whole price there is nothing to
invoice, so the switch is refused and the booking is settled at $0 on the pay
step instead.

The election is WRITTEN by two producers: booking-create (draft save and
review-parked creates, #2265) and the edit path (#2266) — a member editing a
`DRAFT`, an actor editing an `AWAITING_REVIEW` or `PAYMENT_PENDING` booking.
The edit refuses to write a positive election onto any other status (notably
`PENDING`: `charge-saved-method` requires PENDING and consumes no election, so
no election-bearing booking may ever sit there) and clears it when the edit
itself settles the booking at $0. Members may edit their own `DRAFT` bookings
(#2266): a draft edit changes stored numbers only — no capacity claim, no hold
stamp, no change fee — and the `DRAFT -> PAYMENT_PENDING` / `confirm-draft`
doors keep enforcing capacity and holds exactly as above.

Every transition INTO a settled status clears the election if one is somehow
still on the row (#2319), because nothing reads the column after settlement and a
non-NULL value there would advertise an outstanding request forever:
`markBookingPaymentSucceeded`'s `PAID` claim (the door the Stripe webhook, the
session confirm, the payment link, the saved-card charge and the auto-confirm
cron share), the Internet Banking reconcile's `PAID` flip and its
late-capacity-failure `CANCELLED` flip, and the repriced-to-$0 auto-pay in both
modification services — the last of which is defence in depth: no edit reaches a
review-parked booking (#3500), so a stored election meets the $0 settle only if
some later writer lets one through. A clear on a $0 settle is
silent (nothing was owed); a clear where real money was taken writes a
`booking.credit_election.unapplied` audit row that the member's booking history
renders, plus an operator alert. `PENDING -> PAID` via the public payment link is
the exception that never needs it: that route refuses a booking carrying an
election outright rather than charging the pre-credit price.

A bank-transfer booking's charge is in the member-money journal before its
`PAID` (#4628, `INV-MONEY-045`): the transitions that issue its payable invoice
(the internet-banking create into `PAYMENT_PENDING` or `CONFIRMED`, the switch
to internet banking, the school pay-on-account approval) post R01; an edit or
`CANCELLED` before payment re-states it; and the later `PAID` (the settle, or
the Internet Banking reconcile's flip, which now writes the confirmation's
ledger lines as the settle does) links its lines to that charge rather than
charging again. Every writer that sets `PAID` or `CANCELLED` is classified by
`booking-sale-status-writer-census.test.ts`.

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
captured money is never silently orphaned. One captured charge is the
exception (#4300, `INV-PAY-138`): a charge the settle refuses as
`superseded_capture` (an edit had replaced the payment it landed on) is going
back to the card, so the door releases the claim like a failed charge
(`PENDING`, hold restored, beds reconciled) for the next charge, and admins get
the `admin-superseded-capture-refused` alert. The cron and
`charge-saved-method` do the same. The next attempt
(`beginSavedCardChargeAttempt`) does not count that capture as money already
taken once its refund is in flight and owes back in full, so it charges as
usual. Otherwise it refuses, never charging on top: `superseded_capture_returning`
while only its cancel row names it, `superseded_refund_stopped` once its refund
will never run again (a person must act, from Refunds owed or Stuck States),
and `captured_primary_exists` for a capture owed back only in part. Whichever
refusal wins, the refusing door hands off every capture whose refund has not
started.

Split-booking guest-portion settlement with no card on file (#1967). A split
non-member child (#738) is normally auto-charged at its hold deadline to the
member's saved card inherited from the parent payment
(`savedPaymentMethodForBooking`, `src/lib/saved-payment-method.ts` — since
#3269 a card counts only with the `stripeSetupIntentId` that saved it beside it,
`INV-PAY-053`). But a `PAYMENT_PENDING` parent can legitimately
pay by **Internet Banking** (switch-at-pay flips the parent to `CONFIRMED` with
an IB-source payment), which leaves the parent payment with no
`stripeCustomerId`/`stripePaymentMethodId`; and a parent that paid by **one-off
card checkout** leaves a payment method Stripe refuses to charge again, which
#3269 reads as no card too — so either way the child resolves to no saved
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
is the same one the link-mint stop uses — literally the same function,
`paymentLinkExpiryForCheckIn(checkIn, clubZone) <= now` (#2870), rather than the
same expression written out twice — so the two can never disagree about
"check-in has passed". The day ends in the club's **persisted** timezone
(`INV-CONFIG-002`), read once per cron run outside every transaction and threaded
in, because resolving it is a settings query and this decision runs under both
the global and the per-lodge advisory lock. Because the child holds no capacity this is
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
to the arrive/depart and roster generate/confirm queries — since #2622 the roster
side is one shared query (`getOperationalRosterGuestsForDate` in
`src/lib/roster-eligibility.ts`) rather than a copy per surface, so the admin
roster and the hut-leader wizard cannot drift on who is blocked — so a blocked
booking's guest resolves to null server-side (arrive returns 404, roster-confirm 400) — the
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

Since #3653 (`INV-PAY-114`) that single-refund plan is the path for a plan frozen
before #3653 and for an Internet Banking settlement only. A card settlement
freezes `{ perChildRefunds }` instead, with one `organiser_child_refund_*`
recovery operation per paid child (`PENDING -> PROCESSING -> SUCCEEDED`, or
`FAILED` and retried, alerting on exhaustion). Each operation is one Stripe
refund against the combined intent; its child's refund row, mirror, Xero note,
the settlement's `SUCCEEDED -> PARTIALLY_REFUNDED -> REFUNDED` move and the
operation's close commit together, after Stripe answered. A joiner's reduction,
a joiner's own cancellation and, since #3956, an approved refund appeal on the
joiner's booking (`INV-PAY-123`, keyed `organiser_card_appeal_refund_*` by the
request) use the same operation, so a live group's settlement can now read
`PARTIALLY_REFUNDED` - still paid (`organiserHasPaidSettlement`), and the
organiser is not asked to pay again. A
refund Stripe answered `pending` and later failed moves its operation
`SUCCEEDED -> PENDING` (owed again with a fresh retry budget, first due once
Stripe's 24-hour idempotency window on its key has passed, since a retry inside
it is answered with the failed refund; alerting on exhaustion), its refund
row to `failed`, and the settlement back to the status the remaining refunds
imply (`REFUNDED`/`PARTIALLY_REFUNDED -> PARTIALLY_REFUNDED`/`SUCCEEDED`).

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
`idempotency_error` for a reused key with mismatched parameters. The
`REFUNDED` booking event commits with whichever close moves that operation to
`SUCCEEDED` - the inline refund's, or the cron's when the inline refund threw,
was refused or made only some slices - in the close's own transaction, dated by
it and for the frozen plan's total, so it is written once and never for a
refund still owed (#4145, `INV-PAY-134`). A "Paid another way" close records
only what the row's slices took from the refunds recorded on the payment, as
that event dated by the latest of them as Stripe made it - never before the
cancel - and marked as that close's (none made, none written). The page tells
each part from where it is recorded: the card's from that marked event (with
none - a cancel made before #4145 - from what the row's slices took from the
payment's recorded refunds, by the rule the close used,
`cardRefundMadeForOperation`, undated), what the record says was paid back,
and as closed by the club only what the record left unpaid
(`paidAnotherWayUnpaidCents`). A part the payment no longer held when it
closed is none of these and is not said. A refund the close recorded that
Stripe later fails, owed again on a row of its own
(`card_refund_failed_later_<refund>`, #4104), is said by that row - made again
(dated by its close), on its way, stalled (the club follows it up) or paid
another way, said with the cancel's own paid-another-way close as one total -
and taken off the part it was in, the rest keeping its date; a retry that
fails too is said by the row owing it (#4166). Which row made the refund is
what the failed-later writer recorded on that row (`madeByOperationId`: by
metadata, and among several failed-later rows, which all send the same, by the
slice it fills); a row raised before #4166 is matched by amount. A paid-another-way close's refund is told only if Stripe made it by
that close, and dated only if recorded by it. The undated part
follows the refunds as recorded now, within what the record's paid-back and
unpaid figures leave of the refund due. A cancel made before #4145 wrote its event up front,
whatever became of the refund, so a later close writes no second one; the
booking page reads an open or paid-another-way row ahead of that event.
Stated limit, the deploy boundary, both ways and history only while both
colours serve: an old image's cancel writes its up-front event even after a
new runner closed the row and recorded one (two events), and an old image's
runner closes a new cancel's row with no event (none). An edit financial
review's credit or refund landing after the cancel is never read as the
cancellation's settlement. An outstanding additional
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
booking can be converted to `PENDING` by a concurrent officer approval
(`approveBookingRequest`), which holds that lock and re-writes the held booking
by id only. The cancel therefore takes
the same lock, re-reads the status under it, and flips to `CANCELLED` only while
the status is still one of the three no-payment states; if a concurrent approval
(or another cancel) has moved it out of that set the loser returns HTTP 409 and
runs no side effects (no status flip, pointer detach, bed reconcile, audit,
email, or waitlist re-process), so a just-converted booking is never clobbered
back to `CANCELLED`. Requester acceptance (#3415) keeps the hold
`AWAITING_REVIEW`; the same under-lock re-read refuses a hold whose request is
`ACCEPTED`.

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
a concurrent officer approval converted it to `PENDING`), the cancel refuses with
HTTP 409 and takes no side effect, rather than dispatching into the generic
`PENDING` cancel branch and cancelling the just-converted booking / revoking its
brand-new payment links (#1406). The two guards close the race together: the flag
covers a conversion that commits before the outer read, the under-lock re-read
covers one that commits after it. Callers cancelling a genuine member-created `PENDING`
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

The admin `PAYMENT_PENDING -> WAITLISTED` repair (#2649) is recorded the same
way: `waitlist.returned_to_waitlist`, `booking` category, written with the
booking status change in one transaction, and carrying the id of the
`waitlist.confirm_offer_release_failed` row it resolves so the strand and its
repair link in both directions. It is offered only where that row exists and is
unresolved — the booking's own columns retain no waitlist provenance, and the
free / `PAYMENT_PENDING` / no-payment-record shape is reached by several
ordinary paths that were never on a waitlist. Of the four conditions, the two
scalar ones (`status: PAYMENT_PENDING` and `finalPriceCents: 0`) are re-asserted
inside the guarded `updateMany`; the absence of a `Payment` row and the strand
report are read under the same two locks immediately above it.

## Booking Modification Lifecycle

Known change request statuses: `REQUESTED`, `APPROVED`, `REJECTED`, and — for a
`POLICY_EXCEPTION`-kind request only — `CANCELLED` and `SUPERSEDED` (#2365) plus
`EXPIRED` (#2553, written by the hold-reaper cron). This sentence is the status
census: a narrowed type or filter list copied from it must carry all six.

```text
member/admin starts edit -> quoted delta -> local booking mutation
positive delta -> additional payment or supplementary Xero invoice
  (the Booking Modified email names it by one rule: a card ask as a card
  payment even while its failed mint waits for retry, an Internet Banking
  booking's invoice as Internet Banking - #4052)
  (minted after the edit's commit; a booking CANCELLED or BUMPED by then is
  asked nothing, and an ask a cancel landing mid-mint could not see is retired
  FAILED by the minter - the door's, the recovery runner's or a currency
  re-issue's - #4316, INV-ADDPAY-044)
uncollected additional payment -> reminder at +3 days, reminder 2 days before
  check-in, admin re-send on demand; stops at check-out (never auto-cancelled);
  a credit-release request is instead reminded weekly, four times after the request, past check-out,
  and so is a request an edit merged into once the stay has ended (INV-ADDPAY-048)
uncollected review-raised request -> WITHDRAWN by a finance officer (#3528)
negative delta -> first cancels or shrinks an unpaid price ask (#3954), then
  Stripe refund or source-linked member credit for what is left
admin review path -> REQUESTED -> APPROVED or REJECTED
edit read no primary invoice link (#3980, INV-PAY-136)
  -> claims the payment row: updateMany where {id, xeroInvoiceId: null}
     count 1 -> commits, history row marked settledAgainstPrimaryInvoice
     count 0 -> 409 "please try again", nothing applied; the retry reads the
       link and adjusts the invoice
```

**Withdrawal (#3528, `INV-ADDPAY-040`).** A request a completed financial review
raised can be taken back while it is unpaid. The transition is ordered so a
crash between its two halves converges on a retry rather than leaving a payable
intent behind a zeroed booking:

```text
officer withdraws
     not review-raised, or carries a superseded price ask -> refused (edit the booking)
     already paid -> refused (that is a refund)
     a live CREATE_ADDITIONAL_PAYMENT_INTENT recovery -> refused (try once it has minted or died)
  -> Stripe cancel FIRST, outside any lock (no-op if already cancelled)
     succeeded at the provider -> refused: that is a refund, nothing changes
     processing / not cancellable -> refused, nothing changes
  -> under pg_advisory_xact_lock(1):
       Payment.additional* zeroed behind a fence on the exact values retired
         (count 0 -> 409, whole transaction rolls back)
       ADDITIONAL row -> FAILED + withdrawnAt (the durable fact; never deleted)
       WAITING_PAYMENT supplementary invoice on that intent -> CANCELLED
  -> booking.additionalPayment.withdrawn audit row; the review task stays COMPLETED
later payment_intent.canceled webhook -> reconcile reads PAST the stamped row -> still nothing owed
```

**One ask at a time, sized to the whole outstanding balance (#3340).** A booking
edit raises ONE ask, so minting a replacement ADDITIONAL PaymentIntent queues
every other outstanding one on that payment for cancellation. That makes the new
ask the ONLY figure anybody will ever collect, and sizing it on this edit's own
delta therefore deleted the unpaid balance of the ask it replaced — two
consecutive +$70 edits on a $130 paid booking asked $70 and lost $70, silently
and permanently ([INV-PAY-047]). The ask is the edit's net PLUS the unpaid
balance of the ask it supersedes.

```text
edit raises an ask -> mint the replacement intent
  -> enqueue CANCEL_PAYMENT_INTENT for every other live or declined (#4422) ADDITIONAL intent
  -> cancel it SYNCHRONOUSLY, best-effort, BEFORE the new client secret returns
       still cancellable -> transaction FAILED, operation SUCCEEDED
       Stripe already captured it -> handed off to REFUND_SUPERSEDED_PAYMENT
       provider failure -> the queued operation stands; the recovery cron finishes
  -> each superseded ask's WAITING_PAYMENT supplementary invoice, a declined
       ask's included, re-pointed at the replacing intent (#3403, INV-PAY-140)
  -> the member's card sees only the replacing intent
REFUND_SUPERSEDED_PAYMENT completes
  -> reconcile aggregates, THEN one audit row + one REFUNDED BookingEvent
     (discriminated, so the cancellation narrative never reads it as a
     settlement) + ONE member email (superseded-payment-refunded, naming the
     corrected amount owing) + ONE admin alert
     (admin-superseded-payment-refund)
```

**A reduction retires the unpaid ask before it refunds (#3954, [INV-PAY-120]).**
A price reduction on a booking still owing an unpaid price ask is set against
that ask first, on a card-paid or a credit-paid ($0) booking alike. Only what is
left is refunded, credited or given back, by the policy tier.

```text
reduction edit, under the door's locks
  read the unpaid ask ONCE; the options, the save (and the quote) use that read
  no unpaid price ask -> settles as before
  unpaid ask = the rows' live ask (a chain holding a review-raised request -> none)
             + each ask whose mint FAILED and whose CREATE_ADDITIONAL_PAYMENT_INTENT
               recovery will still run, sized as its replay would size it
               ("retry nets it off", 9 Oct 2026); an increase's recovery a later
               ask overtook, or a re-issue that wrote its own row -> already settled
       an officer's review-charge recovery -> left exactly as set (decision B)
  -> offset = min(reduction, unpaid ask)
  -> every unpaid ADDITIONAL row since the last paid one -> FAILED + withdrawnAt
       a row captured since the read -> 409, the whole edit rolls back
  -> each waiting recovery FIRST -> SUCCEEDED (closed unminted), fenced on the
       exact status, attempts and processingStartedAt read; a deadlock -> 409
       claimed under two minutes ago -> 409 "try again in a moment"
       claimed since the read -> 409, the edit rolls back
       its retry later -> nothing to claim; a stalled runner writes nothing,
         and the intent it minted, once no row or recovery names it, is
         cancelled at Stripe (`abandoned`, best-effort, after its claim hold's
         transaction ended; logged as `reissued-ask.abandoned-intent-cleanup`;
         #4631), as it is when a stale reclaim's runner closed the recovery
         SUCCEEDED with another intent or none (#4652); a recovery reset,
         PENDING, FAILED or still claimed (even by a runner that already wrote
         another intent), or an intent it adopted by matching (#4036), keeps it
  -> enqueue CANCEL_PAYMENT_INTENT for each retired intent (same transaction)
  -> WAITING_PAYMENT supplementary invoices on it, or on a closed recovery's
       edit -> read for what they bill, then CANCELLED
       (ADDITIONAL_ASK_RETIRED_BY_REDUCTION)
  -> reconcile: the Payment mirror reads past the stamped rows
  -> what is left of the reduction -> policy-tiered refund / credit / give-back
  -> ask left over -> PENDING CREATE_ADDITIONAL_PAYMENT_INTENT for it, under an
       edit-scoped Stripe key, claimable after a one-minute grace
  -> offset beyond the retired asks' invoices, which evidence shows the primary
       invoice billed -> PENDING scoped invoice-correction CREDIT_NOTE against it,
       keyed on this edit (10 Oct 2026), raised after the edit's own note; the
       repair pass verifies or queues it. Not established -> recorded, reported
       for a person, no note
after commit, the minter
  -> runs each retired intent's cancellation now
       Stripe already captured it -> REFUND_SUPERSEDED_PAYMENT, in full
  -> ask left over -> mint under the recovery's key, and complete that recovery
       in one transaction with the row (recovery moved meanwhile -> writes nothing;
       the runner, or a later reduction, owns it) -> queue its own supplementary
       invoice, WAITING_PAYMENT on the intent (decision A)
       the recovery ended SUCCEEDED without this intent (a later reduction
         netted it off, an increase folded it in, or the runner wrote another
         intent under an amount-suffixed key), or is still PROCESSING but
         already repointed at another intent, and no row or recovery names it
         -> that intent cancelled at Stripe (`abandoned`, best-effort, after
         commit; logged as `reissued-ask.abandoned-intent-cleanup`; #4052); a
         runner claim still naming the key, or one that wrote this same
         intent, keeps it
  -> the new intent's row re-read before its invoice and secret: retired only
       when withdrawn, or FAILED with a queued Stripe cancellation, the
       supersede stamp, or Stripe reporting the intent cancelled or gone; a
       declined card (FAILED alone, still open at Stripe) is payable (#4052)
later increase while a re-issue still waits -> folds it in: one ask for both,
  the re-issue's recovery closed under the same fence, the fold recorded on the
  increase's history (its replay asks again; the re-issue's invoice waits on
  the increase's intent once minted); a stalled runner's unwritten intent is
  cancelled as a net-off's is (#4631)
chase -> reads the mirror: a cancelled ask stops, a re-issued one is chased at its new amount
```

Before #3340 the cancellation was only enqueued, so the retired intent stayed
confirmable until the five-minute cron reached it (measured at 4m05s), and the
refund that followed a capture inside that window wrote nothing at all — Stripe's
own receipt was the entire notice.

**Locked-period requests on a finished stay (#3750).** Approving a
`LOCKED_PERIOD` request whose booking's stay has finished (fully past, or
`COMPLETED`) EXECUTES it, in one transaction; on any other stay approval still
only acknowledges the review. A refusal at any step rolls the claim back, so the
request stays `REQUESTED` at its old `version`.

```text
LOCKED_PERIOD request, stay finished -> officer approves
  -> pg_advisory_xact_lock(1) -> lodge capacity lock -> fresh-role reauthorisation
  -> re-read: REQUESTED, LOCKED_PERIOD, expected version   (else claim lost, no effect)
  -> drift: booking dates + guest set still the request's original, and each guest's
       nights where the request stored them, night rows included (#4030, #4088)   (else stays REQUESTED)
  -> request names no change: the officer's entered guests (#4030), else stays REQUESTED
       entry on a request that names a change, or nights outside the stay -> stays REQUESTED
  -> CAS claim REQUESTED -> APPROVED, version + 1   (the same statement writes any officer entry,
       and the nights each guest kept, requestedChanges.keptNights (#4157))
  -> modifyBookingBatch(finishedStayCorrection) on the same transaction
       a guest's range that only repeats their own dates keeps the nights they hold (#4157)
       figures differ from the officer's check -> refused, rolled back (#4030)
       over-capacity past night -> refused until the officer confirms (whole-lodge hold: always refused)
       no active season / member-night clash / a guest who cannot be booked -> refused
       dates moved on an unpaid booking whose invoice is in a Xero-locked period -> refused
       fee on a stay with nothing captured -> recorded on the payment, collected by the pay step
  -> linkedModificationId written
  -> COMMIT, then the ordinary post-commit settlement (ask, refund, Xero, email, audit)
  (a dry run of the same sequence, rolled back before COMMIT, is the officer's quote)
```

A member's request must name a structured change — dates, guests added or
removed, or a guest's nights (#4030); a note alone is refused at submit. For an
older free-text request the officer enters the guests the member described, and
the claim stores them on the request as officer-entered on the member's behalf
(`INV-REQ-011`), so a refusal after it rolls the entry back with the approval.

The booking keeps its status (a `COMPLETED` stay stays `COMPLETED`); the money
moves on the ordinary edit paths above.

**Booking-policy exception requests (#2365).** A `BookingChangeRequest` now
carries a `kind`: the original today/past-night edit is `LOCKED_PERIOD`, and a
member request to override an eligible *soft* booking-policy failure (a
minimum-stay rule or the adult-member hosting requirement — the #2363 allowlist,
never a hard limit) is `POLICY_EXCEPTION`. A policy-exception row freezes the
complete immutable proposal (`proposalSnapshot` + its SHA-256 `proposalHash`),
the structured evidence it asks an admin to allow (`frozenEvidence`, the #2363
HOLD-if-any-HOLD aggregate) plus the denormalised `aggregateCapacityMode`, a
required `memberMessage` (trimmed, <=1000 chars), and attempt/conflict metadata
(`attemptCount`, `conflictCount`, `lastConflictAt`, `lastConflictReason`). Its
lifecycle adds three terminal outcomes to the shared enum (`CANCELLED` and
`SUPERSEDED` with #2365, `EXPIRED` with #2553):

```text
POLICY_EXCEPTION request -> REQUESTED
  REQUESTED -> APPROVED   (Booking Officer allows the exact reviewed proposal;
                           atomic canonical execution — see the follow-up lane)
  REQUESTED -> REJECTED   (declined)
  REQUESTED -> CANCELLED  (member withdrew the proposal before a decision)
  REQUESTED -> SUPERSEDED (a newer proposal, or live-booking drift, replaced it)
  REQUESTED -> EXPIRED    (#2553: nobody decided it before its capacity hold's
                           deadline, so the reaper cron released the beds)
```

Every non-`REQUESTED` state is terminal (a guarded `updateMany` on
`status = REQUESTED` plus the integer `version` token enforces the single
transition, exactly the `BookingRequest.version` discipline, #1923). A held
request does NOT change its live booking; a held modification request reserves
only the incremental per-night capacity beyond the unchanged live booking. The
reservation ledger keys to a `BookingChangeRequest`, so new-booking requests (the
separate `NewBookingPolicyExceptionRequest` store) do not yet hold a provisional
reservation — their approval rechecks capacity instead — until the new-booking
hold lands with the Booking Officer approval screen (#2526).

**The provisional-reservation and atomic approve-and-execute lane is built
(#2525).** Each held request materialises its footprint as
`PolicyExceptionReservationNight` rows that the canonical capacity calculation
counts as occupancy, so a pending request cannot be oversold. The four
releasing transitions — `REJECTED`, `CANCELLED`, `SUPERSEDED`, `EXPIRED` — delete
those rows in the SAME guarded transaction that writes the status, under the
global -> per-lodge lock order: the member-owned CANCELLED and SUPERSEDED in
`booking-exception-request-service.ts`, and the officer REJECTED plus the reaper's
EXPIRED in `resolvePolicyExceptionRequestTerminal`
(`booking-exception-execution.ts`). A lost claim releases nothing.
`REQUESTED -> APPROVED` is different: it does
not "release then create". Inside ONE transaction the approval reauthorizes from
fresh DB roles, re-reads under the global -> per-lodge locks, re-checks the
proposal hash and `classifyPolicyExceptionDrift` (a disappeared reviewed rule
executes WITHOUT an override; a materially-changed or new violation keeps the
request `REQUESTED` for resubmission), rechecks capacity for a NO_HOLD aggregate
(a conflict keeps it `REQUESTED` with a recorded reason rather than failing it),
claims `REQUESTED -> APPROVED` with the `version` CAS, releases the reservation,
and invokes the now transaction-aware canonical booking service
(`createConfirmedBooking` / `modifyBookingBatch`) so the reserved beds become the
executed booking's own beds with no mark-approved-then-call-service gap. Provider
work and the member approval/rejection notice run after commit. See
`docs/CONCURRENCY_AND_LOCKING.md` -> "Provisional reservations for held
policy-exception requests".

**An abandoned hold expires (#2553).** A request nobody ever decides used to hold
its beds forever. Every request that actually reserves beds is therefore stamped
at creation with an immutable `holdExpiresAt`: seven days
(`POLICY_EXCEPTION_HOLD_TTL_DAYS`), never past the start of the first night it is
holding, and never less than 24 hours
(`POLICY_EXCEPTION_HOLD_MIN_TTL_HOURS`) so a late request still gets a real
review window. The deadline is stamped once and never rewritten, so a member's
expiry date cannot move under them. The `policy-exception-hold-reaper` cron
(`src/lib/cron-policy-exception-hold-reaper.ts`, every 3 hours in the general
cycle) then closes each past-deadline hold through
`resolvePolicyExceptionRequestTerminal` with `to: "EXPIRED"` — the SAME guarded
claim and atomic release the other three terminal outcomes use, so there is no
second release implementation to drift. Three things bound it: it only scans
`REQUESTED` + `POLICY_EXCEPTION` + `HOLD`-aggregate rows that still have live
`PolicyExceptionReservationNight` rows, so a request stranding no capacity (a
`NO_HOLD` aggregate, or a HOLD aggregate whose incremental footprint came out
empty) is never closed by a cron; the `version` CAS means a decision landing in
the same window wins and the reaper releases nothing; and a past-deadline row the
shared transition refuses outright (not a policy-exception row, or an unparsable
`proposalSnapshot`) is counted as `unresolvable` and logged at warn, because
unlike a lost claim it can never self-heal. Each expiry leaves three records: the
`EXPIRED` status the member and officer surfaces read, a
`booking-policy-exception-request.expired` audit row, and a
`policy-exception-request-expired` courtesy email to the member who raised it.
Both side effects run strictly AFTER the release commits and neither can affect
it — a failed audit write or a bounced email is logged and swallowed, so it can
never roll back a release, re-run one, or stop the reaper closing the run's other
holds. The member's one-open-request slot is freed, so a lapse never locks them
out of raising a fresh proposal.

**Member request surfaces (#2524, wired to #2525).** #2524 builds the
request-CREATION half of that flow (creation, member cancel, member supersede, the
officer queue read and the on-request notification). Integrated with #2525, that
same service now HOLDS the incremental provisional reservation for a held
modification and RELEASES it atomically on member cancel / supersede; the officer
approval + reject half is the #2525 execution engine, assembled behind the Booking
Officer approval route (#2526). Because a
`BookingChangeRequest.bookingId` is a required FK, a NEW booking has no row to
attach to, so new-booking proposals get their own dedicated store,
`NewBookingPolicyExceptionRequest`, sharing the same `BookingChangeRequestStatus`
lifecycle, the same immutable proposal/hash + frozen-evidence + `memberMessage`
discipline, and the same integer `version` claim token. A MODIFICATION request
stays on the `POLICY_EXCEPTION` `BookingChangeRequest` above. Both enforce a
**one-open-request rule race-safely at the database**: a `REQUESTED` row holds a
deterministic `openStateKey` slot (`nbpe:{memberId}:{proposalHash}` for a new
booking, `pe:{bookingId}:{memberId}` for a modification) under a NULL-distinct
unique index, and every terminal transition NULLs it — so a losing concurrent
create races into a unique violation (mapped to 409) rather than a second open
row, and a `LOCKED_PERIOD` row (which never sets the slot) is unaffected. Cancel
and supersede are the guarded single transitions above; a supersede that loses
its `REQUESTED -> SUPERSEDED` claim creates NO replacement. The Booking Officer
queue read merges both stores into one age-ordered view.

**The officer decision is wired (#2526).** The Booking Officer's queue is a
dedicated *Policy Exceptions* tab on Booking Requests, and
`PATCH /api/admin/booking-exception-requests/[id]` is the decision. Approving is
NOT a status flip: the route assembles the real #2525 hooks
(`src/lib/booking-exception-approval.ts`) and the engine claims the request AND
runs the canonical booking service in the same transaction, so the request
becomes APPROVED only if the booking was really created or really changed. Every
other outcome leaves the row exactly as it was and is reported as such — a
capacity conflict answers "still pending", never "approved". Because the engine
now takes a `PolicyExceptionRequestStore`, the SAME algorithm decides both
tables; the new-booking store's reservation release is a no-op, since a
new-booking request holds no beds while it waits.

```text
officer decision (both stores)
  approve + confirm -> executed            (booking created / change applied)
                       + followUpFailed    (committed; post-commit work threw)
                    -> claimLost           (409: the queue was stale)
                    -> notAuthorized       (403: fresh-DB roles refuse)
                    -> proposalDrift       (409: live booking or delta moved)
                    -> proposalUnreplayable(409: pre-format row; booking unmoved)
                    -> policyDrift         (409: a reviewed rule materially changed)
                    -> keptPendingCapacity (409: still REQUESTED, conflict recorded)
                    -> needsSettlementMethod (400: price drops, no refund choice)
                    -> guest refusal       (403/400: the party is not bookable)
  refuse + reason   -> REJECTED            (reservation released atomically)
```

`executed` is terminal even when `followUpFailed` is set: the transaction has
committed, so the request IS `APPROVED` and the booking IS real. Only the
post-commit phase (provider hand-offs, audit rows, the member email) failed, and
the officer is told exactly that rather than being told the request is still
pending — a "pending" answer after a commit is the one thing this state machine
must never produce.

Where the capacity recheck runs depends on whether the store's held requests
actually reserve beds (`holdsReservation`). A modification request holds an
incremental reservation, so its recheck runs AFTER the release (its own beds must
not count against it) and its conflict is recorded in a separate transaction,
because the signal that keeps it `REQUESTED` rolls the approval transaction back.
A new-booking request holds nothing, so it is rechecked BEFORE the claim and its
conflict commits in the one transaction that commits. Either way
`conflictCount` / `lastConflictAt` / `lastConflictReason` are written, which is
what lets both the officer's card and the member's own list say "the lodge is
full" rather than showing a silent `REQUESTED`.

**The member's own view of that lifecycle (#2562).** The member-facing request
area does not add a state; it PROJECTS the stored ones, and the projection is a
pure function in `src/lib/member-exception-requests.ts` shared by every member
surface, so there is only one place a status can be turned into a word. Six stored
statuses become seven member-visible ones, because `REQUESTED` splits in two:

```text
REQUESTED, no conflict recorded  -> pending
                                    ("With the Booking Officer")
REQUESTED, lastConflictAt set    -> pending-capacity-conflict
                                    ("Waiting - the lodge was full")
APPROVED                         -> approved   ("Approved and booked")
REJECTED                         -> refused    ("Not approved")
CANCELLED                        -> withdrawn  ("Withdrawn by you")
SUPERSEDED                       -> superseded ("Replaced by a newer request")
EXPIRED                          -> expired    ("Lapsed")
```

The split is the point, not a nicety: a request an officer has already tried to
apply and the lodge stopped is a materially different thing to tell somebody than
a request nobody has opened, and collapsing them reads as "nobody has looked" — a
statement the member would act on. A conflict counts as live only while the row is
still `REQUESTED`; once it is decided, withdrawn, replaced, expired or executed, an
old conflict is history and stops colouring the row. The mapping is exhaustive over
the Prisma enum (a `never` assignment), so a status added later cannot default into
a friendly word.

Two derived facts travel with each row and are deliberately NOT restatements of the
status. `capacityHeld` is read from the reservation ledger, never from
`aggregateCapacityMode` — false for every new-booking request whatever its mode
says, and false for a modification whose incremental footprint came out empty (a
pure shrink) — and `canWithdraw` / `canReplace` are derived from the very condition
the cancel and supersede services' guarded claims name (`status = REQUESTED`), so
the UI cannot offer an action the API would answer with a 409. A replacement is a
new frozen proposal reached through the wizard that built the original, not an edit
of the stored one: the officer decides the exact proposal that was frozen.

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

In `"in-progress"` mode the plan that prices the change
(`buildInProgressGuestRangePlan`) works from each guest's canonical
`BookingGuestNight` set, not from their `stayStart`/`stayEnd` envelope
(#2736, `INV-MOD-025`). A guest with a gap in their stay keeps the gap: it is
not charged, not written back as a night row and not given a bed, while an
extension still buys contiguous new nights after their last held one. The edit
also sells only the nights it creates (#2743): a night is added to an existing
guest only when the check-out actually moves, and only past the OLD check-out,
so an edit that leaves the dates alone — a guest added or removed, a promo or
member-link change — cannot add a night to anybody. (A name-only edit never
reaches this plan: it is identity-only on both routes and takes the
price-preserving echo.) The discriminator is whether a guest's held nights reach
the BOOKING'S own check-out, not whether they have gone home, so a guest who is
in the lodge tonight but leaves before the booking does gets the same gap and the
same smaller bill as one who left a week ago. Extending the check-out does still
admit every remaining guest for the nights it adds — this plan overrides
`guestStayRanges` for existing guests and the panel offers no per-guest end date
on an in-progress edit, so an API caller that sends one is ignored rather than
refused, and the officer sees the cost as one aggregate quote line for the whole
party. Because nobody is back-filled, a removal can leave `Booking.checkOut`
ahead of the last night anybody holds; that is accepted rather than guarded.
A night the edit gives back is credited at the price the member paid rather than
at today's season rate, and the per-night rows written back are each night's real
rate rather than the guest's average (#2744, `INV-MOD-025`). Since #4317 a guest
strand whose stored rows do not carry a non-negative integer price for every
night they hold, or do not sum to its stored total, is valued by
`valueStrandNights` (`INV-MOD-028`): usable rows keep their figures and the rest
of the stored total is split evenly, so what the edit credits and keeps always
adds up to what the guest was charged. The planner always prices; it has no
review branch. Its windows come from the guest's held night rows, not the stored
stay envelope (`INV-DATE-020`). The today's-rate valuation and the refund
ceiling that once stood behind it stay gone.
For an ordinary stay that runs to the booking's check-out, every number is
exactly what it was before. Bookings edited before those fixes keep the rows and
the price they were given — history is not repriced (#2745 carries the decision
about whether anything is done about them). Two edits are newly refused, both
because the booking would be left with NOBODY in the future window: a check-out
pulled back past the last night any remaining guest still holds, and a save on a
booking whose check-out is still ahead but whose guests have all finished their
stays. Both name a check-out the plan will actually accept — the suggestion is
clamped at the edit window, without which #2743's own shape would name a date
every guard rejects and the booking would be editable by no route at all. The last
money shape stated rather than fixed on this path is now fixed too (#2756): the
plan priced each guest on their own, so nights an in-progress edit newly BOUGHT
carried no group discount; it prices the whole party in one pass per window, and
a night the guest already holds is valued identically on both sides of the edit so
nothing already bought moves — see `INV-MOD-025`. The same change fixed a wider
fault behind it: every edit path built its season data without the season's `type`,
so on the DEFAULT summer-only setting no edit of any kind could qualify for the
discount, whichever planner ran. Season loading now goes through the one
`toSeasonRateData` mapper, which is a price change to ordinary edits as well —
see `INV-MOD-006`.

Because that price change reaches a club on the default setting, the club now has
a say in it (#2770). `GroupDiscountSetting.applyToEdits` decides whether a booking
edited later earns the group discount on the nights that edit newly buys, and it
governs this planner exactly as it governs the ordinary one: both
`calculateModifiedPricing` and the modify-quote route read the setting once and
hand the SAME resolved value to `buildInProgressGuestRangePlan` and to the
ordinary pricing pass, so the two branches cannot price a night differently. The
default is on, which is what every edit path already did, so no club's prices move
because the switch exists; switched off, the nights an edit buys price exactly as
they would at a club with no group discount at all, and nights a guest already
holds keep their stored price in either state — see `INV-MOD-026`.

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

Financial history outlives its booking (`INV-MONEY-043`, #4514): the database
refuses to delete a booking that a ledger line, journal leg, credit row, group
settlement, payment or refund record names. Only a `DRAFT` is ever hard-deleted —
by its owner or an admin, or by the nightly `draft-cleanup` when it expires —
and a draft never carries money. One that did would be refused with 409
(`financial_history`), nothing written, or left out of the cron's batch and
reported; money arriving between the cron's read and its delete rolls the whole
batch back.

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

Soft-delete also reaches out to Stripe, **after** its transaction commits
(#2700, `INV-ADDPAY-036`). The blockers above count CAPTURED payment history, so
an intent that has not captured yet is exactly the state they permit — and
exactly the state that can capture a moment later, because deleting a booking
does not by itself touch Stripe. The delete therefore cancels the booking's
in-flight PaymentIntents, both the base one and the modification one, once the
booking row is durably deleted: outside the transaction so no provider round
trip is made while `pg_advisory_xact_lock(1)` is held, and never throwing, so a
Stripe outage cannot turn a completed deletion into an error the admin would
retry. The local `PaymentTransaction` is marked FAILED **only** when Stripe
confirms the cancel; `canceled: false` means the intent reached a terminal state
on its own — possibly `succeeded` — and writing FAILED there would be a lie.
A cancellation that fails is audited as
`booking.delete.payment_intent_cancel.failed` (`outcome: "failure"`) as well as
logged. This makes the race rare rather than impossible; a capture that still
lands is handled by the manual refund task lifecycle above.

## Public Booking Request Quote Lifecycle

A `BookingRequest` from the public form can be priced through one or more
`BookingRequestQuote` versions. Known quote statuses: `DRAFT`, `SENT`,
`ACCEPTED`, `CANCELLED`, `SUPERSEDED`.

```text
DRAFT -> SENT (admin sends; a SHA-256 response token is issued, time-limited; the
               beds are auto-held as an AWAITING_REVIEW booking, #1254)
SENT  -> ACCEPTED (requester accepts an option atomically with the request; the
               AWAITING_REVIEW hold stays capacity-holding until officer approval or decline)
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
quote is marked SENT. Acceptance retains the `AWAITING_REVIEW` hold for officer
review (#3415); only officer approval converts it. Requester cancel and quote
expiry can release an unaccepted hold. Officer decline can release an accepted
hold after retiring the request (see the booking-status section above).

Decline and the hold (#1365, broadened #1423): the admin **decline** route
declines a request in any of the seven held/editor states its status-guarded flip
claims — `VERIFIED`, `PRICED`, `QUOTED`, `QUOTE_SENT`, `ACCEPTED`, `QUERY_PENDING`,
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

Correction and the quote (#2936): an officer may **correct** an unconverted
request — its dates, its party, its catering preference, its school name and its
contact details — from the six undecided states in
`CORRECTABLE_BOOKING_REQUEST_STATUSES` (decline also admits `ACCEPTED`), and
correcting it **re-opens** it. Every `DRAFT` and `SENT` quote flips to
`SUPERSEDED` in the same transaction as the
correction's status-and-version-guarded claim, `priceCents` is cleared and the
request returns to `VERIFIED`, so no price or quote can outlive the shape it was
computed from. `SUPERSEDED` again rather than `CANCELLED` — an officer retired
it — and again it is what kills the requester's live link, since
`loadSentQuoteByToken` requires `SENT`.

An **accepted** quote blocks the correction outright (`409`), on either
evidence: a quote row at `ACCEPTED`, or the request's own `acceptedQuoteId`,
which is set atomically with quote acceptance before any officer conversion.
Declining the agreement is the officer's deliberate act; editing cannot re-open
it. The claim itself additionally fences on `convertedBookingId: null` and
`acceptedQuoteId: null`, so the refusal holds under a race as well as at the
guard.

The hold follows decline's shape exactly: claim first, then release the
`AWAITING_REVIEW` hold through the shared cancel path with
`requireRequestHold: true`, then tell any member guests the hold had notified. A
correction that changes ONLY the catering preference keeps the hold — that is the
one corrected field a hold does not read. A release that fails is reported as a
correction that SAVED with its beds still held, never as a failed save, and so is
every other post-claim failure: the whole block is wrapped the way decline's is.

Beds a correction keeps, or fails to release, are swept by
`cron-quote-expiry-reminders`' stale-hold phase **once the request's last quote
response window has lapsed**, which is what selecting `VERIFIED` alongside
`MODIFICATION_REQUESTED` and `QUERY_PENDING` bought — `VERIFIED` is where a
correction leaves the request, and the expiry phase cannot see it because the
correction has just superseded the `SENT` quote that phase selects on.

**That qualifier is load-bearing, not throat-clearing.** The deadline is
`max(responseTokenExpiresAt)` across the request's quotes, and only a SENT quote
ever writes one — so a request that has never had a quote sent has no window, no
deadline, and is skipped on every tick for ever. Beds held on such a request by
the officer's own "Hold slots" and then kept by a catering-only correction (or
left behind by a release that failed) have **no** cron recovery at all; the
officer's Release button is the only thing that frees them. That is the same rule
that protects a deliberate re-hold (#1296) rather than a gap in this sweep, and
it is why the page says "once the window lapses" rather than "are swept".

**Correction and response fences (#2936, #3415).** A correction leaves the live
`VERIFIED` state, so the historical exclusion of only `DECLINED`/`CANCELLED`
could not protect the corrected envelope. Quote save claims the request's
`version`; quote send claims the quote while still `DRAFT`/`SENT`. Acceptance
takes `pg_advisory_xact_lock(1)`, re-reads the `SENT` quote and its request-owned
`AWAITING_REVIEW` hold, and claims `QUOTE_SENT -> ACCEPTED` with null accepted and
converted pointers. The quote's `SENT -> ACCEPTED` claim commits in that same
transaction; a lost claim rolls both writes back. Acceptance creates no payment
or conversion. A matching already-accepted retry is read-only, including after
officer approval, and never re-arms `PRICED`.

`MODIFY` and `QUERY` also take the global lifecycle lock (#3415, superseding
#2936's deliberately unfenced message writer). They re-read and claim the
loaded-version `QUOTE_SENT` request with no accepted pointer, require the quote
still `SENT`, then supersede that quote. A response that loses to acceptance,
correction, decline or cancellation returns `409` before changing either record.
See the [locking guide](CONCURRENCY_AND_LOCKING.md).

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
- **accept-wins-first:** acceptance leaves the request `ACCEPTED` and its hold
  `AWAITING_REVIEW`. An officer may still decline: the guarded `DECLINED` claim
  precedes release through the shared cancel path. Generic cancellation refuses
  an `ACCEPTED` linked request under the global lock; decline's prior retirement
  makes its release permissible. `requireRequestHold: true` requires the held
  booking to remain `AWAITING_REVIEW`, rather than detecting quote acceptance.
- **decline-wins-first (defence-in-depth for a POST already past its token
  load):** the decline claims `DECLINED` and releases the hold first
  (`heldBookingId` detached, `convertedBookingId` still null). The concurrent
  requester's acceptance and modify/query responses require the exact
  `QUOTE_SENT`/`SENT` pair under the global lock. A late response `409`s without
  resurrecting the request, changing its accepted terms, or creating a booking.
- **approval-wins-first:** only officer approval converts the hold. Its version
  claim prevents a stale decline from retiring the converted request; a hold
  release also refuses a booking that has left `AWAITING_REVIEW`.
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

### Member whole-lodge requests (#2263)

A signed-in member may ask for sole occupancy of the lodge
(`POST /api/booking-requests/whole-lodge`). The row is an ordinary
`BookingRequest` — no new `BookingRequestType` and no new
`BookingRequestStatus` — discriminated everywhere by
`requestedByMemberId != null && exclusivityRequested`. It is the ONLY member-origin
kind of booking request; a public or school request always has
`requestedByMemberId` null.

```text
(member submits) -> VERIFIED   (no email verification: the requester is signed in,
                                so no verification token is ever issued; verifiedAt
                                is stamped at creation and the row lands straight
                                in the officer queue holding NO capacity)
VERIFIED -> APPROVED -> CONVERTED  (officer approves with a priced headcount; a
                                CONFIRMED booking is created, owned by the
                                requesting login member, with wholeLodgeHold
                                stamped by the approving admin. With the
                                Internet Banking and Xero modules both on it
                                carries NO Payment row: the member pays from
                                the booking page by card, or switches it to
                                Internet Banking, which mints the receivable
                                and raises the invoice then — the same
                                CONFIRMED -> PAID settlement every card or
                                IB capture takes. Credit the member asked for
                                on the request is applied at approval; credit
                                covering the whole price lands it PAID here.
                                With either module off, the legacy shape: a
                                PENDING INTERNET_BANKING Payment row invoiced
                                post-commit)
PRICED   -> APPROVED -> CONVERTED  (same transition, defensive: see the note
                                below — nothing sanctioned puts a member-origin
                                row in PRICED, and the approval accepts it
                                anyway rather than dead-ending a row that
                                somehow got there)
VERIFIED -> DECLINED           (officer declines; the note is audit-log-only)
VERIFIED -> CANCELLED          (the MEMBER withdraws it)
```

Opening card entry leaves the unpaid approval CONFIRMED with an uncaptured
Stripe PRIMARY attempt. It still reaches the applied-credit clamp, $0
settlement and finished-stay collection queue (`INV-PAY-140`); received,
refunded, invoiced or unverified payment evidence does not enter that branch.
Concurrent Internet Banking switches re-read the payment source under the
existing global/lodge locks and replay the winner's persisted hold fields
without another receivable (`INV-LOCK-002`); the replay re-runs the
idempotent invoice enqueue after the transaction.

**Why `PRICED` appears above when the prose below says these rows never reach it.**
Both are true and the difference matters. Nothing sanctioned can price a
member-origin row: `priceBookingRequest` throws `409` for it and the admin queue
offers no price control. But `approveMemberWholeLodgeRequest`'s status guard, and
its `updateMany` claim, both accept `{ VERIFIED, PRICED }`. That is deliberate
tolerance rather than an admission that the state is reachable: if a future change
(or a hand-run database fix) leaves such a row in `PRICED`, the officer can still
approve it instead of meeting a `409` on a row with no other way forward. The
guard is a wider door than the pipeline can currently reach — the narrow
statement "these rows never reach `PRICED`" describes what the code PRODUCES, and
this diagram line describes what the approval ACCEPTS.

**The quote lifecycle is refused, at the service layer.** `createBookingRequestQuote`,
`sendBookingRequestQuote`, `holdBookingRequestSlots` and `priceBookingRequest` each
throw `409` for a member-origin whole-lodge row, and the admin queue hides their
buttons. Hiding is the UX; the 409 is the guarantee. The reason is not tidiness:
quote-send auto-holds capacity (#1280), the quote email is a member-visible
pricing surface the design excludes, and requester-accept mints a duplicate
non-login member for somebody who already has a login account. So these rows
never reach `PRICED`/`QUOTED`/`QUOTE_SENT`/`QUERY_PENDING`/`MODIFICATION_REQUESTED`
and never carry `heldBookingId` — the shared pipeline still handles those states
if a row somehow acquires one, but nothing sanctioned produces one.

**Withdrawal** (`POST /api/booking-requests/whole-lodge/[id]/withdraw`) is a
status-guarded `updateMany` to `CANCELLED` whose WHERE also names
`requestedByMemberId` (ownership is part of the claim, so another member's id
behaves exactly like a non-existent one) **and `heldBookingId: null`**. That last
clause is load-bearing: member withdraw has no hold-release machinery, so
cancelling a row that holds beds would strand an `AWAITING_REVIEW` hold forever
with nothing left to release it. The blocked member gets the fixed `409`; the
resolution path is admin **decline**, which does release holds. Any stray `SENT`
quote is retired to `SUPERSEDED` in the same transaction, request row locked
first (the #1423 lock-ordering invariant). The loser of a
withdraw-vs-approve/decline race gets the same `409`.

**Decline** on a member-origin row keeps the officer's note in the audit metadata
ONLY: `declineReason` stays null on the row, and the decline email renders its
fixed generic body with no note and nothing derived from availability. The
school/public `declineReason` is the field the requester is SHOWN, and an
availability-derived sentence in it would be exactly the disclosure ADR-001
decision 6 forbids. Not persisting is deliberately stronger than
persist-and-filter: a null column cannot be leaked by a surface added later.

**Retention (owner decision OD-B).** `purgeExpiredBookingRequests` hard-deletes
member-origin `DECLINED` rows (already covered by the declined sweep) and
member-origin `CANCELLED` rows on the same 90-day clock. The `CANCELLED` sweep is
scoped to `requestedByMemberId != null` because a public request also reaches
`CANCELLED` (a requester cancelling their own quote) and OD-B decided retention
only for the member-origin flow. "My requests" therefore shows a bounded history,
and its copy says so.

**Member merge.** `BookingRequest.requestedByMemberId` is classified `move` in
`MEMBER_MERGE_RELATION_SPECS`: a loser's requests re-point to the surviving
member, who then owns them in "My requests" and may withdraw them. A merge can
transiently push the master past the 2-open-request cap. That is accepted: the
cap is a **creation-time guard, not an invariant** — it stops a member opening a
third request, and nothing in the system reads it as a promise that no member
ever holds more than two.

Token-link outcomes the requester can see:

- Valid `SENT` link: the quote is shown with options, price, and an expiry hint.
- Not found: `404` "This quote is not valid."
- Accepted quote: a durable read-only confirmation shows the accepted stay and total, including after the original token expires; the officer later approves or declines it.
- Replaced or requester-cancelled quote: a named terminal response points to the club or the most recent quote.
- Past expiry: `410` "This quote has expired." with a recover-by-contacting-the-club path.
- Any action after an admin declined the request (#1423): the decline retired the
  quote (`SENT` -> `SUPERSEDED`), so the link now returns the `409` "This quote is
  no longer active." above for accept / modify / query / cancel alike. In the rare
  case a requester POST loaded the still-`SENT` quote a moment before the
  retirement committed, the exact `SENT`/`QUOTE_SENT` claim under the global lock
  is the backstop and `409`s, creating no booking and never resurrecting the
  request (#3415).
- Accept racing the expiry / hold-release cron (owner-ratified, #1317): harmless.
  The accept and the cron both serialize on the booking advisory lock, so at most
  one side wins; the loser gets a safe conflict response it can retry, the quote
  link stays active, and no double-booking or data loss occurs.

Every requester transition (accept, cancel, modification request, question) is
written to AuditLog with `actor: "requester"`. Acceptance holds no new beds: the
quote's `AWAITING_REVIEW` hold already holds them, so it has no capacity revert. The
parent `BookingRequest` moves NEW -> VERIFIED -> QUOTED -> QUOTE_SENT -> ACCEPTED
(requester accept), then APPROVED/CONVERTED only after officer review; it may instead move to
CANCELLED (cancel), MODIFICATION_REQUESTED, or QUERY_PENDING. When an admin
sends a quote, the email-delivery result is recorded so the team can tell whether the
requester actually received the link.

On a SCHOOL request, `pendingAdultCount` is a count of unnamed adults in the
quoted party, not a teacher identity. A sent quote's `AWAITING_REVIEW` hold has
one `BookingRequestPendingAdultReservationNight` count per lodge night in
addition to its named `BookingGuestNight` rows. An ACCEPTED quote keeps both
until an officer names the adults or declines the request. Naming one accepted
adult keeps the request ACCEPTED and the accepted snapshot immutable; under
global then lodge locks it proves the original-to-current party mapping,
claims the request version, aligns provisional held prices with the selected
accepted snapshot, and creates real guest nights while reducing the anonymous
count in one transaction (#3794). Existing guest/night identities and accepted
terms stay fixed; lost claims and failures leave no partial price/name write.
Approval is refused while any pending count
or reservation remains. Once names are complete, school approval proves the
accepted-party mapping under its locks before claiming conversion; it retains
each person's accepted cents and held guest id. Missing or inconsistent
accepted snapshots refuse conversion. Hold cancellation removes the reservation in the same
transaction as the booking status flip.

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
capacity. Admins can adjust the bulk child counts, and **saving the quote is
where that adjustment lands** (#3412): the regenerated guest list is persisted
on the request in the transaction that mints the quote, so pricing, the sent
quote's breakdown, the send-time hold and approval all read one list. Approval
applies the same override through the same resolver, and still reprices and
rechecks per-night capacity against that final list. What the resolver
guarantees is
[`INV-ADDPAY-008`](invariants/additional-payment-chasing.md#inv-addpay-008); why
a live hold makes a count change a refusal rather than a re-size is
[`INV-ADDPAY-006`](invariants/additional-payment-chasing.md#inv-addpay-006).
Both writes are claims rather than overwrites: the request row on
version/status/hold, and the quote row on its own status, so neither a save nor
a send that lost a race writes anything or emails anybody.
The non-login records these flows create are classified by `Member.role`, not
counted as paying members: school groups (the school contact and each teacher)
get role `SCHOOL`, and general public booking-request contacts get `NON_MEMBER`.
Both non-member roles grant no access, are excluded from member rosters, and never
owe a membership subscription (see Member roles in `docs/ARCHITECTURE.md`). At
school conversion the booking lodge's **Who can be hut leader for school
bookings** setting is sampled once (#3819, replacing #3416's club-wide switch):
unless the lodge ticks **A teacher on the booking**, teachers remain named
guests and school contact people but receive no assignment or PIN email. When
it is ticked, the conversion also creates their lodge-scoped hut-leader
assignments, from arrival to the night before checkout, and sends the
post-commit PIN emails. If the club's default lodge changes between that read
and the lodge lock, the approval refuses with a 409 and can be retried.

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

No write of an intent's ledger row moves a captured transaction back
(`INV-PAY-132`, #4081): a PENDING or PROCESSING write, or a late SUCCEEDED one,
that lands on a SUCCEEDED or refunded row keeps that row's status.

Booking cancellation honors these transitions (#1473): only a never-captured
payment flips to FAILED at cancel, decided on transaction-ledger capture
evidence — the aggregate mirror alone can lie, because inbound reconciliation
folds modification credit notes worded as refunds into `refundedAmountCents` /
`PARTIALLY_REFUNDED` on never-captured Internet Banking payments (see
`docs/DOMAIN_INVARIANTS.md`). Since #3979 a note worded as an *invoice
correction* never folds: it lowered an invoice nobody had paid, so it is a price
correction, not a refund (`INV-PAY-126`). Genuinely captured payments survive
the cancel unchanged — no *transaction* ever leaves the refunded states.

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

Superseded capture (#4300, `INV-PAY-138`): a capture on an intent an edit
superseded belongs to the superseded-intent machinery, which refunds it (or
holds it for the treasurer on a cancelled booking), so it never settles the
booking. The settle refuses it under `lock(1)` with the outcome
`superseded_capture`: the transaction row records the capture, the booking
stays payable, nothing is confirmed or invoiced, and admins get the unmuteable
`admin-superseded-capture-refused` alert. The webhook and the card doors ask
the same reading first (`queueSupersededPaymentIntentRefundRecovery`); the pay
step and the `/pay` link then mint a repay intent under
`..._repay_<supersededIntentId>_<amount>_<currency>` and say the earlier
payment is going back (`previousPaymentRefunding`), and `confirm-payment`
answers 409 `SUPERSEDED_CARD_PAYMENT_REFUNDING`, also for a captured intent of
the booking its pointer has moved past. Neither reuse arm hands out an intent
a superseded row still names; one being paid answers `PAYMENT_PROCESSING` in
its own words. After a card success the `/pay` link asks the server what it
did and never shows the pay buttons again.

Saved-card provenance (#3269, `INV-PAY-053`). Two writers put a
`stripePaymentMethodId` on a `Payment` row and only one of them saves a card:
`markBookingSetupIntentSucceeded` writes it together with `stripeSetupIntentId`
(the card is attached to the customer for off-session reuse), while
`markBookingPaymentSucceeded` writes the one-off PaymentIntent's card, which
Stripe refuses to charge again. Every off-session charge path therefore asks
`src/lib/saved-payment-method.ts`, which offers a card only when customer,
payment method and SetupIntent are all on the same row. The settlement cron,
admin confirm-pending-guests and the two readers that predict a charge (the
member page's "will charge" wording, the payment-link `not_payable` gate) ask
`savedPaymentMethodForBooking` — the booking's own row first, then its split
parent's; `charge-saved-method` asks `reusableSavedPaymentMethodOnRow` for the
own row only, because it records the capture on the row it read and creates
none. No charge claim writes the card column: `savedPaymentMethodRowStamp`
writes the customer onto the row and nothing else, so a parent's one-off
checkout card can no longer be laundered onto the child by being copied, and a
claim cannot resurrect an own-row card that a concurrent replacement SetupIntent
mint just cleared. A capture still records the card that paid on its ledger row
(`markBookingPaymentSucceeded`), and `reconcilePaymentAggregates` mirrors it
onto the `Payment` row only when that row carries no SetupIntent (`INV-PAY-054`,
"the ledger never moves a saved card"). What that buys: a row carrying a
SetupIntent holds that intent's card or nothing, so the provenance proxy is
exact for every row written since the rule shipped — a one-off capture sitting
beside a saved card's SetupIntent survives only in legacy rows, where #3268's
terminal handling of a Stripe refusal is the backstop — and the copy on a row
without a SetupIntent never reads as reusable, which is also why the laundered
rows production already holds read as no card, without a migration. The row
itself still transitions exactly as before — this changes
which bookings enter `PENDING -> PROCESSING` off-session, not what happens once
they do.

Saved-card charge attempt (#3267, `INV-PAY-055`). Every off-session charge of a
saved card — the settlement cron, admin confirm-pending-guests and
`charge-saved-method` — is one PRIMARY Stripe `PaymentTransaction` created
inside the caller's claim transaction (under `lock(1)` and the lodge lock,
after the PENDING -> CONFIRMED claim) BEFORE Stripe is asked, with its own
Stripe idempotency key stored on `reference`. Two key shapes are read as an
attempt row's: `pending_charge_<bookingId>_<rowId>` and the `_v2` key (that key
plus `_v2`, #4646). Only the first is minted until #4682
(`mintedSavedCardChargeKey`), because the release before #4646 reads only it
and would charge again beside a `_v2` row it met during a deploy or after a
rollback. The charge's metadata names the row (`savedCardAttemptId`) only under
a `_v2` key, so a re-sent key always sends its first body:

```text
attempt row: PENDING (no intent id)  -- Stripe asked, intent returned -->
  SUCCEEDED (captured)                            [booking -> PAID]
  PROCESSING (requires_action / processing / …)   [claim released, webhook or next attempt resolves]
  FAILED (canceled / requires_payment_method)     [claim released, next attempt is fresh]
attempt row: PENDING  -- Stripe THREW -->
  definite (card_error, invalid_request_error, idempotency_error, authentication_error)
      -> FAILED, then the error is rethrown        [next attempt mints a fresh key]
  ambiguous (api_error, rate limit, connection, unknown)
      -> stays PENDING, error rethrown             [next attempt replays THIS row]
next attempt finds an unresolved (PENDING/PROCESSING) attempt row:
  same card, intent known      -> replay: RETRIEVE that intent (no new charge)
  same card, no intent yet     -> replay: re-send its key (Stripe answers or executes once)
                                  ... unless the row is older than 23h -> REFUSED
                                      (`attempt_key_expired`: Stripe's key window is
                                       24h, so a re-send after it is a NEW charge)
  different card               -> FAILED (reason suffixed `:superseded_by_new_card`),
                                  its intent cancelled best-effort after commit;
                                  one found already `succeeded` IS the capture;
                                  one found still `processing` is put BACK to
                                  PROCESSING and IS the answer (never charged beside)
next attempt finds a PRIMARY row still holding captured cash -> REFUSED
  (`SavedCardChargeRefusedError`: claim rolls back, admins alerted, no charge)
  ... unless the superseded machinery owns it (#4300, `INV-PAY-138`; every row
  is read first, and real money taken - or a capture owed back only in part -
  is `captured_primary_exists` whatever else is found):
    its refund in flight, owing back in full   -> not money taken: charge as usual
    only its cancel row names it              -> REFUSED (`superseded_capture_returning`)
    its refund dead (retries spent)            -> REFUSED (`superseded_refund_stopped`,
                                                  a person acts: Refunds owed / Stuck States)
  after the rollback, whichever refusal won, the refusing door hands every
  capture only a cancel row names to its refund
  (`handOffSupersededCaptureAfterRefusal`), so that capture no longer holds
  the next attempt back; a real capture or a stopped refund still refuses
`payment_intent.succeeded` / `.payment_failed` for an intent the ledger does not know
  -> adopt the PENDING/PROCESSING no-intent attempt row, settle it, then handle as
     usual (lost-response recovery), linked exactly by
       the event's saved-card `request.idempotency_key` = the row's `reference`, or
       no saved-card key (`request` null: an asynchronous capture, and every
       redelivery of it) -> the metadata's `savedCardAttemptId` = the row's id,
       its payment this booking's and its key the `_v2` shape (#4646)
     the row write is claimed on "still no intent": a lost adoption writes nothing
     an original-key attempt (every one minted until #4682) has neither link
     for an asynchronous capture
       -> stays PENDING, ends at `attempt_key_expired`, alerted as unmatched
```

Every write onto an attempt row is FORWARD ONLY. A capture is written over
anything but refund history; a non-capture only over an unresolved row. So a
`processing` answer a path retrieved cannot undo a `succeeded` the webhook has
already recorded, and each path's locked release re-reads the booking under its
locks and hands the claim back only while it is still CONFIRMED — a booking the
webhook has since settled PAID is left alone.

Before #3267 all three paths shared one key, `pending_charge_<bookingId>`, so
the admin route's different metadata could only ever answer an idempotency
parameter-mismatch error, and a re-saved card was refused for 24 hours. The
double-charge guard that key stood in for now lives on the ledger under the
claim's locks — which is why `charge-saved-method`, which used to charge with
no claim at all, now takes the same PENDING -> CONFIRMED claim as the other
two paths and releases it (CONFIRMED -> PENDING, hold restored) when nothing
is captured.

Duplicate capture on an already-PAID booking (#1992): when a success arrives
carrying the SAME intent the booking settled with, every reconciliation path
returns `already_paid` unchanged (webhook redelivery, confirm-payment racing
the webhook, payment-link reconcile, a saved-card charge attempt replayed by
the cron, charge-saved-method or confirm-pending-guests — since #3267 a replay
retrieves the recorded attempt's own intent rather than re-sending a shared
`pending_charge_` key, see "Saved-card charge attempt" above).

The PAID claim records which row settled the booking
(`Payment.settledByTransactionId`, #4211): the card capture, or the cash or
bank receipt's PRIMARY row. The manual mark-paid reversal clears it.

A COMPLETED booking is judged exactly as a PAID one (#4285): the post-stay
cron's `PAID -> COMPLETED` ends the stay, not the settlement, so every row
below holds on it, the booking stays COMPLETED, and a finished stay's beds are
not reconciled. Before #4285 any success arriving on a COMPLETED booking threw
"not payable" (or was refused as a stale amount), a 500 Stripe retried for
three days. With no record and nothing else holding money, a lone capture keeps
silently only as a replay of one the app had already recorded (its row was
`SUCCEEDED` before this delivery, and not written by the caller itself, as a
saved-card pre-record or the webhook's adoption of a lost-response attempt
is); one never recorded before is new money, kept whatever its amount as
`duplicate_capture_kept` with the `new-capture` alert. That alert is owed from
the settle's transaction (an `AlertCooldown` marker) until it is delivered: the
capture's next arrival re-alerts while it stands, and the payments cron's
`duplicate-capture-kept-alert` task sends it an hour on otherwise, re-judged
first in one read-only `RepeatableRead` snapshot. It waits while a card refund
operation that may take from this capture is in flight (its own row or intent,
a plan with a slice of it, or no plan yet); any other operation, such as an
additional-payment charge, never holds it back. It is moot, and clears
silently, for a capture whose card no longer holds money, a booking gone, or a
capture the superseded or duplicate-capture machinery owns. Who else holds money is read the way an
admin is told (`readOtherSettledCaptureWhere`'s `readTellingWhere`, the Xero
conflict's reading), by the settle's alert and the drain alike, so a capture
behind a dead cancel, or one whose duplicate-capture refund Stripe failed later
and open rows owe back less than all it holds, is named. That reading counts PRIMARY rows by
ledger status, so "no other payment" is worded as none the app counts as
settling the booking. A booking cancelled since is told as
`new-capture-closed`, naming the cancellation's recorded refund, its card
refund read in that snapshot as the booking page reads it
(`readCancelledCardRefund`): refunded only once its row SUCCEEDED and no
refund it made that Stripe failed later is owed again; planned but not sent
while it or such a refund is on its way or dead; closed as paid another way,
with what the close left unpaid; and, where only a refund that failed later
was closed that way, that part by its amount (#4285 review).
An organiser-card child's is its debt to the group organiser's card
(`readOrganiserChildCancelledCardRefund`; a refund failed later reopens it),
and is said so. A card refund shortfall's bank and check parts are said as
their hand-back tasks stand: owed, paid, or closed. Another payment holding money is told
as `new-capture-later-payment`. Every alert shows what the card still holds: its
amount less the card refunds recorded against it (`sumRecordedRefundsForCapture`),
since a refund as account credit is placed on the capture's ledger row while
the money stays on the card. Any delivered alert for the capture clears the marker. A
send whose daily cooldown was claimed before a crash waits out that day, so the
worst case is about 24 hours. A saved-card capture whose caller crashed or
threw between its pre-record and the settle reads as a replay on its next
arrival (a stated limit). Every other status the
settle cannot pay from (CANCELLED, BUMPED, WAITLISTED, WAITLIST_OFFERED,
AWAITING_REVIEW) still throws, and the webhook's stale-amount check (#1161)
still guards an unpaid booking; it skips a PAID or COMPLETED one, whose capture
the settle only keeps or refunds.

```text
recorded settler arrives again             -> already_paid, never refunded
other capture arrives, settler holds cash  -> duplicate refund (below)
no usable record, another capture holds    -> duplicate_capture_kept: kept,
  cash (paid before #4211, by the draining    nothing refunded; unmuteable
  colour, or a settler that no longer holds   admin-duplicate-capture-kept
  money)                                      alert, once a day per capture
recorded settler no longer holds money,    -> duplicate_capture_kept: kept,
  nothing else does                            alert says this payment may now
                                               pay for the booking (owned
                                               duplicate: re-sends its refund;
                                               settler the superseded
                                               machinery holds: silent keep)
```

A success carrying a DIFFERENT intent while the recorded settler still holds
net cash is double money (the residual #1967 split-child link-vs-auto-charge
window, or a third capture from stale tabs) and is auto-refunded: the
duplicate's transaction goes `SUCCEEDED -> REFUNDED` via a durable
`duplicate_capture_<bookingId>_<pi>` recovery operation, the settlement
transaction and the booking's PAID (or COMPLETED) status are untouched, and
`markBookingPaymentSucceeded` reports `duplicate_capture_refunded` /
`duplicate_capture_refund_failed`. A fully `REFUNDED` prior capture is history
(#1765), never a settlement a repay generation could "duplicate". All of it is
decided under `lock(1)`; a capture a duplicate-capture refund already owns, at
any status, re-sends only its own refund (`INV-PAY-043`).

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

Capacity race (#740, #4125): a payment that succeeds after the final capacity
claim failed cancels the booking in the claim, which also writes the
`capacity_claim_failed_refund_recovery_<bookingId>_<pi>` row with the frozen
refund plan. The `CANCELLED` event (written before the refund is attempted)
says the full amount "is being refunded" and carries
`cancelledBecause: "capacity_race"`, so the member is never told they
cancelled it. The `REFUNDED` event is written once the refund is made, for the
plan's total (never the full charge), by whichever close moves the row to
`SUCCEEDED`: the inline attempt's close or the recovery runner's, in the
same transaction as that close (`closeRefundRowRecordingEvent`, which a member
cancel's close shares since #4145), so a
crash cannot leave the row closed without its event, and a failed insert
leaves the row open for the runner's replay. A close that finds the row
already closed writes nothing, so the event lands exactly once. The inline
close takes the row only while it is still on the plan the attempt sent
(#4144), so a row re-planned after Stripe later failed the refund stays open
and owed, with no event. Until it lands, the booking
page and the payment-link page read the row
(`readCancelledCardRefund`, which reads a member cancel's
`booking_cancel_refund_recovery_<bookingId>` row the same way): still being
sent says "on its way to your original payment method"; a dead row (retries
spent, or failed with no retry) says the club will be in touch - as does a
dead card part of a card refund shortfall; a row closed "Paid another way"
says so, with what its record paid back and left unpaid (the slices Stripe had
made first, a member cancel's or a capacity race's, are recorded by that close
and said apart, as is another row's refund the runner made, and what the
sentence does not say - the rest past the plan, or a part its payment no longer
held - is followed up). A capacity race's refund is never told as more than its
rows' frozen plans together (`cardRefundPlanCents`), whatever its state: a
`CANCELLED` snapshot written before #4125 froze the full charge; a capacity race's row the runner closed before #4125,
which wrote no event, says it was refunded. A refund its event recorded that
Stripe later fails is said by the row owing it again, as for a member cancel
(#4166). No cancellation policy decided a
capacity-race refund, so its narrative names none. That settle records no
`MEMBER_PAID` event, so the narrative takes the payment from the `CANCELLED`
snapshot, whose `settledAmountCents` is the plan's total: when the payment
ledger showed less refundable than the charge (or nothing - an empty plan,
which never reads "no refund was due"), the rest is neither refunded nor
retained, and the narrative says the club will be in touch about it. That
promise is backed by a once-ever officers' alert on the booking naming the
rest (`alertCapacityRaceRefundShortfall`) and (#4154, `INV-PAY-135`) by a
hand-back task to check for it, raised OPEN in the void's claim. The
narrative counts every settlement event of a capacity race, so the task
marked paid back (its REFUNDED event) removes the follow-up line; dismissed,
the line says the club checked the rest and closed it.

### A succeeded app intent no PRIMARY row settles (#4624)

`handlePaymentIntentSucceeded` routes an intent the app created (it carries
`bookingId`, `appPaymentIntentRoute`) through its routes in order, and only
an intent that falls through all of them reaches the unmatched branch:

```text
payment_intent.succeeded, app metadata
  type group_settlement            -> organiser settlement (never unmatched)
  superseded machinery owns it     -> its refund or hold   (never unmatched)
  type modification_additional     -> additional-ask handler (never unmatched)
  row by intent id, else saved-card attempt adopted by event.request.idempotency_key
  or (#4646) by the metadata's savedCardAttemptId,
  else the row by intent id read once more
    PRIMARY row                    -> settle the booking as usual
    no row | non-PRIMARY row       -> UnrecognisedStripePayment (APP_INTENT_NO_TRANSACTION |
                                      APP_INTENT_NOT_PRIMARY), one admin alert, event COMPLETED
```

Nothing about the booking, its payment, ledger or Xero is written on that
branch; the alert is once ever per PaymentIntent and a failed send fails the
event so Stripe redelivers (`INV-INT-033`). Which minting flows can reach it:

| Flow or kind | Reaches it? | Expected or lost money | Why |
| --- | --- | --- | --- |
| Pay step and `/pay` link, PRIMARY | No | - | `attachMintedCardIntent` writes the PRIMARY row under lock(1) before the client secret leaves the server; a refused attach cancels the intent and never hands the secret out |
| Saved-card charge, answer received (`chargeSavedCardAttempt`) | No | - | The request's `settleSavedCardChargeAttempt` writes the intent onto the attempt row. It can commit after the webhook's first read and before `adoptSavedCardChargeAttemptForIntent`, which then finds no row without an intent; so the webhook reads the row by intent id once more before calling the payment unmatched, finds the PRIMARY row, and settles as usual (`already_paid` when the request settled first) |
| Saved-card charge, answer lost, Stripe attributes the capture to the request | No | - | `adoptSavedCardChargeAttemptForIntent` adopts it by `event.request.idempotency_key` |
| Saved-card charge under a `_v2` key, answer lost, capture asynchronous (`event.request` null) | No | - | `adoptSavedCardChargeAttemptForIntent` adopts it by the attempt id the metadata carries (`savedCardAttemptId`, #4646); a redelivery finds the row by intent id. This release reads `_v2` rows but does not mint them; #4682 does |
| Saved-card charge under the original key (every one minted until #4682), answer lost, capture asynchronous; or the attempt row already ended | Yes, `APP_INTENT_NO_TRANSACTION` | Lost money | The card was charged and no row can be linked: the original key's metadata names no row, and an ended row is never adopted. The attempt ends at `attempt_key_expired`, and a redelivered event reaches the same branch |
| An app intent confirmed outside the app after its attach was refused or never ran (dashboard or API) | Yes, `APP_INTENT_NO_TRANSACTION` | Lost money | No row was ever written for it |
| An intent another deployment minted on the same Stripe account (its `bookingId` is not here) | Yes, `APP_INTENT_NO_TRANSACTION` | Unexpected: money this app holds no record of | One deployment serves one club, so it should not happen. Each deployment needs its own Stripe account or test sandbox: staging, development and CI sharing one test account would record each other's app intents. Their emails are held off production, so the cost there is only rows |
| Additional asks: edit, review charge, currency and price re-issue, released credit | No | - | Each carries `type: ADDITIONAL_ASK_INTENT_TYPE` and is routed to `handleAdditionalModificationPaymentSucceeded` first |
| An ADDITIONAL row whose intent is not marked an additional ask: no current minter writes one; a legacy row `ensurePaymentTransactionsBackfilled` writes from `Payment.additionalPaymentIntentId` for an intent minted without the type would be one | Yes, `APP_INTENT_NOT_PRIMARY` | Lost money | Neither the booking path nor the additional-ask path settles it |
| Group organiser settlement | No | - | `type: GROUP_SETTLEMENT_INTENT_TYPE`, routed first to `applyGroupSettlementSucceeded` |
| Superseded intent with a live cancel or owed-back capture | No | - | `queueSupersededPaymentIntentRefundRecovery` owns it |
| Pre-ledger payment (intent only on `Payment`) | No | - | `findPaymentTransactionByIntentId` backfills a PRIMARY row |
| Booking hard-deleted | No | - | Only a DRAFT with no financial history is deleted (`deleteBooking`) |

So every case that reaches the branch today is money nothing records, and
each alerts; the expected cases are the routes above it, each pinned silent in
`stripe-webhook-alerts.test.ts` ("#4624").

### Saved card (SetupIntent) on a PENDING non-member-guest booking (#3266)

A PENDING booking with non-member guests is not charged at booking time; the
member saves a card through a Stripe SetupIntent and the cron (or an admin
charge route) charges it closer to check-in. The card lives on the `Payment`
row as `stripePaymentMethodId`, beside `stripeSetupIntentId` and
`stripeCustomerId`, and every charge path reads the card column without asking
Stripe first — so the column must only ever name a card that may be charged
(`INV-PAY-052`).

```text
no card on row  --(member opens "Save Payment Method"; route mints)-->  intent open
   row: stripeSetupIntentId = new intent, stripeCustomerId set,
        stripePaymentMethodId = NULL        <- a replacement CLEARS the old card
intent open  --(setup_intent.succeeded webhook, or the route's re-adopt arm)-->  card saved
   row: stripePaymentMethodId = the intent's card    (markBookingSetupIntentSucceeded)
intent open  --(setup_intent.canceled)-->  intent canceled  (row UNCHANGED: the id is kept so the next
   mint's idempotency key chains from it; card untouched)
card saved   --(member mints a replacement)-->  intent open  (card cleared again)
card saved   --(terminal Stripe refusal on charge, #3268)-->  no card on row
   row: stripePaymentMethodId = NULL, stripeSetupIntentId LEFT IN PLACE (succeeded)
```

`POST /api/payments/create-setup-intent`, when the row already names an intent,
decides from the intent's live status plus the row's card column:

| Stored intent | Row card | Route does |
| --- | --- | --- |
| open (has a client secret, not canceled) | any | hands back the existing client secret; no new intent |
| succeeded | this intent's OWN card | re-stamps it (a no-op write), answers `alreadySaved`; Stripe is not asked |
| succeeded | NULL or a DIFFERENT card, and Stripe still reports the intent's card attached to the row's customer | stamps it, answers `alreadySaved` — the webhook simply had not landed yet |
| succeeded | NULL or a DIFFERENT card, and the intent's card is detached, belongs to another customer, or is `resource_missing` | mints a fresh SetupIntent under the chained key `seti_<bookingId>_<oldIntentId>`; card stays NULL until that one succeeds |
| succeeded | NULL or a DIFFERENT card, and Stripe fails for any other reason | 500 — not a verdict either way, so nothing is stamped and nothing minted |
| canceled, or no client secret | any | mints a fresh SetupIntent under the chained key, clearing the card |

The verdict in the middle three rows is `classifySucceededSetupIntentCard`
(`setup-intent-card.ts`), and the `setup_intent.succeeded` webhook applies the
SAME one — it is the one rule for adopting a succeeded intent's card. The
webhook adds the guard the route satisfies by construction: it stamps only when
the row STILL names this intent (a redelivery for an intent the row has since
replaced writes nothing), and `markBookingSetupIntentSucceeded` re-checks that
under the write (`updateMany` on `bookingId` + `stripeSetupIntentId`, card column
only; the intent id is written by the mint alone). `setup_intent.canceled`
writes nothing: nulling the id sent the next mint back to the
`seti_<bookingId>_initial` key, which inside Stripe's 24-hour idempotency window
replays the ORIGINAL intent's creation.

The booking page's owner-only "Save Payment Method" card shows whenever
`savedPaymentMethodForBooking` (`INV-PAY-053`) finds no reusable card on the
booking's own row or its split parent's — the same const that drives the admin
button's will-charge wording — so an abandoned replacement, a retired card, or a
legacy copied card with no SetupIntent puts the form back rather than leaving a
dead end; the "Payment on hold" notice takes its place only once a chargeable
card is on file.

Saved-card auto-charge failure (#3268, `INV-PAY-054`): when the confirm-pending
cron's off-session charge THROWS, the Payment row's state does not move — the
row stays `PENDING` and the capacity claim is released as before — but the
error is now classified before the next run is allowed to try again:

```text
charge throws -> release claim (unchanged)
  retry    (soft decline inside the window, api/rate-limit/idempotency error,
            plain Error, anything unrecognised)
             -> admin alert as before -> same card charged next run
  terminal (Stripe rejects the pm itself; a "do not retry" decline code incl.
            authentication_required, or advice_code do_not_try_again; a soft
            decline still declining two days after the charge first became
            due — the second ~2-day window)
             -> pm detached at Stripe (outside any transaction). Only an
                invalid_request_error refusal is swallowed; any other detach
                failure rethrows -> nothing cleared -> the retry alert instead
             -> Payment.stripePaymentMethodId = null on EVERY row carrying it
                (child AND borrowed-from parent)
             -> PaymentTransaction.paymentMethodId = null on every ledger row
                carrying it (so a reconcile of a row WITHOUT a SetupIntent —
                a split child's — cannot re-stamp it)
             -> ONE member email (saved-card-charge-failed) + ONE admin alert
                (which says "stays pending" only when the claim release itself
                succeeded; otherwise that the booking is stuck confirmed-unpaid)
             -> next run: split child -> #1967 payment-link path;
                          plain booking -> missing_payment_method (log only)
```

`stripeSetupIntentId` and `stripeCustomerId` are untouched. The PROCESSING /
`requires_action` branch (an intent RETURNED, not thrown) is not part of this.

The same change bounds how `reconcilePaymentAggregates` derives
`Payment.stripePaymentMethodId` from the latest PRIMARY ledger row (the rule is
the last bullet of `INV-PAY-054`): a `Payment` carrying a `stripeSetupIntentId`
keeps its card column untouched by the ledger — the SetupIntent writers and the
retire path own it — so a late `payment_intent.canceled` for an old intent can
no longer null a card the member has just re-saved; without a SetupIntent the
ledger row's pm is followed, except that a Stripe row recording no pm never
nulls a card that is set; an Internet Banking latest PRIMARY still yields null.

### Internet Banking settle from the invoice's cash (#3979)

When Xero reports a booking's PRIMARY invoice paid in cash, the inbound settle
moves the payment `PENDING/FAILED -> SUCCEEDED` and records the receipt at the
cash that invoice collected, not the figure the payment was born with
(`INV-PAY-125`, `settle-from-cash.ts`):

```text
no captured IB PRIMARY row, cash complete, one matched payment, no
  refund-worded modification note applied to the invoice, no folded refund the
  invoice's no-cash notes do not exactly explain, one uncaptured IB PRIMARY
  row, no second instrument
  -> PRIMARY row := invoice cash (reason xero_invoice_paid_cash)
  -> Payment amount / refunded / status := the ledger's projection of the rows
     (cash + other captures; an exactly explained correction fold cleared)
  -> ledger BANK_RECEIPT
any of those not true
  -> stored figure kept -> receipt at it -> marker + unmuteable alert (live booking)
PRIMARY row already captured (a replay)
  -> no amount decided again (an unsent marker's alert is sent again)
cash != bookingAmountOwedCents (INV-PAY-119), beyond what supplementary
  invoices bill (INV-PAY-047)
  -> figure still written -> marker + unmuteable alert
```

The marker is an admin-only `SETTLEMENT_MARKERS` event written in the settle's
transaction; the alert follows the commit and is recorded on it once sent. The
cancel arms (a cancelled booking's late cash, the late capacity cancel) size
their credit from the receipt's figure, measure a mixed invoice against its
total less the member's own applied credit, and alert on their own.

An invoice-correction note refunds nothing (`INV-PAY-126`): a $300 invoice
corrected by $100 and paid $200 settles as $200 paid, $0 refunded, and
`reconcilePaymentAggregates` keeps it. Against a receipt recorded at the stored
figure (settled before #3979, or kept) the correction still counts, so the net
stays the cash, and the refunded-total repair finds a bank-transfer payment's
modification notes by its invoice, so a later note's recount never drops one.
The repair writes through a claim on the row it read (status, totals and
`updatedAt`, which the settle touches at every transition), re-runs once from
scratch when it loses that claim, and never un-refunds a payment whose PRIMARY
rows show nothing captured to `SUCCEEDED`. A receipt counts a correction only
while it carries a reason it was born with; a part payment recognised at cancel
is cash-sized.
Settles before #3979 are listed by `pnpm run payments:audit-ib-settled-cash`,
never rewritten.

### Manual mark-paid (cash / off-Xero bank transfer), B5 #2262

A finance:edit admin action that settles a booking's payment for money the app
never saw. It is a SIBLING ENTRY POINT into the one settlement body, so the
booking-side transition is the ordinary settlement one:

```text
Booking: PAYMENT_PENDING | CONFIRMED | PENDING | DRAFT -> PAID
Payment: PENDING/PROCESSING/FAILED -> SUCCEEDED, source coerced to
  INTERNET_BANKING, provenance columns written (manuallyMarkedPaidAt / By /
  note / manuallyMarkedPaidPreviousStatus). FAILED is a legitimate settle-from
  status — a declined/expired card attempt is exactly the case an admin
  remedies with cash — and the fenced write carries this status set as a WHERE
  condition, so an already-SUCCEEDED or refund-bearing payment can never be
  clobbered to a manual settlement.
PaymentTransaction: an INTERNET_BANKING PRIMARY row with NO Stripe intent id,
  reason "manual_mark_paid", -> SUCCEEDED
```

#2397 — an OUTSTANDING upward-modification delta on the same booking. The admin
is asked whether the cash covers it (no default, and the answer is part of the
settle's contract). The delta is a SLICE of the amount owing — an upward
modification raised `finalPriceCents` by the same amount it recorded as the
extra — so the PRIMARY transaction is the booking's worth BEFORE the change
under **both** answers, and the answer decides what sits beside it:

```text
covered:
  Payment: amountCents = finalPriceCents - credit
           additionalPaymentStatus PENDING|FAILED|null -> "SUCCEEDED"
           (re-asserted in the fenced write on the exact additionalAmountCents)
  PaymentTransaction: PRIMARY = (finalPriceCents - credit - delta), plus an
    INTERNET_BANKING ADDITIONAL row with NO Stripe intent id, reason
    "manual_mark_paid_additional", -> SUCCEEDED. The two sum to amountCents:
    the cash is SPLIT, never doubled.
  AuditLog: a second row, "booking-payment.manual-payment.additional-settled",
    which is what puts the extra on the booking-history timeline

NOT covered (owner decision, 31 Jul 2026 — record what was handed over):
  Payment: amountCents = finalPriceCents - credit - delta
           additional* columns UNTOUCHED, so the delta is still owed and still
           chased
  PaymentTransaction: PRIMARY = (finalPriceCents - credit - delta). No
    ADDITIONAL row.
```

The generalised ledger mirror, which holds for both answers (and already held
for a card-settled booking carrying an uncollected addition):

```text
amountCents + creditAppliedCents + (uncollected addition) = finalPriceCents
```

It is not asserted at runtime inside the settle — the settled figure is defined
as the left-hand side, so any in-transaction check is a tautology. It is upheld
by construction (the two rows are a split of one figure), by the fenced write's
WHERE clauses, and after the fact by the booking-ledger census
(`pnpm run booking-ledger:census`, `INV-MONEY-037`); see
`docs/DOMAIN_INVARIANTS.md` for the full statement.

Stripe-intent hygiene differs by answer. Both answers enqueue a durable
CANCEL_PAYMENT_INTENT for every live Stripe intent on the payment, EXCEPT that
a NOT-covered answer spares the payment's current `additionalPaymentIntentId`:
that extra is still owed, and that intent is the member's only self-service way
to pay it. Superseded addition intents are still cancelled, and the covered
answer cancels the addition's intent like any other.

On the reversal, the reversed amount is the figure that was written. A covered
extra goes back to owing: the ADDITIONAL row SUCCEEDED -> FAILED (reason
"manual_mark_paid_additional_reversed") and `additionalPaymentStatus` is restored
by a guarded claim matching exactly the amount and status the settle recorded. A
not-covered settle left the extra owing throughout, so there is nothing to
restore.

Refused (409, nothing written) when the booking is already PAID, is not in a
payable status, participates in a group settlement, has ANY Xero invoice
evidence including a queued mint, carries any refund history
(`refundedAmountCents > 0`), is in a payment status OUTSIDE
PENDING/PROCESSING/FAILED — i.e. has already taken money, refused at read time
since #2397 with a message that says so rather than at the fence with
"changed while you were recording it" — owes nothing, no longer fits the lodge, when
the amount owing moved since the admin's dialog rendered, or (#2397) when the
outstanding extra moved, appeared, or vanished since it did — including when an
answer arrives for an extra that no longer exists, when an extra exists and no
answer was given, when the extra is larger than the whole amount owing (either
answer), and when a "not covered" answer would leave nothing to record because
the extra IS the whole amount owing.

Reversal (`direction: "unpaid"`), permitted only while nothing has happened
that it could not undo:

```text
Booking: PAID -> manuallyMarkedPaidPreviousStatus
  …except a stored DRAFT, which restores as PAYMENT_PENDING (the PAID claim
  cleared draftExpiresAt, so a restored DRAFT would never expire)
Payment: SUCCEEDED -> PENDING, provenance cleared, source left as-is; a
  restored CONFIRMED internet-banking hold deadline is CLEARED
PaymentTransaction (the manual PRIMARY row): SUCCEEDED -> FAILED,
  reason "manual_mark_paid_reversed" — history, never deleted, and never
  resurrected by a later re-mark (the mint predicate skips FAILED rows)
PaymentTransaction (the manual ADDITIONAL row, when the settle covered the
  extra): SUCCEEDED -> FAILED, reason "manual_mark_paid_additional_reversed".
  When the extra goes back to owing and an open card ask for it stands that
  the reversal does not keep cancelled, the row is
  also stamped `withdrawnAt` and `additionalPaymentIntentId` is put back to
  that ask (#4355): the mirror reads past the stamped row, so a capture of the
  ask reads SUCCEEDED. With no such ask the row stays the mirror's anchor.
PaymentRecoveryOperation (every CANCEL_PAYMENT_INTENT /
  REFUND_SUPERSEDED_PAYMENT not yet SUCCEEDED — PENDING, PROCESSING or
  FAILED, retrying or exhausted (#4320) — on a live card intent the restored
  booking can still be paid with):
  DELETED, inside the reversal's transaction — not flipped to a terminal
  status, because every webhook-side liveness predicate keys on
  `status != SUCCEEDED` and a FAILED "closed" row would still hand a
  post-reversal capture to the superseded-refund machinery. The deleted rows'
  full content is preserved on the reversal's AuditLog entry.
PaymentRecoveryOperation (the cancellation of a stale intent, or of one the
  settle found already queued): KEPT, or queued afresh as PENDING where the
  intent had none — it goes on to cancel the intent, or hand its capture to
  the superseded refund. One the runner will not finish (given up at the
  attempt ceiling, or PROCESSING on its last attempt) is RE-ARMED: PENDING,
  attempts 0, due now.
```

Which intents stay cancelled is derived from the restored booking, never
remembered (#4320): the cancel key is shared, so an edit on the PAID booking,
an additional ask's supersede or the `/pay` link's supersede can share the very
row the settle minted, and a settle recorded before #4320 kept no list. The
reversal re-applies the supersede rules — a PRIMARY intent not at the amount the
booking owes (`readBookingAmountOwed`, #1161), a saved-card charge attempt not
at the booking's worth (`bookingWorthCents`: what the cron charges, and what
the capture path accepts), an ADDITIONAL intent that is not the live ask
(`additionalPaymentIntentId`, #3340) — and keeps those intents cancelled. A
settle that covered the extra minted a newer cash ADDITIONAL row, so any
rebuild of the mirror since nulls that pointer; when the reversal puts the
extra back to owing, the live ask is the newest card ask an officer has not
withdrawn, if it asks exactly that extra and its intent is still open
(PENDING or PROCESSING: a FAILED one may be cancelled at Stripe). It also keeps an intent the settle
found already queued (`adoptedCancelPaymentIntentIds` on the mark-paid's audit
row), because a superseded intent is never handed out again (`INV-PAY-138`)
and a wrong-currency supersede (#3567) is not derivable. A settle row without
that list adopts nothing. For every intent left cancelled, a cancellation the
runner will not finish is re-armed, so "still cancelled" is true. A worker
still holding a re-armed row cannot undo it: its failure write is fenced on
the attempt it claimed, which the re-arm reset. Every other live row on a live
card intent is withdrawn; a row on an intent the ledger already retired is
left. The reversal's audit row lists the intents left cancelled
(`stillCancelledPaymentIntentIds`), the rows it re-armed
(`rearmedRecoveryOperationIds`) and the card ask it put the extra back to
(`restoredAdditionalPaymentIntentId`). Each delete is fenced on the same
liveness predicate, so a worker that claims the row meanwhile (FAILED ->
PROCESSING) loses it, and a row a worker finished (SUCCEEDED) is left and not
reported closed.

A member-owed superseded refund is never deleted. The hand-off that creates one
re-claims its cancel row, marks the capture SUCCEEDED and rebuilds the payment
in one transaction under the `Payment` row, which the reversal holds from its
"no settled Stripe transaction" check to its commit: a hand-off that commits
first makes the reversal refuse, and a reversal that commits first leaves the
hand-off nothing to claim, so the capture settles the booking. A worker that
claimed a row before the reversal may still reach Stripe's cancel after it
commits: the member's open tab then fails. The pay step does not mint a fresh
intent: the reversal leaves the payment on internet banking, so both card doors
refuse before reaching Stripe (#4348), and the member pays by bank transfer. No
money moves.

The FAILED row is why #4320 exists: a mark-paid's cancel that met a Stripe
outage waits FAILED to retry, and while the reversal deleted only
PENDING|PROCESSING rows it survived. Once the booking was payable again, the
member's capture of that intent was refunded as superseded and the booking
never settled, or the retry cancelled the intent the member still had open.
Proved on PostgreSQL in `manual-reversal-retrying-cancel.realdb.test.ts`.

Both directions record an `AuditLog` naming the acting admin, and the reversal
records a durable `BookingEvent` — a `CANCELLED` event carrying the
`manual_mark_paid_reversed` discriminator
(`src/lib/manual-settlement-reversal-event.ts`), which the shared narrative
EXCLUDES so a later genuine cancellation is not misdated by it. The reciprocal
inbound fence records its conflict the same way, under the
`manual_settlement_xero_conflict` discriminator.

### Released-credit card request lifecycle (#4253)

```text
(release row written by the outside-spend converge)
  -> recovery row `credit_release_ask_<releaseId>`        (sweep; off until the writer switch is on;
                                                            earlier releases only behind the backlog switch)
  -> closed, nothing asked    (not a release / ended booking / payment not captured /
                               organiser-settled / invoice paid in Xero / nothing owed /
                               below the card minimum, the last with an officer alert)
  -> waiting                  (an unpaid edit request is open whose invoice would not follow a
                               merge: back to the longest retry interval, no attempt spent, never
                               terminal; officers told once, INV-ADDPAY-051)
  -> ADDITIONAL row PENDING (reason credit_released_outside_app, carries any live ask; an unpaid
                               edit request is MERGED into it, its waiting invoice moved onto it,
                               cause "mixed", INV-ADDPAY-052)
       -> SUCCEEDED by card  -> payment recorded on the booking's invoice (sweep, XeroObjectLink)
       -> FAILED+withdrawn   when Xero shows the invoice PAID (the request alone, or carrying only
                               earlier released credit): card payment cancelled first,
                               bank-cash row written in the same transaction
       -> superseded         by a later ask that carries it (INV-PAY-098): an edit made while
                               the request is unpaid MERGES into one request (cause "mixed"),
                               chased and worded as both
  claim hold lost mid-mint (a stale claim reaped and reclaimed): nothing written; the intent
                               it minted under the release's key is cancelled at Stripe
                               (`abandoned`, best-effort, after the hold's transaction; logged
                               as `reissued-ask.abandoned-intent-cleanup`) only once the
                               reclaiming runner closed the row SUCCEEDED without it and no row
                               or recovery names it; a row still claimable or claimed, or failed
                               for good, keeps it: a retry may mint under the same key and get
                               it back, otherwise it stays open, never offered (#4652, INV-PAY-120)
  chase while unpaid (INV-ADDPAY-048): request email now, reminders at 7, 14, 21 and 28
                               days; after the fourth reminder only the officers' queues chase
  reminder withheld for an officer (INV-ADDPAY-051): Xero shows the invoice owing less than the
                               request's released credit, or not open (paid, voided, unapproved),
                               or the request cannot be matched to it (none, a 404, no amount due)
```

`INV-ADDPAY-045`, `INV-ADDPAY-046`, `INV-ADDPAY-048`, `INV-ADDPAY-050`, `INV-ADDPAY-051`, `INV-ADDPAY-052`.

### Manual refund task lifecycle (#2262)

```text
OPEN -> COMPLETED   (finance:edit; writes the local refund allocation and a
                     REFUNDED BookingEvent — the ONLY moment the ledger says
                     the money went back)
OPEN -> DISMISSED   (finance:edit; requires a note; moves no money)
OPEN -> DISMISSED   (#2700: the Stripe webhook, with NO acting member at all —
                     `completedByMemberId` stays null and no operator note is
                     required. Fires only on a task raised by the deleted-booking
                     modification-payment path, matched on that exact payment
                     intent, when `handleCancelledBookingAdditionalPaymentSucceeded`
                     has already refunded the capture, so the task's question is
                     answered. Status-fenced on OPEN, so a replay or an operator
                     who got there first claims nothing. Moves no money —
                     COMPLETED here would write a SECOND refund allocation for
                     one refund. See `INV-ADDPAY-036`.)
OPEN -> COMPLETED   (#3030: the same finance:edit close, but the amount arrives
                     WITH it. An `EDIT_FINANCIAL_REVIEW` task can be OPEN with
                     `amountCents` NULL - genuinely unknown, never a magic zero -
                     and the admin's confirmed non-negative integer cents is
                     written inside the SAME status-fenced claim as the status,
                     so a confirmation can no more apply twice than a status can.
                     An OPEN task MAY already carry an amount - see the note
                     below - and this arm still requires a human to confirm one.
                     A note is REQUIRED on this arm, because the admin is pricing
                     real money from evidence. ZERO IS REFUSED: a completion at
                     $0.00 would record a refund the club did not make, and
                     "reviewed, nothing is due" is DISMISSED. A task with
                     `paymentId` NULL is not automatically a credit-only one
                     since #3194: that column records the booking's captured
                     money AT RAISE TIME and nothing backfills it, so the
                     completion re-reads the BOOKING's own payment and routes on
                     that. A completion that genuinely finds no captured money
                     writes no refund allocation AND no REFUNDED booking event -
                     there is nothing to allocate against and nothing moved. Where the confirmed figure differs
                     from one the task already carried, that is the audited
                     amendment of owner decision D2 and `raisedAmountCents` keeps
                     what it was raised with; on a legacy kind a differing figure
                     is refused as a stale screen instead.)
OPEN -> COMPLETED   (#3032: and the confirmed amount now MOVES, down whichever of
                     the three existing settlement paths the booking's payment
                     says it belongs to - a canonical Stripe refund for a card
                     payment, made AFTER the commit; the local ledger allocation
                     for an internet-banking hand-back; or account credit through
                     `createBookingModificationCredit` where nothing was captured.
                     #3194: "the booking's payment" is read AT COMPLETION when
                     the task carries no payment id of its own, through the same
                     captured-and-settled gate the raise sites use - so a member
                     who pays after their edit was parked is refunded to the card
                     they paid with instead of being handed club credit they
                     never asked for. Where the task DOES carry a payment id that
                     id still decides, so every existing cap and refusal is
                     reached exactly as before.
                     The route is chosen and every refusal raised BEFORE the
                     status claim, so a refused completion leaves the task OPEN
                     with nothing half-applied. THREE refusals are possible: no
                     `BookingModification` anchor to settle against; an anchor
                     whose credit key is already taken - owner decision D-3032-1's
                     obliged edge case, refused rather than reaching an untyped
                     throw inside the credit writer; and a card amount larger than
                     the booking's captured Stripe total, measured off the
                     captured transactions rather than the `Payment.source`
                     column, whose schema default would otherwise send a
                     hand-settled booking down the card path. The member-facing
                     event follows the money: REFUNDED only once Stripe returned a
                     refund id, CREDITED where account credit was issued. The card
                     route persists its refund DEBT - the frozen per-transaction
                     slices and a TASK-scoped Stripe key prefix - inside the same
                     transaction as the claim, before any provider call, so a
                     crash in the commit-to-Stripe window is replayed by the
                     recovery cron rather than lost. The prefix and the recovery
                     operation are keyed to the TASK and not to the
                     `BookingModification`, because ONE BOOKING can hold two
                     review tasks against one modification row - before #4317
                     a consent removal exempted from the pending-review fence
                     could raise its own beside an open one. (Until #3498 one
                     EDIT could raise
                     several, one per guest strand; since then it raises one
                     per EDIT, except where the edit moved two or more guests'
                     nights - then one per recorded strand again, because a row
                     holds one amount. `INV-PAY-100`.) A Xero modification
                     credit note for the same amount is queued on the same anchor
                     after the commit, through `queueXeroBookingEditSettlement`.)
OPEN -> DISMISSED   (#3030: for an `EDIT_FINANCIAL_REVIEW` task this means
                     REVIEWED, AND THIS SYSTEM MOVED NO MONEY for that occurrence
                     - a real decision, which is why it is not the same thing as
                     an unknown amount. The REQUIRED note is what says which
                     decision it was: nothing was owed, or the club settled it
                     outside this task. Both are honest here and neither pretends
                     money moved, which is the property requirement 7 asks for.
                     It writes NO amount at all: putting a zero there would be the
                     magic value this epic exists to remove. #3032: and it takes
                     NO settlement route - no allocation, no credit, no Stripe
                     call, no Xero note and no booking event - so nothing
                     downstream can read a dismissal as money having moved.)
DISMISSED -> OPEN   (#3498, owner decision D2: an officer with finance:edit puts
                     a dismissal back on the queue. A dismissal is a DECISION and
                     a decision can be wrong; a COMPLETED row is a MOVEMENT and
                     stays terminal, refused by status before anything is
                     claimed, because its money settled against an anchor that
                     can only pay out once. A dismissal with NO
                     `completedByMemberId` is refused as well - those are the
                     webhook's own arm above, recording a capture Stripe had
                     already refunded, so putting one in the hand-settle queue
                     would invite a second refund. The transition is the same
                     status-fenced conditional update as every arm above, in the
                     other direction; it moves no money and calls no provider; it
                     clears `completedAt` and `completedByMemberId` and leaves the
                     dismissal's own `note` exactly as it was written. A note is
                     REQUIRED and goes to the audit entry
                     `booking-payment.manual-refund-task.reopen`, which carries
                     who dismissed the row, when, and what they said - the claim
                     clears all three off the row, so that entry is the only
                     place they survive. Everything the OPEN status governs
                     re-arms with it: the pending-review fence, and the
                     member-facing banner. See `INV-PAY-099`.)
OPEN -> DISMISSED   (#3643, owner decision 28 Sep 2026: the ONLY close of a
                     part-payment review - a `CANCELLED_BOOKING_HAND_BACK`
                     marked by `partPaymentReviewPaymentId`, raised with no
                     amount and no `paymentId` inside an officer's DECISION 2
                     unpaid-cancel claim, one per payment in any status.
                     COMPLETED is refused at the door and unrepresentable in the
                     database (`ManualRefundTask_part_payment_review_shape` with
                     `ManualRefundTask_completed_amount_present`): the payment is
                     settled in Xero, not here. The dismissal quiets the Xero
                     repair tool's manual-review finding for the booking, and a
                     reopen re-arms it. See `INV-PAY-107`.)
DISMISSED -> OPEN   (#3643, orchestrator decision 3: the inbound Xero sync,
                     when a PAID event arrives for a payment with a
                     part-payment review. It moves no money: it writes onto the
                     review when it learned the invoice was paid and the
                     invoice's cash, once, and reopens it, status-fenced under
                     `pg_advisory_xact_lock(1)` and audited as a reopen with no
                     actor. An OPEN review gets the same note and stays OPEN. An
                     email is attempted, best-effort; the note is the record.
                     See `INV-PAY-108`.)
```

**#3827 (owner decision D-3813-6): an edit's refund hand-back follows this
lifecycle unchanged.** A price reduction on a booking not paid through Stripe
raises the task OPEN, inside the edit's transaction, keyed one per
`BookingModification`; it is completed or dismissed exactly as a cancellation's
hand-back, except that its completion queues no Xero document, because the
edit's own credit note already corrects the invoice, and its `REFUNDED` event
is marked so the narrative never reads it as a cancellation's settlement. While
it is OPEN its amount is cash already promised back: later edits, acceptances
and cancellations refund only what is left, and a DISMISSED one cannot be
reopened past that. See
[`INV-PAY-117`](invariants/payment-and-settlement.md#inv-pay-117).

**#3827 (owner decision D-3813-7): so does an approved refund appeal's.**
Approving a refund request raises the task OPEN for the part of the approved
amount no card refund carries, inside the approval's transaction under
`lock(1)`, keyed one per `RefundRequest`, and nets it as above. Its completion
queues that request's own Xero refund credit note for the amount paid back
(owner decision D-3813-8; the approval queues none for this part), and its
`REFUNDED` event is marked the same way. It may be DISMISSED with a note even
though the booking is cancelled, because the cancel came first and never
counted it. See
[`INV-PAY-118`](invariants/payment-and-settlement.md#inv-pay-118).

**#3949 (owner decisions, 15 and 21 Oct 2026): on a joiner the organiser paid
for by Internet Banking, both go back to the organiser.** The same OPEN ->
COMPLETED or DISMISSED transitions, guarded the same way, but COMPLETED records
the refund on the child's payment mirror (REFUNDED or PARTIALLY_REFUNDED) under
`lock(1)` and then the `Payment` row, because that payment holds no captured
transaction to allocate against; the group's settlement row does not move. It
completes on a live child and after the organiser's group cancel alike, so the
edit's task that the cancel netted is paid rather than stranded. A
refund-direction edit financial review on a live child completes the same way,
and so does the hand-back a joiner's own cancel of such a place raises (owner
decision, 22 Oct 2026: the organiser is refunded, never the joiner's credit);
on a cancelled one it is refused, task OPEN. While the organiser's group cancel
is part-way through (the group CANCELLED, this child not yet claimed) a
completion is refused, task OPEN, no edit or appeal raises a new one, and no
edit (adding a guest included) changes the child's price or charges a change
fee, whatever settlement it chose (the change is refused whole), so the
organiser is never paid twice. No Xero
note is queued until #4292: after the commit admins are alerted to credit the
group's invoice by hand. See
[`INV-PAY-137`](invariants/payment-and-settlement.md#inv-pay-137).

**#4162 (owner decision 17 Oct 2026): a bank refund to re-confirm follows it
too, raised by a void.** When Xero voids the credit note of a bank hand-back,
the nightly follow-up (`INV-ADDPAY-042`) takes that refund back out of the
payment's records and inserts ONE new task OPEN - never a reopen: the completed
hand-back stays COMPLETED (#3498) and its ledger line is reversed instead. It is
a `CANCELLED_BOOKING_HAND_BACK` keyed `bank-refund-void:<payment>:<note>` (the
claim, so one per voided note), or `bank-refund-void:<payment>:<note>:<line>`
for each refund a person picks for an unmatched note, netted from refundable cash while OPEN like an
edit's. OPEN -> COMPLETED needs one of two answers (raise a fresh credit note
keyed on the task; or the hand-made note's number, checked in Xero before the
transaction and then tracked), writes the allocation and the `BANK_REFUND` line
as any hand-back's completion does, and writes NO `REFUNDED` event: the money
moved once. OPEN -> DISMISSED is "the club keeps it", with a reason. The
previous app version completes it as an ordinary hand-back.

**#4042: so does a group organiser's, except that it cannot be dismissed.** An
organiser's cancel of a group paid by Internet Banking raises the task OPEN on
the organiser's booking, inside the first per-child claim that books a
joiner's refund, under `lock(1)`, keyed one per settlement; each later claim
sets its total, derived from the joiners the ledger proves refunded, while it
is OPEN (a share booked after it closed raises a supplementary task keyed per
joiner for what nothing covers). It carries no `paymentId`: the cancel
already booked those refunds on the joiners' own payments, so COMPLETED
records only that the officer repaid the organiser and writes no allocation,
ledger line, Xero note or `REFUNDED` event. COMPLETED takes `lock(1)` and
must name the total the screen showed; a missing or grown total is refused. DISMISSED is refused: the
refunds are booked as made, so not repaying is the treasurer's correction.
See
[`INV-PAY-124`](invariants/payment-and-settlement.md#inv-pay-124).

**#4097: so does a card cancellation's refund shortfall.** An own-card cancel
whose frozen card refund plan carries less than the refund due raises up to two
tasks OPEN inside its claim, keyed per booking: the part the payment's non-card
charges hold (owed by bank transfer) and the rest (checked before paying). Each
is a cancellation's own hand-back: completed or dismissed as the cash cancel's,
with no `lock(1)`, except that COMPLETED is refused (409) while the cancel's
card refund recovery is not SUCCEEDED and, for the part to check, while its
bank-transfer sibling is OPEN; it settles on the non-card charges first,
posts its `BANK_REFUND` line on the card payment, which no refund row will
post, and queues one Xero refund note of its own, keyed on the task. Where the
payment's ledger has nothing left to allocate, COMPLETED is refused with a
message naming DISMISSED, which the treasurer then uses. See
[`INV-PAY-129`](invariants/payment-and-settlement.md#inv-pay-129).
A capacity race whose card refund plan is short of the charge raises the
part to check alone, OPEN inside the void's claim and keyed on the race's
intent (#4154); its COMPLETED is refused while any of the race's own card
refund rows is not SUCCEEDED, and settles only on that intent's own charge.
Where that charge holds too little, the completion first lowers its refunded
total to its refund rows when every guard holds (the owner's guarded
recalculation), else is refused naming the guard (DISMISSED and a Xero note by
hand). See
[`INV-PAY-135`](invariants/payment-and-settlement.md#inv-pay-135).

**#3498: and one of the two terminal states is no longer terminal.** A DISMISSED
row can be put back OPEN by an officer, which is the arm above; a COMPLETED row
cannot. Nothing about the RAISE changed with it - the raise still never reopens,
amends or re-keys a settled row, and the recurrence walk below is untouched -
because reopening is an officer's own audited act rather than something a later
edit does.

**#3030/#3166: terminal is terminal FOR THE ROW, and for nothing after it.** An
`EDIT_FINANCIAL_REVIEW` task carries an `occurrenceKey` - the identity of the
structural edit that raised it. A REPLAY of that edit finds the existing row and
raises nothing; a COMPLETED or DISMISSED row is not a replay's answer at all, and
since #3166 it no longer suppresses the next occurrence of the same identity -
that raise takes a `#n` recurrence key of its own and the settled row is left
untouched. An earlier revision of this paragraph said a replay raises nothing
"whatever state it has reached", which is the pre-#3166 rule and the money it
lost. Where the key is minted, what counts as
"the same structural edit", what separates a replay from a new edit of the same
shape, and which database constraints hold the rules up are
stated once, in [`INV-PAY-051`](invariants/payment-and-settlement.md#inv-pay-051)
- not restated here, because one rule with three homes is one rename away from
two of them lying.

**#3030: an OPEN task MAY carry an amount, and that is a defined state.** The
raise accepts `raisedAmountCents`, which is written to both `amountCents` and
`raisedAmountCents` at creation, so a `priced-but-still-OPEN` row is legal. It
means *the edit could prove a figure and a human has not yet confirmed it* - not
that anything has been decided and not that any money may move. Nothing moves
until a COMPLETED transition, whatever the row already holds. The ordinary case
remains `amountCents` NULL: genuinely unknown, and never a zero standing in for
it.

**Where a terminal row is read, and the #2750 decision behind it.** Both
terminal states are terminal for the row, not for the operator: the finance
queue on `/admin/payments` shows OPEN rows as work to settle, and since #2750
also shows the webhook-closed rows above as a read-only **"Refunded
automatically — nothing to pay back"** card, bounded to the last
`AUTOMATIC_REFUND_NOTICE_WINDOW_DAYS` (30) by `completedAt`. Before that, the
webhook's own close took the row off the only screen it ever appeared on, so that
durable record of an automatic refund was visible only to somebody who thought to
query the table.

**That card is complete for BOTH late-capture paths since #2760 then #2773, and it
used not to be.** As #2750 shipped it
the task had a single creator — the confirm-modification-payment endpoint — so a row
existed only on the ordering where the member's browser got there before the webhook
did. Webhook first (the healthy case), a member who closes the tab after paying, and
the interleaved ordering the raise's own refund fence declines all refunded the
capture and left nothing for the close to claim, and the raise never fired at all
for a booking that is CANCELLED but not deleted. The webhook now writes the
DISMISSED row itself when its OPEN-fenced close claims nothing, for both
populations (`recordAutomaticCancelledBookingRefundTask`, #2760 — owner decision
10 Aug 2026). #2773 then routed the SIBLING handler for a booking's OWN payment,
`handleCancelledBookingPaymentSucceeded`, through the same writer, so every
automatic refund of a late capture inside the card's window is on the card — an
orchestrator decision the owner has not ruled on, reversible, with the authority
line under `INV-ADDPAY-039`. The two are stated as separate sentences on purpose:
a real owner decision and an unruled one sitting inside one clause is what made
this branch's fabricated attribution credible in the first place. The card groups the deleted rows apart from the merely cancelled ones so
normal operation cannot bury the interesting case. What is still bounded is the
window, not the record: the row and the
`booking.payment.refunded_after_cancellation` audit entry are permanent.

**Both handlers share ONE implementation of the epilogue**
(`src/lib/cancelled-booking-late-capture.ts`): one record writer, one post-refund
`deletedAt` re-read, one alert decision. Four `reason` sentences exist, one per
(capture kind, population), because the sentence is stored on the row and printed on
the card — calling a booking's own payment a "booking modification payment" would
print an operator-facing falsehood.

**Two exceptions in `INV-ADDPAY-037` remain, and a reader of this diagram should not
assume them away.** An operator who resolves the `OPEN` task by hand before the
refund lands leaves a row that matches neither the close nor the card's filter, so
that refund reaches no card and is named only at WARN — the carve-out #2774 D1 keeps,
an orchestrator decision the owner has not ruled on (authority line under
`INV-ADDPAY-039`). And if the record write itself fails, the `critical`
`booking.payment.auto_refund_record_failed` audit entry names it and, since #4149,
the handler still writes the refund entry (marked `recordLost`) and sends the
alert, then answers 500: Stripe's redelivery (or the nightly self-heal, before it
raises any card note) writes the missing row once - closing a still-`OPEN` #2700
task - with a `booking.payment.auto_refund_record_recovered` entry, and sends
the alert again, because the first read its recipients from the database that
had just failed: a duplicate, never a silence (#2761;
`late-capture-record-recovery.ts`). A `charge.refunded` arriving before that row
queues no generic card note (#4170).

**AND SINCE #2774 ONE THING CAN STOP THE REFUND ITSELF (`INV-ADDPAY-039`).** If a
`ManualRefundTask` for the capture is already `COMPLETED`, an operator has paid the
member back by hand and `applyLocalRefundAllocation` wrote the allocation — so
Stripe's refund on top of it pays the member twice. The refund is withheld before it
is made, a `critical` `booking.payment.late_capture_refund_withheld` row is written
(`outcome: "blocked"`, never `refunded_after_cancellation`, which would claim a
refund that did not happen), and the club is alerted that the money did NOT go.
`DISMISSED` must NOT block: no allocation exists, so blocking would leave the club
holding the member's captured funds. A hand-completion landing DURING the refund is
not preventable without holding `pg_advisory_xact_lock(1)` across a Stripe call, so
it is detected afterwards instead and reported as
`booking.payment.late_capture_double_refund_suspected`.

#2750 asked whether the #1350 automatic refund should instead be **gated**,
leaving the task OPEN so a person decides. It was not, and the reasoning is
recorded rather than assumed: the member's money returning is the safe direction
when nobody is watching, gating it means the club holds a member's money until
somebody acts, and it would put a new condition on a Critical webhook money
path. The club is already emailed the moment it happens —
`handleCancelledBookingAdditionalPaymentSucceeded` has always mailed an admin alert
on this path, naming the amount and the auto-refund, and since #2761 that mail has
its own accurate subject and cannot be muted (`INV-ADDPAY-038`); since #2773 the
primary handler sends the same mail instead of the generic muteable "Payment Failed"
one — so what was missing was somewhere to look afterwards, not a notification.
Exactly one notification per event still holds across all three outcomes: the
auto-refund alert, the withheld-refund alert, or the possible-double-payment
alert, never two of them. The card
carries no controls — there is no decision left, and "Mark paid back" on such a
row would write a second refund allocation — and its copy names the one thing an
operator may still have to do: if the deletion rather than the payment was the
mistake, the booking has to be made again and the member charged again, because
the refund has already gone out. The rows it shows are defined once, in
`automaticallyRefundedManualRefundTaskFilter` (`INV-ADDPAY-037`), which the
route uses rather than restating; an operator's own dismissal never appears
there.

There are FOUR creators, and only the first, second and fourth ever make an OPEN row:

- Created atomically with the CANCELLED claim when a **cash-settled** booking is
  cancelled with a non-zero policy refund. A zero-refund outcome creates no task.
- Created by `confirm-modification-payment` when a **card** modification payment
  is captured against a booking the club has already soft-deleted (#2700,
  `INV-ADDPAY-036`): the capture is recorded rather than refused, and an OPEN
  task asks a person to decide. Raised under `pg_advisory_xact_lock(1)`,
  idempotent on the payment intent, and fenced against a refund that already
  happened, so it is never raised for money Stripe has already returned.
- Created **already DISMISSED** by the Stripe webhook when it auto-refunds a late
  capture on a cancelled booking and its OPEN-fenced close claims nothing (#2760,
  `INV-ADDPAY-037`), from EITHER late-capture handler since #2773. Never OPEN —
  there is no work, and completing such a row throws out of
  `applyLocalRefundAllocation` — and never `COMPLETED`, which would write a second
  refund allocation for one refund. Both populations and both capture kinds, each
  storing its own `reason` sentence; every lookup matches all four sentences, so a
  deletion landing between two Stripe deliveries cannot produce two rows and a
  future writer cannot key on its own sentence alone. Under the same
  `pg_advisory_xact_lock(1)` as the raise above, because close-or-create is a
  find-then-write rather than an atomic fenced update. On the PRIMARY path there is
  never an `OPEN` row to close — nothing raises one for a primary intent — so the
  create arm is the only one reachable there.
- **Legacy: settles tasks raised before #4317.** Since #4317 every booking edit
  is priced from stored data (`INV-MOD-028`) and nothing raises this kind; the
  tasks already OPEN are worked through this lifecycle until waves B and C of
  epic #4302 settle them and retire it. It was created by a **booking edit whose
  exact sold price could not be read from the booking's own stored history**
  (#3030, epic #2797; `kind` `EDIT_FINANCIAL_REVIEW`). Owner decision D1: the
  stay change is applied and
  only the MONEY is held, so the booking never disagrees with reality while an
  admin prices the adjustment. Raised by `raiseEditFinancialReviewTask`
  (`src/lib/edit-financial-review.ts`) INSIDE the caller's transaction, so the
  structural edit and the one task are atomic locally, and under
  `pg_advisory_xact_lock(1)` — the same cohort and the same reason as the two
  raisers above, because create-or-find is a find-then-write. Idempotent on the
  `occurrenceKey` rather than on any `reason` sentence: text is not an identity,
  and #3030 rejects it as one by name. This is the only creator that may leave
  `amountCents` and `paymentId` NULL (owner decision D2), and it carries the D3
  evidence in `reviewContext` — the cause, the guest strand, the nights given
  back, the stored guest total and whatever stored night prices existed, and the
  booking dates. The booking's payment and rate history is deliberately NOT
  copied there: the admin surface links to the live one. #3032 adds the
  `bookingModificationId` the completion settles against (owner decision
  D-3032-1) to that context - a pointer to a row, deliberately NOT part of the
  occurrence identity, so carrying it cannot re-identify a replay. #3030 shipped
  the state and #3032 the settlement and the fence; #3031, #3032 and #3166 added
  the raise callers, and #4317 removed every one of them.

**#3032: while a review is OPEN, a MONEY-AFFECTING edit to that booking is
refused** (legacy: only a review raised before #4317 can be OPEN).
`assertNoPendingEditFinancialReview` (`src/lib/edit-financial-review.ts`)
is called by the batch, date and guest-removal edit services, the guest-add route
and the acceptance re-price under their locks, on
the post-lock re-read and before any write, and answers `409` with the code
`EDIT_FINANCIAL_REVIEW_PENDING`. It is deliberately narrow. An identity-only edit,
a credit election and the price-preserving admin date shift are not fenced,
because none of them reads the booking's stored money. Nor is a CONSENT-AUTHORITY
removal (`CONSENT_DECLINE` / `CONSENT_EXPIRY`): owner decision D-14 says a member
who never consented must always be able to come off a booking, so that removal
proceeds rather than being held behind a pricing question nobody has answered.
No removal parks its money since #4317, so the exemption's only effect is that
the fence does not refuse it.

The transition is a status-fenced conditional update, so a double click can
never double-apply the allocation, and the row is never processed by any cron —
it deliberately is not a `PaymentRecoveryOperation`. (That dispatcher's final
arm used to execute ANY unknown enum member as a superseded-payment Stripe
refund; since #2262 it rejects an unhandled type with an explicit throw, but a
task a cron must never execute still does not belong in a cron-executed table.)

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
outbox claim -> charge already invoiced AND emailed -> operation SUCCEEDED (skipped ALREADY_EMAILED; no provider call) (#3971)
FAILED operation -> Xero Operations Retry -> same row PENDING, same correlation key (charge from localId, INV-INT-026)
  refused (409, no write) when the charge already has a Xero invoice, needs none (VOIDED/NOT_REQUIRED/NO_INVOICE),
  another attempt for it is live, or a sibling was resolved in Xero after the row was queued
provider reference exists but snapshot differs -> CONFLICT (no provider rewrite)
outbox claim -> a covered subscription already PAID, no invoice yet -> CONFLICT (SUBSCRIPTION_ALREADY_PAID; no provider call)
CONFLICT (SUBSCRIPTION_ALREADY_PAID) -> officer "Close: already paid" (finance edit, required reason) -> NOT_REQUIRED (#4098)
  only while EVERY covered subscription is still settled — PAID, or NOT_REQUIRED for an exempt member
  (re-checked in the guarded write); releases the
  charge's ACTIVE coverage claims and bumps each voidGeneration; audited; a repeat is a no-op success;
  refused (409, no write) while an invoice operation for the charge is queued or running, or while
  any covered subscription is unsettled (advice: pay the rest then close, or unpay every one then Retry);
  Close is offered only where every active covered subscription is settled
NOT_REQUIRED (closed) family charge -> still counts as billing its family (a new joiner -> FAMILY_ALREADY_BILLED)
  until a covered member's PAYMENT is reversed (PAID at the close, recorded on the released claim, and no longer
  settled) -> the next preview re-bills the family on a NEW charge beside the retained row; only SOME payments
  reversed -> CLOSED_FAMILY_PARTLY_REVERSED warning, and an officer's confirm still invoices the full family fee
  (#4110; the unique index covers live charges only); a member NOT_REQUIRED at the close later moved to
  NOT_INVOICED (assignment save, membership sync) is no reversal -> the family stays billed; only members still
  BILLED through the family count (their billing family when they are in several), so a covered member who moved
  to another family and was then reversed does not re-bill the old one
two closed charges for one family/type/season, no live one -> the NEWEST closed charge decides alone WHETHER the
  family is re-billed (owner, 16 Oct 2026: "newest charge wins"; rows are grouped and sorted, never read in arrival
  order): while it is settled the family stays billed even if a payment only an older closed charge covered was
  reversed; when it re-bills, the CLOSED_FAMILY_PARTLY_REVERSED warning still counts a payment standing under ANY
  closed charge for the family (decision 1)
member a closed charge for the family covered who is no longer settled — exempt at that close and now owing, or
  paid there and since reversed — while the newest still bills the family ->
  CLOSED_FAMILY_MEMBER_NEEDS_DECISION (withheld, counted under "Needs your decision"; the family is never re-billed;
  Finance marks the member Paid if the family fee covers everyone, otherwise invoices the difference in Xero by
  hand) -> regenerated by every preview, so it stays OPEN across runs and refreshes -> member settled or holding
  a Xero invoice -> no longer regenerated -> the next confirm or refresh RESOLVES it (#4110 decisions 4 and 5);
  a covered member still settled (a tier-exempt child still NOT_REQUIRED) gets no exception at all
bare live Xero invoice held by a member a closed charge for that family AND type covered without a standing payment
  (exempt at a close, or reversed under an older charge and not paid at the newest close: Finance's difference
  invoice) -> does not suppress the family, so a later reversal still re-bills it; any other bare invoice, including
  a parent's own family invoice when they were paid at the newest close, suppresses as #2161 requires
family with a reversal under the newest closed charge, held back (#2161 bare invoice, active family claim or
  operator marker) -> every member a closed charge covered who is no longer settled (reversed under the newest or
  an older charge, or exempt at a close) gets CLOSED_FAMILY_MEMBER_NEEDS_DECISION naming what holds the family
  (an invoice, a family charge or an operator's marker); a new joiner gets none; never a re-bill, and an approval
  bills nothing
re-bill of a closed family while a member's difference invoice passed the hold (same type, basis not per-member) ->
  CLOSED_FAMILY_REBILL_BESIDE_INVOICE warning naming the member and invoice (an officer confirms through it; an
  approval withholds the family for Finance)
stated limit: a member PAID through a Xero invoice at the close, moved to an exempt type (the sync's NOT_REQUIRED
  write clears the link) and back (NOT_INVOICED), reads as reversed until the next paid-status refresh relinks
  the still-paid invoice; a preview in that window offers the family for re-billing
membership approval (NEW_MEMBER_APPROVAL) preview with a CLOSED_FAMILY_PARTLY_REVERSED warning -> that family is
  withheld (no charge), the warning persisted OPEN for Finance and counted -> Finance's confirm invoices it and
  RESOLVES the warning (resolvedVia CONFIRM)
VOIDED family charge -> never counts as billing its family -> re-billed by the next preview (#2147, #4110)
invoice attempt in Xero when the close lands -> guarded INVOICE_CREATED write matches nothing -> no link,
  no downgrade, no email; the closed charge carries STRAY_INVOICE_AFTER_CLOSE naming the invoice to void
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

`NOT_REQUIRED` and `VOIDED` are the no-invoice statuses
(`MEMBERSHIP_CHARGE_NO_INVOICE_STATUSES`): the enqueue (and so Retry), the
outbox worker, its failure handler and Xero Operations Retry never invoice or
reopen a charge in either, and the worker skips an operation queued for one in
a race. A `NOT_REQUIRED` charge on any basis but
`NO_INVOICE` is one an officer closed as already paid, because confirmation
writes `NOT_REQUIRED` only for `NO_INVOICE`. The close releases the claims
(rather than keeping them, as a `NO_INVOICE` charge does) so the subscription is
left exactly as a member marked paid before billing: skipped while PAID, and
re-billable with a fresh idempotency key if the manual payment is later
reversed — on a per-family charge too. A closed family charge keeps counting
as its family's charge while every subscription it covered is settled, so a new
joiner still meets `FAMILY_ALREADY_BILLED`; a reversal stops it counting, and
the family/type/season partial unique index (live charges only, #4110) lets the
re-bill's new family charge sit beside the retained row. A VOIDED family charge
never counts. It takes no advisory lock — the charge claim and
the PAID check are each a guarded write, so two closes close once and a
reversal that commits first rolls the close back. Every charge-status write the
invoice pipeline makes is guarded to live charges, so none can reopen a closed
charge; an attempt already in Xero when the close lands leaves its invoice as a
stray the officer voids, named on the closed charge.

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
fresh idempotency key. Closing a charge as already paid (#4098) releases its
claims and bumps the generation the same way, leaving the row `PAID`. A voided
per-family charge never counts as the family's charge in the preview; a closed
one does until a covered member's payment is reversed — `PAID` at the close
(the close records each claim's status in `subscriptionStatusAtClose`) and no
longer settled — so a new joiner is still refused but a reversed member is
billed again on a new family charge, with a warning when only some payments
were reversed (owner decisions, 15 Oct 2026; #4110). An exempt member,
`NOT_REQUIRED` at the close, had no payment to reverse: an assignment save or
membership sync that later moves them to `NOT_INVOICED` leaves the family
billed, and Finance is asked to decide how to bill them
(`CLOSED_FAMILY_MEMBER_NEEDS_DECISION`, owner decision 4, 16 Oct 2026). With
two closed charges for one family the newest decides (owner decision 5).

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
approved, not by card -> OPEN officer refund task -> COMPLETED records the refund (#3827, D-3813-7)
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
stranded free confirm, admin repair -> WAITLISTED
```

An entry may legitimately sit over nights a whole-lodge hold covers (#2930).
That became reachable when the member calendar started letting a full future
night be selected — which is how the waitlist is reached at all — so
`capacity unavailable -> WAITLISTED` now includes "unavailable because the lodge
is held". It changes no transition. Promotion is gated on
`checkCapacityForGuestRanges(...).available`, and a hold forces that false
whatever the bed arithmetic says (`INV-CAP-021`), so the entry keeps its queue
position until the hold is released rather than being offered or cancelled. The
member is never told which of the two kept them waiting (ADR-001 decision 6).

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
admin previews + applies removal -> selected rows deleted; causal partner promoted
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

The selected lodge's `BedAllocationSettings` governs both the explicit board
run and this lifecycle reconcile (#2593). After placement count and the hard
school/age-mix rules, feasible layouts are compared lexicographically in the
saved top-to-bottom order: booking cohesion, stay continuity, requested room,
and direct-family cohesion by default. Any subset — including `[]` — is valid;
omitted settings use the default. The split planner executes at most 24
deterministic matching-layout candidates, including connected-family,
direct-group, direct-pair, capacity-aware high-affinity room packing, and
maximum-cardinality direct-edge pairing orders; whole-room, legacy, and
displacement trials are additional. This is a bounded
heuristic rather than a global optimum. Saving a different order is not a
lifecycle transition and rewrites no allocation: it changes only plans made
after the save.

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

Two occupancies with no booking behind them feed this invariant as
attribution-less rows and so are covered by that last clause: a **custodian bed
hold** (#2286) and, since #2317, an **exclusive whole-lodge hold** — every
active bed of the held lodge on every held night, less the bed-nights a
custodian holds (`INV-CAP-038`, #2698), so the two sets are disjoint and a
bed-night is claimed exactly once. Both are tierless, so both
read as an adult: another booking's unaccompanied minors are kept out of the
rooms, and no name, booking id or age tier of the held group ever reaches the
planner. Neither can be displaced: neither has a row to move, and — because a
real allocation row may sit on the same bed on the same night, and planner
occupancy is keyed `bedId:stayDate` — the planner also pins those bed-nights as
permanently occupied, so evicting the co-located booking releases that
booking's claim and never the hold's.

Reconciliation widens its loads to the envelope of every booking overlapping
the reconcile range (`min(checkIn) .. max(checkOut)` union the range) so the
planner sees whole stays, while the set of bookings planned stays restricted
to those overlapping the original range (no cascade).

On the admin allocation board, every existing-chip drag/drop and nested
**Move to bed** choice opens one reviewed move dialog. The hovered date column
never changes an existing allocation's night. Pointer and keyboard interactions
name the destination and original night, then stop at confirmation; cancel sends
no request and restores focus. The current bed stays selectable so the admin can
review a person-wide consolidation or an all-noop outcome.

The dialog starts at `ALLOCATION_NIGHT` and may widen to `BOOKING_GUEST`, which
resolves every existing row for that guest on the booking (including sparse and
off-screen rows, up to 366) without creating any. Its read-only preview separates
changed and unchanged rows, exact NZ nights, approval-to-draft consequences,
shared-double promotions, and hard conflicts. Apply carries that scope plus the
anchor, destination and digest — never a target date — and takes global booking
`lock(1)`, the complete sorted lodge union, sorted member-lifecycle and
member-partner-link families, then deterministic allocation-row locks before an
authoritative re-preview. Cancellation uses the same global key, so a post-cancel
move cannot resurrect a row.

A matching apply writes every changed row with one guarded bulk statement,
preserving dates and making approved rows unapproved `MANUAL` drafts. Partner
promotions and their cross-booking causal audit attribution commit in that same
transaction. Any conflict or stale fact refuses the whole move; digest drift
returns a refreshed preview and requires a second confirmation. Unchanged rows
are never re-drafted, promoted, written, or audited, and an all-noop confirmation
succeeds audit-free. Bucket-to-board bulk placement keeps its older per-night
conflict semantics. The legacy allocation-id/destination request remains capped
at 31 rows for older callers but is no longer the board's existing-chip seam.

The board's "Run Auto Allocation" uses the same whole-stay planner without
displacement. Its displayed suggestions are only a preview: the action takes
global booking `lock(1)` then the selected lodge lock, authoritatively rebuilds
only after confirming that lodge is still active, then rebuilds the scoped
inventory/booking/occupancy/hold plan through that transaction and constructs
and inserts AUTO rows. A room or bed deactivated/retyped
after preview therefore cannot be written from the stale plan. The board raises
a stay-level `ROOM_SWITCH` warning when a booking's rooms change between nights,
plus a `MINOR_ADULT_MIX` warning on any persisted room-night that mixes one
booking's minors with another booking's adults (#1768).

**Range assignment (#2251).** "Assign range…" places ONE guest on ONE bed
across a range of any length — the board's 31-night window bounds the read, not
the write. The write is attempt-first (there is deliberately no dry-run/preview
step) and atomic: any blocked night refuses the WHOLE range, nothing is written,
and the refusal report names each blocked night in one of three distinct
categories — the bed is already allocated that night (naming the occupying
guest; a provisional occupant still counts, so nothing is silently overwritten),
the guest is not booked that night (a **bad request**, never a silent skip —
including a gap night of a non-contiguous stay, #713), or **the guest's own
booking** holds the whole lodge (ADR-001's short-circuit — a held booking owns no
per-bed rows, so the whole range is refused). Another booking's overlapping hold
is NOT a blocker here: it is surfaced on the board as a banner and an
`overlapsExclusiveHold` badge, exactly as it is for every other allocation path.
A second, explicit "assign the N free nights" action re-sends the exact night
list the report showed, and the server writes that set or refuses it with a fresh
report. When the report contains nights the guest is not booked on, that action
asks for an explicit confirmation first — naming how many nights are not part of
the guest's booking and will NOT be assigned, and how many will — so a partial write is never
one click away from a warning. Either way the operation records exactly one
`BED_ALLOCATION_RANGE_SET`
audit entry (`targetId` = the booking id, written inside the same transaction as
the rows) carrying the requested range, what was written, and what was refused —
as counts and night runs, without the other bookings' guest names, which stay in
the response to the admin. If the move stranded partners on shared doubles, the
same transaction adds ONE batched `BED_ALLOCATION_PARTNERS_PROMOTED` entry for
all of them (capped list + exact count + truncation flag) rather than one entry
per promotion, so a 366-night range writes a bounded number of audit rows as well
as a bounded number of statements; the single-night and bulk board paths keep
their per-promotion `BED_ALLOCATION_PARTNER_PROMOTED` entries. Range assignments
**auto-approve**: their rows land with `approvedAt`/`approvedByMemberId` stamped
rather than as drafts. Board single-night and drag placements are deliberately
NOT auto-approved — draft-vs-approved remains the suggestion-vs-confirmation
distinction. One consequence to state plainly: because
`isBookingBedAllocationLocked` is "at least one approved row exists" (#776), the
member's requested-room editing locks on the FIRST range assign, not at a later
confirmation step; the assign dialog says so before the admin commits. Manual
allocation of a whole-lodge-held booking is refused outright at the write
chokepoint, matching the lifecycle prune (#2285).

**Reviewed removal (#2594).** Removal is an explicit PREVIEW → APPLY transition,
not a one-click row delete. Preview writes nothing and classifies a non-empty
selection as Auto draft, Manual draft, and/or Approved within exactly one scope:
the anchored allocation, that person on that booking, the whole booking, or the
selected lodge's visible half-open window (maximum 31 nights). Person and
booking scope include matching rows outside the page; window scope does not.
The preview states category counts, affected bookings/nights, causal
shared-double promotions, and which bookings will have no approved row left and
therefore re-open requested-room editing.

APPLY must carry that preview's `v1:<sha256>` digest. Under global `lock(1)` →
the sorted immutable booking/anchor lodge locks → sorted selected/causal
allocation-row locks, it rebuilds the same state and refuses any historical
third-lodge anomaly. Drift produces a 409 refreshed preview and no
transition. A match atomically deletes every selected row, changes each
surviving causal shared-double occupant from second to primary, and records
`BED_ALLOCATION_REMOVAL_APPLIED` plus the bounded
`BED_ALLOCATION_PARTNERS_PROMOTED` audit when needed. There is deliberately no
edge from APPLY to auto-allocation: freed nights stay unallocated until a later
manual placement or explicit **Run Auto Allocation**. Preview requires
`bookings:view`; APPLY requires `bookings:edit`; the retired direct
`DELETE /api/admin/bed-allocation/allocations/[id]` is no longer a transition.
When only the opening row of a booking/person scope disappeared, the 409 preview
re-anchors to the lowest-id matching survivor; the current apply still writes
nothing, while a newly reviewed apply is no longer trapped on a dead row id.

Draft rows still arise constantly, which is why a confirmation step remains a
real affordance rather than a legacy one: board single-night and drag placements
create them, auto-allocation writes `source: "AUTO"` suggestions as drafts, and a
MOVE **re-drafts** an approved row (the upsert's update branch clears
`approvedAt`/`approvedByMemberId`). From inside a booking (#2252) those drafts
are approved with a **booking-scoped** approval: `approveBedAllocations` takes
`bookingId` as a first-class selector, sufficient on its own, so confirming one
booking can never stamp another booking's pending rows the way the `from`/`to`
form would. It carries the panel's ADR-003 lodge scope too, so the write scope
matches the lodge-scoped read the card displayed. That approval audits
`BED_ALLOCATION_APPROVED` with `targetId` = the booking id, so the booking's own
audit deep link finds it.

The room-request lock is therefore **two-way**, and the surfaces say so. No
un-approve action exists or is invented, but two paths can take a booking's last
approved row away and re-open the member's editor: the move re-draft above and
reviewed removal. The removal preview decides that from the booking's complete
approved-row set rather than the window on screen, because the panel pages a
stay longer than 31 nights and cannot see the rest of it. Approval, removal, and
member requested-room writes share the global serialization boundary and use
row locks/guarded predicates so a concurrent winner changes the authoritative
answer rather than crossing this transition stale.

To verify: approval status representation, conflict handling, per-night guest
uniqueness, room continuity and whole-booking displacement behavior, range
refusal categories and their single audit entry, and module-disabled behavior.

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
built-in FULL or NON_MEMBER -> archive and booking-rule changes refused -> existing archive may be reactivated, existing wrong rule restored
member role backfill -> current-season assignment created if missing
type assignment preview -> apply-from date/reason saved -> audited assignment update
booking quote/create/modify -> resolve season assignment/default -> member rate, non-member rate, or block
subscription display/gate -> resolve season assignment/default -> required or not required
annual billing preview/confirm -> resolve stored season assignment or role-default row (active or archived) -> when billing is required, require effective fee or surface exception -> snapshot charge
```

The `FULL` and `NON_MEMBER` built-ins are also resolved directly by key, so they
remain in booking use even if an old row was archived. Admin editing refuses
archiving them and changing their booking behavior away from the built-in value;
reactivation and restoration to that value remain available (`INV-LIFE-093`).

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

An archived role-default row continues to govern existing members with no season
assignment. Booking keeps its synthetic built-in policy if that row is absent;
annual billing needs the stored type ID and an effective fee, so a missing row
or fee becomes an exception instead of a charge (`INV-MONEY-016`).

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
member requests direct parent/dependant as partner -> generic 201/no link for by-email; specific 422 for authorised member-id/admin paths
target confirms from profile -> CONFIRMED (one-confirmed-partner invariant re-checked under advisory lock; other PENDING requests involving either member pruned)
target confirms after direct parentage appeared -> 409, request remains PENDING, no success audit/email
target declines -> row hard-deleted (no email), initiator may re-request
initiator withdraws own PENDING -> row hard-deleted
the adult recorded as having confirmed a NO-LOGIN adult co-member's details declares them -> CONFIRMED in one step (no consent round-trip; "one login manages the family"). Gated on Member.detailsConfirmedByMemberId naming the initiator AND the pair still sharing a family group (#2284 re-anchored this off the FamilyGroupMember.role ADMIN value, which #2520 then dropped from the database outright — there is no rank on a family membership to re-anchor onto); the voucher pointer is self-assignable by any adult login co-member, so this is an equal-adults gate, not a group-lead privilege
admin assigns directly (admin member-detail card) -> CONFIRMED immediately, assignedByAdminId recorded; an existing PENDING for the pair is promoted; both members emailed unless the admin chose not to notify (#1769a)
unregistered partner claims a createPartnerLink invite token -> CONFIRMED inside the claim transaction (claim = consent); direct-parent conflict -> family join still succeeds, partnerLinkFormed false, direct_parent_relationship skip audited
either CONFIRMED partner removes the link -> row hard-deleted, other partner emailed
admin removes any link -> row hard-deleted, both partners emailed when it was CONFIRMED unless the admin chose not to notify (#1769a); a PENDING removal emails no one
CONFIRMED link deleted (either dissolve path) -> pair's FUTURE shared double-bed second-occupant allocations swept back to the awaiting-allocation queue in the same transaction (#1756; both bookings audited, admins alerted post-commit)
member deactivated / anonymised / re-tiered off ADULT -> same sweep, single-member scope (either side of the shared bed)
CONFIRMED link DROPPED by a member merge (the master already had its one confirmed partner) -> the merge's own validity-driven reconciliation instead of the sweep above (#2595): every future shared bed-night involving the master or the duplicate is re-judged against mayShareDoubleBedWith and only the ones that no longer qualify are swept, so the master's own still-confirmed share survives
```

To verify: canonical pair ordering (`memberAId < memberBId` CHECK), the
one-CONFIRMED-partner-per-member invariant (advisory locks + partial unique
indexes), ADULT-only + no-self-partner guards, direct-parent exclusion through
both parent columns and both partner statuses in either write order, pending pruning on confirm,
one outstanding outgoing request per member, the memberId-target
shared-family-group guard on the member API, and the stale-share sweep
invariant (#1756, extended to merge by #2595): no future `isSecondOccupant`
allocation may outlive its partner link or the active-adult precondition (see
`INV-CAP-010` for the #1756 sweep and `INV-CAP-030` for the merge form, both in
docs/invariants/booking-dates-and-capacity.md).

The direct-parent exclusion also has a transactional PostgreSQL backstop (#3271):
statement triggers on both parent columns and on every `MemberPartnerLink` status
maintain one canonical `MemberParentPartnerExclusion` count row per unordered
pair. The pair primary key serializes application writers and direct SQL. The
check rejects a state with both counts positive using a stable, non-identifying
error; deleting or moving the last source edge decrements the counts and a
deferred trigger removes an empty pair row. This table is derived internal state,
not a second relationship API or an operator-editable record.

## Member Guest Consent Lifecycle ("+ Add Member Guest", #2305 / MG2 #2307, MG4 #2309)

Known `BookingGuest.consentStatus` values: `null`, `PENDING`, `CONFIRMED`,
`DECLINED`, `EXPIRED`. **`null` is the dominant state and always will be** —
every non-member guest, every family-scope guest (owner decision D-6), every row
written before this feature existed. `null` is *consent-free*, not
*consent-given*, and the two must stay distinguishable forever: `CONFIRMED`
means somebody said yes, `null` means nobody had to be asked.

```text
add, module ON, cross-family, member acting, approvalRequired=true (the shipped default, D-3)
    -> PENDING + consentRequestedAt + consentExpiresAt = min(now + N days, the day before check-in), floored at +2h; the target or their delegate is emailed
add, module ON, cross-family, member acting, approvalRequired=false (notify-only opt-down)
    -> CONFIRMED with NULL requestedAt/respondedAt/respondedBy/expiresAt ("auto-confirmed, never asked"); the target is told, not asked
add, module ON, cross-family, ADMIN acting (on-behalf, admin booking-copy, pipeline)
    -> CONFIRMED + consentRespondedAt + consentRespondedByMemberId = the acting admin (MG4-D-a, brought forward); always notify
add, family scope, or module OFF
    -> all five columns NULL (D-6, unchanged; module OFF refuses a cross-family add with the byte-for-byte pre-feature error)
booking copy of an existing cross-family guest
    -> re-stamped against the copying admin; consent is NOT transitive across bookings

PENDING -> CONFIRMED   the target, or a delegate the resolver accepts (D-5/D-10); respondedAt + respondedBy recorded; bed allocations reconciled post-commit; the booking's promo codes re-priced in the same transaction, a paid reduction returned in full the way it was paid (#3827, D-3813-5)
PENDING -> DECLINED    same actors; then the SHARED removal path (never a second delete)
PENDING -> EXPIRED     the nightly sweep, when now >= consentExpiresAt; then the shared removal path, electing account credit (D-15); respondedBy stays NULL because nobody decided
CONFIRMED              terminal. D-13: no later modification of the booking re-opens it, in either policy mode
DECLINED / EXPIRED     terminal, and normally GONE — see below

any state -> (row deleted)   the booker or an officer takes the guest off the booking, or the
                             booking-request approval substitutes somebody else onto the row.
                             The member is told once (member-guest-request-withdrawn); the
                             consent record goes with the row. NOT a status transition.
```

**A soft-deleted booking answers nothing at all, and that outranks every
PENDING edge above** (#2700, `INV-ADDPAY-035`). `respondToMemberGuestConsent`
refuses before any transition is attempted, for **every** actor — the target and
an accepted delegate alike — so `PENDING -> CONFIRMED` and `PENDING -> DECLINED`
are both unreachable once the club has deleted the booking. Nothing is recorded:
no claim, no bed reconcile, no hosting-queue drain, and no email to the booking
owner about a record the club has deleted. The refusal is asserted twice — once
unlocked to answer cheaply, and again inside the transaction under
`pg_advisory_xact_lock(1)`, which is the same key `softDeleteCancelledBooking`
takes, so a deletion committing between the two reads is serialised behind the
consent transaction and seen. The nightly `PENDING -> EXPIRED` sweep is
unaffected; it is not an answer.

**No EDIT transitions this machine, and that is owner decision D-13 rather than
an omission.** Changing a booking's dates, its lodge, its price, or the rest of
its party leaves every consent column of an already-consented guest exactly as
it was — not rewritten to the same value, but never touched. There is no
`CONFIRMED -> PENDING` edge and no re-consent path anywhere in the edit,
modify-quote, modify-plan, copy or pipeline code, and a test asserts the
absence rather than the presence. So a booker may stretch a two-night stay a
member agreed to into a ten-night one and that member is neither asked nor told;
their only exit is self-removal, which D-14 may itself refuse. The two ticks
compound, and the compound outcome is stated here and in
`docs/DOMAIN_INVARIANTS.md` so a reader meets it as a decision rather than as a
surprise.

**Leaving the machine is not the same as moving inside it.** A guest row can
disappear at any state — the booker removes them, an officer withdraws a request
nobody has answered, the booking-request approval swaps a different member onto
the row — and none of that is a status transition, because the row and its five
columns are deleted together. What the member gets is one message saying they are
no longer on the booking, from whichever surface did it. A decline and a lapse
are the two cases that do NOT use it: each already has its own message for the
same event, and sending both would give one person two explanations.

**Every transition is a status-guarded `updateMany`** (`WHERE id = ? AND
consentStatus = 'PENDING'`). A zero row count means somebody else won, and then
there is **no email, no removal, no bed write, no audit entry** — which is what
makes double-approve, approve-after-expire, decline-racing-the-sweep and two
delegates answering at once all resolve to one winner and one set of effects.

**Why `DECLINED` and `EXPIRED` rows are usually invisible.** The shared removal
path deletes the guest row, so a successful decline leaves no `DECLINED` row
behind; the durable record is the audit entry and the outcome email. The
persisted status earns its keep in exactly one case: **the claim succeeded but the
removal was refused.** That row is *blocked* — still holding a bed, needing a
human — and appears on the admin exception list. Owner decision **D-14** makes
this reachable on purpose: the ordinary self-removal blockers apply to a member
who never consented, so a decline can be refused. Owner decision **D-15** keeps
the list short by electing account credit on the sweep, so an ordinary paid
booking always releases; only four reasons reach the list (last guest,
quote-priced, a status that forbids guest changes, check-in already started).

**A refused removal is TWO writes, and it has to be.** The shared removal path
deletes the guest's chore assignments and the guest row *before* its last two
gates run, so a refusal caught inside the transaction and returned as a value
would let Prisma commit a half-completed removal — the row gone, the price never
recalculated, no credit, no bed reconcile, and no blocked row for the exception
list to show. The refusal is therefore THROWN out of the transaction, which rolls
all of that back, and the terminal status is written afterwards by a separate,
minimal transaction over the row the rollback restored. That second write reuses
the same status-guarded claim, so a sweep that legitimately claimed the row in
between wins and the caller reports `ALREADY_RESOLVED` with no side effects.

To verify: the status-guarded claim in `member-guest-consent-service.ts` (a bare
`update` by id breaks a concurrency test); the two-lock order (global
`pg_advisory_xact_lock(1)` for money/status, THEN the per-lodge capacity lock);
read-key → lock → re-read, including the sweep's re-assertion of
`consentExpiresAt` on the fresh row under the lock; the expiry clamp landing on
the day BEFORE check-in (clamping to check-in itself would fire on a morning the
removal path already refuses as `STAY_NOT_FUTURE`); the `consentAuthority`
parameter authorizing exactly one guest id and only once that row already carries
its terminal status; and `OPERATIONALLY_PRESENT_GUEST_WHERE`, which must match
`null` and `CONFIRMED` and nothing else (see docs/DOMAIN_INVARIANTS.md, "Member
guest consent").

## Lodge Induction Lifecycle

Known induction statuses: `DRAFT`, `IN_PROGRESS`, `COMPLETED`, `VOIDED`.
Known workflow kinds: `NEW_MEMBER`, `HUT_LEADER`, `YOUTH_TO_FULL`,
`RE_INDUCTION`.

```text
admin/application creates induction -> assigned signers review checklist
signer records overall Pass -> sign-off count increments
required sign-offs reached -> COMPLETED
admin override -> COMPLETED
trusted legacy baseline -> NEW_MEMBER COMPLETED (ADMIN_OVERRIDE)
admin void -> VOIDED
```

Checklist templates are versioned and active per workflow kind, so a Hut Leader
Induction can use different checklist wording from a New Member Induction.
The trusted legacy baseline transition is the guarded, dry-run-first exception
for an authorised pre-register history (#2361). It creates a new row only for
an active, non-archived, non-cancelled real-member row (`USER` or `ADMIN`) in a
configured person age tier who has neither an open workflow nor a completed
induction of any kind. Login is not required, so non-login dependants remain
included; `LODGE`, `NON_MEMBER`, and `SCHOOL` rows are excluded. It preserves
all existing rows and creates no signers or sign-offs. All new rows use the
same supplied, non-future New Zealand date for `inductionDate` and
`completedAt`, record the Full Admin actor and stable provenance, and commit
atomically. An open `DRAFT` or `IN_PROGRESS` row visible under the direct-DML
table lock blocks the entire apply; a repeat apply is a no-op. The required
operator freeze protects the wider member population from the final dry run
through apply. `N/A` members are reported but never transitioned.

Completing a `HUT_LEADER` induction sets the member's hut-leader eligibility
flag. Actual `HutLeaderAssignment` rows remain separate dated roster/coverage
records and are not created by induction completion.

`HutLeaderAssignment` has **no state machine of its own** and gains none from
the custodian bed hold (#2286): it stays a stateless dated record whose
Upcoming / Active / Past reading is derived from `startDate`/`endDate` against
today. Adding, changing or clearing its optional `bedId` is a plain field edit —
the held bed is computed from the row on every query, so shortening, extending
or deleting the assignment returns the bed with nothing to reconcile. The same
is true of the whole-lodge-hold exclusion #2698 added: a hold's represented bed
set is derived from the live custodian holds at read time and stored nowhere, so
adding or removing a bed hold moves a bed-night between the two sets with no
state to migrate. What #2698 does add is a WRITE-time question, not a state: a
bed hold created or changed over nights an existing whole-lodge hold covers is
refused with `409 CUSTODIAN_OVERLAPS_WHOLE_LODGE_HOLD` until the officer accepts
it explicitly, and the acceptance and the assignment commit together. Deleting
an assignment now runs under the lodge capacity key, because it widens every
overlapping hold's represented set.

## Membership Cancellation, Archive, And Delete Lifecycle

Known request statuses: `REQUESTED`, `APPROVED`, `REJECTED`, `WITHDRAWN`,
`COMPLETED`.
Known participant statuses: `REQUESTED`, `PENDING_CONFIRMATION`, `DECLINED`,
`APPROVED`, `REJECTED`, `CANCELLED`, `REJOINED`.
Known lifecycle action statuses: `REQUESTED`, `APPROVED`, `REJECTED`.

A departure has an explicit calendar day (`Member.leavingDate`, #4457).
Single and bulk deactivation, cancellation approval, archive approval and
account anonymisation write it alongside `active = false`; an inactive member's
known departure is preserved through later cancellation or archive. A cancelled
CSV import stays undated: its cancellation day is history, not a leaving date,
so an officer records one before retention can count. Reactivation clears the date
so a later departure starts a new retention period. A routine save of an
already inactive record never infers a missing historical date, and the nullable
migration backfills nothing. Officers can set or correct the known date in the
member detail page's Contact group; active members and future departure dates
are refused. Automatic retention excludes every inactive member without a date.

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

Entry eligibility (#2383, #2391): a cancellation request — raised by an admin
from the member page, or by the member themselves from the **Membership
Cancellation** panel in their own profile — is accepted for any account holder
— every member whatever admin access they hold, and organisation/school
accounts — and refused only for the lodge kiosk device login and
booking-request contact records, which hold no membership. The kiosk is
recognised by the record's whole classification, so a person who merely also
holds the lodge tools stays cancellable. One rule,
`isMembershipHolderRecord`, shared by three call sites: the admin-raised server
route, the admin member page's gate, and (since #2391) the member-raised route
in `loadCancellationCandidates`, which applies it both to the requester and to
every candidate in the family list. The member-raised route adds exactly two
further conditions, and they are about being able to operate your own profile
rather than about the class of account: the requester must be `active` and
`canLogin`. Approval is where
the admin-account guards bite: a privileged target needs a Full Admin approver,
and the last active login-enabled Full Admin can never be cancelled, both
evaluated inside the approval transaction. A self-raised cancellation is
allowed but cannot be self-approved — including one raised from the profile
panel, where the requester is recorded as the member themselves. See
[`membership-lifecycle.md`](invariants/membership-lifecycle.md) and
[`CANCELLATIONS.md`](CANCELLATIONS.md#who-can-be-cancelled).

Approval blockers (#2392): `loadMembershipCancellationBlockersByMemberId` is the
single entry point for "why can this not be approved yet", and it now answers in
two parts — future owned bookings / guest appearances (local), and unpaid Xero
invoices on the member's contact. The invoice half runs only when
`xeroArchiveContactsOnCancellation` is on AND the member has a linked
`xeroContactId`, because those are exactly the conditions under which approval
archives a Xero contact; otherwise no Xero call is made. That setting is read
through `loadMembershipCancellationSettingsStrict`, so a failed read is an
unknown (the check runs) rather than a silent "off" (the check is skipped) —
the ordinary loader degrades to defaults whose archive flag is false. "Unpaid" means
AUTHORISED or SUBMITTED with `AmountDue > 0` (the finance dashboard's own open-
invoice definition), across ACCREC and ACCPAY, minus the member's current-season
subscription invoice when the approval is itself STILL about to credit it IN
FULL — mirroring `queueApprovedMembershipCancellationXeroOperations`, which would
otherwise deadlock the ordinary unpaid-subscription cancellation. That predicate
is `excusesUnpaidInvoiceBlocker` from
`loadMembershipCancellationSubscriptionCreditPlansByMemberId` (#2400), the same
module the credit note consults, so the exclusion set is exactly the set the
approval clears: an invoice that will NOT be credited — because it still covers
other members who have not been cancelled, or because its credit-note operation
has already had its single run and skipped — blocks like any other, or the
archive would take a Xero contact with a live balance out of circulation. The
recorded-outcome half is what makes the archive re-check safe: by the time it
runs the credit note has settled, so recomputing "would this credit in full?"
would answer yes for a whole cancelled family and excuse an invoice nobody is
going to credit (#2400 review). If Xero cannot be
reached the check FAILS CLOSED: the participant gets an
`invoice_check_unavailable` blocker (`disconnected` / `rate_limited` /
`unavailable` / `invalid_request` / `too_many_invoices`) and the approval is
refused, because an unknown answer is not "nothing owing". `invalid_request`
(Xero 400/404 — usually a contact merged or deleted there) and
`too_many_invoices` are the NON-transient ones and are worded as such; every
failure message names the archive-setting escape hatch. Contact ids are chunked
40 to a `getInvoices` call, and hitting the `MAX_INVOICE_PAGES` cap raises
`too_many_invoices` for the batch rather than returning a truncated list — Xero
orders a batched read `DueDate ASC` across all its contacts, so a truncated
result could otherwise leave a quiet contact looking clear. The review queue
reads through a 60s in-process memo; the approval guard always passes
`freshInvoiceCheck` so a decision is never taken on a cached answer, and
failures are never memoised. Because the archive is an outbox operation drained
later, `syncXeroMembershipCancellationContact` re-runs the same check `fresh`
immediately before archiving and DEFERS (fails for retry, like the credit-note
guard) if anything is owing. The QUEUE RENDER is additionally scoped (#2402):
`getAdminMembershipCancellationRequests` asks about participants satisfying
`isMembershipCancellationParticipantAwaitingApproval`
(`membership-cancellation-approval-readiness.ts`) — the conjunction of both
approval guards' own preconditions, held in agreement with them by test, and the
same predicate the queue page's Approve button is enabled off, so the button is
never live on a row whose check did not run. The BOOKING half loads for that set
regardless of viewer. The INVOICE half additionally requires
`viewerCanApprove`, which the route resolves from the same `membership: edit`
requirement the review endpoint enforces, and is declined via
`loadMembershipCancellationBlockersByMemberId`'s `invoiceCheck: "skip"` (default
`"run"`, so omission is fail-closed). A declined participant is serialized with
`invoiceCheckSkipped: true` so the queue states that the money check did not run
rather than rendering an absent panel that reads as "nothing owing"; the
shared-invoice notice and its credit-plan read are skipped with it, because its
`blocksApproval` field is derived from the invoice blockers. Approval and
archive-time checks are unaffected. See
[`CANCELLATIONS.md`](CANCELLATIONS.md#unpaid-invoices-block-approval).

Shared subscription invoices (#2400): one Xero invoice covers every member of a
family or billing group, and `xero-subscription-invoices.ts` stamps its id on
each covered `MemberSubscription`. `createXeroMembershipCancellationCreditNote`
credits `amountDue` — the WHOLE remaining balance — so it now raises the note
only when the leaver is the last covered member still with the club. "Covered"
is the union of the subscription invoice link and the charge's ACTIVE
(`releasedAt IS NULL`) coverage claims, because those two records can disagree
and an uncertain covered set must not authorise wiping a balance; a covered
member drops out of it once `Member.cancelledAt` is set, so approving a whole
family one participant at a time leaves the LAST approval to credit the invoice
in full. Otherwise the operation completes SUCCEEDED with
`skipped: shared_invoice_covers_remaining_members` and no Xero call is made at
all — the check runs before the client is authenticated, and after the
existing-credit-note lookup, so a partially-completed run still finishes its
allocation. The determination is made afresh at each moment it is acted on
(approval gate, then the credit note itself), never snapshotted at request time.

Once that gate passes, the run takes a durable per-INVOICE claim before its first
Xero call (`XeroObjectLink`, role
`MEMBERSHIP_CANCELLATION_CREDIT_INVOICE_CLAIM`, inserted with `skipDuplicates`),
because several siblings' cancellations can reach the same "nobody else is
covered" state and the outbox claims per operation, not per invoice. A run that
loses the claim performs no Xero call and completes SUCCEEDED with
`skipped: invoice_credit_claimed_by_other_cancellation`; the holder's own retries
proceed. Where a cancellation credits nothing AND no member the invoice covers is
left with the club — the whole-family case whose last leaver has a PAID
subscription — the operation records `sharedInvoiceLeftUncredited` and an admin
alert names the invoice, so a balance nobody will ever credit is not left silent.
See [`CANCELLATIONS.md`](CANCELLATIONS.md#shared-family-invoices) and
[`CONCURRENCY_AND_LOCKING.md`](CONCURRENCY_AND_LOCKING.md).

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
parent link requested -> parent is active + not archived + not an organisation account (ANY age tier) -> ancestors(parent) + 1 + descendants(child) <= 3 links -> linked | 422 (parent inactive/archived/organisation) | 422 (four-generation cap) | 422 (would close a family loop) | 422 (PENDING or CONFIRMED direct partner pair)
dependent inherits email -> the chosen parent themselves, if adult + not archived + not cancelled + real address + not themselves inheriting -> record that parent as the CHOICE and derive the effective pointer from it | 422 (that parent cannot receive club mail). One hop only since #2716: no walk, and no fallback to a grandparent.
family removal/cancellation/delete -> relationship cleanup while preserving history
cancellation approved for a middle generation -> its dependants' links cleared, NOT re-parented -> detached members named in the response and the audit log
```

A `CHILD_REQUEST` whose family group still has zero memberships (a bundled
group-creation child) cannot be approved until the `GROUP_CREATE` request for
that group is approved first (422 guard).

A parent link may be recorded at **any age tier** (#2282): a 16 or 17 year old
can genuinely be a parent, so recording the relationship is age-blind while
every responsibility function — the contact of record for a dependant's mail,
details confirmation, booking delegation — stays gated on an active adult, none
of which consults the parent link. A dependant of a non-adult parent therefore
inherits from **nobody** (#2716) — the address does not travel past them to a
grandparent — and the admin member page says so before the dependant is added. Organisation and school ACCOUNTS are
the one exclusion, and it is by role rather than by age tier: they are not
people, and `NOT_APPLICABLE` is the age-exempt tier that age-exempt humans carry
too.

Family links run to at most **four generations** (great-grandparent →
grandparent → parent → child) and two parents per member, checked symmetrically
at link time so the verdict does not depend on the order links were created in.
See `docs/DOMAIN_INVARIANTS.md` → parent/dependant links for the rule, the
writers that enforce it, and the direct-parent-only email inheritance that goes
with it (`INV-LIFE-047`).

To verify: non-login adult confirmation, dependent age-up behavior, inherited
email changes, the four-generation cap and its cycle guard at depth, direct-
partner exclusion through both parent columns and both partner statuses, blocked
request/application recovery without partial membership or notification side
effects, database-trigger recovery after unlink/delete, and Xero contact
synchronization.

## Email Retry Lifecycle

Known email log statuses: `QUEUED`, `SENT`, `FAILED`, `BOUNCED`,
`SKIPPED_NO_EMAILS`, `SKIPPED_NON_PRODUCTION`.

`SKIPPED_NON_PRODUCTION` (#3035) is the environment-safety suppression: this
installation is a confirmed copy, so nothing was transmitted and no provider was
contacted. It is TERMINAL and the retry cron never selects it — that job filters
on `FAILED` alone. An installation whose role nobody has declared, and a live
installation that has declared a local capture mailbox, both land on `FAILED`
instead, carrying a `deliveryBlockReason`: those are configuration faults, so they
stay retryable and go out by themselves once the deployment is corrected —
PROVIDED the row still holds a rendered body. It does not for the twenty-six
`SENSITIVE_EMAIL_LOG_TEMPLATES`, nor for any message whose logged recipient is
redacted, because a live sign-in link, a door code or a payment link must not sit
at rest; and the retry cron selects only rows that still hold one. Such a row is
therefore written AT `attempts = 3`, which drops it out of the retry query and
into the operator's email-failure review queue for a manual re-send, and its
`errorMessage` says exactly that rather than promising it will self-heal.
A copy that has explicitly declared a capture mailbox transmits into it normally
and its rows are ordinary `SENT`.

```text
email queued -> send attempted -> sent
confirmed copy -> environment-safety suppression (terminal, no provider contacted)
unconfirmed role or capture-in-production -> retryable failure carrying a block reason
send failure -> retryable failed -> suppression + booking authority rechecked
current authority + current mailbox -> delivery HTML re-finalized -> guarded claim -> retried by cron
revoked authority or stale mailbox -> detail CTA removed, bearer/page action preserved -> retried
unknown legacy authority -> retired for manual review
application rollback -> old worker cannot select quarantined new-version booking body
exhausted or suppressed -> admin-visible failure/suppression
```

The organiser's extra-invoice notice (#4299) starts as a durable `FAILED` row
with a pending-delivery reason, retained retry HTML, and an id derived from the
template and booking change. Only the retry worker sends it, after its normal
15-minute backoff and recipient checks. Replaying invoice creation finds the
same email row; failure to persist that row leaves the invoice operation
retryable. This avoids a synchronous send racing email recovery.

A message whose retry belongs to something else keeps no body
(`NON_RETRYABLE_EMAIL_LOG_TEMPLATES`), so its `FAILED` row is never replayed.
The settlement-figure alert's marker retries it (#4446). The unrecognised and
unmatched Stripe payment alerts (#4647, `INV-INT-032`, `INV-INT-033`) give
their once-ever claim back when nobody received them and fail the webhook, so
Stripe's redelivery sends them again; a cron replay as well would send them
twice. The webhook fails even when that give-back fails: the delivery gives
back its own claim, by its exact stamp, again. A sent alert whose `alertedAt`
write fails keeps its claim and a sent marker, so the event completes and no
redelivery sends it again (#4670).

Stated limit, shared with the settlement-figure alert: these alerts count as
sent once any recipient receives them, so a copy one recipient lost while
another got it is neither retried nor queued for review (#4669).

To verify: retry backoff, suppression handling, durable recipient identity,
direct/inherited mailbox drift, revoked-authority fail-closed behavior,
page-fragment/bearer preservation, rollback isolation, which business-critical
emails require admin alerts, and that the four reasons a message went unsent —
the club's own "No emails" switch, an environment-safety suppression, an
unconfirmed environment, and a provider failure — stay distinguishable
(INV-CONFIG-004).

## Xero Outbox And Reconciliation Lifecycle

An organiser-paid bank-transfer place's extra invoice follows the existing
supplementary-invoice outbox, anchored on its change (#4299, `INV-PAY-148`). Its
queued create is committed with the edit; provider failure retries the same
change, and cash reconciliation adds only the extra's actual receipts to the
place. Its original combined-invoice share is retained.

`ORGANISER_EXTRA_ADJUSTMENT` releases unpaid extras before policy refunds.
Waivers start `PENDING`; refund notes start `WAITING_PAYMENT` and become
`PENDING` only when the matching bank-transfer hand-back is `COMPLETED`. The
worker claims `RUNNING` before provider work and completes under that claim.
A run that stalls past Reset stale running still records its credit note,
re-taking a FAILED row under a fresh claim or leaving a re-queued one to its
queued run, and is otherwise traced, never lost (#4655, below).
A full release of an invoice with no payment or credit voids it; any other
release allocates a credit note. A still-queued extra invoice a release covers
whole goes from `PENDING`, `WAITING_PAYMENT` or `FAILED` to `SKIPPED` and is
never raised. Cash that races a release
is recognised and its policy refund reserved. A reversal of cash already partly
refunded raises a `REVIEW` row (`FAILED`, not replayable) that a treasurer
resolves in Xero Operations.
Refund notes target the invoice that held each paid share and wait for its
unpaid-balance waiver to finish before payout. The organiser's app
notice is a separate durable email row, sent by the email retry lifecycle.

The outbox scan (`processQueuedXeroOutboxOperations`) and the retry scan
(`processQueuedXeroOperationRetries`) read `PENDING` rows oldest first, ordered
by `createdAt` then `id` (#4663). `createdAt` comes from JS time, so rows queued
in one millisecond tie (every row under the frozen test clock), and without the
`id` tiebreak a tie fell to PostgreSQL's physical row order. The `id` is a cuid,
so a tie breaks deterministically but not in insertion order: nothing may rely
on first-in-first-out within one millisecond. A test that runs the worker with
`limit: 1` reads the row the worker holds, or makes its target the only eligible
row, and never assumes which of two tied rows is first.

```text
local business event -> Xero outbox operation queued
  one ACTIVE (PENDING/RUNNING/WAITING_PAYMENT) operation per correlation key
  (#1354): a start that loses the insert race takes the winner's active row.
  If the winner has already finished (#4338): newest row for the key FAILED,
  unresolved or closed by the converge below -> it inserts its own row and
  makes its own Xero call, as a retry a moment later would (at most 3 inserts);
  SUCCEEDED, CANCELLED, PARTIAL (its Xero object exists) or FAILED with an
  officer's resolved-in-Xero mark (done, `INV-INT-025`) -> the unique
  violation is thrown, as before. On a caller's transaction (not the root
  client) the violation is thrown at once: it has aborted the transaction, so
  nothing can be read. Limit: after a FAILED winner the extra call can fail
  too and add one FAILED row toward the repeated-failure alert; an
  applied-credit allocation's is closed by the converge below
two callers on one row (the hand-off above) each record their own outcome of
  the same keyed Xero call (#4356, INV-INT-029): an outcome never replaces a
  better one. A failure, or a FAILED or CANCELLED completion, never lands on
  SUCCEEDED or PARTIAL; PARTIAL never lands on SUCCEEDED; SUCCEEDED lands on
  any row no claim holds, one resolved in Xero included: it leaves the mark,
  keeps the links and, if it recorded a Xero object, alerts the officers once
  per operation after commit (#4374). None but SUCCEEDED lands on a repair's
  marked RUNNING claim unless written onto that claim. Every outcome carries
  the claim it was made under (its RUNNING row's `startedAt`, #4373), and
  none, a success included, lands on a RUNNING row another claim holds: a
  stale-reset or failed attempt's late outcome never lands on the retry's
  claim, so the row stays RUNNING for the retry and the booking invoice
  retry's settle-time fence. A refused write answers null: no link, no
  repeated-failure alert
worker claims operation -> provider call -> success or retryable failure
success -> SUCCEEDED clears lastErrorCode and lastErrorMessage, so an earlier
  wait's or failure's code is not shown on it (#4049); PARTIAL keeps them
worker finds the operation must wait (busy) -> RUNNING -> PENDING: returns
  to PENDING without failing, status-guarded; the billed-offset wait makes no
  Xero call; lastErrorCode is the wait's code or null
  billed-offset note waiting for its edit's own note (#3954): code
  BILLED_OFFSET_AWAITING_OWN_NOTE, rechecked every
  BILLED_OFFSET_OWN_NOTE_RECHECK_MS; at BILLED_OFFSET_OWN_NOTE_WAIT_MS from
  createdAt -> FAILED for a person (an operator's retry raises it unwaited)
  it waits only when its edit expected an own note; a note the repair pass
  queues reads that from the edit's history row (#4049)
supplementary invoice WAITING_PAYMENT on a card ask's intent (INV-PAY-104;
  an officer's or the repair tool's own actions on it are not drawn here)
  -> that intent captured and the money kept -> the others naming it billed
     with it fit the capture -> PENDING (released)
       they would not -> CANCELLED, STALE_WAITING_PAYMENT_CAPTURED, an
       officer told
  -> that intent captured and refunded -> left WAITING_PAYMENT for the reaper
  -> a later request supersedes the ask and carries its balance (#3403,
     INV-PAY-140) -> stays WAITING_PAYMENT, re-pointed at the request that
     absorbed it (`parkedFromPaymentIntentId` keeps the first intent), under
     the change's and the carrier's keys, guarded on status, intent and
     correlation key: by the supersede's cancel step, by the minter before it
     returns its secret, by an edit leg parking on a failed ask, and by the
     reaper before it would retire it
       -> booking ended, change already linked or another invoice queued, the
          carrier would bill more than it asks, or the payload unreadable ->
          left as it was
       -> the carrier already captured -> released at once (unpaid where its
          receipt records the capture)
  -> re-pointed, and the FIRST intent is then captured and kept (a declined
     ask paid from a stale tab) -> returned to that intent, then released
  -> a price reduction retires the chain -> CANCELLED,
     ADDITIONAL_ASK_RETIRED_BY_REDUCTION (INV-PAY-120)
  -> the pay door closed and nothing carries it -> CANCELLED,
     STALE_WAITING_PAYMENT (the reaper; only a capture of that same intent
     revives it)
inbound webhook/event recorded -> reconciliation worker processes event
failure -> retry/backoff/admin visibility
FAILED/PARTIAL -> officer marks it resolved in Xero -> done: status unchanged,
  never retried, requeued or re-minted beside (INV-INT-025)
  refused while the operation is RUNNING, a live copy of it is queued, or a
  queued retry of it overlaps the mark (the mark is then withdrawn)
  refused for applied-credit allocations and deallocations (retry-only)
  a FAILED payment refund-note create naming no note (#4421, INV-INT-028):
  the mark needs the Xero note's number, checked in Xero first, and records
  the note's id and number with it and the payment's live refund-note link,
  under lock(1) then the Payment row, in one status-guarded claim (FAILED,
  "naming no note"); refused, nothing written, when a retry of it ran since
  the read, a run already raised its note (its retry or a same-key create,
  SUCCEEDED or PARTIAL), a live copy is queued, or another create row or a
  link records that note, or for a number sent to a row that takes none; a
  withdrawn mark takes the note and retires the link (audited; a failed
  withdrawal alerts); a PARTIAL row naming no note and an unreadable amount
  are refused (Mark non-replayable)
  the create's own call, stalled past a Mark failed and a resolve recording a
  note, then answers (#4426): its note is recorded only under a
  guarded claim refusing a row whose resolve recorded a note -> lost:
  nothing written (the row keeps the officer's note, no link, no pointer), no
  settlement, no completion; the same note as the officer's -> nothing more;
  any other -> one `xero` audit row and one XERO_SUCCESS_AFTER_RESOLUTION
  alert naming it. After a plain resolve (no note recorded) or a Mark failed
  with no resolve the late note lands as any success does (-> SUCCEEDED)
RUNNING -> Reset stale running -> FAILED, then the organiser adjustment's
  stalled create answers (#4655, `INV-INT-034`): its note is written on the row
  before any allocation only where no other note is recorded and the row is
  this run's RUNNING claim, or unresolved FAILED -> RUNNING under a fresh claim
  in the same write (#4672: this run allocates or pays out and completes or
  fails the row under that claim; Resolve and Retry refuse it meanwhile; a
  dead process is reset again), or unresolved PENDING (a Retry queued it in
  place: this run stops, counted skipped; the queued run continues from the
  note, raising no second one) -> otherwise (resolved by hand, a retry's
  RUNNING claim, another note recorded, closed): nothing written, the run
  returns without failing the row; the same note -> nothing more; any other ->
  one `xero` audit row and one XERO_SUCCESS_AFTER_RESOLUTION alert naming it
credit-note allocation refused by Xero as more than the note has left (#4218)
  -> FAILED with code CREDIT_NOTE_SPENT_OUTSIDE_APP when a read of the note
  afterwards CONFIRMS it was spent outside the app. Xero's refusal is the
  trigger (a read made beforehand could lag an edit and fail an allocation Xero
  would accept) but not proof: the app's own earlier allocation, whose
  completion was never recorded, is refused the same way. So the original error
  stands, unnamed, when the read fails, shows the note now has enough, or shows
  this invoice already holds an allocation of at least the slice. The row stays
  replayable and the named code still counts as refused by Xero
  (xeroRefusedOperation); a retry sends the allocation again and should go
  through once the credit is restored in Xero. Applies to every credit-note
  allocation; for an applied-credit allocation the next arm then converges and
  closes the row instead
applied-credit allocation raises that named failure (#4219) -> the worker
  converges the credit ledger with Xero (write the lot down, release the
  booking's applied credit, shrink or delete the unsent slice, close the slice's
  failed allocation rows through the resolution fields and mark them
  non-replayable), then plans again; the operation completes SUCCEEDED when
  nothing is left to allocate. A converge that finds a concurrent run already
  converged closes the caller's own failed allocation row the same way, and
  audits the close, since it failed after that run's close (#4338). It closes
  it only when that run's write-down and release for this booking and note
  exist; otherwise the row stays FAILED. Only credit Xero shows spent on an invoice or
  payment the app has no record of counts. Fails closed (original failure
  stands) when it cannot account for the discrepancy
inbound credit-note event or the backstop sweep finds the note funding a lot (#4270)
  -> the mirror writes down the free part of the lot Xero shows spent outside the
  app, or restores what it wrote down when Xero shows the spend undone (an
  additive `ADMIN_ADJUSTMENT` row and one audit row, member credit lock only).
  Defers a note changed under two minutes ago (a sweep recheck follows), a note
  with allocation work in flight, and writes nothing for a note that is not
  AUTHORISED or PAID, whose list does not add up, or that funds several lots
queued retry (REQUEUE) RUNNING -> CANCELLED when its operation read as resolved
  in Xero (before the claim, or the claim lost to the resolve); nothing ran
outbox copy RUNNING -> CANCELLED when a sibling for the same document was
  resolved after the copy was queued; no Xero call
retry claims original FAILED/PARTIAL -> RUNNING -> handler completes it
  the claim needs the row unresolved and replayable: a resolve or a mark
  non-replayable after the retry's read makes it lose, with no write and no
  Xero call (#3635, #4256)
  handler throws before completing -> original RUNNING -> FAILED with the
  run's error (guarded: still RUNNING, still this claim's startedAt) (#3462)
  queued retry (REQUEUE) -> FAILED, naming the original and its status
PARTIAL invoice payment repair or refund-note repair claims PARTIAL -> RUNNING
  with code PARTIAL_REPAIR_RUNNING (#4256) -> invoice repair records the
  payment -> SUCCEEDED, or PARTIAL while an invoice-email fault remains (its
  message says so; no repeated-failure alert); the refund-note leg completes
  its own row. Every completion is guarded on the claim (still RUNNING, still
  its startedAt), so it never lands over an officer's Mark failed
  handler throws first -> RUNNING -> PARTIAL, payload kept, with the run's
  error (guarded on the claim), so the row stays repairable
  process dies mid-repair -> stuck RUNNING -> Mark failed / Reset stale running
  -> PARTIAL (above) -> Retry repairs it, under the payment's one key; a
  payment the dead run already recorded (a live INVOICE_PAYMENT link for the
  invoice at the repair's amount; a DELETED or other-amount one does not
  count) closes the row with no second Xero call; Xero refusing an
  overpayment -> resolve in Xero
  completion lost its claim -> row stays as the operator set it; the retry says
  "Retry it once to close it", never "Repaired"
  Reset stale running reports FAILED and PARTIAL counts separately
  rows repaired before #4256 stay PARTIAL; one retry closes them
FAILED refund-note repair claims FAILED only -> RUNNING, with code
  REFUND_NOTE_REPAIR_RUNNING (#4356); a lost claim -> "already claimed". A
  throw before completion, or a stale reset of a dead run -> FAILED; a
  refund-payment failure completes PARTIAL first. The outbox's busy and
  cooldown un-claims never return a marked claim to PENDING
mark non-replayable on FAILED/PARTIAL only, status-guarded: a retry that
  claimed the row after the officer's read -> 409, nothing written, no audit
queued retry (REQUEUE) of an operation marked not replayable -> CANCELLED,
  skipped "not-replayable"; nothing ran
stale RUNNING (> 15 min) -> FAILED by an officer's Mark failed (one row) or
  Reset stale running (all), code ORPHANED_STALE_RUNNING; then retryable
  a PARTIAL repair's claim (code PARTIAL_REPAIR_RUNNING) -> PARTIAL instead,
  payload kept, code ORPHANED_STALE_RUNNING; Retry repairs it again (#4256)
retry of an outbox-run row (group invoice and its VOIDs, kept late capture,
  membership subscription invoice, a change capture's receipt) -> the SAME row back to PENDING, same
  correlation key, status-guarded; the outbox claim runs it. Refused (409, no
  write) when a sibling for the same document was resolved in Xero after the
  row was queued, which the outbox would cancel unsent (#3994). A subscription
  invoice is also refused when its charge already has a Xero invoice or needs
  none (#3971)
primary booking invoice create saves its link -> worth gap check (#3980,
  INV-PAY-136), and again on its "invoice already exists" replay
  a second save of the same invoice stores nothing -> re-check from the first's
  shortfall anchored on a marked edit outside the create's snapshot that
  moved money, with no review
    -> supplementary invoice operation queued PENDING (once per anchor set),
       paid from cash the primary left, else unpaid; a later card capture of
       the anchor's own ask is recorded against it by its own receipt (below)
  overcharge, or a shortfall no marked edit anchors -> REVIEW operation
    PRIMARY_INVOICE_WORTH_GAP written FAILED, replayable false (Retry
    refused) -> treasurer acts in Xero, then Resolve (fixed in Xero); one per
    booking, invoice and direction
change's card capture kept, nothing parked on its intent, primary invoice
  linked (#3953, INV-PAY-139), or the primary's link save for every captured
  change its recorded cash does not cover (before its gap check) ->
  ADDITIONAL_CAPTURE_RECEIPT PENDING, one per capture (key: the intent), found
  or created under the change's supplementary-invoice anchor lock - unless the
  booking is cancelled or paid by internet banking, or another writer records
  the capture (the primary's payment, the change's own supplementary invoice,
  or one naming or covering it, or a kept-capture invoice); a replay, or the
  webhook and the confirm route at once, find it (already-released)
late change capture KEPT on a cancelled, invoiced booking (the #3639 task
  DISMISSED; #4324, INV-PAY-144) -> the keep's one decision, under the task row
  then the change's anchor lock (the repair tool's QUEUE_KEPT_LATE_CAPTURE_RECORD
  runs the same), after finding the capture's receipt or kept invoice:
    a change invoice naming the capture, paid or awaiting release -> the
      late-success release, after commit; if an unpaid change invoice remains,
      enqueue its receipt under the same anchor (never fall back to the primary
      after a refused release)
    a #3980 gap invoice billing it (one of its anchors, in Xero or on its
      way, never voided), or the primary billing it (settled against it, or
      no supplementary invoice, and the change did not race the primary's
      create), or a live supplementary invoice billing this capture (unpaid,
      or recording it) ->
      ADDITIONAL_CAPTURE_RECEIPT PENDING (task re-read
      DISMISSED under the lock); a replayed release finds it (already-released)
    nothing billing it (every supplementary invoice withdrawn, the live one
      recording another capture, or raced past the primary with no gap
      invoice billing it) ->
      KEPT_LATE_CAPTURE_INVOICE PENDING, less what another writer records
      (readCaptureRecorder); nothing where another records all of it
    no change readable (even where an unpaid invoice names the capture) ->
      nothing; the repair tool names it
  approval after a reopen, under the task row then the anchor: a receipt that
    stored no decision (PENDING, FAILED) -> CANCELLED, code
    KEPT_LATE_CAPTURE_WITHDRAWN; one that stored it is left to send
  supplementary enqueue for the change (or naming the capture), under its
    anchor lock: raised unpaid where a capture of it has a receipt linked,
    RUNNING or carrying a stored decision
  gap check: pays the gap invoice only from cash no receipt row claims and no
    supplementary invoice records, never the credit-release sweep's share
    (#4494), and names the captures it took, with the cents, on its payload
    (coveredPaymentIntentIds, coveredCaptureCents)
  gap invoice send (outbox), officer Retry or PARTIAL repair, where what it
    takes of a capture plus the credit-release sweep's share (the larger of
    the ledger's and its CREDIT_RELEASE_PAYMENT links') exceeds the gross
    capture, or the sweep holds a capture it takes from (#4494) -> no
    payment recorded, an officer alerted; the payload is stored unpaid before
    any Xero call (the repair: under its claim, then closed with the reason),
    naming no capture only where its payment provably never reached Xero,
    else still naming its captures
  credit-release sweep beside such a gap invoice (#4494): one whose payment
    may be in Xero (SUCCEEDED, PARTIAL, resolved, a Xero id, response or
    link, a stale-RUNNING reset, an invoice body its send stored) -> held, an
    officer alerted; one that cannot have paid yet and can still send (it
    can run again - PENDING, RUNNING, WAITING_PAYMENT, or FAILED or PARTIAL
    and replayable, unresolved - queued within 7 days) -> waiting, no alert;
    otherwise -> held, an officer alerted daily, naming the row: retry it or
    wait if it can still run, else record the payment by hand
  receipt worker:
    a LIVE invoice create for the booking, or (under the booking's anchor
      lock) a LIVE receipt for it stamped ADDITIONAL_CAPTURE_RECEIPT_PLANNING
      -> busy -> back to PENDING (code ADDITIONAL_CAPTURE_RECEIPT_WAITING),
      left out of the scan for a minute; otherwise its own row is stamped
      PLANNING under that lock and it goes on
    payment already linked -> SUCCEEDED, no Xero call
    another writer records the capture -> SUCCEEDED (stood down)
    capture no longer kept, booking cancelled (save a capture its approval
      task kept, #4324) or paid by internet banking -> CANCELLED
    its target - the gap invoice for its change, or the change's own invoice
      raised unpaid - PENDING, RUNNING or WAITING_PAYMENT -> busy -> back to
      PENDING (no failure)
    no room on the primary and no gap invoice -> #3980's re-check:
      gap queued -> busy -> back to PENDING; a review task -> refused
    room on that target, else the primary (the capture less any part another
      writer recorded) -> decision stored under the change's anchor lock (the
      change from its stamp or a review charge's reason, else the booking's)
      after who records it is read again there (a kept capture's task no
      longer DISMISSED -> CANCELLED, stood down; another recorder by now ->
      SUCCEEDED, stood down; the target moved -> busy; no change known and a
      paid invoice on the booking naming no capture, or a pre-#3641 change
      invoice's payment linked in Xero -> refused) ->
      Xero payment (or an earlier run's, found by
      reference) -> SUCCEEDED, ADDITIONAL_CAPTURE_PAYMENT link; cash left over
      -> officer alerted; a refund note named another invoice -> flagged; a
      kept capture's refunds credited back and a waiting paid-another-way
      note queued (#4324)
    on a cancelled booking: no #3980 re-check - nothing new is billed there
    not captured, Xero unreadable, nothing due, gap invoice not in Xero, the
      invoice's own payment still owed, a retry's room gone, or a stored
      decision another document now records with no payment of its own in
      Xero under the reference (one there is linked, officer told) -> FAILED, code
      ADDITIONAL_CAPTURE_RECEIPT_REFUSED, officer alerted; Retry re-runs it on
      the same row, any stored decision unchanged
    Xero write error -> FAILED (decision kept); Retry sends the same payment
```

To verify: status strings, stale processing reset, tenant selection, link
cleanup, and exact retry exhaustion alerts. The resolved-in-Xero arm is pinned
by `xero-operation-retry.test.ts` and `xero-booking-repair.test.ts` (#3635).
The claimed-original abandon and Mark failed are pinned by
`xero-operation-retry.test.ts`, `xero-sync.test.ts`,
`xero-operation-queue.test.ts` and `xero-operation-routes.test.ts` (#3462).
The PARTIAL repair's claim is pinned by `xero-operation-retry.test.ts` and,
against real PostgreSQL, `xero-partial-repair-claim.realdb.test.ts` (#4256).
The shared-row outcome guard is pinned by `xero-sync.test.ts` and, against real
PostgreSQL, `xero-shared-operation-outcome.realdb.test.ts` (#4356).
A change capture's receipt is pinned by `additional-capture-xero-receipt.test.ts`,
`additional-capture-recorder.test.ts` and, against real PostgreSQL,
`additional-capture-receipt.realdb.test.ts` and
`additional-capture-receipt-unattributed.realdb.test.ts` (#3953); a kept change
capture's decision by `late-capture-kept-xero.test.ts`,
`xero-kept-late-capture-ledger.test.ts` and, against real PostgreSQL,
`kept-change-capture-record.realdb.test.ts` (#4324).

## Cron And Recovery Lifecycle

```text
cron request authenticated by CRON_SECRET -> task allowlist/module gate
task records run/claim -> processes due rows
success -> durable state updated
failure -> run/failure visible and retryable where business-critical
```

To verify: which cron jobs record `CronJobRun`, exact statuses, stale queue
health thresholds, and skipped-module reporting.

### Settlement figure alert recovery (#4446)

```text
committed settlement marker, alertSentAt null -> after-commit send
send throws or reaches nobody -> alertUndeliveredCount + 1, marker stays pending
existing Xero inbound cron -> pending marker older than ten minutes -> same sender
cooldown claim lost -> no send; claim won -> re-read sent/count before sending
send succeeds -> alertSentAt set; send fails three times -> Stuck States, no more sends
```

The counter is optional in the existing JSON snapshot (old markers read as zero).
This template does not retain EmailLog HTML: the marker owns retries, so the email
retry cron cannot send extra copies outside its cap.
Failure counts use a conditional snapshot write so a late failed sender cannot
erase another sender's sent stamp. No schema migration, money transition or
additional lock is involved. As before,
a crash after a send but before its sent stamp can repeat that alert when the
ten-minute cooldown expires; the retry is at least once.

### Shared Xero inbound run authority (#4432)

The scheduled inbound cycle, HTTP cron's inbound/mirror tasks and whole-club
sync-now action take the same dedicated PostgreSQL session advisory claim before
running any tasks. A lost claim reports “A sync is already running” and runs
nothing. No transaction spans the cycle. Success or failure closes the session;
process/connection death also releases its claim, so there is no persisted
RUNNING state to reap and no lease expiry that admits a live second holder.
Connection loss fails the runner at its next task boundary and at completion.
Individual tasks retain the recorded SUCCESS/FAILURE/SKIPPED lifecycle above.
See [the claim and its ordering](CONCURRENCY_AND_LOCKING.md#xero-inbound-cycle-run-claim-4432).

### Xero cron run status: SKIPPED means no work (#4375)

```text
module off / Xero not connected / membership refresh env off -> skipped: true -> SKIPPED
credit-sync pass already ran this interval (skipped: true)                     -> SKIPPED
credit-note mirror with nothing to read (skipped: true)                        -> SKIPPED
batch worked, some rows passed over (skipped: <count>)                        -> SUCCESS
outbox rows refused before any call (cooldownDeferred > 0)                    -> SUCCESS + warning
outbox or replay rows failed (failed > 0)                                     -> SUCCESS + warning
heal or void follow-up with a failed note                                      -> FAILURE
```

A queue task's numeric `skipped` count is rows it passed over after working its
batch: a lost claim, a row resolved in Xero or marked not replayable, a note
waiting for another note. That run succeeded, so cron health stays green. A row
the outage cooldown, the daily limit or the environment check refused before any
call is counted there too, but it means Xero is unusable: the outbox counts it
as `cooldownDeferred` and the run carries a `warning`, shown amber. A failed
row warns the same way and points at Xero Operations. To verify:
`xero-cron-runner.test.ts`, `xero-outbox-fail-fast.test.ts`.

### Alpine Central Server version pause (#49)

```text
alpine-server-other-lodges-sync (03:00) -> module on -> base URL set
  -> checkServerVersion (one GET /api/v1/version; records the answer)
     -> no key          -> SKIPPED central-server-not-configured
     -> mismatch        -> SKIPPED server-version-mismatch   (before the claim)
     -> could not check -> last answer stands; continues
     -> match/unchecked -> item enabled? -> claim -> upload -> download -> SUCCESS
                                                                  -> download stopped (connection-changed | superseded)
                                                                     -> SKIPPED stopped; the next pass repeats it
club-post-mirror-sync / push webhook -> key set -> checkServerVersion
     -> mismatch -> skipped server-version-mismatch          (before commsSyncStartedAt)
club-post-share-retry -> isServerSyncPaused (stored answer, no call)
     -> paused -> shares and withdrawals left pending, no attempt counted
```

The pause is computed, never stored (`INV-INT-027`): the row holds only the
server's last answer, so the first run after either side is upgraded records a
matching answer and resumes with no manual step. A SKIPPED run with reason
`server-version-mismatch` is therefore the expected state while the two sides
differ, not a failure to recover from; the setup page shows both numbers.

A download that stops before recording its cursor (#4262 review: the
connection was replaced while it ran, or another download recorded first) ends
the pass as `status: "stopped"` with that reason, recorded SKIPPED
(`alpineServerSyncRunStatus`). That bends the #4375 rule above, where SKIPPED
means no work: a stopped pass may already have uploaded rows and merged some
lodges before it stopped. It is SKIPPED rather than SUCCESS because its cursor
and owned list were not recorded, so the pass is not complete and the next one
repeats the download; the run's summary keeps the reason.

### A recovery failure no retry fixes (#4081)

A failed attempt normally backs off and retries; a refusal the next attempt
would meet again does not:

```text
PROCESSING -> attempt throws
  ordinary failure            -> FAILED, nextRetryAt set (retry), no alert until attempts run out
  attempts spent              -> FAILED terminal + one officer alert
  CREATE_ADDITIONAL_PAYMENT_INTENT whose ask write found its intent recorded
  for another edit            -> FAILED terminal at once: nextRetryAt null, attempts set
                                 to the ceiling, the cause on lastError + one officer alert
```

Every terminal row sits at the attempt ceiling, so the claim, the health check
and the stuck-state page's "Exhausted recovery operations" read it as dead; the
debt stays on the row (`INV-PAY-092`, `INV-MOD-060`). To verify:
`payment-recovery.test.ts` and `additional-ask-reduction.realdb.test.ts`
("#4081").

### Edit review-charge recovery row (#3402)

One booking edit's review charge has ONE payment-recovery row. Unlike other
recovery rows, a finished one can be reopened, because a later share of the
same edit can still defer to it:

```text
PENDING -> PROCESSING (worker claim) -> SUCCEEDED (replay raised everything owed)
SUCCEEDED -> PENDING   (a later share deferred, or its raise was refused: re-armed, attempts reset)
PROCESSING             (re-arm moves only nextRetryAt; the close is fenced on processingStartedAt
                        and the claimed nextRetryAt, else the row is handed back to PENDING)
terminal FAILED        (never re-armed: the edit belongs to the booking-vs-Xero repair pass, INV-PAY-057)
```

The rule and its stated limits are `INV-PAY-112`; the interleavings are in
`docs/CONCURRENCY_AND_LOCKING.md`. To verify:
`edit-financial-review-charge-raise-claim.realdb.test.ts` and
`payment-recovery.test.ts` ("#3402").

### Card refund recovery row: dead, then paid another way (#3372)

A card refund the club decided to make and Stripe has not yet paid is a
`REFUND_BOOKING_MODIFICATION` or `REFUND_SUPERSEDED_PAYMENT` recovery row. Until
it closes it counts in "Refunds owed" and comes off Net Collected (owner, 7 Oct
2026), at its unsent slices: a recorded refund counts toward a slice only if it
is on that slice's transaction, is exactly the slice's amount, and falls
inside the row's window - made by Stripe no earlier than the row was raised
(floored to its second) and, once the row is closed, no later than its
`succeededAt` (`openCardRefundOwedByOperation`; one clock at both ends since
#3924 round 7). So a refund Stripe made before a close and
the app recorded after it stays the closed row's; after a "Paid another way"
close it is money paid twice, listed on the stuck-states page.

```text
PENDING -> PROCESSING (worker claim, attempts < MAX) -> SUCCEEDED (Stripe refunded every slice)
PROCESSING -> FAILED  (attempts left: retried at nextRetryAt)
PROCESSING -> FAILED  (Stripe answered a slice failed/canceled: re-planned on the attempt
                       held, each refused slice on its next key, then retried; INV-PAY-128)
PROCESSING -> FAILED  (charge-backed preflight finds a counted outside-app refund
                       on a planned charge since this debt arose: DEAD immediately,
                       no retry, audited and alerted; no slice sent; INV-PAY-145)
PROCESSING -> FAILED  (attempts spent: DEAD, alerted once; still owed)
(none) -> PENDING     (a refund Stripe accepted, then failed: a new row per
                       Stripe refund, card_refund_failed_later_<refund>, under
                       the Payment row lock; INV-PAY-128)
(none) -> DEAD        (that row's own retry failed later too, or Stripe
                       created the refund before the cutoff migration and no
                       open row counts it, or (#4210, INV-PAY-142) a row that
                       may have made it was closed "Paid another way":
                       raised PENDING with its attempts spent, never
                       claimed, never in flight)
PENDING|FAILED -> same (an open, claimed row that counted the refund is
                       re-planned instead: the slice on its next key,
                       recording the failure in failedRefundIds; compare-and-set
                       on the plan, status, attempts and nextRetryAt read)
DEAD -> SUCCEEDED     ("Paid another way": finance:edit, lock(1), then the
                       Payment row, refused (409) unless what is owed is the
                       figure the treasurer saw, then a status-guarded claim on
                       PENDING|FAILED with attempts >= MAX; lastError is the
                       paid-another-way marker, nextRetryAt null, succeededAt
                       now; the amount - all of what is still owed, or part
                       of it, as the treasurer chooses - is recorded
                       on the payment with applyLocalRefundAllocation; a
                       COMPLETED hand-back task and its BANK_REFUND line record
                       it; audited under `payment`)
```

Before an ordinary charge-backed recovery sends any unmarked slice, its
preflight reads Stripe once per involved intent, outside every transaction
(`INV-PAY-145`). It records the returned charge refunds through the canonical
writer and queues their existing accounting corrections. Exact `refundSliceKey`
evidence marks an unmarked stored-plan slice with its refund, compare-and-set
on the plan and the runner's `PROCESSING` claim (`INV-PAY-147`); a lost guard
sends nothing. Both runners send only the returned plan's unmarked slices,
including after Stripe forgets the key; a wholly marked row completes. A
counted outside-app refund without a matching slice key since the debt's
creation second stops the whole row for an officer;
there is no amount matching, automatic adoption or debt close. An incomplete
page or unavailable evidence fails the attempt without sending, using normal
backoff. Marked slices are not sent or checked. The specialised combined-group
executors retain their own replay protocols.

A refund Stripe answers `failed` or `canceled` on a booking edit, a cancellation
or an approved refund request never closes its row (#4083, #4096, #4102,
`INV-PAY-128`). Stripe answers a repeated key with the original refusal for 24
hours, so whoever reads a refusal moves that slice to a fresh idempotency key
(`refused1`, `refused2`, ...). An edit freezes its plan before Stripe and queues
its whole read plan after success or throw if any slice is unmade (#3984,
`INV-PAY-146`), even if the webhook has since recorded a refund. A cancellation
re-plans its pre-persisted row the same way while it is still `PENDING` with no
attempt. An approved refund request also queues its whole plan after the attempt:
refused slices on their next key, unanswered ones keep their key, made ones
marked with their refund (`madeRefundId`). If no row can be written once Stripe
was asked by a refund-request approval, its approval
stands, and the officers' alert and its audit row split what is not made into
what Stripe refused (refund it another way) and what got no answer (it may have
been made: check Stripe first); the Xero credit note covers only what went back.
Only an attempt that never reached Stripe releases the claim back to `PENDING`
(#4117). The runner re-plans only on the attempt it holds (`PROCESSING` under
its own `processingStartedAt`) and then fails it; a slice it made beside a
refusal stays in the plan, marked with its refund, never sent again. A marked
slice is filled in "Refunds owed" by exactly that refund, whenever Stripe made
it, and the row's amount stays the plan's total; the ledger census's in-flight
refund reads only its unmade slices, and the retries-exhausted alert what the
row still owes once it is marked failed, netting the refunds its final attempt
recorded. The officers are alerted once per refused slice - by the write that
first moves it off the key it was planned under (a cancellation's re-plan, the
runner's, or an edit's or refund request's row when it is written), or by the
edit door when no row could be written - and again if the retries run out.

Every other card refund door keeps a refusal owed too (#4103, `INV-PAY-130`). A
door whose row is written before its attempt - the edit financial review, the
treasurer-approved late capture, the duplicate capture and the capacity race,
as the cancellation does - re-plans that row while it is `PENDING` with no
attempt, once per refusal (compare-and-set on the row's plan), including a
refusal before a later slice threw, and never closes it. The superseded-payment
runner asks under its row's key first and moves a refusal to a one-slice plan on
its next key. The late-capture webhooks hold a refused capture for a treasurer
(an `OPEN` approval task) whatever the setting, so they write no "refunded"
record; the approval asks on the key generation the recorded refusals count to.
The Xero repair pass fails on a refusal and records only what Stripe made; a
re-run moves each slice to the key generation its recorded refusals count to,
so it asks afresh. The legacy group settlement refund (plans frozen before
#3653) and the superseded group intent's webhook refund fail on a refusal as on
a throw; each retry's key moves past the refusals Stripe holds on the intent
for that refund, so it asks afresh.

A refund Stripe accepted (`pending`) and failed later is owed again (#4104,
`INV-PAY-128`), by one row. The one writer of a charge's refund rows
(`recordStripeRefundsAgainstTransaction`) sees it exactly once: its guarded
counted -> refused write, or a door or worker told `pending` by a replayed key
while the row already says refused (the event came first). In the same
transaction, under the Payment row lock it already holds, it finds who owes it:
a row of its own, or a slice already recording it (`failedRefundIds`), means
nothing more; the open row that counted it - the slice marked with it
(`madeRefundId`), or the unmarked slice "Refunds owed" fills with it as the
payment stood before the failure when the refund carries exactly the metadata
that row's runner sends (`cardRefundOperationRefundMetadata`) - has that slice
moved to its next key; with none, a new row is raised per failed Stripe refund, for exactly its amount on
its charge, under a key Stripe has never seen, recording on its slice which row
made the refund (`madeByOperationId`, #4166): the one row on the payment whose
runner metadata the refund carried, or among several the one whose slice it
fills, else null. A row someone may be writing (a
worker's attempt, or a row no worker has claimed yet) is never moved: the
failure is retried later, or, met by that row's own door or worker replaying
its key, handed back to it as refused. A closed row is never reopened. A new
row is raised dead - for "Paid another way", alerted - when the refund was
itself such a retry, or Stripe created it before the cutoff migration
(`20261115010000_card_refund_failed_later_cutoff`) finished (every refund, with
a migration history that lacks it): it may have failed while nothing could
notice, and may already have been paid by hand. So too (#4210, `INV-PAY-142`)
when a row that may have made it - any whose runner metadata it carries, or
whose slice it fills - was closed "Paid another way" (a completed close record
keyed on that row, read under the same lock): the close's bank transfer may
already have paid it, so an officer checks it. A refund naming no booking of
the payment (made in the Stripe dashboard, or a legacy group refund) is taken
out of the refunded total, alerted with its Stripe id and audited, never
re-sent. Two ways
in: the `refund.failed` webhook (and `refund.updated` / `charge.refund.updated`
where subscribed), and the payments cron, which reads each card refund still
recorded `pending` back from Stripe, least recently read first. The officers
are alerted once per decision, after commit. Closed as "Paid another way", a
row owing a failed-later refund - its own, or a re-planned slice - whose card
refund note is still in Xero (the payment's notes cover more than its card
cash) notes only what that excess does not cover
(`failedLaterCardNoteCoverCents`), and the close counts as noted.

The treasurer says "paid back in full" or "paid back part of it"; the route
refuses an amount that does not match the answer, and any close for $0 - a row
that owes nothing is not offered (#3924 round 7). A part close ENDS the refund:
the rest stops being owed anywhere, and a later review's netting counts the
refund at its full raised amount (owner, 8 Oct 2026: "Difference is gone"). The
close makes no Stripe call. In Xero every kind queues a bank-transfer refund
credit note for exactly the amount paid back, keyed on the close's task and
dated the close's club day, where there is an invoice to credit (owner, 8 Oct
2026: "Raise a refund note for all"). The note is sized by the close's record
less what its own notes already cover, never by the payment-wide gap (#3924
round 8), and its Xero key is the close and what its own notes cover, so a
retry after a crash is answered with the same note whatever else landed
(round 9). A late card charge's refund is credited
against the charge's own receipt, named by its invoice id; when Xero has none,
the close queues that receipt (the kept-charge invoice, on the approval task,
put back to PENDING if it failed before it could have reached Xero) and the
receipt's worker queues the note after it records the receipt's link (owner,
8 Oct 2026: "Record receipt, then credit"). When the receipt is already on its
way - a change's supplementary invoice for the capture, queued, sending or
FAILED - the close queues nothing and takes the same waiting key; that
invoice's worker runs the note step once it is sent (round 8):

```text
close (no receipt in Xero) -> KEPT_LATE_CAPTURE_INVOICE PENDING, no note
receipt worker: invoice + Stripe payment sent
  -> transaction 1 under the approval task's row: receipt link written
  -> transaction 2 under the same row: bank-transfer REFUND_CREDIT_NOTE
     PENDING (keyed on the close), unless one was already asked for it
  -> receipt row SUCCEEDED (or PARTIAL)
note step fails -> receipt row FAILED with its link standing; its retry finds
  the invoice and payment linked and runs only the note step
receipt FAILED unsent -> no note; the repair tool's
  PAID_ANOTHER_WAY_LATE_CAPTURE_WITHOUT_XERO_RECEIPT retries (or queues) it,
  and the note follows
receipt FAILED after it may have reached Xero (payment linked, or the invoice
  call attempted) -> left FAILED for an officer, who checks Xero, then retries,
  or marks it resolved and records the refund by hand if it is there;
  a close finding it so reports receipt-held-for-officer, never queued (round 9)
close (receipt on its way: a change invoice) -> waiting key, nothing queued
  (refund-note-after-failed-receipt when that invoice FAILED, round 9;
  receipt-held-for-officer when it FAILED after attempting the call, round 10)
change invoice sent -> its row SUCCEEDED, then the note step under the
  approval task's row: bank-transfer REFUND_CREDIT_NOTE PENDING
change invoice FAILED -> an officer's retry puts that row back to PENDING with
  its queued payload (round 9), so it is sent from its own row and the note
  step follows; never an inline replay on a new row that names no capture.
  Round 10: only for a capture an approval task owns; refused (409) when the
  change already carries an active SUPPLEMENTARY_INVOICE link - mark it
  resolved, and the receipt is that linked invoice. Round 11: the close's
  share is not recorded by hand; the nightly credit check or the repair tool
  raises its note. Round 12: the capture's card refunds are recorded by hand,
  and the 409 names them: every card-refund path reads the resolved row as
  resolved by hand, so no note is raised. Round 13: it names what no card
  note in Xero answers; with no close, or a $0 one, it says any later card
  refund is recorded by hand. Round 14: it says to mark the row resolved
  first, before anything is recorded by hand; names a card note sent with no
  reply (executed payload, no credit note id) apart, to check in Xero before
  recording; and while the card verdict still names an invoice in Xero, sizes
  as the note writer does and says nothing of later card refunds
note step never ran (receipt in Xero, no note asked) -> the repair tool's
  PAID_ANOTHER_WAY_REFUND_NOTE_NOT_QUEUED queues it through the same step
  (round 8), and the nightly credit check runs the step for every payment
  its closes' notes do not cover (round 9)
note FAILED -> Retry in background in Xero Operations; the nightly credit
  check returns the existing row and never retries it
receipt (change invoice or own receipt) resolved by hand before the app sent
  it, whatever the close planned, before any note row -> no note; the repair
  tool's report-only PAID_ANOTHER_WAY_REFUND_NOTE_RECORD_BY_HAND names the
  capture's own card refunds less the notes naming it, plus the close, to
  record by hand (round 9, sized so in round 12), in place of
  KEPT_LATE_CAPTURE_REFUND_RECORD_BY_HAND; not raised once a note row of the
  close exists (round 10), and otherwise raised on every run, since a refund
  recorded by hand writes no row. A row resolved by hand after the app sent
  it, or a change linked in Xero, is the app's invoice for the close (round
  11: the paid-another-way verdict only): recorded against its id, and the
  close's note follows. Every card-refund path still reads it resolved by
  hand, so its card refunds get no note: the report-only
  LATE_CAPTURE_CARD_REFUND_RECORD_BY_HAND names them to record by hand (round
  12), with or without a close, raised on every run. Round 13: on that
  card-refund verdict alone - so also a change invoice resolved before the
  app sent it (#4038), and a close whose note row exists - and sized by the
  card notes in Xero only. Round 14: a note never sent (queued payload, still
  queued or FAILED before it called Xero; round 15: or refused, a 4xx) is
  recorded by hand; one that may be in Xero (executed payload, no id, no
  refusal) is named apart by every record-by-hand finding, to check in Xero
  first. Round 15: a note is in Xero by its id, or by its active refund-note
  link naming the capture, so an officer's retry on a new row with no queue
  type counts, once. Each
  capture is named once: the kept invoice's finding (only where the card
  verdict is resolved by hand, #4039), the close's, or this one; none where
  the app raises the card note
```

A close Stripe also paid is listed as paid twice. The treasurer marks it
Resolved once it is sorted out with the member (owner, 9 Oct 2026): a note,
kept on the close's task and audited under `payment`; the row leaves the list
and comes back only if Stripe refunds the card for it again. No money moves:

```text
listed paid twice -> Resolved (finance:edit, a note, refused (409) unless the
  card figure is the one the dialog showed; one status-guarded write on the
  close's task, guarded on the resolution it carried; audited)
Resolved -> listed again (a later card refund for the same close)
```

It refuses an organiser child's refund (#3653) and a group
organiser-cancel settlement's refund (`isOwedCardRefundOperation`); a
superseded intent's refund closes whole, never at nil, and only while its
charge still holds exactly what it owes. The rules are
`INV-PAY-121` and `INV-PAY-122`; the lock is registered as
`closeCardRefundPaidAnotherWay#1`. To verify:
`card-refund-paid-another-way.test.ts`, `open-card-refund-owed.test.ts`,
`xero-kept-late-capture-ledger.test.ts` (round 6: the Xero books of a late
charge's close, whatever order the outbox runs in) and
`card-refund-paid-another-way.realdb.test.ts` (a double click closes once; a
refund recorded while the close waits for the payment row is refused with a
409; a close that waits on the approval task's row behind the receipt's worker
reads the receipt recorded and queues its own note - both against the real
receipt worker since round 8; the receipt's note step runs at most once; the
gap's close share agrees with coverage, a PARTIAL note and a covered second row
included; a close's note is sized by its record; a Resolved double click writes
once), `card-refund-paid-twice.test.ts` and `xero-booking-repair.test.ts`
(rounds 7 and 8: the receipt and note findings).

### Confirm-pending saved-card charge (#3268)

`confirmPendingBookings` claims a hold-expired booking (PENDING -> CONFIRMED
under `lock(1)` + the lodge lock), charges the saved card off-session, and on
success moves it to PAID. A THROWN charge used to be one outcome — release the
claim, alert admins, retry next run — which retried a permanently unusable card
24 times over four days. It is now two:

```text
charge throws -> claim released (booking back to PENDING, beds reconciled away)
  -> classify (src/lib/saved-card-charge-failure.ts)
     retry    -> admin alert, same card next run            (as before)
     terminal -> card retired everywhere + member told once + admins told once
                 -> next run takes the no-card path for this booking
```

The full decision table and the row-clearing contract are in "Payment
Lifecycle" above and `INV-PAY-054`. To verify: the classifier table
(`saved-card-charge-failure.test.ts`) and the cron's terminal branch
(`cron-confirm-pending.test.ts`, "#3268").

### Confirm-pending charge attempt is one ledger row with its own key (#3267)

The charge itself is one attempt row per Stripe key, minted inside the claim
transaction right after the Payment upsert (`beginSavedCardChargeAttempt`), so
a run that finds an earlier attempt still unresolved asks Stripe about THAT
attempt instead of charging again, and a run after a definite refusal starts a
fresh one:

```text
claim (lock(1) + lodge lock, PENDING -> CONFIRMED, Payment upsert)
  -> begin attempt: fresh row + key | replay unresolved row | end superseded row | REFUSE on captured cash
  -> commit
  -> #1992 sweep (link intents; attempt rows excluded by key prefix)
  -> chargeSavedCardAttempt: cancel superseded intents (best-effort) -> charge | retrieve
       succeeded  -> settle row SUCCEEDED -> markBookingPaymentSucceeded (as before)
       other      -> settle row (PROCESSING | FAILED) inside the locked release -> PENDING
       throws     -> definite: row FAILED first; ambiguous: row left PENDING
                     -> release claim -> #3268 classify (terminal retire / retry alert)
  REFUSED (captured row on a pending booking) -> claim rolled back, error alert, failed id
```

The states and the definite/ambiguous partition are in "Payment Lifecycle"
above and `INV-PAY-055`. To verify: `saved-card-charge-attempt.test.ts` and
`cron-confirm-pending.test.ts` ("#3267").

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
enrollment accepted -> recovery codes stay visible until Continue -> replace document at server-resolved destination
verification accepted -> replace document at server-resolved destination
rejected or failed request -> retain challenge and correction flow, no navigation
```

To verify: Auth.js JWT callback claim handling, challenge-token single-use
consumption, protected route-group layout redirects, API guard rejection,
email-code expiry, TOTP skew window, recovery code single-use consumption, and
lockout reset after successful verification. The two successful panel exits share
one local document-replacement function (`window.location.replace`); destination
selection stays server-side, including safe deep links and nonce-bound private
family-invite returns. Neither exit renders that destination in a DOM attribute.
Enrollment waits for explicit **Continue** so the member can save recovery codes.
Rendered panel tests cover accepted, pending, rejected and network-failed requests;
direct browser journeys require protected content after Continue and verification,
without a later helper navigation (#4060).

## Password Sign-In Throttle (#4609)

A per-account count in front of the password check (`INV-AUTH`). It keeps no
status column: the state is the `LoginThrottle` row's count and its last
counted attempt, read through the pure policy in
`src/lib/login-throttle-policy.ts`.

```text
no row / count < 5 -> free: attempt claimed (count+1) before the password compare
count >= 5 and now < lastFailureAt + wait(count) -> waiting: dummy compare, LOGIN_THROTTLED, nothing counted, no member read
waiting and now reaches lastFailureAt + wait(count) -> free for one more claimed attempt (wait doubles 30 s -> 15 min)
valid password (any count, after a claim) -> row deleted (cleared)
completed password reset -> row deleted (cleared)
an hour with no counted attempt -> count reads as 0; idle sweep deletes the row
store failure -> same states, counted per process at the #1142 divided budget
```

To verify: `login-throttle-policy.test.ts` (the waits and the idle reset on the
frozen clock), `login-throttle-auth.test.ts` (through the real password provider)
and `login-throttle.realdb.test.ts` (the row lock under forced interleavings).

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
    member deleted (#2620), canLogin=false, or sessionsRevokedAt later than the session's
      issue time (#3603) -> sessionInvalidated=true (INV-LIFE-014, INV-LIFE-092). The database
      stamps sessionsRevokedAt when login goes on -> off, so a session from before a switch-off
      is refused after login is switched back on too, whichever cookie is presented; a token
      once invalidated also stays invalidated (sign-in racing the switch-off, clock skew);
      the member signs in again for a new one
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

Client-side state machine for GA4 consent (issue #975, reshaped by #2573). The
module must be enabled AND a valid GA4 measurement id must be stored in
`AnalyticsSettings` before anything renders at all, and the route must also be
analytics-eligible before the BANNER or the TAG appears. There is no
environment-variable path.

Route eligibility gates the banner and the tag; it deliberately does **not** gate
the public **Analytics preferences** control, which is offered wherever the runtime
is mounted — including a public page analytics does not run on — because in
banner-off mode it is the visitor's only way to opt out.

The club chooses one of two modes at Admin → Integrations → Google Analytics.

Banner ENABLED (the default, and the recommended option):

```text
no stored choice, or one stored under an older consent revision
    -> banner shown; NOTHING sent to Google (no tag, no request, no ping, no consent signal)
visitor accepts  -> {choice:"accepted", revision, source:"banner"} persisted -> loader renders, analytics_storage granted
visitor declines -> {choice:"declined", revision, source:"banner"} persisted -> loader never renders
visitor dismisses (close) -> identical to declining
stored choice at the CURRENT revision -> banner suppressed, prior choice honoured
admin runs "Ask visitors to choose again" -> revision bumped -> every stored choice is stale -> banner shown again
```

Banner DISABLED:

```text
no stored choice                        -> loader renders automatically, analytics_storage granted
stored choice with source:"banner"      -> IGNORED once (a banner-era decline no longer blocks) -> loader renders
stored choice with source:"preferences" -> HONOURED at any revision (accepted -> loads, declined -> does not)
visitor opts out from the footer's Analytics preferences control
    -> {choice:"declined", revision, source:"preferences"} persisted
    -> consent update denied + window["ga-disable-<ID>"] set -> no further collection
```

Advertising storage, advertising user data and advertising personalisation are
denied in every signal, in both modes.

To verify: no `<Script>` at all while the banner is enabled and unanswered; the
loader rendering only when module enabled + valid stored measurement id +
eligible route + decision allows; decline and dismiss both mapping to denied; a
revision bump re-prompting; a banner-era decline being ignored in banner-off mode
while a preferences decline is not; and `send_page_view: false` with exactly one
sanitised `origin + pathname` page view per client-side navigation.

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
