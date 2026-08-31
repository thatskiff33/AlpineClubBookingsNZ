# File-size allowances for #3170

Six files this change touches were already far over budget before anyone opened
this issue, and five of them are the booking-edit engines: the in-progress
planner, the modify plan, the batch modify service, and the two routes over them.
That is not incidental to the change — it is where the change has to be. Making
"the price of this night is not known" a storable value means every place that
composes, writes, previews or refuses a night price has to say which of the two
absences it is looking at, and those places live in exactly these files.

Nothing here could be lifted into a new module. The distinction between "the
composer said unknown" and "the vector is short" is enforced at the WRITE, and
the write is one function inside `applyGuestChanges`; the parked plan is composed
from state that only exists inside `buildInProgressGuestRangePlan`; and the
decision to move no money is a set of branches through a 1,700-line service whose
ordering IS its safety property. A wrapper that moved those lines elsewhere would
put the rules somewhere other than the code they govern, which is how an ordering
rule stops holding.

A large share of the growth is prose rather than logic, and deliberately so. Two
of this repository's four re-fixed-the-same-rule incidents began with a money
rule that was correct in the code and unexplained beside it, and the single most
important paragraph in this change — why an explicit `null` is honoured and a
short vector still throws — is one somebody will otherwise delete as redundant.

Splitting any of these five is a refactor of its own. They are the booking-edit
engines; a seam through them touches every lock-ordering comment, every
settlement branch and a large share of the booking test suite, and it belongs on
an issue where it can be reviewed as the domain change it is rather than ridden
in on an epic's last child. Each was over budget independently of this change.

The five booking-edit files this change also grows already carry an allowance
from #3031, which is a sibling child of this same epic and therefore LIVE in this
comparison rather than inert. One file, one allowance — so their recorded lengths
are updated in place in `size-allowances.d/3031-exact-sold-price.md`, each with a
note saying what #3170 added, in the same append style that file already uses for
its own later rounds. Only `xero-booking-invoices.ts` is new to the list and is
declared here.

file: src/lib/xero-booking-invoices.ts
lines: 1404
reason: a guest holding a night whose price is not known falls back to the
  whole-stay line rather than having that night dropped from the per-night runs.
  Dropping it would emit an invoice SHORT by that night's money - a live
  under-charge on a real Xero document - because the runs reconcile to the
  guest's total only by partitioning every night held. The growth is the
  narrowing predicate and the paragraph naming that failure, which has to sit on
  the branch it prevents.

file: src/lib/xero-invoice-rounding-audit.ts
lines: 787
reason: the operator CLI that replays the pre-#1231 invoice maths was a missed
  consumer twice over - its arithmetic added an unknown night as 0 and collapsed
  the run minimum to 0, and it had stopped replaying the builder, which now sends
  a guest with any unknown night down the whole-stay branch. The growth is one
  filter spelt the same way as the builder's plus the paragraph saying why the
  branch has to match, which belongs on the mapper it guards: this module's whole
  promise is that it reproduces the builder byte for byte, and a reader who
  cannot see that the two branch alike will re-introduce the divergence. The
  module was already over its 700-line budget before this change and is a single
  cohesive diagnostic - splitting a replay in half is how the halves drift.

