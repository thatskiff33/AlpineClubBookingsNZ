# The club-time kernel

Audience: Developer, Agent.

`src/lib/club-time/**` is the one place this product turns dates and times into
each other. If you are about to format a date, derive "today", work out when a
stay starts, or convert a wall-clock time into an instant, it goes through here.

The rules it enforces are `INV-DATE` (in
[`invariants/booking-dates-and-capacity.md`](invariants/booking-dates-and-capacity.md))
and `INV-CONFIG-002` (in
[`invariants/product-configuration.md`](invariants/product-configuration.md)).
This page is the developer contract; it states no rule of its own.

## The three concepts, and why they are different types

Most date bugs in this repository have been one concept wearing another's
clothes, so the kernel makes them distinct in the type system rather than in
prose.

| Concept | Type | Zone? | Examples |
| --- | --- | --- | --- |
| **Calendar date** | `CalendarDate` — a branded `YYYY-MM-DD` string, `0001-01-01` to `9999-12-31` | **never** | a lodge night, a birthday, a season start, a promo window |
| **Instant** | `Instant` (a bare `Date`, Prisma's shape) | **required to read** | `createdAt`, when a payment settled, when an email sent |
| **Club-local scheduled time** | wall clock + zone → `Instant` | required | a job at 08:00 club time, noon arrival and departure |

**A calendar date takes no zone argument, anywhere, and that is not an
omission.** 16 April 2026 is a Thursday in every zone on earth. The calendar-date
formatters pin `timeZone: "UTC"` over the UTC-midnight encoding, so the
projection is provably the identity — which is why a `"use client"` component can
render a lodge night correctly with no zone plumbing at all.

**The brand means what it says, and arithmetic that would break it throws.**
`addCalendarDays` and `addCalendarMonths` refuse a fractional step and refuse to
leave the four-digit range, with a `RangeError`, rather than returning a branded
value that fails the type's own validator. That is not defensive tidiness: a
five-digit year still satisfied the brand, so every downstream `slice(0, 4)` read
it as the wrong year and `compareCalendarDates` silently reversed the order —
which reached production through an admin URL as an audit log that came back
empty while the page still said what it had been asked for.

**An instant has no calendar day until you supply one.** `createdAt.toISOString().slice(0, 10)`
is the UTC day, which is *yesterday* in New Zealand for roughly the first half of
every New Zealand day. That is `INV-DATE-019`, and it is the single most repeated
defect in this codebase's history.

## Where the zone comes from

One place: `getClubTimeZone()` (CT-1, `INV-CONFIG-002`), the persisted
`ClubTimeSettings.timeZone`. The kernel never reads `APP_TIME_ZONE`, never reads
`process.env`, and never asks the browser.

- **Server component or route** — `await clubTime()` from `club-time/server`,
  which is `server-only` and request-scoped through React `cache()`. It returns
  a bound API so you do not thread the zone through every call.
- **A shared `src/lib` module a CLI can reach — and only then.** Use
  `readClubTimeZoneOutsideRequest()` from `club-time-zone-runtime`.
  `server-only` is a bare `throw` that is inert only under the `react-server`
  condition, which `tsx` does not set, so a shared module importing
  `club-time/server` kills every command-line entry point that reaches it — at
  import, before `main()`. That has happened twice: CT-5 (#2869) broke two
  operator CLIs and added this reader, and CT-4 then broke the multi-lodge E2E
  seed the same way. `cli-server-only-reach-census.test.ts` is the guard, and it
  derives its entry points from where they are actually invoked rather than from
  a list somebody has to remember to extend.

  **"Shared `src/lib` module" is not the test — being CLI-REACHABLE is**, and
  the difference is one decision this file now makes once instead of leaving to a
  per-file coin flip (#2870). A `src/lib` service that only a route and a React
  render ever import should use `clubTime()` / `clubTimeZone()` from
  `club-time/server`, because those are request-scoped through React `cache()`:
  `readClubTimeZoneOutsideRequest()` is deliberately not memoised, so every call
  is another `clubTimeSettings.findUnique`. `admin-payments-service.ts` is the
  worked example — it takes the CLI-safe reader on a path that is only ever a
  React request, and pays one extra settings query per payments-list request with
  a date bound for a `server-only` hazard that module does not actually have.

  **How to check, rather than guess.** Run
  `cli-server-only-reach-census.test.ts`: it walks the real import graph from
  every CLI entrypoint, so if your module is reachable from one it will say so.
  If nothing reaches it, `club-time/server` is *usually* the right reader and the
  memo is free. If something does — or if you are writing the module a diagnostics
  pack is about to import — take the runtime reader and say in its docblock which
  entrypoint made that necessary, so the next reader can re-measure the claim
  rather than inherit it. A docblock asserting a hazard that no longer exists is
  the pattern this repository keeps re-finding; measuring beats repeating.

  **"Usually", because a green census is not a licence to move a SCHEDULED JOB.**
  Measured across the nine sites that compose the runtime reader (#2870, F4a):
  only `booking-create.ts` is statically CLI-reachable, through
  `e2e/setup/seed-second-lodge.ts`. The other seven files are the cron modules
  and `config-transfer`, and the census cannot see their hazard **by design** —
  `src/instrumentation.node.ts` loads each job through a LAZY
  `await import(...)`, and the census counts static edges only, because counting
  lazy ones would report every legitimate deferred import in the tree. Next
  bundles instrumentation separately from routes, so a `server-only` import on
  that graph throws when the job runs rather than at boot, and `cache()` gives a
  cron tick no memo to win anyway. So the reader choice is: **static CLI reach,
  or reach from instrumentation — either one means the runtime reader**, and only
  a module that neither can touch should take `club-time/server`.

  Measured again for the payment-link expiry mint (#2870): `payment-link.ts`,
  `booking-request.ts`, `group-booking.ts` and `cron-confirm-pending.ts` are
  reachable from **no** CLI root, and from `src/instrumentation.node.ts` by all
  four — the cron through `general-cron-runner`, `group-booking` through the Xero
  inbound chain. So all four take the runtime reader, and the rule decided the
  answer without a judgement call. Where such a module also runs under a lock, it
  resolves the zone before the transaction and threads it in as a value; see
  `docs/CONCURRENCY_AND_LOCKING.md` -> "Which client reads the club's timezone".
- **Client component** — `useClubTime()`, from `@/components/club-time-provider`.
  The zone is resolved on the server and delivered through a context mounted by
  exactly two components, `AppProviders` and `WebsiteChrome`, which between them
  cover every route group. **The hook throws when the provider is missing**,
  rather than falling back — a fallback renders a plausible wrong hour and
  nothing fails, which is the worst outcome available. That is only a safe
  choice because the mount is *enforced*:
  `club-time-provider-mount-census.test.tsx` walks every page, follows the
  import graph, and fails if anything reachable from a providerless surface
  reads the hook. Six such surfaces are named there, each with its reason.
  A client component must never call
  `Intl.DateTimeFormat().resolvedOptions().timeZone`: that is the viewer's zone,
  not the club's, and `INV-CONFIG-002` forbids it. **Very often you need no zone
  at all**, because what you are rendering is a calendar date — 28 of the 57
  components censused for CT-4 needed no zone plumbing whatsoever, and finding
  that out first is what kept the migration from becoming a prop-threading
  exercise across 48 files.

## A wall time may not exist, or may exist twice

This is `INV-DATE-025`, and it is the part most likely to surprise you.

Asking for "2026-03-08 at midnight in `America/Havana`" asks for a moment that
**does not exist** — the clocks jump from 23:59:59 to 01:00:00. Asking for
"2015-10-30 at midnight in `Asia/Amman`" asks for one that happens **twice**.
Measured across all 418 zones this runtime knows, 2015 to 2036: midnight is
skipped in **19** zones and ambiguous in **8**.

So the two derivations take explicit policies:

```ts
instantForClubWallTime(date, time, zone, {
  skipped: "reject" | "nextExistingInstant",     // default: reject
  ambiguous: "earliest" | "latest",              // default: earliest
})
```

`reject` is the default because nothing asks on purpose for a moment that never
happened; it throws `SkippedClubWallTimeError`, which names the date, the time
and the zone. A day-boundary helper such as `startOfClubDay` opts into
`nextExistingInstant`, because a booking screen must render rather than fail.
`earliest` is the ambiguity default because a job at 01:30 on a fall-back day
should run once, at the first 01:30.

**`nextExistingInstant` returns the moment the clock jumped to** — the transition
instant itself — and not the request slid forward by the size of the gap. Every
reading inside one gap therefore collapses to the same instant: on a
spring-forward morning both 02:00 and 02:30 resolve to 03:00. That is what makes
`startOfClubDay` provably the first instant of its day even where the gap begins
the previous evening, which is a real case rather than a hypothetical — Toronto
and Nassau, 31 March 1919, where the earlier rule quietly counted half an hour of
the 31st into the 30th. The one limit: on a calendar day a zone skips **entirely**
no instant reads as that day at all, and the transition instant is the honest
answer rather than a correct one.

**Noon needs no policy on any zone a club runs today**, and that is the measured
reason the epic's noon-to-noon stay boundary is safe where a midnight boundary
would not be: across 2015–2036 local noon is never skipped and never ambiguous,
where midnight is skipped in 19 zones. It is **not** safe in principle. Over
1900–2100 noon is skipped in 16 zones, and five of those are date-line moves — a
country crossing the line skips a whole calendar day, midday included, most
recently Apia and Fakaofo on 30 December 2011. So `noonOfClubDay` still carries a
policy, and the code handles that case rather than assuming it away.

## Reaching for the right helper

The kernel grew eleven entry points during CT-4's last group (#2870), plus one
bridge beside it, and every one arrived because several call sites had already
written the line out by hand and said so in a comment. If you are about to write
one of these, there is a function.

| You are about to write | Use instead |
| --- | --- |
| `requireCalendarDate(v.slice(0, 10))`, or `calendarDateOfDateOnlyInstant(new Date(v))`, over a serialised `@db.Date` | `calendarDateOfSerialisedDbDate(v)` — and the `…OrNull` sibling inside a client render, where a throw blanks the screen |
| `new Date(endOfClubDayExclusive(d, zone).getTime() - 1)` | `endOfClubDayInclusive(d, zone)` — but prefer the half-open bound wherever a `lt` will do |
| `dateOnlyInstantOf((await clubTime()).today())` | `clubTodayDateOnlyInstant()` from `club-time/server` |
| `dateOnlyInstantOf(date).getUTCDay()` | `calendarDayOfWeek(date)` — no `Date` is constructed, so the `getDay()` typo has nowhere to happen |
| `new Date(y, m, 1)`, or a hand-rolled next-month rollover | `startOfCalendarMonth(date)` for the anchor and `addCalendarMonths` for the step. Both take a `CalendarDate`, so a bare `YYYY-MM` month KEY is not one: gluing `-01` on is how you make it a day, and the three sites #2870 attributed to this row turned out to be doing exactly that and nothing else |
| a local `Intl.DateTimeFormat` for a shape the kernel lacks | check `HOUSE_SHAPES` first; five shapes were added in #2870 for exactly this, and #3123 added `formatClubInstantDayMonth` / `formatClubInstantWeekdayDayMonth` because two shapes existed for a `CalendarDate` and not for an `Instant` — which is enough of a gap to justify a hand-rolled per-zone formatter, and did, twice |
| a bare month name — the months a season or period runs between | `formatClubShortMonth(date)`. Declared as its own shape rather than the year sliced off `formatClubShortMonthYear`, per the rule below |
| the day before or after a `yyyy-MM-dd` key, via an instant and a zone reader | `addCalendarDays(requireCalendarDate(key), n)`. Two defects in one line, of which #3100 shipped one and armed the other: see "The stay window" below |
| `Date -> Date` normalisation of a stored day, for a comparison written in `Date`s | `storedDateOnly` from `@/lib/stored-calendar-day` — a bridge, not the recommended shape |
| a `yyyy-MM-dd` KEY from a stored `@db.Date` value, via a zone reader | `calendarDateOfDateOnlyInstant(requireStoredCalendarDay(v, …))`. Composed rather than wrapped, so the encoder's own name stays at the call site for the encoding census; #3107 is what a zone reader does here |

Two rules the table cannot express.

**A new display shape is DECLARED WHOLE, never composed.**
`formatClubLongWeekdayDayMonth` plus `" 2026"` really does produce
"Thursday, 16 April 2026" for `en-NZ` — which is why four separate authors
reached for it — and it is a coincidence of this locale's punctuation rather than
a property. `APP_LOCALE` is configurable, so a locale ordering the pair
differently would silently change every day button in the product. The one shape
that IS assembled, `formatClubWeekdayDay`, appends a bare integer taken from the
calendar-date string, which has no locale form to get wrong.

**`storedDateOnly` is the one helper here that is not kernel-shaped, and it lives
outside `src/lib/club-time/**` for that reason.** `Date` in and `Date` out keeps
the working value a `Date`, where the kernel's own answer is that a stored day
becomes a `CalendarDate` at the boundary and stays one. It exists because six
modules' comparisons are still written in `Date`s; CT-6 (#2991) is where those
become calendar-date comparisons and the bridge goes away.

## The stay window

`checkIn` and `checkOut` stay **date-only identities**, and capacity stays the
half-open night range `[checkIn, checkOut)`. `INV-DATE-002` and `INV-DATE-003`
are unchanged. `stayWindow(checkIn, checkOut, zone)` derives 12:00 club-local on
each endpoint *when an actual arrival or departure instant is needed* — and
nothing else should compute one.

Do not count nights by dividing elapsed milliseconds by 24 hours. Across a DST
transition a night is 23 or 25 hours, and the kernel has a test where that
arithmetic gives **0** nights for a stay the calendar says is 1.

**And do not STEP a lodge night by adding 24 hours to an instant either** — the
same 25-hour day sends the step back to where it started. Measured:
`America/Denver` local midnight on 2026-11-01 plus 24 hours reads back as
2026-11-01. `addCalendarDays` is the step, and #3100 is what happens without it:
the operational-day helpers shifted a `yyyy-MM-dd` key by building a UTC-midnight
instant, adding `days * 24h`, and reading the result back through the
environment zone — where for a club behind Greenwich the projection ATE the
shift, so "the next night" was the same night and "the previous night" skipped
one, on every call. Swapping only the reader is not the fix: it is correct until
the next person changes the encoder.

Of those two defects #3100 shipped ONE. The projection was live; the millisecond
step was **latent**, because against a UTC-midnight anchor `days * 24h` is exact —
measured over 4,000 consecutive days in both directions, zero mismatches, since a
UTC day is always 86,400,000 ms. It arms itself the moment the anchor becomes
club-local, which is the measurement above. Both are named here because a reader
who fixes only the live half re-creates the other.

**The step and the DECODER beside it are one fix, and #3107 is the other half.**
Moving the step onto calendar arithmetic while the key derivation still projected
left the two in different frames, which is worse than either alone: on
`Atlantic/Azores` — the only IANA zone that changes the SIGN of its offset across
DST, so the only one where the projection is not a uniform shift — a three-night
stay grew a fourth night, and a proposal's beds were counted on the wrong nights
inside the capacity lock. A key is DECODED from the day its column holds, never
read out of a zone.

## The legacy adapter

There is **one** left. `src/lib/date-only.ts` keeps every signature and delegates
to the kernel. **No call site has changed and none is wrong** — it is an adapter,
not deprecated code, and CT-6 (#2991) retires it once CT-3 to CT-5 have moved its
callers.

### The rendering adapter is gone (#3123)

`src/lib/nzst-date.ts` sat beside it and held the club's *rendering* seam — the
six `formatNZ*` helpers. It is **deleted**, and the sequence that got it there is
the pattern the remaining adapter should follow rather than a one-off:

1. **CT-2 (#2990)** made every helper a one-line delegation, so the formatting
   logic single-sourced onto the kernel while no caller's behaviour changed.
2. **CT-3 to CT-5, then #3113/#3118 and #3107/#3121**, moved the call sites — 40
   of them across 13 files at the last count — each onto the right *question*
   rather than merely the right module: a `@db.Date` lodge night became a
   `CalendarDate` and lost its zone argument entirely, while a real `createdAt`
   or `expiresAt` kept one and took it from the club's persisted setting.
3. **#3123** deleted the file, once `nzstDateImporters` in
   `src/lib/__tests__/club-time-escape-hatch-census.test.ts` measured zero.

**It was not replaced by a thinner adapter, a re-export shim or a
"compatibility" module, and it must not be.** Two rendering seams is one too
many; that was the whole point.
`src/lib/club-time/__tests__/club-time-kernel-census.test.ts` asserts the file
has not come back — the case is "has really deleted the rendering adapter,
rather than thinning it", and it checks that the FILE is gone rather than that it
is small, because a stub is a second rule system whatever its size. The
`toLocale*` arms in `eslint.config.mjs` refuse a hand-rolled formatter anywhere
under `src/**`. The six frozen
`Intl.DateTimeFormat` constants it used to hold survive **transcribed by hand**
in `src/lib/club-time/__tests__/house-shapes.test.ts`, swept against the kernel
over 400 consecutive instants — that transcription is now the only record of
what the club has always been shown, which is exactly why it is not an import.

Tests assert against the kernel directly. Where a suite needs to name what the
*environment* would have said — the wrong answer, to prove an email does not
carry it — it spells out
`formatClubInstantDateTime(instant, unvalidatedLegacyClubTimeZone(APP_TIME_ZONE))`
rather than reaching for a module kept alive for that purpose.

### Two honest limits while the date-only adapter exists

- **The adapter no longer passes `APP_TIME_ZONE` (#3123), though a few modules
  still read the environment directly.** `src/lib/date-only.ts` used to default
  six helpers' `timeZone` parameter to the environment's zone, so a call site
  that had not moved sat silently on the container's `TZ` and read identically to
  one that had. Those defaults and the import are gone: every `timeZone`
  parameter is required, every caller names an authority, and the adapter now
  answers with whatever it was handed. Which modules still read the environment
  is deliberately not restated here — a list copied into prose is a list that
  drifts — it is `ENVIRONMENT_ZONE_ADAPTERS` in `eslint.config.mjs`, each entry
  carrying the reason it has not moved, held as a shrink-only ratchet by
  `src/lib/__tests__/club-time-boundary-guard.test.ts`. CT-2 made the persisted
  zone *reachable*.
  CT-5 (#2869) moved the provider, scheduled-job, export and email surfaces onto
  it; CT-3 (#2872) moved the temporal schema; CT-4 (#2870) has moved the admin
  API, the member-facing API, the client components, the admin and member pages,
  and — in group F1 — the membership **season year**. What remains in `src/lib` is
  listed on #2870, and one of the two items that were reachable today is now
  closed: the remaining one is the other half of the booking-date projection the
  policy-exception engine executes through.

  **The season year is worth recording here rather than only on the issue,
  because the shape of the fix is the lesson.** `getSeasonYearForYearEndMonth`
  read its `Date` argument with `date.getMonth()` and `date.getFullYear()` — the
  HOST's calendar components — so `getSeasonYear(new Date())` answered from the
  server's month and `getSeasonYear(booking.checkIn)` read a UTC-midnight
  `@db.Date` encoding a day early for every club west of Greenwich. **Because it
  read the argument that way, no call site could repair itself**, and handing it a
  club-derived day was measured across a host x club matrix to make things WORSE:
  zero wrong days for a host at or ahead of UTC, and one entire wrong day for any
  host behind it. The remedy is two functions in `src/lib/financial-year.ts`,
  divided by temporal kind rather than by caller —
  `clubSeasonYear(zone, clock?)` for "what season is it now, for the club", which
  takes the persisted zone, and `seasonYearOfStoredDate(value)` for a `@db.Date`
  column value, which takes NO zone and refuses a value carrying a UTC time of
  day. `getSeasonYear` was deleted rather than repaired, so the typechecker
  enumerated every call site instead of leaving the wrong ones silently green.

  That second one is **now closed on both paths, and how it was reported is the
  part worth keeping.** The pricing engine decodes a stored calendar day in UTC
  rather than projecting it, which `INV-DATE-019`'s first exact boundary blesses
  for a `@db.Date` value; group F4b then did the same for
  `normalizeGuestStayRange` (`src/lib/booking-guest-stay-range-input.ts`), which
  had still been projecting the booking envelope through `APP_TIME_ZONE` before
  defaulting a guest who supplied no dates of their own — what the member form
  sends unless multi-range mode is open. So the officer, the capacity recheck and
  the executor now agree on the nights the member asked for.

  **This entry used to say the defect was confined to the NEW-BOOKING path, and
  that was wrong.** `resolveModificationStayRanges` normalises every ADDED guest
  through that same helper, so a member adding a guest to an existing booking
  without giving them dates hit it too — and the two passes of that one function
  disagreed with each other, leaving the guest's resolved range a night outside
  the envelope the same call returned. The claim originated in a code comment,
  travelled into #2870's residual list, and was recorded as fact for two groups
  before anyone read the call graph. It is the same lesson as the season year
  above, from the other direction: **a published claim about which surfaces a
  temporal defect reaches is only as good as the census behind it.** Both halves
  are pinned — `booking-exception-new-booking-guest-frame.test.ts` for the
  new-booking freeze and `booking-range-less-guest-frame.test.ts` for the
  modification resolver, each on the environment and the host axis.

  **The booking-modification date window had THREE apply-path mirrors, and the
  third one (#3088) is the entry worth reading before writing a test for this
  class.** Group B (#3056) moved the preview — `modify-quote/route.ts` — onto
  `storedDateOnly` and left the apply paths projecting the same `@db.Date` lodge
  nights through `APP_TIME_ZONE`; F4b closed `booking-modify-validation.ts` and
  #3088 closed `booking-date-modification-service.ts`. What the last one
  measured is that **a wrong stored day can hide inside a correct-looking
  result.** The admin date shift computes its delta from the projected
  `oldCheckIn` and then applies that delta to equally-projected guest rows, so
  the two one-day errors cancel and every translated night lands on the right
  day. A test asserting the shifted nights would have passed throughout.

  **The same `oldCheckIn` reaches six other places, and none of them cancel:**
  the roster-date lock key set, the persisted `BookingModification.previousData`,
  the `booking.modify.admin_override` audit payload, the member's date-change
  email, `processWaitlistForDates`, and the equality guard that is supposed to
  refuse a no-op shift. That guard is the sharpest case, because it failed in
  BOTH directions: it never matched a true no-op, so re-submitting a booking's
  own dates wrote a change record, mailed the member and offered the nights to
  the waitlist — and it falsely matched a legitimate one-day-earlier shift,
  which was refused with "The booking already has these dates". Because the
  writer re-reads the booking under `pg_advisory_xact_lock(1)`, the same guard is
  what makes two concurrent identical shifts idempotent; before the fix the loser
  wrote a second phantom modification instead. **Pin what the wrong value
  REACHES, not the one derived quantity that happens to be self-correcting.**

  **The lock keys are the example to copy, and the reason a contract test did
  not catch this.** `rosterOperationalDayRange(oldCheckIn, oldCheckOut)` builds
  the `roster:<date>` set, so behind Greenwich a stay of
  `2026-07-05 → 2026-07-08` locked `roster:07-04 … roster:07-07`: the real
  check-out day — the exact day #2622 extended the range to cover — went
  unlocked unless a chore row already sat on it, while an irrelevant `07-04` was
  locked instead. `roster-lock-contract.test.ts` enforces that every caller
  *calls* `rosterOperationalDayRange(` and writes no raw
  `{ start: checkIn, end: checkOut }`; it never inspects the VALUE handed in, and
  its key-set cases exercise the helper with literal dates rather than a caller's
  derived ones. **A contract over the call is not a contract over the argument.**
  Changing which dates are in the set is deadlock-safe by construction:
  `lockRosterDates` sorts the whole set by formatted date before acquiring any of
  it, so no membership change can invert an acquisition order.

  **`previousRange` on the bed-allocation reconciler is NOT one of the six, and
  an earlier version of this entry said it was.** It is a dead parameter:
  `reconcileBedAllocationsForBookingWithLodgeLockHeld` destructures only
  `{ bookingId, db }`, pruning is driven entirely by the freshly re-read booking
  (`bookingGuestId notIn guestIds`, `stayDate notIn nightDates`), and
  `BedAllocation` cascades from `BookingGuest` rather than `BookingGuestNight`,
  so the night delete/recreate leaves allocations alone. The wrong `oldCheckIn`
  released no bed and left no stale row. That correction is recorded here rather
  than quietly dropped, because this entry exists to record exactly this failure
  — a plausible mechanism written into the ledger as the durable lesson, ahead
  of the call graph that would have refuted it.

  **What `booking-date-modification-frame-parity.test.ts` does and does not
  guarantee.** It compares the apply path against a *transcription* of the
  preview rather than against fixed dates, so the apply path cannot drift away
  from the preview **as transcribed there**. It cannot see preview-side drift at
  all: the oracles deliberately do not import `modify-quote/route.ts`, and a
  measured mutation moving that route's shift delta base from `oldCheckIn` to
  `oldCheckOut` left the parity suite at 10 passed / 0 failed. Preview-side drift
  is caught by `modify-quote-shift.test.ts` (which did fail on that mutation) and
  by `api-club-time-convergence.test.ts`'s import ban, not by the parity file.
  The design is right — importing the route drags its whole module graph in and
  proves nothing about the text that ships — but a transcription goes stale
  silently, so both transcribed sites carry a back-pointer naming the oracle.

  So "is this application running on the persisted zone?" still has a different
  answer per surface until CT-6 (#2991) retires the adapters, and until then no
  green suite settles it: on a deployment where the environment and the persisted
  value agree — which is every deployment today, and which
  `club-time-zone-env-agreement.test.ts` pins — **no test can detect the
  difference.**
- **The scheduled jobs read the zone once, at boot.** All 25 of them, plus the
  Sentry monitors and the finance-sync schedule, resolve it before the first
  `cron.schedule` and keep it for the life of the process. Changing the club
  time zone therefore does not move a running job: **the application has to be
  restarted.** The product says so rather than leaving it to a runbook — on the
  zone panel, on its page, in contextual help, and as a banner on the health
  page's Cron Jobs section, which shows the zone the jobs are *running* beside
  the one that has been configured. `cron-runtime-zone.ts` publishes the
  boot-pinned value on a `Symbol.for` global, because Next bundles
  instrumentation separately from routes and a module-level `let` is not
  reliably shared between them; `null` there means **unknown**, never
  agreement.
- `APP_LOCALE` is still an environment-derived constant. Locale is a separate
  axis this epic does not touch.

## What the guards will stop you doing

- A bare `toLocaleDateString` / `toLocaleTimeString` / `toLocaleString` is
  lint-blocked (`INV-DATE-015`). So is an `Intl.DateTimeFormat` with no
  `timeZone`.
- `src/lib/club-time/__tests__/club-time-kernel-census.test.ts` reads the kernel
  off disk and fails if a second `new Date()` appears outside `clock.ts`, if
  `Intl` escapes `intl.ts`, if a module-level formatter is frozen anywhere, if
  the calendar-date pin stops being literally `"UTC"`, if the barrel gains a
  `server-only` or Prisma import, or if `APP_TIME_ZONE` comes back.
- The census also fails a `Date.now()` outside `clock.ts` — it is the same
  ambient clock read as `new Date()` and the earlier guard could not see it.
- **Any module citing `INV-DATE-003` or `INV-DATE-020` may not reach
  `stayWindow`.** That set is *discovered* from the citation rather than
  hand-listed, because a hand list of one module was the shape of a guard this
  kernel has already been caught by twice. A stay window is arrival and departure
  instants; occupancy is nights, and the two must not be computed from each
  other.
- `date-only-encoding-guard.test.ts` FOLLOWS the shared renormalisers by name,
  through `DATE_ONLY_RENORMALISERS`. That census classifies a call site by the
  Prisma field it reads, and it deliberately does not follow a wrapper whose
  encoder feeds another call rather than being the result — correct for its alias
  ban, and it left every site written through `storedDateOnly` classified as
  nothing at all. Both that helper and `pricing.ts`'s stricter
  `normalizeBookingDate` are listed, so `storedDateOnly(booking.createdAt)` is now
  reported rather than invisible. **The set keys on the NAME**, so it has to lead
  a rename, or there is a window in which thirty-two sites are unclassified again.
- `parseInstant` refuses an impossible date — `2026-02-30T00:00:00Z` is `null`,
  not 2 March. It is the provider boundary, so it holds the same no-rolling rule
  the calendar parser does.
- That census is **disk-scanning**, so `vitest related` cannot reach it — there
  is no import edge to a file it merely reads. Run it explicitly when you change
  the kernel; CI catches it either way.
