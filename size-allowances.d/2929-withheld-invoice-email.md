# File-size allowances for #2929 — the withheld Xero invoice email

One file needs an allowance of its own. Five others this change also grows —
`src/app/(admin)/admin/book/page.tsx`, `src/lib/booking-create.ts`,
`src/lib/xero-booking-invoices.ts`, `src/lib/xero-sync.ts` and
`src/lib/xero-operation-retry.ts` — already carry a
live allowance from a sibling child of epic #2725, and the gate refuses two live
allowances for one path. Their `lines:` were therefore **re-measured** in the
fragments that already hold them (#2930, #3367, #3368) rather than re-declared
here, which is what the gate asks for in those words: an allowance whose number
is not the file's real length is exactly the drift it replaced. Those five
allowances are live against `origin/main` — which is the base CI compares this
gate against, whatever branch the pull request targets — because their own
fragments are still in this diff, unmerged to `main` with the rest of the epic.

file: src/lib/xero-operation-outbox.ts
lines: 3198
reason: nineteen lines, seventeen of them the docblock on ONE new optional
  field. The field is an enqueue-time instruction the booking create passes and
  every one of the other fourteen callers omits, so the comment names them —
  that list is the whole census, and a reader deciding whether their enqueuer
  should pass it needs to find the answer where the option is declared, not in
  an issue. This file is deliberately one dispatcher over every Xero outbox
  operation type: splitting the booking-invoice enqueuer out to save nineteen
  lines would put one queue type's shape in a second file and is how two
  enqueuers come to disagree about what a queued operation carries.
