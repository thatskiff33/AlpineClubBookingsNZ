# File-size allowance for #4686 (a late CANCELLED or PARTIAL keeps an officer's Retry)

file: src/lib/xero-sync.ts
lines: 1130
reason: `completeXeroSyncOperation` now notes, inside its transaction, when a
  part-success was refused because its attempt lost its claim, and hands the
  Xero object to `afterLostClaimPartial` once that transaction has returned,
  so the audit row and alert run after commit, outside it. The flag, its
  setter and the hand-off are four lines that must sit where the transaction
  ends; the trace itself lives in `xero-late-partial-trace.ts`, and splitting
  the writer would move the commit boundary away from the code that has to
  follow it.
