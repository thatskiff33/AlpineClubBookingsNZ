- **A guest booking no longer tries to charge a card that was never saved
  for reuse (#3269).** When a member books with non-member guests and the guest
  places are held provisionally, the guests' share is charged later to the card
  saved on the member's booking. Until now the system treated any card the
  member had paid with as a saved card — including one used once at checkout,
  which Stripe will not charge a second time. The scheduled charge failed every
  time, and the failed card details were copied onto the guests' booking, where
  the "Confirm pending guests" button then promised a charge that could not
  happen. Now a card counts as saved only when the member saved it through the
  save-a-card step. A member whose own place was paid by a one-off card payment
  is treated exactly like one who paid by Internet Banking: at the hold deadline
  they are emailed a secure payment link for their guests' share, the club is
  notified, and the hold is extended while it is unpaid. Guest bookings already
  carrying a copied card are repaired by the same rule on their next settlement
  run — no data fix is needed.
