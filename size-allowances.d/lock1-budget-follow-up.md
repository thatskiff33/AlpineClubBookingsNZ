# File-size allowances for the INV-LOCK-005 follow-up to #4933

Every lock(1) transaction now runs on `LOCK1_HOLDER_TRANSACTION_BUDGET` and its
route answers contention as a retryable 503. The response itself lives once in
`src/lib/transaction-contended-response.ts`; what each file below gains is the
call or the budget argument, which has to sit at the site. Files that would have
crossed their budget for the first time were tightened instead, so every entry
here was already over its budget on `main`.

file: src/app/api/admin/booking-exception-requests/[id]/route.ts
lines: 837
reason: the INV-LOCK-005 contention answer: a transactionContendedResponse call and
  its import in this route's own catch, ordered against the route's other error
  answers (captured-payment and committed-step recovery answers stay first).
  Moving it out would split one route's error mapping across two files.

file: src/app/api/admin/bookings/[id]/confirm-pending-guests/route.ts
lines: 981
reason: the INV-LOCK-005 contention answer: a transactionContendedResponse call and
  its import in this route's own catch, ordered against the route's other error
  answers (captured-payment and committed-step recovery answers stay first).
  Moving it out would split one route's error mapping across two files.

file: src/app/api/admin/bookings/[id]/exclusive-hold/route.ts
lines: 432
reason: the INV-LOCK-005 contention answer: a transactionContendedResponse call and
  its import in this route's own catch, ordered against the route's other error
  answers (captured-payment and committed-step recovery answers stay first).
  Moving it out would split one route's error mapping across two files.

file: src/app/api/admin/bookings/[id]/force-confirm/route.ts
lines: 380
reason: the INV-LOCK-005 contention answer: a transactionContendedResponse call and
  its import in this route's own catch, ordered against the route's other error
  answers (captured-payment and committed-step recovery answers stay first).
  Moving it out would split one route's error mapping across two files.

file: src/app/api/admin/bookings/[id]/mark-paid/route.ts
lines: 265
reason: the INV-LOCK-005 contention answer: a transactionContendedResponse call and
  its import in this route's own catch, ordered against the route's other error
  answers (captured-payment and committed-step recovery answers stay first).
  Moving it out would split one route's error mapping across two files.

file: src/app/api/admin/bookings/[id]/review/route.ts
lines: 379
reason: the INV-LOCK-005 contention answer: a transactionContendedResponse call and
  its import in this route's own catch, ordered against the route's other error
  answers (captured-payment and committed-step recovery answers stay first).
  Moving it out would split one route's error mapping across two files.

file: src/app/api/admin/deletion-requests/[id]/route.ts
lines: 1324
reason: the INV-LOCK-005 contention answer: a transactionContendedResponse call and
  its import in this route's own catch, ordered against the route's other error
  answers (captured-payment and committed-step recovery answers stay first).
  Moving it out would split one route's error mapping across two files.

file: src/app/api/admin/hut-leaders/route.ts
lines: 467
reason: the INV-LOCK-005 contention answer: a transactionContendedResponse call and
  its import in this route's own catch, ordered against the route's other error
  answers (captured-payment and committed-step recovery answers stay first).
  Moving it out would split one route's error mapping across two files.

file: src/app/api/admin/members/[id]/xero-push/route.ts
lines: 398
reason: the INV-LOCK-005 contention answer: a transactionContendedResponse call and
  its import in this route's own catch, ordered against the route's other error
  answers (captured-payment and committed-step recovery answers stay first).
  Moving it out would split one route's error mapping across two files.

file: src/app/api/admin/members/bulk-update/route.ts
lines: 759
reason: the INV-LOCK-005 contention answer: a transactionContendedResponse call and
  its import in this route's own catch, ordered against the route's other error
  answers (captured-payment and committed-step recovery answers stay first).
  Moving it out would split one route's error mapping across two files.

file: src/app/api/admin/refund-requests/[id]/route.ts
lines: 761
reason: the INV-LOCK-005 contention answer: a transactionContendedResponse call and
  its import in this route's own catch, ordered against the route's other error
  answers (captured-payment and committed-step recovery answers stay first).
  Moving it out would split one route's error mapping across two files.

