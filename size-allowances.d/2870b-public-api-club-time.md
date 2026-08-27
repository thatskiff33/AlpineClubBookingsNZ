# File-size allowances for CT-4b (#2870 — non-admin API routes onto club time)
> **Line counts refreshed by CT-4 group F3 (#2870).** That group hoisted the
> shared helpers these files each wrote out privately, so several of them are now
> SHORTER than this file recorded and four are two or three lines longer where a
> two-line import pair became one multi-line import. The gate requires
> `lines:` to equal the file's real length, so the numbers below were reset to
> what the tree holds; nothing about the reasoning above changed, and no file
> here crossed a ceiling it was not already over.

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

## Two `src/lib` modules join the list, and why that is not scope creep

Adversarial review found that three of the route edits above changed only ONE
SIDE of a cross-file pair. Each pair is two files that read the same stored
column and must read it the same way; correcting one and not the other did more
damage than leaving both wrong, because both had been wrong in the same
direction and therefore agreed.

The worst of them stopped a workflow dead. The exception-request route freezes a
proposal and hashes it; `booking-exception-approval.ts` replays it at approval
time and re-hashes. With the route corrected and the replay still projecting, the
two hashes differed for any club behind Greenwich, the integrity gate reported
`drift`, and the officer was told to have the member resubmit — which reproduced
it exactly. No modification policy exception could be approved at all
(`INV-EXCEPT`).

So the fix has to land on both sides, in the same change, which brings two
`src/lib` modules that CT-4f would otherwise own into this diff. Both are single
declared exceptions rather than a widening of scope: the edits are the same
`@db.Date`-decode correction the routes got, and nothing else in either file
moves. The comments are longer than the code because the whole hazard is
invisible in the diff and lives across two files — a reader who reinstates one
line will not be looking at the other one.

`booking-edit-policy.ts` and `booking-modification-stay-ranges.ts` took the same
kind of correction and needed no allowance: both are comfortably inside the
700-line domain-module budget.

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
lines: 581
reason: twenty-three lines on a 564-line route, of which nine are the shared
  `storedDateOnly` helper and its doc. That helper belongs in `src/lib/**`, which
  CT-4f owns and which must move last so the five groups ahead of it are not
  written twice; until then a local copy is the smaller cost. The remainder is
  the club-time import and a rewritten comment about which frame the comparisons
  share — rewritten because the first attempt at it was WRONG, claiming
  `editPolicy.today` was a club calendar day when it is still the container's.
  A comment that overstates how far a migration got is the "false and green"
  hazard `docs/CLUB_TIME_KERNEL.md` names, so the replacement is explicit about
  which half of that policy moved and which half is CT-6's.
  #3123 adds six, and three of them make that comment true again in the other
  direction. It said `editPolicy.today` was still the container's day and that
  migrating it was CT-6's; CT-6 landed, so it now says the day is the club's
  persisted one, supplied to `getBookingEditPolicy` as a REQUIRED parameter by
  this route — and that threading it as a value rather than an `await` is what
  kept that widely-called pure function synchronous. The rest is the import
  and the `today:` argument with its own note, because this policy's `today`
  and `editableFrom` are quoted back to the member in the change-request copy.

file: src/app/api/bookings/[id]/exception-requests/route.ts
lines: 290
reason: sixteen lines on a 286-line route, nine of them the same
  `storedDateOnly` helper and doc that CT-4f will hoist into `src/lib/**`, the
  rest the club-time import. The route freezes a proposal an officer later
  approves, so what the stored stay days mean is exactly the thing worth stating
  where it happens.
  #3123 adds three: the `club-time/server` import and the two-line `today:`
  argument on `getBookingEditPolicy`, which no longer defaults it. A route
  that freezes a proposal an officer later approves is exactly where the day
  it was frozen on must be the club's.

<!-- The `modify-quote/route.ts` entry that stood here is DELETED, not
     re-numbered. Its own reason said the nine lines it covered were the shared
     `storedDateOnly` helper "awaiting its CT-4f home in `src/lib/**`"; group F3
     (#2870) gave it that home, so the route is now shorter than the base ref and
     needs no allowance. An allowance is one-shot, and one left behind after its
     growth is undone is a stored exception. -->

file: src/app/api/bookings/route.ts
lines: 1376
reason: four lines on a 1355-line create route — a three-line comment and one
  import. The comment says why "today" is now the persisted club day and why it
  is still encoded at UTC midnight, which is what keeps it on the same frame as
  the parsed check-in and the retroactive-lookback arithmetic three lines below.
  Splitting booking creation is a genuine but entirely separate job.
  #3123 adds three. The `today` this route already resolved for the
  retroactive-create gate is now passed into the internet-banking lead-time
  check as well, rather than that check reading the environment for a second
  answer to the same question — two todays on one create being the straddle
  this entry's own reason is about.

file: src/app/api/member/data-export/route.ts
lines: 339
reason: three lines on a 338-line export route: a two-line comment and an
  import. The date it stamps on a member's downloaded file is now the club's
  calendar day rather than the container's, and saying so beside the stamp is
  cheaper than leaving a future reader to work out why the obvious helper was
  not used.
  #3103 adds the 339th line: one more import, for the shared season name, so a
  member's downloaded file and their screen cannot disagree about which season
  a subscription belongs to. Recorded here rather than in its own file because
  this gate measures against `main`, where the whole 338 to 339 growth is one
  change, and one file may hold only one allowance.

file: src/app/api/members/family/[memberId]/details/route.ts
lines: 405
reason: five lines on a 394-line route — a four-line comment and an import — on
  the "date of birth cannot be in the future" gate. The gate now reads the club's
  day rather than the container's, and the date of birth itself still takes no
  zone; both halves are one line apart and both have been got wrong here before.

file: src/app/api/members/family/create-group/route.ts
lines: 496
reason: six lines on a 491-line route: the same four-line comment on the same
  future-date-of-birth gate, plus the club-time imports. This route applies the
  gate per child in a loop, so the note sits at the single place the day is
  derived rather than at each use.

file: src/app/api/profile/route.ts
lines: 501
reason: five lines on a 491-line route. The existing comment already explained
  why this comparison is day-against-day rather than day-against-instant
  (#2682); two lines are added saying WHOSE day it now is, and the rest is the
  club-time import. Deleting the surrounding explanation to stay level would
  lose the reason the comparison is shaped this way at all.

file: src/lib/booking-create.ts
lines: 1952
reason: fifteen lines on an already-oversized create service, of which thirteen
  are one comment and two are imports. `POST /api/bookings` and this service run
  the same two retroactive-booking rules — the service deliberately re-checks the
  RESOLVED envelope, which guest nights can widen — and CT-4 moved the route onto
  the club's day while leaving this on the container's. On a deployment whose
  container is a day ahead, the route admits a check-in and the service then
  throws "Retroactive bookings can go back at most 365 days" against a boundary
  one day later, refusing what the same request just accepted. Both now read one
  helper, and the comment says why two "today"s here are a straddle rather than
  defence in depth. Splitting a 1,874-line booking-creation service is a real job
  and an entirely separate one.
  #3123 adds twenty-seven, and they close the same class one layer in. The
  promotion's validity window is judged inside `resolvePromoInTransaction`,
  which runs under `pg_advisory_xact_lock(1)`, the per-lodge capacity key AND
  a `FOR UPDATE` on the promo row, so it cannot read the club's timezone for
  itself (`INV-LOCK-004`). `createDraftBooking` gains a pre-transaction read
  with a nine-line comment; `createConfirmedBooking` reuses the day it ALREADY
  resolved for the retroactive envelope, which is the same
  one-answer-per-create property this entry describes; and
  `createWaitlistedBooking`'s options object goes multi-line to carry it.

file: src/lib/booking-exception-approval.ts
lines: 1075
reason: twenty-one lines on an already-oversized module: nine are the same
  `storedDateOnly` helper and doc the three routes carry, awaiting CT-4f's single
  home for it in `src/lib/**`, and eleven are the comment on the five decodes that
  must stay spelled exactly as the request route spells them. This is the pair
  whose divergence made every modification policy exception unapprovable, so the
  five lines being one edit apart from their counterpart is the single most
  important thing a future reader can know about them. Splitting the approval
  hooks is CT-4f-adjacent work that would bury this migration's own diff.
