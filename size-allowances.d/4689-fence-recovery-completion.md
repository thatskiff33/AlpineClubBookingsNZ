# File-size allowance for #4675 - the claim-fenced recovery close

file: src/lib/payment-recovery.ts
lines: 3606
reason: the runner's SUCCEEDED close is fenced on the claim the attempt holds,
  and the claim has to reach it from where it is taken and re-stamped: the
  claim hold returns its re-stamped claim, the succeeded-intent hand-off reads
  back the claim its own write took, and the webhook's claimless close becomes
  its own small function beside the claimed one so no runner path can reach
  for it. All three are private to this module and sit with the claim, the
  hold and the reaper they are fenced against; moving the close out would split
  the one recovery state machine across two files and add an import cycle the
  credit-release ask already works around. The shared claim type and its fence
  went to `payment-recovery-constants.ts`, inside its budget.
