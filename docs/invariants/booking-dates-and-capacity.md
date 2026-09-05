# Booking Dates And Capacity

Audience: Developer, Agent.

Prefixes defined in this file: **`INV-DATE`** — what a lodge night is, when a
stay starts and ends, how dates are stored, compared and rendered — and
**`INV-CAP`** — how many beds exist, who consumes them, and how beds are
allocated.

This file also hosts one rule from another prefix: `INV-LIFE-062`, the custodian
bed hold, re-homed here from `membership-lifecycle.md` by #2706 because it is a
capacity invariant end to end. IDs are location-independent and the index is
authoritative for ID → file, so it keeps its number and its prefix.

Read this file when you are changing anything that decides which NZ calendar day
a booking touches, who is present on a day, how many beds a lodge has, or which
bed a guest is placed in.

Index: [`docs/DOMAIN_INVARIANTS.md`](../DOMAIN_INVARIANTS.md) — every `INV-*` ID
with a one-line description of what it covers. ID scheme and allocation rules:
[`SCHEME.md`](SCHEME.md).

Every heading below whose whole text is an `INV-*` ID defines that invariant. IDs
are permanent: never renumbered, never reused. **The text under each ID is a
verbatim move from the source document and must not be reworded in place** —
only the ID heading lines were added, and one relative link path was re-pointed
(`TESTING.md` → `../TESTING.md`).

## The stay boundary: midday NZ to midday NZ (normative)

### INV-DATE-001

