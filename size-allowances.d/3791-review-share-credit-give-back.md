# File-size allowances for #3791

file: src/lib/member-credit.ts
lines: 1075
reason: the review share's give-back IS the clamp's give-back of applied credit,
  Xero deallocation step included (#3791 asks for one mechanism, not a second),
  so `giveBackAppliedCredit` has to sit beside the clamp, `lockMemberCreditLedger`
  and `deriveBookingAppliedCreditCents` it is built from. Moving it out would
  import those back from here and split one ledger rule across two files; the
  review-only rules (the unpaid limit, netting against a cancellation's restore)
  live in `edit-financial-review-account-credit.ts` instead.

file: src/lib/xero-credit-notes.ts
lines: 1164
reason: the unallocated account-credit note's builder takes the review task
  (#3791 fix round) so a sibling review's note on the same edit is not mistaken
  for this one. The task scopes that builder's own link short-cut and Xero key,
  which live only here; the key parts themselves are shared from
  `xero-review-task-key.ts`.

file: src/lib/xero-operation-outbox.ts
lines: 3268
reason: the two modification credit-note enqueues are where a queued note is
  deduplicated, and a review task's note has to be deduplicated by its own
  task-scoped key rather than the anchor's link (#3791 fix round). Splitting the
  enqueues out of the outbox would move the dedupe away from the worker dispatch
  that reads the same payload.

file: src/lib/xero-operation-retry.ts
lines: 1843
reason: an operator retry of a modification credit note must rebuild the same
  task-scoped keys and the account-credit wording the note was queued with
  (#3791 fix round); the retry dispatch for that queue type lives here.
