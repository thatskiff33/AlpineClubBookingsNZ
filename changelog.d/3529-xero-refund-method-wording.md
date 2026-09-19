- **Every Xero refund or credit document now says how the money went back,
  and Xero only shows a refund as paid when it really was (#3529).** A credit
  note raised by the booking system used to read "Refund for booking …"
  whether the member's card had been refunded or the club had paid them back
  by bank transfer, and a hand-back settled by internet banking after a
  booking-edit review was labelled as if it were a card refund. Worse, such a
  note was then marked paid from the Stripe account — money that never went
  through Stripe — which took it off the treasurer's list of outstanding
  credits and made it hard to find when the real bank line arrived.

  Each document now opens with exactly one of three wordings, in both its line
  and its reference: **Refund against original credit card** (money left the
  Stripe account), **Refund requested via internet banking** (the club sent
  the money back itself), or **Account Credit** (nothing moved — the member
  keeps the credit). The wording follows the decision that was actually made
  when the money was settled, not a guess from how the booking was paid.

  Xero now records a settling payment against a refund note only where the
  money verifiably moved. A card refund is still recorded against the Stripe
  account. A refund sent by internet banking is recorded against a new
  **Bank Transfer Refunds Account** you can choose on the Xero setup screen;
  until you do, the credit note is raised **without** a payment so it stays
  visibly outstanding for you to match to the bank line, and the Setup
  Completeness checklist tells you the choice is waiting. A bank transfer is
  never recorded as leaving the Stripe account again — including for older
  refund notes the system repairs.

  Also new: when an internet-banking payment arrives in Xero for a booking
  that was already cancelled and belongs to a school or other organisation,
  and the club pays it back by hand, completing that hand-back now raises the
  credit note against the paid invoice — before, it reached Xero nowhere and
  the invoice had to be corrected by hand. A booking settled in cash has no
  Xero invoice at all, so its hand-back still writes nothing to Xero: the
  money never went through the books there.

  Nothing about cancellation policy changed: a booking paid by internet
  banking and then cancelled still returns account credit.
