# File-size allowances for #3770 (create-door member-id probe)

Two already-over-budget files grow. Neither change adds a rule of its own: each
moves existing refusals above the member lookup, and the growth is the code that
splits one refusal in two plus the comment saying why the order matters.

file: src/app/api/bookings/route.ts
lines: 1517
reason: the route is a long, ordered sequence of guards, and the contract this
  issue fixes IS that order: the input-only refusals must run before the member
  lookup, and the ones that read the resolved party after it. Moving the
  stay-range, own-dependant, past-date, lodge and guest-count checks out to a
  module would put half of that sequence in another file, which is exactly the
  place a later edit drops a new refusal on the wrong side of the lookup again.
  The growth is the pre-lookup stay-range validation (eight lines), the past-date
  split (the plain refusal above the lookup, the retroactive lookback and Xero
  lock below it, because those need the resolved stay envelope) and the comment
  naming the rule for the next refusal somebody adds.

file: src/lib/booking-exception-request-service.ts
lines: 2449
reason: the "nothing to review" collapse has to live in `freezeProposal`, the one
  function both exception doors call, with the beyond-family ids as a required
  argument so a new caller cannot forget it. Putting it in a separate module
  would split the refusal from the only place it is raised. The rest is the
  reorder on the new-booking door and the comments recording why "nothing to
  review" cannot simply be moved above the lookup like the others: whether
  anything trips reads the named members themselves.
