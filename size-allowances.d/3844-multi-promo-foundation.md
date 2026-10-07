# #3826: a booking's promo redemptions go plural

Every file below grows by the import and the guarded read that route its
former one-to-one promo redemption read through `booking-promo-redemptions.ts`
(epic #3813, child C1). Splitting any of these modules for a one-line import
would be a refactor of its own; the later children of the epic rewrite the
pricing and invoice sites these lines touch.

file: src/app/api/bookings/[id]/modify-quote/route.ts
lines: 2542
reason: the quote preview reads the booking's one promo redemption through
  soleBookingPromoRedemption (#3826); one import and one guarded read where
  the booking is loaded, ahead of epic #3813 C2 widening the preview.
  #3827 then prices every code the booking carries in the preview through the one orchestrator, reading the edit's code list the way the save reads it.
  #3828 (re-measured in place) refuses the one-code fields on a several-code booking through the save's own predicate, and orders that refusal ahead of the removal branch.
  Re-measured at #3829, the final main sync, which composed main's #3653,
  #3809, #3835 and #3792 growth of this file with the epic's.

file: src/app/api/member/data-export/route.ts
lines: 417
reason: a member's export must state a booking's promo discount across every code it
  carries (#3826), and name each code with its own discount (#3828, re-measured
  in place); the small summing helper belongs beside the one export shape
  it serves, not in a shared module nothing else would call.

file: src/lib/booking-batch-modification-service.ts
lines: 2673
reason: one import of bookingPromoCodeLabel for the plural promo read (#3826); the
  two call sites changed in place.
  #3827 reads the request's code list through its own reader.
  Re-measured at #3829, the final main sync, which composed main's #3653,
  #3809, #3835 and #3792 growth of this file with the epic's.

file: src/lib/booking-cancel.ts
lines: 2802
reason: the cancel release now gives back every promo code a booking carries
  (#3826), through the one booking-level release in promo.ts; the existing
  cleanup helper keeps a cheap probe so a booking with no code opens no
  transaction, and its docblock says so. #3827 then hands the paid cancel's
  money calculation the open edit refund hand-backs it must not refund twice
  (`INV-PAY-117`): one import and one argument read under the claim's lock.
  Re-measured at #3829, the final main sync, which composed main's #3653,
  #3809, #3835 and #3792 growth of this file with the epic's.

file: src/lib/booking-delete.ts
lines: 747
reason: the delete audit snapshot must record every redemption a booking carries
  while keeping a single-code snapshot byte-identical (#3826); the small shaping
  helper sits beside the one snapshot it builds.
  Re-measured at #3829, the final main sync, which composed main's #3653,
  #3809, #3835 and #3792 growth of this file with the epic's.

file: src/lib/booking-modify-plan.ts
lines: 3267
reason: the promo change step reads the booking's one promo redemption through
  soleBookingPromoRedemption (#3826); one import and one guarded read inside
  applyPromoCodeChanges, which epic #3813 C2 rewrites.
  #3827 then rewrites applyPromoCodeChanges to add, remove and reorder codes through the one orchestrator, and shares the proposed party's consent reader with it.
  #3828 (re-measured in place) refuses the one-code fields on a several-code booking there, before any lock or write; the predicate lives in booking-modify-promo-request.ts.

file: src/lib/config-transfer/categories/club-settings.ts
lines: 1182
reason: the new multiPromoCodes module key must be classified for config transfer
  (#3826), and the classification and its reason live in this one table.

file: src/lib/waitlist-cross-lodge.ts
lines: 1006
reason: one import of bookingPromoRedemptions for the plural redemption read (#3826).

file: src/lib/waitlist.ts
lines: 1482
reason: one import of bookingPromoRedemptions for the plural redemption read (#3826).
  #3827 hands each guest's consent to the promo re-price.

file: src/lib/xero-booking-invoices.ts
lines: 1550
reason: the promo line refused a multi-code booking until epic #3813 C3 gave each
  code its own line (#3826); #3828 re-measured it in place after moving the line
  into xero-promo-adjustment-lines.ts.
  Re-measured at #3829, the final main sync, which composed main's #3653,
  #3809, #3835 and #3792 growth of this file with the epic's.
