# File-size allowances for #5468 (#5433, waitlist owed notices)

file: src/app/(admin)/admin/booking-desk/waitlist/page.tsx
lines: 1037
reason: the board gains one delivery state, a non-production copy's withheld
  offer email, with its label and its neutral badge beside the other states it
  is chosen among; moving one case of a closed switch out of the page would
  split the list an officer reads from the code that renders it.

file: src/lib/waitlist-cross-lodge.ts
lines: 1002
reason: a window restart between the cross-lodge confirm's phases must still be
  the same offer, so each later phase re-reads its claim through
  offerSnapshotAcrossWindowRestart; the four lines sit inside the claims they
  guard, and lifting the phases out is a refactor of its own.

function: src/lib/waitlist-cross-lodge.ts#confirmCrossLodgeWaitlistOffer
lines: 712
reason: the same three re-reads, one per later phase, inside the transactions
  whose claims they feed; the phases are not yet separate functions, and
  splitting them here would move the claims away from their locks.
