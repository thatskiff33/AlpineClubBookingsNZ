- **Card payments are now charged in the club's own currency, and the old
  server currency, locale and time-zone constants are gone (#3567).** Until now
  a member's card was charged in the currency set by the server's `CURRENCY`
  variable, while everything on screen used the currency recorded at
  **Admin → Setup & Configuration → Club Currency & Locale**. A club that had
  changed its currency on that page was shown one currency and charged another.
  Cards are now charged in the recorded currency, so the two can no longer
  differ. A club on the New Zealand defaults notices nothing: cards are still
  charged in NZD and every screen, email and Xero line reads exactly as before.

  **Changing the currency now changes card charges straight away.** Before you
  save a new currency, the page counts the card payments already started (these
  stay in the old currency), the saved cards waiting to be charged later (these
  are charged in the new currency) and the payment-recovery retries still open
  (the payment provider refuses these after the change). The change needs its
  own tick, confirming that the club's **Stripe account and Xero base currency
  both match** the new currency. Xero books every invoice this site sends in its
  base currency, so a mismatch puts invoices in the wrong currency.

  Currencies without two decimal places, such as the Japanese yen or the Kuwaiti
  dinar, can no longer be chosen, and a card payment in one is refused. Every
  amount is kept in hundredths, so a card would otherwise be charged a hundred
  times, or a tenth of, what the member was shown.

  **Upgrade note.** If your server's `CURRENCY` differs from the currency shown
  on the Club Currency & Locale page, cards will be charged in the page's
  currency after this upgrade; check that page, your Stripe account and your
  Xero base currency agree before deploying. `CURRENCY` and `LOCALE` now only
  seed that page on a first start and are never read again.
  `NEXT_PUBLIC_CURRENCY` and `NEXT_PUBLIC_LOCALE` are no longer read at all: an
  install that set only those would start on NZD / en-NZ, and its first start
  logs a warning saying so. The refund table no longer fills in "nzd" when a
  currency is missing (a database migration that rewrites no data); existing
  refunds keep the currency they were refunded in. The AI spend budgets now
  count their months in the club's recorded time zone, which is the same month
  as before for a New Zealand club.
