# File-size allowances for #4442

A new additional ask must not carry money a stale tab paid between its sizing
and its queue. The recovery runner is one of the three writers of that ask, so
its replay re-reads the carried balance under the same locks as the others,
and (review C-F1) a retry that finds its own row resumes its post-write steps.

file: src/lib/payment-recovery.ts
lines: 3474
reason: the additional-ask replay's own changes, beside the claim, the mint
  and the supersede they guard - the shared queue fence's import and re-read
  (frozen replays included), refusal of unverifiable frozen amounts after a
  capture on every retry, the claim hold's lock choice and transaction
  budget, and the post-write steps lifted into one closure so a retry that
  finds its OWN row runs exactly them instead of completing as overtaken. The
  lock order itself lives in `lockAdditionalAskQueue`
  (`additional-ask-queue-transaction.ts`); lifting the whole replay out of
  this module is a refactor of its own.
