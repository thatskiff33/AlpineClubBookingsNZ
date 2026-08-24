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
lines: 678
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
lines: 833
reason: eleven lines. The roster header's long-weekday formatter has no house
  shape in the kernel, so it stays local and is now pinned to UTC over the
  UTC-midnight encoding; the date also comes straight off a URL segment, so the
  decode gained a fallback rather than a throw that would blank the page — and
  the note beside it now says plainly that the fallback is NEW, because the
  previous spelling produced an invalid `Date` and `Intl` threw on it.

## Added when the fourteen deferred client files were finished

The rows above were written when this group still had fourteen `"use client"`
files it could not migrate: CT-4 group C's shared client boundary had not merged,
so a page needing the club's zone IN THE BROWSER had nowhere to get it from. That
blocker cleared, all fourteen were finished, and exactly one of them is an
already-oversized file that grew.

The other thirteen are all inside their budgets and stay there — including
`(public)/pay/[token]/page.tsx`, which went 444 to 484 against a 500-line
route-page budget and was watched for exactly that reason.

file: src/app/(lodge)/lodge/kiosk/page.tsx
lines: 1180
reason: twenty-nine lines on a page that was already 1151. Nine are the club-day
  binding and the note saying the wall tablet's own clock has never been the
  authority and must not become one; eleven are the header formatter's, which
  has no house shape in the kernel so it stays local and is now pinned to UTC
  over the UTC-midnight encoding rather than to the environment zone; the rest
  are the decode gaining a fallback instead of a throw, because this is an
  unattended screen in a lodge and a thrown render is a blank wall. This file was
  the last `APP_TIME_ZONE` importer in the member, lodge, finance and public page
  tree. Splitting it is real work and a real review: it is one screen with a week
  strip, a day list, attendance, chores and a PIN login, and carving it up to buy
  back twenty-nine lines while also moving its temporal authority would put two
  unrelated risks in one diff.

## Added in the fix round, for a straddle this group's own diff created

Two adversarial lenses found four places where group E had moved one half of a
value and left the other, so one screen showed two answers. Three were fixed
here as declared `src/lib` exceptions, on the precedent group B set (#3056) when
it took four of them: a straddle is worse than either consistent state. Two of
the three cost no lines worth arguing about. This one did.

`src/lib/member-guest-consent-card.ts` was the fourth, and it is NOT allowanced —
it was 695 lines against a 700-line budget, so the correction took it over for
the first time, which this gate refuses to allowance and rightly. Its
`// Date labels ---` divider was already the seam, so everything below it plus
the three formatters those labels are the only users of moved to
`src/lib/member-guest-consent-labels.ts`. The card module re-exports them, so no
call site moved — deliberately, because one importer is
`src/app/(admin)/admin/bookings/page.tsx` and the sibling admin lane (#3067) has
that file open.

file: src/lib/lodge-display-state.ts
lines: 1009
reason: eighteen lines on a 991-line file, and seventeen of them are the comment.
  The change itself is one line: the lobby board's window opened on
  `getTodayDateOnly()` — the container's day — while group E had already moved the
  wall's HEADER onto the club's persisted zone, so for a club in Pacific/Auckland
  on a TZ=UTC host the header read "Fri, 17 Apr" above a board still showing 16
  April's guests, arrivals and roster, for twelve hours of every day, on an
  unattended screen with nobody to reload it. The note has to sit on that line:
  `startDate` keys every query in the function, and the next reader will see a
  one-line `?? dateOnlyInstantOf((await clubTime()).today())` with no way to know
  that the obvious-looking `getTodayDateOnly()` it replaced was the defect rather
  than the simplification. Splitting is not available in any useful form —
  `buildDisplayState` is one privacy-enforcing serialiser whose whole point is
  that every query in it is scoped to one lodge in one window, and the #28/LTV-003
  matrix that guards it reads the assembled payload.
