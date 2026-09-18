# File-size allowances for #3498

Owner decision D1 moves an `EDIT_FINANCIAL_REVIEW` work item from the grain of
the guest strand to the grain of the EDIT, and D2 makes a dismissal reversible.
Four files that had been at or under their ceiling were **split** rather than
allowed — `stored-sold-price-evidence.ts` into `parked-edit-occurrence.ts`,
`stored-night-price-repair-store.ts` into `stored-night-price-repair-plan.ts`,
`edit-financial-review.ts` into `edit-financial-review-parked-raise.ts`, and the
finance queue route into `manual-refund-task-queue-reads.ts` — so the entries
below are only for files that were already over budget before this change.

file: src/components/admin/manual-refund-task-queue.tsx
lines: 2033
reason: the settle dialog now renders one column of night-price boxes per
  strand of the edit, and the evidence block carries every strand the parked
  edit recorded. The two new pieces are already in their own files — the
  reopen card and the per-strand fieldset — and what is left here is the one
  thing that cannot leave: the dialog's own state, which has to hold the
  officer's typing for every strand at once while the shared checker judges it
  against the single settlement they are pricing. Splitting the dialog from the
  card it opens from would put that state behind a prop-drilling boundary for
  no reader's benefit.

file: src/lib/booking-edit-guest-ranges.ts
lines: 2024
reason: the in-progress planner composes the strands it records into one
  occurrence through the shared composer, and states why a strand named at both
  parked exits is recorded once. The decision is four lines of code inside an
  existing branch; the rest is the reasoning, which belongs beside the exit it
  is about rather than in a module a reader would have to go and find.

file: src/lib/booking-guest-removal-service.ts
lines: 1456
reason: a parked removal now composes one occurrence instead of raising a task
  per strand, and the paragraphs explaining WHICH strands it records — including
  why the departing strand is always among them, which is the defect #3032 was
  filed for — had to be corrected rather than deleted. They sit at the site they
  govern.

file: src/lib/booking-modify-plan.ts
lines: 3025
reason: nine lines: the parked exit carries one occurrence rather than a list,
  and refuses loudly if the planner ever hands it a park with no occurrence at
  all. Both belong in the exit itself.

file: src/lib/booking-date-modification-service.ts
lines: 2244
reason: four lines — the parked verdict is now "there is an occurrence" rather
  than "the list is not empty", and the raise is skipped rather than handed an
  empty list.

file: src/lib/booking-batch-modification-service.ts
lines: 2527
reason: three lines, the same shape as the date path's.

file: src/app/api/bookings/[id]/guests/route.ts
lines: 1586
reason: five lines. A pure guest add is the case that rules out filtering the
  fan-out down instead of moving the grain up — no existing strand moves, so a
  filter would raise nothing — and the comment saying so belongs at the raise it
  guards.

file: src/app/api/bookings/[id]/modify-quote/route.ts
lines: 2378
reason: seven lines. The preview must park whenever the save would, so it reads
  the causes of every strand the one occurrence records rather than of every
  occurrence in a list.