file: src/lib/xero-operation-outbox.ts
lines: 3094
reason: (#3193 fix round reconciliation - re-measured at 3094, was 2992. The
  round split the enqueue's `short` verdict into `short-sent` and
  `short-in-flight`, because one name was carrying two different facts: an
  invoice that EXISTS, and a row the outbox has merely claimed. Only the first is
  durable - a claimed row returns to PENDING un-attempted on a Xero cooldown
  refusal, and the next settlement then raises it to the combined total, which
  already contains any share billed separately in the meantime. The worked
  sequence bills $310 for a $280 edit. The distinction has to live on the outcome
  the enqueue returns, because the enqueue under its lock is the only place that
  can tell the two apart at all. The same round fenced
  `attachPaymentIntentToWaitingSupplementaryInvoiceOperations` on
  `localModel: "BookingModification"` - it matches on the payload rather than the
  anchor and was the one change-scoped read that could see a second ask - and
  made `shortfallReviewTaskId` a parameter of a module-private implementation
  rather than a public option, so "set only by the wrapper" is unrepresentable
  rather than policed. Also the earlier note, kept: the number, not the argument. This allowance is
  still unmerged to `main`, so the ratchet judges the file against it rather than
  against the base ref, and 2877 was the length when #3170 wrote it. #3193 added
  the SECOND ASK - a named path over this same enqueue that raises a settled
  review share's own small invoice when the change's invoice had already gone out
  without it. It is a wrapper rather than a second locked decision precisely so
  this file keeps exactly one place that answers "does this ask already have an
  invoice going out?", which is the property #3170 was fixing; a copy elsewhere
  would be smaller here and worse everywhere. Re-measured, not guessed.) the fix round's Xero half of "one booking edit, one ask". An edit whose
  money could not be valued can raise two review tasks, and the owner's 30 Aug
  2026 decision is that both contribute to a single request for the total - so
  the supplementary invoice has to bill $230 rather than $200 and then $30.
  Queueing the second one is not available and is the defect: this module's own
  `enqueueXeroSupplementaryInvoiceOperation` refuses an anchor that already
  carries an active SUPPLEMENTARY_INVOICE link and returns a MESSAGE rather than
  an error, so the second share is dropped in silence. What was added is one
  restate - raise the PENDING or WAITING_PAYMENT operation's amount, and its
  correlation key with it, because that key is built FROM the amount and a stale
  one would let a later enqueue queue a duplicate. It belongs here and nowhere
  else: it is the exact inverse of `attachPaymentIntentToWaitingSupplementaryInvoiceOperations`
  a few lines below it, reads the same payload shape by the same JSON path, and
  the two must agree about which states are still safe to edit. A caller-side
  copy would be a second definition of "has this ask left the building". The
  module was 1,776 lines over its 700-line budget before this change; it is the
  single Xero outbox and a seam through it is a refactor of its own.
  Fix round 2 (+133): the restate alone could not deliver what its docblock
  claimed. Its status filter was on the READ and not on the write, so an
  operation that left PENDING between the two statements was rewritten behind an
  ask already going out; it had no comparison at all, so a stale run's smaller
  total could LOWER a queued invoice and its caller would then return early,
  leaving nothing to re-queue the difference; and the enqueue beside it deduped
  on a `correlationKey` BUILT FROM THE AMOUNT, so two concurrent settlements at
  $200 and $230 matched nothing of each other's and queued two operations - two
  Xero invoices, $430 billed for a $230 edit. The growth is the status-guarded
  `updateMany`, the never-lower comparison on the invoice's NET, a per-anchor
  advisory lock around the enqueue's link-check -> queued-check -> write, an
  anchor-scoped lookup replacing the amount-scoped one, and the paragraphs
  stating what is now guaranteed and the one window that is not. All of
  it has to sit on the two functions it governs: this is the single definition of
  "does this booking change already have an invoice going out", and a caller-side
  copy is what let the two answers disagree in the first place.
  Fix round 4 (+96): the window fix round 2 wrote down was not the one that
  existed. The outbox worker read each operation's payload from its SCAN and
  claimed the row a Xero round trip later, so a restate landing in that window
  MATCHED the still-PENDING row, wrote, and honestly reported that it had
  restated - while the send used the scanned figure and its caller returned early
  believing the combined total was billed. On the internet-banking route, where
  the supplementary invoice IS the ask, that invoiced $200 of a $230 edit and left
  the $30 existing nowhere. The growth is a post-claim re-read of
  `requestPayload` in `processQueuedXeroOutboxOperations` with the paragraph
  explaining why the ORDER is the whole point, and a `covers-total | short | none`
  verdict on the enqueue's return so the settlement can tell an invoice raised to
  the total from one that had already left the queue - the `message` beside it is
  prose for an operator's repair report and nothing could branch on it. Both
  belong here for the same reason the rest does: the enqueue is where the link
  check, the queued check and the restate all happen under one lock, and it is the
  only place that question can still be answered - `createXeroSupplementaryInvoice`
  overwrites the operation's payload with the Xero invoice body at dispatch, so
  afterwards the queued amount is simply gone. #3181 fix round (+14): the
  per-anchor advisory lock's docblock NAMED ITS CALLERS, deliberately, because
  "every caller is post-commit" had already been false once and a lock-ordering
  claim has to be checkable. #3181 added a third - the payment-recovery worker -
  and an enumeration written to be audited is worse than useless once it is
  silently incomplete, so the third caller is named there with the evidence that
  it too arrives holding nothing (a status-guarded `updateMany` claim, no
  transaction, no advisory lock, its Stripe round trip long finished).
