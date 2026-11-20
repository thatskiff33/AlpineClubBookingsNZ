# Size allowances for #5153

function: src/lib/membership-cancellation-xero.ts#createXeroMembershipCancellationCreditNote
lines: 606
reason: routes Xero tax through the club tax schedule; those lines sit inside
  the function `createXeroMembershipCancellationCreditNote`, which was already
  over its limit before this change, and lifting it apart is a refactor of its
  own, not part of this fix.

function: src/lib/xero-booking-invoices.ts#createXeroInvoiceForBooking
lines: 951
reason: routes Xero tax through the club tax schedule; those lines sit inside
  the function `createXeroInvoiceForBooking`, which was already over its limit
  before this change, and lifting it apart is a refactor of its own, not part
  of this fix.

function: src/lib/xero-credit-notes.ts#createXeroCreditNote
lines: 658
reason: routes Xero tax through the club tax schedule; those lines sit inside
  the function `createXeroCreditNote`, which was already over its limit before
  this change, and lifting it apart is a refactor of its own, not part of this
  fix.

function: src/lib/xero-credit-notes.ts#createUnappliedXeroCreditNote
lines: 315
reason: routes Xero tax through the club tax schedule; those lines sit inside
  the function `createUnappliedXeroCreditNote`, which was already over its
  limit before this change, and lifting it apart is a refactor of its own, not
  part of this fix.

function: src/lib/xero-entrance-fee-invoices.ts#createXeroEntranceFeeInvoice
lines: 458
reason: routes Xero tax through the club tax schedule; those lines sit inside
  the function `createXeroEntranceFeeInvoice`, which was already over its
  limit before this change, and lifting it apart is a refactor of its own, not
  part of this fix.

function: src/lib/xero-modification-credit-notes.ts#createXeroCreditNoteForModification
lines: 438
reason: routes Xero tax through the club tax schedule; those lines sit inside
  the function `createXeroCreditNoteForModification`, which was already over
  its limit before this change, and lifting it apart is a refactor of its own,
  not part of this fix.

function: src/lib/xero-subscription-invoices.ts#createXeroMembershipSubscriptionInvoice
lines: 417
reason: routes Xero tax through the club tax schedule; those lines sit inside
  the function `createXeroMembershipSubscriptionInvoice`, which was already
  over its limit before this change, and lifting it apart is a refactor of its
  own, not part of this fix.

function: src/lib/xero-supplementary-invoices.ts#createXeroSupplementaryInvoice
lines: 582
reason: routes Xero tax through the club tax schedule; those lines sit inside
  the function `createXeroSupplementaryInvoice`, which was already over its
  limit before this change, and lifting it apart is a refactor of its own, not
  part of this fix.
