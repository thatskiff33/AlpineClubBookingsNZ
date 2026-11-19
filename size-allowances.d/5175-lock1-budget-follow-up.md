# File-size allowances for the INV-LOCK-006 follow-up to #4933

Every lock(1) transaction now runs on `LOCK1_HOLDER_TRANSACTION_BUDGET` and its
route answers contention as a retryable 503. The response itself lives once in
`src/lib/transaction-contended-response.ts`; what each file below gains is the
call or the budget argument, which has to sit at the site. Files that would have
crossed their budget for the first time were tightened instead, so every entry
here was already over its budget on `main`.

A file already past three times its budget on `main` cannot take an allowance
(#5145). Each of those moved a schema, type, error class or pure helper into a
sibling module instead, so it ends no longer than it is on `main` and has no
entry here.

file: src/app/api/admin/bookings/[id]/exclusive-hold/route.ts
lines: 432
reason: the INV-LOCK-006 contention answer: a transactionContendedResponse call and
  its import in this route's own catch, ordered against the route's other error
  answers (captured-payment and committed-step recovery answers stay first).
  Moving it out would split one route's error mapping across two files.

file: src/app/api/admin/bookings/[id]/force-confirm/route.ts
lines: 380
reason: the INV-LOCK-006 contention answer: a transactionContendedResponse call and
  its import in this route's own catch, ordered against the route's other error
  answers (captured-payment and committed-step recovery answers stay first).
  Moving it out would split one route's error mapping across two files.

file: src/app/api/admin/bookings/[id]/mark-paid/route.ts
lines: 265
reason: the INV-LOCK-006 contention answer: a transactionContendedResponse call and
  its import in this route's own catch, ordered against the route's other error
  answers (captured-payment and committed-step recovery answers stay first).
  Moving it out would split one route's error mapping across two files.

file: src/app/api/admin/bookings/[id]/review/route.ts
lines: 398
reason: the INV-LOCK-006 contention answers: the review claim's catch, and a
  helper for the cancellation after a committed rejection that keeps the
  reviewRecorded facts on its 503. Moving them out would split one route's
  error mapping across two files.

file: src/app/api/admin/hut-leaders/route.ts
lines: 468
reason: the INV-LOCK-006 contention answer: a transactionContendedResponse call and
  its import in this route's own catch, ordered against the route's other error
  answers (captured-payment and committed-step recovery answers stay first).
  Moving it out would split one route's error mapping across two files.

file: src/app/api/admin/members/[id]/xero-push/route.ts
lines: 397
reason: the INV-LOCK-006 contention answer: a transactionContendedResponse call and
  its import in this route's own catch, ordered against the route's other error
  answers (captured-payment and committed-step recovery answers stay first).
  Moving it out would split one route's error mapping across two files.

file: src/app/api/admin/members/bulk-update/route.ts
lines: 746
reason: the INV-LOCK-006 contention answer: a transactionContendedResponse call and
  its import in this route's own catch, ordered against the route's other error
  answers (captured-payment and committed-step recovery answers stay first).
  Moving it out would split one route's error mapping across two files.

file: src/app/api/admin/xero/force-sync/route.ts
lines: 346
reason: the INV-LOCK-006 contention answer: a transactionContendedResponse call and
  its import in this route's own catch, ordered against the route's other error
  answers (captured-payment and committed-step recovery answers stay first).
  Moving it out would split one route's error mapping across two files.

file: src/app/api/bookings/[id]/confirm-draft/route.ts
lines: 427
reason: the INV-LOCK-006 contention answer: a transactionContendedResponse call and
  its import in this route's own catch, ordered against the route's other error
  answers (captured-payment and committed-step recovery answers stay first).
  Moving it out would split one route's error mapping across two files.

file: src/app/api/bookings/[id]/confirm-payment/route.ts
lines: 372
reason: the INV-LOCK-006 contention answer: a transactionContendedResponse call and
  its import in this route's own catch, ordered against the route's other error
  answers (captured-payment and committed-step recovery answers stay first).
  Moving it out would split one route's error mapping across two files.

file: src/app/api/bookings/[id]/exception-requests/route.ts
lines: 338
reason: the INV-LOCK-006 contention answer: a transactionContendedResponse call and
  its import in this route's own catch, ordered against the route's other error
  answers (captured-payment and committed-step recovery answers stay first).
  Moving it out would split one route's error mapping across two files.

file: src/app/api/bookings/[id]/guests/[guestId]/route.ts
lines: 559
reason: the INV-LOCK-006 contention answer: a transactionContendedResponse call and
  its import in this route's own catch, ordered against the route's other error
  answers (captured-payment and committed-step recovery answers stay first).
  Moving it out would split one route's error mapping across two files.

file: src/app/api/bookings/[id]/modify-dates/route.ts
lines: 395
reason: the INV-LOCK-006 contention answer: a transactionContendedResponse call and
  its import in this route's own catch, ordered against the route's other error
  answers (captured-payment and committed-step recovery answers stay first).
  Moving it out would split one route's error mapping across two files.

file: src/app/api/bookings/[id]/modify/route.ts
lines: 442
reason: the INV-LOCK-006 contention answer: a transactionContendedResponse call and
  its import in this route's own catch, ordered against the route's other error
  answers (captured-payment and committed-step recovery answers stay first).
  Moving it out would split one route's error mapping across two files.

file: src/app/api/bookings/[id]/waitlist-confirm/route.ts
lines: 589
reason: the INV-LOCK-006 contention answer: a transactionContendedResponse call and
  its import in this route's own catch, ordered against the route's other error
  answers (captured-payment and committed-step recovery answers stay first).
  Moving it out would split one route's error mapping across two files.

file: src/app/api/payments/charge-saved-method/route.ts
lines: 689
reason: the INV-LOCK-006 contention answer: a transactionContendedResponse call and
  its import in this route's own catch, ordered against the route's other error
  answers (captured-payment and committed-step recovery answers stay first).
  Moving it out would split one route's error mapping across two files.

file: src/app/api/payments/switch-to-internet-banking/route.ts
lines: 571
reason: the INV-LOCK-006 contention answer: a transactionContendedResponse call and
  its import in this route's own catch, ordered against the route's other error
  answers (captured-payment and committed-step recovery answers stay first).
  Moving it out would split one route's error mapping across two files.

file: src/lib/admin-member-detail-service.ts
lines: 1773
reason: the INV-LOCK-006 budget on this service's transactions plus a contention
  rethrow in its own catch, which otherwise reported P2028 as a failure. The
  rethrow has to sit in the catch it escapes from; there is no seam to move it to.

file: src/lib/admin-roster-service.ts
lines: 844
reason: the INV-LOCK-006 budget on this service's transactions plus a contention
  rethrow in its own catch, which otherwise reported P2028 as a failure. The
  rethrow has to sit in the catch it escapes from; there is no seam to move it to.

file: src/lib/bed-allocation-move.ts
lines: 1442
reason: one import of LOCK1_HOLDER_TRANSACTION_BUDGET (INV-LOCK-006). The budget
  must be written at the transaction call so the budget census can read it, and
  a wrapper would hide it from that census; the module already exceeded its budget.

file: src/lib/bed-allocation-removal.ts
lines: 793
reason: one import of LOCK1_HOLDER_TRANSACTION_BUDGET (INV-LOCK-006). The budget
  must be written at the transaction call so the budget census can read it, and
  a wrapper would hide it from that census; the module already exceeded its budget.

file: src/lib/booking-delete.ts
lines: 754
reason: one import of LOCK1_HOLDER_TRANSACTION_BUDGET (INV-LOCK-006). The budget
  must be written at the transaction call so the budget census can read it, and
  a wrapper would hide it from that census; the module already exceeded its budget.

file: src/lib/booking-exception-execution.ts
lines: 1036
reason: one import of LOCK1_HOLDER_TRANSACTION_BUDGET (INV-LOCK-006). The budget
  must be written at the transaction call so the budget census can read it, and
  a wrapper would hide it from that census; the module already exceeded its budget.

file: src/lib/cron-confirm-pending.ts
lines: 2008
reason: one import of LOCK1_HOLDER_TRANSACTION_BUDGET (INV-LOCK-006). The budget
  must be written at the transaction call so the budget census can read it, and
  a wrapper would hide it from that census; the module already exceeded its budget.

file: src/lib/cron-group-settlement-reaper.ts
lines: 1068
reason: one import of LOCK1_HOLDER_TRANSACTION_BUDGET (INV-LOCK-006). The budget
  must be written at the transaction call so the budget census can read it, and
  a wrapper would hide it from that census; the module already exceeded its budget.

file: src/lib/deleted-booking-modification-payment.ts
lines: 745
reason: one import of LOCK1_HOLDER_TRANSACTION_BUDGET (INV-LOCK-006). The budget
  must be written at the transaction call so the budget census can read it, and
  a wrapper would hide it from that census; the module already exceeded its budget.

file: src/lib/group-booking.ts
lines: 1968
reason: one import of LOCK1_HOLDER_TRANSACTION_BUDGET (INV-LOCK-006). The budget
  must be written at the transaction call so the budget census can read it, and
  a wrapper would hide it from that census; the module already exceeded its budget.

file: src/lib/group-cancel.ts
lines: 1133
reason: one import of LOCK1_HOLDER_TRANSACTION_BUDGET (INV-LOCK-006). The budget
  must be written at the transaction call so the budget census can read it, and
  a wrapper would hide it from that census; the module already exceeded its budget.

file: src/lib/member-guest-consent-service.ts
lines: 1408
reason: one import of LOCK1_HOLDER_TRANSACTION_BUDGET (INV-LOCK-006). The budget
  must be written at the transaction call so the budget census can read it, and
  a wrapper would hide it from that census; the module already exceeded its budget.

file: src/lib/member-partner-link.ts
lines: 1567
reason: one import of LOCK1_HOLDER_TRANSACTION_BUDGET (INV-LOCK-006). The budget
  must be written at the transaction call so the budget census can read it, and
  a wrapper would hide it from that census; the module already exceeded its budget.

file: src/lib/seasonal-membership-assignments.ts
lines: 1955
reason: one import of LOCK1_HOLDER_TRANSACTION_BUDGET (INV-LOCK-006). The budget
  must be written at the transaction call so the budget census can read it, and
  a wrapper would hide it from that census; the module already exceeded its budget.

file: src/lib/waitlist-cross-lodge.ts
lines: 1019
reason: the INV-LOCK-006 budget on this service's transactions plus a contention
  rethrow in its own catch, which otherwise reported P2028 as a failure. The
  rethrow has to sit in the catch it escapes from; there is no seam to move it to.

file: src/lib/waitlist.ts
lines: 1486
reason: the INV-LOCK-006 budget on this service's transactions plus a contention
  rethrow in its own catch, which otherwise reported P2028 as a failure. The
  rethrow has to sit in the catch it escapes from; there is no seam to move it to.

## Function allowances

The function-length ratchet (#4927) judges the same growth one level down. Each
function below was already over 300 lines on `main`; what it gains is the same
contention answer or budget argument as its file, at the site that needs it.

function: src/app/api/admin/booking-exception-requests/[id]/route.ts#PATCH
lines: 487
reason: the INV-LOCK-006 contention answer sits in this handler's own catch,
  ordered against its other error answers; lifting the catch out is the
  handler split its own issue has to plan.

function: src/app/api/admin/bookings/[id]/exclusive-hold/route.ts#POST
lines: 381
reason: the INV-LOCK-006 contention answer sits in this handler's own catch,
  ordered against its other error answers; lifting the catch out is the
  handler split its own issue has to plan.

function: src/app/api/admin/bookings/[id]/force-confirm/route.ts#POST
lines: 334
reason: the INV-LOCK-006 contention answer sits in this handler's own catch,
  ordered against its other error answers; lifting the catch out is the
  handler split its own issue has to plan.

function: src/app/api/admin/deletion-requests/[id]/route.ts#POST
lines: 1036
reason: the INV-LOCK-006 contention answer sits in this handler's own catch,
  ordered against its other error answers; lifting the catch out is the
  handler split its own issue has to plan.

function: src/app/api/admin/hut-leaders/route.ts#POST
lines: 336
reason: the INV-LOCK-006 contention answer sits in this handler's own catch,
  ordered against its other error answers; lifting the catch out is the
  handler split its own issue has to plan.

function: src/app/api/admin/members/[id]/xero-push/route.ts#POST
lines: 333
reason: the INV-LOCK-006 contention answer sits in this handler's own catch,
  ordered against its other error answers; lifting the catch out is the
  handler split its own issue has to plan.

function: src/app/api/admin/members/bulk-update/route.ts#POST
lines: 676
reason: the INV-LOCK-006 contention answer sits in this handler's own catch,
  ordered against its other error answers; lifting the catch out is the
  handler split its own issue has to plan.

function: src/app/api/bookings/[id]/confirm-draft/route.ts#POST
lines: 370
reason: the INV-LOCK-006 contention answer sits in this handler's own catch,
  ordered against its other error answers; lifting the catch out is the
  handler split its own issue has to plan.

function: src/app/api/bookings/[id]/confirm-payment/route.ts#POST
lines: 332
reason: the INV-LOCK-006 contention answer sits in this handler's own catch,
  ordered against its other error answers; lifting the catch out is the
  handler split its own issue has to plan.

function: src/app/api/bookings/[id]/guests/[guestId]/route.ts#DELETE
lines: 496
reason: the INV-LOCK-006 contention answer sits in this handler's own catch,
  ordered against its other error answers; lifting the catch out is the
  handler split its own issue has to plan.

function: src/app/api/bookings/[id]/guests/route.ts#POST
lines: 1395
reason: the INV-LOCK-006 contention answer sits in this handler's own catch,
  ordered against its other error answers; lifting the catch out is the
  handler split its own issue has to plan.

function: src/app/api/bookings/[id]/modify/route.ts#PUT
lines: 373
reason: the INV-LOCK-006 contention answer sits in this handler's own catch,
  ordered against its other error answers; lifting the catch out is the
  handler split its own issue has to plan.

function: src/app/api/bookings/[id]/waitlist-confirm/route.ts#POST
lines: 505
reason: the INV-LOCK-006 contention answer sits in this handler's own catch,
  ordered against its other error answers; lifting the catch out is the
  handler split its own issue has to plan.

function: src/app/api/payments/charge-saved-method/route.ts#POST
lines: 610
reason: the INV-LOCK-006 contention answer sits in this handler's own catch,
  ordered against its other error answers; lifting the catch out is the
  handler split its own issue has to plan.

function: src/app/api/payments/create-payment-intent/route.ts#POST
lines: 817
reason: the INV-LOCK-006 contention answer sits in this handler's own catch,
  ordered against its other error answers; lifting the catch out is the
  handler split its own issue has to plan.

function: src/app/api/payments/switch-to-internet-banking/route.ts#POST
lines: 485
reason: the INV-LOCK-006 contention answer sits in this handler's own catch,
  ordered against its other error answers; lifting the catch out is the
  handler split its own issue has to plan.

function: src/lib/admin-member-detail-service.ts#updateAdminMember
lines: 946
reason: the INV-LOCK-006 budget is an argument on the lock(1) transaction this
  function opens, and a contended rollback is rethrown past its local catch
  so the route can answer 503; both sit at the site, and splitting the
  function is a refactor of its own.

function: src/lib/admin-roster-service.ts#updateAdminRosterForDate
lines: 480
reason: the INV-LOCK-006 budget is an argument on the lock(1) transaction this
  function opens, and a contended rollback is rethrown past its local catch
  so the route can answer 503; both sit at the site, and splitting the
  function is a refactor of its own.

function: src/lib/waitlist-cross-lodge.ts#confirmCrossLodgeWaitlistOffer
lines: 709
reason: the INV-LOCK-006 budget is an argument on the lock(1) transaction this
  function opens, and a contended rollback is rethrown past its local catch
  so the route can answer 503; both sit at the site, and splitting the
  function is a refactor of its own.

function: src/lib/waitlist.ts#confirmWaitlistOffer
lines: 436
reason: the INV-LOCK-006 budget is an argument on the lock(1) transaction this
  function opens, and a contended rollback is rethrown past its local catch
  so the route can answer 503; both sit at the site, and splitting the
  function is a refactor of its own.
