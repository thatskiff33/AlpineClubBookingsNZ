# File-size allowances for #3032

Three booking-edit services each gain the same call: the pending-review fence
that refuses a second money-affecting edit while the club is still working out
the money for the last one. Every one of them was already far over its budget
before this change, and each grows by one call plus the comment explaining why it
sits where it does.

The fence itself is NOT duplicated — the rule, the message, the machine code and
the narrow-by-design exemptions all live once, in
`src/lib/edit-financial-review.ts`, and these three sites call it. What cannot be
lifted out is the CALL, because its position is the safety property: it has to be
after both advisory locks, after the post-lock re-read, after the authorisation
checks, and before any write. A helper that "wrapped" the three services to move
those lines elsewhere would put the ordering rule somewhere other than the code
it orders, which is exactly how an ordering rule stops holding.

Splitting any of these three modules is a refactor of its own. They are the
booking-edit engines; a seam through them touches every lock-ordering comment,
every settlement branch and a large share of the booking test suite, and it
belongs on an issue where it can be reviewed as the domain change it is rather
than ridden in on a money-correctness fix. Each was over budget independently of
this change and stays over it by the same margin plus its one call.

file: src/lib/booking-batch-modification-service.ts
lines: 1538
reason: the fence call has to sit after both advisory locks, the post-lock
  re-read and the identity-only/credit-election determination, and before the
  pricing engine runs — its position IS the guarantee, so it cannot be lifted
  into a wrapper without moving the ordering rule away from the code it orders.
  The module was 822 lines over budget before this change and is a booking-edit
  engine whose split is a domain refactor in its own right.

file: src/lib/booking-date-modification-service.ts
lines: 1779
reason: same one call, in the same position, on the path where every edit
  reprices. The module was 1,066 lines over budget before this change; splitting
  the date engine would touch every lock-ordering comment and settlement branch
  in it and belongs on its own issue rather than on a money-correctness fix.

file: src/lib/booking-guest-removal-service.ts
lines: 1033
reason: this site carries the most comment of the three because it also carries
  the one exemption that keeps owner decision D-14 true — a member who never
  consented must always be able to come off a booking, so a consent-authority
  removal proceeds and parks its own money rather than being trapped behind a
  pricing question nobody has answered. That reasoning belongs at the call site,
  where somebody deleting the exemption will read it. The module was 304 lines
  over budget before this change.
