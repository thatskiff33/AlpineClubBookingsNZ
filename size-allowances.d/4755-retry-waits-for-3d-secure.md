# File-size allowance for #4755

The recovery replay waits, for a bounded hour, on a carried ask whose member is
on their bank's 3D Secure page. The decision itself and the two pure column
mappers live in `additional-ask-recovery-replay.ts`; what stays here is the
part that writes the recovery row.

file: src/lib/payment-recovery.ts
lines: 3672
reason: the wait, its sooner recheck and the sighting are written by the one
  fenced chokepoint every recovery failure and wait already goes through
  (`markPaymentRecoveryOperationFailed` via `waitPaymentRecoveryOperation`),
  and the pre-mint clear uses the same held-claim fence as the mint's hold
  (`heldPaymentRecoveryClaimWhere`). Moving them elsewhere would need those
  private fences exported or copied, splitting one row's write rules across
  two files. The replay function itself shrank by two lines.
