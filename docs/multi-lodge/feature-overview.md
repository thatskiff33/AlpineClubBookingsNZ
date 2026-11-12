# Multi-Lodge Feature Overview

What multi-lodge support does and how it behaves for each kind of user.
This is the intent document: if implementation and this description
diverge, one of them is wrong and the PR should say which. Decision
rationale lives in the ADRs; delivery sequencing lives in
`implementation-plan.md`.

## Purpose

Some clubs operate more than one lodge — two today for the club driving
this work, three for others in the community. Each lodge is a separate
building with its own rooms, beds, bed count, door code, travel
directions, chores, and possibly its own season dates and nightly rates.
Members belong to one club and hold one membership, but stay at
different lodges at different times.

Today the software assumes exactly one lodge. Multi-lodge support makes
the lodge a first-class concept so that one deployment can run several
lodges without splitting the club's membership, finances, or admin
across separate installations.

## What a Lodge Is

A lodge is a bookable property with:

- its own rooms, beds, and lockers (names unique within the lodge, so
  both lodges can have a "Bunkroom 1")
- its own nightly capacity, derived from its own beds — or, when the Bed
  Allocation module is off, a capacity set directly on the lodge
- its own seasons and rates when needed (a road-end lodge and a
  ski-in lodge may price differently)
- its own chore list and roster
- its own door code, travel notes, and opening/closing/day-to-day
  kiosk instructions
- its own shared kiosk sign-in, bound to that lodge's device
- its own school-group soft cap (the size above which a school group is
  asked to bring a member host)
- optionally its own cancellation, minimum-stay, and booking-period
  rules, and its own lodge-restricted working-bee events, when the club
  decides a lodge needs them (otherwise club-wide rules apply everywhere)

Everything else — members, families, membership types, applications,
payments, credits, promo codes (unless deliberately restricted), the
Xero connection, email, committee, and reporting — belongs to the club,
not to a lodge.

## Experience by User

### Clubs with one lodge

