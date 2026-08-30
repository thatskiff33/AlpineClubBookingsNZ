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
