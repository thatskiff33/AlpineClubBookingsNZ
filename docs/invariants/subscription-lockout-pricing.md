# Subscription-Lockout Booking Pricing

Audience: Developer, Agent.

Prefix defined in this file: **`INV-LOCKOUT`** — lapsed-subscription pricing
and the three-way lockout mode, admin date overrides and retroactive
creates, and the per-booking withholding of member-facing email.

Read this file when you are changing how an unpaid subscription is priced or
refused, the `MembershipLockoutSettings.mode` gates, an admin date override or
on-behalf create, or anything that decides whether a member is emailed about a
booking.

Index: [`docs/DOMAIN_INVARIANTS.md`](../DOMAIN_INVARIANTS.md) — every `INV-*` ID
with a one-line description of what it covers. ID scheme and allocation rules:
[`SCHEME.md`](SCHEME.md).

Every heading below whose whole text is an `INV-*` ID defines that invariant. IDs
are permanent: never renumbered, never reused. **The text under each ID is a
verbatim move from the source document and must not be reworded in place** —
only the ID heading lines and the bracketed cross-file `[INV-*]` pointers
registered in the PR were added.

## Subscription-lockout pricing (#2533), admin date overrides and member-facing email

### INV-LOCKOUT-001

**Owner decision (2 Aug 2026), extending the #2364 lapsed-member framing.** The
same idea #2364 applies to a lapsed member — "not a member in good standing is,
for this rule, a non-member" — is extended to the money axis for an unpaid
subscription:

> A subscription-locked member can still book for others in their family, but if
> that individual's subscription is not paid they get charged **non-member
> rates** (and are **told why**), and there still has to be **at least one
> paid-up adult member on the booking**.

### INV-LOCKOUT-002

**Three rules, one predicate reused.** The pure evaluator lives in
`policies/subscription-lockout-pricing.ts` and mirrors the hosting evaluator's
shape (facts in, decisions and member-facing sentences out, no I/O):

- **Unpaid member → non-member rate.** A member (`isMember`) for whom the
  booking-time gate says a subscription is *required* this season
  (`requiresPaidSubscriptionForMemberForBooking`, which already folds in the
  Xero-off bypass, membership-type opt-outs and the per-age-tier rule) and whose
  subscription is *not* PAID prices at the built-in NON_MEMBER rate. This is the
  existing `rateSource: "TYPE_POLICY_FORCED"` resolution
  (`resolveGuestRateMembershipTypes`), so it routes the correct non-member Xero
  item code with no new pricing or invoicing path — the same route a
  `NON_MEMBER_RATE` membership type already takes.
- **At least one paid-up adult member present.** A qualifying participant is a
  #2364 host (active, uncancelled, unarchived, ADULT, operationally present) whose
  subscription is ALSO settled (PAID, or not required for them).
  `participantQualifiesAsHost` is reused verbatim and the subscription fact ANDed
  on top, so the standing half can never drift from the hosting rule — a lapsed
  adult with a paid subscription fails on standing, a paid-up-membership adult
  with an unpaid *subscription* fails on money, and only somebody clear on both
  counts satisfies the requirement. An empty party fails.
- **Told why.** Two member-facing sentences name neither a person nor an amount:
  the rate reason states that member rates are unavailable while the subscription
  is unpaid and how to restore them; the refusal names the two escape routes
  (renew, or add a paid-up adult). The rate reason is surfaced today, read-only,
  on `GET /api/member/subscription-status` (`memberRateNotice`), worded to be true
  under BOTH the current hard-block lockout and the decided non-member-rate
  direction so it never over-promises a booking.

### INV-LOCKOUT-003

