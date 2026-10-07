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
lines: 1869
reason: the create request accepts the booker's code list beside the legacy single
  code, refuses both at once, and runs the pre-lookup refusals for every code
  (#3770's shape); the ordering itself lives in booking-create-promo.ts.

file: src/app/api/promo-codes/validate/route.ts
lines: 532
reason: the preview accepts a code list, works out which guests await acceptance
  through the create's own consent planner, and prices its single code through
  the one orchestrator; the several-code half is in promo-codes-preview.ts,
  leaving only the schema and the hand-off here. Re-measured for #3492 (C4,
  PR #3895): an edit preview names its booking (owner-checked through the
  shared `bookingForPromoLookup`, one 404 for unowned and missing) and each
  guest's row, and the guests already on the booking are judged by their stored
  consent beside the planner's answer for the others — a stored row counting
  only for the member on it, so a borrowed row id cannot make another member
  present; that choice belongs in the one place the preview decides consent.

file: src/lib/member-guest-consent-service.ts
lines: 1349
reason: an acceptance re-prices the booking's codes inside the consent transaction
  that already holds the locks it needs (D-3813-4), and its after-commit half
  runs from the one finalise step; the re-price itself is in
  booking-guest-acceptance-reprice.ts.
  Re-measured at #3829, the final main sync, which composed main's #3653,
  #3809, #3835 and #3792 growth of this file with the epic's.

file: src/app/api/bookings/[id]/guests/[guestId]/route.ts
lines: 548
reason: the removal's Booking Modified email says whether its refund is a bank
  transfer the club still has to send (D-3813-6); one import and one field
  beside the refund amount it qualifies.
  Re-measured at #3829, the final main sync, which composed main's #3653,
  #3809, #3835 and #3792 growth of this file with the epic's.

file: src/lib/email/booking.ts
lines: 1787
reason: the Booking Modified sender takes the required bank-transfer flag and
  composes a split payment's cash and credit halves (D-3813-5/6); the sentence
  itself lives in booking-modified-email-copy.ts. Re-measured when epic #3813's
  C3 (#3828) merged in, which adds its own reason: the booking-confirmed
  sender's options gain each code's own adjustment (promoLines) and hand it to
  the one shared promo-rows builder; the option belongs beside promoCode on the
  sender it configures, typed by the one PromoCodeAdjustment import.
  Re-measured at #3829, the final main sync, which composed main's #3653,
  #3809, #3835 and #3792 growth of this file with the epic's.

file: src/app/(admin)/admin/refund-requests/page.tsx
lines: 884
reason: the appeal review's ceiling is the approve route's net-of-open-edit-
  refunds figure (INV-PAY-117); the page carries the loaded rows' type and one
  shared helper call, the arithmetic lives in manual-refund-task-settlement-rules.ts.

file: src/app/api/admin/refund-requests/[id]/route.ts
lines: 610
reason: the approval's cap and its claim must share one transaction under
  lock(1) (INV-PAY-117) so the figure checked is the figure approved; moving
  the claim out of the handler would split the #818 single-flight claim from
  the money it guards. D-3813-7 (INV-PAY-118) plans the card refund and
  raises the bank-transfer task in that same transaction, and a released
  claim takes its task with it under the same lock. Only an internet-banking
  payment raises one (a card shortfall stays logged drift), and a task that
  cannot be raised rolls the claim back - both decided inside that same
  transaction, so they cannot move out of it either.

file: src/app/api/bookings/[id]/refund-request/route.ts
lines: 283
reason: the appeal request refuses past the cash net of open hand-backs and
  late-cash credit and says plainly when all of it is already being returned
  (INV-PAY-117, INV-PAY-118); both are refusals beside the existing ones they
  extend.

file: src/lib/email-message-registry.ts
lines: 2199
reason: the approved appeal's email names how the refund comes back (D-3813-7);
  its composed {{refundSentence}} token is registered, sampled, required (so
  an override saved from the old card-only wording is flagged) and kept beside
  {{amount}} for saved overrides, in the one registry every template token
  lives in.

file: src/lib/email-message-renderer.ts
lines: 952
reason: a required token needs its plain-English guidance in the one table the
  validator reads (REQUIRED_TOKEN_GUIDANCE); {{refundSentence}} became required
  for the approved-appeal email (#3827, D-3813-7), so its sentence joins the
  two already there rather than living in a second table.

file: src/lib/xero-credit-notes.ts
lines: 1266
reason: owner decision D-3813-8 (INV-PAY-118) - the refund-note builder raises
  a refund request's own note: keyed by the request, linked under its own role,
  never per-delta and never the payment's pointer. Those are branches inside
  the one builder every refund note goes through (its #3548 crash-window
  recording, settlement and completion), so a second builder would fork that.

file: src/lib/xero-operation-outbox.ts
lines: 3282
reason: the refund-note dispatch passes the request id through (D-3813-8); the
  enqueue itself lives in xero-refund-request-credit-note-outbox.ts.

file: src/lib/xero-sync.ts
lines: 1029
reason: findCanonicalPaymentRefundCreditNote leaves refund-request notes out of
  its fallbacks (D-3813-8) so a cancellation's note is never absorbed into a
  request's; the exclusion belongs in the one finder every reader uses.
