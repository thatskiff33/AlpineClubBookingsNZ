# Size allowances for #5140

file: src/app/api/bookings/route.ts
lines: 1910
reason: adds the 503 branch for a contended booking create
  (isTransactionContention, Retry-After, #4933) inside this file, which was
  already over its limit before this change; lifting it apart is a refactor of
  its own, not part of this fix.

file: src/lib/booking-create.ts
lines: 2080
reason: passes the shared lock(1) transaction budget to the two booking create
  transactions (#4933), inside this file, which was already over its limit
  before this change; lifting it apart is a refactor of its own, not part of
  this fix.

file: src/lib/group-settlement.ts
lines: 1685
reason: replaces the literal 30 s budget with the shared lock(1) budget
  constant (#4933), one extra line of import, inside this file, which was
  already over its limit before this change; lifting it apart is a refactor of
  its own, not part of this fix.

function: src/app/api/bookings/route.ts#POST
lines: 1643
reason: adds the 503 branch for a contended booking create
  (isTransactionContention, Retry-After, #4933) inside `POST`, which was
  already over its limit before this change; lifting it apart is a refactor of
  its own, not part of this fix.

function: src/lib/booking-create.ts#createDraftBooking
lines: 332
reason: passes the shared lock(1) transaction budget to the two booking create
  transactions (#4933), inside `createDraftBooking`, which was already over
  its limit before this change; lifting it apart is a refactor of its own, not
  part of this fix.

function: src/lib/booking-create.ts#createConfirmedBooking
lines: 1123
reason: passes the shared lock(1) transaction budget to the two booking create
  transactions (#4933), inside `createConfirmedBooking`, which was already
  over its limit before this change; lifting it apart is a refactor of its
  own, not part of this fix.
