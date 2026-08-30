- **The payment link a member is emailed no longer says their booking is
  settled while the club is still working out what it costs (#3194).** When a
  change to a booking saves but the refund or charge for it cannot be read from
  the booking's stored price history, the money waits for the office. The
  booking's own page has said so since #3033. The `/pay/...` link did not: it
  showed the ordinary payment view, and on a booking that read as paid it told
  the member there was nothing more to do. One member, one booking, two answers
  — and the reassuring one was the one that had not checked.

  That link now says the same thing the booking page says, in the same words,
  because both take those sentences from one file. A booking whose money is
  being worked out is told the club is doing so, that nothing has been refunded
  or charged for it yet, and that there is nothing they need to do about that
  change — with no figure of any kind, because the figure is the thing nobody
  knows yet.

  **The member can still pay, and every way to pay stays open.** A change can
  give back nights that cannot be priced while adding nights that price
  normally, so the booking's own price is often genuinely due and this link is
  the only way an unregistered guest can pay it. The card button, the internet
  banking reference and the "email me a new link" button all remain, with the
  review note sitting directly under the amount so it is read before the member
  decides — and it says in as many words that the change being worked out is not
  part of the figure shown. Taking the payment away would have cost them the
  booking when the hold expired without moving a cent of the money in question.
  The note stays on screen after they pay, too, so the last thing the page says
  is not "your booking is confirmed, see you at the lodge".

  A booking with no review waiting is unchanged in every respect.
