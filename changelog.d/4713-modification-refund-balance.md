- **Booking-change refund retries account for refunds already made (#4713).**
  When a retry has no saved refund plan, it refreshes the recorded balance after
  checking Stripe, so a refund made through another route no longer causes an
  oversized request that wastes a retry.
