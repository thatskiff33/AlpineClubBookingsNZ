- **Each promo code gets its own line in Xero, on emails and on the booking
  page (#3828, epic #3813).** When a booking carries several promo codes, the
  Xero invoice now shows one "Promo adjustment - CODE" line per code, each
  posted to that code's own Xero item and account, so the treasurer can
  reconcile every code separately. A group's combined invoice does the same for
  each joiner, and a booking edit's supplementary invoice or credit note shows
  one promotion line for each code whose discount changed. Confirmation emails,
  the booking's payment summary and the member's data export name each code
  with its own amount.

  If the club's records cannot show exactly what each code took off, the
  invoice keeps one combined promotion line naming all the codes, at the
  usual promotion account, and the Xero sync record says why. The invoice
  total is the same either way.

  A booking with a single promo code is unchanged: the same invoice line,
  coding, email rows and edit lines as before.
