- **A card refund on a bank-transfer booking now gets its own Xero credit
  note (#4312).** When a bank-transfer payment also took a card payment (an
  edit paid by card) and some of that card money was refunded, the refund
  was counted under the payment's first refund credit note and Xero never
  got a note for it, so Xero showed less credit than the club had paid back.
  These card refunds now get a credit note of their own, each for exactly
  that refund: the card part of an approved refund appeal, including one the
  payment recovery job finishes later; a refund made in the Stripe
  dashboard; and a refund of a card payment captured after the booking was
  cancelled. A card payment taken twice by mistake, and refunded, still gets
  no note: Xero never received it. If Stripe fails one of these refunds days
  later and the app sends it again, the failed refund's note covers the
  refund the app sends in its place, so Xero is not credited twice; if that
  one fails too, the cover passes to the next refund the app sends for it, if
  any. A refund made in the Stripe dashboard always gets a note for its full
  amount. If Xero voids one of these notes, it is
  listed on Stuck States for a person and never mistaken for a bank refund
  to take back.

  Only card refunds made after this release's marker migration runs get a note
  of their own. Older ones are never given one: the read-only query in the
  deploy notes still lists those payments so their notes can be raised by hand.
  While the previous version still runs during an upgrade, or after rolling
  back, it treats these new credit notes as it treated card refunds before.