Nothing changes for the member. Multi-lodge is core (ADR-005 — no module
flag), but with a single lodge no lodge dimension appears in the
member-facing UI: no selector, and no lodge names in emails or booking
lists. The screens where a member checks or pays for one booking — the
booking wizard's review step, the booking page and the payment link — are
the exception: they always name the lodge (#2701, `INV-CAP-039`). The
Lodges admin page exists (a one-item list with **Add lodge**), but until a
second active lodge exists members see exactly what a single-lodge club
always saw. This is the permanent default for upstream and every
single-lodge fork, not a transition state.

### Members (once a second lodge exists)

- Booking starts by choosing a lodge, then dates. Availability
  calendars, quotes, and prices are for that lodge only.
- A booking belongs to exactly one lodge. Booking both lodges for the
  same trip means two bookings (the existing group-booking linking can
  tie them together).
- Confirmation and pre-arrival emails carry the right lodge's name,
  travel notes, and door code.
- So do the screens the member reads on the way through: the payment
  page's "your booking is confirmed" line, the group-join confirmation
  page, and any booking message a club writes with
  `{{CLUB_LODGE_NAME}}` in it — on the booking page, the payment page,
  the booking flow's payment choices and the group screens alike — all
  name the lodge that booking is actually at rather than the club's
  default one.
- Before paying, the booking page's Stay Details card and the payment
  link's card name the booking's lodge, and the arrival card is titled
  with it. My Bookings and the dashboard's Next Stay, draft and Recent
  Bookings rows show the lodge under each booking's dates
  (`INV-CAP-039`); a booking still at an archived lodge is labelled even
  after the club is back to one active lodge.
- If the committee restricts a lodge (for example, one lodge is
  reserved for a section of the club), ineligible members simply do not
  see it offered. By default every member can book every lodge.
- Cancellation and refund rules are the club's, unless the lodge they
  booked has its own published rules — whatever applies is what the
  booking flow displays.

### Admins

- The Lodges page (always available — multi-lodge is core, ADR-005)
  manages lodge identity: name, active state, door code, travel notes.
- Rooms/beds, lockers, seasons/rates, chores, and bed allocation are
  managed per lodge — the existing pages gain a lodge context selector
  when more than one active lodge exists, and look exactly as they do
  today otherwise.
- Booking lists, search, and dashboards can filter by lodge; admins
  always see all lodges' data. There is no per-lodge admin role.
- Policy pages keep editing the club-wide rules by default, with an
  explicit "this lodge has its own rules" override path per lodge.
- Promo codes gain an optional restriction to selected lodges. An
  unrestricted promo works everywhere, including at lodges created
  later.

### Hut leaders and kiosks

- A hut-leader assignment is for one lodge. Their PIN, roster, chore
  sign-off, and guest lists are that lodge's only.
- A kiosk device belongs to one lodge and shows only that lodge's
  arrivals, departures, and roster.

### Treasurer / finance

- One Xero connection, one ledger, one finance dashboard, unchanged.
  Bookings carry their lodge, so per-lodge revenue reporting is possible
  later (for example via Xero tracking categories), but nothing splits
  by default and no finance workflow changes.

## What Deliberately Does Not Change

- Membership, applications, families, subscriptions — club-wide.
- Payments and refunds — attached to bookings; money handling,
  integer-cent amounts, and Stripe flows are untouched.
- The Xero integration and its single operational connection.
- Module flags remain club-wide (chores are on or off for the club, not
  per lodge).
- Waitlist, group bookings, credits, and cancellation flows keep their
  behaviour — they gain lodge awareness, not new rules.

## Worked Examples

1. **Same weekend, both lodges.** The Smith family books Lodge A for
   Saturday; the club's school group fills Lodge B the same night.
   Lodge B being full has no effect on Lodge A's availability, and vice
   versa. Each booking prices from its own lodge's season rates.
2. **Lodge-specific promo.** The committee creates SPRING25 restricted
   to Lodge B to lift shoulder-season occupancy. It applies on Lodge B
   bookings and is rejected (with a clear message) on Lodge A bookings.
3. **Policy override.** Lodge B is remote and expensive to service, so
   the committee gives it a 14-day cancellation tier set. Lodge A keeps
   the club-wide 7-day rules. A member cancelling sees the rules for
   the lodge they booked.
4. **Hut leader.** Sam is hut leader at Lodge A this week. Sam's PIN
   works on Lodge A's kiosk, shows Lodge A's roster and guests, and
   does nothing at Lodge B.

## Delivered Capabilities

Beyond the per-lodge booking, pricing, capacity, policy, chore/roster,
locker, and access scoping above, the feature also includes:

- **Cross-lodge waitlist opt-in (ADR-004).** When a member waitlists a
  full lodge, they may opt in to alternate lodges they'd also accept.
  When a bed frees, the processor may offer an opted-in alternate per a
  club-configurable queue order (own-lodge-first by default, or merged
  by join time); the offer states the alternate lodge and its price, and
  acceptance creates a fresh booking at that lodge (never mutating the
  original entry's lodge).
- **New-lodge setup wizard.** Creating a lodge opens a guided flow
  (identity → rooms/beds → lockers → seasons/rates → chores) with
  quick-seed and copy-from-another-lodge, each step skippable.
- **Lodge configuration hub.** One page per lodge showing what it still
  needs, with an inline capacity setting and links into each editor
  pre-filtered to that lodge.
- **Per-lodge kiosk accounts.** One shared kiosk sign-in per lodge
  device, each bound to its lodge; the kiosk header names the lodge it
  is operating.
- **Lodge-aware booking requests.** Public and school request forms let
  the requester choose a lodge (when more than one is active); pricing,
  capacity, quotes, approval, and the resulting booking all follow that
  lodge.
- **Lodge-restricted working-bee events.** A working bee can be bound to
  a lodge so its discount only applies to bookings at that lodge.
- **CMS lodge-capacity token.** `{{lodge-capacity:lodge-slug}}` renders a
  named lodge's capacity on public pages; the bare token stays the
  default lodge.

Every one of these follows the single-lodge presentation rule (ADR-002):
with fewer than two active lodges, no lodge selectors, columns, or names
appear, and behaviour is identical to today's single-lodge club.

## Boundaries and Non-Goals

- No per-lodge admin accounts or per-lodge module settings.
- No single booking spanning multiple lodges.
- No per-lodge Xero connections or ledgers.
- `lodgeId` is **`NOT NULL`** on the entity tables, enforced without an outage
  via a `default_lodge_id()` column default (an old colour's omitted-column
  insert auto-fills the default lodge). Policy tables keep a nullable `lodgeId`
  (club-wide default). See `contract-release.md`.
- Lodge count is unbounded in the data model, but the UI is designed
  for the realistic case of two to a handful of lodges, not dozens.
- A cross-lodge waitlist is *not* a non-goal: it is delivered (ADR-004,
  see "Delivered Capabilities" above). A waitlist entry stays bound to the
  lodge the member asked for, but the member may opt in to alternate lodges,
  and acceptance creates a fresh booking at the alternate lodge.
