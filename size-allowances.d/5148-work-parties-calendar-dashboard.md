# File-size allowances for fork #118 (work parties: calendar, dashboard, Join)

Four already-over-budget files grow by wiring only. The logic itself went to
new modules written to their own ceilings: `work-party-calendar.ts`,
`calendar-work-party-entries.ts`, `work-party-member.ts`,
`work-party-access.ts`, `work-party-dashboard-card.tsx`,
`use-work-party-prefill.ts`, and `event-details-view.tsx` (which also takes the
calendar dialog's read-only view out of `event-dialog.tsx`, leaving that file
shorter than its base). `calendar-service.ts` stays under its budget.

file: src/app/(admin)/admin/work-parties/page.tsx
lines: 659
reason: the work party card gains an "On calendar" badge, an "Add to calendar"
  button and its click handler, and a notice when a save could not update the
  calendar. They sit beside the card's existing Edit, Activate and Delete
  buttons and handlers, which this page keeps inline; moving only the new one
  out would split one row of buttons across two files.

file: src/app/(authenticated)/book/_hooks/use-booking-wizard.ts
lines: 2410
reason: the call to `useWorkPartyPrefill` (the prefill itself lives in its own
  hook) and the few lines that tick the joined work party when the review step
  lists the working bees, and the inputs that tell the prefill when to stand
  down (the lodge list, the subscription check, the member's own dates). That tick has to sit inside the existing response
  handler that sets the list, because the handler's sequence guard is what
  stops a stale response from ticking it.

file: src/app/(authenticated)/book/page.tsx
lines: 713
reason: one status line for a Join link that could not be filled in, placed
  with the page's other top-of-page notices.

file: src/app/(authenticated)/dashboard/page.tsx
lines: 998
reason: the members-only gate and one query for the new Work Parties card (the
  card is its own component), and the Events card query now hides an inactive
  work party's entries. The gate and query sit with the other cards' gates and
  queries in this page, which reads everything once for the whole dashboard.
