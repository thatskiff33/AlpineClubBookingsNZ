# File-size allowance for #3501 — the guest-add door's money question

One already-over-budget file grows, by nineteen lines, and every one of them is
comment.

**Compression was taken first, and a split was taken where one existed.** The
change itself is a one-line substitution: `payment.status === "SUCCEEDED"`
becomes `hasCapturedPayment(booking.payment)`. Four of the nineteen lines are the
import, which crosses the print width once a third name joins it and so wraps
from one line to five. The docblock was written at twenty-three lines and cut to
fourteen before this fragment was opened. In the same pull request the sibling
route `confirm-modification-payment/route.ts` was converged onto the same one
home and kept *inside* its budget by hoisting a module-level `Set` — so the
allowance below is what was left after doing that work, not instead of it.

**Why the explanation cannot move somewhere thinner.** This door settles for
itself rather than through `applyPaymentAdjustments`, which is exactly why it
drifted in the first place (#3200 fixed the invoice half of the same drift, at
the same line). A reader arriving at this block needs to know, at the block,
that the substitution moves the answer in **two** directions and that both are
intended: wider for the two refunded shapes, which is the defect the issue was
filed for, and narrower for a zero-dollar booking, which is a fix the owner's
decision did not explicitly cover and which was found by tracing rather than
assumed. The second half is the one a later reader would otherwise "correct" —
it looks like an accidental regression and is not. A comment that lives in the
policy module instead is a comment nobody reads at the moment they need it,
which is the failure `AGENTS.md` records as the reason its own mandatory reading
list was replaced by a routing table.

Splitting the route is not available here and would not help if it were: the
settlement arithmetic is one linear block inside one transaction callback, and
lifting eight lines of it into a helper would put the rule and the reason for
the rule in different files — the thing `INV-SSOT-001` asks us not to do.

file: src/app/api/bookings/[id]/guests/route.ts
lines: 1568
reason: nineteen lines, all comment and import wrapping, on a one-line
  behavioural substitution. The docblock explains that the shared predicate
  moves this door's answer BOTH ways — wider for PARTIALLY_REFUNDED and
  REFUNDED, narrower for a zero-amount capture — and says why the narrowing is a
  fix rather than a regression, since the zero-dollar auto-pay leaves a null
  Stripe intent behind a SUCCEEDED row whose source is still STRIPE. Without
  that note the next reader restores the old test and re-opens the defect. The
  door settles inline rather than through `applyPaymentAdjustments`, so there is
  no shared settlement site the explanation could live at instead, and the
  block cannot be split out without separating the rule from its reason.
