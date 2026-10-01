# File-size allowances for #3770 (create-door member-id probe)

Three already-over-budget files grow. None of the changes adds a rule of its
own. Each one either moves existing refusals above the member lookup or
pre-checks a refusal the transaction already makes. The growth is the code that
splits one refusal in two, plus the comment saying why the order matters.

file: src/app/api/bookings/route.ts
lines: 1555
reason: the route is a long, ordered sequence of guards, and the contract this
  issue fixes IS that order: refusals that read only the request and the booker
  must run before the member lookup, and the ones that read the resolved party
  after it. Moving the stay-range, own-dependant, past-date, lodge, guest-count,
  owner-subscription, minimum-stay, Internet Banking and promo checks out to a
  module would put half of that sequence in another file. That is exactly where
  a later edit would drop a new refusal on the wrong side of the lookup again.
  The growth is the pre-lookup stay-range validation, the past-date split (the
  retroactive lookback and Xero lock stay below the lookup, because they need
  the resolved stay envelope), the promo pre-check call, the `!draft` guard on
  the Internet Banking block, and the comment naming the rule for the next
  refusal somebody adds. The promo rules themselves live in
  `booking-create-promo.ts`.

file: src/lib/booking-exception-request-service.ts
lines: 2493
reason: the "nothing to review" collapse has to live in `freezeProposal`, the one
  function both exception doors call. It takes the beyond-family ids as a
  required argument, so a new caller cannot forget it. The supersede-target and
  open-slot pre-checks have to sit in each create function, between the
  dependant question and the member lookup: each door claims on its own table
  with its own scope, and the in-transaction claims they front are already
  there. Putting either in a separate module would split each refusal from the
  only place it is raised.

file: src/app/api/bookings/[id]/exception-requests/route.ts
lines: 335
reason: twenty lines. The refusal clock has to start at the top of the
  handler, and the collapsed-refusal handling has to sit in the handler's own
  catch, because only the handler holds the request, the session and the clock
  that `handleMemberGuestAddRefusal` needs. This is the same shape every booking
  add path already uses, and lifting it out would hide the one ordering (clock
  first, helper before mapping) that makes the timing floor real.
