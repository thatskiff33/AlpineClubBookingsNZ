- **A booking paid partly with account credit can again have its own
  cancellation credit note raised in Xero (#4712).** When Xero told the system
  about a credit note that had been spent on a booking, the system sometimes
  recorded that note against the booking's payment as if it had been raised
  for it. That stopped the booking's own cancellation credit note from ever
  being created ("already linked"), and made the payment look partly refunded
  when no money had gone back. The system no longer records it that way. A
  one-off repair, `pnpm run xero:applied-credit-account-note-link-repair`, lists
  the records the old behaviour left behind and, for the payments an operator
  has reviewed, removes them and corrects each payment's refunded total. It
  makes no change in Xero.
