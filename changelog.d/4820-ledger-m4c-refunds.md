- Record card refunds in the member-money journal. Each card refund the app
  owes (a cancellation, an edit, an approved appeal, an edit review, a duplicate
  or late capture) is recorded as a debt, each card refund slice is reserved
  against it before Stripe is asked, and each refund Stripe records pays that
  debt only through its own reservation; a refund that fails later reopens it.
  A refund the journal would over-pay is not sent and lands on the stuck-states
  list for the treasurer. Closing a card refund as paid another way in part
  now asks whether the club keeps the rest or it is still owed to the member;
  a rest still owed stays in "Refunds owed" until a later close, and the
  member's booking page and payment link say both what was paid back and that
  the rest is still being refunded. A dry-run-first
  owner command lists and reconciles reservations. Stripe requests are unchanged.
