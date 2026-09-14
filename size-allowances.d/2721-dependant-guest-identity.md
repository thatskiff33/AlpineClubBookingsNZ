# File-size allowances for #2721 (own-dependant guest identity)

One already-over-budget file grows: the booking-create route handler. **The seam
that did exist was taken first**, and it is why this list is one file rather
than three:

- `src/lib/booking-dependant-identity.ts` — the whole rule. The candidate set,
  the exact-match collision detection, the declaration shape and the refusal,
  with the privacy boundary and the never-positional note. The wizard and the
  route both import it, which is the point: a second spelling of "is this name
  my dependant?" in the client is how the question the wizard asks and the
  question the server answers come to differ.
- `src/lib/person-name-normalization.ts` — the trim/lowercase/collapse rule,
  lifted out of `guest-name-similarity.ts` where it was private, so the
  post-payment typo guard and this one cannot drift.

Both new modules are far inside their own budgets, and
`src/lib/member-family-service.ts` stayed inside its 700 by keeping its share to
the import and the one payload field.

file: src/app/api/bookings/route.ts
lines: 1487
reason: eighty-odd lines, roughly half of them comment. The code is a single
  guarded call — load the booker's dependants, check the party against them,
  answer the refusal — and it cannot move out of this handler, because
  everything it reads is decided in this handler and nowhere else: the resolved
  member ids come out of the linked-member map built thirty lines above, and
  `isAuthorizedOnBehalf` is the same local flag that decides `skipAuthorization`
  beside it. Lifting it to a module would put the exemption in a different file
  from the exemption it has to agree with, which is exactly the drift
  `INV-SSOT-001` is about. The comment is load-bearing twice: it is the only
  record that the guard sits before the person-night, hosting and capacity
  pre-flights on purpose, so a party about to put a member on the bumpable
  non-member queue is stopped while it is still a proposal; and the only
  statement of why an authorised on-behalf create is exempt, which a reader who
  deletes it will otherwise read as an oversight and "fix". The review round
  made it SHORTER than first written: forty-one lines used to argue that the
  guard must be handed the normalised party, and that argument is now a required
  argument instead of a comment — the guard takes the ids that really resolved
  and works the member path out itself, so there is no precondition left to
  explain. This route is already a long sequence of such guards; splitting one
  out because it is the newest would make the order they run in — which is the
  whole contract — impossible to read in one place.

  The owner's decision of 15 Sep 2026 then added twenty-one lines and changed
  what half of them say. The exemption is gone, so the paragraph justifying it is
  replaced by the one recording WHY it is gone — that this check protects a third
  party's bed rather than the acting officer's authority, so a reader who finds
  the member-guest boundary check skipping beside it does not "fix" the
  inconsistency back. The other half is the sentence naming whose dependants are
  read: `effectiveMemberId`, the member the booking is for, never
  `session.user.id`, which on this path is the officer. That one is the
  difference between the guard working and the guard disclosing another family's
  names, and it is a one-token edit away in either direction.