This subsection is the normative stay-boundary invariant (epic #2629). It is
stated once, here; write any new stay-boundary sentence elsewhere as a
reference to this subsection rather than a restatement, fold restatements you
find into references as their files are touched, and measure every future
change in this area against it. All
times in this invariant are New Zealand time (Pacific/Auckland). UTC is never
a semantic boundary in this subsection; it appears only as the storage
encoding described at the end (and once as a code-level aside on weekday
derivation).

### INV-DATE-002

- **Lodge night.** Night N is the period from midday NZ on date N to midday NZ
  on date N+1. The boundary is fixed at midday NZ by definition (D-M3): there
  is no configurable boundary, and no time-of-day value participates in the
  stay boundary or in presence. (The kiosk arrive/depart stamps
  `BookingGuest.arrivedAt` / `departedAt` are action audit timestamps, never
  presence inputs. `Booking.expectedArrivalTime` is not one either: since #2621
  it is display-only information for the hut leader — shown on the kiosk and on
  the lobby wall's arrivals board, inside the wall's name-privacy gate — and it
  is read by no boundary, no presence decision and no chore assignment. A member
  who wants to leave before their check-out morning chore talks to the hut
  leader; the system records no departure time and infers none.)

### INV-DATE-003

- **Stay.** A stay is the half-open date range `[checkIn, checkOut)` expanded
  to nights — the motel rule: a guest is in the lodge from midday NZ on their
  check-in date to midday NZ on their check-out date. The check-out date is a
  departure morning, never an occupied night, which is why back-to-back
  handovers and same-day turnover on one bed need no special case. When
  explicit `BookingGuestNight` rows exist they are the authoritative night set
  and the contiguous envelope is ignored.

### INV-DATE-004

- **Presence on an operational day D** — the answer to every human-facing "who
  is here today" question (rosters, kiosk, manifests): morning half
  (midnight to midday NZ) iff D−1 is one of the guest's nights; evening half
  (midday NZ to midnight) iff D is one of their nights; present iff either
  half holds. Derived labels, never independent data: *arriving* =
  evening-half only; *departing* = morning-half only ("leaves today"). Sparse
  multi-segment stays follow the same rule per segment with no exception
  (D-M4): nights {5, 8} give presence on {5, 6, 8, 9} and absence on the gap
  day 7.

### INV-DATE-005

- **Two models, two helper families**, both in
  `src/lib/booking-guest-stay-ranges.ts`. The **night model**
  (`isGuestActiveOnNight` / `getActiveGuestsForNight`) is canonical for
  capacity, availability, pricing, bed allocation, whole-lodge and
  member-night logic — every per-night resource question; under it the
  departure date is never occupied. The **operational-day model** is canonical
  for chore-roster eligibility, the kiosk, print manifests and day statuses —
  every human-facing "who is here today" question. Ownership is strict in both
  directions: an operational-day caller must not reach the night helpers, and a
  capacity caller must not reach the operational-day ones.
  **The operational-day helpers** (#2622) are `getGuestOperationalDayPresence`
  (both halves plus the derived labels), `isGuestOperationallyPresentOnDay`,
  `isGuestArrivingOnDay`, `isGuestDepartingOnDay` and
  `getOperationallyPresentGuestsForDay`. They implement the pure rule above,
  sparse segments included, and take a private key-based copy of the night
  predicate rather than refactoring the frozen night helpers. There is one
  chore-eligibility query, `getOperationalRosterGuestsForDate`
  (`src/lib/roster-eligibility.ts`), read by the admin roster service and the
  kiosk generate route; roster-confirm validation and both chore-cleanup paths
  read the same helpers (D-M6). **Every read surface is converted.**
  `getLodgeVisibleGuestsForDate` survives as a deprecated wrapper that DEFINES
  NOTHING: since #2735 both branches are a straight delegation
  (`includeDepartureDate: false` → the night model, `true` →
  `isGuestOperationallyPresentOnDay`). It exists only so the lobby wall keeps a
  single named entry point a source contract can fence; `lodge-display-state` is
  its **only** caller and no surface may grow a second call. [INV-DATE-023] is
  the standing rule that let its predicate widen safely.

### INV-DATE-020

- **One place turns a stay into nights, and its envelope branch is half-open**
  (#2628). `BookingGuestNight` is the canonical night set;
  `BookingGuest.stayStart`/`stayEnd` is a DERIVED envelope whose `stayEnd` is the
  morning after the last night [INV-DATE-012], and for a sparse stay it silently
  fills the internal gaps. The named helpers in
  `src/lib/booking-guest-stay-ranges.ts` are the one definition and every read
  surface routes at them: `expandStayEnvelopeToNightKeys` (raw half-open
  expansion), `getGuestBedNightKeys` (night set when the guest has one, else the
  envelope — the set form of `isGuestActiveOnNight`),
  `getExplicitGuestBedNightKeys` (explicit rows only, `null` when none, for the
  bed-allocation surfaces), `getGuestDepartureMorningKeys` /
  `isGuestDepartureMorning` (one departure per SEGMENT),
  `getNextGuestBedNightAfter` / `isGuestReturningOnDay` (single-segment bounds),
  and `getEarliestCurrentBedNightDate`. Do not write another
  `eachDateOnlyInRange(guest.stayStart, guest.stayEnd)`;
  `guest-stay-expansion-census.test.ts` counts them per site, so a second copy
  in a declared file fails too.
  **`expandStayEnvelopeToNightKeys` must stay half-open.** Both bed-allocation
  planners are fed ONE PSEUDO-GUEST PER NIGHT (`stayStart = night`,
  `stayEnd = night + 1`); an inclusive expansion gives each a phantom second
  night and the planner claims the morning-after bed while its occupant is still
  in it. `bed-allocation.test.ts` → "pseudo-guest envelope (#2628)" is the
  mutation probe. Two deliberate non-callers: the lifecycle's
  `getGuestNightDatesInRange` reads the explicit rows with NO envelope fallback
  (it feeds both placement and the prune diff), and the planner's
  `guestStayNights` treats an explicitly EMPTY night list as "no demand". A
  guard on whether a bed is still spoken for starts at LAST NIGHT, not today:
  night N runs to midday NZ on date N+1 [INV-DATE-002], so `stayDate >= today`
  forgets this morning's occupant. That widening is for REFUSALS only — the
  partner-share sweeps DELETE rows and stay at `stayDate >= today`, because past
  lodge nights are history [INV-CAP-010]. A refusal built on this rule names the
  first few dates and occupants and says "and more", never the whole history.

### INV-DATE-021

- **A guest's kiosk attendance is one CURRENT state per stay, and every rule
  keyed on "the end of the stay" has to be re-read per segment** (#2628).
  `BookingGuest.arrivedAt` / `departedAt` is a single pair of timestamps meaning
  "where is this person now", not a log of check-ins. A stay with a gap in it
  arrives and leaves once per SEGMENT, so three consequences are load-bearing and
  none of them may be dropped:
  - The kiosk's check-in and check-out buttons BOTH ride on server-derived flags
    (`canMarkArrived`, `canMarkDeparted`) computed where the guest's night rows
    are loaded, never on a rule re-derived in the page from `isArriving` and
    `departedAt`. Those two fields cannot see the night set, and the combination
    they produce on a return night — check-in hidden because a departure is
    recorded, check-out hidden because the night is not a departure morning —
    leaves a hut leader with no control at all on a night the guest is in the
    building.
  - Marking a RETURN arrival (`isGuestReturningOnDay`, which is false for every
    day of every contiguous stay) always marks arrived and CLEARS the superseded
    departure, rather than toggling. That is what keeps the next check-out
    recordable instead of un-recording the previous one, and it is why "Arrived"
    and the faded row read `arrivedAt && !departedAt` rather than `arrivedAt`.
  - The departure chore sweep is bounded by `getNextGuestBedNightAfter`, not by
    "every date after today". Unbounded was correct only while the endpoint
    accepted a single, final departure; on a sparse stay it silently deletes the
    suggested roster generated for a segment the guest is still booked for, and
    toggling the departure back off restores nothing.

### INV-DATE-022

- **A SQL stay filter is a COARSE FILTER, never the answer: every kiosk write
  lookup loads the envelope and then decides over the night rows** (#2737). A
  `where` on `stayStart`/`stayEnd` describes only the envelope, a strict
  SUPERSET of the night set for a sparse stay [INV-DATE-020], so a lookup whose
  authority stops at the `where` accepts a write for a night the guest is at
  home. Both kiosk write lookups in `src/lib/lodge-date-scoping.ts` load coarse
  and decide in code: `findLodgeGuestForDate` (arrive) with
  `isGuestActiveOnNight`, `findLodgeGuestDepartingOnDate` (depart) with
  `isGuestDepartureMorning`. Three things are load-bearing:
  - **The night rule is NOT folded into the `where`.** The fragments there are
    the enforcement gates — member consent, pending admin review
, lodge scope and booking status — and they collapse to one
    uninformative "nothing matched" so a refused caller learns nothing. "You are
    not booked in tonight" is a fact about the booking, not the caller's rights,
    so arrive answers `409 GUEST_NOT_BOOKED_THIS_NIGHT` while `403` stays
    authorisation and `404` stays uniform. **Depart deliberately keeps the
    uniform `404` for "not a departure morning"**; anyone who adds a specific
    answer must not fold the rule into the `where`.
  - **The coarse filters stay as narrow as each rule allows and are not
    unified.** Arrive's is half-open (`stayEnd: { gt: date }`) because a
    departure morning is never an occupied night [INV-DATE-003]; depart's is
    checkout-inclusive because a departure morning is what it looks for.
  - **A guest carrying no `BookingGuestNight` rows still falls back to the
    envelope**, so every pre-#713 row behaves as it always has; a fixture that
    omits `nights` exercises the fallback, not the rule.
  A server guard is required even where no screen sends the request: the kiosk's
  `canMarkArrived`/`canMarkDeparted` flags [INV-DATE-021] make offer and
  acceptance agree by construction, but a stale page or a direct call bypasses
  the offer.

### INV-DATE-006

- **The lobby wall is deliberately mixed and stays fenced** (issue #58): it asks
  BOTH models, each for its own job, and keeps its own code path
  (`src/lib/lodge-display-state.ts`). Its guest-name privacy gate
  (sole-occupancy detection) is a NIGHT count. Everything a viewer reads — who
  is listed, the arriving/departing/staying counters, the bars — is the
  OPERATIONAL DAY, so a guest is shown on every morning they leave, including a
  mid-stay one, and their bar is drawn from their night set with the gap in it
  (#2735). Being mixed is the point: the two answers are different on a
  changeover day and each is right for its own question. The fence is that the
  wall may not be unified onto one family, and that the night count is derived
  independently of the visible list [INV-DATE-023] — widening its night counts
  would put guest names on an unauthenticated public screen during back-to-back
  handovers.

### INV-DATE-023

- **The lobby wall's night count is derived independently of what the wall
  shows** (#2735). `nightTotals` in `src/lib/lodge-display-state.ts` — the input
  to sole-occupancy / whole-lodge detection, which decides whether an
  unauthenticated public screen prints guests' names and phone numbers — is
  taken from the booking's whole guest set through the night model
  (`getActiveGuestsForNight`), never by reading the visible list. It shares no
  term with the visibility rule in either direction, so no change to who is
  DISPLAYED can add or remove a night. This ordering is the standing safety rule:
  the wall's visibility predicate could only be widened to per-segment presence
  because the count had already been decoupled, and anything that couples them
  again must narrow the predicate back first. A departure morning is never a
  night (INV-DATE-003), and `lodge-display-state.test.ts` fails on a sparse-stay
  fixture if one is ever counted as one.
- **Withholding names and drawing a blockout are separate decisions on that
  wall** (#2735). The serialiser keeps two sets: `wholeLodgeBookingIds` (the
  group holds a night INSIDE the window → `DisplayStateBooking.wholeLodge`, the
  blockout panel, the week strip, the rotating `occupancy:whole-lodge-*`
  conditions) and `soleOccupancyBookingIds`, a SUPERSET that also covers a group
  whose only presence in the window is its departure morning. The privacy gate
  (`namesAllowedForBooking`, and the chore-assignee labels that reuse it) asks
  the superset; the blockout view asks the narrow set — a widening here can only
  withhold more names. A row that reaches the wall on a departure morning alone
  must NOT be flagged `wholeLodge`. A `wholeLodge` row is not guaranteed
  contiguous, so any DAY span painted from it is derived from the row's
  `nights`, never from its envelope.

### INV-DATE-007

- **A member departing lodge A and arriving at lodge B on the same date is
  legal**: the two presence windows abut at midday, so the member-night
  conflict rule (below) is satisfied by construction.

### INV-DATE-008

- **Zero-night bookings** (`checkIn == checkOut`) expand to zero nights and
  are present on no day. The shape is deliberately unrepresentable — every
  booking-creating route refuses it — and must stay that way rather than
  becoming an accidental day-visit feature.

### INV-DATE-009

- **Deliberately outside this invariant:**
  - `daysUntilDate` (`src/lib/policies/cancellation.ts:140-158`) and the
    refund tiers it feeds (`getRefundTier` and the refund calculators,
    `src/lib/policies/cancellation.ts:13-90`) measure time *until* a stay
    against an NZ-local-midnight countdown boundary, not nights within it.
    They are not governed by the midday rule; any change there is a money
    change requiring its own issue, its own owner decision, and per-tier
    evidence — never a side effect of work in this area. A twelve-hour shift in
    that boundary moves real bookings across a refund-tier threshold: the same
    cancellation refunds a different amount.
  - The completion cron / unpaid-finished-stays pair keeps its dual check-out
    boundary (#2029, below). Both operate on NZ date-only lodge nights and
    neither is a presence definition; their `<` / `<=` split brackets the
    check-out day deliberately and must not be "aligned" onto one boundary.
  - The custodian bed hold uses deliberate inclusive day semantics (its own
    section below [INV-LIFE-062]): an assignment's `endDate` is a covered day, not a
    departure morning.
  - The kiosk depart lookup matches only the exact departure date — a status
    action window, not a presence rule.
  - The group-join window closes once the stay's check-out date is reached
    (`hasGroupStayFullyEnded`, `src/lib/group-booking.ts:469-476`) — an
    action window on dates, settled by its own owner decision, not a presence
    rule.
  - Minimum-stay derives its weekday as the NZ weekday: `night.getUTCDay()`
    (`src/lib/policies/minimum-stay.ts:56`) is correct precisely because
    nights encode NZ calendar dates (see the storage note). Any future true
    time-of-day instant in this area would silently shift that weekday for
    hosts behind UTC.

### INV-DATE-010

- **Storage encoding, not semantics.** A stored lodge night is a club calendar
  date. The `@db.Date` columns pin that date to UTC midnight internally — an
  instant that renders as club midday in NZST and 1pm during NZ daylight saving,
  which is the same club calendar day either way, so a CI runner in UTC and a
  club in New Zealand agree on the date ([`docs/TESTING.md`](../TESTING.md) pins
  the frozen test clock to an instance of exactly this instant as evidence).
  The UTC-midnight pinning is an internal encoding of the calendar date and
  nothing more: it is NOT the midday boundary instant, and the club's calendar
  day is the semantic truth.
- **That agreement is NOT universal, and an earlier wording of this rule said it
  was.** It held only because every deployment so far sits at or ahead of
  Greenwich. Read one of these values in a zone BEHIND Greenwich and it names the
  PREVIOUS day — measured during epic #2988, which exists to remove exactly that
  assumption. So the encoding is the same everywhere; the day you get back is not,
  unless you decode it correctly.
- **Decode it in UTC, and cite the rules that say so.** `INV-DATE-019` states the
  exact boundaries for truncating a stored `@db.Date` value, and `INV-DATE-026`
  its corollary; those are the authority for a decode, not this rule. What no
  rule may be derived from is one of these values read as a **moment** — an
  instant carrying a time of day — rather than as the calendar date it encodes.
  Do not cite this rule as permission to read one in a zone, and do not cite it
  as a prohibition on decoding one in UTC; several docblocks have paraphrased it
  as its own inverse and propagated that.

## Date handling rules

### INV-DATE-011

- Lodge bookings use New Zealand date-only nights, not arbitrary timestamps,
  unless a feature explicitly requires time-of-day semantics (the stay-boundary
  invariant above governs what those nights mean).

### INV-DATE-012

- `BookingGuest.stayStart` and `BookingGuest.stayEnd` represent each guest's
  date-only occupancy inside the booking envelope.

### INV-DATE-013

- `@db.Date` columns (e.g. `Booking.checkIn`/`checkOut`,
  `BookingGuest.stayStart`/`stayEnd`, `HutLeaderAssignment.endDate`) store an NZ
  calendar date, encoded at UTC midnight. Compare them only against date-only
  values (`getTodayDateOnly()` for today; `storedDateOnly()` from
  `src/lib/stored-calendar-day.ts` to normalise one of these columns), never a
  raw `new Date()` or a local-midnight (`setHours(0,0,0,0)`) instant (F8/F32,
  #1888). **Not `normalizeDateOnlyForTimeZone()` on one of these columns**: it
  projects the value through the environment zone — the PREVIOUS day for a club
  behind Greenwich (#3107).

  **The two mistakes fail differently, and the local-midnight one is worse
  (#2838).** A bound is narrowed to a `DATE` parameter by its UTC calendar date
. A raw `new Date()` lands on
  the previous NZ day for the first ~12-13h of each NZ day; `setHours(0,0,0,0)`
  under the `TZ=Pacific/Auckland` pin narrows to `D-1` **all day, every day**,
. One day early on the
  value is one day LATE on the window: `checkIn <= tomorrow` / `checkOut >=
  today` evaluated at `D-1` admits `[checkIn, checkOut+1]` instead of
  `[checkIn-1, checkOut]` — the window `getKioskAccessTier`
 enforces for a stay. #2838 fixed the member-facing reads
  (`dashboard-club-day-boundaries.test.tsx`,
  `authenticated-layout-club-day-boundaries.test.tsx`); #2868 fixed the Xero
  repair sweep's window as a SPLIT — a date-only bound for `Booking.checkIn`, a
  `startOfDateOnlyForTimeZone` bound for the three `DateTime` columns in the
  same `OR` — pinned under three host pins by
  `xero-booking-repair-scope-window.test.ts`.

  **A spelling finds candidates; only the CALL GRAPH settles them.** `setHours`
  is not an ISO truncation, so #2684's lint rule cannot see it. **Read that as
  "no site is currently known", never "the class is closed"**; #2684's lint rule
  is what would close it.

  A `DateTime` column in the same statement takes the start-of-club-day instant
  from `startOfDateOnlyForTimeZone()`, never the date-only value, which would
  push it to club MIDDAY.

### INV-DATE-025

- **A club-local wall time is not guaranteed to exist, and may exist twice.**
  Deriving an instant from "this date at this clock time in the club's zone" has
  two failure modes a single offset lookup cannot see, both the DST transition
  itself.
- **The kernel resolves it with THREE probes, not two** — a day before, at, and
  a day after, reading every candidate back. Across all 418 zones this runtime
  knows, 2015 to 2036, local midnight is skipped in 19 zones and ambiguous in 8;
  a two-probe correction names the wrong calendar day in 11 of them and is blind
  to an ambiguity when both probes land the same side of the transition.
- **The policy is explicit at the call site, on two independent axes.** A
  *skipped* wall time defaults to `reject`; a day-boundary caller opts into
  `nextExistingInstant` so a booking screen can never fail to render. An
  *ambiguous* wall time defaults to `earliest`, so a job scheduled at 01:30 on a
  fall-back day runs once, at the first 01:30.
- **Noon is measurably safer than midnight — but not a guarantee.** In that
  sweep local noon is never skipped and never ambiguous; over 1900–2100 noon
  *is* skipped in 16 zones, five of them date-line moves, the most recent in
  2011. So **the noon-to-noon stay window needs no policy on any zone any club
  runs today, and `noonOfClubDay` still carries one**, because a booking screen
  must render rather than throw. Do not read "noon is safe" as "noon cannot be
  skipped".
- Decided on #2990 (CT-2) under epic #2988; the measurements are that issue's.

### INV-DATE-024

- **`Member.dateOfBirth` is a CALENDAR DAY, stored at UTC midnight.** The column
  is `@db.Date` as of **#2872** (owner decision recorded on #2859). **The writer
  rule did not go away with it**: a column type pins what the database stores,
  not the value a writer computes. Build it with
  `parseDateOnly(\`${yyyy}-${mm}-${dd}\`)`, an explicit `T00:00:00.000Z`, or
  `Date.UTC(...)`. **Never** `new Date(\`${yyyy}-${mm}-${dd}T00:00:00\`)`: with
  no `Z` and no offset that is SERVER-LOCAL midnight, a day early every hour of
  every day under the `TZ=Pacific/Auckland` pin — the F8/F32 hazard
  [INV-DATE-013] on a column that is not a lodge date.
  **`new Date("yyyy-MM-dd")` is not on that list, deliberately**: the zone is
  right, but the constructor rolls an impossible day over silently
; `parseDateOnly` returns an invalid
  `Date` instead.
- **Compare a stored date of birth only against another date-only value.** The
  age-up candidate query's bound must cover the whole cutoff calendar day
  (`src/lib/cron-age-up.ts`, #2859); an age tier moves a price and hosting
  eligibility.
- **Both sides of the age comparison are calendar days, and they read one
  frame** (#3082). `computeAge` (`src/lib/policies/age-tier.ts`) decodes its date
  of birth **and** its reference date in UTC through `requireStoredCalendarDay`,
  which refuses a value carrying a UTC time of day; `getSeasonStartDate` is that
  day at UTC midnight and `getSeasonStartCalendarDate` the same day as text. Do
  not correct one half.

  `member-age.ts` reads `formatDateOnly`. Its 29
  February convention differs from `computeAge`'s deliberately (clamp to 28
  February for an identity check versus compare the day as written); the two can
  only disagree when the REFERENCE date is 28 February, and `computeAge`'s
  reference is always a season start, day 1 of a month, so on the price path the
  divergence is **structurally unreachable**.



### INV-DATE-026

- **A column holding a calendar day is `@db.Date`.** Not a bare `DateTime` that
  writers agree to keep at UTC midnight — the schema states it, and PostgreSQL
  refuses to keep a time. #2872 narrowed eleven such columns and the reviewed
  exception list `DATE_ONLY_IN_DATETIME_COLUMN` is now **empty**, its terminal
  state.
- **A column only qualifies if EVERY writer agrees.** Three were examined and
  deliberately left as `DateTime` because one writer puts a real moment in them:
  `MemberInduction.inductionDate` (stamped with the clock at the last sign-off),
  `MembershipNominationSettings.gateEffectiveFrom` (defaults to `new Date()`
  when left blank, as the panel's help text promises) and
  `CalendarEventSeries.until` (written at local **noon**). Narrowing a mixed
  column destroys the evidence of which rows were which, and the fail-closed
  preflight would abort the deploy on every such row.
- **A bare `DateTime` may hold a calendar day only through that list**, one entry
  per field, naming the write that proves it. An entry dies when its column is
  narrowed, and `date-only-encoding-guard.test.ts` fails an entry that outlives
  its fix.
- **The corollary is the part that breaks things: a Prisma bound against a
  `@db.Date` column must be a calendar day at UTC midnight.** The adapter
  narrows whatever instant you hand it, so a bound built as midnight in the club
  zone — or on the host — becomes the **previous day**, and nothing warns you.
  That is invisible in a schema diff, which is why narrowing a column without
  censusing its readers is the dangerous half of the change (#2872 found three
  such readers, one of them an age-up cutoff and therefore a price).
- `src/lib/__tests__/prisma-date-column-binding.test.ts` is the executable form
  of the corollary, and `DATE_ONLY_COLUMN_FIELDS` — parsed from `schema.prisma`
  rather than hand-listed — keeps the field set honest.
- Minted on #2872 (CT-3) under epic #2988.

### INV-DATE-019

- **When a server asks for "today", it asks the club's calendar.**
  `todayDateOnlyForTimeZone()` returns it as a `yyyy-MM-dd` string and
  `getTodayDateOnly()` as a date-only `Date`; both live in `src/lib/date-only.ts`,
  both work on the server and in the browser, and since CT-2 (#2990) both are
  adapters over `clubToday()` in `@/lib/club-time`, which is where new code should
  ask. Never `new Date().toISOString().slice(0, 10)` (or `.substring(0, 10)`, or
  `.split("T")[0]`) — that is the **UTC** day, still *yesterday* in New Zealand
  for roughly the first half of every NZ day (#2682);
  `src/lib/__tests__/nz-today-date-only.test.tsx` freezes the clock inside the
  divergence window and fails the build if the pattern comes back.

  Three exact boundaries on that rule: truncating a `DateTime` column is
  `INV-DATE-027`; adding days to a document date is `INV-DATE-028`; and *the
  member booking calendar and the admin kiosk deliberately derive today from the
  BROWSER's calendar day* (`src/components/booking-calendar.tsx`,
  `src/app/(admin)/admin/book/page.tsx`, #2474, `INV-DATE-014`), so "one way to
  ask" holds for server-side and club-facing derivations, not literally
  everywhere. Any comparison the SERVER then makes is still the club day.

  A date-only value compared against the raw clock is the same mistake in
  reverse: `parseDateOnly("<today NZ>")` is UTC midnight of that day, which is
  still in the *future* of `new Date()` until midday NZ, so a guard written
  `dob > new Date()` refuses today's NZ date — the very date its own picker
  offers. Compare date-only against date-only (`> getTodayDateOnly()`), which is
  what the date-of-birth guards do since #2682.

### INV-DATE-027

- **Truncating an existing `@db.Date` value to its UTC day is fine — it already
  encodes a calendar day at UTC midnight. It is not fine for a `DateTime`
  column.** `createdAt`, `updatedAt` and friends are real instants, so
  `booking.createdAt.toISOString().slice(0, 10)` lands on the previous NZ day all
  morning. Every Xero document date derived from the clock or a stored
  `DateTime` is `formatDateOnlyForTimeZone` (#2697, #2834), as is the
  member-facing "Details last confirmed" line (#2839). **Most such sites are
  invisible to a grep** because they reach the pattern through a wrapper —
  `formatDate` in `src/lib/xero-invoice-helpers.ts`, `toDateInputValue` in
  `src/lib/member-family-service.ts` — so census the call graph, not the
  spelling. Both wrappers remain correct for `@db.Date` receivers only.

  **A generic renderer cannot decide this from the runtime type**: an instant
  and a calendar day are the same `Date` and the same ISO string (#2860). Where
  both kinds render side by side — the member-merge comparison screen — the kind
  is DECLARED per field in `src/lib/member-merge-field-kinds.ts`. That adds no
  exception to the rule; it applies it: instants (`photoUpdatedAt`,
  `hutLeaderEligibleAt`) read through `formatDateOnlyForTimeZone`, while
  `dateOfBirth`, `joinedDate` and `lifeMemberDate` (`@db.Date` since #2872) are
  deliberately NOT — a calendar day decodes in UTC, and only a test reading them
  from a club BEHIND UTC can tell the two apart. `DATE_ONLY_IN_DATETIME_COLUMN`
  is now empty (`INV-DATE-026`).

  One writer does not honour the calendar-day intent: `parseXeroCompanyNumberDate`
  (`src/lib/xero-contacts.ts` and its clone in the import-member-contact route)
  stores SERVER-LOCAL midnight, so a Xero-imported date of birth reads a day
  early until #2859 lands — a storage defect fixed at the writer. The
  `setHours(0, 0, 0, 0)` class is `INV-DATE-013`; neither #2684's lint rule nor
  its guard test sees it. Until that rule lands this class is a known trap, not
  a permitted pattern.

### INV-DATE-028

- **A number of days added to a document date is added in CALENDAR days**, with
  `addDaysDateOnly` over the date-only value — never by adding `days x 24h` to an
  instant and then reading the result on the club's calendar. The Xero
  entrance-fee invoice's 30-day due date and the subscription invoice's
  `dueDays` both step date-only values since #2834.

  The hazard belongs to the club-calendar FIX, not to the pre-#2834 UTC code:
  once the issue date is the club's calendar day, deriving the due date as
  `formatDateOnlyForTimeZone(instant + days x 24h)` reads a shifted instant in a
  zone whose offset may have changed in between. New Zealand leaves daylight
  saving at 03:00 on 5 April 2026, so `30 x 24h` from 00:30 on 15 March yields
  the 13th where thirty calendar days is the 14th. On the subscription invoice
  that is worse than a wrong date: `subscriptionInvoiceMatchesSnapshot` adopts a
  pre-existing Xero invoice only when `invoiceDueIntervalDays` equals the
  charge's frozen `dueDays`, so a 29-day interval would stop an immutable charge
  adopting its own invoice.
  `src/lib/__tests__/xero-document-dates-club-calendar.test.ts` pins both ends
  at the 5 April boundary.

### INV-DATE-014

- **Client-side, a selected lodge night is an NZ date-only `yyyy-MM-dd` string
  carried end-to-end.** The booking calendar (`src/components/booking-calendar.tsx`),
  the member booking wizard, and the admin "book on behalf" kiosk
  (`src/app/(admin)/admin/book/page.tsx`) never hold a lodge night as a
  local-midnight `new Date(year, month, day)` (#2474): that is midnight in the
  BROWSER's zone, off by one for a booker far enough from New Zealand the moment
  it reaches an instant-based API. The value submitted, the club-pinned label,
  the night count, and the hold deadline are all derived from the string via
  `parseDateOnly` / `addDaysDateOnly` / `countNightsDateOnly`, which encode the
  club calendar day at UTC midnight — an encoding and not a moment, per
  `INV-DATE-010`, which also holds the qualification about clubs behind
  Greenwich. `formatCalendarDayOnly(year, monthIndex, day)` is the canonical
  encoder; the #2264 `localCalendarDayToDateOnly` bridge is gone.
  `src/lib/__tests__/booking-calendar-timezone.test.tsx` pins the lodge-night
  identity across browsers behind, at, and ahead of NZ, on an NZ DST-transition
  night. (This is the CLIENT representation; server-side capacity date
  arithmetic keeps its own `@db.Date`/date-only helpers, above.)
- **Since CT-6 (#2991) this fails mechanically rather than by review.** Two
  `no-restricted-syntax` arms over `src/**` ban reading or writing a `Date`
  through the host's clock face — `getFullYear`/`getMonth`/`getDate` and their
  `set*` counterparts, plain and computed — and ban importing `date-fns`, which
  performs the identical read inside `node_modules`. The host-clock arm ships
  with NO exemption; `date-fns` keeps a seven-file ratchet, each entry naming
  what it uses and what blocks it. `club-time-boundary-guard.test.ts` proves
  both arms twice — that they RESOLVE at every production path, and that they
  REPORT a violation there — with a clean control at each path so the ban is
  about the host's clock rather than about `Date`.

### INV-DATE-015

- **Rendering** a date or a time is a separate invariant from storing or
  comparing one, with its own single seam: `@/lib/club-time`. The six house
  shapes — "16 Apr 2026", "16 Apr 2026, 11:30 am", "16 April 2026", "11:30 am",
  "April 2026" and "Thu, 16 Apr 2026" — each pin `APP_LOCALE`, and each comes in
  a CALENDAR-DAY form that takes no zone (the kernel pins `timeZone: "UTC"` over
  the UTC-midnight encoding, so the projection is provably the identity) and an
  INSTANT form that requires the club zone explicitly. A bare
  `toLocaleDateString()` / `toLocaleTimeString()` / `toLocaleString()` renders in
  the VIEWER's zone and locale (#2256, #2264); an `eslint` `no-restricted-syntax`
  rule over `src/**` blocks all three, with its documented exclusions in
  `eslint.config.mjs`. Three files format NUMBERS with
  `Number.prototype.toLocaleString` and carry a narrowed rule lifting only that
  call. A screen whose format is
  legitimately none of the six declares a module-level
  `new Intl.DateTimeFormat(APP_LOCALE, { timeZone: APP_TIME_ZONE, … })` constant;
  that, not an `eslint-disable`, is the escape hatch, and there are no disables
  in the tree.
- **Since CT-2 (#2990) the seam is `@/lib/club-time`, and since #3123 it is the
  ONLY one.** `src/lib/nzst-date.ts` and its six `formatNZ*` helpers are
  deleted, **not replaced by a shim, a re-export or a test-only stub, and must
  not be**; `club-time-kernel-census.test.ts` asserts the file has not come
  back. The lint arms are unchanged in what they MATCH.
- **Where the zone those formatters pin comes from is a different invariant.**
  Since CT-1 (#2989) it is the persisted `ClubTimeSettings.timeZone`, read
  through `getClubTimeZone()` — `INV-CONFIG-002` in
  [`product-configuration.md`](product-configuration.md). `APP_TIME_ZONE` is
  the transitional constant `src/lib/date-only.ts` and the module-level
  formatters still read; do not conclude from it that the environment is the
  club's civil-time authority. Naming the environment's zone is `INV-DATE-029`.

### INV-DATE-029

- **CT-6 (#2991) closed the recurrence path and counted the remainder.** Naming
  the environment's zone — `process.env.TZ`, `NEXT_PUBLIC_TZ`, or an
  `APP_TIME_ZONE` import — is a lint error under `src/**` outside a named
  nine-file ratchet, of which two are structural (the config module that defines
  it and CT-1's seed reader) and seven are measured callers each carrying the
  issue that blocks them. What a selector cannot express is counted instead:
  `club-time-escape-hatch-census.test.ts` counts the call sites that still let a
  zone-defaulting `@/lib/date-only` helper take the environment's answer. Every
  ceiling there is TIGHT — equal to the live count, with no deliberate slack — so
  a measurement below one means the ceiling is stale, not that there is room.
  They may only fall; a ceiling whose subject is deleted is retired with it.

### INV-DATE-016

- The LONG spelled-out date — `formatClubLongDate` for a calendar day,
  `formatClubInstantLongDate` (or a binding's `instantLongDate`) for a moment —
  is reserved for the MEMBER-FACING surfaces the owner asked to keep it on
  (#2264): booking messages and the emails built from them, the lodge and
  hut-leader instruction "last updated" stamps, and the generated report cover.
  Admin and internal screens use the medium shape (`formatClubDate` /
  `formatClubInstantDate`). Until #3123 these were `formatNZLongDate` and
  `formatNZDate` on the retired `nzst-date` adapter; the rule is about the SHAPE,
  not the spelling, and the shape is byte-identical.
  `src/lib/__tests__/member-facing-long-dates.test.ts` pins the four call sites
  so a later "tidy every date onto the medium form" pass fails loudly rather than
  silently shortening what a member reads.

### INV-DATE-017

- Two check-out boundaries coexist by design (#2029; named as a deliberate
  non-presence exception by the stay-boundary invariant above). The completion
  cron flips
  PAID → COMPLETED only once `checkOut < todayNZ` — the entire NZ check-out day
  stays PAID and self-editable/extendable — whereas the admin "finished stay"
  attention queues (`unpaid-finished-stays.ts`) intentionally use
  `checkOut <= todayNZ`. The difference is deliberate and the two operate over
  DISJOINT status sets: the queues surface still-unsettled stays
  (`PAYMENT_PENDING`, or a settled status carrying an unpaid additional delta) on
  the check-out day itself for payment chasing, while completion is a next-day
  transition of PAID bookings. A booking is therefore never both counted as a
  finished-stay-needing-payment AND still PAID-completable under the same rule.

### INV-DATE-018

- Base Reports uses lodge nights, never booking creation time (#2368). Its
  selected From/To window is inclusive and overlaps the half-open booking stay
  `[checkIn, checkOut)` (the stay-boundary invariant above). Every
  non-occupancy figure uses one explicit positive
  cohort: `PENDING`, `PAYMENT_PENDING`, `CONFIRMED`, `PAID`,
  `AWAITING_REVIEW`, and `COMPLETED`, with the same lodge/deleted scope. Count
  bookings once per overlapped bucket. Count guest rows once when their own
  half-open `[stayStart, stayEnd)` envelope overlaps the selected range; sparse
  explicit guest-night rows do not override that envelope for this metric.
  Allocate all integer cents of `finalPriceCents` across the
  booking's complete stay before slicing the report range (100/3 = 34/33/33).
  This is **Booked revenue**, not cash. Net collected cash stays payment-derived
  (`Payment.amountCents` less refunds, with a captured addition already inside
  that amount; #2408), and outstanding additions remain separate (#2350). The
  #2408 guard is binding here too: a collected-addition claim without captured
  `ADDITIONAL` transaction evidence must not change cash arithmetic or leak
  transaction rows, but must log and expose an aggregate possible-understatement
  warning in the page, CSV, and PDF. All Reports money presentation preserves
  exact integer cents.
  Occupancy is the deliberate exception within the page: it stays limited to
  PAID/COMPLETED and continues to exclude custodian occupancy (#2286).

## Capacity and allocation

### INV-CAP-001

- Capacity is per lodge. A booking belongs to exactly one lodge
  (`Booking.lodgeId`); capacity is "beds available on date D at lodge L", and
  no code path may sum beds across lodges into a single club-wide number. Two
  bookings at different lodges never contend for the same beds. The one
  deliberate, documented exception is a reporting-layer occupancy denominator
  that intentionally aggregates active lodges; any such aggregate must be
  recorded in `docs/multi-lodge/lodge-scoping-contract.md` and labelled as
  cross-lodge in the surface that shows it. A single-lodge club is simply a
  club whose `Lodge` table has one active row — the same per-lodge rules apply
  with the lodge dimension hidden by the ADR-002 presentation rule.

### INV-CAP-002

- `lodgeId` is **`NOT NULL`** on the six entity tables (`LodgeRoom`, `Locker`,
  `Season`, `Booking`, `ChoreTemplate`, `HutLeaderAssignment`), enforced
  **without an outage** via a `default_lodge_id()` column default: an old
  (pre-lodge) colour's insert omits `lodgeId` and auto-fills the default lodge,
  so no null is written even mid-blue/green-cutover. `lodgeNullTolerantScope`
  is now a strict `{ lodgeId }`. Policy/settings tables keep a **nullable**
  `lodgeId` (null = club-wide default), scoped via `resolvePolicyRowsForLodge`.
  See `docs/multi-lodge/contract-release.md`.

### INV-CAP-003

- Each lodge's capacity resolves through `getLodgeCapacityStatus` (full
  scenario table in `docs/CAPACITY_MODEL.md`). When the Bed Allocation module
  is on with ≥1 active bed, the physical bed inventory is the placement set and
  the per-lodge `LodgeSettings.capacity` acts as a **maximum sleeping capacity
  ceiling**: the effective capacity is the lower of the two, so a lodge may
  have more beds installed than it is allowed to sleep (`capped_beds`). No
  capacity set — or one at/above the bed count — leaves the bed count as the
  figure (`configured_beds`); only an explicit capacity caps it, never an
  unconfigured fallback. When the module is off, or on with no active beds, the
  capacity is the per-lodge `LodgeSettings.capacity`; if that is unset the lodge
  resolves to capacity 0 (`unconfigured_lodge`). Since #1982 the DB is the sole
  runtime source — `club.json` is no longer a runtime capacity fallback; the
  default lodge's `LodgeSettings.capacity` is backfilled from the config bed
  total by the boot-time self-heal, and any lodge (default or additional) with
  neither configured beds nor a capacity is unbookable rather than overbookable
  until it is set up (the setup-readiness Club Config check warns on a
  default lodge left at 0).

### INV-CAP-004

- A booking consumes beds when it is capacity-holding. The implementation
  source of truth is `capacityHoldingBookingFilter()` in
  `src/lib/booking-status.ts`, which every occupancy/availability query uses
  (composed under `AND` with the per-lodge scope, since both are `OR`
  fragments). A booking holds capacity when either (a) its status is in
  `CAPACITY_HOLDING_BOOKING_STATUSES` (PAID, COMPLETED, CONFIRMED,
  AWAITING_REVIEW), or (b) it is PENDING **and** is the converted booking of a
  `BookingRequest` — i.e. an accepted-but-unpaid quote or a directly-approved
  request (issue #1254). Rule (b) refines #737: generic PENDING bookings
  (split-booking non-member children #738, member "only-if-my-guests-come"
  holds) have no `originBookingRequest` and stay non-holding and bumpable, but a
  quote-derived accepted booking keeps its beds until it is paid, expires, or is
  cancelled. Because #737's member-priority bumping only ever touched
  non-holding PENDING rows, an accepted-but-unpaid quote can no longer be bumped
  by a later member booking — this is the intended capacity-priority change.

### INV-CAP-005

- Split-booking guest portion always settles or is notified, never silently
  stranded (#1967). A split non-member child (#738) is auto-charged at its hold
  deadline to the member's card inherited from the parent payment. When the
  parent is settled without a saved card (Internet Banking, or already
  CONFIRMED/PAID/COMPLETED), `cron-confirm-pending.ts` instead mints a tokenised
  `/pay/<token>` PaymentLink and emails it to the member — once per mint,
  deduped on the absence of an active PaymentLink for the child
  (`mintSplitGuestPaymentLinkIfAbsent`) — and fires an admin alert on **every**
  hold-extension run until the child settles. If the parent itself is unpaid, no
  link is minted or emailed. Only genuine
  split children qualify: a #796 group joiner always has a `GroupBookingJoin`
  row. At most one live token exists per booking
  (every mint revokes-then-creates under the per-lodge advisory lock;
  undelivered emails revoke their link), and the link
  and the saved-card auto-charge never both settle durably: the charge claim
  revokes links, the /pay intent path re-reads the link and
  the on-demand path refuses when a saved card exists. The residual in-flight
  window is backstopped (#1992): a link PaymentIntent minted BEFORE the claim is
 cancelled on Stripe first, and if the member's confirm still wins,
  `markBookingPaymentSucceeded` auto-refunds whichever DISTINCT capture arrives
  second — durably with a loud admin alert —
  while a SAME-intent replay keeps its `already_paid` outcome and at most one
  side can ever be refunded. A capture already
  owned by the superseded-intent recovery machinery (`CANCEL_PAYMENT_INTENT` /
  `REFUND_SUPERSEDED_PAYMENT`) is never mistaken for the settlement side of such
  a pair. No beds are held for the child until it is paid. The same machinery
  backs `POST /api/bookings/[id]/send-guest-payment-link`. A child can end PAID
  while its parent is unpaid or later cancelled — the parent-cancel sweep only
  cancels still-PENDING children — and there is deliberately no auto-cancel past
  check-in (owner policy decision).

### INV-CAP-006

- Bed-allocation eligibility (`BED_ALLOCATABLE_BOOKING_STATUSES`) is a status-
  only superset of capacity-holding; the `capacity-holding ⊆ bed-allocatable`
  invariant still holds because rule (b) only extends holding to PENDING, which
  is already bed-allocatable (locked by
  `booking-status-bed-allocation-ownership.test.ts`, #813).

### INV-CAP-032

- **Every path that creates a booking guest writes their `BookingGuestNight`
  rows (#2739).** `BookingGuestNight` is the canonical night set; the whole
  bed-allocation surface and (since #2628) the officer card read it and only it.
  A guest created with no rows is a guest the system believes is nowhere. **This is a creation-path
  obligation, not a read-path fallback**: the envelope fallback in
  [INV-DATE-003] exists for pre-#713 history only. The five booking-request
  write points — `approveBookingRequest`, `approveSchoolBookingRequest`,
  `approveMemberWholeLodgeRequest`, `reassignHeldBookingGuests` and
  `holdBookingRequestSlots` — all write them. `HeldBookingGuestInput.nights` is
  REQUIRED and `toPipelineGuestCreateData` requires `nights` with no fallback, so
  a sixth pipeline without a night set is a TYPE ERROR, pinned by `booking-request-guest-nights.test.ts`.
- **The rows are half-open and NZ date-only**, built through the pricing
  engine's own night list: nights over `[checkIn, checkOut)` [INV-DATE-003] at
  the storage encoding [INV-DATE-013].
- **Per-night cents are the engine's where the engine priced the guest, and a
  division of the total where an officer set it.** ENGINE-PRICED (school and
  member whole-lodge approval with no flat total) stores
  `PriceBreakdown.guests[i].perNightCents` verbatim, as `buildGuestCreateData`
  does. OFFICER-TOTAL (public approval, quote hold, flat whole-lodge or manual
  override, backfill) divides to the exact cent with the extra cents on the
  EARLIEST nights — the `evenlySplitCents` vector
 — so Xero line items are byte-identical
  whether the rows exist or not. `buildApprovalGuestNights` refuses a vector that
  does not reconcile to the stored `priceCents` and divides instead.
- **The rows are the #1036 locked prices on the one edit path reaching these
  bookings.** Standard edits refuse a booking-request booking
  (`assertBookingNotQuotePriced`, #1032); of the three shapes
  `booking-batch-modification-service.ts` exempts, only the link-only #2337
  placeholder→member path prices, passing
  `link ? [] : lockedNightPricesForGuest(guest)`: the LINKED row re-rates at the
  member rate, every UNLINKED placeholder keeps its negotiated price
  (`src/lib/__tests__/school-booking-request.test.ts`). Owner-approved on
  #2739. Backfill and operator facts: `INV-CAP-035`.

### INV-CAP-035

- **The backfill for existing rows is
  `20260810010000_backfill_booking_request_guest_nights`**, the exact complement
  of #1098's `20260704150000_backfill_booking_guest_nights`. It is idempotent
  (per-guest "has no rows at all" guard plus `ON CONFLICT DO NOTHING`), skips
  cancelled, bumped and soft-deleted bookings, and is proven against a real
  PostgreSQL by its #2418 verification fixture. Two consequences are intended:
  booking-request hut fees now reach the finance revenue reconciliation's booking
  side, and a member an officer linked to a converted booking's guest is credited
  with the nights they really stayed by `countMemberStayNights`.
- **It is a DATA write taken before cutover**, at step 13 of
  `docs/PRODUCTION_UPGRADE_RUNBOOK.md` while the old colour still serves, and it
  is not `windowed`. So: (1) every approval and quote hold taken between
  `migrate` and cutover is written by pre-#2739 code and gets no night rows —
  **re-run the statement verbatim after cutover**, which inserts nothing where
  the first pass already ran; (2) aborting the cutover un-does the code but NOT
  the inserted rows, the only irreversible part of the release; (3) in that
  window the old colour's in-place hold reassignment updates
  `stayStart`/`stayEnd`/`priceCents` without rewriting night rows, so a quote
  accepted at a different option than the hold can leave backfilled rows
  describing the hold's dates and total — and invoicing prefers stored rows over
  the guest's flat `priceCents`. Remedy: re-raise or refresh the invoice for any
  request approved in the window, or take the deploy with quoting paused.

### INV-CAP-007

- Auto-allocated stays are **room-continuous per booking** (issue #1677): the
  planner (`buildFirstFitBedAllocationPlan`) places a booking's whole party in
  ONE room for the ENTIRE stay — in free space first, and for capacity-holding
  bookings by displacing whole provisional stays (#1387 preserved) — falling
  back to the legacy per-night split only when no single room can host the
  stay; fallback bookings are reported in
  `BedAllocationPlan.roomContinuityFallbackBookingIds`. Displacement relocates
  or unallocates a provisional booking's ENTIRE visible stay (one destination
  room) and never night-splits it — whole-stay room claims (Phase 2) evict
  newest bookings first, while the per-night fallback (Phase 3) selects
  victims in room/bed sort order; an
  admin-approved allocation (#776 lock) on ANY night pins the whole booking
  against displacement, as does a stay extending beyond the reconcile load
  envelope. Existing allocation rows are never rewritten by planning — only
  provisional displacement moves rows — and re-planning a fully-allocated
  state is a no-op.

### INV-CAP-008

- **Allocation preferences are per lodge and advisory, never safety
  overrides (#2593):** the board and lifecycle resolve the same strict saved
  order for the booking's lodge. The canonical default is booking cohesion →
  stay continuity → requested room → direct-family cohesion; an explicitly
  saved empty list is valid deterministic neutral behavior. Every hard
  invariant (maximum feasible placement count within a candidate, school
  separation, adult coverage, cross-booking age mix, lodge isolation,
  custodian/exclusive holds, approved-row pins, and displacement safety) is
  scored or enforced ahead of those preferences. Preference values then
  compare the bounded feasible candidates lexicographically from top to bottom;
  disabling a value removes only that comparison. Family cohesion means guests
  sharing at least one family-group id **directly**; connected components,
  direct subsets, capacity-aware high-affinity room packing, and
  maximum-cardinality direct-edge pairings provide bounded candidates but do
  not turn transitive acquaintances into a scored family pair. The planner
  executes at most 24 matching-layout candidates per booking, alongside its
  whole-room, legacy, and displacement trials. This is a deterministic bounded
  heuristic, not a claim of global optimality across all bookings. A settings
  save never moves an existing row: it affects later board suggestions and
  later lifecycle reconciliation only. The board's visible suggestions are a
  preview, never a persistence payload: Run Auto Allocation takes global then
  the selected lodge lock, refuses an unknown or inactive selected lodge, and
  rebuilds the complete scoped plan on that transaction client before writing,
  so a bed/room deactivate, retype, lodge
  mismatch, allocation/approval change, or hard-predicate change committed
  after preview cannot receive a stale AUTO row.

### INV-CAP-009

- **Cross-booking age mix (#1768, owner-set):** a room-night containing minors
  from booking X must never also contain an adult from a DIFFERENT booking —
  planner-enforced in both placement directions on every path (whole-stay,
  per-night split, adult spread, displacement eviction/relocation), including
  against pre-existing `occupiedBedNights`; an occupant row with no booking
  attribution conservatively blocks minors (counted as an unknown adult) but
  not adults. Same-booking mixing is unrestricted, and minors-only ROOMS are
  allowed: the booking-level rule stays night-scoped (Phase 0
  `NO_BOOKING_ADULT` — a minor needs a same-booking adult on-site that night,
  not in the same room). SCHOOL-request bookings (`isSchoolGroup`, from the
  origin/held `BookingRequest.type`) prefer adults together and students
  separate. **A shared DOUBLE bed grants no composition exemption (#2656,
  owner-set):** each of its two occupants counts toward the room-night
  composition under that occupant's OWN booking key, so a double holding an
  adult of booking A and an adult of booking B blocks a third booking's minor
  from that room-night exactly as one adult alone would; the index behind the
  guard is maintained per `bookingGuestId:stayDate` and no composition
  predicate reads the occupant view, pinned by paired regression tests including
  the positive control. The planner never rewrites persisted violations
  (manual/legacy rows) — the board surfaces them as `MINOR_ADULT_MIX` warnings;
  the manual board itself is warned, not blocked, **by design** (owner decision,
  2026-07-11, closing the deferral from #1768/PR #1775): the invariant binds
  every automated placement path, while the manual board deliberately stays an
  admin-judgment escape hatch with the warning as its guard. Do not add a hard
  block without a fresh owner decision.

### INV-CAP-010

- **Double-bed shared occupancy (#1701):** a `DOUBLE` bed may hold two occupants
  on a night — one primary and one second occupant — when they are declared
  partners: two `ADULT` members holding a **CONFIRMED** `MemberPartnerLink`
  (#1742), the single-source `mayShareDoubleBed()` rule in
  `double-bed-sharing.ts`. A PENDING link grants nothing; both members must
  also still be ACTIVE adults at placement time. (#1744 swapped this signal in
  for the interim same-`FamilyGroup` rule, which wrongly permitted e.g. a
  parent and an adult child.) The precondition is enforced at placement time
  AND swept when it later breaks (#1756): **no future `isSecondOccupant`
  allocation may outlive its partner link or the active-adult precondition**.
  Dissolving a CONFIRMED link (`removeOwnPartnerLink` /
  `adminRemovePartnerLink`), deactivating a member (member edit, bulk update,
  or account-deletion anonymisation), or correcting an ADULT to a minor/N-A
  tier acquires `acquireFuturePartnerSharedAllocationLocks` and runs
  `sweepFuturePartnerSharedAllocationsWithLocksHeld`
  (`bed-allocation-lifecycle.ts`) in the SAME transaction as the breaking
  event: the pair's future (tonight onwards, NZ date-only) second-occupant
  rows are deleted back to the awaiting-allocation queue — never the primary,
  so the sweep cannot orphan anyone and needs no promotion pass — with a
  `BED_ALLOCATION_PARTNER_SHARE_SWEPT` audit row against BOTH bookings and a
  post-commit admin alert (`admin-partner-share-swept`, "Booking review
  required" preference). A dissolve sweeps only bed-nights whose two occupants
  are exactly the dissolved pair; deactivation/tier change sweeps any future
  shared bed-night involving the member on either side. Past lodge nights are
  history and stay untouched, and the sweep is idempotent (a second run finds
  nothing).

### INV-CAP-030

**Member merge is the fifth writer of this invariant, and needs its own,
validity-driven form (#2595).** Merge COLLAPSES two identities:
`planPartnerLinkMerge` keeps at most one CONFIRMED partner for the master, and
`applyMoves` re-points `BookingGuest.memberId` onto the master while leaving
every bed allocation where it was. Neither #1756 scope
fits, so merge runs `sweepUnbackedFutureSharedDoublesWithLocksHeld`
(`bed-allocation-lifecycle.ts`): for the `[master, loser]` scope it re-derives
each candidate future bed-night's actual two occupants and re-asks
`mayShareDoubleBedWith` whether they may still
share, sweeping ONLY the bed-nights that fail — only the `isSecondOccupant` row,
with the same `BED_ALLOCATION_PARTNER_SHARE_SWEPT` audit against both bookings
(reason `members_merged`, `issue: 2595`) and the same post-commit admin alert. A
guest with no member on either side is swept without an eligibility round-trip;
a bed-night whose primary is missing is left to the #1750 promotion pass. It is
idempotent.

Its lock prefix is DELIBERATELY narrower than its #1756 sibling's:
`acquireMemberMergePartnerSharedLodgeLocks` takes every affected lodge capacity
key in sorted order BEFORE any member-lifecycle key, and NO global cohort
`lock(1)`. Instead: a wider lodge
derivation (the members' future bed allocations UNION the lodges of EVERY
booking they hold a guest row on, no date filter since #2672) plus two run-time
checks — the sweep re-derives the guest-row lodges under merge's `Member … FOR
UPDATE` and refuses the whole merge with a 409 if the prefix no longer covers
them, and refuses rather than judge a bed-night whose room sits outside the set
(docs/CONCURRENCY_AND_LOCKING.md). That
derivation reads `Booking.lodgeId` as **immutable for the row's life**, which the
schema does not enforce, so `bed-allocation-lock-topology-contract.test.ts` fails
the build on any writer of that column: a `Booking` update takes no lock on
`Member`, so a move committed after the re-derivation would leave the sweep
judging an unserialised lodge with no refusal.

### INV-CAP-031

Membership cancellation and archive need no sweep call: approval is blocked while
ANY future booking or member guest appearance exists. Only an admin adds the
second occupant on the board, and only onto a bed whose primary already **holds
capacity** — checked at PLACEMENT time only (`BED_ALLOCATABLE_BOOKING_STATUSES`
is a deliberate superset of the capacity-holding statuses), so a strong default
rather than a guarantee. Since #2656 the planner **represents** a shared double —
occupant identity is keyed `bedId:stayDate:bookingGuestId`, distinct from the
`bedId:stayDate` capacity key — so it never frees a bed-night one of the pair
still occupies, never treats a two-booking bed-night as a SINGLE-BED displacement
target, and counts an emptied double as one freed bed. Auto-allocation never creates a second occupant;
every other bed type stays one occupant per night. DB-enforced without CHECK
constraints: `@@unique([bedId, stayDate, isSecondOccupant])` caps a bed-night at
≤2 rows and a raw-SQL partial unique index (`prisma/partial-unique-indexes.tsv`) caps every non-DOUBLE bed at one;
`BedAllocation.bedType` is the denormalized copy that index reads.

The **base** capacity figure is unchanged — a shared double is ONE bed of
`activeBedCount`, each occupant a full person-night — but each active DOUBLE adds
one **partner-shared slot** of admission headroom (#1745): reserved (only
`checkCapacityForPartnerSharedAdmission` on the admin-initiated partner flow may
use it; every other path reads the base `getLodgeCapacity`), bounded (≤ active
DOUBLE count per night, the sharer's partner holding a base-backed place), and capped by an explicit
`LodgeSettings.capacity`, which limits *people*, so a `capped_beds` lodge gets no
headroom (docs/CAPACITY_MODEL.md).
Initiation is admin-only (#1746): `partnerSharedGuests` flags are rejected for
non-admin actors at route and service, quick-add candidates are server-computed
(`listBookingPartnerSharingCandidates`), and the public wizard carries no
shared-slot affordance. A DOUBLE holding a second occupant cannot be retyped to a
non-double until that occupant is removed. Survivor promotion: `INV-CAP-036`.

### INV-CAP-036

Whenever a shared double loses its primary — a reviewed removal (#2594), a board
move of the primary, a cross-booking cancellation / reconcile prune (#1750), or
the lifecycle displacement apply path (#1387/#1677, promoting since #2656) — the
surviving partner is **auto-promoted** to primary on the vacated bed-night
atomically with the removal on transactional paths. The displacement path reads
the rows it is about to move or delete BEFORE the write, promotes the survivor on
every bed-night that lost its primary, and clears `isSecondOccupant` on a MOVE (a
relocated row lands alone on a bed that was free at plan start). Promotion is
gated on `isSecondOccupant` alone, never the denormalized `bedType` of either
row: an AUTO-allocated row on a real DOUBLE carries the SINGLE default. The
bed-night is therefore never dead-ended behind the orphaned-second-occupant guard
in `resolveSecondOccupant`, and re-pairing follows the normal sharing rules.

Single-row paths write one `BED_ALLOCATION_PARTNER_PROMOTED` audit per promotion,
because the partner may belong to a different booking. Two bulk paths batch it —
**range assignment** (#2251, up to 366 bed-nights) and **reviewed removal**
(#2594) — each recording **one `BED_ALLOCATION_PARTNERS_PROMOTED`** entry
targeted at the anchoring booking, listing each promotion (`{allocationId,
bookingId, bookingGuestId, bedId, stayDate}`) up to the audit sanitiser's
50-identity bound with the exact `promotedCount` and a `promotionsTruncated`
flag, so audit rows stay bounded independently of the range length.

The reviewed-removal and board-move services self-wrap read + write + promote in
a transaction; the lifecycle prune captures-before / flips-after on the caller's
client. Stated limit: callers that reconcile on the bare `prisma` singleton
(e.g. `cron-complete-bookings`, the confirm-pending-guests route) can, on a crash
between delete and flip, leave a recoverable orphaned second occupant — visible
on the board and cleared by the next reconcile or a manual move, never a
capacity or double-booking violation.

### INV-CAP-011

- Waitlisted and offered bookings do not consume capacity until confirmed.

### INV-CAP-012

- A waitlist offer reprices the booking at current season rates,
  membership-type policy, group discount, and promo validity at the moment the
  offer is issued; the offer email states the price the member will pay on
  confirmation. The creation-time price snapshot is not a price lock — an
  identical booking made directly on the offer day pays the same. If repricing
  fails, the offer proceeds at the stored snapshot rather than being blocked.

### INV-CAP-013

- A linked `Member` may be present on only one live booking per lodge night
  (night as defined by the stay-boundary invariant above, which also makes a
  same-date lodge-to-lodge move legal by construction). This person-night
  guard is separate from bed capacity: it checks draft,
  pending, confirmed/paid/completed, waitlist, offered, and admin-review
  bookings, but ignores cancelled, bumped, deleted, and expired draft rows.

### INV-CAP-014

- A member put on somebody ELSE's booking may take their own place off it, and
  only their own place. The rule is one shared server-side predicate
  (`evaluateGuestSelfRemoval`, `booking-guest-self-removal.ts`): not the
  booking's owner, the guest row is their own, the booking's status is one of
  the eight self-removable ones, the stay is still in the future (NZ date-only
  check-in strictly after today), and they are not the last guest. The
  authoritative gate is `removeBookingGuestInTransaction`, which imports the
  same status set and additionally refuses a quote-priced booking and a settled
  booking whose refund/credit election only the owner or an admin may make.
  Every surface that offers the action — the booking wizard's night-conflict
  card and the booking detail page's own card (#2250) — drives its visibility
  from that predicate rather than a client-side copy of it, so a member is never
  shown a control the service would refuse; where it says no, the action is
  hidden and the reason is stated instead. The booking detail page also passes
  `isQuotePriced` (one indexed `isQuotePricedBooking` lookup, run only when the
  action would otherwise be offered), so the quote-priced refusal is predicted
  rather than discovered on submit. The settled-booking refund/credit election
  stays server-only by design: predicting it needs the price delta of the
  removal, which is the full repricing pass inside the removal transaction, and
  a cheaper guess ("has a captured payment") would hide the action from members
  the service would allow. That refusal surfaces as the service's own
  plain-English 400, which the card shows verbatim.

### INV-CAP-015

- The 409 the person-night guard returns is read by whoever made the request,
  which may be a member adding somebody else as a guest. Its human-readable
  message is therefore composed only from what that requester already supplied —
  the member they tried to book and the nights they chose — plus the next step
  their own `canSelfRemove` / `isOwnBooking` / `isSelfGuest` / `canOpenBooking`
  flags allow. **The payload is scoped to match** (#2250): a conflict row carries
  `bookingId`, `bookingStatus`, `bookingOwnerName`, `bookingCheckIn`,
  `bookingCheckOut` and `guestId` only when the server marked this viewer
  `canOpenBooking` — the booking's own owner, an admin, or the conflicting guest
  themselves. An unentitled row carries nothing but the member the requester
  tried to book, that member's name, the intersection with the nights they chose,
  and the four viewer-aware booleans. The gate lives at the single assembly point
  in `findBookingMemberNightConflicts`, because every route that returns this
  body passes the array straight through; the copy layer
  (`describeBookingMemberNightConflictBooking`) gates independently and fails
  closed, so a row missing the detail says nothing rather than rendering
  `undefined`.

### INV-CAP-016

- The same 409 is produced by flows whose reader cannot change the dates (the
  admin booking-request approve / hold / send-quote routes and the booking
  modify routes), so the server-built message is flow-neutral. Only the booking
  wizard — the one surface whose reader is choosing the dates — renders the next
  step with `canChooseDifferentDates`, which is what adds "…or choose different
  dates" (#2250).

### INV-CAP-017

- The person-night guard is app-level enforcement by design (#1039 item 3): a
  database unique index cannot express it because liveness is booking-status
  dependent and spans `BookingGuest` to `Booking`, which a Postgres partial
  unique index cannot reference. It is race-free because every transaction that
  **creates or re-dates** a member-linked `BookingGuest`/`BookingGuestNight`
  footprint takes its per-lodge capacity lock before running
  `assertNoBookingMemberNightConflicts`, whose first authoritative action takes
  sorted per-member-night advisory locks across lodges (#1881). A writer that
  also moves booking status or money takes global `lock(1)` before those locks.
  The lodge-before-member ordering and the guard's self-lock are frozen by
  `review-findings-contracts.test.ts`. (`CONCURRENCY_AND_LOCKING.md` maps these
  locks alongside the per-member credit lock and the ordering discipline each
  follows.) Writes that do not change the member-night
  footprint — re-pricing, name-only guest edits, lodge arrive/depart timestamps,
  and anonymization that clears the member link — legitimately skip the guard, as
  does the non-member group-join path (`verifyAndCreateNonMemberJoin`, which
  writes only `memberId: null` guests and takes the lock but is a guard no-op).
  When an admin links a booking-request guest to a real member — or opens a
  request that already carries persisted linked members — the linking UI runs an
  **advisory-only** overlap pre-check (`findLinkedGuestMemberNightConflicts`,
  #1226) so any conflict surfaces before approve/hold. The panel computes it on
  load for pre-existing links and on every link/unlink, applying only the latest
  response per request so a slower earlier check can't overwrite a newer one
  (#1226 follow-up). It is non-authoritative — it never throws, blocks, or takes
  the advisory lock, and it excludes the request's own held booking — the
  transactional `assertNoBookingMemberNightConflicts` guard at approve/hold time
  remains the sole enforcer.

### INV-CAP-018

- A member holds at most one group-join roster row per group
  (`GroupBookingJoin` unique on groupBookingId + joinerMemberId, #1039
  item 2). The roster row is written inside the child booking's transaction:
  a duplicate live join aborts the whole transaction, and a row left by a
  cancelled or bumped join is reused on re-join. Non-member join requests
  carry a NULL member id and sit outside the constraint.

### INV-CAP-019

- Draft, pending, waitlist, payment-recovery, and review states must have
  expiry, retry, admin visibility, or repair paths.

### INV-CAP-020

- Linked provisional-child cancellation is guarded against the hold-resolution
  cron (#1881 residual): after a parent cancel, each candidate takes global
  `lock(1)` then its immutable lodge's per-lodge lock, is re-read, and is
  conditionally claimed only while still `PENDING`. A child the cron already
  confirmed or charged is never overwritten, and a lost claim runs none of the
  cancellation side effects.

### INV-CAP-021

- **Exclusive whole-lodge hold (ADR-001, #118):** a night overlapped by a
  capacity-holding booking with `Booking.wholeLodgeHold = true` admits no
  further capacity from any admission path — the night's `availableBeds` is
  hard-blocked at 0, never negative, so it cannot be bypassed by the admin
  over-capacity override (#1668). To non-admins the held lodge presents
  exactly as an ordinary full lodge (decision 6); only admin surfaces are told
  a hold is in effect. Full scenario table in `docs/CAPACITY_MODEL.md`,
  "Exclusive whole-lodge hold — a non-bypassable block".

### INV-CAP-022

- **A held booking owns no `BedAllocation` rows (ADR-001 §Bed allocation,
  #2285):** the group implicitly occupies every bed, so both **automatic**
  allocation paths skip it — the admin board excludes it from the
  awaiting-allocation set and the planner, and the lifecycle reconcile prunes
  its rows and never auto-places it (keyed on the flag, not status). Every
  planner additionally re-reads the bookings it is about to write rows for
  immediately before the write, so a hold, cancel or soft delete landing
  between planning and writing cannot be undone by a re-insert. The manual
  board path is guarded separately, at the single allocation-write chokepoint
  added by #2251 (stacked on #2285 and landing with it): every manual path —
  single-night board placement, the bulk multi-night drop and range assignment —
  goes through `assertGuestAndBedForAllocation`, which refuses a held booking, so
  a hand-placed row can no longer be created only to be swept by the next
  reconcile. The exclusive-hold toggle reconciles both directions (set prunes, release
  re-plans), and a school approval granting exclusivity prunes after stamping
  the hold; both record the removed rows in their audit entry so a mistaken
  hold can be undone by hand. Divergence guard:
  `src/lib/__tests__/held-booking-allocation-agreement.test.ts`.

### INV-CAP-023

- **A held booking's nights ARE occupied as far as both planners are concerned
  (ADR-001 amendment, #2285, resolved by #2317):** a whole-lodge hold's nights
  are synthesised into both bed-allocation planners as **unattributed,
  non-displaceable** occupancy — every active bed, every held night — while the
  hold owns no `BedAllocation` row. The rows carry a null booking and a null
  guest (#1768 "unknown occupant" shape): unattributed and non-displaceable (no row for a `MOVE` or `UNALLOCATE` to
  target). A tierless unknown occupant counts as an adult for the cross-booking
  age-mix guard. An officer-kept overlapping booking is therefore never
  auto-placed onto beds the held group is using; those guest-nights surface as
  `NO_BED_AVAILABLE`. Being unattributed is a property of the
  bed-NIGHT: a real `BedAllocation` row can legitimately share a held bed-night
  (decision 1 never refuses the overlapping booking), planner occupancy is keyed
  `bedId:stayDate`, and evicting the co-located booking releases that booking's
  claim and never the hold's. **The blocking predicate is the capacity engine's
  own** — `wholeLodgeHold` AND `bookingHoldsCapacity` /
  `capacityHoldingBookingFilter()` over the same lodge — so a planner can never
  report a night as held that the engine would admit into, and a stale hold flag
  blocks nothing in either place. Both writers re-read the live holds on the
  client that is about to write; every placement transaction this code **opens
  itself** takes the per-lodge advisory lock first, while a reconcile inside a
  CALLER's transaction inherits that caller's lock discipline and relies on the
  re-read. **Manual placement is deliberately
  untouched:** ADR-001 decision 1 hands an overlap to the booking officer, and a
  write-time refusal would remove that path. The officer sees the board's banner
  plus the **Overlaps exclusive hold** chip, and a hold with no guests entered yet blocks without appearing in the
  banner. Source `exclusive-hold-occupancy.ts`; guards `exclusive-hold-planner-occupancy.test.ts` and `custodian-write-path-contract.test.ts`.

### INV-CAP-024

- **The requested-room lock follows the approved rows, not the hold (#776,
  #2285):** setting an exclusive hold prunes the booking's approved allocations,
  so `isBookingBedAllocationLocked` goes false and the member's requested-room
  editor re-opens; the re-plan after a clear creates unapproved AUTO rows, so it
  stays open until an admin approves again. Intended: with no allocated beds
  there is nothing for the lock to protect.

### INV-CAP-025

- **Approving beds is always scoped, and the booking is a first-class scope
  (#2252):** `approveBedAllocations` stamps `approvedAt`/`approvedByMemberId`
  only where `approvedAt: null`, and refuses outright when NONE of its three
  selectors — `allocationIds`, a date `range`, or a `bookingId` — is given, so
  an unselected approval can never stamp every pending row in the database.
  `bookingId` is sufficient ON ITS OWN and only ever narrows when combined with
  the others; it exists because the in-booking panel has no safe alternative
  (`allocationIds` caps at 250 and a long stay can exceed it, and the `from`/`to`
  form approves every pending allocation of every booking in the window). A
  booking-scoped approval audits `BED_ALLOCATION_APPROVED` with
  `targetId` = the booking id, because the booking page's audit deep link
  searches `targetId` and never metadata. The booking selector honours the same
  ADR-003 lodge scope the range selector does, so the approve can never reach
  wider than the lodge-scoped read the officer was shown — an anomalous row of
  the booking in another lodge's room is neither displayed nor confirmed.

### INV-CAP-026

- **The requested-room lock is two-way, and nothing pretends otherwise
  (#776, #2252, #2594):** no un-approve action exists and none is invented, but
  two ordinary paths can take a booking's last approved row away and re-open the
  member's editor — a board MOVE re-drafts the row it updates (the upsert's
  update branch clears `approvedAt`/`approvedByMemberId`), and reviewed removal
  deletes it. The removal preview computes `reopenedBookings` from every approved
  row on each affected booking, never only the 31-night page on screen, and the
  shared dialog names that consequence before apply. Member requested-room
  writes take global `lock(1)`, lock and re-read the booking row, then use a
  guarded update whose predicate still says no approved allocation exists; an
  approval or removal that wins first therefore changes the authoritative answer
  rather than being crossed by a stale room-request write.
  The same three paths (single-night/drag placements, `source: "AUTO"`
  suggestions, and move re-drafts) are why draft rows persist under #2251's
  auto-approve, and why a confirmation affordance stays meaningful.

### INV-CAP-027

- **Existing allocation moves preserve their lodge nights, require review, and
  commit atomically (#2366, #2595):** an existing-chip drag or **Move to bed**
  menu choice selects a destination bed only; the hovered column is never a
  target date, and both pointer and keyboard paths open the same confirmation
  dialog before any write. The reviewed request is an exclusive typed shape:
  anchor allocation, destination bed, `ALLOCATION_NIGHT` or `BOOKING_GUEST`
  scope, and `v1:<sha256>` preview digest. The legacy `{ allocationIds, bedId }`
  request remains capped at the 31-night board limit for older callers.

  Night scope resolves the anchor only. Person scope resolves every existing
  row for that guest on that booking, including sparse/off-screen nights, up to
  366; it creates no missing guest-night or allocation. Preview needs
  `bookings:view`, writes nothing, and separates changed/noop rows while showing
  approval re-draft, shared-double promotions, and every hard refusal. The
  digest binds the full selected and relevant occupant sets plus booking,
  guest-night, consent, member/age, partner-link, destination, custodian-hold,
  whole-lodge-hold and derived feasibility state. Counterpart identities never
  enter the response.

  Apply needs `bookings:edit` and takes global `lock(1)` -> the complete sorted
  source/destination/booking/occupant lodge union -> sorted member-lifecycle ->
  sorted member-partner-link -> deterministic allocation-row locks. It re-reads
  and re-digests before one guarded `UPDATE ... FROM (VALUES ...)` statement
  (up to 366 rows, bounded budgets). Cancellation uses the same global key, so a move can never resurrect
  a pruned row. Changed rows keep their original NZ dates, become unapproved
  `MANUAL` drafts, and commit with any partner promotions and bounded causal
  audits. Unchanged rows are digest-bound but excluded from feasibility,
  promotion, write, re-draft, and audit. An all-noop confirmation succeeds with
  explicit feedback and no audit. Any stale fact, conflict, or guarded-count
  mismatch refuses atomically; a stale digest carries a refreshed preview and
  requires confirmation again. Bucket-to-board placement keeps its separate
  per-night partial-conflict contract.

### INV-CAP-028

- **Destructive allocation removal is preview-bound and never replans
  (#2594):** every UI entry point uses
  `POST`/`PUT /api/admin/bed-allocation/allocations/removal`; the old direct
  `DELETE /api/admin/bed-allocation/allocations/[id]` route is retired. Preview
  needs `bookings:view`, writes nothing, and accepts exactly one of four scopes:
  one anchored allocation, one guest on one booking, one whole booking, or one
  lodge's half-open visible window of at most 31 nights. Guest and booking scope
  include off-screen rows by design; window scope never crosses its lodge or
  visible dates. Category selection is a non-empty subset of three mutually
  exclusive classifications: unapproved `AUTO`, unapproved `MANUAL`, and any
  approved row regardless of source.

  The `v1:<sha256>` preview digest includes canonical scope, sorted categories,
  every matching row's mutable identity, every approved row on the affected
  bookings, and every causal shared-double sibling. Apply needs `bookings:edit`,
  resolves the immutable booking lodge plus the reviewed anchor lodge, then
  takes global `lock(1)` → sorted lodge locks → sorted allocation-row locks
  before an authoritative re-preview. ID- and bed-night-expanded queries use
  sorted 10,000-value chunks under that same transaction, below PostgreSQL's
  bind-parameter ceiling without weakening all-or-nothing rollback. A matching or causal row in any third
  lodge is refused without mutation. If an aggregate booking/person preview's
  opening row disappeared, the refreshed preview re-anchors to the lowest-id
  matching survivor so a subsequent reviewed apply is reachable.
  A missing/moved anchor, changed category membership, new approval, promotion
  change, or any other digest drift returns 409 with a refreshed preview and
  writes nothing. A matching apply deletes the complete reviewed set, promotes
  any stranded shared-double second occupants, and writes one bounded operation
  audit plus one bounded promotion audit in the same transaction. It never calls
  board or lifecycle auto-allocation: no replacement row appears until an admin
  explicitly places it or runs auto-allocation later.

### INV-CAP-029

- **A range assignment writes all or nothing, and records itself once (#2251):**
  `assignBedRange` scans, writes and audits inside one transaction. If any
  requested night is blocked, NOTHING is written and the caller receives a
  per-night refusal in one of three never-merged categories — `BED_TAKEN` (a
  provisional occupant counts), `GUEST_NOT_BOOKED` (a bad request, never a
  silent skip, including a gap night of a non-contiguous stay, #713), and
  `EXCLUSIVE_HOLD`, meaning **the guest's OWN booking** holds the lodge
  (ADR-001's short-circuit). Another booking's overlapping hold is surfaced on
  the board (`overlapsExclusiveHold`), not refused here. A partial result exists
  only when a human sends the explicit `nights` list they were shown — the
  server writes exactly that set or refuses it with a fresh report. Every
  attempt that COMPLETES — applied or refused — produces exactly ONE
  `BED_ALLOCATION_RANGE_SET` audit entry against the booking id in the same
  transaction; an attempt that THROWS rolls back and records nothing. That entry
  records shape, not people: night counts and runs per category plus booking
  ids, with guests' names only in the API response. The only other row the
  transaction may write is the single batched `BED_ALLOCATION_PARTNERS_PROMOTED`
  entry (`INV-CAP-036`), so **both the statement count and the audit-row count
  are fixed whatever the night count**. Proceeding past `GUEST_NOT_BOOKED`
  nights requires an explicit on-screen confirmation naming how many nights are
  not part of the guest's booking (never "outside the stay") and how many will
  be written. The 31-night `MAX_BED_ALLOCATION_RANGE_NIGHTS` bounds the board's
  READ window, not this write; lodge capacity never reads `BedAllocation` rows.
  Placement paths nevertheless take the destination lodge's capacity lock because
  custodian holds share the bed inventory (#2286). The write bound
  (`MAX_BED_ALLOCATION_ASSIGN_RANGE_NIGHTS`, 366) keeps one transaction finite
  and is **refused at, never silently truncated to** — as is every board window
  the admin types.

### INV-CAP-033

- **The bed-allocation board never offers a bed choice without a concrete lodge,
  and every club-wide board says why it is club-wide (#2701):** the board's
  lodge scope is one of five named states — `lodge`, `all`, `empty`,
  `resolving`, `unavailable` — and **the set is total**: every combination of
  selection, permission, failure, loading and option count lands on exactly one.
  `all` carries the REASON it was reached — `chosen` from the selector (or a
  `?lodgeId=` naming the sentinel), or `no-lodge-permission` for a role that may
  open this board but not read the lodge list (the shipped `ADMIN_MEMBERSHIP`
  and `FINANCE_ADMIN` presets); both are honest, read-only views that say which
  they are. `resolving` fetches no dashboard, so a direct visit cannot render a
  club-wide board on its way to a real lodge; `unavailable` (a
  `/api/admin/lodges` failure that is **not** a 403) is an error with a retry,
  distinguishable from `all` **by construction**. Without a concrete lodge,
  every allocation control that needs one is disabled with its reason on
  screen: Select bed and Allocate, Move to bed, drag-and-drop, Assign range, Run
  Auto Allocation, Approve Visible, Reset allocations, Remove allocation, and the
  per-lodge preferences section. This is a rule about what the operator is
  OFFERED; it layers on top of, never replaces, the writer-side refusals
  (`assertGuestAndBedForAllocation` and `LODGE_MISMATCH` in
  `bed-allocation-move.ts`). A read-side backstop mirrors them:
  `GET /api/admin/bed-allocation` refuses a `lodgeId` contradicting a named
  `bookingId` with a 409 `LODGE_MISMATCH`; an unresolvable `bookingId` never
  triggers it. **While a booking is focused, its lodge is authoritative and the
  selector's ADR-002 default must not write at all** — that default fires
  whenever fewer than two ACTIVE lodges are offered, so left running it
  overwrites the server-derived lodge and re-fires the request in a loop; a
  booking at a DEACTIVATED lodge is the reachable case.

### INV-CAP-034

- **A booking names its lodge, and the server never fills the blank (#2701):**
  `POST /api/bookings` refuses a create carrying no `lodgeId` with a 400 and
  `code: "BOOKING_LODGE_REQUIRED"`, checked BEFORE any lodge resolution so the
  club's default lodge is unreached — one gate instead of one guard per surface.
  Four consequences are load-bearing:
  - **The shared resolver stays permissive.** `resolveOptionalActiveLodgeId`
    still defaults for READS, where an omitted lodge legitimately means the
    whole club — the mode `INV-INT-016` retains for outside consumers. The
    strictness belongs on the write, not in the helper.
  - **A member is always shown the lodge they are booking**, on every booking
    including in a single-lodge club.
  - **A member cannot complete a booking whose lodge is unknown; an admin
    booking on someone's behalf may continue**, with the lodge named on screen
    before anything is written. The member Dates step is the transport boundary
    as well as the visual one: loading, failed, forbidden and successful-empty
    lodge lists mount no availability calendar and issue no lodge-dependent
    room, availability, policy, quote, create, waitlist, draft or
    exception-request call. A retry returns to Dates, reloads the options and
    waits for a selected id validated by that successful response.
  - **Every booking-create service requires the authoritative lodge, including
    callers that bypass the HTTP route.** Copying a booking carries the source
    booking's `lodgeId`; a member joining a group carries the organiser
    booking's resolved lodge. The shared TypeScript input makes `lodgeId`
    required, and every public create service runtime-refuses a missing, blank
    or unchecked value before it can call the permissive read resolver. The
    exact call-site census in `booking-create-requires-lodge.test.ts` fails on
    insertion/deletion drift, indirect argument objects and an explicit
    `undefined`, `null` or `void` value.

### INV-LIFE-062

A `HutLeaderAssignment` may additionally hold ONE bed (`bedId`): a **custodian
occupancy** (#2286).

- **Optional and inert by default.** `bedId = null` is a role only, with zero
  capacity effect.
- **One explicit lodge owns the interactive workflow.**
- **Inclusive night semantics.** The hold covers every night from `startDate`
  to `endDate` **inclusive**, never the half-open booking envelope.
- **Counted as an occupant, never as a smaller lodge.** The per-night custodian
  **count** is added to `occupiedBeds`, not subtracted from `lodgeCapacity`, so
  `occupiedBeds + availableBeds === lodgeCapacity` holds every night.
- **No booking, no allocation row, no guest.** A custodian is not a
  `BookingGuest`: absent from the chore roster, booking rows and display
  occupancy counts.
- **Two assignments never hold the SAME bed on an overlapping night**; the
  one-day handover overlap is allowed only on different beds, refused on write.
- **A whole-lodge hold and a custodian never contend**: the hold reserves the
  *bookable* lodge; the custodian's bed sits outside that pool.
- **Exclusion is enforced in application code, never by a database constraint**
  (owner decision 28 Jul 2026). (1)
  **every** `BedAllocation` write path re-reads the live holds **on the same
  client, immediately before the write**, and refuses or drops what would land
  on one — `allocateBedNightWithLocksHeld`, the range assign's `CUSTODIAN_HOLD`
  classification, `runAutoBedAllocation`'s in-transaction re-filter, and the
  lifecycle reconcile's `dropRowsOnCustodianHeldBedNights`. (2) Every placement transaction this code **opens itself**
  takes `acquireLodgeCapacityLock` as its first statement
; a reconcile inside a CALLER's transaction inherits
  that caller's lock discipline and still re-filters at write time.
  `custodian-write-path-contract.test.ts` fails CI on an undeclared write path
 and asserts (2) as an ORDER over
  each self-wrapping writer's body (#2688). `CUSTODIAN_BED_CONFLICT` on the board
  surfaces any row that got through.
- **A held bed cannot be deactivated or deleted**, nor its room, while the hold
  exists (`onDelete: Restrict` backstop).
- **Minor privacy.** A minor-age custodian is never individually named on the
  lobby display.
