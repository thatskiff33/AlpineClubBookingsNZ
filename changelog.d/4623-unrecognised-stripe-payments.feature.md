- **A Stripe payment the app did not create is no longer silent (#4532).** A
  club can take money on its Stripe account outside the app - a Stripe Payment
  Link for donations, a Checkout page, or a charge made in the Stripe
  dashboard. The app used to ignore such a payment, so nothing reached Xero and
  the Stripe clearing account stopped reconciling with nobody told why.

  The app now keeps a record of each such payment and sends Finance editors one
  email per payment, "Stripe payment the app did not create - code it in Xero",
  naming the amount, when it was paid, what was bought, and the Stripe payment
  and Payment Link, with a link to it in Stripe. It cannot be muted. The
  treasurer then records the money in Xero by hand against the Stripe clearing
  account; the [Payments guide](../docs/guides/payments.md#a-stripe-payment-the-app-did-not-create)
  says how. Payments the app makes itself are unchanged.
