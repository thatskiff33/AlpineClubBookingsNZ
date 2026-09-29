# File-size allowances for #3407

Seven party-size door files each gain the one import line for
`lodgeGuestLimitMessage` (`src/lib/lodge-booking-readiness.ts`). The rule and
its wording live in that module; the only thing left in each door is the call,
which has to sit beside the check it explains.

file: src/app/api/bookings/[id]/change-requests/route.ts
lines: 585
reason: one import line for the shared not-set-up refusal message.

file: src/app/api/bookings/[id]/modify-quote/route.ts
lines: 2372
reason: one import line for the shared not-set-up refusal message.

file: src/app/api/bookings/route.ts
lines: 1503
reason: one import line for the shared not-set-up refusal message.

file: src/lib/booking-modify-plan.ts
lines: 3149
reason: one import line for the shared not-set-up refusal message.

file: src/lib/booking-request.ts
lines: 3044
reason: one import line for the shared not-set-up refusal message.

file: src/lib/group-booking.ts
lines: 1956
reason: one import line for the shared not-set-up refusal message.

file: src/lib/school-booking-request.ts
lines: 2943
reason: one import line for the shared not-set-up refusal message.

file: src/app/(admin)/admin/lodges/[id]/setup/page.tsx
lines: 960
reason: the new Capacity step's card. Its state, save, readiness read and
  Finish heading already live in `_components/wizard-capacity.tsx`; the card
  stays in the page because its Save button is a static view-only opt-out that
  must sit in the same file as the wizard's own banner
  (`view-only-banner-contract.test.ts`), and splitting it out would need a
  vouching parent for one button.

file: src/lib/setup-readiness.ts
lines: 2287
reason: the Club Config check now names every active lodge that is not set
  up for bookings, not only the default one (#3407 review). The wording sits
  beside the two branches that share it, inside the one check that owns the
  default-lodge warning; the resolver call itself lives in
  `setup-readiness-db.ts`.
