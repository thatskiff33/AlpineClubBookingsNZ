# #3827: several promo codes priced on one booking

The pricing itself lives in new modules (`booking-promotions.ts`,
`booking-guest-acceptance-reprice.ts`, `promo-codes-preview.ts`,
`booking-modify-promo-request.ts`); these doors grow only by what wires them
to it.

file: src/app/api/bookings/[id]/modify/route.ts
lines: 555
reason: the edit request accepts the booker's code list (promoCodes) through the
  schema the preview shares, and lists it among the fields a date-only override
  refuses; both belong beside the fields they extend.

file: src/app/api/bookings/route.ts
lines: 1870
reason: the create request accepts the booker's code list beside the legacy single
  code, refuses both at once, and runs the pre-lookup refusals for every code
  (#3770's shape); the ordering itself lives in booking-create-promo.ts.

file: src/app/api/promo-codes/validate/route.ts
lines: 483
reason: the preview accepts a code list, works out which guests await acceptance
  through the create's own consent planner, and prices its single code through
  the one orchestrator; the several-code half is in promo-codes-preview.ts,
  leaving only the schema and the hand-off here.

file: src/lib/member-guest-consent-service.ts
lines: 1313
reason: an acceptance re-prices the booking's codes inside the consent transaction
  that already holds the locks it needs (D-3813-4), and its after-commit half
  runs from the one finalise step; the re-price itself is in
  booking-guest-acceptance-reprice.ts.
