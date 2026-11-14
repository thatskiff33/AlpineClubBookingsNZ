- **The emailed payment link now confirms a payment made through a bank or
  pay-later page (#4955).** Some payment methods send the payer to another site
  to approve the payment and then back to the link. On their return the page
  used to show "Amount due" and "Pay by card" again until Stripe told the club's
  server about the payment, so the payer could not tell whether it had worked.

  The page now says "Checking your payment..." and asks the server what the
  payment did, then shows the paid page or the right next step. A payment
  declined or cancelled at the provider shows "Your payment did not go
  through. You have not been charged." beside the usual pay options. Nothing
  about how money is taken or settled has changed.
