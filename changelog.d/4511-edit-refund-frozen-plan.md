- **Booking edit refunds retry without sending extra money (#3984).** If Stripe
  refunds a member but saving the refund fails, recovery now replays the original
  request even when a webhook records it first. Partial refunds keep their
  completed and outstanding parts together, with existing officer alerts.
