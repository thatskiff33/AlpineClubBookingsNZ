# File-size allowance for #4676 - a throwing claim hold settles its intent

file: src/lib/payment-recovery.ts
lines: 3620
reason: one `.catch` on the additional-intent runner's claim hold, which hands
  a hold that threw to the lost hold's own settle (`settleLostRecoveryClaimHold`,
  in `reissued-ask-abandoned-intent.ts`) and rethrows. It has to sit on the
  hold call itself: it needs that attempt's minted intent and its `adopted`
  flag, which exist only in this function, and the rethrow has to reach the
  runner's retry in this module. The proof and the logging went into the
  existing helper; only the five-line hand-off is here.
