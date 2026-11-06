- **A change fee on a booking that is not yet paid is now charged (#4661).**
  When the dates of a booking not yet paid were moved, such as a bank-transfer
  booking whose invoice was still unpaid, the club's late-change fee was worked out but
  never added to what the member owed. The booking's history showed a fee,
  but the payment, the invoice and the booking ledger did not carry it.

  The fee is now added to the amount the member owes, once. An invoice raised
  later includes it; an invoice already sent gets a supplementary invoice for
  it; and when the booking is paid the ledger records the fee against the
  edit that charged it. Bookings already paid are unchanged: their fee was
  already collected by the edit itself.
