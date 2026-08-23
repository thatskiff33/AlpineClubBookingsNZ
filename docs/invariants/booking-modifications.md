# Booking Modifications

Audience: Developer, Agent.

Prefix defined in this file: **`INV-MOD`** — what an edit to an existing booking
may change, what it must keep, how nights and prices are re-derived, and which
policies a modification is still held to.

Read this file when you are changing how an existing booking's dates, party or
price are edited.

Index: [`docs/DOMAIN_INVARIANTS.md`](../DOMAIN_INVARIANTS.md) — every `INV-*` ID
with a one-line description of what it covers. ID scheme and allocation rules:
[`SCHEME.md`](SCHEME.md).

The source's `## Booking Modifications` section also carried adult-member
hosting, booking requests, subscription-lockout pricing, policy exceptions and
additional-payment chasing. Those live in their own files under the same index
heading; this file holds the modification rules themselves.

Every heading below whose whole text is an `INV-*` ID defines that invariant. IDs
are permanent: never renumbered, never reused. **The text under each ID is a
verbatim move from the source document and must not be reworded in place** —
only the ID heading lines were added.

## INV-MOD-001

Booking changes must not orphan or desynchronize:

- Guests and per-guest stay ranges
- Payments and PaymentTransaction rows
- Refunds and member credits
- Xero invoices, payments, credit notes, and object links
- Bed allocations
- Audit records
- Emails and notification state
- Waitlist and capacity decisions

## INV-MOD-002

Positive deltas, negative deltas, credits, refunds, and additional payments must
remain traceable to the original booking and modification event.

## INV-MOD-003

