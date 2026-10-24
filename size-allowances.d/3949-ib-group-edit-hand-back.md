# File-size allowances for #3949

file: src/app/api/admin/refund-requests/[id]/route.ts
lines: 732
reason: the approval names who its bank-transfer part goes back to - the
  group organiser on a joiner the organiser paid for by internet banking - for
  the hand-back it raises and the email it sends, from the one predicate in
  `group-organiser-paid.ts`; and its raise is refused while the organiser's
  group cancel is part-way through, answered 409 beside the organiser card's
  own refusal in the same catch. The two lines are those imports, and the
  approval that raises the task and sends the email is the only place these
  facts meet.

file: src/lib/email/booking.ts
lines: 1806
reason: the "Booking Modified" sender's `refundByBankTransfer` parameter now
  says who the bank transfer goes to (the member, or the group organiser) rather
  than only whether there is one; the one line is the payee type's import,
  beside the parameter it types, which every edit door's call is checked against.

file: src/components/admin/manual-refund-task-queue.tsx
lines: 2369
reason: the finance queue tells the officer the money goes to the group
  organiser on a joiner the organiser paid for by internet banking - the
  paid-back dialog's title and sentence, the dismissal's sentence, the queue's
  intro paragraph and a refund-direction review row's description and button
  for those rows, and that row skips the cash-or-bank question because the
  organiser is always paid by bank transfer; each sits beside every other
  kind's title, sentence, intro and question in this same render, so the new
  ones have to sit with them.

file: src/lib/booking-cancel.ts
lines: 2861
reason: the paid-cancel gate and the cancel's capture evidence each pass the
  booking to the one capture-evidence entry point (`paymentShowsCaptureEvidence`
  in `booking-payment-state.ts`), which reads an Internet Banking organiser
  child's settle mirror as the capture; without it a joiner's cancel flipped
  the organiser's share FAILED. And (owner decision, 22 Oct 2026) the joiner's
  own cancel of such a place takes its card-tier method and by-hand disposition
  from the helper it shares with its preview (`cancelRefundDisposition`), and
  its hand-back's reason, email, confirmation and "Manual refund needed" alert
  name the organiser - by name in the reason and the alert's Organiser row, read
  from the organiser's booking under the claim's locks - each beside the cash
  hand-back's own lines in the same branch.

file: src/app/api/bookings/[id]/guests/route.ts
lines: 1694
reason: the guest-add door settles its own price change rather than through
  `applyPaymentAdjustments`, so it asks the same refusal every other edit door
  asks there - no price change of a joiner's booking the organiser paid for by
  internet banking while the organiser's group cancel is part-way through
  (`refuseOrganiserBankChildPriceChangeInGroupCancel`) - right after it prices
  the change under its own `lock(1)`. The three lines are that call, its
  comment and its import; the one helper is shared, not copied.

file: src/app/api/bookings/[id]/modify-quote/route.ts
lines: 2551
reason: the quote answers, as advice, the refusal its save would meet - no
  price change of a joiner's booking the organiser paid for by internet
  banking while the organiser's group cancel is part-way through - from the
  save's own function (`organiserBankChildPriceChangeRefusal`), returned beside
  the organiser card's `chargeRefusal` on that field's own line, so it never
  promises a refund the save refuses. The one line is that function's import.