file: src/app/api/admin/xero/force-sync/route.ts
lines: 349
reason: the INV-LOCK-005 contention answer: a transactionContendedResponse call and
  its import in this route's own catch, ordered against the route's other error
  answers (captured-payment and committed-step recovery answers stay first).
  Moving it out would split one route's error mapping across two files.

file: src/app/api/bookings/[id]/confirm-draft/route.ts
lines: 427
reason: the INV-LOCK-005 contention answer: a transactionContendedResponse call and
  its import in this route's own catch, ordered against the route's other error
  answers (captured-payment and committed-step recovery answers stay first).
  Moving it out would split one route's error mapping across two files.

file: src/app/api/bookings/[id]/confirm-payment/route.ts
lines: 372
reason: the INV-LOCK-005 contention answer: a transactionContendedResponse call and
  its import in this route's own catch, ordered against the route's other error
  answers (captured-payment and committed-step recovery answers stay first).
  Moving it out would split one route's error mapping across two files.

file: src/app/api/bookings/[id]/exception-requests/route.ts
lines: 338
reason: the INV-LOCK-005 contention answer: a transactionContendedResponse call and
  its import in this route's own catch, ordered against the route's other error
  answers (captured-payment and committed-step recovery answers stay first).
  Moving it out would split one route's error mapping across two files.

file: src/app/api/bookings/[id]/guests/[guestId]/route.ts
lines: 561
reason: the INV-LOCK-005 contention answer: a transactionContendedResponse call and
  its import in this route's own catch, ordered against the route's other error
  answers (captured-payment and committed-step recovery answers stay first).
  Moving it out would split one route's error mapping across two files.

file: src/app/api/bookings/[id]/guests/route.ts
lines: 1603
reason: the INV-LOCK-005 contention answer: a transactionContendedResponse call and
  its import in this route's own catch, ordered against the route's other error
  answers (captured-payment and committed-step recovery answers stay first).
  Moving it out would split one route's error mapping across two files.

file: src/app/api/bookings/[id]/modify-dates/route.ts
lines: 391
reason: the INV-LOCK-005 contention answer: a transactionContendedResponse call and
  its import in this route's own catch, ordered against the route's other error
  answers (captured-payment and committed-step recovery answers stay first).
  Moving it out would split one route's error mapping across two files.

file: src/app/api/bookings/[id]/modify/route.ts
lines: 566
reason: the INV-LOCK-005 contention answer: a transactionContendedResponse call and
  its import in this route's own catch, ordered against the route's other error
  answers (captured-payment and committed-step recovery answers stay first).
  Moving it out would split one route's error mapping across two files.

file: src/app/api/bookings/[id]/waitlist-confirm/route.ts
lines: 589
reason: the INV-LOCK-005 contention answer: a transactionContendedResponse call and
  its import in this route's own catch, ordered against the route's other error
  answers (captured-payment and committed-step recovery answers stay first).
  Moving it out would split one route's error mapping across two files.

file: src/app/api/bookings/route.ts
lines: 1898
reason: #4933's contention answer on the draft, confirmed and waitlist paths of
  booking create, each in its own catch ahead of the path's other error
  answers. The shared helper already holds the response; what stays is the call.

file: src/app/api/payments/charge-saved-method/route.ts
lines: 699
reason: the INV-LOCK-005 contention answer: a transactionContendedResponse call and
  its import in this route's own catch, ordered against the route's other error
  answers (captured-payment and committed-step recovery answers stay first).
  Moving it out would split one route's error mapping across two files.

file: src/app/api/payments/create-payment-intent/route.ts
lines: 936
reason: the INV-LOCK-005 contention answer: a transactionContendedResponse call and
  its import in this route's own catch, ordered against the route's other error
  answers (captured-payment and committed-step recovery answers stay first).
  Moving it out would split one route's error mapping across two files.

