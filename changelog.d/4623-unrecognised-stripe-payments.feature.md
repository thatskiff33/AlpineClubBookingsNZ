- **A Stripe payment the app did not create is no longer silent (#4532).** A
  club can take money on its Stripe account outside the app - a Stripe Payment
  Link for donations, a Checkout page, or a charge made in the Stripe
  dashboard. The app used to ignore such a payment, so nothing reached Xero and
  the Stripe clearing account stopped reconciling with nobody told why.

  The app now keeps a record of each such payment and sends Finance editors one
  email per payment, "Stripe payment the app did not create - code it in Xero",
  naming the amount, when it was paid, the description the club entered in
  Stripe, and the Stripe payment and Payment Link, with a link to it in Stripe.
  It says so when another platform on the account, such as Xero's own Pay now,
  created the payment. It cannot be muted. After five in an hour the app sends
  one "More Stripe payments the app did not create" email an hour instead, in
  case of card testing, and still records every payment. The treasurer then
  records the money in Xero by hand against the Stripe clearing account; the
  [Payments guide](../docs/guides/payments.md#a-stripe-payment-the-app-did-not-create)
  says how. A restricted Stripe key now also needs read access to Checkout
  Sessions. Payments the app makes itself are unchanged.
