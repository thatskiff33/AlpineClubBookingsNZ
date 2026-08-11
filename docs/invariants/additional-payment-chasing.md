# Additional Payment Chasing

Audience: Developer, Agent.

Prefix defined in this file: **`INV-ADDPAY`** — an outstanding additional
payment, who is owed one, who may pay one, and the quote/request holds and
refund-settlement rules that sit beside it.

Read this file when you are changing the additional-payment chase, the unpaid
finished-stay queues, a booking-request or quote capacity hold, or how a
reduction, refund or credit note settles.

Index: [`docs/DOMAIN_INVARIANTS.md`](../DOMAIN_INVARIANTS.md) — every `INV-*` ID
with a one-line description of what it covers. ID scheme and allocation rules:
[`SCHEME.md`](SCHEME.md).

Every heading below whose whole text is an `INV-*` ID defines that invariant. IDs
are permanent: never renumbered, never reused. **The text under each ID is a
verbatim move from the source document and must not be reworded in place** —
only the ID heading lines and the bracketed cross-file `[INV-*]` pointers
registered in the PR were added.

## Additional-payment chasing (#2350), request holds and refund settlement

### INV-ADDPAY-001

Until #2350 nothing chased the member for an uncollected upward change and no
admin surface showed one. These rules now hold:

- **Who is owed anything at all.** `isAdditionalPaymentOwed`
  (`src/lib/additional-payment-chase.ts`) is the in-memory twin of
  `buildAdditionalOwedWhere` and tests BOTH halves: booking status in
  {`CONFIRMED`, `PAID`, `COMPLETED`} (one shared list,
  `ADDITIONAL_OWED_BOOKING_STATUSES`), and `additionalAmountCents > 0` with
  `additionalPaymentStatus` other than `SUCCEEDED`. The status half is not
  decoration: booking cancellation marks the additional intent `FAILED` (or
  leaves it PENDING where no intent exists) WITHOUT zeroing the amount, so an
  amount-only test would show cancelled bookings as owing and would email their
  members a payment demand. It takes the status as a required argument so a
  caller cannot forget it.

### INV-ADDPAY-023

