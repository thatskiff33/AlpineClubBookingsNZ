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
