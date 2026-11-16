- **The booking page, the booking wizard, additional payments and group
  settlement now confirm a payment made through a bank or pay-later page.**
  The emailed payment link already did this (#4955). On every other card
  payment, a payer sent to a provider's site and back used to see the payment
  form again, or on a draft booking the "Continue to Payment" step, with
  nothing to say whether the payment had worked.

  Each of these now says "Checking your payment..." and asks the club's server
  what the payment did. It then shows the paid state, "This payment is being
  processed" for a payment the bank is still clearing, or the right recovery
  message. A payment the payer declined or cancelled at the provider shows
  "Your payment did not go through. You have not been charged." next to the
  form. A payment still processing after an in-page confirmation is also
  described that way instead of the form being shown again. Nothing about how
  money is taken or settled has changed.
