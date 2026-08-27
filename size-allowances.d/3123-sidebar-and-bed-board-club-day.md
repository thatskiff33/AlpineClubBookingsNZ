# File-size allowances for #3123 (admin sidebar / bed-board club day)

file: src/components/admin-sidebar.tsx
lines: 1162
reason: +61 lines, and none of them is nav table. The dated Unpaid Finished Stays
  deep link stopped being a module-level constant read from the container's
  environment timezone and became a required first parameter on the three
  exported nav seams, which the command palette also calls — so the growth is
  four docblocks explaining WHY the day is threaded (one authority, one
  computation, shared by two surfaces), why the section-order constant may still
  be derived from a fixed probe day, and why `useClubTime()` rather than a server
  prop. Splitting is available here and is the wrong trade twice over. Lifting
  the 438-line `navSections` table into its own module would put the nav data on
  one side of a file boundary and the one dated href on the other, which is
  exactly the two-registry drift the palette's own docblock says this file exists
  to prevent; and the explanations have to sit on the seams they constrain,
  because the next reader will be looking at a parameter that now looks
  gratuitous and has no way to know that defaulting it re-opens a defect with two
  independent halves. The table itself did not move a line: it is now an arrow
  function's concise body, so its indentation is byte-identical.

file: src/lib/stuck-state-dashboard.ts
lines: 1142
reason: +4 lines in one function. `addBedAllocationItems` now resolves the club's
  day once as a calendar day and drops the `@db.Date` encoding it never needed —
  it only ever built two date strings from it — plus a three-line comment saying
  that a lodge night takes no timezone, which is the mistake the surrounding
  encode/decode helpers invite. Splitting a 1138-line dashboard aggregator to
  land four lines would be a large refactor of an unrelated file inside a
  migration lane, which is the case this directory's README names as reaching for
  an allowance knowingly.