- **Who may PAY one.** The member-facing surfaces use a second, deliberately
  wider list, `ADDITIONAL_PAYABLE_BOOKING_STATUSES` — the owed list plus
  `PAYMENT_PENDING`, which the owed list drops only to keep the two admin queue
  counts summable. Both surfaces that can move money gate on it: the booking
  page's `AdditionalPaymentCard` and
  `GET /api/bookings/[id]/additional-payment-secret`. The member dashboard's
  owed total is scoped instead by its own query (`ACTIVE_BOOKING_STATUSES` +
  `COMPLETED`), wider again. **What every one of them excludes is CANCELLED and
  BUMPED**, and that is the invariant: a member is never shown, and can never
  complete, a card payment for a booking the club has stopped counting.
  Enforcement is not cosmetic — cancellation marks the additional intent
  `FAILED` without zeroing the amount, and the cancel path asks Stripe to cancel
  only an intent that was still *outstanding*, so an intent that had already
  failed (a declined card) stays confirmable at Stripe. Before this gate the
  owner of a cancelled booking could open the booking, be offered "pay this
  extra", fetch a live client secret and complete the charge; the late-capture
  backstop (#1350) auto-refunded and alerted, but the member had still been
  charged for a booking that no longer existed.

### INV-ADDPAY-024

- **What the member is told.** While the stay is still ahead, the member is
  emailed at most twice per obligation: `ADDITIONAL_PAYMENT_REMINDER_DAYS`
  (3) days after the extra was raised, and
  `ADDITIONAL_PAYMENT_FINAL_REMINDER_DAYS_BEFORE_CHECK_IN` (2) days before
  check-in. The pre-arrival reminder also names the amount when one is owing.
  Nothing is ever auto-cancelled or auto-expired, and the chase stops the
  moment `checkOut <= today` - a finished stay belongs to the queue above [INV-LOCKOUT-043].

### INV-ADDPAY-025

- **Nothing raised before the chase existed is chased, and the cutover is a
  fact rather than a plan.** An obligation whose episode started before the
  cutover is never emailed about by the cron: on first deploy every pre-existing
  delta is already past the day-3 threshold, so without this the first pass
  would mail the whole backlog at once, and legacy rows with no ADDITIONAL
  transaction would date the demand from the payment row's creation rather than
  the day the price changed. Those deltas stay on every admin surface and can
  still be chased by hand — and the exclusion is per EPISODE, so a later upward
  change (or a member retrying a failed charge) is chased normally.

  The cutover is **derived, not hand-written**: it is the `startedAt` of the
  FIRST `CronJobRun` row for `additional-payment-reminders`
  (`resolveAdditionalPaymentChaseStartedAt`). If there is no such row, this pass
  is the first, so it sends nothing and the row it writes becomes the cutover —
  whenever the deploy actually happens. A hand-edited constant pinned to a
  migration date was the previous design and it was enforced by nothing: had the
  deploy slipped past it, every obligation raised in the gap would have been
  backlog mailed on the first pass, which is the exact failure the guard exists
  to prevent. Run rows are pruned after 90 days, which can only move the cutover
  forward to the oldest surviving run — still months behind anything this job
  chases three days after it is raised. A read failure sends nothing that pass:
  not knowing where the cutover is must never mean "email everyone".

### INV-ADDPAY-026

- **What makes it idempotent.** Two nullable stamps on `Payment`,
  `additionalReminderSentAt` and `additionalFinalReminderSentAt`, written by a
  guarded `updateMany` BEFORE each send, so a cron rerun (or two runners
  racing) claims nothing and sends nothing. The stamps are read RELATIVE to the
  current obligation - which starts at the latest ADDITIONAL
  `PaymentTransaction.createdAt`, falling back to the payment row's own
  creation for legacy rows - so a stamp left by an earlier, settled delta never
  suppresses the chase for a later one, and no writer has to reset them.

  Every claim also FENCES the obligation the read decided on: the full owed test
  (booking status included), the exact `additionalAmountCents`, and no ADDITIONAL
  transaction newer than the episode being chased. The episode fence is the
  load-bearing one - a member retrying a failed charge mints a new Stripe intent
  and therefore a new ADDITIONAL transaction row at the SAME amount, which an
  amount-only pin would not notice; the email would quote the old obligation
  while the stamp (written at `now`) counted as the new episode's, burning its
  first reminder for good. A lost claim is re-read and re-decided rather than
  treated as another runner's win.

### INV-ADDPAY-027

- **One clock for automatic and manual, in both directions.** An admin can
  re-send the same email from the booking page (`POST
  /api/admin/bookings/[id]/additional-payment-reminder`, `bookings:edit`,
  audited). It writes the stamp for whichever reminder is currently due - and
  when that is the last-chance one it closes BOTH stamps, exactly as the cron's
  own final branch does. Writing only the day-N stamp made the cooldown
  one-directional: an admin re-send inside the pre-arrival window was followed
  by the cron's near-identical email at the next three-hourly tick.

  `ADDITIONAL_PAYMENT_RESEND_COOLDOWN_MINUTES` (60) is honoured by BOTH senders,
  in both directions: an automatic nudge inside the window refuses a manual one
  with a 429, and a manual one inside the window makes the cron read "not due"
  (in its decision AND in its claim's WHERE). Stamps alone were not enough — a
  manual send late on the NZ day before the last-chance window opens writes only
  the day-N stamp, and the next tick after NZ midnight would have found the
  final reminder unstamped and sent it minutes later. The cost is that a due
  reminder can slip to the following tick, three hours, not a lost email. On a
  send failure the stamps are given back, so a failed re-send never silently
  disarms the automatic chase.

### INV-ADDPAY-028

- **Only a transmitted message counts as sent, and a stamp is only ever spent on
  a message that went out or one that will be replayed.** `sendEmail` RETURNS
  rather than throws when it withholds a message (a suppressed address, a
  walk-in placeholder address, the "No emails" switch flipping on after the
  check), so both senders inspect the outcome. The manual re-send answers with
  what really happened instead of a success. Both then apply the SAME rule with
  the SAME single exception: the stamps go back, unless the withhold was an
  UNREADABLE "No emails" switch, which leaves a `FAILED` `EmailLog` row the
  retry cron replays (re-checking the switch first) — restoring there would risk
  the member getting two copies, so the 503 reply says the message is queued and
  tells the admin not to re-send rather than inviting a retry the cooldown would
  refuse.

### INV-ADDPAY-029

- **Silence is refused, not swallowed — and unreachability is checked before
  anything is claimed.** A booking with the "No emails" switch on is skipped by
  the cron with no stamp burned (so the reminder is still due once the switch
  comes off) and refused outright by the manual re-send with an explanation - an
  admin standing at the screen must not read a silent withhold as a successful
  send. Both fail CLOSED if the switch cannot be read. The cron additionally
  checks the recipient BEFORE claiming - a walk-in placeholder `.invalid`
  address, or an active bounce/complaint suppression - so an unreachable member
  costs one skipped pass instead of a burned stamp and a manufactured bounce row
  every three hours, and the reminder stays cleanly due for whenever the address
  is fixed or the suppression cleared. That pre-check is what makes the shared
  stamp rule above affordable in a job that runs eight times a day.

### INV-ADDPAY-002

Three side doors into the finished-unpaid state are closed at the door
(owner decisions 2026-07-11, #1723):

- **Past-dated waitlist force-confirm** (path 1, decision B — allow, flag at
  creation): a force-confirm that lands `PAYMENT_PENDING` on a booking whose
  check-out has already passed is allowed but flagged at creation —
  `createdUnpaidFinishedStay` in the audit details/metadata, an
  `unpaidFinishedStay` field in the route response, and an amber "Unpaid
  finished stay created" card on the admin waitlist page. $0 force-confirms
  (land `PAID`) and parked-for-review outcomes carry no obligation and are
  not flagged.
- **Upward modification of a settled past stay** (path 2, decision B): kept
  on the card additional-payment flow rather than blocked; the uncollected
  delta counts on the second queue above [INV-LOCKOUT-043].
- **Stale group join** (path 3, decision A — exclude): a group whose
  organiser booking's last night is over (`checkOut ≤ NZ today`, the same
  cutoff as the queues — a stay checking out today accepts no new joiners;
  an action window on dates, named as such by the stay-boundary invariant in
  "Booking Dates And Capacity", not a presence rule) leaves
  the joinable set entirely: `hasGroupStayFullyEnded` gates the public
  summary's `isJoinable`, the member join (409), the non-member join request
  (409 `GROUP_STAY_ENDED`), and the emailed-token verify (`not_joinable`),
  sitting directly after the open/deadline check and ahead of the
  payment-mode/active-booking gates.

### INV-ADDPAY-003

A booking left with only non-adults (YOUTH/CHILD/INFANT) requires admin
approval regardless of how it got there or whether it was already paid: every
edit path — including single-guest self-removal, which is never blocked for a
written justification — flags the booking (`adminReviewStatus: PENDING`, with
an automatic note on the removal path) so it lands in the admin review queue.
Review parking moves a booking to AWAITING_REVIEW only from the pre-payment
statuses (DRAFT/PENDING/PAYMENT_PENDING — DRAFT parks in create parity, #2266,
with `draftExpiresAt` nulled so the 72-hour expiry cannot sweep a booking out
from under its reviewer); a paid or confirmed booking is flagged in place, and
approving it clears the review without re-opening the payment lifecycle.
Rejection cancels through the shared cancellation flow, which refunds captured
payments per the policy (a legacy DRAFT-status queue entry — pre-#2266 rows
only — is cancelled directly by the review route with a guarded
DRAFT → CANCELLED flip, since a draft holds no capacity and has no payment).
The invariant is also **enforced at the doors, not only at the writers**
(#2266): `confirm-draft` and `create-payment-intent`'s DRAFT arm both refuse
(409) any booking with `requiresAdminReview` and a non-APPROVED
`adminReviewStatus`, so even a writer bug that leaves a review-flagged DRAFT
behind cannot let a minors-only booking reach PAID with its review pending.

### INV-ADDPAY-004

Because a paid minors-only booking is deliberately **not** parked to
AWAITING_REVIEW (Option A / F27, issue #1372 — parking a paid booking would
collide with the captured-money invariant #1100), a second gate protects the
child-safety concern: while a paid/completed booking carries a PENDING admin
review it is **blocked from lodge check-in**. The block is reason-agnostic
(#1422) — ANY pending admin review gates check-in, not only the adult-supervision
reason (today the only such reason, but a future review type inherits the gate
automatically). Server enforcement lives in the shared
`checkinNotBlockedByPendingReviewFilter()` where-fragment, which **excludes** the
booking from the arrive/depart and roster generate/confirm queries
(`src/lib/lodge-date-scoping.ts`) so its guest resolves to null server-side
(arrive returns 404, roster-confirm 400); the check-in reminder cron skips it as
well. The lodge **guest list** (the roster staff read on the kiosk) is the one
surface that now **shows** the blocked booking rather than hiding it — flagged
"Blocked from Check-In — see Booking Officer" with its arrival toggle disabled,
so staff can see who is held while the booking stays un-arrivable server-side
(defense in depth). The booking keeps its PAID status throughout; clearing the
review to APPROVED makes it check-in-eligible again. When the flag newly trips on
a paid booking a best-effort admin email fires (template `admin-minors-review`,
gated by its own `adminBookingReviewRequired` notification preference #1422),
since nothing changes the booking's visible status to signal the block.

### INV-ADDPAY-005

The member **edit** panel collects this justification proactively (#2104): it
mirrors the `requiresAdultSupervisionReview` predicate client-side (the same
inlined check the create wizard uses) and renders a required reason field as soon
as an in-progress edit would leave the post-edit party minors-only — unless the
viewer is acting as an admin (admins auto-approve) or the booking is already
flagged/reviewed (the server only demands a reason on the FIRST trip). As a
belt-and-braces fallback for any client/server drift, the modify route returns
the machine-readable `REVIEW_JUSTIFICATION_REQUIRED` code, on which the panel
reveals the same field and re-surfaces the request. The server
(`resolveModifyReviewUpdate`) remains the sole enforcer; the client field only
saves the member a round-trip.

### INV-ADDPAY-006

A quote hold spans the whole quote lifecycle (issue #1254). Sending a quote
places the hold automatically: the held booking (AWAITING_REVIEW, a
capacity-holding status) reserves the beds/guest-nights before the send is
finalized, so a quote is never emailed for dates it cannot reserve — if the
lodge is full the send fails loudly (409). The hold survives acceptance: on
accept/approve the same held row becomes the request's converted booking and
moves AWAITING_REVIEW → PENDING, which keeps holding via rule (b) above [INV-CAP-004], so an
accepted-but-unpaid quote does not lose its bed before payment. Accept and the
no-payment cancel are serialized on the global booking advisory lock (#1311): the
cancel re-reads the held status under that lock and flips to CANCELLED only while
it is still AWAITING_REVIEW/WAITLISTED/WAITLIST_OFFERED, so a cancel racing an
accept can never clobber the just-converted PENDING booking back to CANCELLED —
the loser returns 409. The guest swap
at accept updates the held booking's existing guest rows in place (stable
`bookingGuest` ids) instead of delete-then-recreate, so an admin's pre-assigned
`BedAllocation` rows, #713 night sets, promo guest targets, and chore
assignments are preserved. The hold is released on cancel (requester declines
the quote), expiry, or a capacity-reduction bump: the quote-expiry cron
(`cron-quote-expiry-reminders.ts`) frees the bed behind any SENT quote whose
response link has lapsed, and the accepted-but-unpaid booking is released by
the same hold-deadline machinery as any other PENDING request booking
(`cron-confirm-pending.ts`). Every release path detaches
`BookingRequest.heldBookingId` so a later re-quote can never reuse a released
row.

### INV-ADDPAY-007

An accepted-but-unpaid quote hold is **not** protected against a later reduction
of lodge capacity for its nights (owner-ratified, #1317). At the hold deadline
`cron-confirm-pending.ts` re-checks capacity for those nights under the booking
advisory lock; if capacity has since been lowered below what is booked, the
still-unpaid hold is bumped/cancelled (no charge, bumped email sent) exactly as
any other over-capacity PENDING request booking would be. The capacity-priority
rule above [INV-CAP-004] ("a later *member* booking can no longer bump an accepted-but-unpaid
quote") is unchanged — only an admin lowering the nightly capacity can reclaim an
unpaid hold. Paying the hold moves it to a fully capacity-holding status and ends
this exposure.

### INV-ADDPAY-008

School approval re-checks per-night capacity for the FINAL guest list on both
branches before anything flips to a capacity-holding status (#1352, #1911,
#1881). Fresh-create is a capacity-only admission and takes the canonical
per-lodge capacity lock. Held-reuse excludes the held booking's own guests from
the capacity check and takes global `lock(1)` -> per-lodge because it must
exclude cancellation/release of the existing AWAITING_REVIEW booking. It
re-reads the request and hold under both locks and claims
`AWAITING_REVIEW -> CONFIRMED` with a status-guarded update; a lost claim rolls
back every guest/member/payment/audit side effect. A hold reserves only the
originally held
guest count, so an admin child-count override at approval can never confirm
more beds than actually remain on any night; the admin sees the same
capacityExceeded outcome as the fresh path.

### INV-ADDPAY-009

A booking converted from (or held for) a public/school booking request keeps
the held booking's immutable concrete lodge even when the request stored a null
default-lodge selector and the configured default later changes. Held generic
and school conversions lock that concrete lodge, fully re-read the request and
booking, and reject any explicit lodge mismatch before mutation. The booking
keeps its officer-negotiated price, flat-split across guest rows; the quote's
per-tier rates are not persisted on the booking. Before a school group
arrives, the school contact confirms who is attending (#1101): a tokenized
public page (hash-stored, rotated per reminder email) applies identity-only
name updates through the same price-preserving machinery as quoted-booking
edits, and the explicit confirmation is stored on the booking request.
The booking's owning contact is an admin decision taken where the owner is
first materialised — a capacity hold, or approval when no hold exists (#1255):
the admin either creates a new non-login `NON_MEMBER`/`SCHOOL` contact or maps
the request onto an existing non-login `NON_MEMBER`/`SCHOOL` contact, and
mapping reuses that contact's Xero contact instead of spawning a duplicate. A
booking request is never mapped onto a `canLogin:true` member, a held request's
owner stays fixed until the hold is released (an admin **Release hold** action
cancels the `AWAITING_REVIEW` held booking through the shared cancel path,
freeing the beds and re-enabling the contact choice). Because this is an admin
re-mapping rather than a requester cancellation, the release suppresses the
customer "booking cancelled" email (`cancelBooking`'s
`suppressCustomerNotification` option — the detach/reconcile/audit still run),
and it deliberately does **not** revoke the requester's quote response token:
the link stays active, so the admin is warned to re-send a fresh quote after
re-mapping. Releasing a hold (and declining a held request) refuses with HTTP
409 rather than cancelling if the requester accepted the quote concurrently —
i.e. the held booking has already left `AWAITING_REVIEW` (`cancelBooking`'s
`requireRequestHold` guard, #1406) — so a just-accepted booking is never
cancelled and its payment links never revoked out from under the requester.

### INV-ADDPAY-010

An admin decline releases the capacity hold from ANY held/editor state, not just
`VERIFIED`/`PRICED` (#1423): a decline is valid from all six states the admin
panel shows the Decline button for — `VERIFIED`, `PRICED`, `QUOTED`,
`QUOTE_SENT`, `QUERY_PENDING`, `MODIFICATION_REQUESTED`
(`DECLINABLE_BOOKING_REQUEST_STATUSES`) — and each can carry a live
`AWAITING_REVIEW` hold that the decline frees (claim-first: the `DECLINED` flip
lands before any hold release, so a wrong-state decline `409`s and never touches
the hold).

### INV-ADDPAY-011

A DECLINED request is untouchable by every other actor. In the SAME transaction
as the `DECLINED` claim, the decline retires any outstanding `SENT` quote
(`SENT` -> `SUPERSEDED`; `SUPERSEDED` = admin retired it, distinct from a
requester-cancel `CANCELLED`). Because `loadSentQuoteByToken` requires
`status === SENT`, that retirement alone `409`s all four requester quote actions
(accept / modify / query / cancel) on a still-live link, and the pre-expiry
reminder cron (which selects only `SENT` quotes) skips the declined request
instead of nudging it. As defence-in-depth against a request finalised between a
requester POST's token load and its write, the accept re-arm, the modify/query
re-status, and the losing-accept capacity revert are each status-guarded with
`status notIn [DECLINED, CANCELLED]`: a late accept or modify/query `409`s (no
new booking, Payment, or PaymentLink; no resurrection to
`MODIFICATION_REQUESTED`/`QUERY_PENDING`), and the revert simply does not
un-decline the request. The guards still permit a re-arm from
`CONVERTED`/`APPROVED`, preserving approve's `convertedBookingId` idempotency
(#1232 double-accept returns the one existing booking). Per-teacher hut-leader records are always created fresh. The held owner is re-validated at conversion:
if a previously mapped contact is no longer a valid non-login contact by the time
the requester accepts (login enabled, archived, deactivated, role changed), the
accept still succeeds — a fresh non-login contact is substituted and both a
durable admin-attention audit row (`booking_request.owner_substituted`) and an
active `admin-owner-substitution` admin email alert (gated by the
`adminXeroSyncError` preference, F20 residual #2 / #1377) are raised post-commit
so the substituted Xero contact can be reconciled. When the Xero module is off, the
manual-invoice admin notification names the resolved booking owner (the mapped
contact when mapped), not the raw request school/contact.
Headcount or tier changes still go through the admin re-quote flow, and
unconfirmed lists inside the prompt window surface on the stuck-state
dashboard. Standard edit paths (batch
modify, date change, guest add, single-guest removal, and the modify-quote
preview) refuse such bookings rather than silently repricing every guest at
season rates — the change is made by re-pricing or issuing a revised quote
from the booking request. The one exception (#1099) is identity-only edits:
guest name fixes never run the pricing engine — stored totals, per-guest
prices, and night rows are echoed back unchanged on every booking, quoted or
not — so they pass the block, and quoted bookings are additionally exempt
from the paid-name lock (renaming placeholder students after the school has
paid its invoice is the intended workflow).

### INV-ADDPAY-012

The paid-name lock on free-text (non-member) guest names blocks changing who a
booking is for after full payment — an unauthorised transfer/resale. It has one
narrow exemption (#1386): on an **identity-only** edit (no structural change) of
a fully-paid, non-quoted booking, an identity-preserving spelling **typo** may
be corrected. A change qualifies only when, on names normalised as trim +
lowercase + collapse-internal-whitespace: (a) neither new part is blank; (b) the
first name and last name each keep the same word/token count (a typo never adds
or removes a name part); (c) no positionally-aligned token is a whole-token
replacement — for each aligned first/last token pair, at least half of the
longer token must be preserved (edit distance × 2 &lt; max token length), which
refuses surname-family swaps like "David Ng" → "David Wu" and "Ann Ho" →
"Ann Lo" even though their overall distance is ≤ 2; and (d) the
Damerau-Levenshtein distance (adjacent transposition = 1 edit) between the
normalised full names is at most `min(2, floor(0.25 × lengthOfLongerFullName))`
— at most two edits and never more than a quarter of the longer name, distance 0
(pure case/whitespace) included. Anything else keeps the hard reject ("only
spelling corrections are allowed after payment; contact the office to change who
a booking is for"), so a same-surname given-name swap ("John Smith" →
"Jane Smith", distance 3) and a full swap ("John Smith" → "Aroha Ngata") are
refused. The rule is enforced server-side (`src/lib/guest-name-similarity.ts`,
mirrored in the modify-quote preview); it never reprices or rechecks capacity
(the identity-only price-preserving path still applies), and every allowed fix
writes a `BookingModification` audit row discriminated as `GUEST_TYPO_FIX` (with
a `paidNameTypoFix` snapshot flag) carrying old→new names, actor, and time.
Member-linked guest names remain unrenameable regardless.

### INV-ADDPAY-013

**Residual risk (accepted, audit-mitigated):** the per-token and distance bounds
above stop wider swaps, but a SINGLE-character change that keeps most of a
token is fundamentally indistinguishable from a spelling typo by string
comparison, so short one-edit substitutions such as "Kim" → "Tim", "Sam" →
"Pam", or "Rob" → "Bob" are STILL accepted after payment. This is
self-serviceable by the booking owner (`booking.memberId === actor`) on
PAID/CONFIRMED bookings and cannot be closed in code. Its only mitigation is the
`GUEST_TYPO_FIX` audit trail, which admins should periodically review for
suspicious post-payment renames.

### INV-ADDPAY-014

A price reduction against an issued-but-unpaid Xero invoice (pay-on-account,
no captured payment) is corrected for the full net delta — there is no captured
money and therefore no cancellation-policy tier to apply — via a modification
credit note against the primary invoice, which is never reissued. Consequently
the true outstanding balance on such an invoice is the current `finalPrice`
plus any billed change fee, i.e. the original total minus the modification
credit notes already issued. Cancellation must clear that true outstanding and
must not read the captured-amount mirror (`payment.amountCents`), which stays at
the original total until asynchronous Xero reconciliation folds the credit note
into `refundedAmountCents`.

### INV-ADDPAY-015

The paid-path twin of that rule: cancellation of a booking with a captured
payment computes its refundable base as
`min(amountCents − refundedAmountCents, finalPrice + changeFee) − changeFee`,
never from the raw Payment mirror alone. Prior reductions can leave the mirror
stale (an Internet Banking invoice paid at its reduced amount, or a
penalty-window retention), and an uncapped base pays out more than the booking
is worth. The cancel preview applies the same cap so the member is never
promised more than the cancel will pay.

### INV-ADDPAY-016

A credit-settled modification reduction allocates against the payment's
captured transactions (`applyLocalRefundAllocation`) in the same transaction
that writes the `MemberCredit`, exactly as a card-settled reduction does via
the refund ledger. `refundedAmountCents` therefore reflects every settlement
method, and no ordering of edit/cancel operations may produce a different
total payout (refunds plus credits) than another ordering reaching the same
final state.

### INV-ADDPAY-017

A net-positive booking edit that mixes a price reduction with a larger
late-change fee bills Xero the SIGNED components on one supplementary invoice
(#1356): a negative price-adjustment line beside the positive fee line, so the
invoice total and the payment recorded against the Stripe clearing account
both equal the net the member was actually charged — the same net the
additional Stripe PaymentIntent captured. The negative line posts to the
`hutFeeRefunds` account mapping, like every other give-back (a club that
prefers a single ledger line maps `hutFeeRefunds` to the same code as
`hutFeesIncome`); positive lines stay on `hutFeesIncome`. Clamping the negative component
would over-record income and Stripe-bank receipts by the dropped reduction
and break bank reconciliation. A supplementary invoice exists only for a
positive net; a mixed-sign edit whose net is zero or negative settles through
the modification credit-note paths, and both the outbox enqueue and the
executor refuse (skip, replay-safely) rather than gross-bill the fee. The
booking-vs-Xero repair pass applies the same rule: it verifies supplementary
invoices against the modification net and queues missing ones with the signed
components. On the credit-note side the repair pass sizes by STORED evidence
(#1427): abs(net) is only an upper bound, because the primary path caps the
credit at the policy-limited settlement the modification row cannot
reconstruct. Queue actions and the amount-evidence expectation prefer the
resolved note's own enqueue payload (then oldest-first — the first enqueue
is the primary-path settlement decision; CANCELLED attempts rank last), and
replaying that amount rebuilds the identical amount-embedding correlation
key, so the local outbox dedup holds and a recent attempt that already
reached Xero dedups within Xero's idempotency window — then link metadata,
then executed note totals, then (last resort) a bare legacy payload.
Operation evidence, object resolution, and blocking detection are all
discriminated by the operation's queue-type hint: the immutable `queueType`
COLUMN (#1347), then the payload's own name, then the correlation-key
segment — decisive for the pre-column executed ledger, whose payloads were
overwritten at dispatch before the column backfill copied them. An
account-credit-note op beside the invoice-applied note (same
entityType/operationType) therefore never sizes, resolves as, blocks, or
pollutes the mismatch evidence of the invoice-applied note — in the
worst case that confusion allocated the member's UNAPPLIED account-credit
note against the already-paid primary invoice (double-refund exposure). A
net-negative modification positively settled by an account credit note (link
role or executed op hint) is complete as-is: it has no invoice-applied note
to repair and produces no finding. A
stored amount outside (0, abs(net)] is ignored as inconsistent, so an
over-sized note still flags against abs(net); the deliberate limit of
evidence-first is that a wrongly-enqueued amount INSIDE the range reads as
the app's recorded decision and reports clean — the alternative (flagging
every non-abs(net) note) drowned real drift in a false positive on every
policy-tiered booking. When no stored evidence exists and the payment has
captured money (by aggregate status or a captured transaction row), BOTH the
missing-note queue and the missing-allocation queue become manual-review
findings instead of auto-applying abs(net); auto-queueing abs(net) remains
correct only for the no-captured-payment case, where the full delta is a
pure bookkeeping correction (#1015). A live-but-not-retryable credit-note or
allocation operation surfaces as blocked rather than silence (and a
FAILED-unretryable one says so, not "pending"). The manual retry stack replays the operation's STORED amounts
first (the #1354 queued-payload-first rule): the Xero idempotency key embeds
the amounts, so replaying the enqueued values keeps the retry deduplicable
against the original attempt, preserves a policy-limited credit-note
settlement the modification row does not record, and lets the enqueue-time
`queueType` distinguish an unapplied account-credit note from an
invoice-applied one. Only fully-legacy rows fall back to the signed
modification record — a rebuilt supplementary invoice keeps its reduction and
a rebuilt credit note refunds the absolute net, never the absolute price
component alone (which would over-credit by the fee).

### INV-ADDPAY-018

A cancellation's card-refund debt must be durable before any external call
(#1349): the claim transaction that flips the booking to `CANCELLED` also
writes the payment-recovery operation, carrying the per-transaction refund
allocation frozen from the under-lock read. No crash point between the claim
commit and the Stripe refund may leave the debt unrecorded, and no combination
of the inline refund and the recovery cron may pay it twice — both execute the
same frozen slices, so they mint identical Stripe idempotency keys and Stripe
replays rather than repeats. The mirror of this rule is the group-cancel
settlement, which persists its per-child `refundPlan` before its Stripe refund
for the same reason.

### INV-ADDPAY-019

Xero contact resolution (`findOrCreateXeroContact` /
`createXeroContactForMember`) performs every provider call — OAuth refresh,
searches, creates, and their retry sleeps — OUTSIDE any database transaction
(#1355): concurrent duplicate creation is bounded by the member-scoped Xero
idempotency key, and only the local link write takes a SHORT advisory-locked
transaction with a re-check (first-writer-wins against a concurrent
resolver). Operation-log success is recorded post-commit only; a local-link
failure after the Xero call marks the operation FAILED, never SUCCEEDED for
rolled-back state.

### INV-ADDPAY-020

Stepped Stripe refunds settle into Xero as per-delta credit notes whose cents
must sum exactly to the payment's refunded total (#1354). The amounts billed
to Xero are derived from EXECUTION-TIME state (`refundedAmountCents` minus the
sum of active covering notes), never trusted from an enqueue-time watermark —
so operations executing out of order, replays through the retry stack (which
re-enters delta mode via the queued payload or the enqueue-time `queueType`
column), and races between enqueue and execution all converge on the same
books. Inbound reconciliation MERGES link metadata over the outbound
per-delta keys instead of replacing them; the outbox processor fails errored
operations for every queue type (keeping them replayable rather than
RUNNING-stuck dead-ends); the daily credit-reconciliation cron re-enqueues
the uncovered delta for any flagged payment so historical gaps self-heal; and
a partial unique index allows at most one ACTIVE outbox operation per
correlation key (owner-approved defence in depth — terminal rows may repeat
the key across attempts).

### INV-ADDPAY-021

For `source: STRIPE` payments the local refund ledger is Stripe-truth and
inbound Xero reconciliation may only raise it, never lower it (#1353). The
inbound credit-note repair keeps the local `refundedAmountCents` when the
Xero-derived total is below it (logging and raising the deduped Xero sync
alert instead of rewriting), and never flips a REFUNDED/PARTIALLY_REFUNDED
Stripe payment back to SUCCEEDED from Xero-derived data — an operator voiding
a refund credit note in Xero cannot "un-refund" money Stripe has already paid
out, and a missing refund-delta credit note can no longer silently lower the
ledger the missing-credit-note detector compares against (which previously
self-masked the divergence). Internet Banking payments are the deliberate
exception: Xero is their payment rail, so the repair remains authoritative in
both directions for them.

### INV-ADDPAY-022

Cancelled-booking soft-delete may hide an operational duplicate only when it
preserves the booking row and no external money/Xero history needs to remain
operator-visible by default. Balanced internal modification deltas that net to
zero are not external financial history by themselves.

### INV-ADDPAY-030

**A soft-deleted booking is always `CANCELLED`, and stays that way** (#2674).
`Booking.deletedAt` has exactly one writer — `softDeleteCancelledBooking` in
`src/lib/booking-delete.ts`, which refuses any status other than `CANCELLED` —
nothing anywhere transitions a booking back out of `CANCELLED`, and `deletedAt`
is never cleared. Two consequences follow, and both are load-bearing:

- **A fixture carrying `deletedAt` beside a live status models a shape
  production cannot emit.** Deletion is not an orthogonal "archived" flag layered
  over any status, which is what the schema shape alone would suggest.
- **Most booking routes refuse a deleted booking only INCIDENTALLY**, through a
  status gate that excludes `CANCELLED` rather than through any deletion check.
  A sweep of all 27 exported methods under `src/app/api/bookings/[id]/**` (#2674)
  found, **before** the guards added by that issue: **4** consulting `deletedAt`
  directly (`additional-payment-secret` GET, `requested-room/options` GET,
  `send-guest-payment-link` POST, `[id]` DELETE); **17** methods refusing a
  deleted booking only via some other guard; **4** genuinely reaching a write
  (`confirm-modification-payment` POST, `guests/[guestId]/consent` POST,
  `exception-requests/[requestId]` PATCH, `refund-request` POST); and **2**
  read-only GETs that check nothing and will serve a deleted booking's data to
  its own owner (`change-requests`, `refund-request`).
  4 + 17 + 4 + 2 = 27. **After** the guards — `arrival-time` PUT and DELETE,
  `refund-request` POST, and the `booking: { deletedAt: null }` relation filter
  inside `cancelModificationExceptionRequest` — the split is **8** direct,
  **15** incidental, **2** still reaching a write, and the same **2** unguarded
  reads.

  **After #2700 the split is 11 / 15 / 1 / 0 = 27**, re-measured by enumerating
  all 27 methods rather than by adjusting the arithmetic. #2700 closed the
  consent write and both reads, so: **11** consult `deletedAt` directly **and
  refuse** (the 8 above, plus `guests/[guestId]/consent` POST through
  `member-guest-consent-service.ts`, plus `change-requests` GET and
  `refund-request` GET); **15** refuse only incidentally, unchanged, because
  #2700 touched none of them; **1** consults `deletedAt` directly and
  **deliberately writes anyway** (`confirm-modification-payment` POST — see
  `INV-ADDPAY-036`); and **0** unguarded reads remain.

  **The first and third categories are both "consults `deletedAt`", and they
  are split on what the route then DOES**, so the partition stays disjoint and
  still sums to 27. Counting "routes that consult `deletedAt`" gives **12**, not
  11, and a reader who adds the categories expecting that number will think one
  is missing. The distinction is the point: consulting the column is not the
  same act as refusing on it, which is the same lesson `INV-ADDPAY-031` records
  about `send-guest-payment-link`.

  So "this route is safe" is not the same claim as "this route checks",
  and a change to a status rule can uncover a write nobody meant to expose. Any
  NEW booking-scoped write should carry the guard explicitly rather than inherit
  the coincidence.

  Two earlier revisions of this paragraph were wrong, and both errors are worth
  naming because each would have sent someone to the wrong place. The first said
  15 rather than 17 incidental and omitted the reads entirely, so its figures
  summed to 23 and four methods went unaccounted for. The second counted
  `cancel-preview` GET among the unguarded reads: it is not one. That route
  rejects any status outside `PENDING`/`PAYMENT_PENDING`/`CONFIRMED`/`PAID` with
  a `400` before it builds any payload, and by the first clause of this invariant
  a soft-deleted booking is always `CANCELLED` — so it refuses every deleted
  booking, unconditionally, and returns no booking data. It is an incidental
  refusal, which is exactly the category this invariant exists to distinguish
  from a real check.

### INV-ADDPAY-031

The house shape for the guard is `requested-room/options` (#2673): select
`deletedAt` beside the authority fields, return **404 uniformly for every role**
— no Full Admin exemption, because that exemption belongs to record-*viewing*
surfaces like `bookings/[id]/page.tsx` and not to writes — and place the check
**after** the authorisation check, so an unauthorised caller gets `403` either
way rather than a deleted-or-live oracle. The 404 body must be **byte-identical**
to the not-found body, so an authorised caller cannot tell a deleted booking from
one that never existed.

The ordering half is the part that is easy to get wrong, and it was wrong on one
of the four routes the census above found "consulting `deletedAt` directly".
`send-guest-payment-link` POST folded the deletion test into its not-found branch
(`if (!booking || booking.deletedAt)`) **above** its 403, so a caller with no
claim on the booking got `403` while it was live and `404` the moment an admin
deleted it — a deleted-or-live oracle on any id whose existence they could
otherwise establish (a booking they were a guest on, a shared URL). Consulting
`deletedAt` is therefore not sufficient evidence that a route follows this rule;
the ordering has to be read. Reordered in #2674 and pinned by
`src/app/api/bookings/[id]/send-guest-payment-link/__tests__/deleted-booking-ordering.test.ts`.

**The byte-identical-body half now has one named carve-out, and only that
half.** `INV-ADDPAY-034` lets three surfaces say the booking was cancelled or
removed instead. The **ordering** half — after the authorisation check, always —
has no carve-out anywhere and is what keeps the carve-out safe: every surface
that departs from the body rule still answers `403` to a caller with no claim,
so nothing is disclosed to anyone not already entitled to the record. Read the
two halves separately; a future exception to one is not an exception to the
other.

### INV-ADDPAY-032

**Superseded by INV-ADDPAY-035 and INV-ADDPAY-036 (#2700).** Both decisions were
taken in the owner's 10 Aug 2026 walkthrough and both surfaces are now closed —
the consent write refuses, the modification payment records and queues a human.
Neither remains "tracked as a decision rather than a guard". Original text kept
below, verbatim, because merged commits and closed issues cite this id.

Two write paths are known to remain reachable on a soft-deleted booking, and are
tracked separately because each needs a decision rather than a guard:

- `bookings/[id]/guests/[guestId]/consent` — **both** arms, not just one. The
  APPROVE arm is the more direct of the two: it takes the claim
  (`member-guest-consent-service.ts:426-439`) having read neither `status` nor
  `deletedAt` — the booking is loaded there only to pick a lodge lock — then
  reconciles beds and emails the booking's owner about a record the club has
  deleted. The DECLINE arm additionally records a response outside the
  transaction it rolls back.
- `bookings/[id]/confirm-modification-payment` — where refusing to record a
  payment Stripe has already captured is not self-evidently safer than recording
  it.

### INV-ADDPAY-033

**Superseded by INV-ADDPAY-034 (#2700).** Both reads now refuse a soft-deleted
booking, sharing one sentence with the consent write. Original text kept below,
verbatim — and its `cancel-preview` correction is still the authority on why
that route is not a third, which is why this stub does not repeat it.

The two unguarded read-only GETs above — `change-requests` and `refund-request` —
are tracked with them: each reads the booking on `{ memberId }` alone and returns
a deleted booking's own data to its own owner after the 403, which is a smaller
problem than a write but is still a surface the booking page itself refuses.

`cancel-preview` GET is **not** one of them, though an earlier revision of
`INV-ADDPAY-030` listed it as a third: its status gate refuses every deleted
booking with a `400` before any payload is built. Anyone acting on that earlier
figure would have gone to add a guard to a route that already refuses.

### INV-ADDPAY-034

**Three surfaces tell the reader the booking was cancelled or removed instead of
answering a bare 404, and they share ONE sentence to do it** (#2700, owner
decision 10 Aug 2026). The sentence lives in
`src/lib/deleted-booking-refusal.ts` as `DELETED_BOOKING_MESSAGE`, and the three
callers import that constant rather than restating it:
`guests/[guestId]/consent` POST, `change-requests` GET, and `refund-request`
GET. One constant, not three copies, is the rule — three variants that say
subtly different things about the same event is the failure this prevents.

**Both halves are ENFORCED, not merely written down.**
`src/lib/__tests__/deleted-booking-refusal-callers.test.ts` sweeps `src/` for
importers of the refusal module and fails on a fourth, and asserts per surface
that the guard sits below that surface's own authorisation refusal. Without it
a later contributor could import the constant — now that an informative body is
normalised on this hazard — and place it above an ownership check, restoring the
`send-guest-payment-link` oracle #2674 had to reorder out, with every existing
test still green.

**This is a deliberate departure from `INV-ADDPAY-031`'s byte-identical-body
half, and it is worth stating precisely because the general rule is the opposite
of it.** Disclosing that a record existed and is gone is normally an oracle. It
is not one here, because **the guard sits after the authorisation check** on
every one of the three: to see the sentence you must already be the guest being
asked, an accepted family delegate answering for them, the booking's owner, or
an admin. A caller with no claim still receives `403` and learns nothing, and
the answer they get does not move with the booking's deletion state. Disclosure
to somebody already entitled to the record is not an oracle. The ordering half
of `INV-ADDPAY-031` therefore has no exception and is what makes this one safe.

**Why say anything at all.** "Booking not found" is a dead end that reads as a
fault in the system; "cancelled or removed" is an explanation the reader can act
on. The owner's stated purpose (10 Aug 2026) was that somebody arriving from an
old club email gets the explanation rather than the dead end.

**Who actually reaches it today, stated plainly, because the rule above must not
claim a journey the product does not have.** The reader is a client that loaded
the booking BEFORE the deletion and acted AFTER it — the stale tab, which is the
same race the rest of this rule and `INV-ADDPAY-036` exist for — or a direct API
caller. **No fresh navigation reaches any of the three bodies**, and every one
of the four paths dead-ends earlier for its own pre-existing reason:

- The consent card lives on `bookings/[id]/page.tsx`, which calls `notFound()`
  for any non-admin on a deleted booking before rendering anything.
- The delegate consent page resolves `{ kind: "NOT_FOUND" }` on
  `guest.booking.deletedAt` in `member-guest-delegate-page.ts`, **above** both
  the target and the delegate branches — deliberately, so the neutral page
  cannot be used to tell a real guest row from a fabricated id.
- `refund-request` GET's only client is `RefundAppealButton`, which the booking
  page renders only when the booking is not deleted.
- `change-requests` GET has **no client at all** in `src/` or `e2e/`; the one
  fetch of that path is the panel's `POST`.

So the departure below is currently worth its cost for the race, not for the
email journey. Making the email journey itself explain rather than dead-end
would mean changing the delegate page's uniform `NOT_FOUND` — which is a
privacy property with its own Playwright assertion — and is therefore an owner
decision rather than a tidy-up. Recorded here rather than assumed: do not cite
the email journey as a live behaviour until that decision is taken.

**What the sentence must NOT carry, and both exclusions are load-bearing:**

- **Who deleted it.** The guest does not need it, the system cannot always
  assert it accurately, and naming an actor invites the reader to wonder whether
  somebody made a mistake.
- **The booking owner's name.** That would leak a member's identity on a booking
  the club has deleted. "Contact the club" costs the reader nothing.

**The status stays 404, not 410.** 404 is what `INV-ADDPAY-031` already fixed
across this route folder and what every existing client treats as "gone"; the
decision changed the BODY, not the status. It is uniform for every role
including a Full Admin — the record-viewing exemption on `bookings/[id]/page.tsx`
belongs to the page, not to the APIs beneath it.

**A route may carry both bodies at once, and `refund-request` does.** Its POST
keeps the byte-identical `Booking not found` settled by #2674; its GET carries
this sentence. That is not drift: both sit after the same 403, so the one person
who can see either learns the same fact from both. Pinned by "answers a
DIFFERENT body from the POST on the very same deleted booking" in
`src/app/api/bookings/[id]/refund-request/__tests__/route-deleted-booking.test.ts`,
so a later reader who notices the difference finds it asserted rather than
accidental.

### INV-ADDPAY-035

**A soft-deleted booking takes no member-guest consent answer, from any role, on
either arm** (#2700, owner decision 10 Aug 2026, superseding the first bullet of
`INV-ADDPAY-032`). `respondToMemberGuestConsent` refuses with 404 and
`INV-ADDPAY-034`'s shared sentence. Nothing is recorded: no status claim, no bed
reconcile, no hosting-queue drain, no audit entry, and **no email to the booking
owner** about a record the club has deleted.

Both arms needed closing, and the APPROVE arm was the more direct of the two: it
took its claim having read neither `status` nor `deletedAt`, because the booking
was loaded only to pick a lodge lock. The DECLINE arm additionally recorded a
BLOCKED response outside the transaction it rolls back — the refusal now lands
before that transaction is opened, so that path is unreachable too.

**The guard is asserted TWICE and both are required.** An unlocked pre-read
produces the right answer cheaply and keeps the refusal out of the transaction;
a second read **inside** the transaction, after `pg_advisory_xact_lock(1)`, is
what makes it true. `softDeleteCancelledBooking` takes that same key, so a
deletion committing between the two reads is serialised behind the consent
transaction and seen by the locked read. Removing either one fails a named test
in `src/lib/__tests__/member-guest-consent-deleted-booking.test.ts`.

**The guard cannot live in the route, and that is not a style preference.** The
route's pre-read proves only that the guest row belongs to the booking — not
that the caller is the target or an accepted delegate. A check there would hand
somebody holding a guessed pair of ids a 404-versus-403 oracle, which is exactly
what `INV-ADDPAY-031`'s ordering half forbids and exactly the defect
`send-guest-payment-link` had.

**The route's uniform 403 still wins wherever it applies.** A non-existent
booking, a non-existent guest row, a guest row on another booking, an
already-answered request, and a caller who is neither target nor delegate all
keep answering the same 403 with the same body on a deleted booking as on a live
one. The new message is reachable only after all of those have passed.

### INV-ADDPAY-036

**A booking modification payment captured against an already-deleted booking is
RECORDED and queued for a person; it is never refused, and never automatically
refunded from that path** (#2700, owner decision 10 Aug 2026, superseding the
second bullet of `INV-ADDPAY-032`). The owner rejected both of the alternatives:
recording it silently leaves a ledger row against a ghost booking with nobody
told, and refusing it leaves the club holding a member's money with no record of
it at all. Three obligations follow, and all three are the rule:

- **`confirm-modification-payment` POST does not refuse.** Stripe has already
  captured by the time it is called; a 404 would leave a captured payment with
  no ledger row, which is worse than a ledger row against a deleted booking. It
  is the one method on this prefix that consults `deletedAt` and deliberately
  writes anyway, which is why the `INV-ADDPAY-030` census counts it separately
  from the eleven that refuse.
- **It decides from a FRESH read of `deletedAt`, not from the one it opened
  with.** The handler's opening read happens before `getPaymentIntent` — a live
  Stripe round trip — so deciding from it covers only the ordering where the
  booking was already deleted when the handler looked. In the other ordering the
  DELETE commits while the handler is talking to Stripe, and deciding from the
  stale value recorded the capture and raised nothing: the exact state this rule
  says cannot occur. The flag is therefore re-read immediately before the
  decision, and **either** read seeing a deletion is enough — nothing in the tree
  un-deletes a booking (one writer of `deletedAt`, no restore path), so the two
  reads can only disagree in one direction. The re-read is skipped when the first
  read already answered.
- **It raises an OPEN `ManualRefundTask`** (`bookingId`, `paymentId`,
  `amountCents`, `reason`, `status: OPEN`) after recording the payment and
  before the audit entry, so a human decides whether to refund. `status: OPEN`
  is written explicitly rather than inherited from the schema default, so the
  property is the code's and provable without a database. The raise is
  idempotent on the **payment intent** — matched on
  `bookingId + paymentId + this intent's reason` across every status — so a
  retry raises nothing, and the unrelated cash/manual settlement task
  `booking-cancel.ts` can hold on the same booking is never mistaken for it.
  Raising it is best-effort in exactly one sense: a failure is logged loudly and
  never turned into a 500, because the money IS recorded and a retry would take
  the already-captured early return and never reach the raise again.
- **The raise is fenced against a refund that already happened**, under the same
  `pg_advisory_xact_lock(1)`. The close described below only catches a webhook
  that arrives after the task exists; a webhook that completes entirely inside
  the confirm route's own Stripe round trip leaves nothing to close, and the
  route then writes `SUCCEEDED` back over the `REFUNDED` status and would raise
  a task for money Stripe has already returned — one an operator cannot even
  complete, because `applyLocalRefundAllocation` throws "Refund amount exceeds
  captured payments". So the raise re-reads the transaction row and skips when
  `refundedAmountCents` covers the capture. That field, not `status`, is what
  decides it: `markPaymentIntentTransactionSucceeded` overwrites the status but
  never the refunded total, so on this interleaving the status is the field that
  is lying.
- **The deletion path closes the window rather than only handling the fallout.**
  `softDeleteCancelledBooking` cancels the booking's in-flight PaymentIntents —
  both the base and the modification one — **after** the transaction commits, so
  no Stripe round trip happens while the global lock is held and no provider
  timeout can roll back a deletion the admin was told nothing about. It never
  throws, and it marks the local transaction FAILED **only** when Stripe
  confirms the cancel; on `canceled: false` the intent reached a terminal state
  on its own, possibly `succeeded`, and writing FAILED there would be a lie the
  confirm endpoint would immediately overwrite. The honest claim is that this
  makes the race **rare**, not impossible — the residue is what the task above
  exists for. A cancellation that FAILS is **audited**, not only logged
  (`booking.delete.payment_intent_cancel.failed`, `outcome: "failure"`,
  category `payment`): the swallow is right, but the one outcome somebody has to
  act on — the window did not close — must not be visible only in the server
  log, and the soft-delete's own audit entry is written inside the transaction
  before Stripe is called, so it cannot carry it.

**No automatic refund from this path**, deliberately: it is a money movement
triggered by a race, and if the DELETION was itself the mistake, refunding
automatically compounds it rather than surfacing it.

**But a refund can still happen, from a DIFFERENT and older path, and anyone
reading the rule above needs to know it.** Since #1350 the Stripe webhook routes
an additional payment captured on a `CANCELLED` booking through
`handleCancelledBookingAdditionalPaymentSucceeded`, which refunds it in full
automatically — and by the first clause of `INV-ADDPAY-030` a soft-deleted
booking is always `CANCELLED`, so that path covers deleted bookings too. The two
orderings must not pay the member twice:

- **Webhook first** — it records and refunds; the confirm endpoint then finds
  the transaction already captured, takes its early return, and raises no task.
  Since #2760 the webhook writes the record itself in that case, already
  `DISMISSED` (`INV-ADDPAY-037`), so "no task is raised" no longer means "no row
  exists" — it means no OPEN one does.
- **Confirm endpoint first** — it records and raises the task; the webhook's
  refund then answers that task's whole question, so the webhook **closes** it
  as `DISMISSED` with a note. `DISMISSED`, never `COMPLETED`: in
  `manual-booking-payment.ts` COMPLETED means an operator handed the money back
  by hand and is what writes the local refund allocation, so COMPLETED here
  would be untrue AND would write a second allocation for one refund.
  `completedByMemberId` stays null because no member did it.
- **Interleaved** — the webhook completes entirely inside the confirm route's
  own Stripe round trip. The route's already-captured early return does not
  fire (it read the status before the refund) and the close found no task (it
  ran before the raise), so neither of the two guards above applies. The raise's
  own refund fence is what covers this one, and it is the reason that fence sits
  inside the lock rather than beside it.

Closing a task whose subject is already resolved moves no money, so it does not
contradict the no-automatic-refund rule; the refund it records is #1350's
established behaviour and is not introduced by #2700. Nor does #2760's write: an
already-`DISMISSED` row asks nobody for anything and moves nothing. **The
consequence worth naming: on the common path where webhooks are healthy, the member
is refunded automatically and the task is a record rather than a decision.** The task earns
its place in the orderings where the webhook does not arrive, is disabled, or
fails — which is precisely when the club would otherwise be holding money with
nobody told.

### INV-ADDPAY-037

**Every automatic refund of a late capture on a cancelled booking leaves a
`ManualRefundTask`, and that row is visible on the operator surface rather than
only in the database** (#2750, extended by #2760 — owner decision 10 Aug 2026,
taken deliberately over the narrower recommendation — and by #2773, an
**orchestrator** decision the owner has not ruled on; reversible. The authority
line under `INV-ADDPAY-039` covers every #2773 / #2774 clause in this file).

**BOTH LATE-CAPTURE PATHS, SINCE #2773 — AND THE SCOPING CLAUSE THAT USED TO SIT
HERE IS GONE BECAUSE THE CODE EARNED IT, NOT BECAUSE THE CLAIM WAS WIDENED.**
There are two handlers in `stripe-webhook-service.ts`:
`handleCancelledBookingAdditionalPaymentSucceeded` for a payment for a *change* to
a booking, and `handleCancelledBookingPaymentSucceeded` for the booking's OWN
payment. Until #2773 only the first recorded anything; the second refunded with the
same `cancelled_booking_late_capture` reason, wrote the same
`booking.payment.refunded_after_cancellation` audit entry, and left no
`ManualRefundTask` and no unmuteable mail — so an operator holding a
`refunded_after_cancellation` entry with no card row had to know which handler wrote
it before they could tell whether the card was broken. **Both now route through the
same shared epilogue** (`src/lib/cancelled-booking-late-capture.ts`), which is one
implementation rather than a copy per handler: one record writer, one `deletedAt`
re-read, one alert decision.

**WHAT "EVERY ORDERING" MEANS ON THE PRIMARY PATH, checked rather than assumed.**
Nothing in the tree raises an `OPEN` `ManualRefundTask` for a PRIMARY payment
intent — the confirm-modification-payment route is the only raiser of one of these
and it handles modification intents — so the close arm is unreachable there and the
CREATE arm is the only one that fires. First delivery creates the row; a Stripe
redelivery finds this writer's own row and creates nothing; a deletion landing
between two deliveries resolves to the one row, because every lookup matches all
four `reason` sentences; and `booking-cancel.ts`'s cash-settlement task on the same
booking and payment carries a different `reason`, so it neither blocks the create
nor is mistaken for this row. The two named exceptions below are the only gaps, and
they are the same two on both paths.

**FOUR `reason` SENTENCES, ONE PER (capture kind, population).** The kind decides
"a booking modification payment" versus "the booking's own payment" and the
population decides "already deleted" versus "already cancelled". The sentence is
STORED on the row and PRINTED on the finance card, so reusing the modification
wording for a primary capture would print an operator-facing falsehood. Every
sentence is frozen once written, for the reason the deleted-population one always
was: `reason` is the idempotency key.
`INV-ADDPAY-036`'s consequence — that on a healthy webhook the member is refunded
automatically and the task is a record rather than a decision — was only half
delivered: the webhook's own close moved the row out of the `OPEN` list, which is
the only list the finance queue showed, so that durable record of a money movement
nobody authorised appeared on no screen at all. "A human is told" was true of the
database and false of every human.

**THE RECORD IS COMPLETE ON BOTH PATHS, AND #2760 THEN #2773 ARE WHAT MADE IT SO —
WITH TWO NAMED EXCEPTIONS AND NOT ONE MORE.** As #2750 shipped it, a
row existed only where the confirm-modification-payment endpoint had raised one —
one of four orderings — so a webhook-first refund (the ordinary healthy case), a
member who closes the tab after paying, and the interleaved ordering the raise's
refund fence declines all moved money with no row at all. The #1350 refund also
fires on `Booking.status === "CANCELLED"` rather than on `deletedAt`, and the raise
only fires on `deletedAt`, so a late capture on a cancelled-but-live booking
produced nothing either. **The webhook now writes the row itself** —
`recordAutomaticCancelledBookingRefundTask`, already `DISMISSED`, whenever its
OPEN-fenced close claims nothing — **for both populations, and since #2773 from
both handlers.** The qualification that used to sit here, and the "this card does
not catch every one" copy that went with it, are lifted; so is the
booking-change scoping clause #2760 added, because the primary handler now produces
a row in every ordering it can reach. What remains bounded is the CARD's thirty-day
window, not the record: the row and the
`booking.payment.refunded_after_cancellation` audit entry stay permanent.

The two exceptions are stated here, on the card and in
`docs/guides/payments.md`, because a completeness claim with an undisclosed hole
is worse than the partial claim it replaced:

- **An operator who resolved the confirm route's `OPEN` task BY HAND before
  Stripe's refund landed.** That row is already non-`OPEN` and carries the
  operator's own note and `completedByMemberId`, so it matches neither the
  `OPEN`-fenced close nor `automaticallyRefundedManualRefundTaskFilter`, and the
  automatic refund reaches no card. The writer deliberately does NOT write a
  second row — one `ManualRefundTask` per capture is the property every lookup on
  this path protects, and widening the card's filter to admit actor-bearing rows
  would reintroduce #2750's defect of presenting a hand dismissal as an automatic
  refund. It returns `alreadyRecorded: "hand-resolved"` and logs at **WARN** with
  the row's status, which is the only place that ordering is named.

  **KEEPING THIS CARVE-OUT IS #2774 D1 — the orchestrator's call, not the owner's,
  and the owner has not ruled** (authority line under `INV-ADDPAY-039`; reversible).
  Writing a second row was rejected here on the reasoning
  above: one `ManualRefundTask` per capture is the property every lookup here
  protects, and two rows for one capture would put the same money on the hand-back
  queue and the record card at once. It applies to a **`DISMISSED`** hand
  resolution — settled another way, no allocation written, nobody paid twice. The
  **`COMPLETED`** variant of the same ordering is a different matter entirely and is
  now `INV-ADDPAY-039`: it means the club has already paid the member back, and it
  is fenced.
- **The record write itself failing.** The caller must answer 200 — the money is
  already back with the member and a 500 replays the whole refund path for a
  bookkeeping row — so Stripe never redelivers and nothing else in the tree ever
  writes that row. A container log is not a record when the card claims
  completeness, so the caller writes
  `booking.payment.auto_refund_record_failed` (`severity: "critical"`,
  `outcome: "failure"`, `category: "payment"`, carrying the booking and the
  payment intent) beside the `refunded_after_cancellation` entry. **That audit row
  is the recovery surface**: it is the one place a finance operator can find an
  automatic refund the card does not hold. Removing it, or downgrading it to a log
  line, breaks this rule.

**The writer's obligations, none of them optional:**

- **Already `DISMISSED`, never `OPEN`.** An `OPEN` row is work an operator is asked
  to do, and there is none — Stripe returned the money before anybody saw the
  capture. Worse, completing such a task throws out of
  `applyLocalRefundAllocation` ("Refund amount exceeds captured payments"), so it
  would look unresolvable as well as being wrong. `COMPLETED` is equally forbidden
  and for the reason given below: it writes a second refund allocation for one
  refund. No allocation is written, no operator is queued, and the refund's amount
  and timing are untouched — this is a bookkeeping row for a decision #1350
  already made.
- **Idempotent on the payment intent, across both populations.** The key is
  `bookingId + paymentId + reason`, and every lookup matches BOTH population
  sentences (`automaticCancelledBookingRefundTaskReasons`). That is not
  belt-and-braces: a booking can be deleted BETWEEN two Stripe deliveries of one
  capture, so a per-population key would let the second delivery write a second row
  for a single refund. The confirm route's raise matches the same pair, so a
  webhook-written row of either kind stops it raising a duplicate `OPEN` task.
- **The deleted population's `reason` bytes are frozen.** `reason` IS the
  idempotency key, so rewording it would leave any `OPEN` task raised before a
  deploy unmatchable — the webhook would create a second DISMISSED row and leave
  the OPEN one in the hand-back queue asking an operator to hand back money Stripe
  had already returned. The merely-cancelled population therefore got its own NEW
  sentence (`cancelledBookingModificationRefundReason`) rather than the existing one
  being generalised, and each row stores the sentence that was true when it was
  written.
- **Under `pg_advisory_xact_lock(1)`, and that is a change from #2750.** The close
  alone was a single status-fenced `updateMany`, atomic on its own and holding no
  lock. Close-or-create is a find-then-write: two deliveries of one capture, or a
  delivery racing the raise, would each find no row and each write one. It takes
  the same canonical global key the raise takes — the cohort `booking-cancel.ts` is
  already in when IT creates a `ManualRefundTask` — and nothing else, holding it
  across an `updateMany`, a `findFirst` and at most one `create`. No provider call
  happens inside it; the refund that triggers it has already returned.
- **Budgeted `{ maxWait: 5_000, timeout: 10_000 }`, not left on Prisma's
  defaults, and NOT given the admin precedent either.** The advisory wait counts
  against the interactive-transaction budget, and the longest-lived holder of
  `lock(1)` in the tree — `assignBedRange`, up to 366 nights — runs on
  `{ maxWait: 10_000, timeout: 30_000 }`, so on the 2s/5s default an admin
  assigning a bed range concurrently with a Stripe delivery blows this
  transaction with a `P2028` and the row is lost for good (see the second
  exception above). Copying the 30s admin precedent into a webhook is the
  opposite error: Stripe's delivery timeout is the ceiling on a handler, so it
  would trade a lost row for a lost delivery. This is the `lock(1)` cohort's only
  webhook-triggered participant, and `docs/CONCURRENCY_AND_LOCKING.md` records it
  as such. Changing either number is a decision about which failure the club
  prefers, not a tuning detail.
- **Never flips an existing row.** A row in any non-`OPEN` state — written by this
  writer, dismissed by an operator, or `COMPLETED` because a human handed money
  back first — is left exactly as it is, not re-dated, re-noted or duplicated.

Five further obligations, on the surface:

**One notification for this event, and it already exists — do not build a
second.** `handleCancelledBookingAdditionalPaymentSucceeded` has always mailed the
club at the moment it happens, naming the member, the stay, the amount, the payment
intent, and the fact that the capture was auto-refunded and the supplementary Xero
invoice was not released; since #2773 the primary handler sends the same mail in
place of the generic muteable one it used to send. **"One" is per EVENT, and there
are three mutually exclusive kinds of it, never two at once:** the ordinary
auto-refund alert, the withheld-refund alert when `INV-ADDPAY-039`'s fence fires,
and the possible-double-payment alert when a hand-completion is found after the
refund. The shared epilogue picks exactly one and the fenced path returns before the
ordinary one can be reached. What was missing was somewhere to look afterwards, which
is what this rule adds. Anyone tempted to "add an alert" here should read
`INV-ADDPAY-038` first: that mail was rewritten by #2761 rather than joined by
another, because a second notification for one event is noise, and noise is how the
first one stops being read. No pending count anywhere reaches these rows either —
every one of them counts `status: "OPEN"`, and #2761's owner decision explicitly
left badges and the digest alone.

- **The finance queue on `/admin/payments` renders those rows** as a second,
  read-only card beneath the hand-back queue. It renders **even when no `OPEN`
  task exists**, which is the ordinary case for a healthy webhook and the exact
  case the pre-#2750 component could not display: that component returned `null`
  on an empty `OPEN` list. It is bounded by `completedAt` to
  `AUTOMATIC_REFUND_NOTICE_WINDOW_DAYS`, because an unbounded list of long-settled
  rows is the state that makes an operator stop reading a card; the row itself and
  the `booking.payment.refunded_after_cancellation` audit entry stay permanent.
  **The card says on screen what it covers** — every automatic refund of a late
  payment from the last thirty days, **with the one hand-resolved exception named in
  the copy** — and names the audit entry as the permanent record beyond that window.
  It must not claim more (it is bounded, and the hand-resolved ordering is real) and
  must not go back to claiming less (#2750's "this card does not catch every one" is
  false since #2760, and its booking-change scoping is false since #2773;
  reinstating either would tell an operator to distrust a list that is now
  complete). The exception is one clause, not a paragraph: a footnote an operator
  can read in passing keeps the claim true, while the old partial-list paragraph
  invited them to stop trusting the card altogether.
  **It groups the two populations**, deleted first: widening to every cancelled
  booking added rows for what is usually normal operation — cancel a booking
  somebody is part-way through paying for and this is the expected outcome — and in
  one flat list those would bury the case that needs a person, a refund on a
  booking the club DELETED where remaking it means charging the member again. Each
  group says which it is and what to do about it. No row carries a **View booking**
  link, unlike the hand-back queue beside it: a deleted booking's detail page 404s
  for anybody who is not a Full Admin, and a merely cancelled booking's page is
  gated on `bookings:view` while this card is gated on `finance:view` — which a
  Finance Viewer holds with no bookings access at all — so the link is a dead end
  for part of this card's audience either way. The identifiers are printed as text
  instead; **widening who may open a deleted booking to make a link work is not an
  acceptable fix** and would need its own owner decision.
- **Which rows those are is defined once**, in
  `automaticallyRefundedManualRefundTaskFilter`, and every reader uses that export
  rather than restating its conditions. It requires **both** the automatic close's
  note prefix **and** `completedByMemberId: null`, and neither condition may be
  dropped as redundant. `ManualRefundTask.completedBy` is
  `onDelete: SetNull`, so deleting the member who dismissed a task by hand NULLs
  the column that said who did it; on the null check alone, that operator's
  deliberate dismissal would then be presented as an automatic refund the club
  never made. On the note alone, a future writer of the same sentence *with* an
  acting member would be admitted.
- **The note prefix is stored data, not display copy.** Writer and reader share the
  constant, so they cannot drift from each other — but `startsWith` is evaluated
  against text already written to rows, so rewording the constant would keep every
  test that derives its expectation from it green while making every historical
  automatic refund invisible: #2750's own defect, arriving through the back door.
  One assertion in
  `src/lib/__tests__/deleted-booking-refund-visibility.test.ts` therefore pins the
  exact bytes as a golden string. Changing them needs a migration that rewrites the
  stored notes (or a reader that accepts the old prefix as well), in the same commit
  as the new string.
- **A failed read never reads as a clean slate.** The notices query is caught on its
  own so it cannot reject the batch carrying the OPEN hand-back queue — money the
  club still owes members must not leave the screen because an informational list
  timed out — and the route answers `autoRefundedUnavailable: true` beside the empty
  list. The surface prints a line saying it could not look, for that case and for a
  whole failed load, because an empty card asserts that no money was refunded
  automatically and a query that failed has not earned that.
- **The card carries no controls, and says what is still owed in work rather than
  in money.** There is no decision left — Stripe returned the money before anybody
  saw the capture — and a control would claim otherwise, while "Mark paid back" on
  such a row writes a second refund allocation for one refund. The copy states the
  one thing an operator may still have to do: if the **deletion** rather than the
  payment was the mistake, the booking has to be made again and the member charged
  again, because the refund has already gone out.

**The refund itself is deliberately NOT gated, and that is the decision this rule
records.** Suppressing #1350's automatic refund while the booking is soft-deleted
was considered and rejected: it leaves a member's money with the club until
somebody acts, and it puts a new condition on a Critical webhook money path. The
money returning to the member is the safe direction when nobody is watching, so
visibility was added instead of the refund being held. **Do not gate it as a side
effect of work in this area** — reversing this needs a fresh owner decision, a
test pinning that the capture is not auto-refunded and the task stays `OPEN`, and
its own review of the webhook path. Nothing here changes what money moves, when,
or by how much.

### INV-ADDPAY-038

**The alert for an automatically refunded late capture says what actually happened,
cannot be muted, and stays the only notification for the event** (#2761, owner
decision 10 Aug 2026, taken deliberately over the recommended badge option;
extended to both handlers by #2773 — an orchestrator decision the owner has not
ruled on; see the authority line under `INV-ADDPAY-039`). Same scope
as `INV-ADDPAY-037`
and for the same reason: **both** late-capture handlers send this mail since #2773,
and the muteable generic `sendAdminPaymentFailureAlert` the primary handler used to
send — switchable off per admin in Notification Recipients and club-wide in
Delivery Rules, for an automatic money movement — is gone from that path.

**IT NAMES WHICH PAYMENT, NOT ONLY WHICH POPULATION, AND THAT IS NOT COSMETIC.**
#2761's copy hard-coded "a booking-change payment" and "the supplementary Xero
invoice for the change was not released". Neither is true of a booking's own
payment: there is no supplementary invoice at all on that path, which credit-notes
the booking's own invoice when one exists. Reusing the mail unchanged would
therefore have been the very defect #2761 was filed about — a notice that
misdescribes the event — arriving through the back door. The capture-kind sentence
is composed once (`lateCaptureAutoRefundLeadParagraph`) and shared by the
hand-built HTML and the REQUIRED `{{lateCaptureLeadNote}}` token, so an admin's
saved default cannot describe a different capture, or a different Xero consequence,
from the mail.
`INV-ADDPAY-037` put the durable record on a screen; nothing pulled an operator to
that screen, and the one thing that fired at the moment it happened was weaker than
it looked. It went out as `sendAdminPaymentFailureAlert`: subject "Payment Failed",
gated on the per-member `adminPaymentFailure` preference, with a recipient set that
could be empty. Nothing failed on either path — a payment was captured after the
booking had gone and the money went straight back — so the subject misdescribed the
event, which is how it got triaged as noise. The primary handler kept sending
exactly that mail until #2773.

Four obligations:

- **Its own template and subject, naming the money movement and which population
  it was.** `admin-late-capture-auto-refund`, subject "Payment refunded
  automatically — booking already deleted: <member>" or "… — booking already
  cancelled: <member>". Both populations, because #2760 widened what fires it, and
  they need different follow-up: a deleted booking may have been deleted by
  mistake, in which case remaking it means charging the member again, while a
  merely cancelled one is normally the expected outcome and needs nothing. The
  distinguishing sentence is composed once
  (`lateCaptureAutoRefundOutcomeParagraph`) and shared by the hand-built HTML and
  the `{{refundOutcomeNote}}` token, so an admin's saved default cannot describe a
  different population from the mail. `{{bookingStateLabel}}` and
  `{{refundOutcomeNote}}` are both REQUIRED tokens: an override that drops either
  leaves an operator unable to tell the two cases apart.
- **Its own registry entry, not a variant of `admin-payment-failure`.** Sharing the
  key would let an admin's override of the routine payment-failure wording rewrite
  this notice, and would put both under one delivery switch. Same reasoning as
  `admin-booking-request-hold-cancelled` and `admin-split-settlement-cancelled`.
- **Delivery is not opt-in, on either mute vector.** The template is in
  `LOCKED_DELIVERY_TEMPLATE_NAMES`, so `/admin/notification-delivery-policies`
  refuses to change its mode; and it ships through `sendUnmuteableAdminAlert`,
  which reads no per-member notification preference and does not consult the
  club-wide policy row at all (the lock is enforced on write, not on read, so
  reading it would leave one more way to silence an automatic money movement — the
  fail-closed withhold alert in `email/core.ts` takes the same direct route). The
  permission matrix still decides the audience: whoever can EDIT finance. That is
  who the club made responsible, not a mute. **The recipient set cannot be
  silently empty:** no finance editors falls back to Support & System editors, and
  no admins at all falls back to the club's support address, with a warning logged
  whenever it falls past the first step and the existing undeliverable escalation
  recorded when not one recipient received it.

  **The last rung must resolve the club's OWN address, not the bootstrap
  literal.** It reads `EmailMessageSetting.supportEmail` through
  `loadEmailMessageSettings` — the same DB-first resolution every other outbound
  mail uses, so it is whatever an admin typed into `/admin/email-messages`, and
  `config/club.json`'s address when nothing is stored. It is deliberately **not**
  `CLUB_SUPPORT_EMAIL`: that constant is `SAFE_DEFAULT_CONFIG.supportEmail`, the
  frozen unconfigured-club literal `support@example.org`, which SES accepts and
  bounces asynchronously — `sendEmail` would report `sent`, the undeliverable
  escalation would never fire, the `EmailLog` row would say SENT, and the alert
  would vanish in exactly the state the fallback exists for (while feeding hard
  bounces into the club's sender reputation). A recipient that cannot receive mail
  is a silently empty recipient set with an extra step. The literal survives only
  as the guard against a blank setting and a settings read that throws.

  **A declared widening, not an accident:** step 2 resolves `support: edit`, a
  different area from the one that owns the alert. For the built-in roles that is
  the Full Admins, but the state this fallback exists for is a club with a custom
  role set and no finance editor — and there a tech-support editor with no finance
  access receives a body carrying the member's name, stay dates, refunded amount,
  booking id and Stripe payment-intent id. That is accepted deliberately: reaching
  somebody in a degraded state beats reaching nobody, the step is logged, and the
  club chose the role set. It is recorded here and in
  `docs/guides/notification-recipients.md` so it is a decision on the record rather
  than a surprise. Narrowing the fallback body instead — naming no member and no
  amount — stays available if a club objects.
- **Still exactly one notification, and no badge or digest changed.** This replaced
  the previous mail on both paths; it did not join it. `AdminPendingCounts` and the
  count fixtures are untouched by design, and the digest keeps its explicit template
  allowlist — so these events no longer land in its "Payment Failures" count,
  which is a correction rather than a loss: nothing failed. The webhook still sends
  it fire-and-forget with a `.catch` that only logs, because webhooks stay
  non-blocking and the durable record is the row plus the audit entry. **The
  `INV-ADDPAY-039` alert REPLACES this one when it fires** — the epilogue sends
  exactly one of the two — so "one notification" holds across all three outcomes.

### INV-ADDPAY-039

**A late capture an operator has already paid back by hand is never refunded a
second time.** Before refunding, the handler looks for a `ManualRefundTask` for this
`bookingId + paymentId` and this payment intent's `reason` set whose status is
`COMPLETED`. If one exists the refund is **withheld**, a `critical` audit row is
written and the club is told the money did **not** go out, so a person reconciles it
(#2774 D2).

> **WHO DECIDED THIS — THE ORCHESTRATOR, NOT THE OWNER. This is the authority line
> every #2773 / #2774 citation in the tree points at, and it is stated at this
> length once because an invariant is the permanent record and a future agent will
> cite it as authority.**
>
> Every direction attributed to **#2773** or **#2774** anywhere in this repository —
> this rule, `INV-ADDPAY-037`'s lifted scoping clause and its `DISMISSED` carve-out
> (#2774 D1), and `INV-ADDPAY-038`'s extension to both handlers — was chosen by the
> **orchestrator**, taking each issue's own **Recommended** option under the owner's
> standing instruction to work the backlog down. **The owner has not ruled on #2773
> or #2774.** At the time of writing both issues still carry `needs-decision`, no
> option is ticked, and neither thread records an answer.
>
> **So cite it as an orchestrator decision. Attributing #2773 or #2774 to the owner
> is false**, and that is not a hypothetical: the first version of this branch
> attributed both to the owner, with a date, in eighteen places — including this
> file, this invariant's own rule text, and a comment beside operator-facing copy.
> Two review lenses caught it and the owner held the branch (see the comment threads
> on #2773 and #2774, and #2713). Nothing in the repository can tell an owner's
> decision from an agent's, because every agent drives `gh` as the owner's account —
> so the only defence is that an attribution is written accurately in the first
> place.
>
> **The neighbouring #2760 and #2761 citations, dated 10 Aug 2026, are by contrast
> real** — each of those threads carries the owner's own "ready to action" comment.
> Check the thread before you repeat any citation of this kind: deleting a true one
> is as damaging as inventing a false one, and one sat next to the other here.
>
> **It is reversible, and the reversal is small in each part.** #2774 D2 (this rule)
> is one read — `findCompletedHandBackForLateCapture`; drop the call and the refund
> goes out as it did before, with nothing to migrate, because the fence writes no
> state of its own beyond an audit row and an alert. #2774 D1 (the carve-out) is the
> `DISMISSED` branch of `recordAutomaticCancelledBookingRefundTask`, whose
> alternative — write a second row — is still open. #2773 is the `captureKind`
> argument threaded from the primary handler; the `reason` sentences it selects are
> frozen either way (they are the idempotency key), so a reversal stops writing the
> primary sentences rather than editing them.
>
> **#2774 D2 is the one to put to the owner first.** #2774 says in its own words
> that it changes a Critical money path and needs its own review, and it offers
> "Leave it" as an option. The fence ships ahead of that answer because refunding a
> member twice is the worse failure while the question is open — not because the
> question is closed.

**THE MONEY BUG THIS CLOSES.** `resolveManualRefundTask` writes
`applyLocalRefundAllocation` on — and only on — the `COMPLETED` resolution. That
allocation is the ledger saying the money went back. So a `COMPLETED` row for a
capture means the club has already paid the member, in cash or by bank transfer,
out of its own funds; Stripe's refund on top of it is a **second payment for one
capture**. The task can sit `OPEN` for hours or days while the webhook is delayed or
disabled, and resolving it by hand is exactly what it is for — so this was not a
narrow race. It is pre-existing: #2760 did not introduce it and deliberately did
not change it.

**IT IS NOT THE GATING THIS FILE RULES OUT, and the difference is the whole
justification.** `INV-ADDPAY-037` forbids suppressing #1350's automatic refund as a
side effect of work in this area, because that would leave the club holding a
member's money until somebody acted. This withholds a **second copy** of a refund
the member has already had. Nothing the member is owed is held back, and the amount,
the timing and the decision of every refund that still happens are untouched.

**`COMPLETED` AND NOTHING ELSE MAY BLOCK.** A `DISMISSED` row means "settled another
way" and writes NO allocation, so fencing on it would leave the club holding a
member's captured funds while the audit log claimed the matter was closed — the
symmetrical money bug, and the one a "simplify this to any non-OPEN row" change
would introduce. An `OPEN` row is the confirm route's unanswered question and the
refund is the answer.

**KEYED ON THIS CAPTURE, NOT ON THE BOOKING AND PAYMENT ALONE.**
`booking-cancel.ts` raises its own `ManualRefundTask` on the same booking and
payment when a CASH-settled booking is cancelled, for the cancellation policy's
share of the ORIGINAL payment — a different sum about different money. The fence
matches only rows carrying one of this payment intent's four `reason` sentences, so
completing that task cannot refuse a member's late capture.

**A FENCE THAT CANNOT ANSWER GIVES NEITHER ANSWER, and this is the deliberate
choice between two bad failures.** Refunding anyway can pay a member twice;
refusing anyway can leave the club holding their money for good, because a webhook
that answers 200 is never redelivered. So the read is **not** wrapped in a catch:
the rejection propagates, the handler's outer catch answers 500, the
processed-event marker is cleared, and Stripe redelivers with backoff against the
same idempotent refund keys — so a redelivery that reaches a working database
refunds exactly once. The fence therefore sits BEFORE the refund and AFTER the
capture is recorded: before, because afterwards no check can help; after, because
withholding the refund must not also lose the record that Stripe holds the money.

**WHAT THE FENCE DOES NOT CLOSE, STATED RATHER THAN IMPLIED.** A hand-completion
that commits after the fence read but during the Stripe refund is not caught by it.
`resolveManualRefundTask` takes no advisory lock, and closing the window would mean
holding `pg_advisory_xact_lock(1)` across a provider round trip, which
`docs/CONCURRENCY_AND_LOCKING.md` forbids outright. What the fence does is shrink
the exposure from "any time in the hours or days the task sits `OPEN`" to "the
duration of one Stripe refund call". **The residue is DETECTED rather than left
silent:** the record writer re-reads the row under the lock and returns
`existingStatus: COMPLETED`, and the caller escalates that to a `critical`
`booking.payment.late_capture_double_refund_suspected` audit row and an alert saying
the member may have been paid twice.

**THE AUDIT ROW AND THE ALERT MUST BOTH SAY WHICH WAY THE MONEY WENT.**

- The fenced path writes `booking.payment.late_capture_refund_withheld`
  (`severity: "critical"`, `outcome: "blocked"` — a guard refused an action, nothing
  failed), carrying the capture's amount, the hand-back task's id and amount, who
  completed it and when, and `refundSent: false` **spelled out in the row**. It must
  NOT write `booking.payment.refunded_after_cancellation`: that action is the club's
  permanent record of an automatic refund, named as such by the finance card and
  `docs/guides/payments.md`, and writing it would put a money movement that did not
  happen into the permanent record.
- The detected path writes
  `booking.payment.late_capture_double_refund_suspected` with `refundSent: true`.
- The alert is `admin-late-capture-hand-back-conflict`, its own registry entry and
  its own template with two subjects — "Automatic refund withheld — already paid
  back by hand" and "Payment may have been refunded TWICE — reconcile". It is NOT a
  flag on `admin-late-capture-auto-refund`: that template's heading and body assert
  the money went back and there is nothing to pay back, which is false on the
  withheld arm and the opposite of the truth on the other, and one editable body
  cannot be correct about a refund that happened AND one that did not. Delivery-
  locked and unmuteable on the same grounds as `INV-ADDPAY-038`, and more so.
- **The direction survives an admin rewriting the subject, in both directions of
  editing.** A stored subject override REPLACES the sender's computed subject whole, so
  the direction rides in the subject as the `{{handBackConflictLabel}}` token and the
  saved copy is refused if it **drops** that token (`REQUIRED_SUBJECT_TEMPLATE_TOKENS`)
  **or if it states a direction beside it in its own words**
  (`FORBIDDEN_SUBJECT_PHRASES`, derived from the sender's own two labels so the two
  cannot drift). Both halves are needed and neither implies the other: a subject that
  keeps the token and prepends "Automatic refund withheld" renders the wrong claim in
  the leading words an inbox truncates to, which is the part an operator triages on. A
  free-text subject cannot be made paraphrase-proof, and is not claimed to be — the
  guarantee that holds whatever the admin writes is the BODY, which states the
  direction in its heading, its alert box, its required `{{handBackConflictNote}}`
  paragraph and an explicit "Automatic refund sent: Yes / No" row.

**NO ROW IS WRITTEN AND NO PARTIAL TOP-UP IS REFUNDED on the fenced path.** The
operator's `COMPLETED` row already IS the record of that capture, and a second row
for one capture is the property every lookup here protects. The hand-back's amount
is carried into the audit row and the mail so a person can see whether it covered
the whole capture, but nothing computes or sends a difference: that is a new money
decision and would need its own owner decision.
