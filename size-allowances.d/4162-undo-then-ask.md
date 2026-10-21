# File-size allowances for #4162 (undo, then ask once)

Eight already-over-budget files grow. The new behaviour itself lives in new
modules written to their own ceilings (`bank-refund-void-scan.ts`,
`bank-refund-void-follow-up.ts`, `bank-refund-void-answer.ts`,
`bank-refund-void-count.ts`, `refund-allocation-unwind.ts`,
`xero-inbound/credit-note-bank-transfer-floor.ts`, two components). Each entry
below is the seam into an existing flow, which belongs where that flow is.
Three files at their budget were brought back under it rather than allowed.

file: src/components/admin/manual-refund-task-queue.tsx
lines: 2339
reason: the refund list's one question for a bank refund to re-confirm - its
  row line, intro paragraph, dialog title, description and button wording, and
  the answer's state and body field. Every other kind's wording branches live
  in the same title/description/button functions of this card, and splitting
  one kind's branches out would leave the card's wording in two places. The
  answer's controls are already their own component.

file: src/instrumentation.node.ts
lines: 1710
reason: the 02:25 schedule runs the follow-up right after the link cleanup in
  the same scheduled callback, which is where every schedule lives.

file: src/lib/admin-cron-health.ts
lines: 938
reason: one cron-health definition row for the new job, in the one
  authoritative list the cron-recording contract test checks.

file: src/lib/stuck-state-dashboard.ts
lines: 1159
reason: one dashboard item and its dependency beside the other Xero items;
  the dashboard is the one place every stuck-state count is assembled.

file: src/lib/xero-credit-notes.ts
lines: 1363
reason: the hand-back task id riding the executed row's payload, beside the
  other fields a retry must keep (paidAnotherWayTaskId, creditsInvoiceId).

file: src/lib/xero-inbound/credit-note-repairs.ts
lines: 1174
reason: the floor is one call in the recount, kept minimal because open PR
  #4231 changes the same function; its logic is its own module.

file: src/lib/xero-operation-outbox.ts
lines: 3340
reason: the enqueue option, its payload field and the worker's pass-through
  for the hand-back task id, each beside the matching existing field.

file: src/lib/xero-operation-retry.ts
lines: 1989
reason: one pass-through line so an operator retry keeps the hand-back task id.

file: src/lib/xero-refund-note-link-repair.ts
lines: 918
reason: one optional parameter on the blocking-create finder, so a create row
  whose own note Xero voided never holds a voided bank-transfer note back
  (#4162 review). The finder's query is the one definition of "could still
  mint"; a second copy beside the follow-up would drift from it.
