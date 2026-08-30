- When a booking change costs the member more, the club now always ends up with
  an invoice for it. Until now, if the payment request could not be raised on the
  first attempt — a card provider timing out, a momentary network fault — the
  system quietly retried it in the background and got the request to the member,
  but the matching invoice was never raised. The member could see the charge and
  pay it; the club's accounts had no record that it was ever made, so the payment
  arrived with nothing to reconcile it against. The retry now raises the invoice
  as well, for the same amount and against the same payment, exactly as it would
  have if nothing had gone wrong.
- It cannot end up raising two. Whatever mix of first attempt and retry a change
  goes through, one booking change still produces one invoice, and a retry that
  runs twice adds nothing the second time.
- This applies to both kinds of increase: an ordinary change that reprices a
  stay, and one the office settled as money the member owes after a price
  review. Both use the same payment request and now both raise the same invoice.
- On the rare occasion the invoice still cannot be raised — the club's accounting
  connection being down at that exact moment — the payment request is left in
  place and working, and the booking shows up in the office's Xero repair check
  as a change that is missing its invoice, ready to be queued with one click.
