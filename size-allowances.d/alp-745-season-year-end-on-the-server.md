# Size allowances for #5259 (server season year-end)

Each of these already-oversized files or functions now passes the club's
resolved financial year-end to the season derivation it calls, instead of
letting the derivation default to a process cache that answers March until
something seeds it. The growth is the line that resolves or forwards the month
beside the season it already derives; moving it elsewhere would separate a
season from the year-end that defines it, which is the defect being fixed.

file: src/app/api/admin/reports/route.ts
lines: 370
reason: names the current season with `seasonSlashLabel` under the club's
  resolved year-end rather than a hand-written two-year label.

file: src/app/api/bookings/[id]/confirm-draft/route.ts
lines: 432
reason: resolves the year-end once, so the membership-type policy, the
  subscription gate and its refusal judge and name one season.

file: src/app/api/bookings/[id]/guests/[guestId]/route.ts
lines: 564
reason: resolves the year-end before the removal's transaction and hands it to
  the removal service that reprices.

file: src/app/api/bookings/quote/route.ts
lines: 471
reason: resolves the year-end once and derives the season the price and the
  deferred non-member portion are judged in.

file: src/app/api/promo-codes/validate/route.ts
lines: 446
reason: the promo preview prices in the season the club's resolved year-end
  gives the stay.

file: src/lib/booking-create.ts
lines: 2069
reason: the three create services price the stay's season from the year-end
  their caller resolved before any transaction.

file: src/lib/booking-exception-approval.ts
lines: 1256
reason: reuses the year-end in the batch's pre-transaction facts for the
  evaluator and the create.

file: src/lib/booking-guest-removal-service.ts
lines: 1248
reason: the removal reprice and policy check take the year-end the caller
  resolved before the transaction.

file: src/lib/group-booking.ts
lines: 1975
reason: the join paths resolve the year-end once; the refusal names the season
  by it.

file: src/lib/member-guest-consent-service.ts
lines: 1419
reason: the consent expiry and decline reprice take the year-end the sweep or
  request resolved first.

file: src/lib/waitlist-cross-lodge.ts
lines: 1009
reason: the cross-lodge quote and confirm take the year-end resolved once
  before the capacity transaction.

file: src/lib/waitlist.ts
lines: 1375
reason: the offer pass resolves the year-end once, before the capacity
  transaction, for the reprice and the quote.

file: src/lib/xero-membership-sync.ts
lines: 1737
reason: the membership sync resolves the year-end once per run and derives
  each season from it.

function: src/app/api/admin/reports/route.ts#GET
lines: 330
reason: names the current season with `seasonSlashLabel` under the club's
  resolved year-end rather than a hand-written two-year label.

function: src/app/api/bookings/[id]/confirm-draft/route.ts#POST
lines: 372
reason: resolves the year-end once, so the membership-type policy, the
  subscription gate and its refusal judge and name one season.

function: src/app/api/bookings/[id]/guests/[guestId]/route.ts#DELETE
lines: 498
reason: resolves the year-end before the removal's transaction and hands it to
  the removal service that reprices.

function: src/app/api/bookings/quote/route.ts#POST
lines: 403
reason: resolves the year-end once and derives the season the price and the
  deferred non-member portion are judged in.

function: src/app/api/promo-codes/validate/route.ts#POST
lines: 388
reason: the promo preview prices in the season the club's resolved year-end
  gives the stay.

function: src/lib/admin-booking-copy.ts#copyBookingToDraft
lines: 325
reason: resolves the year-end before the create service opens its transaction.

function: src/lib/booking-create.ts#createDraftBooking
lines: 333
reason: the three create services price the stay's season from the year-end
  their caller resolved before any transaction.

function: src/lib/booking-create.ts#createConfirmedBooking
lines: 1117
reason: the three create services price the stay's season from the year-end
  their caller resolved before any transaction.

function: src/lib/booking-create.ts#createWaitlistedBooking
lines: 355
reason: the three create services price the stay's season from the year-end
  their caller resolved before any transaction.

function: src/lib/booking-guest-removal-service.ts#removeBookingGuestInTransaction
lines: 838
reason: the removal reprice and policy check take the year-end the caller
  resolved before the transaction.

function: src/lib/cron-age-up.ts#checkAgeUpMembers
lines: 391
reason: resolves the year-end once per run and dates the season start from it.

function: src/lib/group-booking.ts#joinGroupBookingAsMember
lines: 503
reason: the join paths resolve the year-end once; the refusal names the season
  by it.

function: src/lib/group-booking.ts#verifyAndCreateNonMemberJoin
lines: 479
reason: the join paths resolve the year-end once; the refusal names the season
  by it.

function: src/lib/waitlist-cross-lodge.ts#confirmCrossLodgeWaitlistOffer
lines: 715
reason: the cross-lodge quote and confirm take the year-end resolved once
  before the capacity transaction.

function: src/lib/xero-membership-sync.ts#checkMembershipStatus
lines: 453
reason: the membership sync resolves the year-end once per run and derives
  each season from it.

function: src/lib/xero-membership-sync.ts#refreshAllMembershipStatuses
lines: 308
reason: the membership sync resolves the year-end once per run and derives
  each season from it.
