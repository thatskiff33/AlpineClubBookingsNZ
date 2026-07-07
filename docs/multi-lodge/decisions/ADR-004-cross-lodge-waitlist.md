# ADR-004: Cross-Lodge Waitlist Opt-In

## Status

Accepted (owner decisions recorded 2026-07-03). Implemented 2026-07-03
with the implementation notes below.

## Context

A waitlist entry is bound to the lodge that was full (feature-overview
"Boundaries and Non-Goals"), and the cross-lodge case was deferred until
per-lodge availability (phase 3), eligibility (phase 4), and the
booking-flow lodge context (phase 8) were stable. All three are delivered.

The club's two lodges are close enough that a member waitlisted at one
would often accept a bed at the other. Today they cannot say so: the
waitlist processor (`processWaitlistForDates`) scans candidates in global
`createdAt` order, checks capacity only against each candidate's own
lodge, and offers only that lodge.

Two properties of the current machinery shape this design:

- **Price is locked at waitlist creation.** `createWaitlistedBooking`
  prices against the entry's lodge and `confirmWaitlistOffer` never
  reprices — an offer today is always for the original lodge at the
  original price.
- **A booking's `lodgeId` is immutable in practice.** Promo redemptions
  are validated against the booking's lodge and not re-checked later;
  split-booking children must stay at their parent's lodge; allocations,
  audit events, and finance records all assume the lodge never changes.
  Mutating `lodgeId` on an existing booking would need every one of those
  handled by hand.

## Decision

### Owner decisions (2026-07-03)

1. **Queue order is configurable, club-wide.** Two modes:
   - `OWN_LODGE_FIRST` (default): when capacity frees at lodge X, X's own
     waitlist is served first in join order; only then are cross-lodge
     opt-ins from other lodges' queues considered, also in join order. No
     one is overtaken in a queue they joined.
   - `MERGED`: everyone whose entry could be satisfied at lodge X — its
     own queue plus opt-ins — is ranked purely by `createdAt`.
2. **Cross-lodge offers require explicit confirmation of the new price.**
   The offer email states the alternate lodge and its price for the same
   guests and dates; nothing changes until the member confirms on the
   offer screen. Same-lodge offers keep today's flow untouched.

### Opt-in model

- New junction `BookingWaitlistAlternateLodge` (`bookingId`, `lodgeId`,
  unique pair): the lodges a waitlisted member would also accept. The
  entry itself stays bound to the lodge the member asked for —
  `Booking.lodgeId` keeps its meaning, positions and emails are unchanged
  for members who never opt in.
- The booking flow's waitlist prompt offers the opt-in only when a second
  active lodge exists (ADR-002 presentation rule) and only for lodges the
  member is eligible to book (phase 4). The waitlist create API validates
  the same on the server.

### Processor

`processWaitlistForDates` gains a cross-lodge pass per the configured
mode. A cross-lodge candidate is offered lodge X only when: X has
capacity for every night of their stay, the member is still eligible for
X, and X's seasons can price the dates (no offer at an unpriceable
lodge). The offer records what was offered: new nullable
`Booking.waitlistOfferedLodgeId` and `waitlistOfferedPriceCents` (both
null for a same-lodge offer, so existing rows and flows behave
identically).

### Acceptance: create-and-cancel, never mutate

Accepting a cross-lodge offer does **not** move the existing booking.
The confirm endpoint, inside one transaction holding the offered lodge's
capacity lock, creates a fresh booking at the offered lodge through the
standard creation path — which re-validates eligibility, re-validates any
promo against the offered lodge's restrictions, re-prices from that
lodge's seasons, and handles split parties correctly by construction —
then cancels the waitlist entry with audit events linking the two
bookings. If the fresh price no longer matches the offered price (rates
changed between offer and confirm), the confirm is rejected and the
member sees the updated figure rather than being charged it silently.

The waitlist-offer screen shows the offered lodge's name and price and
requires the explicit confirm per owner decision 2.

### Implementation notes (2026-07-03)

