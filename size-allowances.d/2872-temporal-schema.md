# File-size allowances for CT-3 (#2872 — temporal schema census and date-only narrowing)

One already-over-budget file grows here, by eight lines, all of them comment.

`src/app/api/admin/reports/route.ts` was 340 lines against a 250-line route
budget before this change and is not restructured by it. What it gains is a
correction and the reason for it: `Member.joinedDate` becomes `@db.Date`, and
`@prisma/adapter-pg` narrows a bound `Date` for such a column to its UTC calendar
date. The route was binding a club-MIDNIGHT instant to that filter, which narrows
to the day *before* the window, so the new-member count would have started a day
early. The fix is to bind the two calendar days there and keep the instant pair
for `Member.createdAt` in the very same `OR` — one window, two kinds of column,
two encodings.

**Splitting is worse here, and specifically here.** The whole hazard is that two
adjacent lines of one `where` clause need *different* bound values, and the eight
lines say which and why at the two places a reader meets them: where the four
bounds are derived, and where the two kinds sit side by side. Moving that
explanation into a helper module would put the rule a screen away from the
comparison it governs, which is exactly how this class of defect (`INV-DATE-013`)
has been reintroduced here before. Splitting the *route* is a real and separate
job — it aggregates a dozen unrelated report sections — and doing it inside a
schema-migration change would bury the migration's own diff.

Nothing else in this change grows a production file: `src/lib/cron-age-up.ts`
takes the same correction and stays inside its 700-line domain-module budget
(633), and every other edit is in `prisma/`, a test, or a test-support module.

file: src/app/api/admin/reports/route.ts
lines: 348
reason: eight lines of comment on an untouched 340-line route that is already
  over budget. They state why two adjacent bounds in one `where` clause must be
  encoded differently now that `Member.joinedDate` is `@db.Date` — the calendar
  days for it, the club-day instants for `Member.createdAt` beside it. Lifting
  that explanation out would separate the rule from the comparison it governs,
  which is how INV-DATE-013 has been reintroduced in this repository before, and
  splitting the route itself is an unrelated refactor that would bury the schema
  migration this change exists for.

## The promo-codes admin screen, added in review

The three-lens review found that this screen's edit dialog seeded its four
`<input type="date">` boxes by projecting a `@db.Date` value through the club's
time zone — and the dialog writes those boxes back. For a club west of UTC that
made every save of a promo code walk its window one day earlier, permanently and
invisibly, on the columns that gate a discount against a booking's check-in. The
fix is two lines; what grows the file is the comment saying which defect it was,
because the wrong version looked deliberate and agreed with the right one in New
Zealand.

`src/app/(admin)/admin/promo-codes/promo-codes-page-client.tsx` is 1741 lines of
one admin screen and was already far over budget before this change touched it.
Splitting it is a real job and a worthwhile one, but it is a refactor of an
unrelated screen: this pull request is a schema migration, and re-cutting a
1700-line form inside it would bury the migration's own diff and put a promo
pricing screen at risk for a reason that has nothing to do with promo pricing.
The comment was cut from thirty-three lines to twenty during review, which is
where it stops being able to say what the defect was.

file: src/app/(admin)/admin/promo-codes/promo-codes-page-client.tsx
lines: 1756
reason: fifteen lines, almost all comment, on a 1741-line admin screen that was
  already far over budget and is not restructured here. They record a live
  data-corruption defect the review found — the edit dialog seeded its date boxes
  by projecting a `@db.Date` value through the club zone and then wrote them
  back, so west of UTC every save walked the promo window a day earlier — and the
  explanation has to sit at the two functions it governs, because the wrong
  version looked deliberate and agrees with the right one in New Zealand.
  Splitting a 1700-line form is a genuine job but an unrelated one, and doing it
  inside a schema migration would bury that migration's diff.
  The fifteenth line is CT-4 group D's (#2870, PR #3067): the two promo-window
  decoders collapsed onto the shared payload decoder, which is a net
  simplification of the file rather than an addition to it. It is recorded here
  rather than in group D's own allowance file because this gate measures against
  `main`, where the file is still 1741 lines — so the whole 1741 to 1756 growth
  has to be one entry, and one file may hold only one allowance.
