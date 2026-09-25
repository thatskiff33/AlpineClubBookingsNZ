- **Dates and times now follow the locale you set in the admin panel, and AI
  spend is counted in your club's own currency (#3566).** Since the previous
  release every amount has followed the currency and format recorded under
  Admin → Club Currency & Locale, but dates and times were still written the way
  the server's `LOCALE` setting said — and in the published image that meant New
  Zealand English for every club. This release finishes the job: every date and
  time on screen, in the club's time zone, is now written the way the club
  recorded, including the lobby display's clock, the health dashboard's "Last
  refresh" line, the audit log, the stuck-states page and the induction record.
  Emails follow too, within five minutes of a change, and the daily chore-roster
  email — which always wrote its date the New Zealand way — now does as well.
  Alphabetical order on the lockers list and in photo galleries follows the same
  setting.

  **What a club on the shipped New Zealand defaults will notice: nothing.** Every
  date, time and amount is written byte-for-byte as before, on screen and in
  email, which is checked by test against the formatters that were retired.

  **What a club on another format will notice:** dates in its own style — for
  `de-CH`, for example, a 24-hour clock and German month names, which can make
  the lobby display's date line a little wider. The date labels along the bottom
  of the report charts (such as "Apr 16") are still written in English; that is
  a known limitation, noted in the operator guide.

  **AI spend now uses the club's recorded currency.** The monthly AI caps were
  already labelled in it, but spend was still converted using the server's
  `CURRENCY` setting, so a club that had switched currency in the panel could not
  set a conversion rate at all and had its spend counted as if one New Zealand
  cent were one cent of its own money. Now the cap and the spend are in the same
  currency. **Changing the club's currency now clears the AI spend conversion
  rate** — it was set for the old currency — and the audit log records that as
  `AI_SPEND_CURRENCY_RATE_CLEARED`; re-enter the rate for the new currency on the
  AI settings page. That new audit record is readable by anyone with support
  view access, like the rate record beside it; it carries two currency codes, a
  rate and the administrator's id, and no member data.

  The server's `CURRENCY` and `LOCALE` settings now do nothing an existing club
  can see; they only seed a brand-new installation. The one thing still taken
  from `CURRENCY` is the currency card payments are charged in, which the next
  stage (#3567) decides.
