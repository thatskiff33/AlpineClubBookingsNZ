# File-size allowances for #3971 (subscription invoice charge id)

file: src/lib/xero-operation-retry.ts
lines: 1928
reason: the Xero Operations retry for a failed membership subscription
  invoice is one more "send the row back to the outbox" branch, beside the
  group settlement and kept late-capture branches that already live here and
  share this module's private, status-guarded requeue helper. It needs that
  helper, the module's retry error and its support gate, so moving it out
  would either export the requeue primitive for one caller or split one
  dispatcher's sibling branches across two files. The growth is the requeue
  payload, the refusal of a charge that already has a Xero invoice or needs
  none, and their calls in the gate and the executor.
