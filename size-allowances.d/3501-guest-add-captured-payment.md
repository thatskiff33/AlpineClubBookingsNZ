# File-size allowance for #3501 — the guest-add door's money question

One already-over-budget file grows, by twenty-nine lines, every one of them
comment or import wrapping. The behavioural change is a single line.

**Compression came first.** The docblock was written at twenty-three lines and
cut twice; the import accounts for four of the remaining lines on its own, since
it crosses the print width once a second name joins it. Nothing here is prose
that could have been a shorter sentence — it is the reason one door differs from
its three siblings, which is the single most deletable-looking thing in the file.

**Why the figure grew during review, which is the honest part of this fragment.**
It was opened at nineteen lines. Two adversarial reviews then found that the
obvious convergence — asking the whole of `hasCapturedPayment`, exactly as the
other three doors do — would have silently stopped collecting from **zero-dollar
bookings**, because that predicate also requires `amountCents > 0` and a stay
covered entirely by credit or a 100% promo carries `amountCents: 0` with a
`SUCCEEDED` status. At a club with the Xero integration off, nobody would have
been asked for the added guest's price at all: a new silent under-collection, at
the very door this issue exists to stop under-collecting at.

The door therefore asks the **status half** (`isCapturedPaymentStatus`) and the
docblock has to say why it differs from its three siblings. That explanation is
the growth. It is also the single most deletable-looking thing in the file — a
later reader who sees three doors calling one predicate and a fourth calling
another will "fix" the inconsistency unless the reason is sitting there. The
first draft of this change made exactly that mistake in the opposite direction,
and wrote a test asserting the loss was correct.

**Why the explanation cannot move somewhere thinner.** This door settles for
itself rather than through `applyPaymentAdjustments`, which is why it drifted in
the first place — #3200 fixed the invoice half of the same drift at the same
line. There is no shared settlement site the note could live at instead, because
not sharing the settlement site is the defect being worked around. Splitting the
route would not help either: the arithmetic is one linear block inside one
transaction callback, and lifting it into a helper puts the rule and the reason
for the rule in different files, which is the thing `INV-SSOT-001` asks us not
to do.

file: src/app/api/bookings/[id]/guests/route.ts
lines: 1578
reason: twenty-nine lines of comment and import wrapping on a one-line
  substitution. The docblock records that this door asks the STATUS half of the
  captured question rather than the full `hasCapturedPayment` its three siblings
  use, and why: the amount clause would have stopped it asking zero-dollar
  bookings for an added guest's price, which the Xero arm cannot cover when the
  integration is off. Without that note the difference reads as an oversight and
  gets "corrected", re-opening a money loss that two reviews caught. The door
  settles inline rather than through `applyPaymentAdjustments`, so there is no
  shared site the explanation could live at, and the block cannot be split out
  without separating the rule from its reason.
