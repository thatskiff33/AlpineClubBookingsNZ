- **A card refund of credit already recorded in Xero now gets a credit note (#4493).**
  When a member paid by card for credit that had been used in Xero, and that
  payment was recorded on the booking's invoice, a later refund of the card
  left Xero still showing the money as received. That refund now raises one
  credit note for the amount refunded, against the same invoice, and sending
  the refund again does not raise a second note.

  Refunds that were already missed are not repaired. A card payment taken after
  a booking was cancelled is unchanged.