**Enforcement is wired, behind one club setting (#2543).**
`MembershipLockoutSettings.mode` (`SubscriptionLockoutMode`) picks between three
mutually exclusive answers, and it is the ONLY thing that can move a club's money
here:

- **`NO_BLOCK`** — no subscription gate at all; unpaid members book at member
  rates.
- **`HARD_BLOCK`** — the historical behaviour: 403 `SUBSCRIPTION_REQUIRED` /
  `GUEST_SUBSCRIPTION_REQUIRED` on the create, confirm-draft, modify-quote,
  guest-add and group-join paths. **The effective default**, so no club moved.
- **`NON_MEMBER_PRICING`** — the rule above: the unpaid member is repriced, told
  why, and the booking must carry a paid-up adult member.

### INV-LOCKOUT-004

**Independent booking failures are reported together.** A member create or member
group-join can fail both the paid-up-adult rule and enforced adult-member hosting on
the same party. Those paths evaluate both before returning and answer with
`BOOKING_POLICY_REQUIREMENTS_NOT_MET`, both allowlisted `reasonCodes`, and one
aggregated `exceptionReview`; they do not stop at whichever evaluator happened to
run first. The hosting half passes through `buildAdultMemberHostingRefusalBody`
before aggregation, so its internal qualifying-host member ids never enter a
member-facing combined response. A single failure keeps its existing response code
and shape.

### INV-LOCKOUT-005

**Nothing moved on the release that shipped this, and `mode` is the ONLY record of
the policy.** Owner directive on #2561: the change completes in one release rather
than keeping dual-read/dual-write compatibility alive for a later contract release.
Two migrations, one deploy:

- `20260803000000_subscription_lockout_three_way_mode` (expand) adds the enum and a
  nullable `mode`;
- `20260803010000_contract_subscription_lockout_drop_enabled` (contract) BACKFILLS
  `mode` from the legacy boolean (`true → HARD_BLOCK`, `false → NO_BLOCK`), makes it
  `NOT NULL DEFAULT HARD_BLOCK`, and DROPS `enabled`.

### INV-LOCKOUT-006

So a club that had deliberately switched the lockout off stays off, and one that had
it on keeps hard-blocking — but that mapping now lives in the migration rather than
in a read-time fallback. `normalizeMembershipLockoutSettings` has no legacy branch:
a recognised `mode` wins, and the only null left is "no settings row exists at all",
which resolves to the same `HARD_BLOCK` the column defaults to. The backfill's
correctness is pinned against real rows by
`prisma/migration-verification/20260803010000_contract_subscription_lockout_drop_enabled.ts`,
whose mutants include the two that would move a club's money: an inverted mapping,
and an unconditional `HARD_BLOCK` that would silently re-enable the lockout for every
club that had turned it off.

### INV-LOCKOUT-007

**That drop needs a maintenance window, and the ledger says so.** The contract row is
the repo's first `old_code_compatible=windowed` declaration: the previous release's
Prisma client names `enabled` on every read of this model, and the booking gates
resolve the policy through that read, so the old colour cannot take a booking between
migrate and cutover. Verified rather than assumed — a client generated from the
previous schema fails with `The column MembershipLockoutSettings.enabled does not
exist in the current database`, and recovers after the `rollback.sql` that ships
beside the migration (`NO_BLOCK → false`, `HARD_BLOCK` and `NON_MEMBER_PRICING →
true`, plus `mode` back to nullable-without-default). Deploy sequence in
`DEPLOYMENT.md` → "Windowed migrations"; rehearsal transcript in
`docs/PRODUCTION_UPGRADE_RUNBOOK.md` §7.1.

### INV-LOCKOUT-008

**Bundle-format compatibility outlives the column.** A configuration bundle exported
before #2543 carries `enabled` and no `mode`, and those files are still on operators'
disks. `enabled` is no longer an exported field, so config-transfer's `reconcile`
hook maps the bundle KEY to the mode it means on the way in. Without it the key would
be an unknown field, silently dropped, and a club importing a pre-#2543 bundle to
turn the lockout off would be told it worked while every unpaid member went on being
refused. The reverse derivation is gone with the column: there is no boolean left to
write back.

### INV-LOCKOUT-009

**The mode is resolved once per request and passed down - to the money as well as
to the gates.** Every consumer reads it through `member-subscription-eligibility.ts`:
`resolveSubscriptionLockoutMode()` outside transactions (it reseeds the
financial-year cache, which can reach Xero), and `peekSubscriptionLockoutMode()` as
the FALLBACK for a caller that holds none. Each write path resolves the mode once and
hands it to `evaluateNonMemberPricingRequirements` **and** to
`resolveGuestRateMembershipTypes` / `priceBookingGuestsWithMembershipTypePolicy`
(`subscriptionLockoutMode`); `prepareGuestPlan`, `calculateModifiedPricing`, the
waitlist sweep and `removeBookingGuestInTransaction` take it as a value their
in-transaction code cannot reach for the database to obtain. Two reasons, both
correctness rather than speed:

- **Consistency.** An independent read per pricing call let an admin's mid-request
  save have the route gate branch on one regime and the price be computed under the
  other - the "priced as a member here, refused there" drift #2543 exists to remove.
  `modify-quote` performs seven or more pricing passes in one request and differences
  two of them into the member's settlement delta, so a save landing between those two
  made the delta wrong by the whole member/non-member spread on every remaining guest.
- **Connections.** The pricing gate runs inside booking transactions that hold the
  per-lodge capacity lock. Reading the two (uncached) settings rows through the module
  client there checks out a SECOND pool connection underneath the lock, which
  `docs/CONCURRENCY_AND_LOCKING.md` names as the pool-starvation shape and forbids
  twice by name for `validateMinimumStay` and `loadAdultMemberHostingPolicy`. Being
  handed the mode removes that read entirely, in every mode, for every club.

### INV-LOCKOUT-010

**A failed mode read fails the request; it never quietly charges member rates.** The
reprice resolver does not swallow errors from the mode read - an empty reprice set
means "member rates", so a transient pool timeout would have undercharged an unpaid
member permanently and invisibly (the rate is snapshotted per guest row) on a booking
the route gate had already waved through. One leniency remains, and it is inherited
rather than introduced: `loadEffectiveModuleFlags` swallows its own database errors and
returns every module DISABLED (logging at error level), which resolves to `NO_BLOCK`.
`main` has the identical outcome through `isSubscriptionEnforcementActive` - a failed
flags read there skips the hard block and the unpaid member books at member rates just
the same - so #2543 neither widens nor narrows it.

### INV-LOCKOUT-011

**The financial-year reseed is gated on the Xero module, not on the mode.** A club that
has deliberately switched the lockout off resolves `NO_BLOCK` — from the `mode` the
contract migration backfilled out of its old boolean — with Xero still on, and every
request-path reseeder in the tree routes through
`resolveSubscriptionLockoutMode` (the booking write paths, `findUnpaidMemberGuests`, the
member notice builder). Gating the reseed on `mode !== "NO_BLOCK"` therefore left such a
club with no request-path reseed at all: after a container restart the shared season
derivation and `computeAgeTier` would resolve against the March default instead of the
club's real year-end month, and the rate resolved for a booking can differ from the correct one. The
reseed runs before the mode is consulted, restoring the pre-#2543 condition.

### INV-LOCKOUT-012

**Only the refusals are mode-gated, never the lookups.** `findUnpaidMemberGuests`
/ `findUnpaidMemberGuestNames` still run under `NON_MEMBER_PRICING`: they are what
raise the D-8 neutral refusal for an unpaid member guest from beyond the booker's
family, and that privacy boundary is not the lockout policy's to relax.

### INV-LOCKOUT-013

**There are SIX mode-gated refusal sites, not five.** The five route-level gates
(create, confirm-draft, modify-quote, guest-add, group-join) plus `prepareGuestPlan` in
`booking-modify-plan.ts` - the APPLY half of the edit flow whose preview is
`modify-quote`, reached from `modifyBookingBatch` and therefore from
`POST/PUT /api/bookings/[id]/modify`. Ungated, it hard-blocked an unpaid member guest in
every regime, so a member was quoted the non-member price with an explanation and then
refused on save with the pre-#2543 403: an edit that could never complete.

### INV-LOCKOUT-069

**The PAYMENT path carries no subscription gate, and that is the design, not a
gap (#2779, owner decision 11 Aug 2026).** Nothing under
`src/app/api/payments/` or `src/app/api/webhooks/`, **and nothing in the modules
those routes delegate settlement to**, may consult
`resolveSubscriptionLockoutMode` or
`requiresPaidSubscriptionForMemberForBooking` to refuse the booking's OWNER.
The settlement modules are named because the routes are thin: the Stripe webhook
route is signature verification that hands off to `stripe-webhook-service.ts`,
and the pay route hands its PAID claim to `payment-reconciliation.ts` /
`booking-credit-election.ts`. A gate one layer down strands the same member as a
gate in the route, so the census covers `stripe-webhook-service.ts`,
`payment-reconciliation.ts`, `booking-credit-election.ts`,
`booking-payment-flow.ts`, `payment-transactions.ts` and `payment-link.ts` by
name. It does NOT cover the transitive import closure of those routes, which
reaches pricing and booking-policy modules where the gate legitimately belongs.
Together with the `!isAuthorizedOnBehalf` term on the create gate
(`INV-LOCKOUT-003`), that is what makes one journey possible: an admin books on
behalf of a member whose subscription is unpaid, and the member — still locked
out — signs in, opens the booking and pays for it. Closing this "hole" would
close that journey, and would also mean refusing a member who is trying to give
the club money over a different debt entirely.

Two consequences follow and are load-bearing:

- **`confirm-draft`'s subscription refusal only ever bites a ZERO-price draft.**
  The route returns 400 "Use the payment flow to complete non-zero bookings"
  before it reaches the gate, so a priced draft is confirmed by paying for it,
  never by that route. The refusal is therefore narrower than it looks, and
  reading it as the general rule is what made this look like an enforcement gap
  in the first place.
- **`HARD_BLOCK` is not weakened anywhere.** The same member's own
  `POST /api/bookings` is still refused 403 `SUBSCRIPTION_REQUIRED`, and their
  own zero-price `confirm-draft` is still refused 403. Only what an admin
  already created for them is payable.

Enforced structurally by `src/lib/__tests__/subscription-lockout-call-sites.test.ts`,
which fails if any non-test file under those two trees — or any of the named
settlement modules — starts naming a lockout identifier, and names this ID in the
failure message. The same census asserts each named module still exists, so a
rename cannot quietly empty it.

### INV-LOCKOUT-070

**The pick-up-and-pay journey has exactly two edges that are NOT payment gates,
and both must be stated wherever the journey is offered (#2779).**

- **72 hours.** `createDraftBooking` sets `draftExpiresAt` to 72 hours out, and
  the nightly `draft-cleanup` job DELETES an expired DRAFT outright rather than
  cancelling it — so a member who takes a week finds no booking at all, not a
  lapsed one. The admin booking page states the window where the officer chooses
  "Save as Draft"; the member sees the deadline on the dashboard card and on the
  booking page that takes the money.
- **A $0 on-behalf draft has no pick-up-and-pay step, so the ADMIN confirms it.**
  There is nothing to pay: the booking page gates the payment card on
  `finalPriceCents > 0`, so the member is offered `ConfirmDraftButton` instead,
  and `confirm-draft` refuses a locked-out non-admin. The admin confirms that one
  — either straight from the admin booking page instead of saving it, or with the
  confirm control on the booking, which takes the route's `isAdmin` bypass.

  **This is the absence of a CONTROL, not the presence of a gate, and the
  distinction is load-bearing.** `POST /api/payments/create-payment-intent`
  admits a `DRAFT` with no price check, and its transaction decides the zero case
  inside itself: `settledEffectivePriceCents <= 0` calls
  `settleFullyCreditCoveredBooking`, which claims `PAYMENT_PENDING -> PAID`
  (`src/lib/booking-credit-election.ts`). So a member who calls that route
  directly with their own booking id — no UI offers it — does settle a $0 draft,
  locked out or not. That follows from `INV-LOCKOUT-069`, which forbids a
  subscription gate anywhere on that route, and it is ACCEPTED rather than
  absent: no money moves, and the same owner decision that keeps the priced door
  open keeps this one open. Do not "close" it by adding a gate — that would
  violate `INV-LOCKOUT-069`. Anyone who wants it closed needs a new owner
  decision, because the owner's stated rationale (refusing a member trying to give
  the club money) does not by itself reach a branch where no money changes hands.
  That question is filed as #2792 and is open; until it is answered, the branch
  stays as it is.

The member-facing surfaces are copy only: no gate, price, capacity or settlement
behaviour is decided here. Where they say a free booking is confirmed by the club,
they are describing the controls the member is offered, which is what a member can
act on — not asserting that the pay route would refuse one.

### INV-LOCKOUT-014

**The paid-up-adult requirement is evaluated on REMOVALS too, not only on additive
writes.** Otherwise any party reached the forbidden state in two requests: book with a
paid-up adult member (allowed - the unpaid member repriced on the strength of their
presence), then remove that adult, with nothing to re-evaluate and no review raised. It
is now evaluated over the whole PROPOSED party on the apply path (`prepareGuestPlan`,
which covers adds, removals and date changes in one place) and over what is LEFT on
`DELETE .../guests/[guestId]`. A **consent DECLINE or EXPIRY is exempt** and always
allowed through: D-14 requires that a member who has declined can be taken off, and
refusing it would trap them on a booking they have refused. An ADMIN is skipped as on
every other #2543 gate. What stays gated is the case the rule is about - the booking
owner, or a member self-removing, choosing to take the party's last paid-up adult member
off it.

### INV-LOCKOUT-015

**The waitlist is the sixth money path and now carries both halves.** The offer sweep
prices through the same gate, so it inherits the reprice, and it passes NO locked night
prices - the whole stay re-bases at current rates and the result is WRITTEN to the
stored booking. Both safeguards now reach it: the offer email states the repriced figure
**and** the reason for it (`subscriptionMemberRateNotice`, rendered from the shared
sentence), and `confirmWaitlistOffer` re-checks the paid-up-adult requirement before the
claiming transaction - outside it, like the minimum-stay check beside it - failing closed
WITHOUT consuming the offer, so the member keeps their place and can fix the party or ask
a Booking Officer instead of the offer being burnt. That refusal answers 409 with the
shared refusal body, not a bare message.

### INV-LOCKOUT-016

**D-12 is applied on every path, and from the real column.** A member guest whose invite
is still PENDING is not operationally present and therefore cannot be the party's paid-up
adult - otherwise the requirement is trivially satisfiable, since the invite need never be
accepted, and the D-4 sweep later removes the row, leaving a confirmed booking with no
paid-up adult member on it. The Prisma column is `BookingGuest.consentStatus`;
`toSubscriptionLockoutParticipants` reads that for a persisted row and the planned
`memberGuestConsent.consentStatus` for a pre-persist one, so the create path (whose
`guestInputs` already carry the PENDING columns `planMemberGuestConsentWrites` is about to
write) and the guest-add path share one mapping instead of each inventing their own. The
two PREVIEW surfaces hold no consent row, so they derive the same answer from the three
facts the writer would use - a cross-family member guest lands PENDING exactly when the
module is on, the club requires approval, and the actor is a member rather than an admin
acting for them - which is what stops a quote staying silent about a party the save then
refuses. The exception-request re-evaluation takes an explicit `operationallyPresent` per
proposed guest for the same reason: without it a member refused on a booking path could
not reproduce the violation, the request machinery would find nothing to review, and the
409's promised override path would lead nowhere.

### INV-LOCKOUT-017

**Xero narrates the rate, not the membership flag.** The hut-fee line's
`(TIER, Member|Non-member)` label is derived from `BookingGuest.rateMembershipTypeId`
(`describeGuestRateMembershipLabel`), the same field `resolveHutFeeItemCode` keys on, so
the words on the line agree with the item code the line is coded to. A repriced member
therefore reads as an ordinary non-member line (owner decision, 2 Aug 2026), instead of
"(ADULT, Member)" at the non-member amount inside the non-member item - a contradiction
both the treasurer reconciling member against non-member hut-fee income and the member
receiving the invoice could see. `BookingGuest.isMember` is deliberately NOT moved by the
reprice; it stays load-bearing elsewhere. Known and accepted consequence: the
pre-existing `TYPE_POLICY_FORCED` class flips to ", Non-member" too, because no persisted
marker distinguishes the two reasons for pricing on `NON_MEMBER` rows - and the new
wording is the honest one for that class as well, whose line has always been coded to the
non-member item at the non-member amount. Narration only: no amount, item code, account
code or idempotency key changes, and a guest with a NULL snapshot still falls back to
`isMember`.

### INV-LOCKOUT-018

**The reprice happens at the single pricing gate**, not at the five write paths.
`resolveGuestRateMembershipTypes` is the one function all ~25 booking-pricing call
sites already pass through, so "consistent across every write path" is a
structural property rather than a review checklist.

### INV-LOCKOUT-019

**The paid-up-adult requirement has two triggers, and is still not
unconditional** (second trigger: owner decision, 3 Aug 2026). It applies when

- somebody STAYING on the party is being repriced for an unpaid subscription, or
- the **booking owner** is an unfinancial member — whether or not they stay.

### INV-LOCKOUT-020

Both are judged by the one owing test (`resolveMemberSubscriptionSettlement`, via
the single settlement batch in `evaluateNonMemberPricingRequirements`), so the
owner cannot be judged by a different rule than the party. The owner joins the
FACTS batch only, never `repricedMemberIds`: an owner who is not staying holds no
nights, so counting them as repriced would inflate the violation's count and emit
a rate notice about a charge nobody received.

### INV-LOCKOUT-021

**Why the second trigger.** `HARD_BLOCK` refuses an unfinancial member *as a
person* — they cannot book at all, even for a party of non-members they will not
join. Keyed only on who stays, `NON_MEMBER_PRICING` let exactly that booking
through with no reprice, no requirement and no notice, so switching a club to the
softer rule quietly opened the one case the strict rule most reliably closed, and
lapsing cost a member nothing so long as they booked for others. In that case the
new trigger is still **gentler than `HARD_BLOCK`, not stricter**: a flat 403
becomes a 409 with an override door and the beds held. An unfinancial owner can
never satisfy their own requirement (they fail the money half of
`participantIsPaidUpAdultMember`), and a paid-up adult member in the party
satisfies it exactly as before — which is what keeps the intended family case
booking.

### INV-LOCKOUT-022

**Still not unconditional, and that scoping remains load-bearing.** Applied to
every booking in the mode, the requirement would newly refuse bookings that are
legal today and have nothing to do with subscriptions: a paid-up Youth member
booking their own bed, a family whose only member row is a child, an
all-non-member party booked by a financial member. None is touched by either
trigger. "Is a responsible adult member present?" in the general case is
`ADULT_MEMBER_HOSTING_REQUIRED`'s question (#2364), configured per lodge; the two
compose, and a party can trip both.

### INV-LOCKOUT-023

**`memberRateNotice` follows the reprice, not the requirement**, now that the two
are different questions. An unfinancial owner who is not staying triggers the
requirement with nobody repriced, and the notice claims member rates "aren't
available for those nights" — a statement about a price nobody was charged. That
party gets the refusal (or the quote's early warning) and no rate notice.

### INV-LOCKOUT-024

**The cross-lodge promotion is the seventh money path, and reached none of the
rule.** `confirmCrossLodgeWaitlistOffer` calls `createConfirmedBooking` DIRECTLY,
so the create route's gate never ran, while the offer sweep had already re-based
the entry's stored price at current rates and inherited the reprice — a party the
create route would have refused could be promoted here and charged non-member
rates instead. Fixed as Phase 0b, with the same semantics as its same-lodge twin:
the mode and the party are read before Phase 1 opens the transaction that holds the
offered lodge's capacity lock; the requirement is judged against the OFFERED lodge,
since that is where the booking will exist; a violation fails closed WITHOUT
consuming the offer (the entry reverts to `WAITLISTED` so the member keeps their
place) and answers with the shared refusal body, which the waitlist-confirm route
already maps to a 409 with no cross-lodge special case. The rate notice rides the
success result too, because a cross-lodge quote can differ from the member's own
lodge by the whole member/non-member spread.

### INV-LOCKOUT-025

**The two waitlist paths refuse with one shared sentence the booking paths do not
use.** `formatMissingPaidUpAdultWaitlistRefusal` appends "You've kept your place on
the waitlist." to the shared refusal, and both waitlist paths call it so their
answer cannot depend on which lodge the sweep offered. It is scoped to them because
they reject the offer WITHOUT consuming it — neither revert touches
`waitlistPosition`, so the claim is literally true — while a booking-time refusal
has no waitlist place to claim. The frozen violation's own `message` is deliberately
unchanged: it is hashed into exception snapshots and read by the reviewing officer,
so `details`/`violations`/`exceptionReview` keep the policy's wording while `error`
carries the member's. The waitlist-confirm route therefore places
`error: result.error` AFTER the shared-body spread — the body carries its own
`error`, and spreading it last silently discarded the waitlist sentence.

### INV-LOCKOUT-026

**Every write path passes the owner**, because the requirement is a property of a
set of call sites rather than of behaviour: a path that forgets it silently
enforces the old repriced-only rule while every other path's tests stay green.
`subscription-lockout-call-sites.test.ts` counts the owner argument against the
evaluation calls, file by file. The exception-request re-evaluation resolves the
owner **server-side** — a modification reads the live booking's own `memberId`
rather than trusting the requester to be it — so a refusal that keys on the booker
reproduces there and the 409's door actually opens.

### INV-LOCKOUT-027

**The refusal is a door, not a wall.** A missing paid-up adult raises
`PAID_UP_ADULT_MEMBER_REQUIRED` — **409, not 403**, deliberately outside
`HARD_STOP_BOOKING_FAILURE_CODES`: the booking *is* permitted, by a Booking
Officer, through the #2363/#2365 exception-request workflow. The violation is
frozen with `capacityMode: "HOLD"` (owner decision 4), so a pending override keeps
the beds rather than making the member race for capacity while an admin reads
their request. `requirements` carries **counts and no identities** — every field is
rendered back to the refused member, and naming who is unpaid would turn a booking
refusal into a financial-status oracle. The fingerprint follows: it hashes the
hazard ("this party has nobody paid-up on it"), not who, so re-saving the same
party shape does not reopen a decided review.

### INV-LOCKOUT-028

**The FROZEN violation shape is unchanged by the owner trigger; the member-facing
RESPONSE is audience-scoped instead.** An owner-triggered refusal reads
`repricedUnpaidMemberCount: 0`, which discloses that the trigger was not a member of
the party. On ten of the eleven enforcement sites that is a fact the recipient
already holds, because the unfinancial member IS the person receiving the refusal:
create, quote, confirm-draft, modify-quote, guest-add, the modify apply path and
both waitlist confirms all run for the booking's own owner, an admin is exempt from
the check entirely, and the group-join gate passes the JOINER as the owner of the
booking being made rather than the group booking's owner. The eleventh is
single-guest removal, where a member may take their own guest row off **somebody
else's** booking — there the refusal can reach a member of another family while the
trigger is the booking owner's unpaid subscription, which they can see nowhere else
in the app. So `buildPaidUpAdultRefusalBody` takes an audience and the removal path
asks for `OTHER_PARTY_MEMBER` when the actor is not the owner: identical refusal,
wording, HOLD and override door, with that one count withheld. The frozen violation
keeps both counts because the open-state fingerprint is hashed from them, so
redacting there would change which refusals count as the same hazard; only the copy
rendered to the member is narrowed, and no snapshot's shape moves.

### INV-LOCKOUT-029

**A violation must name the nights it holds.** When the owner arm fires on a party
that yields no nights of its own, `affectedNights` falls back to the booking
envelope: a `HOLD` over zero nights would reserve nothing while promising the
member their beds. Unreachable on the reprice trigger, which implies a member
participant.

### INV-LOCKOUT-030

**A repriced member stops counting as a host** (owner decision 3). Under
`NON_MEMBER_PRICING` the booking-side loader stamps
`HostingParticipant.subscriptionSettled = false` on them, and
`participantQualifiesAsHost` refuses them — somebody the club is charging as a
non-member is not the responsible member the hosting rule asks for. **Absent means
settled**, so under the other two modes the field is never populated and the
hosting answer is byte-identical to pre-#2543. Deliberately asymmetric, and
narrower than the lapsed-member rule: `participantIsNonMemberGuest` does NOT read
the field, so an unpaid member's own nights do not become uncovered guest-nights
needing admin review. A lapsed membership is gone; an unpaid subscription is a
membership in good standing with a bill outstanding.

### INV-LOCKOUT-031

**`NON_MEMBER_PRICING` is a relaxation, with two narrow exceptions - stated because
the blanket claim is not true.** It removes hard refusals rather than adding them. But
the paid-up-adult requirement is evaluated over the WHOLE party, while the pre-#2543
gates looked only at the guests a request was ADDING, so two parties that pass today can
land on the new 409:

1. **confirm-draft** has no member-guest subscription gate on `main` at all, so a draft
   owned by a paid-up Youth member containing an unfinancial member guest confirms today
   and is refused under `NON_MEMBER_PRICING`.
2. **modify-quote and `.../guests`** gate added guests only, so a member already on the
   booking with an unpaid subscription can trip the requirement on an edit that has
   nothing to do with them.

### INV-LOCKOUT-032

Both land on a 409 with an override door and a HOLD on the beds - not a wall - and
neither is closed by adding a new HARD_BLOCK gate, which would change today's behaviour
for clubs that have not adopted the mode. The honest claim is: no HARD_BLOCK refusal
becomes stricter, and these two cases become reviewable rather than impossible.

### INV-LOCKOUT-033

**The owner trigger adds no third exception**, and the arithmetic is worth stating
because it looks like it should. An unfinancial member booking beds for others is
refused OUTRIGHT under `HARD_BLOCK` today (403 `SUBSCRIPTION_REQUIRED`, keyed on the
booker as a person). Under `NON_MEMBER_PRICING` they now get a 409 with the override
door and the beds held. That is strictly gentler than the behaviour it replaces, so the
list above stays at two. What the trigger IS stricter than is the interim repriced-only
build of #2543, which never shipped: the gap was closed by owner decision before the
mode reached a club.

### INV-LOCKOUT-034

**Config-transfer maps the legacy bundle KEY, and a broken one fails the dry-run.**
There is no `(mode, enabled)` pair to reconcile any more — `enabled` is neither a column
nor an exported field — but a bundle exported before #2543 still carries the key, and it
still records a real decision. Left unmapped it would be an unknown field: the importer
writes only fields physically present in a bundle (dropping null-valued ones in the
default merge mode) and type-checks only names in the spec's `fields`, so the key would be
silently dropped, the target would keep its own `mode`, and the dry-run would report no
change to the policy. A club importing a pre-#2543 bundle to turn the lockout off would
have been told it worked while every unpaid member went on being repriced and refused. So
the singleton spec's `reconcile` hook maps the key to the mode it means (`true →
HARD_BLOCK`, `false → NO_BLOCK` — the same mapping the contract migration applied to live
rows), on the one code path both the dry-run and the apply use, and it also covers the
bundle a post-#2543 club exported before an admin ever opened the panel
(`mode: null, enabled: false` → `NO_BLOCK`).

### INV-LOCKOUT-035

Two properties of that hook are load-bearing. It derives ONLY into an absent-or-null
`mode` and never over a value the bundle states, so a hand-edited `"MAYBE"` is refused by
name by the DMMF enum check rather than silently corrected into whatever the legacy boolean
said. And it runs BEFORE the field-validation loop, which is what lets `mode` carry
`required: true` now that its column is `NOT NULL`: `required` fires only on a PRESENT
null, so a pre-#2543 bundle (no key at all) is untouched, a `mode: null` beside an
`enabled` has a real mode by the time the loop sees it, and the one remaining shape —
`mode: null` with nothing to derive from, i.e. a hand-trimmed or partially-written file —
fails the dry-run as an error instead of aborting the whole import transaction on a
write-time Prisma exception. The reverse derivation is gone with the column: there is no
boolean left to write back, and `enabled` never reaches Prisma. No format-version bump is
needed either — an old bundle imports to the right policy rather than to a guess, so there
is nothing for a version gate to refuse.

### INV-LOCKOUT-036

**Reversal:** set the mode back to `HARD_BLOCK` (or `NO_BLOCK`) in Admin →
Subscription lockout. No migration, no code change, and no already-taken booking is
re-priced — the rate is snapshotted per guest row as it always was, and a guest who
keeps a locked night keeps their snapshot too. Two stored-money exceptions, both
pre-existing behaviours the mode inherits rather than introduces: the waitlist offer
sweep re-bases a WAITLISTED entry's stored price at current rates before the member
confirms (which is why the offer email now states the reason as well as the figure),
and any edit the member themselves makes prices its NEW nights at today's rates. The
paid-up-adult half keys off the same standing predicate as #2364, so a reversal of
*that* half is #2364's reversal (drop the standing clauses from
`participantQualifiesAsHost`), never a narrower one here.

### INV-LOCKOUT-037

Issue #1668 adds an **admin-only override** (`adminOverride`, honoured solely when
`bookingManagementAuthorizationRole(session.user) === "ADMIN"`, i.e. Full Admin
or Booking Officer) that lifts those date-window locks so an admin can move the
dates of an in-progress or fully-past booking. The override is **date-only**:
the modify / modify-dates / modify-quote endpoints reject any guest, promo, or
name field submitted alongside the flags ("Admin override edits change dates
only"), and status eligibility (`canModifyBookingStatusForRole`) plus the
per-lodge capacity lock still apply. Members and officers-without-`bookings:edit`
see byte-for-byte unchanged behaviour whether or not the flag is present. An
override requires an explicit `pricingMode` [INV-LOCKOUT-053]:

- **shift** — a pure relocation: the night count is held constant (a provided
  single bound derives the other), every cent is frozen (booking totals,
  per-guest `priceCents`, and each translated `BookingGuestNight.priceCents`
  move with the stay), and there is no change fee, settlement, Stripe, or Xero
  activity. The `BookingModification` row is `ADMIN_DATE_SHIFT` with
  `priceDiffCents`/`changeFeeCents` = 0. All date math is date-only
  (`addDaysDateOnly` on date-only-normalised bounds, per the stay-boundary
  invariant's storage-encoding note), so the delta is
  DST-safe. The member-facing change-notification email is an explicit
  per-action admin choice on **every** admin edit — not only overrides (#1696).
  Whenever an admin / Booking Officer saves a booking edit (dates, guests, or
  promo, override or plain), a dialog asks whether to email the member ("Save
  and email member" / "Save without emailing"); the choice is recorded in the
  audit metadata (`notifyMember`) and an admin/API caller that omits the flag
  defaults to notifying. A member editing their own booking always sends the
  change email, and a non-admin actor can never suppress it — the modify /
  modify-dates routes 403 any `notifyMember` flag from a non-ADMIN caller
  (pricing/capacity override flags still require `adminOverride`). A recalculate
  override that moves money still respects the admin's choice — the amounts
  remain visible on the booking and in Xero regardless. The same per-action
  choice covers the two remaining admin-driven member-facing emails (#1705):
  the standalone **guest-removal** route (`DELETE /api/bookings/[id]/guests/
  [guestId]`) and **cancellation** (`POST /api/bookings/[id]/cancel`, "Cancel
  and email member" / "Cancel without emailing" — the suppression also covers
  the linked provisional split children cancelled with the parent). Both routes
  403 the flag from any non-(booking-management)-ADMIN caller, force notify for
  non-admin actors (cancellation at the service — `cancelBooking` — and guest
  removal in the route handler itself), default to notify when the flag is
  absent, and record a suppressed send as `notifyMember: false` in the audit
  metadata;
  refund/credit settlement, audit, booking events, waitlist processing, and the
  admin-facing alerts are never affected by the choice. **The Xero invoice
  email on the Internet Banking path is deliberately outside this choice and is
  ALWAYS sent** (superseded for the per-booking "No emails" switch — see
  that section below) — it is the member's payment instruction (invoice number + bank
  details), so suppressing it could strand an unpaid invoice the member was
  never told about (owner decision on #1705). Three further cancellation
  emails are **deliberately always-notify** and outside the choice (owner
  decision 2026-07-10, #1730): the joiner emails when a **group organiser
  cancels** the group, the member email on an **admin review-rejection**
  cancel, and the cancellation emails sent by **deletion-request cleanup** —
  in each, the recipient is losing a booking they own, and a missed email
  risks a member arriving for a stay that no longer exists. (All three are
  nonetheless withheld by the per-booking "No emails" switch — see that section
  below — which overrides every always-notify rule on this page.)

### INV-LOCKOUT-044

The #1780/#1769b sweep extends this same per-action choice to every remaining
admin-initiated member email — membership application approve/reject (#1786),
membership cancellation review (#1787), member archive review and
account-deletion reject (#1788), family-group child-request and group-create
approve/reject (#1789), booking review approve/reject (#1790), booking-request
decline (#1791), and refund-appeal approve/reject (#1792) — each
default-notify, admin-only (all `requireAdmin()` routes, so no non-admin can
carry the flag), and audited `notifyMember: false` only when a send is truly
suppressed (a would-not-send path — e.g. a member with no email on file, or a
refund appellant with no address — records no notify field). Five further
sends stay **deliberately always-notify** and outside the choice for the same
not-strandable-communication reason: the membership-application **induction
sign-off requests** (token-bearing signer requests), the family group-create
**partner invitation** (token-bearing; the partner cannot join without it),
the **account-deletion approval** privacy receipt (the member requested
deletion and cannot log in afterward), and the booking-request
**approved/quote** emails (they carry the payment/quote link). On a
booking-review **rejection** the shared cancellation email above (#1730) is
the always-notify send, so a suppressed reject still emails the member the
cancellation and withholds only the review-declined explainer (superseded for
the per-booking "No emails" switch — see that section below — which withholds
the cancellation notice too, so a reject on a silenced booking emails the
member nothing at all; #2259's review dialog says exactly that rather than
repeating the promise above).

### INV-LOCKOUT-045

An account-deletion approve and reject also have exactly one final winner,
but they do not always race for the same transition (#2597, #2627). An
approval that has future bookings to cancel commits those cancellations in
separately committed transactions before it anonymises anything, so it first
claims `PENDING -> APPROVAL_IN_PROGRESS` — durably, before the first
cancellation commits — and then finalises only from that claim, inside the
anonymisation transaction, so any later privacy failure rolls finalisation
back to the claim and sends no receipt. **While that claim stands, a rejection
can never become final after an approval-triggered cancellation has
committed** — which the single-transition protocol could not guarantee. It is
deliberately NOT an absolute: a Full Admin can release the claim (see
"`APPROVAL_IN_PROGRESS` is not a one-way door" below), and the request is then
decidable again, because the alternative was a request wedged open forever.
What holds after a release is a weaker but honest property — **no rejection
can be finalised over cancellations an approval already committed without the
decider being told**: the release leaves a durable marker on the row, the
queue and the reject dialog state what it means, and the route refuses the
rejection unless the actor is a Full Admin and confirms it. A repeated approval
resumes its own claim rather than being refused, so an interrupted cleanup can
always be completed. A losing concurrent reviewer gets a fixed conflict and
sends no contradictory message. Cancellations already committed before a lost
claim are returned as explicit partial cleanup, never described as
anonymisation.

### INV-LOCKOUT-046

**The claim is taken only when there is something irreversible to protect**
(#2627). An approval with no future bookings to cancel commits everything it
does in the one anonymisation transaction, so it stays `PENDING` and finalises
`PENDING -> APPROVED` in a single guarded transition — the pre-#2597 protocol,
which is safe precisely because nothing was committed ahead of it. Claiming
there would consume the ability to reject in exchange for nothing, and a
permanent failure inside that transaction would wedge a request that nobody
had acted on. Rejection still claims only `PENDING`, so on this path an
approve and a reject do race for the same transition, exactly one wins, and
the loser is told the request was already reviewed with nothing destroyed
either way.

### INV-LOCKOUT-047

`APPROVAL_IN_PROGRESS` is an OPEN state, not a decided one: it still owes the
member their anonymisation, and it **may** already have cancelled their future
bookings — the admin UI's "may already be cancelled" is the honest wording,
because the claim is now only ever taken when there were bookings to cancel,
but it is taken before the first cancellation commits and a resumed claim can
outlive them all. Every "is there an outstanding request?" reader — admin
queue, pending counts, dashboard, the member's own re-request guard, and the
member-merge blocker — must therefore treat it as open via
`OPEN_DELETION_REQUEST_STATUSES`.
Filtering on `PENDING` alone would hide a half-finished deletion from the
queue that has to finish it, and would silently unblock a merge that then
re-points the request at the surviving member.

### INV-LOCKOUT-048

**`APPROVAL_IN_PROGRESS` is not a one-way door** (#2627). A Full Admin may
release a started approval — `APPROVAL_IN_PROGRESS -> PENDING`, guarded on the
claimed status, with a mandatory reason, audited as
`member.deletion_approval_claim_released`, anonymising nobody and emailing the
member nothing. Without it a permanently blocked approval left the request
open forever, and while it is open the member cannot lodge a new deletion
request and their duplicate cannot be merged. The release cannot race a
finalisation that is already committing: it is the same guarded `updateMany`
on the same row (taken under that row's own `FOR UPDATE` — see the attribution
paragraph below), so a release arriving mid-commit blocks on the finalisation's
row lock and then matches zero rows (`DELETION_REQUEST_CLAIM_NOT_HELD`, 409),
while a release that commits first makes the finalisation match zero rows and
roll its whole anonymisation transaction back. Both winner orders are forced
against real PostgreSQL in `adult-member-hosting-queue-merge.realdb.test.ts`.
The release returns the request
to `PENDING` rather than straight to `REJECTED` so the decision itself is
still made through the ordinary reject path, with its guard, its audit entry
and its notify choice.

### INV-LOCKOUT-049

**A released request is marked, and rejecting one is gated and confirmed.**
A release re-opens a decision that had been closed to rejection, so the
re-opened state cannot look like an ordinary pending request. It is `PENDING`
again in the full sense: an approve and a reject race the same guard, and a
later approval **may** re-take the claim — it does so whenever the member has
future bookings at that moment, which happens if the earlier attempt stopped
part-way through cancelling them or the member has booked since (they are not
anonymised and their login still works). A re-claim is strictly safer than not
re-claiming, because it closes the request to rejection again before the next
cancellation commits, and releasing that claim in turn writes the marker again.
The fact therefore
travels **in the row**: `PENDING` with a `reviewedAt` and no `reviewedBy` is a
combination no other writer of the row can produce, so it is a marker and not a
heuristic (`deletionApprovalWasReleased`, `src/lib/deletion-request-decision.ts`;
it deliberately overloads `reviewedAt` instead of adding a column, and every
reader must go through that predicate rather than reading the field). It is
written by the same single guarded mutation as the transition, so it cannot lag,
cannot be lost and cannot be forged in a free-text note. The admin queue shows
it as "approval started and released back to pending" with the release reason,
never as a completed review; the reject dialog repeats it; and the route refuses
a rejection of a released request unless the actor **is a Full Admin** (403 —
the same gate as the release that produced the state, now on the step that does
the harm) **and** carries `confirmReleasedApproval: true` (409
`DELETION_REJECT_AFTER_RELEASE_CONFIRM_REQUIRED` with the disclosure, so a page
loaded before the release cannot finalise one unwarned; the same warn-and-confirm
shape as the over-capacity override) **and** gives the member something they are
actually told. On this one path the note is **mandatory**, mirroring the release
that produced the state, and `notifyMember: false` is **refused** (400
`DELETION_REJECT_AFTER_RELEASE_REASON_REQUIRED` /
`DELETION_REJECT_AFTER_RELEASE_NOTICE_REQUIRED`). Everything else in this
protection is admin-facing — the gate, the row warning, the dialog, the
confirmation flag, the audit metadata — so without those two a Full Admin could
confirm, leave the note empty, suppress the email, and decline the member over
cancelled stays with nothing said at all. Ordinary rejections keep #1788's free,
audited notify choice and their optional note: nothing has been destroyed there,
so silence is a legitimate option. The applied rejection records
`approvalPreviouslyReleased` in its audit entry. Approving a released request is
ungated: it completes the deletion the member asked for and destroys nothing the
released approval had not already destroyed.

### INV-LOCKOUT-050

**The gate decides what to refuse; the guard decides what can be won.** The
Full-Admin check and the confirmation are evaluated against the route's opening
read, which is not the serialised point — Prisma queues on an exhausted
connection pool, so seconds can pass before the write. A release committing in
that window would otherwise turn an ordinary rejection into a
reject-after-release with no Full-Admin check and no confirmation: exactly the
state this section forbids, produced by a check-then-act. So the flavour of
`PENDING` a rejection is authorised against travels into the guarded
`updateMany` itself (`DeletionRequestRejectionOrigin`): an unconfirmed rejection
guards on `reviewedAt: null` and a confirmed reject-after-release on
`reviewedAt: { not: null }`. The two shapes partition `PENDING` exactly, so a
rejection can only ever win the flavour it was authorised against, and the loser
gets the 409 below and decides the reloaded, warned row instead. Forced against
real PostgreSQL — a claim-and-release holding the row while the unwarned
rejection blocks on it, then matches nothing — in
`adult-member-hosting-queue-merge.realdb.test.ts`.

### INV-LOCKOUT-051

**The release and its audit record commit together.** The transition nulls the
claim's own attribution, so the `member.deletion_approval_claim_released` entry
is the only surviving record of who held it — which rules out the
fire-and-forget `logAudit`. The release takes the row `FOR UPDATE`, reads the
previous holder and note through the Prisma model under that lock (so an ABA
interleaving cannot record a holder that was never displaced), performs the
guarded transition, and the route writes that audit row with the awaited
`createAuditLog` on the same transaction client. A failed insert rolls the
release back: the operator is told it failed and the claim is still there to
release again. The release is also the one transition whose first statement is
designed to block, so its transaction runs with an explicit budget larger than
the anonymisation transaction it may be waiting behind (`maxWait` 10s /
`timeout` 15s) and an exhausted wait is answered
`DELETION_REQUEST_RELEASE_CONTENDED` (503, `retryAllowed: true`) rather than a
bare 500 — see `docs/CONCURRENCY_AND_LOCKING.md`.

### INV-LOCKOUT-052

**A decision that loses its guard to a release is reported as that.**
`PENDING` is reachable when a decision claim matches zero rows, and it is the
one state that is known exactly, so the route answers
`DELETION_REQUEST_APPROVAL_RELEASED` (409, `retryAllowed: false`,
`decisionFinal: false`) with the cancellations that did commit — never
`DELETION_REQUEST_DECISION_STATUS_UNCONFIRMED`, whose "its final state could not
be confirmed … do not retry" would durably disable a row the admin can and
should decide again. Both losers land there: an approval finalising from a claim
that has since been released, and an unconfirmed rejection the strict guard
above refused.

### INV-LOCKOUT-053

- **recalculate** [INV-LOCKOUT-037] — the existing full-reprice machinery with the locked-period
  clamps lifted, so locked-night pricing semantics are otherwise preserved
  (a night the guest already bought keeps its stored `BookingGuestNight` price).

### INV-LOCKOUT-038

Under an override, an over-capacity target is **warn-and-confirm** rather than a
hard block: the first apply raises `OverCapacityConfirmationRequiredError`
(HTTP 409, code `OVER_CAPACITY_CONFIRM_REQUIRED`, with the over-capacity nights),
and the admin must resubmit with `confirmOverCapacity: true`. The capacity lock
is still acquired, and the confirmed overbooking is recorded (`capacityOverridden`
on the modification's `newData` and in the audit trail). Statuses outside the
active lifecycle (DRAFT, WAITLISTED, WAITLIST_OFFERED, BUMPED) hold no capacity,
so both pricing modes skip the capacity decision for them entirely — a move that
cannot overbook must never prompt for (or record) an overbooking confirm. Every override move is
audited as `booking.modify.admin_override` with before/after dates, `pricingMode`,
and `confirmOverCapacity`, and is linked (best-effort, post-transaction) to the
booking's most recent APPROVED-but-unlinked `BookingChangeRequest` **that the
move actually fulfils** — the request must be date-only (no guest changes) and
every date it names must equal the applied value, so an unrelated move can never
mark a different ask as applied — closing the approve → apply trail. The modify-quote preview mirrors apply exactly for the
same input (same date resolution, capacity signal, and member-night conflict
check), so the operator never sees a clean preview for a move that would fail.

### INV-LOCKOUT-039

**Per-booking "No emails" switch (#2258, owner decision D10, 2026-07-27).**
Separately from
the per-action `notifyMember` choice above — which is a one-off decision made at
the moment of a single admin action — a booking can carry a persistent
`Booking.noEmails` switch that withholds **everything** the system would send
about that booking for as long as it is on: confirmation, modification, payment,
reminders, arrival information, cancellation, waitlist offers, chore rosters,
and the Xero-sent invoice email. It is enforced in ONE place, the mailer
(`sendEmail` in `src/lib/email/core.ts`), plus the three paths that bypass the
mailer (the retry cron, and the two invoice emails Xero sends on our behalf).
The rules are:

- **Keyed strictly on the booking, never on the recipient address.** An
  address-keyed switch would also swallow two-factor codes, password resets,
  magic-link logins and email-change notices — account lockout, not a
  preference. Every send therefore carries a REQUIRED, typed `bookingContext`
  (`{ bookingId, recipient } | "none"`), so a new send site is a compile error
  until its author states which it is. For a concrete booking the context also
  names the recipient category (an explicit member id, public/non-login, or
  aggregate operator), so address matching can never stand in for authority.

### INV-LOCKOUT-054

- **Authenticated booking links follow the booking-detail read gate (#2362).**
  A concrete booking email receives the canonical, encoded
  `/bookings/<booking-id>` URL only when the recipient is active, can sign in,
  and is the owner, a linked booking guest, or holds bookings-view admin access;
  the outbound address must also still equal that member's current direct or
  flattened inherited mailbox.
  Deleted bookings remain Full-Admin-only. Public/non-login contacts, aggregate
  reports, unrelated members, failed authority reads, and templates outside the
  live booking-scoped inventory receive no authenticated booking URL. Bearer
  payment, quote, consent, and response links stay distinct and unchanged.

### INV-LOCKOUT-055

- **Admin-audience mail is never withheld.** The registry's
  `EmailTemplateDefinition.audience` is the authority, so admin/system alerts
  (payment failure, duplicate-capture refund, and the rest) still reach an
  operator even when the booking is silenced.

### INV-LOCKOUT-056

- **The read fails CLOSED.** Unlike the SES bounce check, which deliberately
  fails open, an unreadable switch withholds the send: the mailer records the
  row FAILED (so the retry cron re-evaluates it) and transmits nothing.

### INV-LOCKOUT-057

- **Every withhold is auditable.** The withheld send is written as an `EmailLog`
  row with status `SKIPPED_NO_EMAILS` and the booking's `bookingId`, with no
  retained body — so the booking page can list exactly what was held back
  (#2259), and the retry cron cannot replay it (its query requires a retained
  body, and the status is terminal).

### INV-LOCKOUT-058

- **The retry cron re-evaluates before every replay.** A `FAILED` row can
  predate the moment the switch was turned on, so `cron-email-retry.ts` re-reads
  it from the row's `bookingId` and fails closed the same way. It also repeats
  the booking-detail authority check from durable `EmailLog` recipient/context
  provenance; the address is matched to that identity's current direct or
  flattened inherited mailbox, never used as identity by itself. Built-in and
  stored-override DELIVERY copies are re-finalized before the guarded retry
  claim, so a revoked/stale recipient loses the detail CTA while bearer actions
  and page fragments remain intact. Stored override SOURCE and re-save behavior
  stay byte-for-byte unchanged. Legacy rows with no durable context retire
  without sending. New booking retry bodies live only in the authority-aware
  `bookingRetryHtmlBody` column; legacy `htmlBody` stays null so an application
  rollback to the pre-#2362 worker cannot replay them without these checks.

### INV-LOCKOUT-059

- **Waitlist candidacy excludes a silenced booking.**
  `processWaitlistForDates` filters on `noEmails: false`, so no NEW offer is
  made to a silenced entry and, in the ordinary case, no offer clock starts for
  a member who would not be told. That exclusion is not retroactive and does not
  cover every ordering, so two cases remain and both are surfaced rather than
  denied:
  - the switch is turned **on while an offer is already live** — the clock keeps
    running and the offer is not retracted. `setBookingNoEmails` returns
    `hasLiveWaitlistOffer`, and #2259's acknowledgement dialog warns on it
    **before** the admin confirms (from the same predicate,
    `bookingHasLiveWaitlistOffer`, so the warning and the route's answer cannot
    disagree about what "live" means) as well as after the write;
  - the **post-commit race** — `processWaitlistForDates` commits the offer and
    fires the email un-awaited afterwards, so a switch flipped in between leaves
    a live offer with a withheld send. (The retry cron can likewise rewrite an
    already-FAILED offer row to `SKIPPED_NO_EMAILS`.)

  In both, the entry is holding a bed the member was never told about, so the
  admin waitlist board reports the distinct `suppressed_live_offer` state with
  `needsOperatorAction: true`. A withheld offer on an entry whose offer has
  already lapsed is the benign `suppressed` state and needs no action. A
  silenced entry that is still `WAITLISTED` produces no EmailLog row at all, so
  the board marks it from the flag ("silenced — will not be offered").

### INV-LOCKOUT-060

- **A silenced waitlist entry keeps its place in the queue.** It is skipped for
  offers but is NOT removed, and it still counts toward the position quoted to
  the members behind it — the position numbers other members see are unchanged
  by anyone's switch. (Deliberate: position is member-visible, and silently
  re-numbering a queue because of an internal admin setting would be a worse
  surprise than a stalled entry an officer can see and fix.)

### INV-LOCKOUT-061

- **Xero-sent invoice emails are gated too, which SUPERSEDES the #1705 carve-out
  above for this switch only.** #1705 decided the Internet Banking invoice email
  is outside the per-action `notifyMember` choice and always sent. D10 says the
  per-booking switch "suppresses everything", so when it is on the
  `emailInvoice` call is skipped and a withheld audit row is written naming the
  invoice. **The invoice itself still exists in Xero and is unchanged** — only
  the emailing is skipped, so an admin sends it **from Xero by hand**. Clearing
  the switch does NOT resend it: invoice creation short-circuits on the stored
  `payment.xeroInvoiceId` and never reaches the email step again, and the
  `emailInvoice` idempotency key would no-op regardless. When the switch could
  not be READ (as opposed to being on) the sync operation is left PARTIAL so an
  operator sees it — but the operations panel's payment repair must never be run
  on an email-only PARTIAL: every one of them is an Internet Banking booking
  whose Xero payment is deliberately skipped, so recording a payment would
  falsely settle an unpaid invoice. That repair is refused for email-only
  PARTIALs. The per-action `notifyMember` carve-out is untouched: with the switch
  off, the invoice email is still always sent. The group settlement invoice is
  one combined bill addressed to and paid by the **organiser**, so it is gated on
  the organiser's own booking and on nothing else — a joiner's switch does not
  suppress the organiser's bill, and each joiner's own group emails are gated on
  that joiner's child booking.

### INV-LOCKOUT-062

- **Setting it requires an acknowledgement.** `POST
  /api/admin/bookings/[id]/no-emails` is admin-only (403 otherwise) and refuses
  an enable without `acknowledged: true` (400, nothing written). Both set and
  clear are audited, and `noEmailsAt` / `noEmailsByMemberId` record who and
  when, mirroring the `wholeLodgeHold` audit columns. Clearing needs no
  acknowledgement — a stuck switch must always be clearable — and does **not**
  re-send anything withheld while it was on.

### INV-LOCKOUT-063

- **The acknowledgement is a real admin decision, not just a request field
  (#2259).** The control lives in the Admin tools card on the booking detail
  page and is gated on `bookings:edit`. Turning it on opens a two-button dialog
  ("Yes — I will tell the member myself" / "Cancel") carrying the plain
  consequence — no emails at all for this booking, including cancellation
  notices and payment reminders, and the admin is responsible for telling the
  member directly. It is deliberately **not** a checkbox: a checkbox is missable
  and the consequence is a member who is never told their booking was cancelled.
  Nothing is written until the dialog is answered.

### INV-LOCKOUT-064

- **The booking carries a persistent warning listing what was ACTUALLY withheld
  (#2259).** Read from the `SKIPPED_NO_EMAILS` audit rows, not a fixed sentence:
  the admin has to know WHICH messages the member never received in order to
  relay them, and the list includes the Xero-sent invoice emails, which are
  inside the same guarantee. Each row shows the template's registry display name
  (`withheldEmailDisplayName`), its subject and its timestamp. The banner
  **keeps warning after the switch is cleared** whenever withheld rows exist,
  because clearing re-sends nothing — a member never told about a cancellation
  is still never told.

  One documented exception (#2350): the additional-payment chase cron checks the
  switch ITSELF and skips before it reaches the mailer, deliberately, so that no
  stamp is burned and the reminder is still due once the switch comes off. Since
  the mailer never runs, no `SKIPPED_NO_EMAILS` row is written and that skipped
  chase does not appear in this list. It is the one booking message the banner
  cannot name — and the only one that is not lost by being withheld, because it
  will be sent for real later.
  Rows are **grouped per template with an exact count**, read with aggregates
  (`getWithheldBookingEmailSummary`). That is a correctness property, not a
  presentational one: a chore-roster send fans out to one row per guest per
  date (~56 for a week for a party of eight), so a flat newest-first list both
  buried the single cancellation that mattered and could hit the old
  undisclosed `take: 100` cap. The groups come from a database-side `groupBy`,
  which returns one row per distinct template; representative subjects are then
  fetched by matching the per-template maxima under an explicit cap, and a
  group is never dropped for want of a subject because the aggregate — not the
  row read — produces the list. (An earlier attempt used
  `findMany({ distinct })`; Prisma only pushes `distinct` into the query when it
  LEADS the `orderBy`, so ordering by `createdAt` fetched every withheld row for
  the booking and deduped in memory — the same unbounded read the `take: 100`
  had been masking, under a comment claiming the registry bounded it.)
  Each group carries a `remedy` saying what the officer must actually DO, and
  the three values are not interchangeable:
  - `relay` (the default) — the content is information the officer can simply
    state. The Xero invoice is here: it still exists in Xero and can be sent by
    hand from there.
  - `auto-regenerates` — `split-guest-payment-link` only. The link is decided
    BEFORE it is minted, so none exists, and the settlement cron re-mints and
    re-sends once the switch is off. Clearing the switch is the whole remedy.
  - `resend-roster` — `chore-roster`, which was briefly and wrongly treated as
    the case above. `admin-roster-service.ts` DELETES the guest's existing chore
    token, mints a fresh one, and only then sends: a live 48-hour link exists,
    the guest's previous link was destroyed, and the guest currently holds
    nothing that works. `sendChoreRosterEmail` has exactly one caller — the
    admin roster action, with no cron behind it — so nothing regenerates it and
    the officer must re-send the roster by hand.
  The banner also points at the email-failure queue, because three classes are
  structurally absent from it: a send that failed closed on an unreadable
  switch, a withheld send whose own `EmailLog` write failed, and rows queued
  before the feature shipped.

### INV-LOCKOUT-065

- **Two consequences are stated in the acknowledgement dialog because nothing
  can record them.** A **live waitlist offer** can only PREDATE the switch
  (candidacy exclusion prevents new ones), so its offer email already went out:
  the member HAS been told and CAN still accept, and the dialog says not to
  reassign the bed. What is lost is the expiry warning and the acceptance
  confirmation. Saying "the member cannot accept" would be worse than silence —
  an officer believing the bed dead might reassign it out from under a member
  still entitled to it. A **still-WAITLISTED** booking is skipped for offers
  ENTIRELY, so no offer is made, nothing is withheld, and no row is ever
  written; the dialog states it before the officer commits and the banner
  repeats it, and "waitlist offers" is deliberately absent from the banner's
  withheld-categories sentence, which would otherwise imply an offer was made
  and only its email held back.

### INV-LOCKOUT-066

- **A member must never learn the switch exists.** The booking detail page
  serves members and admins from one file, so the control, the banner, and every
  `noEmails` value the page produces sit behind the page's admin predicate — and
  the withheld list is not even QUERIED for a member. Gating the render alone is
  insufficient: a prop threaded unconditionally is serialised into the RSC
  payload, so the switch would be readable off the wire with nothing drawing it.
  `booking-no-emails-ui-contract.test.ts` enforces both over the AST.

### INV-LOCKOUT-067

- **The per-action `notifyMember` prompts are not offered while the switch is
  on (#2259 honesty rule).** The rule behind that prompt family (#1769a) is that
  an admin is only asked a question the system will honour; with the switch on
  the message is withheld either way, so asking invites the admin to choose
  "…and email member" and believe the member was told. Every booking-bound
  prompt therefore drops to the send-nothing path and states the position
  instead: confirm-pending-guests, the admin edit, the admin cancel, the booking
  review queue, the waitlist force-confirm, and the refund-appeal review. The
  same contract test asserts the closed world — a new prompt must be classified
  booking-bound or not, with its reason, rather than silently escaping the rule.

### INV-LOCKOUT-068

- **The silenced path sends NO `notifyMember` flag, never `false`.** This is a
  correctness requirement, not a style choice, and the contract test enforces
  it. `notifyMember: false` tells the ROUTE not to send at all, so the mailer's
  gate never runs, no `SKIPPED_NO_EMAILS` row is written, and the withheld-list
  banner cannot name the cancellation the officer just performed in silence —
  on an otherwise quiet booking it would read "Nothing has been withheld yet"
  immediately afterwards, while the operator guide tells the officer to work
  down that list. The compensating control would be blind to its own trigger.
  Sending no flag lets the send be ATTEMPTED and withheld, which records the
  row. The member's outcome is identical either way. It is also the honest
  audit record: `false` would say the officer declined and `true` would say
  they opted in, and with the choice removed neither happened — every one of
  these routes treats an absent flag as "no explicit choice", and only audits
  an explicit one. That the SWITCH decided is durably recorded by the withheld
  `EmailLog` row plus the `booking.noEmails.set` audit entry, so no new field
  was added to six money- and booking-critical routes to state it twice.
  Deliberately EXCLUDED and why: the chore-roster send (per DATE, fanning out
  across many bookings, where the mailer's own gate silences each one
  individually), the public booking-request decline and the admin create flow
  (no `Booking` row to be silenced yet), and every membership, family, deletion
  and application prompt (keyed on a member, not a booking).

### INV-LOCKOUT-040

Booking **creation** is normally today-or-future: `POST /api/bookings` and the
create service both reject a past check-in ("Cannot book in the past"). Issue
#1695 adds an **admin-only, on-behalf-only** exception — the same
`bookingManagementAuthorizationRole(session.user) === "ADMIN"` gate as #1668 —
so a Full Admin or Booking Officer can record a stay that already happened. The
opt-in `allowPastDates` flag (valid only with `forMemberId`, and only with a
check-in strictly in the past — a today-or-future check-in carrying it is a
400) permits a past check-in within a **365-day rolling lookback**
(`RETROACTIVE_BOOKING_MAX_LOOKBACK_DAYS`); it is enforced at the route **and**
re-checked in `createConfirmedBooking` against the **resolved stay envelope**
(guest nights can expand the stay before the requested check-in, #713 — the
route's lookback and lock-date guards also run on the envelope check-in).
Two internal callers legitimately create a booking whose check-in is already
past and carry the service-only `allowPastCheckIn` marker instead: group join
(the child inherits the organiser's whole-stay dates, #1387) and cross-lodge
waitlist confirm (a 48-hour offer accepted after NZ midnight) — the marker
skips only the past-date rejection, never the retroactive semantics, and is
not exposed via the API. Any of the three flags (`allowPastDates`,
`confirmOverCapacity`, `notifyMember`) present without the ADMIN role is a
403; the flag combination is validated (any flag without `forMemberId` → 400,
`confirmOverCapacity` combined with `draft`/`waitlist` → 400, retroactive
`draft`/`waitlist` → 400). Because a
retroactive booking invoices at its check-in (the invoice **issue date stays =
checkIn**, no clamp), a create-time **Xero lock-date guard** protects it: when
Xero is connected the route reads the organisation's `periodLockDate` /
`endOfYearLockDate` (`getXeroLockDates`) and rejects a check-in on or before the
effective lock date (409 `XERO_PERIOD_LOCKED`, with unlock instructions). The
guard is **skipped when Xero is not connected** and **fails closed** (retryable
503 `XERO_LOCK_DATE_CHECK_FAILED`) when the lock dates cannot be read; the Xero
call is made outside any DB transaction and its result is cached ~5 minutes.
The guard still fails closed for every cause, but now **classifies that cause**
(#2105): the `XeroLockDateCheckFailedError` carries a `reason` of
`reconnect_required` (the Xero connection needs re-authorising — a revoked or
missing token/tenant, surfaced by the taxonomy's `XeroReconnectRequiredError`),
`rate_limited` (Xero's daily API budget is exhausted — `XeroDailyLimitError`),
or `transient` (a temporary outage or unclassified failure). The `reason` and
the cause-specific admin copy are emitted **only for the admin audience**
(`getXeroLockGuardErrorResponse` omits it for members) — member-facing bodies
stay the generic wording so they disclose no Xero connection state. The code
(`XERO_LOCK_DATE_CHECK_FAILED`) and status (503) are unchanged for both.
Independently, admins can run a **click-only connection-health probe**
(`GET /api/admin/xero/status?probe=1`): it refreshes the token and reuses the
cached lock-date/org read, returning `tokenHealth` of
`ok | reconnect_required | rate_limited | error`, and is cached server-side
30–60s so repeated clicks make no extra Xero call. A daily-limit cooldown maps
to `rate_limited` **without any API call** (the in-process gate throws before the
network request), so the probe can never burn the shared daily budget; it never
runs on page mount or a poll. The most recent recorded usage `errorMessage`
(redacted) is surfaced alongside the health chip.
The same guard protects the **booking modify paths**
(`xero-period-lock-guard`), with two deliberately asymmetric scopes:
- **Admin override** (#1697): a **recalculate** override can queue a
  **check-in-dated primary-invoice write** — the invoice date/narration update
  on a booking whose payment is not yet settled, or the invoice create a
  zero-dollar recalculate performs — and is rejected (same 409/503 contract, at
  the modify-quote preview and at apply in both modify services, before their
  transactions) when the check-in the booking would end up with lands on or
  before the effective lock date; a check-out-only recalculate is guarded via
  the unchanged past check-in. Supplementary invoices and modification credit
  notes are dated at the day they are raised (not check-in), so on an
  already-paid booking a recalculate writes no check-in-dated document — the
  override guard **still fires there by design**: **deliberately conservative,
  a settled owner decision** (#1697, re-affirmed and closed on #1718 —
  workarounds for the over-block on paid bookings are shift mode or briefly
  unlocking the period).
- **Ordinary (non-override) date edits** (#1729) get a **NARROW guard** at the
  same pre-transaction points (both modify services and the modify-quote
  preview): it fires only when the edit would **actually queue the
  check-in-dated invoice update** — issued Xero invoice, dates changing,
  payment not settled — via the settlement classifier's own predicate
  (`wouldQueueCheckInDatedInvoiceUpdate`, shared so guard and
  `queueXeroBookingEditSettlement` can never drift). Error text is
  **actor-appropriate**: admins get the unlock instructions, members get a
  "contact an administrator" 409 (and a softer fail-closed 503) — same codes
  either way; a member's request against a booking they do not own skips the
  guard silently (the transaction's 403 answers it — no lock-date disclosure
  to non-owners). **Identity-only edits (guest name fixes) are never guarded**
  (owner decision, #1729): the outbox backstop covers that rare strand rather
  than blocking a typo fix. Also outbox-backstopped, not guarded: the
  check-in-dated invoice CREATE a $0-collapsing ordinary edit can queue for a
  never-invoiced booking, and guest-range edits that move the stay envelope
  without date fields in the request.

### INV-LOCKOUT-041

**Shift overrides are exempt**: a shift writes no Xero documents.
As at create, only past check-ins are guarded.
Over-capacity nights on **any on-behalf create** — past (#1695) or
future-dated (#1767) — are **warn-and-confirm** (the same
`OverCapacityConfirmationRequiredError` → 409 `OVER_CAPACITY_CONFIRM_REQUIRED`
contract as #1668, capacity lock still taken, `capacityOverridden` recorded),
with one carve-out: an on-behalf create that opted into the **waitlist
fallback** keeps the capacity-exceeded outcome so the route can create the
WAITLISTED booking instead of prompting. (The former v1 carve-out that
hard-blocked a **non-member hold-eligible (PENDING) party** was retired by
#1771: the persisted override is now honoured by `cron-confirm-pending`, so the
hold re-check confirms rather than bumps the overbook.) A **member self-create
can never overbook**: without `isOnBehalf` the service keeps the hard capacity
block regardless of any flag, and the route rejects the flags outright (403
non-admin, 400 without `forMemberId`).
The member confirmation / hold email is an **explicit per-create choice**
(`notifyMember`, honoured only for on-behalf creates) recorded in the
`booking.created_on_behalf` audit metadata alongside `allowPastDates`,
`confirmOverCapacity`, and `capacityOverridden`; `sendAdminNewBookingAlert` and
the Xero invoice email are unaffected by the choice.

### INV-LOCKOUT-042

A **deliberately over-capacity booking is never destroyed by a later capacity
re-check** (#1771). Every over-capacity admission — on-behalf create
(#1668/#1695/#1767), date/batch modification (#1668), waitlist force-confirm,
confirm-pending-guests overbook (#1366), and admin capacity-hold (#1764) —
**persists** the decision on the booking as `Booking.capacityOverriddenAt` +
`capacityOverriddenByMemberId`. The marker records "a deliberate overbook on the
booking's **current** nights": one-shot admissions stamp it once, while the date
and batch modification services **reconcile** it (re-stamp if the new range is
still an admin-confirmed overbook, **clear** it if the change moved the booking
back within capacity) because they re-evaluate capacity on the new nights — so a
stale flag can never suppress a legitimate cancel after a booking is modified
from an over-capacity range into a fitting one. It is not cleared on cancel (a
cancelled booking never re-enters a re-check). Every payment-time / settlement
capacity
re-check — `markBookingPaymentSucceeded`, payment links, `cron-confirm-pending`,
`charge-saved-method`, `switch-to-internet-banking`, the Internet Banking
invoice-paid reconcile, and group settlement — **must** consult
`bookingHasCapacityOverride(booking)` and, when set, settle/advance the booking
to its correct terminal state instead of cancelling+refunding, 409ing, or
bumping it. The DRAFT-scoped re-checks (`create-payment-intent`,
`confirm-draft`) are exempt because #1767 prevents a DRAFT from ever carrying an
override. Members can never overbook, so this marker only ever appears behind an
explicit, audited admin act.

### INV-LOCKOUT-043

A **finished stay's card obligation never lingers unseen** (#1709, #1723). Two
**disjoint** admin queues surface every uncollected card obligation on a stay
whose check-out is on or before NZ today, both driven by the shared
predicate/href helpers in `src/lib/unpaid-finished-stays.ts` (the dashboard
attention cards, the sidebar Needs Attention badges via
`admin-pending-counts`, and the bookings-list deep links all consume the same
helpers so the surfaces can never drift):

- **Unpaid finished stays** (#1709/#1731): `deletedAt` null +
  `status = PAYMENT_PENDING` + `checkOut ≤ today` — the whole booking price is
  still owed (a retroactive card create qualifies from the moment of
  creation). Deep link:
  `/admin/bookings?status=PAYMENT_PENDING&checkOutTo=<today>`.
- **Unsettled finished-stay additions** (#1723 path 2, owner decision B — the
  card additional-payment flow stays): `deletedAt` null + `checkOut ≤ today` +
  `status ∈ {CONFIRMED, PAID, COMPLETED}` + payment
  `additionalAmountCents > 0` with `additionalPaymentStatus` null or not
  `SUCCEEDED` — a settled stay whose upward modification delta (admin
  recalculate, guest add, date change) was never collected. The payment
  summary columns mirror the LATEST ADDITIONAL payment transaction. The
  in-memory twin of this predicate is `isAdditionalPaymentOwed`
  (`src/lib/additional-payment-chase.ts`), which takes the booking status as a
  REQUIRED argument for exactly this reason: cancelling a booking leaves
  `additionalAmountCents` and `additionalPaymentStatus` untouched, so an
  amount-only test reads a cancelled booking as still owing. `PAYMENT_PENDING`
  is deliberately excluded so the two queue counts can be summed without
  double-counting a booking — a narrowing for counting, NOT a claim that such a
  delta is uncollectable (see "Who may pay one" below [INV-ADDPAY-023]). Deep link:
  `/admin/bookings?additionalOwed=owed&checkOutTo=<today>` via the bookings
  list's `additionalOwed` filter (AND-composed, so explicit status/date
  filters in the same URL still narrow).
- **Unsettled additions on a stay still ahead** (#2350): the same predicate
  with `checkOut > today` instead of `checkOut <= today`, so the two halves are
  disjoint by construction and their counts sum without double-counting. This
  is the half that can still be chased while the member is paying attention;
  the finished half is a follow-up conversation. The dashboard shows one card
  with a split label ("N upcoming, M finished") and the sidebar badge shows the
  sum, both deep-linking to `/admin/bookings?additionalOwed=owed` - the whole
  queue, with no date bound, because the bookings list has no upcoming-only
  filter to point at.
