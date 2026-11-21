# File-size allowances for #5148 (work parties: calendar, dashboard, Join)

Four already-over-budget files grow by wiring only. The logic itself went to
new modules written to their own ceilings: `work-party-calendar.ts`,
`calendar-work-party-entries.ts`, `work-party-member.ts`,
`work-party-access.ts`, `work-party-dashboard-card.tsx`,
`use-work-party-prefill.ts`, `stay-work-parties.ts`, and
`event-details-view.tsx` (which also takes the calendar dialog's read-only view
out of `event-dialog.tsx`, leaving that file shorter than its base).
`calendar-service.ts` stays under its budget.

The booking wizard (`use-booking-wizard.ts`) is past three times its budget, so
it may not grow at all: the review step's work-party read and its selection
rule moved out to `stay-work-parties.ts`, which leaves the wizard one line
shorter than on `main` with the Join wiring in it. It needs no allowance.

file: src/app/(admin)/admin/work-parties/page.tsx
lines: 613
reason: the work party card gains an "On calendar" badge, an "Add to calendar"
  button and its click handler, and a status region (with its focus outcome)
  for the calendar result. They sit beside the card's existing Edit, Activate
  and Delete buttons and handlers, which this page keeps inline; moving only
  the new one out would split one row of buttons across two files. The
  Description field gains a hint saying where members see the text.

file: src/app/(authenticated)/book/page.tsx
lines: 653
reason: one status region for a Join link that could not be filled in, placed
  with the page's other top-of-page notices, and its import.

file: src/app/(authenticated)/dashboard/page.tsx
lines: 1030
reason: the members-only gate and one query for the new Work Parties card (the
  card is its own component). The gate and query sit with the other cards'
  gates and queries in this page, which reads everything once for the whole
  dashboard. The Events card's read moved out to dashboard-calendar-events.ts.

file: src/app/api/promo-codes/validate/route.ts
lines: 519
reason: one import line: the open-work-party test now comes from its one home,
  `work-party-rules.ts`, replacing a three-condition test written inline here
  (INV-SSOT), and `work-party.ts` no longer re-exports it, so the rule has one
  import path.

function: src/app/(admin)/admin/work-parties/page.tsx#AdminWorkPartiesPage
lines: 529
reason: the Add to calendar handler, the On calendar badge and the calendar
  status region sit in the work party card's existing row of buttons and
  handlers, which this page component keeps inline, and the Description field
  gains a hint saying where members see the text, like the Name field's; the
  calendar sync itself lives in work-party-calendar.ts and
  calendar-work-party-entries.ts.

function: src/app/(authenticated)/book/page.tsx#BookPage
lines: 626
reason: the prefill notice, one status region rendered with the page's other
  top-of-page notices, and the destructured value it reads.

function: src/app/(authenticated)/dashboard/page.tsx#DashboardPage
lines: 854
reason: the members-only gate and one query for the Work Parties card (the card
  is its own component); the page reads every card's data once in this body.
  The Events card's read moved out to dashboard-calendar-events.ts, which
  applies the calendar's visibility rule and shows a work party once.
