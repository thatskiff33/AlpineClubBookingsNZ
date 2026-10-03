# #3826: a booking's promo redemptions go plural

Every file below grows by the import and the guarded read that route its
former one-to-one promo redemption read through `booking-promo-redemptions.ts`
(epic #3813, child C1). Splitting any of these modules for a one-line import
would be a refactor of its own; the later children of the epic rewrite the
pricing and invoice sites these lines touch.

file: src/app/api/bookings/[id]/guests/route.ts
lines: 1721
reason: the add-guest reprice now reads the booking's one promo redemption through
  soleBookingPromoRedemption (#3826); one import and one guarded read at the
  existing reprice site, which epic #3813 C2 rewrites wholesale.

file: src/app/api/bookings/[id]/modify-quote/route.ts
lines: 2443
reason: the quote preview reads the booking's one promo redemption through
  soleBookingPromoRedemption (#3826); one import and one guarded read where
  the booking is loaded, ahead of epic #3813 C2 widening the preview.

file: src/app/api/member/data-export/route.ts
lines: 396
reason: a member's export must state a booking's promo discount across every code it
  carries (#3826); the small summing helper belongs beside the one export shape
  it serves, not in a shared module nothing else would call.

file: src/lib/booking-batch-modification-service.ts
lines: 2634
reason: one import of bookingPromoCodeLabel for the plural promo read (#3826); the
  two call sites changed in place.

file: src/lib/booking-cancel.ts
lines: 2603
reason: the cancel release now gives back every promo code a booking carries
  (#3826), through the one booking-level release in promo.ts; the existing
  cleanup helper keeps a cheap probe so a booking with no code opens no
  transaction, and its docblock says so.

file: src/lib/booking-create.ts
lines: 2119
reason: the creation email's promo label names every code in application order
  (#3826); a few lines at the one send site that already built it.

file: src/lib/booking-date-modification-service.ts
lines: 2345
reason: the date-change reprice reads the booking's one promo redemption through
  soleBookingPromoRedemption (#3826); one import and one guarded read where the
  booking is loaded, which epic #3813 C2 rewrites.

file: src/lib/booking-delete.ts
lines: 752
reason: the delete audit snapshot must record every redemption a booking carries
  while keeping a single-code snapshot byte-identical (#3826); the small shaping
  helper sits beside the one snapshot it builds.

file: src/lib/booking-guest-removal-service.ts
lines: 1528
reason: the removal reprice reads the booking's one promo redemption through
  soleBookingPromoRedemption (#3826); one import and one guarded read inside
  the existing recalculation, which epic #3813 C2 rewrites.

file: src/lib/booking-modify-plan.ts
lines: 3208
reason: the promo change step reads the booking's one promo redemption through
  soleBookingPromoRedemption (#3826); one import and one guarded read inside
  applyPromoCodeChanges, which epic #3813 C2 rewrites.

file: src/lib/config-transfer/categories/club-settings.ts
lines: 1180
reason: the new multiPromoCodes module key must be classified for config transfer
  (#3826), and the classification and its reason live in this one table.

file: src/lib/promo.ts
lines: 2065
reason: redeemPromoCode now asks the rollout switch before writing, and the plural
  release helpers must sit beside deletePromoRedemptionAndAdjustCount they
  compose (#3826), with the lock-order note that their sort holds per call; the
  switch probe itself moved to promo-redemption-slot.ts.

file: src/lib/waitlist-cross-lodge.ts
lines: 1006
reason: one import of bookingPromoRedemptions for the plural redemption read (#3826).

file: src/lib/waitlist.ts
lines: 1480
reason: one import of bookingPromoRedemptions for the plural redemption read (#3826).

file: src/lib/xero-booking-invoices.ts
lines: 1563
reason: the promo line refuses a multi-code booking until epic #3813 C3 gives each
  code its own line (#3826); one import and a two-line comment at the one site.
