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
lines: 964
reason: the new Capacity step's card. Its state, save, readiness read and
  Finish heading already live in `_components/wizard-capacity.tsx`; the card
  stays in the page because its Save button is a static view-only opt-out that
  must sit in the same file as the wizard's own banner
  (`view-only-banner-contract.test.ts`), and splitting it out would need a
  vouching parent for one button. Four more lines give the identity step the
  same Skip every other step has, so a view-only admin can leave it.

file: src/lib/setup-readiness.ts
lines: 2287
reason: the Club Config check now names every active lodge that is not set
  up for bookings, not only the default one (#3407 review). The wording sits
  beside the two branches that share it, inside the one check that owns the
  default-lodge warning; the resolver call itself lives in
  `setup-readiness-db.ts`.

file: src/app/(admin)/admin/book/page.tsx
lines: 1692
reason: two lines. One reads the capacity-settings link through the
  lodge-access-gated hook, so a bookings-only officer is never sent to a page
  that refuses them; one passes it to the calendar's not-set-up notice. The
  link is admin-only, so this page has to choose it; the href and the gate live
  in `src/components/admin/lodge-capacity-settings-link.ts`.

file: src/lib/config-transfer/categories/lodge-config.ts
lines: 1041
reason: the lodge.json `capacity` field's call sites in the export, the
  batch read, the validation, the plan and the apply. The field's rules and
  its write live in `categories/lodge-capacity.ts`; what is left has to sit
  in the per-lodge passes it takes part in, including the preview warning for
  a lodge created without a capacity.

file: src/app/(admin)/admin/lodges/[id]/page.tsx
lines: 631
reason: one import line for `LODGE_CAPACITY_OVERRIDE_FIELD_ID`, so the
  capacity field's id and the not-set-up notice's link to it are one
  definition instead of two strings that had already drifted apart.
