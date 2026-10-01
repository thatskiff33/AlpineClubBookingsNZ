# File-size allowances for #3462

Two entries, both on Xero modules that were already far over budget.

file: src/lib/xero-operation-retry.ts
lines: 1844
reason: the new `runWithClaimedOriginal` is the ONE place a retry claims the
  original operation and abandons that claim, and it has to sit beside
  `retryXeroSyncOperation` and `throwLostRetryClaim`, which it calls: moving it
  out would need the lost-claim refusal exported or duplicated, the exact
  split-brain the helper exists to remove. The Payment-invoice branch's inline
  claim moved into it, so the net growth is the helper and its docblock, plus
  `retryAbandonedItsClaim`, which lets the REQUEUE message say "back to
  FAILED" only after an abandon really wrote; it reads state only this helper
  records.
  Splitting this 1,780-line retry module is its own job with its own review.

file: src/lib/xero-sync.ts
lines: 980
reason: `failXeroSyncOperation` gains the guarded abandon (`onlyIfRunningSince`)
  and an operator-message override, documented at the option; the two write
  guards are one discriminated option type so both can never be passed. They belong on
  the one FAILED writer so the redaction, status-code read and repeated-failure
  alert stay in one place rather than being copied into the retry module.
