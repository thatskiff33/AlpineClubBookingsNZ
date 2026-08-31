# File-size allowances for #3193

Two already-oversized modules grow in the #3193 fix round, and both grow for the
same reason: the second ask is deliberately anchored on the review task whose
settled share it bills, and that anchor — the thing that stops the booking
change's own reads sweeping it into the combined total — also made it invisible
to every operator tool. Teaching the admin Xero screens the anchor is what turns
a failed second ask from an untitled row nobody can open into something an
officer can find and replay. The booking's audit trail already told them the
amount was being billed, so "invisible" was worse than merely inconvenient.

Neither addition has a seam to move to. The retry branch has to sit inside the
one dispatch switch that maps an operation to its replay, beside the
`BookingModification` branch it is the counterpart of; lifting it out would put
two halves of "how do I replay a supplementary invoice" in different files. The
record scope has to sit in the switch that maps a local model to what a record
page shows, beside the six scopes already there, for the same reason. Both files
were far over budget independently of this change, and both are single cohesive
dispatchers whose value is that every case is readable in one place.

file: src/lib/xero-operation-retry.ts
lines: 1390
reason: (second pass, re-measured at 1390, was 1379. The eleven lines are the
  correction to this branch's own premise. It was written believing the payload
  survives a failed attempt; it did not, because `createXeroSupplementaryInvoice`
  records the Xero invoice body on the operation BEFORE calling Xero - so the
  branch was DEAD in the one case it exists for, a Xero rejection, and the
  refusal beside it was the ordinary ending rather than the last resort. The
  create path now preserves a second ask's queued payload, and the paragraph
  saying so has to sit on the branch that depends on it, because the next reader
  of a refusal message about "overwritten amounts" will otherwise reach exactly
  the wrong conclusion about which code guarantees what.) The original entry,
  unchanged: a second supplementary invoice that Xero rejected had no retry at all -
  this screen's only supplementary-invoice branch matched `BookingModification`,
  so a `ManualRefundTask`-anchored row sat FAILED forever while the booking's
  history said the amount was being billed. The growth is one branch in the
  replay switch plus one in the retry-eligibility switch, and the paragraph
  saying why this row is replayable ONLY from its queued payload: the share it
  bills lives nowhere else, unlike the change's own invoice, which can be rebuilt
  from the `BookingModification` row. Rebuilding from the task's current amount
  would be a guess about what this row was queued with, so it refuses and says
  so. Both branches belong in the switches they extend - a replay split across
  two files is how two halves of one mapping drift apart.

file: src/lib/xero-record-activity.ts
lines: 838
reason: the second ask's record page. `ManualRefundTask` was not a Xero local
  model, so the page 404'd and the operations panel rendered the row as untitled
  plain text with no link. The growth is one scope builder in the same shape as
  the six beside it - root record, related booking and payment, back link to the
  booking's activity - plus the paragraph explaining why an anchor that exists to
  be invisible to the booking change's reads must NOT be invisible to an
  operator. The builder cannot move: `getXeroRecordScope` is the single switch
  that maps a local model to what its page shows, and a scope living outside it
  is one an obvious reader will not find when adding the next model.
