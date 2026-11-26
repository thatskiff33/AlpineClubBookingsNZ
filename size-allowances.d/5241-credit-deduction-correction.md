# Size allowances for #5241 (deducting credit that has a Xero note)

The correction itself lives in new modules (`admin-credit-deduction-*.ts`,
`xero-credit-note-correction.ts`, `xero-admin-credit-deduction-correction.ts`)
and the member card's new block in `pending-credit-corrections.tsx`. What is
left below is the wiring each existing file must hold at its own seam.

file: src/lib/member-credit.ts
lines: 1219
reason: approval hands a deduction to the reservation under the ledger lock it
  already holds, keeps the member-facing approve audit a literal call site the
  disclosure census can read (the queued case is a separate call), and kicks
  the outbox for deductions too.

file: src/lib/xero-operation-outbox.ts
lines: 2657
reason: the new queue type's import and its one dispatch branch, beside the
  other queue types' branches.

function: src/lib/xero-operation-outbox.ts#processQueuedXeroOutboxOperations
lines: 490
reason: the dispatch is one if-else chain over queue types; a new type is one
  more branch there, and splitting the chain is a refactor of its own.

file: src/app/(admin)/admin/membership/members/[id]/page.tsx
lines: 1365
reason: passes the reserved corrections and the cancel handler from the
  credits hook to the credit card, as it passes the card's other props.

function: src/app/(admin)/admin/membership/members/[id]/page.tsx#MemberDetailPage
lines: 1254
reason: the same three props and their destructuring from the credits hook.
