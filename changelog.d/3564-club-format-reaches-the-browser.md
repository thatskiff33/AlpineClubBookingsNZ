- **The currency and number format you set in the admin panel now reach the
  screens (#3564).** Since #3563 a Full Administrator could record the club's
  currency and its number and date format at **Admin → Setup & Configuration →
  Club Currency & Locale**, and nothing on any screen took any notice. Ten
  screens now do.

  A club outside New Zealand sees its own currency code beside a hut fee, a
  nightly rate, a membership or joining fee, a promo-code amount, a monthly AI
  spend cap and a booking-request total. The audit log and the health dashboard
  write their dates and times the club's way, a promo-code export notice groups
  its counts the club's way, and the lobby display writes its date the club's
  way. None of this needed a rebuild or a change on the server, which is the
  point: those values were previously frozen into the software when it was
  built, so a club could set them and be ignored.

  **Keep the server's `CURRENCY` and `LOCALE` in place, and keep them matching
  the page.** Every **amount** the site writes — a price, an invoice figure, a
  statement line, an email total — is still written from them, along with the
  dates outside the screens listed above, and those move across in the next two
  changes. If the two disagree you will now see your chosen currency code
  sitting beside amounts written the old way, on the same screen. That is the
  mismatch to avoid; the admin page, the operator guide, `CONFIGURATION.md` and
  `.env.example` all say so, and each will stop saying it as its part becomes
  true.

  Nothing already recorded is rewritten or re-converted: an amount of 8450 cents
  is still 8450 cents, and this setting only ever decides how one is written.

  **One installation will see a change it did not ask for, and it is the
  intended one.** If you build your own image and the currency baked into that
  build differs from the one set in the running container's environment, the
  screens above were showing the build's value while the recorded setting held
  the container's. They now show the recorded setting. That is the defect this
  work exists to fix, but it is worth knowing before you notice it.
