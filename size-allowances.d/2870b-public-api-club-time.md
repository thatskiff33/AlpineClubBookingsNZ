# File-size allowances for CT-4b (#2870 — non-admin API routes onto club time)

Nine already-over-budget route handlers grow here, by 87 lines between them.
**Every one of those lines is a comment, an import, or the same three-line
helper repeated.** No route gains a branch, a parameter or a code path; the
change is which authority answers an existing question.

## Why the comments are the growth, and why they stay

This migration's whole content is a distinction that is invisible in the diff.
`getTodayDateOnly()` becomes `(await clubTime()).today()` and
`normalizeDateOnlyForTimeZone(x)` becomes `storedDateOnly(x)` — two edits that
look like renames and are not. One moves an authority from the container's `TZ`
to the club's persisted `ClubTimeSettings` row; the other removes a timezone
projection from a value that must never have one. Both were **correct-looking
and correct-in-New-Zealand** before the change, which is precisely why they
survived so long, and a reader who does not know that will reinstate them. The
comments name the invariant (`INV-CONFIG-002`, `INV-DATE-010`, `INV-DATE-019`,
`INV-DATE-026`) and the observable defect, at the line the reader meets it.

Every one of these files is a route handler that was over the 250-line budget
before this change and is not restructured by it. Splitting any of them is a
real job and a worthwhile one, but it is an unrelated refactor of booking
creation, booking modification or the member profile, and doing it inside a
timezone migration would bury that migration's own diff — the same judgement
CT-3's allowance recorded for `admin/reports/route.ts`.

## The three biggest entries share one cause, and CT-4f removes it

`change-requests`, `exception-requests` and `modify-quote` each carry an
identical nine-line `storedDateOnly` helper — six lines of doc, three of body —
because the kernel has no "decode a `@db.Date` back to a date-only `Date`"
function and `src/lib/**` is CT-4f's, deliberately, so that the five groups
before it are not written twice. Adding one there now would force exactly the
rewrite the epic's ordering exists to avoid. When CT-4f lands the helper once,
these three copies go and the lines come back.

file: src/app/api/bookings/[id]/arrival-time/route.ts
lines: 372
reason: seventeen lines on a 355-line route that is not restructured here.
  Eight are the comment saying why two adjacent lines answer two different
  temporal questions — "today" from the persisted club zone, the stored
  `@db.Date` check-in from no zone at all — and the rest are the club-time
  imports and the extra local the comparison now names. The explanation cannot
  move: the two concepts are one line apart, and the wrong version agrees with
  the right one in New Zealand.

file: src/app/api/bookings/[id]/change-requests/route.ts
lines: 580
reason: sixteen lines on a 564-line route, of which nine are the shared
  `storedDateOnly` helper and its doc. That helper belongs in `src/lib/**`, which
  CT-4f owns and which must move last so the five groups ahead of it are not
  written twice; until then a local copy is the smaller cost. The remainder is
  the club-time import and one corrected comment about which frame the
  comparisons share.

file: src/app/api/bookings/[id]/exception-requests/route.ts
lines: 302
reason: sixteen lines on a 286-line route, nine of them the same
  `storedDateOnly` helper and doc that CT-4f will hoist into `src/lib/**`, the
  rest the club-time import. The route freezes a proposal an officer later
  approves, so what the stored stay days mean is exactly the thing worth stating
  where it happens.

file: src/app/api/bookings/[id]/modify-quote/route.ts
lines: 2346
reason: fifteen lines on a 2331-line route, nine of them the shared
  `storedDateOnly` helper awaiting its CT-4f home in `src/lib/**`. This file has
  thirteen separate reads of a stored `@db.Date` stay day; a local helper with
  one doc is smaller than annotating them, and splitting a 2300-line quoting
  route is a substantial refactor that has nothing to do with timezones.

file: src/app/api/bookings/route.ts
lines: 1359
reason: four lines on a 1355-line create route — a three-line comment and one
  import. The comment says why "today" is now the persisted club day and why it
  is still encoded at UTC midnight, which is what keeps it on the same frame as
  the parsed check-in and the retroactive-lookback arithmetic three lines below.
  Splitting booking creation is a genuine but entirely separate job.

file: src/app/api/member/data-export/route.ts
lines: 338
reason: three lines on a 338-line export route: a two-line comment and an
  import. The date it stamps on a member's downloaded file is now the club's
  calendar day rather than the container's, and saying so beside the stamp is
  cheaper than leaving a future reader to work out why the obvious helper was
  not used.

file: src/app/api/members/family/[memberId]/details/route.ts
lines: 399
reason: five lines on a 394-line route — a four-line comment and an import — on
  the "date of birth cannot be in the future" gate. The gate now reads the club's
  day rather than the container's, and the date of birth itself still takes no
  zone; both halves are one line apart and both have been got wrong here before.

file: src/app/api/members/family/create-group/route.ts
lines: 497
reason: six lines on a 491-line route: the same four-line comment on the same
  future-date-of-birth gate, plus the club-time imports. This route applies the
  gate per child in a loop, so the note sits at the single place the day is
  derived rather than at each use.

file: src/app/api/profile/route.ts
lines: 496
reason: five lines on a 491-line route. The existing comment already explained
  why this comparison is day-against-day rather than day-against-instant
  (#2682); two lines are added saying WHOSE day it now is, and the rest is the
  club-time import. Deleting the surrounding explanation to stay level would
  lose the reason the comparison is shaped this way at all.