A modification price increase whose Stripe intent creation fails transiently is
never lost silently (#1358, F29): every additional-intent flow routes through
the shared helper whose failure path enqueues a durable
`CREATE_ADDITIONAL_PAYMENT_INTENT` recovery operation keyed one-per-modification
with the same modification-scoped Stripe idempotency key, so the replay collects
exactly once; exhausted retries alert the admins with the member, booking, and
amount, and stalled or exhausted queues surface through the recovery health
checks. The recovery processor is execution-time honest about lifecycle: a
booking CANCELLED after the modification completes the operation WITHOUT
minting an intent — cancellation already tore down its additional intents, and
recovery must never resurrect a retired collectable or re-arm the parked
supplementary Xero operation for money that must not be captured (the
stale-WAITING_PAYMENT reaper retires that op).

## INV-MOD-004

Per-guest stay ranges must sit inside the parent booking's checkIn/checkOut
envelope (both are half-open night ranges per the stay-boundary invariant in
"Booking Dates And Capacity"). A guest stay range outside the current envelope
is not rejected —
it auto-expands the booking's dates (issue #713). The database enforces the
envelope as a safety net with deferred constraint triggers
(`BookingGuest_stay_range_within_booking`,
`Booking_dates_consistent_with_guests`) that validate at COMMIT, so a
transaction may widen guest rows before the parent booking row; only the
committed state must satisfy the invariant. The modification services call
`assertBookingEnvelopeInvariants` (`SET CONSTRAINTS … IMMEDIATE`) as the last
statement of their transactions so a violation is attributed to the calling
service rather than surfacing as an anonymous commit failure; the modify
routes recognise the constraint errors via
`isBookingEnvelopeInvariantViolation` and return a clean 500 instead of
leaking raw trigger text to the client.

## INV-MOD-005

Nightly prices lock at booking time: every edit path — batch modify, date
change, guest add, single-guest removal, and the modify-quote preview — prices
only the changed guests/nights at current season rates. A night a guest
already bought keeps the price stored on its `BookingGuestNight` row, so a
season-rate change between booking and edit never rolls into unchanged nights
(adding one guest costs exactly that guest's price; removing one returns
exactly theirs, policy permitting). Edits also price each untouched guest over
exactly the night set they hold (#1093): a partial-stay guest never grows
phantom nights because an unrelated guest was added or removed. A booking date
change is the deliberate reset: it moves every guest — partial stays included —
onto the full new range (the batch-path policy) and re-syncs their
`BookingGuestNight` rows to the newly priced nights, and a guest added mid-life
gets night rows at creation so later edits honour the prices they joined at.
The waitlist offer reprice is the other deliberate exception: an offer re-bases
the whole booking at current rates before the member confirms, and the offer
email states that price. Legacy guests without stored night rows price at
current rates; a one-off backfill migration (#1098) synthesised rows for
pre-#713 guests on live, non-quote-priced bookings (stored price split evenly
across the stay envelope, integer cents, remainder on the first night), so
that fallback now covers only quote-priced bookings — already protected by
the #1032 edit block — and rows created outside the app.

## INV-MOD-006

Every edit path passes the default group discount into pricing exactly as
creation and the waitlist reprice do (#1095), and locks win over the discount:
a night a guest already bought keeps its locked (discount-inclusive) price, so
a party dropping below the minimum on removal never loses a discount it
bought, and the discount applies only to newly priced nights — a guest added
to a qualifying party, or nights a date change adds. Eligibility is per night
and per party size on that night: a partial-stay guest's absent nights do not
count toward the minimum. The modify-quote preview prices with the same
config so previews match what the mutating paths charge. The guest-add route
therefore prices the whole post-add party in one pass — the added guest's
stored price and night rows are their slice of the combined breakdown.
**Every edit path means the in-progress planner too** (#2756): it priced each
guest alone with no config, so the party size the rule saw was always one and a
night an edit to a stay already under way BOUGHT carried no discount while the
same night bought a day earlier did. It now prices the party in one pass per
window, and the same two rules govern which nights move — locks win, and only
newly priced nights are discounted. INV-MOD-025, which is
`buildInProgressGuestRangePlan`'s own rule, states how — and states the property
that keeps it safe: a night the guest keeps is valued identically on both sides of
the edit, so no held night is re-rated when the party crosses the minimum in
either direction.

**"Passes the discount into pricing" includes the season's `type`, and every edit
path had been failing that half in silence** (#2756). `summerOnly` is `true` by
`prisma/schema.prisma`'s default, by `DEFAULT_GROUP_DISCOUNT_SETTING` and by the
admin section's own default, so `isGroupDiscountApplicable` tests
`findSeasonForDate(night, seasons)?.type === "SUMMER"` for the configuration a real
club is most likely in. `SeasonRateData.type` is optional, and all five edit paths
— the modify quote, the modify apply's `loadActiveSeasonRates`, the guest-add
route, the date-modification service and the guest-removal service — hand-rolled a
four-key season literal that omitted it, while every creation path mapped through
`toSeasonRateData` and carried it. So a default-configured club had its booking
discounted when it was made and **every later edit priced at the full rate**,
whichever planner ran: the parity this invariant asserts was false in exactly the
direction that costs the member money, and no test could see it. All season
loading now goes through `toSeasonRateData`, which is the ONLY production mapping
by census, because a second one is free to drop the field again and the type system
cannot object. Correcting this changes prices on ordinary (not-in-progress) edits
too at any summer-only club with the discount enabled — it is the same defect, not
a separate one, and the fix could not be confined to the in-progress branch
because both branches read the same season array.

The **substitution's two consequences** reach every path this invariant covers,
including the in-progress planner since #2756: a `rateMembershipTypeId` whose rows
are dearer than `NON_MEMBER`'s makes a qualifying night cost MORE, and a
substituted type with no row for some age tier in some season throws where the
guest's own type would have resolved. The admin group-discount route validates
neither. Members are never affected (only `NON_MEMBER_DEFAULT` is substituted —
INV-MOD-007).

Since #2770, **"the default group discount" an edit path passes means the value
`toEditTimeGroupDiscountConfig` resolves**, which is absent when the club has
switched `GroupDiscountSetting.applyToEdits` off — the one club-controlled
qualification on this rule, stated in full as INV-MOD-026. Nothing else here
moves: every edit path still passes the SAME resolved value, both planner
branches included, and locks still win over it in both states of the switch.

## INV-MOD-027

A booking officer may price a guest who is **currently on the club's non-member
rate** at the club's own member rate instead, as a recognised member of a partner
lodge, and that election changes the RATE and nothing else (Other Lodges epic,
follow-up to #2749; eligibility widened by #2978).

`Booking.otherLodgeId` names the partner lodge for the whole booking;
`BookingGuest.otherLodgeMember` is the per-person opt-in. A flagged guest
resolves to the built-in `FULL` type's rate rows with `rateSource`
`OTHER_LODGE_MEMBER`, at that guest's own age tier — resolved in
`resolveGuestRateMembershipTypes`, the one gate every pricing path already
passes through (INV-MOD-007), so no write path can be missing the rule.

**WHO MAY BE ELECTED IS A RATE QUESTION, NOT AN `isMember` QUESTION (#2978).**
The eligible set is everyone the club currently charges its non-member rate, and
that is NOT the same as everyone with `isMember` false: a non-member contact
created by book-on-behalf and later re-added through the member-guest finder
carries `isMember` true while resolving to the built-in `NON_MEMBER` type, and
those people are exactly who a reciprocal rate is for. `resolveOtherLodgeRateEligibleGuestIds`
(`src/lib/membership-type-policy.ts`) is the single answer: the edit panel decides
which rows get a tick box from it, and `resolveOtherLodgeRateElection` refuses a
tick on anybody outside it, so the screen can never offer a control whose save is
refused.

**One class is excluded on purpose: a member who owes this club a season
subscription.** Under `NON_MEMBER_PRICING` they are `isMember` with
`NON_MEMBER_DEFAULT` — the same rate source a true non-member carries,
deliberately, so the group discount treats them alike (see the note in
`resolveGuestRateMembershipTypes`) — so the rate source alone cannot separate
them and `isMember` plus the unpaid set does. Electing them would restore the
member rate and silently undo a lockout the club configured on purpose, which is
a money outcome, so both the API boundary and the rate resolver refuse it.

**Owing the subscription withholds the tick under EVERY lockout mode** (owner
decision, 21 Aug 2026). It is not conditional on the club having chosen
`NON_MEMBER_PRICING`: the fact that matters is the debt, not the club's chosen
response to it, and `MembershipLockoutSettings.mode` defaults to `HARD_BLOCK`, so
a mode-gated rule would have left the DEFAULT configuration offering the club's
own member rate to an unpaid member on a `NON_MEMBER_RATE` membership type.
`NO_BLOCK` was considered and deliberately included. In code the two questions
are separate functions on purpose: `resolveMemberIdsOwingSubscription` answers
"do they owe us one" for the OFFER, and the mode-gated
`resolveUnpaidSubscriptionRepricedMemberIds` answers "does the club charge them
non-member rates" for the REPRICE. Nothing about the offer rule moves money on an
existing booking: a flag already stored keeps pricing exactly as it did.

**Why a lapsed member of this club who is paid up at a partner lodge still gets
no tick, and why that is intended rather than a bug.** It looks harsh, and it was
put to the owner as its own question. Letting reciprocity win there would let
anybody lapse their subscription, claim membership of a partner lodge, and keep
paying the member rate indefinitely — the lockout exists precisely to chase an
unpaid subscription, and somebody in that position does still owe this club one.
It was weighed against offering the tick with an officer-facing warning, and the
clean rule was preferred. The officer is told the tick is withheld and why (see
[the booking officer's guide](../guides/bookings.md) and
[Subscription lockout](../guides/subscription-lockout.md)); the way to apply the
reciprocal rate to that person is to settle their subscription, not to work
around the rule here.

**Eligibility answers `bookingBehavior === "NON_MEMBER_RATE"`, not
`!== "MEMBER_RATE"`.** The third value, `BLOCK_BOOKING`, means "may not book at
all", which is not "is on the non-member rate"; the looser test admitted it, and
was unreachable only because `assertMembershipTypeBookingAllowed` refuses such a
guest earlier in every pricing path. A money fence must not depend on an
unrelated guard continuing to exist.

**A stored flag records what was CHARGED, never what was asked for.** The
election fence is judged against the stored booking rows while pricing is judged
against the proposed rows, which the `INV-MOD` placeholder→member link has
already rewritten — so a request that links a placeholder to a member and ticks
them passes the fence while pricing correctly resolves the member's own type.
`applyGuestChanges` therefore writes `otherLodgeMember: true` only for guests the
pricing pass resolved to `OTHER_LODGE_MEMBER`
(`PricingResult.otherLodgeRatedGuestIds`), while an untick always clears the flag
— gate the clear and a stale flag could never be removed. For the same reason an
election is never price-preserving: it may not take the identity-only pricing
echo, which would write the flag without running the rate resolver at all.

**`isMember` is never written by this election, permanently and deliberately.**
The tick records that somebody is a member of ANOTHER club and says nothing about
their standing in this one, so adult-member hosting (`INV-HOST`), the non-member
hold, split bookings, `Booking.hasNonMembers`, the member-guest subscription gate
and member-only promotions all keep seeing exactly what they saw before it.
Only the rate resolver reads the flag, which is what confines the blast radius to
price — and the resolver re-checks eligibility itself, so a row that somehow
carries the flag without qualifying still resolves through the ordinary rules.
The API refusal is the first fence, not the only one.

**An election-only edit is EXEMPT from the quote-priced edit block, on both the
preview and the save** (owner decision, 21 Aug 2026). A booking converted from a
public request is quote-priced: its guest rows carry a split of a total an
officer negotiated, and `QUOTE_PRICED_EDIT_BLOCK_MESSAGE` normally refuses any
edit that would disturb that basis. The tick is exempted because it does not
renegotiate anything — it records that somebody belongs to a partner lodge and
applies the rate the club has already agreed to give such people. That is the
same character as the `INV-MOD` placeholder→member link, which was exempted
first and is the precedent this follows. **This was decided, not overlooked.**

The exemption is **election-ONLY**, and that fence is what makes it safe: pair
the tick with a date move, a guest added or removed, a per-guest stay range or a
promotion and the block applies again in full, because those genuinely do move
the negotiated basis. Every guest the election does not name keeps their locked
split price, since only the ticked and unticked rows have their locks cleared.
It is officer-only, matching the resolver's own admin refusal.

**One predicate answers it for both paths**
(`requestIsOtherLodgeRateElectionOnly`), and that is deliberate rather than
tidiness. The preview and the save each used to carry their own hand-written
list of disturbing fields — and the save's list did not exist at all, so an
election-only edit on a negotiated booking previewed 200 and then saved 400, on
precisely the bookings these guests arrive through. Two lists drift; one cannot.
For the same reason an election never takes the identity-only price-preserving
echo: that path writes the flag without running the rate resolver, so the tick
would land and the money would not move.

**The election is an END STATE, and the guests whose flag CHANGES are exactly the
guests whose locked nights are cleared.** `resolveOtherLodgeRateElection`
(`src/lib/booking-other-lodge-rate.ts`) is shared verbatim by the modify-quote
preview and by `prepareGuestPlan` on the save, so the rows the officer was quoted
are the rows the save reprices and the flags it writes. Clearing the locks is
load-bearing in BOTH directions and for the reason INV-MOD-005 gives: a ticked
guest whose nights stay locked at the non-member price never reaches the member
rate, and an unticked guest whose nights stay locked at the member price never
leaves it. A guest whose flag did not change keeps their locks, so an unrelated
edit reprices nobody. Because the locks are cleared, the guest is correctly
re-snapshotted under INV-MOD-010 and the Xero hut-fee line follows the rate.

**The gates are admin-only, non-member-only, and lodge-required**, enforced in
the shared resolver rather than at each call site: a member self-service request
that carried the fields is refused 403 however it reached the resolver, a tick
naming a member of this club is refused, and a tick with no lodge behind it is
refused so no booking can carry a member-rated guest with no club recorded
against them. Clearing the lodge clears every tick with it.

**It is refused on an in-progress (mid-stay) edit**, on the same evidence as the
#2337 link (`GUEST_MEMBER_LINK_IN_PROGRESS_MESSAGE`): `buildInProgressGuestRangePlan`
prices the STORED guest rows rather than the election-modified pricing rows, so a
mid-stay election would stamp the flag and settle $0. Preview and save refuse
identically, so the officer sees the refusal rather than a phantom $0 quote.

**It is exempt from the quote-priced edit block when it rides alone**, again
mirroring #2337. A booking converted from a public request is quote-priced and
carries an even split of the negotiated total (#1032 blocks ordinary edits so
nothing disturbs that basis) — but the public request form is exactly where the
"member of another lodge" answer arrives, so re-rating one named person
afterwards is the officer's deliberate act, not an ordinary edit. Every guest not
re-rated keeps their locked split price. Pair the election with a date change or
a guest add and the ordinary block applies again.

## INV-MOD-026

A club decides whether a booking **edited later** earns its group discount on
the nights that edit newly buys, and that decision is one stored value governing
every edit path (#2770, owner decision on #2756, 10 Aug 2026).
`GroupDiscountSetting.applyToEdits` is the switch — it belongs to the discount,
not to a code path — and `toEditTimeGroupDiscountConfig` in
`src/lib/policies/booking-route-decisions.ts` is the only place it is applied.
Every edit path resolves its config there and nowhere else: the ordinary planner
(`calculateModifiedPricing`), the date-modification service, the guest-add
route, the single-guest-removal service, the modify-quote preview — whose answer
must be the one the save path then charges (#1095) — and the promo-code validator
when it is previewing an edit rather than a first purchase. **The in-progress
planner is covered by those same resolutions rather than by a sixth one**: since
#2756 both `calculateModifiedPricing` and the modify-quote route read the setting
ONCE and hand that one gated value to `buildInProgressGuestRangePlan` and to the
ordinary pricing pass alike, so the two planner branches cannot disagree about a
night's price. There is deliberately no second gate, because the defect this
switch was added alongside was one planner reading a different config from every
other path (#2756) — a two-tier price for the same night at the same club — and
one chokepoint is the only shape that stays true as paths are added.
`group-discount-edit-switch-census.test.ts` scans the tree and fails the build
when an edit path resolves the discount through the creation mapper
(`toGroupDiscountConfig`) instead, when any caller of
`buildInProgressGuestRangePlan` is not a declared edit path, and when any file
outside the mapper home hand-rolls a group-discount config literal instead of
calling a mapper at all — the shape that hid the promo-code validator from the
#2756 census. The two mappers differ by one boolean and nothing in the type
system can tell a mistake from a choice.

**The default is ON, and the default is what every club already had.** Every
edit path already passed the discount into pricing (INV-MOD-006), so the column
defaults to `true`, the migration installs that constant default on the existing
singleton row, and no club's prices move because the switch exists. Turning it
off is a deliberate club act.

**Off is the absence of a discount, not a second discount rule.** The mapper
returns `undefined`, so the nights an edit buys travel the same code path, with
the same absent config, as they do at a club that never enabled the discount at
all — which is what makes an off club price byte-identically to today's
undiscounted answer rather than approximately.

**Neither state re-rates a night anybody already bought.** A night a guest holds
carries its stored `BookingGuestNight.priceCents` as a locked price
(INV-MOD-005), and pricing honours a lock regardless of any config passed here,
so flipping the switch — in either direction — changes no price already charged
and reprices no history. The one place the switch is observable on a night
nobody is buying is the degradation INV-MOD-005 and INV-MOD-025 already name: a
legacy guest with no stored night rows prices at current rates, and with the
switch off those rates are undiscounted. That is the club's stated intent for
the edit rather than a reprice — no stored price is overwritten — and it is why
the removal service is gated with the rest rather than left on the creation
mapper: one value per edit is the invariant, so a club cannot have its add
priced one way and its removal another.

**A first purchase is not a later edit, and is not gated.** Booking creation,
the public quote, a group booking, a school or booking-request approval, and the
waitlist offer reprice that re-bases a booking at current rates before the
member confirms all keep using `toGroupDiscountConfig`. None of them is an edit
to nights somebody already holds; the offer email must quote the price the
confirm will charge, and the switch is about what an edit *adds*.

**When it is off, the quote says so — but only when the discount would otherwise
have reached this stay.** The modify-quote response carries
`groupDiscountEditNotice`, and the edit panel renders it beside the number in the
same slot as the subscription-rate notice. It is non-null only when the club runs
a group discount, has switched it off for edits, AND the same edit priced through
the ungated creation mapper would actually have been discounted — so an officer
editing a party below `minGroupSize`, or a winter stay at a `summerOnly` club, is
not told a discount was withheld from a number that would have been identical
either way. That makes the notice quote-level rather than club-level, which is
what D2 asked for: it explains a number that went up. The mutual exclusion still
holds — a response can never carry both the notice and a group discount — because
the switch remains the outer condition. The admin control states the policy where
it is set, so the person who turned it off can see what they turned off.

## INV-MOD-007

Hut nightly rates are keyed by membership type, not a member/non-member boolean
(#1930, E4). `MembershipTypeSeasonRate` holds one rate per `(season, membership
type, ageTier?)`: each `MEMBER_RATE` type carries its own rows, non-members
price via the built-in `NON_MEMBER` type, and `NON_MEMBER_RATE` (except
`NON_MEMBER`) and `BLOCK_BOOKING` types carry **zero** own rows — the resolver
never consults them (testable invariant). A type prices per age tier when
`ageGroupsApply` is true, or from a single `NULL`-ageTier flat row when false;
the engine prefers an exact tier row and falls back to the flat row. The rate
resolver classifies every guest as `OWN_TYPE` (a `MEMBER_RATE` member on their
own rows), `NON_MEMBER_DEFAULT` (a true non-member on the `NON_MEMBER` rows), or
`TYPE_POLICY_FORCED` (a member whose type forces the non-member rate, priced on
the `NON_MEMBER` rows). A missing rate for a type × active season is a hard
throw at pricing plus a setup-readiness warning. The group discount no longer
flips a boolean: it substitutes `GroupDiscountSetting.rateMembershipTypeId`
(seeded to `FULL`) **only** for `NON_MEMBER_DEFAULT` guests, so members keep
their own type's rate and `TYPE_POLICY_FORCED` members are excluded — the two
load-bearing behaviours the old flip preserved.

## INV-MOD-008

A fourth way to reach `NON_MEMBER_DEFAULT` arrived with #2543: under
`NON_MEMBER_PRICING`, a member whose season subscription is required but unpaid.
That class resolves `NON_MEMBER_DEFAULT` **and not** `TYPE_POLICY_FORCED`, so the
group discount treats them exactly like a real non-member. The distinction is
money, not taxonomy: `TYPE_POLICY_FORCED` is excluded from the substitution, so
labelling the reprice that way charged the repriced member the raw `NON_MEMBER`
rate on every discounted night while the genuine non-member beside them paid the
substituted (`FULL`) rate — 2400 c/night against 1000 c/night on the seeded
fixture, i.e. 2.4x the rate the club actually charges non-members on that booking,
and an outcome where the member is better off if the club deletes their membership
record. The owner's rule is "priced at non-member rates", so they are priced at the
rate a non-member pays. `TYPE_POLICY_FORCED` itself is untouched — a membership
type the club deliberately configured onto non-member rates stays outside the
discount, exactly as #1930 decided.

## INV-MOD-009

**Membership, not the subscription, gates member-only promotions.** A repriced
member keeps `isMember = true`, and `selectPromoDiscountGuests` filters
`memberGuestsOnly` promotions on that flag, so a repriced member remains eligible
for a member-only promo and can therefore pay LESS than the non-member beside them.
That is deliberate and stated rather than incidental: their MEMBERSHIP is intact and
in good standing — only the subscription is unpaid — and the owner's rule speaks to
rates, not to member benefits. A club that wants the promotion withheld too should
say so; the change would be to gate the predicate on `rateSource` rather than
`isMember`, which is a separate decision about member benefits and not part of the
repricing rule. Pinned by a test, so the behaviour cannot drift silently either way.

## INV-MOD-010

Every priced guest stores a `BookingGuest.rateMembershipTypeId` snapshot — the
type whose rows priced it (the resolved type, never the per-night discount
substitution). Xero line building reads the snapshot to pick the hut-fee item
code. The snapshot is **not** write-once: modify/reprice flows (waitlist offer
reprice, date change, guest add/removal) recompute and overwrite it for
repriced guests alongside `priceCents`; a guest who **keeps any locked night** keeps
both its price and their stale snapshot untouched
(`rateSnapshotUpdateForRepricedGuest`, applied on the batch-modify, date-change and
single-guest-removal writes). That guard is what makes the promise true rather than
aspirational: the snapshot is per GUEST, the locked prices are per NIGHT
(`BookingGuestNight` has no rate-type column), and Xero resolves ONE item code per
guest and applies it to every night run of that guest even though runs are split by
price change. So overwriting the snapshot on a stay that mixes locked and
newly-priced nights posts the locked MEMBER-rate nights under the newly resolved
NON_MEMBER item code. Pre-#2543 the trigger was a mid-booking membership-type
change, i.e. rare; #2543 made it the ordinary case for any unpaid member editing a
booking in a `NON_MEMBER_PRICING` club. The residual, stated plainly, is that such a
guest keeps the OLD item code for the newly priced nights too — the same direction
the locked price itself takes, and the only per-guest answer available until an item
code can be resolved per night run. A guest whose locked prices were deliberately
CLEARED (the #2337 placeholder→member link, which reprices the whole stay) has no
kept locked night and is correctly re-snapshotted. A `NULL` snapshot (pre-refactor booking) falls
back `isMember → FULL / NON_MEMBER` forever. Because the day-one fan-out
backfill copied the old member rows/codes to every `MEMBER_RATE` type and the
non-member rows/codes to `NON_MEMBER`, existing bookings and invoices resolve
byte-identically under the new key.

## INV-MOD-011

Every booking-reduction path — batch modify (`removeGuestIds`/date change),
single-guest removal (`DELETE …/guests/[guestId]`), and date change
(`modify-dates`) — returns member money limited by the same cancellation-policy
tier for the days until check-in, folding any change fee into the net delta, and
requires the member to elect a card refund or account credit whenever a captured
payment makes a settlement returnable. No reduction path refunds the full price
delta outside the policy. A request against a booking with a captured payment
that omits the settlement election is rejected rather than defaulted, so a
body-less self-removal cannot silently settle the booking owner's money; the
owner or an admin makes the election through the batch edit flow.

## INV-MOD-012

A pre-payment reduction can drop `finalPriceCents` BELOW the account credit
already applied at booking-create (F20, #1887). Every modification apply path
that reprices (batch modify and single-guest removal via
`applyLifecycleTransitions`, date change via its own settlement block) re-derives
the applied credit in-transaction, under the member-credit ledger lock, and
refunds the over-consumed slice back to the member (an append-only positive
`BOOKING_APPLIED` offset that nets the applied credit down to the new price and
returns the excess to the member's balance). The zero-dollar auto-pay decision
then keys on the EFFECTIVE (credit-reduced) price, not raw `finalPriceCents`,
mirroring booking-create: a reduction that lands the booking fully
credit-covered auto-confirms it at $0 instead of dead-ending as unpayable at the
card-intent guard (which rejects `effectivePriceCents <= 0`) with the member's
credit over-consumed. The clamp is gated on the LEDGER (a cheap unlocked
`deriveBookingAppliedCreditCents` read) plus a pre-payment status
(PENDING/PAYMENT_PENDING), NOT the payment's `creditAppliedCents` mirror (F1,
#1887): a CARD booking has no `Payment` row until it requests a card intent, so
the mirror gate missed exactly that surface and left the booking dead-ending
unpayable with credit over-consumed. A no-credit modification reads the ledger
once, finds nothing, and never takes the member-credit lock or writes a row —
byte-for-byte unchanged. The clamp is idempotent under transaction re-drive.

## INV-MOD-013

Because the clamp only fires in PENDING/PAYMENT_PENDING, a modification parked to
AWAITING_REVIEW does NOT refund credit or auto-$0-pay before an admin approves it
(F4, #1887), matching booking-create's under-review block on the zero-dollar
path; the release-from-review transition lands PAYMENT_PENDING, at which point the
clamp runs.

## INV-MOD-014

Xero deallocation on Internet-Banking bookings (F3, #1887): the positive clamp
offset and `APPLIED_CREDIT_DEALLOCATION` outbox operation commit in the SAME
member-credit-locked transaction. The worker later obtains Xero's real
allocation IDs, checkpoints them, deletes the invoice allocations, recreates the
reduced integer-cent target, verifies it, then reduces the local allocation
slices. Before releasing the member lock it atomically snapshots the desired
signed-ledger cents and every precise slice into the same durable operation.
Inbound repair, a later clamp, and allocation planning inspect that RUNNING (or
provider-ambiguous FAILED/PARTIAL) fence while holding the same member lock, so
each mutation is wholly before the snapshot or deferred until convergence; no
stale target can release newly valid credit. Multiple notes and multiple local
lots per note are supported.

## INV-MOD-015

After verification, the same local transaction deactivates the superseded
synthetic/actual `APPLIED_CREDIT_ALLOCATION` row links (or the Payment-scoped
`APPLIED_CREDIT_REMAINDER_ALLOCATION` link for a minted remainder) and creates
active replacements keyed by the actual allocation IDs returned by Xero. A zero
target has no active allocation link. Durable checkpoint history records every
row's current/target cents, prior links, Xero-read IDs/amounts, and the provenance
rule used for an equal-total match, so a crash after provider recreate can heal
local link truth without another create.

## INV-MOD-016

Crash/retry contract: partial deletes resume only checkpointed IDs; a crash after
provider recreate but before the local update verifies the target and completes
the local reduction. Simultaneously claimed allocation/deallocation workers for
one Payment return their transient losers to PENDING; a subsequent scan executes
them without overlap instead of stranding both FAILED. A provider total that is
neither exact local state nor a checkpointed
partial/target is ambiguous (for example, a manual Xero edit): the operation
fails visibly for operator retry/manual review and never guesses an ID or amount.
One narrow exception is not a genuine failure: a post-delete+recreate re-GET (or
the next retry's top-of-loop guard) whose total is explained purely by Xero
eventual consistency relative to the durable BEFORE_DELETE/PROVIDER_VERIFIED
checkpoints — a just-deleted allocation still listed, or a just-created recreate
not yet listed (all visible IDs are checkpointed-or-the-recreate) — is
classified transient and requeued to PENDING with backoff (bounded; repeated
non-convergence still lands terminal FAILED for the operator). Only totals or ID
sets that no eventual-consistency projection explains stay terminal.
The admin retry action never invokes either multi-call applied-credit handler
inline: one atomic FAILED/PARTIAL-to-PENDING compare-and-set wins, then the
outbox's PENDING-to-RUNNING claim remains the sole provider-call authority.
Never-captured cancellation and Internet-Banking hold expiry derive the
invoice's allocated credit from the precise positive
`MemberCreditNoteAllocation.amountCents` aggregate, not the coarse historical
`MemberCredit.xeroCreditNoteId` stamp, which cannot represent a partial clamp.
Only those two paths take the member lock and fence: they defer the entire
transition while an `APPLIED_CREDIT_DEALLOCATION` is PENDING, RUNNING, FAILED,
PARTIAL, or WAITING_PAYMENT. This prevents either transition from freezing a
clearing-note amount against the pre-clamp slices; after the worker reaches
COMPLETE, the retry reads the converged target slices. The paid/captured cancel
(refund) path does not take this fence: it restores credit from the payment
mirror (a mirror-based, capped restore) and never sizes any clearing amount
from slices, so no slice-derived money error is constructible there.

## INV-MOD-017

Inbound/legacy repairs that stamped `BOOKING_APPLIED.xeroCreditNoteId` without
creating a precise slice are upgraded under the same transaction lock before
clamp, cancel, expiry, or deallocation reads them. Repair requires exactly one
positive funding lot and enough unallocated cents, creates the
`MemberCreditNoteAllocation` plus active provenance link, and fails closed on
missing or ambiguous provenance. Allocation rows are mutable working slices:
provider-verified deallocation may reduce or delete them. Immutable-equivalent
audit is retained in the deallocation operation's request checkpoint/history
(prior and target cents, provider IDs and match rule) and the inactive/active
`XeroObjectLink` history. Repair validates an existing slice against the signed
ledger rather than accepting it merely because it exists; net-zero historical
negative plus positive-clamp rows never recreate a fully deallocated slice.
When a later unstamped application makes the booking net-negative again, any
active or inactive allocation-link history for the old note/invoice remains a
tombstone and still blocks reconstruction; only provider-observed inbound repair
may recreate working state.
Inbound provider-observed increases/decreases reconcile the precise slice and
append a signed offset instead of rewriting the historical negative application;
superseded allocation links are deactivated, not erased.
Because Xero omits zero allocations from credit-note responses, inbound repair
also diffs active applied-credit allocation links and treats a previously linked
invoice that is now absent as a provider-observed zero target.
Inbound applied-credit reconciliation resolves its payment/member context first
from `CANCELLATION_REFUND` `MemberCredit` rows stamped with the note; when a note
has no such provenance — e.g. an admin-adjustment-minted remainder note — it
falls back to unambiguous LOCAL provenance instead (#1925): the precise
`MemberCreditNoteAllocation` slices stamped with the note joined to their funding
lots, cross-checked against the note's ACTIVE allocation links. That fallback
fails closed (no write, identical to the pre-#1925 skip) whenever the member is
not uniquely identifiable, a slice is missing its funding lot or booking, an
active link references a slice/payment outside the stamped set, or no active link
proves the allocation existed; tombstoned links never resurrect a repair. Every
repaired amount is still derived downstream from the provider targets and precise
slices, so the fallback introduces no amount guess of its own.
Applied-credit provider allocation child operations retain their parent booking,
payment, and operation context. They are never manually replayed inline; retry is
performed only through the serialized parent/outbox workflow so a stale child
cannot recreate credit after deallocation.
Legacy contextless children are also fail-closed by their precise-slice or direct
Payment allocation shape; explicit queued credit-note allocation repairs remain
separate and retryable.

## INV-MOD-018

Every modification path also applies the same lifecycle transitions: a
PAYMENT_PENDING booking whose EFFECTIVE (credit-reduced) price drops to zero
auto-pays with a zero-dollar payment (superseding and cancelling any outstanding
primary PaymentIntents so a stale checkout tab cannot capture the pre-change
amount), any *other* price
change supersedes pending primary intents stranded at the old amount (#1161 —
and belt-and-braces, both intent-issuing endpoints refuse to hand out a
client_secret whose amount no longer matches `finalPriceCents`, and the
Stripe webhook alerts admins before refusing a capture that mismatches the
booking's current total), and the non-member
hold is recalculated from the remaining guests (all-member bookings clear the
hold; bookings inside the hold window or under a disabled hold policy move
PENDING → PAYMENT_PENDING). The same
change must produce the same booking state regardless of which endpoint made
it.

## INV-MOD-019

Self-service edits obey a date-window edit policy (`getBookingEditPolicy`):
future bookings edit freely, an in-progress stay (checked in, not yet checked
out) may only extend its **future** nights with the check-in locked, and a
fully-past stay is not self-editable at all. (The booking stays editable
through its whole check-out day — an edit-window rule, not a presence rule;
the stay-boundary invariant in "Booking Dates And Capacity" is unaffected.)
On an in-progress extension the
minimum-stay policy is evaluated over the **whole contiguous stay**, not the
added nights alone (#2124): because the original check-in is kept fixed, the
modify-quote preview runs `validateMinimumStay` across `[checkIn, newCheckOut]`
(the already-valid original plus the added nights), so a member can extend
their check-out one night at a time even across a weekend minimum-stay rule —
the added night alone would fail the minimum, but the whole stay satisfies it.
A genuinely too-short whole stay is still reported. (The create path evaluates
each new booking's own range, so a separate contiguous one-night booking is
still subject to the minimum — deferred as scope B on #2124.)

## INV-MOD-025

**Not retired, and #2770 records why.** The owner's 10 Aug 2026 decision on #2756
asked for this id to be retired, and #2770's acceptance criterion 5 repeated it.
Following that literally would delete rules that are still true: `SCHEME.md`
requires a retirement to replace the whole body with a one-line notice, and this
body is #2736 (price the nights held, not the envelope), #2743 (sell only the
nights the edit creates, with its four boundary cases) and #2744 (sold-price
valuation, the refund ceiling, the negative-row refusal, the real-rate
write-back) — every one of them still enforced by
`booking-edit-guest-ranges-sparse.test.ts` and cited from
`END_TO_END_TEST_MATRIX.md` and `STATE_MACHINES.md`. What the decision was
pointing at was this id's group-discount carve-out, the sentence that said an
in-progress edit's newly bought nights carry no discount. That is gone: #2756
(PR #2772) removed it, and what remains below is the historical account of how it
was fixed. The question of whether an edit's new nights are discounted is now
answered by INV-MOD-006 and INV-MOD-026 and nowhere else. Raised on #2770 as an
explicit decision rather than settled here.

An in-progress edit prices, quotes and persists a guest over the nights that
guest actually holds — the canonical `BookingGuestNight` set — never over the
`stayStart`/`stayEnd` envelope, which fills a sparse stay's internal gaps
(#2736). `buildInProgressGuestRangePlan` carries the night set through the
plan, and each existing guest's proposed nights are the nights they already
hold that survive the new check-out, plus the genuinely-new nights an extension
buys, which run contiguously from the morning after their **last held night**
(read off the night set, not off `stayEnd`, so a drifted envelope cannot
reopen the gap) and never from before the booking's own **old check-out**
(#2743 — see the next rule paragraph). Everything downstream reads that list:
the future window is
priced night by night through `calculateBookingPrice`'s explicit-nights branch
so seasonal, age-tier and rate-membership-type differences still apply per
night; the per-night amounts (`composeProposedNightPrices`) are computed over
that list rather than by re-expanding a range, so the `BookingGuestNight` rows
written back cover the right nights and a later edit no longer inherits a locked
price for a night the guest never held; the capacity ranges carry
their nights, so no bed is claimed on a night the guest is not there, and the
window those ranges are checked over (`capacityRangeStart`) is the earliest
night any of them actually OCCUPIES rather than the minimum pricing anchor
(#2743) — the anchor reaches back to a guest's own stay end so a check-out-day
extension stays chargeable, and following it would drag the check over past
nights this edit puts nobody on, where an over-capacity night (#1668 override)
or a whole-lodge hold (never admin-overridable, ADR-001 decision 5) would refuse
an extension that adds nobody to it; and a
guest is "active for the future" when they hold a future night, not when a
window is nominally open. Two consequences are load-bearing and must not be
traded away. First, for a **contiguous** stay that runs to the booking's own
check-out — the ordinary one — every one of those outputs is
identical to the pre-#2736 envelope arithmetic, to the cent, to the night and
to the thrown error — that equivalence is what makes the rule safe to apply to
live bookings, and it is proven by re-implementing the old arithmetic in
`booking-edit-guest-ranges-sparse.test.ts` rather than asserted. Second, the
plan reaches the night set through the canonical helpers
(`getExplicitGuestBedNightKeys`, then `expandStayEnvelopeToNightKeys` as the
fallback for a guest with no night rows), so the expander's half-open contract
is untouched (INV-DATE-020) and the bed-allocation planner's one-pseudo-guest-
per-night feed cannot grow a phantom second night. **History is not repriced.**
A booking already edited under the envelope arithmetic — or under the
today's-rate refund and averaged per-night rows this rule also corrects — keeps
the rows and the price it was given; this rule binds edits from here on, and any
correction to a member who was charged or refunded wrongly is an owner decision
and a separate, audited adjustment. **#2745** carries that decision with its
options; it was filed for the gap-night exposure and the #2744 over-refund is
recorded on it as a second, wider one, because that error needed no gap in the
stay to happen — only a season rate that had moved.

**An edit sells only the nights it creates** (#2743). A night may be added to an
existing guest only when the edit moves the booking's check-out, and only past
the **old** check-out: the added leg is bounded below by `bookingCheckOut` as
well as by the morning after the guest's last held night, so
`[bookingCheckOut, newCheckOut)` is the whole of the ground it can cover. An
edit that leaves the check-out where it is — a guest added, a guest removed, a
promo or member-link change — cannot add a night to anybody. The rule exists
because the #2029 reach-back (`maxDate(stayStart, minDate(editableFrom,
stayEnd))`) reaches to the guest's own stay end, which is right one day behind
the edit window and wrong a week behind: a #713 partial-stay guest who had gone
home was put back on the booking for every remaining night and charged for them,
on any edit that reaches this plan. A **name-only** edit is not one of them: it
is identity-only on both routes and takes the price-preserving echo
(`buildIdentityOnlyPricing` on apply, a `priceDiffCents: 0` early return on
quote), so it never builds this plan at all — which is why the worked example is
"adding one guest bought seven nights for another", not "a name correction did".

The discriminator is **not** whether the guest has gone home. It is whether their
held nights reach the booking's own check-out, because that is the only thing
`bookingCheckOut` can test. Boundary by boundary, because getting one wrong
either keeps that over-charge or evicts somebody who is still in the lodge:

- **Runs to the check-out** — their last held night is the night before
  `bookingCheckOut`. Every ordinary stay. The bound is a no-op by construction
  (`heldEndExclusive` already equals `bookingCheckOut`), so nothing about them
  moves, extension included.
- **Leaving today** — their stay end IS the booking's check-out, one day behind
  the window. #2029's case, and the check-out is moving, so the genuinely-new
  night is still bought at the same price from the same anchor. Also a no-op.
- **Stops short of the check-out** — their last held night precedes
  `bookingCheckOut`. The nights between their last one and that check-out are the
  rest of somebody else's stay, were not created by this edit, and are no longer
  sold to them. **This is not confined to a guest who has already departed.** A
  guest who is in the lodge tonight and leaves on the 23rd of a booking that runs
  to the 27th is in this branch too: extend the check-out and they get the new
  nights with a three-night hole in front of them, and a bill smaller than the
  back-fill used to make it. Money still only ever moves down, but it moves for a
  guest who is present, and the bed board shows them out and back.

**Stated, because there is no honoured way to express the alternative:** extending
the check-out still admits *every* remaining guest for the nights past the old
one, including a guest who has already gone home, and it will write those nights
as a second run with a gap in front of them. Not because the request cannot
*carry* a per-guest end — `BatchModifyInput.guestStayRanges` exists — but
because this plan deliberately overrides it for every existing guest exactly as
it does for an added one, and the edit panel does not offer the control on an
in-progress edit (`gridMode` and `rangeMode` are both off when
`isInProgressEdit`). An API caller that sends `guestStayRanges` for an existing
guest on this path is **ignored, not refused**: a range inside the booking's
check-out is a silent no-op, and only one extending past it takes effect, through
envelope expansion. #2743's decision records the re-admission as accepted;
changing it means giving the edit panel a per-guest end date and honouring the
input, which is a new feature and not this rule.

**One consequence is deliberate and recorded rather than guarded.** Because
nobody is back-filled any more, an edit can leave `Booking.checkOut` claiming
nights no remaining guest holds — remove the only whole-run guest and the tail
after the next-longest stay is uncovered. The save is accepted: refusing it would
refuse the ordinary "remove the guest who was staying longest" edit, and the
containment triggers (`BookingGuest_stay_range_within_booking`,
`Booking_dates_consistent_with_guests`) permit it because they test containment,
never coverage. The counterpart is that such a booking eventually walks into the
refusal below, once its remaining nights fall behind the edit window — which is
why that refusal must name a check-out the plan will actually accept.

The rule refuses one edit the envelope arithmetic allowed: when no remaining
guest holds a night from the edit window on, the booking would be left with
future nights nobody occupies, and the save is rejected rather than written. The
refusal names the check-out that would work — the morning after the last night
anybody still holds, **clamped at `editableFrom`** — instead of restating the
rule, because the officer's real mistake is the date. The clamp is load-bearing,
not tidiness: a check-out before `editableFrom` is refused by this function's own
first guard and by `resolveTargetDates` before it, so an unclamped suggestion
would name a remedy the code rejects and the booking would be editable by no
route at all. Under #2736 alone the suggestion always landed exactly on
`editableFrom` (that refusal needs a guest whose last night is the day before the
window opens), so the trap opens only for #2743's shape — a guest who left well
before the window. That string is a log line — both routes replace it before the
operator sees it (#1888) — so making the edit panel say it is a separate UI
change, and until then the officer sees only "Unable to price the requested
future-night changes" with no date in it. Removing every guest still lands on the
original sentence, and the refusal is unreachable for a contiguous stay that runs
to the booking's own check-out, so no ordinary edit's wording moves. #2743 widens
the same refusal to one more booking, deliberately: one whose check-out is still
ahead but every guest's stay has already finished. That save used to go through
by re-admitting and charging those guests; the nights are no longer sold, so
nobody is left holding one and the booking's own inconsistency — a check-out
claiming nights no guest ever booked — is reported instead of paid for. It fires
only when **nobody** is left in the future window, never when the tail is merely
partly uncovered (see the paragraph above).

**What the officer is shown when a re-admission is retained.** The quote emits a
single aggregate line for all existing guests — `"Future-night date change"` or
`"Future-night guest range change"`, carrying `futureExistingDeltaCents` summed
across the whole party — with no per-guest and no per-night breakdown, and the
in-progress panel renders no per-guest night grid. So an extension that bills
four departed guests for three nights each shows as one dollar figure labelled as
a date change. The accepted residual is the money, and it is accepted **without**
a per-guest disclosure; itemizing it is a quote-route change, not this rule.

**A frozen exception proposal is not the party an in-progress execution
creates.** A policy-exception approval (`booking-exception-approval.ts`) executes
`modifyBookingBatch` from a stored delta against a party the officer reviewed,
built by `buildModificationProposalParties`, which resets every remaining guest
to the new envelope. On an in-progress booking the execution instead gives a
guest their own nights plus `[oldCheckOut, newCheckOut)`, so the reviewed
proposal **over-states** the nights and the price. The divergence pre-dates #2743
(this plan has always overridden per-guest ranges) and widens with it; the
direction is safe — execution claims fewer beds and charges less than the
reviewed artifact — and the **executed** party is authoritative.
`booking-exception-frozen-party-matches-planner.test.ts` does not cover it: it
compares the freeze against `prepareGuestPlan`, never against
`buildInProgressGuestRangePlan`, and its fixtures are dated outside the frozen
clock's in-progress window.

**A night is worth what it was sold for, in both directions (#2744).** The plan
passes the guest's stored `BookingGuestNight.priceCents` as `lockedNightPrices`
to the old-price window and the new-price window alike, so a night given back by
a removal or a shortened check-out is credited at the price the member actually
paid — never at the current season rate, which after a rate rise handed back
more than the club had ever charged and could leave a guest who genuinely slept
at the lodge with a negative stored price. Both windows, not just the old one:
the locks are what make a night the guest KEEPS carry one price on either side of
the difference and cancel to nothing, so an extension's delta is still exactly
the nights it adds and no night anybody already bought is ever re-rated. That
half of INV-MOD-006 — **locks win over the discount** — is satisfied here as
it is everywhere else, so a removal no longer strips a group discount the member
bought (INV-MOD-005, INV-MOD-006).

**The group discount applies to what the edit BUYS, and the party is counted per
night (#2756).** The other half of INV-MOD-006 is satisfied too. This plan used to
price each guest on their own — one `calculateBookingPrice` call per guest with no
group-discount config — so the party size the rule saw was always one, and a night
an in-progress edit newly BOUGHT carried no discount where the same night bought
before the stay began would have. On a club with the discount switched on that was
an overcharge running against the member, and it was nobody's decision. The plan
now prices the WHOLE PARTY in one pass per window, the way the guest-add route
does, and each guest's amounts are their slice of that combined breakdown. Two
passes, and which party each counts is the rule:

- The **post-edit** party, over the nights each guest ends up holding, prices
  everything this edit buys: an added guest's window, and the nights an extension
  creates. The count needs no special-casing — a removed guest's proposed nights
  stop at the edit window, a shortened check-out drops its own tail, and a
  partial-stay guest is counted only on the nights they hold, so an absent night
  cannot make up the minimum.
- The **pre-edit** window, over the nights each guest currently holds inside the
  edit window, values a night this edit takes AWAY — and it is passed **no discount
  config at all**, so it is byte-identical to what it was before #2756, discount
  configured or not. #2756 reaches the nights an edit BUYS and nothing else.

  That is a money decision, not an oversight, and it is the second thing an
  obvious-looking fix gets wrong. INV-MOD-006's "a party dropping below the minimum
  on removal never loses a discount it bought" is achieved by the **lock**, which
  covers every guest whose `BookingGuestNight` rows record what they paid and needs
  no party counted. Passing the config would only ever have changed the guests the
  lock cannot reach — a booking predating the rows, or one created by approving a
  request (#2739 backfills those but cannot empty the population) — and for them
  today's party is a guess, so it can only ever SHRINK the credit. A removal on
  such a booking credited $160 for nights the club had charged $240 for, and a
  shortened check-out kept $480 across six guests. `refundCeilingCents` caps this
  leg from ABOVE only, so that direction has no floor: the club would have kept
  money it should have returned, on the credit leg, which is the leg #2744 exists
  to keep honest.

  So a night with **no recoverable stored price** is credited at the guest's own
  rate type at today's rate, no substitution — which errs TOWARD the member for any
  sane rate table, and is bounded above by `refundCeilingCents` so it can still
  never hand back more than the guest is carrying. That is the documented
  pre-existing degradation this file already names above, unchanged. The accurate
  answer is that guest's own stored per-night average, which is right in both
  directions where neither today's-rate rule is; it also moves the
  discount-DISABLED path and therefore the 960-case equivalence matrix, so it is a
  change to ordinary bookings, and it is filed as **#2771** alongside #2745's
  repricing decision rather than taken here.

**A night the guest KEEPS is valued from the post-edit pass in BOTH windows**, and
that is the property that makes a party-aware discount safe on live bookings, not
a detail of it. It cancels to nothing across the difference exactly as the locked
prices do, so nothing already bought moves — not for a guest whose rows record
what they paid, whose price is locked anyway, and **not for a legacy guest with no
recoverable price either**. Valuing the two windows against their own parties
instead would re-rate that guest's already-slept nights every time an edit pushed
the party across the minimum: an add would CREDIT the rest of the party for nights
they had already had, and a removal would CHARGE them for the same nights
(INV-MOD-005). The pass is bounded below by the earliest night the edit actually
prices, so it demands a season rate for no night that nobody is repricing, and
reaches back below the edit window only for the #2029 check-out-day night the
plan can genuinely buy there.

**A night below a guest's OWN first priced night is in that pass for the party
COUNT only, and is carried only when its price is locked.** The floor is party-wide,
so in #2029's shape it can sit below one guest's own future window and reach back
over one of their earlier nights. Nobody reads that night's price. Asking the season
table for it anyway turned an edit that previously succeeded into a thrown
"No rate found" whenever the booking's night rows had drifted past its own check-out
(INV-DATE-012) and the covering season had no row for that guest's tier and rate
type — no season gap required. A locked night short-circuits the rate lookup, so it
joins the count and cannot fail; an unlocked one is dropped, which costs at most the
count on that one night — the pre-#2756 answer for it, able to withhold a discount
but never to invent one. Refusing the edit is the worse outcome. The apply path now
maps a plan failure to the same 400 the quote route already returned, so preview and
apply agree on the refusal as well as on the price.

The 960-case contiguous equivalence matrix is
untouched by every bit of this, and not by luck: it configures no discount and
prices every guest on their own membership type's rows, so the substitution can
reach no case in it and the same buckets still hold, per variant and in total. An
edit at a club that has not switched the discount on does not move by a cent.
**History is not repriced:** the discount binds
edits from here on, nothing already charged, refunded or invoiced is recalculated,
and a correction to a member charged the undiscounted rate by an earlier
in-progress edit is a separate, audited adjustment — the same treatment #2744 and
#2736 had, and the decision recorded on **#2756**.

**What #2756 did NOT build, stated here rather than left to be discovered.** The
owner's decision on that issue added a scope item to D1: an admin-controlled option
on the group-discount setup for *whether bookings edited later receive the
discount*, governing every edit path uniformly, defaulting to ON. This change
implements the D1 behaviour — which is that default — but not the switch, so a club
cannot yet turn edit-time discounting off. That is a new club-facing setting with a
schema column, an admin section, settings-census registration and both-state tests,
and it is filed as **#2770**. Until that lands, edit-time discounting is always on for
a club whose discount is enabled, which is the documented default and no club's
current correct behaviour changes because of the switch's absence.

**The per-night amounts written back are each night's real rate (#2744), not an
average.** A kept night keeps its stored price, a newly bought night takes its
own season rate, and the list is what `BookingGuestNight.priceCents` receives —
which is what the NEXT edit will be told the member paid. Where a guest's stored
rows cannot account for their stored total — no night rows at all (pre-#713, or
a booking created by approving a booking request, which still writes none,
#2739), or a stored total that has drifted from the rows — the amounts fall back
to the even split this always used, over the whole guest, because a distribution
invented from numbers that disagree is a guess dressed as a rate. Either way the
per-night amounts sum to the guest's total EXACTLY, in integer cents with any
remainder spread one cent at a time including for a negative total, so the runs
Xero rebuilds its invoice lines from still multiply back out and no phantom
balance can appear (INV-MONEY-001, INV-MONEY-003). The one shape that cannot sum
is a guest left holding no nights at all — removed before their stay began —
where there is nothing to distribute across: a guest whose rows account for their
total lands on exactly zero, and a guest whose total has drifted keeps the drift,
neither invented nor erased. The degradation is deliberate and is the same one
INV-MOD-005 already names for a legacy guest: with no stored price there is
nothing to recover, and that night is valued at today's rate.

**No edit leaves a guest owing less than nothing (#2744).** Valuing a night at
today's rate is a degradation, not a licence: after a rate rise it can credit
back more than the club ever charged, which is how a guest who genuinely slept at
the lodge finished with a negative stored price and negative night rows. The
credit on the old-price window is therefore capped at what the guest is actually
carrying — their stored price plus whatever this edit charges them for the nights
they keep — so their price lands at worst on zero. The cap cannot bind on a guest
whose nights cost no more than they paid, which is every healthy booking and
every case in the contiguous equivalence matrix. Symmetrically, a **negative**
stored `BookingGuestNight.priceCents` is refused as a sold price and treated as
no recoverable price at all: the column is a bare `Int`, the pre-fix arithmetic
could write negative rows, and honouring one would invert the edit so that giving
a night back CHARGED the member. **History is not repriced by either rule.** A
guest already below zero is left exactly as found — not driven deeper, not
repaired — because correcting what the old arithmetic wrote is an owner decision
with its own audit. **#2745** carries it, and its scope includes rows that are
negative, not only rows that are averaged.

The **contiguous equivalence** above survives this unchanged, and is still proven
rather than asserted: the matrix runs every ordinary edit four ways — rows
carrying today's rate as their stored price (the ordinary live booking, whose
rate has not moved), that same guest with a stored total that has drifted from
the rows, rows arriving without their price, and no rows at all — and all four
agree with the pre-#2736 arithmetic to the cent. Rows arriving without a price is
a thinner `select`, not a state the database can hold (`BookingGuestNight.
priceCents` is NOT NULL); it is in the matrix because the plan cannot tell it
from a guest who was never priced, and
`in-progress-edit-sold-price-census.test.ts` is what stops a loader producing it.
What moves, deliberately, is a refund on a stay whose season rate HAS changed
since it was made: it is now what the club charged rather than what it would
charge today.

**Nothing on this path is left frozen as a money shape.** #2736 carried three,
each pinned by a test in
`booking-edit-guest-ranges-sparse.test.ts` that had to be rewritten rather than
deleted: a guest whose stay had already ended was re-admitted and charged, a
refund was valued at today's rate, and the per-night amounts written back were an
even split. #2743 answered the first and #2744 the other two, and all three pins
were rewritten into the corrected assertion. The fourth was a stated gap rather
than a frozen shape — this plan priced each guest alone, so nights an in-progress
edit newly BOUGHT carried no group discount — and **#2756** answered it, on the
same terms: the behaviour is corrected forward, its pin is a mutation-probed suite
rather than a claim, and history is not repriced. What is left is the two
disclosures recorded above, which are about what the officer is shown rather than
about what anybody is charged.

**Money direction, stated with its scope.** Against the answer this plan gave
*before* #2743, nothing moves up: the bound only ever removes nights from the
added leg, so every difference is a member paying **less** or an edit being
refused. That is measured over the 960-case matrix rather than asserted here
(400 identical, 540 cheaper, 20 refused, landing identically in each of the four
stored-price row variants #2744 added — 200/270/10 in each pair of them), and it
is the direction that matters for live bookings.

Against the **pre-#2736** envelope arithmetic the claim needs a scope, and the
scope is drifted data — a guest whose stored `stayEnd` claims more nights than
their rows do. Two configurations, and they differ:

- Envelope drifted to **at or before** the booking's check-out. #2736 charged the
  nights the envelope had imagined; #2743 stops selling them because they are not
  past the check-out, and the money lands back on the pre-#2736 answer by an
  honest route — the guest keeps the nights their rows record and buys only what
  the extension adds.
- Envelope drifted **past** the booking's check-out. The pre-#2736 arithmetic
  compared a wide old window against a narrower new one and produced a **refund
  for nights the member never bought**. #2736 removed that phantom refund
  deliberately and #2743 does not put it back: nothing here is sold, so the delta
  is zero — which is *above* the legacy refund. So a shape does exist in which
  the answer sits higher than the pre-#2736 one. It is drifted data only, it is a
  phantom refund disappearing rather than a charge appearing, and the 960-case
  matrix can never reach it because it derives every envelope from the rows the
  way the writer does. Both configurations are pinned by their own case in
  `booking-edit-guest-ranges-sparse.test.ts`.

A guest ADDED during an in-progress edit is a deliberate exception in one
respect only: they are admitted for the booking's remaining future nights,
`[editableFrom, newCheckOut)`, and this plan still overrides whatever per-guest
range or night set the request carried. That window is contiguous by
construction, so there is no sparse input to preserve; it is materialised as a
night list anyway so every consumer reads one shape.

## INV-MOD-020

Minimum-stay is also the first consumer of the booking-policy exception
foundation (#2363). The only soft-policy reason codes are `MINIMUM_STAY` and the
reserved `ADULT_MEMBER_HOSTING_REQUIRED`; every other failure remains a hard
stop and cannot enter `aggregatePolicyExceptionViolations`. A minimum-stay
violation freezes its policy id/version, resolved club-wide or lodge-specific
scope, exact affected NZ lodge nights, minimum/actual-night requirements,
eligibility, message, and `HOLD`/`NO_HOLD` capacity mode. Multiple eligible
violations sort deterministically and aggregate to `HOLD` if any row says
`HOLD`.

## INV-MOD-021

That snapshot is transport data only in #2363: it explains a refusal, it never
authorises one. **Every** member-facing mutation path stops server-side for a
non-admin actor, and the list is exact:

- booking create (`POST /api/bookings`) — HTTP 400;
- member group join (`POST /api/group-bookings/[code]/join`) — HTTP 400 with
  code `MINIMUM_STAY_VIOLATION`;
- public non-member group join, at **both** stages — staging
  (`POST /api/group-bookings/[code]/join-request`) refuses with HTTP 400 before
  a verification token, join row, or email exists, and verification
  (`POST /api/group-bookings/join/verify/[token]`) re-reads the CURRENT policy
  set and fails closed with HTTP 409 `minimum_stay` before any member, booking,
  payment or pay link is created — an emailed link lives 48 hours, so a rule
  tightened inside that window must not be honoured. Both stages are
  unauthenticated, so both answer with the SAME generic sentence
  (`PUBLIC_GROUP_JOIN_MINIMUM_STAY_MESSAGE`) and carry nothing else: staging
  throws a `GroupBookingError` with a message and `MINIMUM_STAY_VIOLATION` only,
  verification returns `{ outcome, message }` only. The rule-naming sentence and
  the frozen snapshot exist solely in a `logger.warn` line each stage writes
  beside its refusal — not merely unread by the route, but absent from what the
  route holds, because both surfaces are one field-spread from the wire;
- member date modification through the live edit surface
  (`PUT /api/bookings/[id]/modify` → `modifyBookingBatch`) — HTTP 400, checked
  before the guest plan, pricing and capacity. Its sibling
  `PUT /api/bookings/[id]/modify-dates` (`modifyBookingDates`) carries the same
  block. On the batch path the check runs **only when the edit actually moves a
  night** — the resolved envelope after any `guestStayRanges` widening differs
  from the stored one (`resolveTargetDates().datesChanged`). An edit that leaves
  every night where it was (a guest add, a guest removal, a name fix, a credit
  election) cannot admit a NEW violation, so enforcing it could only hard-block
  an unrelated fix to a booking already grandfathered outside the policy, with
  no remedy the member can reach. `modify-quote` gates its own advisory check on
  the identical predicate (`targetDatesChanged`, computed the same way), so
  preview and apply agree on every request shape.
- waitlist-offer confirmation (`POST /api/bookings/[id]/waitlist-confirm` →
  `confirmWaitlistOffer`), on **both** offer kinds. Confirming turns a queue
  placeholder into capacity-holding status, so it is a fresh commitment to those
  nights, and an offer lives 48 hours — long enough for a rule to be tightened
  under it. A same-lodge offer is evaluated against the booking's own lodge; a
  cross-lodge offer (ADR-004) is evaluated against the **offered** lodge, which
  matters because per-lodge policy resolution replaces rather than merges, so
  that lodge can carry rules the member's own lodge never had, and because the
  cross-lodge path calls `createConfirmedBooking` directly and would otherwise
  apply no rule at all. Both checks run outside any transaction and fail closed
  **without consuming the offer**: the entry reverts to `WAITLISTED` under the
  relevant lodge's capacity lock, exactly as the capacity-lost and
  no-longer-eligible branches do, and the member gets a plain sentence with code
  `MINIMUM_STAY_VIOLATION` while the frozen snapshot stays in the server log.
  There is no admin branch on this path by construction: the confirm refuses any
  actor other than the booking's own member with `Forbidden`, so the only actor
  that ever reaches the check is a non-admin confirming their own offer.
  Because the same-lodge check reads the offer OUTSIDE the claiming transaction
  and runs only when that read already saw a live same-lodge offer this member
  owns, the claim carries a backstop: it records whether the check actually ran,
  and if it finds `WAITLIST_OFFERED` under the lodge lock either without that
  evidence or with a `waitlistOfferedLodgeId` the pre-read did not see, it
  refuses with code `CONFIRM_RETRY` (HTTP 409) and writes nothing at all. The
  offer sweep (`processWaitlistForDates`) makes exactly the
  `WAITLISTED -> WAITLIST_OFFERED` transition that invalidates the pre-read and
  the route carries no rate limit, so without the backstop an offer created in
  that window would be claimed with the policy never evaluated. Refusing is
  retry-safe by construction — no status moves, no allocation is touched and the
  offer is not consumed — so the next attempt re-reads the row and the guard
  evaluates for real.

## INV-MOD-022

The admin exemption is **not one predicate**, and the difference is deliberate.
State it per path:

- **Booking create** exempts an authorised **on-behalf** booking only
  (`isAuthorizedOnBehalf`). A dual-hat admin booking for THEMSELVES is still
  checked — #1442's decision: acting as a member means being held to the members'
  rules. Role alone buys nothing here.
- **Both modify paths and the modify-quote preview** exempt any ADMIN actor
  (`actor.role !== "ADMIN"` / `!isAdmin`), including admin-on-behalf edits.
- **Member group join** exempts any ADMIN session (`sessionRole !== "ADMIN"`),
  self-join included — the create path's narrower rule is not mirrored here.
- **The two public non-member group-join stages and both waitlist-offer confirm
  paths have no admin branch at all**, because no admin actor can reach them:
  the public stages are unauthenticated non-member surfaces, and a confirm
  refuses any actor other than the booking's own member with `Forbidden`.

## INV-MOD-023

Advisory surfaces — modify quote, policy check,
and the edit panel's banner — report the same facts without gating anything;
the panel deliberately leaves Save enabled because the server is authoritative.
No request row is persisted, no capacity is reserved from `HOLD`, and evaluation
never bypasses capacity, subscription, membership, linked-member-night,
authentication, payment, privacy, date, or data-integrity gates. #2365 owns
durable request state, approval/revalidation, capacity reservation, and the
mixed soft/hard admission order. Every caller evaluates against the resolved
booking lodge; unknown or inactive explicit lodge ids are refused rather than
falling back.

## INV-MOD-024

Minimum-stay policy administration is versioned. Every create supplies
`capacityMode`; every update/toggle/delete carries the loaded `version` and a
stale version is refused instead of overwriting a concurrent admin or import.
Config transfer is the one replace-set exception: it takes the config-import
lock then the shared policy-set lock, re-plans, and may delete omitted policies
only after they appeared in Preview. Existing policies migrate to `HOLD`.
