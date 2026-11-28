/**
 * `cancelBooking`'s `refuseRefund` option (#5005, child B): a caller that may
 * only cancel a booking with nothing to give back asks for it, and the paid
 * path's claim refuses, under its locks and before any write, when the policy
 * would refund or restore anything. The import's batch reversal cancels a
 * booking whose payment it has just taken back; if money arrived in between, it
 * must stop rather than refund it.
 */
export class CancelRefundRefusedError extends Error {
  constructor() {
    super("CANCEL_REFUND_REFUSED");
  }
}

export const CANCEL_REFUND_REFUSED_MESSAGE =
  "This booking now has money to give back, so it was not cancelled; check it and cancel it by hand if it should go";
