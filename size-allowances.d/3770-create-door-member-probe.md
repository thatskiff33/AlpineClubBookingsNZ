# File-size allowances for #3770 (create-door member-id probe)

Six already-over-budget files grow. None of the changes adds a rule of its
own. Each one either moves existing refusals above the member lookup or
pre-checks a refusal the transaction already makes. The growth is the code that
splits one refusal in two, plus the comment saying why the order matters.

file: src/app/api/bookings/route.ts
lines: 1796
reason: the route is a long, ordered sequence of guards, and the contract this
  issue fixes IS that order: refusals that read only the request and the booker
  must run before the member lookup, and the ones that read the resolved party
  after it. Moving the stay-range, own-dependant, past-date, lodge, guest-count,
  owner-subscription, minimum-stay, Internet Banking and promo checks out to a
  module would put half of that sequence in another file. That is exactly where
  a later edit would drop a new refusal on the wrong side of the lookup again.
  The growth is the pre-lookup stay-range validation, the request's own stay envelope (which the
  retroactive lookback, the Xero lock date and the promo pre-check now read
  before the lookup), the promo pre-check call, the `!draft` guard on
  the Internet Banking block, and the comment naming the rule for the next
  refusal somebody adds. The promo rules themselves live in
  `booking-create-promo.ts`. The owner's family-first decision (#3770, comment
  5946598639, `INV-GUEST-020`) adds the rest: the lookup now runs in two phases
  with the per-member guards run once over the family and once over the whole
  party, and the deferred paid-up-adult, hosting and adult-supervision collapse,
  with the services' own hosting and supervision refusals mapped the same way.
  Round 4 adds the lodge-access, room-lodge and stay-envelope past-date refusals
  ahead of the lookup; the owner's R4 decision adds the full-lodge pre-flight,
  which has to sit between the family pass and the outsider lookup and shares
  the route's one CAPACITY_EXCEEDED body with the service's answer. The resolution itself moved out to
  `member-guest-family-first.ts`, shared with the exception doors; what stays is
  the ordered sequence of refusals, which is the contract, so it stays readable
  in the one handler that owns it.

file: src/lib/booking-exception-request-service.ts
lines: 2488
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

file: src/lib/promo.ts
lines: 2018
reason: two small shared exports, the lodge-restriction predicate and the
  guest-selection message, that the rules, the application and the create
  route's pre-check now all read. Before this change the predicate was written
  out twice in this file, and a third copy in the pre-check is exactly the drift
  `INV-SSOT-001` forbids. The growth is the named function and its docblock.

file: src/lib/membership-type-policy.ts
lines: 1355
reason: comment only. It records, beside the "the stranger's refusal wins"
  rule it qualifies, that the create route no longer reaches that ordering
  (owner decision, `INV-GUEST-020`). A reader who finds the rule without the
  note would believe the create route still behaves that way.

file: src/lib/booking-create.ts
lines: 2122
reason: three lines. The waitlist path's promo-code normalisation and its
  internal-code refusal now call the one shared helper in
  `booking-create-promo.ts` instead of spelling the rule out inline. The growth
  is the two import names and the named result.

file: src/app/api/bookings/[id]/guests/route.ts
lines: 1710
reason: six lines. The adult-supervision rule is now asked of the guest rows
  themselves, which carry each guest's stored or planned consent, instead of
  the consent-free pricing view, because only an agreed adult counts (owner
  decision on #3770). The call has to stay where the route already decides the
  review; the growth is the call and the comment saying why it reads the rows.

file: src/lib/booking-modify-plan.ts
lines: 3203
reason: eleven lines. The plan already read each proposed row's stored or
  planned consent for the paid-up-adult rule; that read is now one named helper
  that the adult-supervision rule uses too (owner decision on #3770), so the two
  rules cannot judge the same party's presence differently. It has to sit beside
  the review decision it feeds, in the function that builds the proposed party.
