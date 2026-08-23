# File-size allowances for CT-4 group E (#2870, epic #2988)

Six already-oversized page shells grew while moving off the environment's
timezone. **Every line of the growth is either a call-site explanation or the
extra hop the kernel's typed API requires** — a calendar day has to be decoded
before it can be formatted, and a real instant has to be projected through a
binding rather than through a frozen module constant. None of it is new
behaviour, and none of these files gained a new responsibility.

Splitting was taken where it was available rather than allowanced:
`src/app/display/display-screen.tsx` would have grown by 98 lines, so the header
clock and the club-time binding it needs moved into
`src/app/display/display-header-clock.tsx` — which takes the screen from 832 LOC
to 696, back inside its budget and smaller than it started. The six below have no
comparable seam: a booking detail page or a member dashboard is one screen, and
carving a page shell in half to buy back thirty lines would leave the reader
chasing a boundary invented for a line count.

file: src/app/(authenticated)/bookings/[id]/page.tsx
lines: 2603
reason: the stay dates are calendar days and the audit, expiry and hold stamps
  are instants, so the two now take different routes through the kernel and the
  page says which is which at each site. That distinction is the entire defect
  class this epic exists to end, and a reader who cannot see it at the call site
  will collapse the two again; splitting a single booking screen to hide the
  explanation elsewhere makes that likelier, not less.

file: src/app/(authenticated)/dashboard/page.tsx
lines: 924
reason: one local formatter here was being handed BOTH lodge nights and real
  instants — one concept wearing another's clothes, identical output in New
  Zealand and a day early anywhere west of Greenwich. It is now pinned to UTC
  and only ever handed calendar days, with every instant projected first. The
  note recording that, and the note on the club-day window beside it, are the
  reasoning that stops the next edit merging the two back together.

file: src/app/(authenticated)/profile/page.tsx
lines: 683
reason: eleven of the sixteen lines are a warning left ON PURPOSE beside
  `getSeasonYear(new Date())`, which is deliberately NOT migrated: a sibling
  lane measured that handing it a club-derived date makes a behind-UTC
  deployment worse, not better, and the honest fix is a zone-aware helper in
  `src/lib` that another group owns. Without that note the next reader makes
  exactly the change that was measured and rejected.

file: src/app/(authenticated)/book/_components/review-step.tsx
lines: 976
reason: seven lines, being the hold-deadline arithmetic moving from date-only
  `Date` stepping onto calendar-day stepping plus the sentence saying why a
  lodge night takes no timezone. The wizard steps are already separate files;
  there is no further seam to find here.

file: src/app/(authenticated)/book/_hooks/use-booking-wizard.ts
lines: 1957
reason: six lines, being the night count moving onto `countClubNights` and the
  note on why the parse is the forgiving one — this runs on every render of a
  form whose two dates are half-entered most of the time. Splitting this hook is
  a real piece of work and belongs to whoever does it deliberately.

file: src/app/(lodge)/lodge/roster/[date]/setup/page.tsx
lines: 831
reason: nine lines. The roster header's long-weekday formatter has no house
  shape in the kernel, so it stays local and is now pinned to UTC over the
  UTC-midnight encoding; the date also comes straight off a URL segment, so the
  decode gained a fallback rather than a throw that would blank the page.
