- **A payment's refunded total can no longer be overwritten by a write made at
  the same moment (#4217).** When two things changed one payment at once, the
  refunded total could end up wrong. For example, a top-up's card payment could
  land just as a treasurer confirmed a bank-transfer refund cancelled, or as
  account credit was given back. The payment would then show a refunded figure
  that its own refund history did not add up to, and nothing flagged it. Every
  card capture, bank-transfer receipt, top-up request and refund now waits its
  turn on the payment, so the total is always worked out from the latest
  figures. This also fixes a rare clash between a card payment being recorded
  and a refund on the same charge, which could make one of them fail.

  What you may notice: in the rare case that a Stripe notification arrives while
  a long change to the same booking is still saving, it can now be turned away
  and Stripe sends it again a moment later, as it already does for other busy
  moments. Nothing is lost, and no action is needed. In the same rare case, a
  member or officer saving a booking change or a payment may see an error;
  trying again a moment later succeeds.
