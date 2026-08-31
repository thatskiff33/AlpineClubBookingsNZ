# File-size allowances for #3187

file: src/lib/xero-booking-repair-classify.ts
lines: 1521
reason: the growth is one arm of the classifier learning that an edit's expected
  supplementary invoice is not always what its `BookingModification` row says,
  and it has to sit here because the whole point of #3187 is that the GATE and
  the ACTION are a pair. Widening the gate alone produces a critical finding,
  marked safe to auto-apply, whose queued action carries a net of zero and is
  refused by the enqueue's own net guard — a repair that silently does nothing,
  which is worse than the silence it replaced because it teaches an operator to
  ignore the tool. So the expected ask, the payload built from it and the
  detail reported about it are three reads of ONE object, adjacent, with the
  paragraph saying why. Lifting the action builder into
  `xero-booking-repair-findings.ts` beside its siblings was weighed and
  rejected: it would put the finding and the payload that must agree with it in
  different files, which is the drift this change exists to close. The module is
  a single sequential `classifyBookingContext`, deliberately kept whole since
  the #1208 split, and it was 694 lines over its 700-line budget before this
  change. Fix round (+54): the two states where the tool must REPORT rather
  than repair - a card that took less than the officer settled on, and a card
  request whose mint failed and is still owed by its recovery replay. Both are
  the same decision as the arm above them (should this invoice be raised, and
  as paid or unpaid?), taken from the same three numbers, and the whole reason
  the queue arm is trustworthy is that a reader can see the two refusals beside
  it. Moving them out would leave the payload and the conditions under which it
  must not be built in different files - the drift this change exists to close.
  Delta round (+17): the paragraph recording that two parked edits on one
  booking, hitting the same manual-review reason, collapse to a single action -
  the key is built from the booking and the reason text, and neither summary
  carries a modification id. It is left that way deliberately, because it is the
  convention every other manual-review arm in this file follows, and a reader
  who does not know that is one plausible edit away from giving this one arm a
  unique key and a second convention. The number above was re-measured with
  `wc -l` after merging the epic in, not incremented.
