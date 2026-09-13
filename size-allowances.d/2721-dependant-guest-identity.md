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
lines: 1453
reason: seventy lines, and forty-one of them are one comment block. The code is
  a single guarded call — load the booker's dependants, check the normalised
  party against them, answer the refusal — and it cannot move out of this
  handler, because everything it reads is decided in this handler and nowhere
  else: `guestInputs` only exists after `normalizeBookingGuestInputs` has
  stripped an unresolved member link, and `isAuthorizedOnBehalf` is the same
  local flag that decides `skipAuthorization` thirty lines above. Lifting it to
  a module would mean passing both back out and would put the exemption in a
  different file from the exemption it has to agree with, which is exactly the
  drift `INV-SSOT-001` is about. The comment is load-bearing three times over:
  it is the only record that the guard reads the NORMALISED party, which is what
  makes a forged `isMember: true` irrelevant rather than a hole; the only record
  that it sits before the person-night, hosting and capacity pre-flights on
  purpose, so a party about to put a member on the bumpable non-member queue is
  stopped while it is still a proposal; and the only statement of why an
  authorised on-behalf create is exempt, which a reader who deletes it will
  otherwise read as an oversight and "fix". This route is already a 1383-line
  sequence of such guards; splitting one of them out because it is the newest
  would make the order they run in — which is the whole contract — impossible to
  read in one place.
