- **Group organiser card refunds Stripe gave up on can now be settled on Stuck States (#4851).**
  A refund out of a group organiser's card that Stripe gave up on, for one
  joiner or an older refund of a whole group's payment, now appears under
  **Card refunds Stripe gave up on**. **Paid another way** reads Stripe first:
  if Stripe already has the refund, it is recorded and nobody is paid again;
  otherwise the bank payment is recorded and officers are emailed to credit the
  group's invoice in Xero by hand. A joiner's refund can also use **Try the card
  again**, which never sends a refund Stripe already holds. No developer or
  Stripe dashboard refund is needed.
