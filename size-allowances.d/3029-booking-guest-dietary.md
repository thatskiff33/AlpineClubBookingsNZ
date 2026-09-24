# File-size allowances for #3029 (booking-guest dietary/allergy snapshot)

Every entry below is an already-oversized booking module that gains the one
required dietary decision its guest writes now take (`INV-MOD-059`). The
decision itself lives in `src/lib/member-dietary-booking-writes.ts`; what each
file gains is the seeding value read before its transaction and a single call
at the write it already makes. Splitting any of these modules is a refactor of
money- and lock-sensitive code of its own, which the issue forbids widening
into.

file: src/app/(lodge)/lodge/kiosk/page.tsx
lines: 1420
reason: the kiosk day list shows each present guest's dietary note under the
  name it already renders; the value arrives only for the admin and hut-leader
  tiers, so there is no separate component to lift out.

file: src/app/api/bookings/[id]/guests/route.ts
lines: 1650
reason: the add-guest route reads the seeding toggle before its transaction and
  spreads one dietary decision into the guest create it already performs.

file: src/app/api/bookings/route.ts
lines: 1495
reason: the create route reads the seeding toggle once, beside the lockout
  mode it already resolves, and hands it to the three create services.

file: src/lib/booking-batch-modification-service.ts
lines: 2602
reason: the seeding toggle joins the pre-transaction preparation that already
  holds every settings read on this path, and is handed to applyGuestChanges.

file: src/lib/booking-create.ts
lines: 2102
reason: each of the four guest creates (draft, confirmed, split child,
  waitlisted) resolves its dietary decision inside the transaction it already
  holds and passes it to the shared builder.

file: src/lib/booking-exception-approval.ts
lines: 1200
reason: the approval's new-booking execution parameters, resolved before its
  transaction, carry the seeding toggle to the create it executes.

file: src/lib/booking-modify-plan.ts
lines: 3114
reason: applyGuestChanges takes the seeding toggle; its two add-guest creates
  spread a decision and its two placeholder-link writes fill an empty value.

file: src/lib/booking-request-quotes.ts
lines: 2155
reason: the held booking resolves one dietary decision per planned guest
  inside the hold transaction it already opens.

file: src/lib/booking-request.ts
lines: 3032
reason: the held-party reassignment decides carries by identity before its
  delete and per-row rewrites by occupant, and the no-hold approval seeds its
  guests; both sit inside the existing approval transaction.

file: src/lib/diagnostics/tools/provision-role.ts
lines: 1134
reason: the BookingGuest column-grant note records that the dietary column is
  deliberately never granted to the diagnostics role.

file: src/lib/group-booking.ts
lines: 1904
reason: the member join passes the seeding toggle and the non-member joiner
  resolves its (empty) decisions through the same door.

file: src/lib/school-booking-request.ts
lines: 2934
reason: the school and whole-lodge approvals read the toggle before their
  transactions and resolve one decision per guest at their creates.

file: src/lib/waitlist-cross-lodge.ts
lines: 998
reason: the cross-lodge offer rebuilds the same stay, so it captures each
  source row's value and carries it onto the new guest rows.

file: src/lib/member-guest-consent-service.ts
lines: 1259
reason: granting a member guest's pending consent is the moment their row
  first belongs to them, so the approval fills an empty dietary note from their
  profile inside the consent transaction it already holds (#3029 S5); the
  seeding toggle is read with the club day before that transaction.