file: src/app/api/payments/switch-to-internet-banking/route.ts
lines: 571
reason: the INV-LOCK-005 contention answer: a transactionContendedResponse call and
  its import in this route's own catch, ordered against the route's other error
  answers (captured-payment and committed-step recovery answers stay first).
  Moving it out would split one route's error mapping across two files.

file: src/lib/admin-member-detail-service.ts
lines: 1773
reason: the INV-LOCK-005 budget on this service's transactions plus a contention
  rethrow in its own catch, which otherwise reported P2028 as a failure. The
  rethrow has to sit in the catch it escapes from; there is no seam to move it to.

file: src/lib/admin-roster-service.ts
lines: 844
reason: the INV-LOCK-005 budget on this service's transactions plus a contention
  rethrow in its own catch, which otherwise reported P2028 as a failure. The
  rethrow has to sit in the catch it escapes from; there is no seam to move it to.

file: src/lib/bed-allocation-lifecycle.ts
lines: 2594
reason: one import of LOCK1_HOLDER_TRANSACTION_BUDGET (INV-LOCK-005). The budget
  must be written at the transaction call so the budget census can read it, and
  a wrapper would hide it from that census; the module already exceeded its budget.

file: src/lib/bed-allocation-move.ts
lines: 1442
reason: one import of LOCK1_HOLDER_TRANSACTION_BUDGET (INV-LOCK-005). The budget
  must be written at the transaction call so the budget census can read it, and
  a wrapper would hide it from that census; the module already exceeded its budget.

file: src/lib/bed-allocation-removal.ts
lines: 793
reason: one import of LOCK1_HOLDER_TRANSACTION_BUDGET (INV-LOCK-005). The budget
  must be written at the transaction call so the budget census can read it, and
  a wrapper would hide it from that census; the module already exceeded its budget.

file: src/lib/booking-cancel.ts
lines: 2873
reason: one import of LOCK1_HOLDER_TRANSACTION_BUDGET (INV-LOCK-005). The budget
  must be written at the transaction call so the budget census can read it, and
  a wrapper would hide it from that census; the module already exceeded its budget.

file: src/lib/booking-create.ts
lines: 2080
reason: #4933's budget on the draft and confirmed create transactions, with the
  two comments saying why the defaults lost and that a caller's tx keeps its
  own budget. Both belong at the transaction call, where the census reads them.

file: src/lib/booking-date-modification-service.ts
lines: 2264
reason: one import of LOCK1_HOLDER_TRANSACTION_BUDGET (INV-LOCK-005). The budget
  must be written at the transaction call so the budget census can read it, and
  a wrapper would hide it from that census; the module already exceeded its budget.

file: src/lib/booking-delete.ts
lines: 754
reason: one import of LOCK1_HOLDER_TRANSACTION_BUDGET (INV-LOCK-005). The budget
  must be written at the transaction call so the budget census can read it, and
  a wrapper would hide it from that census; the module already exceeded its budget.

file: src/lib/booking-exception-execution.ts
lines: 1036
reason: one import of LOCK1_HOLDER_TRANSACTION_BUDGET (INV-LOCK-005). The budget
  must be written at the transaction call so the budget census can read it, and
  a wrapper would hide it from that census; the module already exceeded its budget.

file: src/lib/booking-exception-request-service.ts
lines: 2488
reason: one import of LOCK1_HOLDER_TRANSACTION_BUDGET (INV-LOCK-005). The budget
  must be written at the transaction call so the budget census can read it, and
  a wrapper would hide it from that census; the module already exceeded its budget.

file: src/lib/booking-request-quotes.ts
lines: 2234
reason: one import of LOCK1_HOLDER_TRANSACTION_BUDGET (INV-LOCK-005). The budget
  must be written at the transaction call so the budget census can read it, and
  a wrapper would hide it from that census; the module already exceeded its budget.

file: src/lib/booking-request.ts
lines: 3101
reason: one import of LOCK1_HOLDER_TRANSACTION_BUDGET (INV-LOCK-005). The budget
  must be written at the transaction call so the budget census can read it, and
  a wrapper would hide it from that census; the module already exceeded its budget.

