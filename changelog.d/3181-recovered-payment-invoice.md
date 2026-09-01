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
- Nor can the retry raise an invoice the first attempt would not have raised. If
  the booking's own invoice had not gone out yet when the change was made, that
  invoice bills the change when it does go out, and no separate one is needed —
  so the retry checks what was true at the time of the change rather than what is
  true when it runs, hours later. Without that, a $500 booking with a $50 guest
  added could have ended up with $600 of income recorded and a $50 bill nobody
  owed, purely because a card provider hiccuped.
- On the rare occasion the invoice still cannot be raised — the club's accounting
  connection being down at that exact moment — the payment request is left in
  place and working, and the booking shows up in the office's Xero repair check
  as a change that is missing its invoice, ready to be queued with one click. For
  a change settled after a price review, where that repair check cannot always
  see the money, the office also gets an entry in the audit log naming the amount
  that was asked for but never invoiced.
- If the member had already paid the request before the retry got to it, no
  invoice is queued against it. Queuing one would leave a job waiting forever for
  a payment that has already happened, and — worse — would replace the office's
  clear "this change is missing its invoice, fix it with one click" prompt with a
  vaguer "waiting for payment" one that never resolves.
