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
  If nothing reaches it, `club-time/server` is the right reader and the memo is
  free. If something does — or if you are writing the module a diagnostics pack
  is about to import — take the runtime reader and say in its docblock which
  entrypoint made that necessary, so the next reader can re-measure the claim
  rather than inherit it. A docblock asserting a hazard that no longer exists is
  the pattern this repository keeps re-finding; measuring beats repeating.
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

The kernel grew ten entry points during CT-4's last group (#2870), plus one
bridge beside it, and every one arrived because several call sites had already
written the line out by hand and said so in a comment. If you are about to write
one of these, there is a function.

| You are about to write | Use instead |
| --- | --- |
| `requireCalendarDate(v.slice(0, 10))`, or `calendarDateOfDateOnlyInstant(new Date(v))`, over a serialised `@db.Date` | `calendarDateOfSerialisedDbDate(v)` — and the `…OrNull` sibling inside a client render, where a throw blanks the screen |
| `new Date(endOfClubDayExclusive(d, zone).getTime() - 1)` | `endOfClubDayInclusive(d, zone)` — but prefer the half-open bound wherever a `lt` will do |
| `dateOnlyInstantOf((await clubTime()).today())` | `clubTodayDateOnlyInstant()` from `club-time/server` |
| `dateOnlyInstantOf(date).getUTCDay()` | `calendarDayOfWeek(date)` — no `Date` is constructed, so the `getDay()` typo has nowhere to happen |
| a month key with `-01` glued on, or `new Date(y, m, 1)` | `startOfCalendarMonth(date)` |
| a local `Intl.DateTimeFormat` for a shape the kernel lacks | check `HOUSE_SHAPES` first; four shapes were added in #2870 for exactly this |
| `Date -> Date` normalisation of a stored day, for a comparison written in `Date`s | `storedDateOnly` from `@/lib/stored-calendar-day` — a bridge, not the recommended shape |

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

## The legacy adapters

`src/lib/nzst-date.ts` and `src/lib/date-only.ts` keep every signature and
delegate to the kernel. **No call site has changed and none is wrong** — they are
adapters, not deprecated code, and CT-6 (#2991) retires them once CT-3 to CT-5
have moved their callers.

Two honest limits while both exist:

- **The adapters still pass `APP_TIME_ZONE`, and a call site that has not moved
  yet is still on the environment.** CT-2 made the persisted zone *reachable*.
  CT-5 (#2869) moved the provider, scheduled-job, export and email surfaces onto
  it; CT-3 (#2872) moved the temporal schema; CT-4 (#2870) has moved the admin
  API, the member-facing API and the client components. **What remains is
  `src/lib` itself**, which CT-4's last group takes, and the list of what is
  known to be wrong there is on #2870 — including two that are reachable today:
  a season year read with host-local getters, and the remaining half of the
  booking-date projection the policy-exception engine executes through.

  That second one is **half closed, and the half that is left still reaches
  execution.** The pricing engine now decodes a stored calendar day in UTC rather
  than projecting it, which `INV-DATE-019`'s first exact boundary blesses for a
  `@db.Date` value — so on the MODIFICATION path the officer, the capacity
  recheck and the executor agree on the nights the member asked for. On the
  NEW-BOOKING path they do not yet: `normalizeGuestStayRange`
  (`src/lib/booking-guest-stay-range-input.ts`, #2870 item 6) still projects the
  booking envelope through `APP_TIME_ZONE` before defaulting a guest who supplied
  no dates of their own, which is what the member form sends unless multi-range
  mode is open. For a club behind Greenwich that guest is still frozen, reviewed
  and booked a night early. The error is halved, not removed, and the remaining
  half is pinned by
  `src/lib/__tests__/booking-exception-new-booking-guest-frame.test.ts`. So "is this
  application running on the persisted zone?" has a different answer per surface
  until CT-6 (#2991) retires the adapters, and until then no green suite settles
  it: on a deployment where the environment and the persisted value agree —
  which is every deployment today, and which
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
