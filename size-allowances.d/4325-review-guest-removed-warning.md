# File-size allowance for #4325 (#4317) — the removed-guest warning on the settle card

The owner asked, on #4302, for a warning on an open edit-financial review whose
guest was removed after it was raised. The decision lives outside the card
(`editFinancialReviewGuestsRemovedSinceRaised` in the review-context module, the
wording in `manual-refund-task-copy.ts`, the flag on the queue payload); the card
gains only its optional field and the one paragraph that shows it, compressed to
five lines.

file: src/components/admin/manual-refund-task-queue.tsx
lines: 2374
reason: the warning has to sit inside the review card, beside the evidence block
  the officer reads before settling, which is where this file renders it. The
  card is wave C's to remove (#4302), so carving a new module out of it for five
  lines would be refactoring code that is about to be deleted.
