# File-size allowances for #4019 (whole-lodge payment options)

The whole-lodge approval now leaves the payment method to the member. Every
file below is an existing seam that change had to pass through; each grows by a
few lines of policy inside a decision the file already owns, and none of them
gains a boundary a split could sit on.

file: src/lib/school-booking-request.ts
lines: 3221
reason: the member-choice branch (apply the elected credit, settle at $0
  when it covers the price, or keep the legacy receivable) sits inside the
  one approval transaction, under the locks it already holds; lifting it out
  would separate the money decision from the capacity claim and the
  idempotency fence it is ordered against, which is the pairing the
  #2263 owner decision placed in this file on purpose.

file: src/lib/booking-request.ts
lines: 3090
reason: the request's credit election is one field on the creation write and
  one on the admin serialiser, beside the exclusivity flag it travels with;
  a new module for a boolean would put the request's shape in two places.

file: src/app/api/payments/switch-to-internet-banking/route.ts
lines: 539
reason: the whole-lodge hold exemption, shared status rule and post-lock
  already-Internet-Banking replay stay inside the existing switch transaction;
  splitting its claim from its source re-read would separate the check from
  the receivable, credit and hold effects it fences. The post-commit invoice
  enqueue, the live-state rule and the replay's answer moved out to
  internet-banking-switch-replay.ts, which both replays share.

file: src/components/admin/booking-requests/public-booking-requests-panel.tsx
lines: 2721
reason: one optional field on the request type, current module eligibility
  passed to the existing approval fields, and truthful toast branches; the panel is the queue's single composition root and
  the #2263 controls already live in their own file beside it.

file: src/lib/email/booking.ts
lines: 1850
reason: the pay-online shape is a type swap and a spread at the two places
  the sender composes the payment-due note; the composer itself lives in
  email-payment-due-note.ts (moved there whole from email-message-notes.ts,
  which sits at its ceiling), which is where the new wording went.

file: src/lib/admin-bookings-service.ts
lines: 1446
reason: the bookings list gains the `unpaid=finished` queue filter (#4264
  review F3), one schema line and one AND-composed fragment beside the
  `additionalOwed` queue it mirrors; the fragment itself lives in
  unpaid-finished-stays.ts, so the list adds a door and not a rule.

file: src/lib/booking-date-modification-service.ts
lines: 2252
reason: the INV-MOD-012 clamp and the $0 auto-settle now reach an approved
  member whole-lodge booking with no Payment row (#4264 review F1), through
  the one predicate `isUnpaidConfirmedWholeLodge`; the conditions widen in
  place beside the PENDING/PAYMENT_PENDING gate they already own, and the
  batch sibling booking-modify-settlement.ts took the same change inside
  its ceiling.

file: src/lib/booking-batch-modification-service.ts
lines: 2744
reason: the locked booking query loads ordered transaction evidence, and a
  newly paid whole-lodge edit calls the shared confirmation poster after its
  guest/night writes; the caller must keep that ordering inside its existing
  transaction, while the posting policy itself lives in the extracted helper.
  The load is typed as `LoadedBookingForLifecycle` (one import line), so the
  lifecycle's unpaid predicate sees the transactions it requires.

file: src/lib/booking-guest-removal-service.ts
lines: 1242
reason: the locked booking query loads ordered transaction evidence for the
  shared lifecycle decision, and the new whole-lodge zero-cash branch calls
  the shared confirmation poster after its guest/night writes; extracting the
  call would separate it from the transaction whose PAID transition it records.
  The lifecycle call is typed as `LoadedBookingForLifecycle` (one import
  line), so the unpaid predicate sees the transactions it requires.