**Premise change (upstream #1035, merged 2026-07-03):** upstream decided
a waitlisted booking's creation-time price snapshot is *not* a price
lock — same-lodge offers now reprice the entry at current rates,
membership policy, group discount, and promo validity when the offer is
issued, scoped on this branch to the entry's own lodge. This harmonises
with (rather than contradicts) this ADR: both offer kinds now price at
offer time, cross-lodge offers via the offered lodge's quote with the
confirm-time drift re-check unchanged.

Two behaviours were pinned down during implementation:

- **Promo-bearing entries are excluded from cross-lodge offers.** The
  Context section said promo revalidation would happen at confirm; in
  practice validating the promo at the alternate lodge collides with
  usage-limit counting of the entry's *own* existing redemption, and
  silently dropping the promo would quote a higher price than the member
  signed up for. A waitlist entry with a promo redemption is therefore
  simply never offered cross-lodge — its same-lodge flow is unchanged.
  Lifting this needs an exclude-own-redemption mode in promo validation
  and is left for a follow-up if members actually hit it.
- **Price drift refreshes the stored quote.** When the re-check at
  confirm finds a different price, the rejection also updates
  `waitlistOfferedPriceCents` to the fresh figure, so the offer screen
  shows the price the member can actually accept on retry rather than
  failing forever against a stale quote.
- **Queue positions are counted per-lodge.** Offer *selection* was always
  per-lodge (each freed lodge serves its own queue plus cross-lodge
  opt-ins). The display/email position a member sees is counted the same
  way: only overlapping `WAITLISTED` entries at the *same* lodge count, so
  a member first in their lodge's queue reads position 1 regardless of
  other lodges' queues. This is consistent with the per-lodge queue model
  above and does not conflict with the club-wide *queue-order enum* under
  Configuration (that setting governs cross-lodge ordering policy, not how
  a single lodge's positions are numbered). Applies to the offer-time
  count, `getWaitlistPosition`, `updateWaitlistPositions`, and
  `getWaitlistForDates`.
- **Confirm rejects a duplicate stay at the offered lodge.** If Phase 3
  (cancel the waitlist entry) failed on an earlier confirm, the entry is
  stranded in `WAITLIST_OFFERED` with a booking already created at the
  offered lodge; a re-confirm — or an expiry re-offer then confirm — would
  create a *second* booking and payment request for the same stay. Phase 1
  (under the offered lodge's capacity lock) therefore rejects the confirm
  when the member already holds an active booking (any non-cancelled,
  non-waitlist status — `PAYMENT_PENDING` counts) overlapping the offer's
  dates at the offered lodge, excluding the entry itself. The rejection
  carries a `DUPLICATE_STAY` code (surfaced by the confirm route like
  `OFFER_PRICE_CHANGED`); the offer is left intact so the member can cancel
  the duplicate and re-confirm.
- **Event-level offer order is club-wide join order (owner decision
  2026-07-08, #1566).** `OWN_LODGE_FIRST` is applied per candidate — an
  entry's own-lodge opportunity is always considered before any
  cross-lodge opportunity — but *across* candidates the processor walks
  all overlapping entries in global `createdAt` order and stops at the
  first successful offer per event. A slot freed at lodge B can therefore
  be offered first to a globally-older lodge-A waitlister whose own lodge
  had standing capacity; lodge B's own queue is served on the next
  trigger event. Capacity remains checked per lodge (no overbooking) —
  this is purely who is offered first. Accepted as join-order fairness
  across the club, consistent with the `MERGED` philosophy, in preference
  to exhausting the freed lodge's own queue before any other offer.

### Configuration

`BookingDefaults.waitlistCrossLodgeOrder` (enum, default
`OWN_LODGE_FIRST`) — club-wide, edited from the booking-policies admin
surface. Not per-lodge: queue fairness is a club policy.

## Consequences

### Positive

- Members near-indifferent between the lodges fill freed beds sooner;
  the club carries fewer empty beds on full nights.
- No behaviour change for anyone who does not opt in, for single-lodge
  clubs (the opt-in UI never renders), or for same-lodge offers.
- The dangerous parts — repricing, promo revalidation, split handling —
  reuse the hardened creation path instead of a parallel mutation path.

### Negative

- An accepted cross-lodge offer produces a new booking id: links in
  older emails point at the cancelled entry (which will reference its
  replacement), and reporting sees a cancelled entry plus a new booking
  rather than one continuous record.
- Offers can go stale two ways (capacity and price); the price-recheck
  rejection adds a retry loop the member experiences as friction, chosen
  deliberately over silent repricing.
- The processor becomes mode-dependent; both modes need test coverage.
