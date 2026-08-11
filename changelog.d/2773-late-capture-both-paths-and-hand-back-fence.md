- **Every automatic refund of a late payment is now on the Payments page, not just
  the ones for booking changes (#2773).** There are two ways a member's card can be
  charged just after their booking is cancelled: for a change to the booking, or for
  the booking itself. Stripe hands the money straight back either way. Only the
  first kind reached the read-only **Refunded automatically — nothing to pay back**
  card on Admin → Payments, and only the first kind got the clear, unmuteable email
  about it — the second still arrived as the generic *Payment Failed*, which
  described nothing that had happened and could be switched off per admin or
  club-wide.

  Both now behave the same way. The card's wording drops the words "booking-change",
  because it no longer needs them: an empty card means no automatic refund happened
  in the last 30 days, whichever kind of payment it was. Each row still says which
  payment it was in its own reason line, and the email says so too, along with what
  became of the Xero paperwork — which genuinely differs between the two.

  Nothing about the refunds themselves changed: same amounts, same timing, same
  decision to refund.

- **A late payment you have already handed back by hand is no longer refunded a
  second time (#2774).** This was a real way for the club to lose money. When a
  payment for a *change* to a booking is captured against a cancelled booking, a
  hand-back task can sit on Admin → Payments waiting for somebody — and clicking
  **Mark paid back** is what records the refund in the ledger. If Stripe's own
  automatic refund then arrived, it went out as well, and the member had been paid
  twice. Nothing stopped it, and only a reconciliation would have caught it.

  A payment for the booking *itself* never raises a task you can mark paid back, so
  this is the payment kind the problem arises on. The new check runs on both kinds
  anyway, so it cannot be reopened by that changing.

  Now the system checks first. If the hand-back task for that payment is already
  marked paid back, the automatic refund is **not** sent. You are emailed
  *Automatic refund withheld — already paid back by hand*, and the booking's audit
  log records it, so somebody can confirm the hand-back really happened and covers
  the whole amount. If it did not, the money is still sitting at Stripe and can be
  refunded from there. **Dismissing** a task does not stop a refund — dismissing
  records no money moving, so the refund is still needed.

  One timing cannot be protected against: marking the task paid back at the exact
  moment the automatic refund is going out. That is now reported rather than silent
  — you are emailed *Payment may have been refunded TWICE — reconcile* and the audit
  log says so, so you can compare the Stripe refund against your own hand-back and
  recover the difference. Neither email can be switched off, and both go to everyone
  whose role can edit Finance.

  If the check itself cannot run — a database problem at that moment — the system
  deliberately does neither: it asks Stripe to send the notification again shortly
  rather than guess between refunding twice and never refunding at all.

- **Those two emails cannot be given a subject that says the wrong one happened.**
  They share one message in Admin → Settings → Email Messages, and the subject fills
  in which of the two it is as you send. If you rewrite that subject, the editor now
  refuses a version that removes the fill-in, and also one that keeps it but types a
  direction of your own beside it — "Automatic refund withheld — …" in front would
  have titled every *possible double payment* as a refund that never went out, which
  is the line an operator triages the inbox on. Wording that says what the email is
  about is fine; it is only the direction that has to be left to the fill-in.

- **Unchanged in both:** no refund amount, timing or decision moved; nothing already
  refunded was recalculated; one refund task per payment still holds; and one email
  per event still holds — the withheld and double-payment notices replace the
  ordinary one rather than joining it.
