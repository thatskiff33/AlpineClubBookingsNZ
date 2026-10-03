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

file: src/app/api/bookings/[id]/guests/[guestId]/route.ts
lines: 567
reason: the removal's Booking Modified email says whether its refund is a bank
  transfer the club still has to send (D-3813-6); one import and one field
  beside the refund amount it qualifies.

file: src/components/admin/manual-refund-task-queue.tsx
lines: 2143
reason: an edit's refund hand-back is a hand-back row that needs its own
  explaining paragraph, kept out of the cancelled-booking one (D-3813-6); it
  sits beside the other kinds' predicates and paragraphs it is chosen among.

file: src/lib/email/booking.ts
lines: 1768
reason: the Booking Modified sender takes the required bank-transfer flag and
  composes a split payment's cash and credit halves (D-3813-5/6); the sentence
  itself lives in booking-modified-email-copy.ts.

file: src/app/(admin)/admin/refund-requests/page.tsx
lines: 884
reason: the appeal review's ceiling is the approve route's net-of-open-edit-
  refunds figure (INV-PAY-114); the page carries the loaded rows' type and one
  shared helper call, the arithmetic lives in manual-refund-task-settlement-rules.ts.

file: src/app/api/admin/refund-requests/[id]/route.ts
lines: 490
reason: the approval's cap and its claim must share one transaction under
  lock(1) (INV-PAY-114) so the figure checked is the figure approved; moving
  the claim out of the handler would split the #818 single-flight claim from
  the money it guards.

file: src/app/api/bookings/[id]/refund-request/route.ts
lines: 276
reason: the appeal request refuses past the cash net of open edit refunds and
  says plainly when all of it is already being refunded by bank transfer
  (INV-PAY-114); both are refusals beside the existing ones they extend.