file: src/lib/cron-confirm-pending.ts
lines: 2047
reason: one import of LOCK1_HOLDER_TRANSACTION_BUDGET (INV-LOCK-005). The budget
  must be written at the transaction call so the budget census can read it, and
  a wrapper would hide it from that census; the module already exceeded its budget.

file: src/lib/cron-group-settlement-reaper.ts
lines: 1068
reason: one import of LOCK1_HOLDER_TRANSACTION_BUDGET (INV-LOCK-005). The budget
  must be written at the transaction call so the budget census can read it, and
  a wrapper would hide it from that census; the module already exceeded its budget.

file: src/lib/deleted-booking-modification-payment.ts
lines: 745
reason: one import of LOCK1_HOLDER_TRANSACTION_BUDGET (INV-LOCK-005). The budget
  must be written at the transaction call so the budget census can read it, and
  a wrapper would hide it from that census; the module already exceeded its budget.

file: src/lib/group-booking.ts
lines: 1969
reason: one import of LOCK1_HOLDER_TRANSACTION_BUDGET (INV-LOCK-005). The budget
  must be written at the transaction call so the budget census can read it, and
  a wrapper would hide it from that census; the module already exceeded its budget.

file: src/lib/group-cancel.ts
lines: 1072
reason: one import of LOCK1_HOLDER_TRANSACTION_BUDGET (INV-LOCK-005). The budget
  must be written at the transaction call so the budget census can read it, and
  a wrapper would hide it from that census; the module already exceeded its budget.

file: src/lib/group-settlement.ts
lines: 1685
reason: one import of LOCK1_HOLDER_TRANSACTION_BUDGET (INV-LOCK-005). The budget
  must be written at the transaction call so the budget census can read it, and
  a wrapper would hide it from that census; the module already exceeded its budget.

file: src/lib/member-guest-consent-service.ts
lines: 1408
reason: one import of LOCK1_HOLDER_TRANSACTION_BUDGET (INV-LOCK-005). The budget
  must be written at the transaction call so the budget census can read it, and
  a wrapper would hide it from that census; the module already exceeded its budget.

file: src/lib/member-partner-link.ts
lines: 1567
reason: one import of LOCK1_HOLDER_TRANSACTION_BUDGET (INV-LOCK-005). The budget
  must be written at the transaction call so the budget census can read it, and
  a wrapper would hide it from that census; the module already exceeded its budget.

file: src/lib/payment-reconciliation.ts
lines: 2887
reason: one import of LOCK1_HOLDER_TRANSACTION_BUDGET (INV-LOCK-005). The budget
  must be written at the transaction call so the budget census can read it, and
  a wrapper would hide it from that census; the module already exceeded its budget.

file: src/lib/school-booking-request.ts
lines: 3231
reason: one import of LOCK1_HOLDER_TRANSACTION_BUDGET (INV-LOCK-005). The budget
  must be written at the transaction call so the budget census can read it, and
  a wrapper would hide it from that census; the module already exceeded its budget.

file: src/lib/seasonal-membership-assignments.ts
lines: 1736
reason: one import of LOCK1_HOLDER_TRANSACTION_BUDGET (INV-LOCK-005). The budget
  must be written at the transaction call so the budget census can read it, and
  a wrapper would hide it from that census; the module already exceeded its budget.

file: src/lib/waitlist-cross-lodge.ts
lines: 1019
reason: the INV-LOCK-005 budget on this service's transactions plus a contention
  rethrow in its own catch, which otherwise reported P2028 as a failure. The
  rethrow has to sit in the catch it escapes from; there is no seam to move it to.

file: src/lib/waitlist.ts
lines: 1486
reason: the INV-LOCK-005 budget on this service's transactions plus a contention
  rethrow in its own catch, which otherwise reported P2028 as a failure. The
  rethrow has to sit in the catch it escapes from; there is no seam to move it to.

file: src/lib/xero-inbound/invoice-paid-effects.ts
lines: 2105
reason: one import of LOCK1_HOLDER_TRANSACTION_BUDGET (INV-LOCK-005). The budget
  must be written at the transaction call so the budget census can read it, and
  a wrapper would hide it from that census; the module already exceeded its budget.
