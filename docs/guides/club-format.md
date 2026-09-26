# Club Currency & Locale

Audience: Operator

## What it is

The currency this club charges in, and the way it writes numbers and dates.
Find it at `/admin/club-format`
(**Admin → Setup & Configuration → Club Currency & Locale**).

Two settings sit on one page because they are the same kind of answer:

- **Currency** — the three-letter code for the money the club takes, such as
  `NZD` or `CHF`. It decides how an amount is *written*, and the currency card
  payments are charged in. It never converts an amount.
- **Number and date format** — a language tag such as `en-NZ` or `de-CH`, which
  decides whether a date reads 14/03/2026 or 3/14/2026 and whether a thousand
  is written 1,000 or 1 000. It is **not** the language the site is in; the
  site is in English either way.

Both are properties of the **club**, not of the server the software runs on and
not of whoever is looking. A member reading the site from another country sees
the club's currency, not their own.

**Recorded here, and in force for every amount, every date and every card
payment.** This page is where the club's currency and format are *recorded*, and
every price, invoice figure, statement line, email total and Xero description
follows it as soon as you save — and so does every date and time on screen, in
the club's time zone and written the club's way, and the currency a member's
card is charged in. Nothing on this page rewrites any amount already recorded.

**These used to be server settings, and this page is where they are changed
now.** `CURRENCY` and `LOCALE` were copied here once, on the first start after
upgrading, so nothing changed for anyone. From then on this page is the
authority: editing the server value changes nothing — not what the site shows,
and not what cards are charged in. That is the point of the change — one place
answers the question, so nobody has to work out which of two is winning. The
`NEXT_PUBLIC_CURRENCY` and `NEXT_PUBLIC_LOCALE` variables are not read at all.

**What follows this page.** As soon as you save:

- **every amount** the site writes — a price, a nightly rate, a promo code
  amount, an invoice figure, a statement line, a finance dashboard figure, a
  booking-request total, an email total, and the amount inside a description
  sent to Xero;
- **every written date and time on screen** — a lodge night, a booking's stay
  dates, an audit-log entry, the health dashboard (its "Last refresh" line as
  well as its rows), the stuck-states page, the induction record, the lobby
  display's date and clock, the month headings and weekday column heads on the
  booking calendars, and the month options in the bookings filter;
- **the currency card payments are charged in** (see below);
- the currency code shown beside a fee or a monthly AI spend cap, **and the
  currency AI spend is counted in** (see below);
- alphabetical order where the site sorts by name — the lockers list, and the
  pictures in a photo gallery.

**Emails follow as soon as you save.** Dates in an email — a booking
confirmation, a reminder, the daily chore roster — are written the way this
page says. Emails read the setting from a copy the server keeps in memory
rather than on every message, and saving here refreshes that copy straight
away, on the server that took the save. The one exception is a second copy of
the app running at the same time — during a blue/green switch-over, for
example — which does not see the save: it refreshes its own copy only when it
next sends an email more than five minutes after its last check, so that first
email can still show dates the old way. Its amounts already show the new
currency either way.

**What does not follow it.** A few labels stay in English whatever is set
here, and are recorded rather than fixed for now:

- the date labels along the bottom of the report charts (for example
  "Apr 16") — the figures and every other date on the reports page do follow
  this page;
- the day-of-week names on the chore schedule and minimum-stay setup screens,
  which are fixed lists of choices rather than dates;
- the month names in the subscription lockout page's "Financial year-end
  month" choice ("January" to "December"), also a fixed list of choices;
- the minimum-stay check-in days on the public booking-policy page ("Friday,
  Saturday"), written from the same fixed list of day names;
- relative times such as "3 hours ago", which are wording, not a date format.

On `en-NZ` the one visible change this brought is September: the bookings
filter's month options and the reports page's "Joined between" line now write
"Sept", the way every other `en-NZ` date on the site already did.

**Expect some screens to look different on another format.** A different
language tag does more than reorder the day and month. `de-CH`, for example,
writes the time on a 24-hour clock ("14:30" rather than "2:30 pm") and spells
the month out in German, so a long month name can make the lobby display's
date line wider. That is the setting working, not a fault.

**Card payments are charged in this currency.** Every NEW card charge is made in
the currency a member is shown. Until #3567 cards were
charged in the server's `CURRENCY` instead, so a club that changed its currency
here was shown one currency and charged another. Saving a different currency
therefore changes live card charges **at once**, and three kinds of payment
already under way behave differently:

- a card payment a member has **already started** stays in the currency it was
  started in if they finish it from the page they already have open, and is
  recorded as the same number of cents; if they reopen the payment page, the
  old payment is replaced by one in the new currency;
- a **saved card** waiting to be charged later (a pending booking) is charged
  the same number of cents in the **new** currency, even though its price was
  set in the old one;
- a **saved-card charge the payment provider never answered** waits for a
  person: its retry, now in a different currency, is refused without saying
  whether the first try charged, so after 23 hours the site asks an
  administrator to check Stripe rather than risk charging twice;
- a **payment-recovery retry** that began before the change is refused by the
  payment provider for the first 24 hours, because it repeats a request in a
  different currency; after that it is made afresh in the new currency;
- a **refund** of a payment taken before the change goes back in that payment's
  original currency (Stripe refunds in the currency it charged), but this site
  shows the refunded amount in the new currency, because it records every amount
  as a number of cents without a currency.

The confirmation counts the payments under way before you save, and a currency
change needs its own tick on top of the ordinary one. It warns; it does not stop
you. Only a Full Administrator sees the counts, because only a Full Administrator
can make the change.

**The club's Stripe account and its Xero base currency must match this
currency.** Invoices this site sends to Xero carry no currency of their own, so
Xero books them in the organisation's **base currency**; if that is not this
currency, every invoice lands in the wrong one. Stripe can take a charge in a
currency other than its payout currency, but converts it before paying out, at
a fee. Change both to match **before** saving here. The site does not yet check
Xero's base currency for you; that check is planned separately (#3633).

**Currencies without two decimal places cannot be chosen.** Every amount here
is kept in hundredths (cents). For a currency like the Japanese yen (no decimal
places) or the Kuwaiti dinar (three), a card would be charged a hundred times,
or a tenth of, what the member was shown. So those currencies are not offered,
saving one is refused, and a card payment in one is refused too.

**Changing the currency clears the AI spend conversion rate.** If the club has
set a rate for AI spend ("how many of our currency one New Zealand dollar
buys"), saving a new **currency** here deletes that rate in the same step, and
the audit log records it as `AI_SPEND_CURRENCY_RATE_CLEARED`. The rate was for
the old currency, so keeping it would count the new currency's spend at the
wrong rate. Both AI settings pages then say the rate is not set: enter the rate
for the new currency there. Changing only the number and date format leaves the
rate alone.

**Every administrator can see this page; only a Full Administrator can change
it.** Any admin — a treasurer or a bookings officer checking why an amount or a
date is written the way it is — can open the page and read both values, where
each came from and who last changed them. Everyone who is not a Full
Administrator sees them read-only, under a note saying so, with the Change
button greyed out. Changing either value is a **Full Administrator** job. It
needs an explicit confirmation, and every such change is written to the audit
log with who made it and what it was before.

This is where the page differs from its neighbours. **Club Time Zone** and
**Environment Safety** are Full Administrator only to open as well as to change;
this page is the same as them on changing and different on viewing.

## When you'd use it

- **First-time setup.** Check both before launch, so the club starts as it means
  to go on.
- **You upgraded and want to check what was carried over.** An upgrade keeps the
  currency and format the installation was already effectively using — it does
  not reset anyone to New Zealand — and this page is where you confirm that.
- **A club outside New Zealand is running this software.** Set the club's own
  currency and format here.
- **Somebody changed `CURRENCY` on the server and nothing happened.** That is
  expected, and this page is where the change actually belongs.

## Step-by-step

### Check what the club is set to

1. Open **Admin → Setup & Configuration → Club Currency & Locale**.
2. Read the two values and the line under each. That line says where the answer
   came from:

   | It says | What that means |
   | --- | --- |
   | **Configured** | The club has chosen it and it is recorded here. |
   | **From the server settings** | Nothing has been recorded yet, so this is what the server was started with. Restarting the app records it; so does saving below. |
   | **Default** | Nothing has been recorded and the server says nothing either, so this is the shipped default (`NZD`, `en-NZ`). Saving records the club's own choice. |
   | **Not usable** | Something is recorded that the app cannot use, so it is falling back. Restarting will **not** repair it — save the value again below. |

3. If somebody has changed them, "Last changed … by …" says who and when.

### Change the currency or the format

1. Choose **Change currency and format**.
2. Filter and pick the currency. Type the language tag in the field beside it —
   the language, then the country, separated by a hyphen.
3. Read the consequences. Tick the acknowledgement.
4. **If you changed the currency**, a second box appears. It counts the card
   payments already started, the saved cards waiting to be charged, and the
   payment-recovery retries still open, and says the Stripe account and Xero
   base currency must match. Check both, then tick it.
5. Choose **Save currency and format**.

Nothing is saved until you press Save, and re-saving the same values on purpose
writes nothing at all — no audit entry for a change that did not happen.

## Settings reference

| Setting | What it is | Accepted values | Default |
| --- | --- | --- | --- |
| Currency | The currency the club charges cards in and displays money in | A three-letter ISO 4217 code with two decimal places: `NZD`, `AUD`, `CHF`. Not a symbol (`$`), not a name (`dollars`), and not a currency without two decimal places (`JPY`, `KWD`) | `NZD` |
| Number and date format | How numbers and dates are written | A BCP 47 language tag: a two- or three-letter language, optionally then a country — `en-NZ`, `en-AU`, `de-CH`, `fr-CA` | `en-NZ` |

Both are refused if they are not one of those shapes, with a message saying what
one looks like. A code the app has never heard of but which *is* three letters is
accepted on purpose: new currency codes are issued from time to time, and a club
should never be locked out of its own real currency because the software's list
is older than the currency.

## Troubleshooting

| Symptom | Cause | Fix |
| --- | --- | --- |
| Changing `CURRENCY` on the server did not change this page | Expected. The server value seeded the setting once; this page is the authority for it now | Change it here instead |
| Changing `LOCALE` on the server did not change the dates | Expected. The server value seeded the setting once; this page is the authority for dates as well as money | Change it here instead |
| An email still shows dates the old way just after a change | It was sent by a second copy of the app (for example during a blue/green switch-over), which refreshes its copy of the setting only when it sends an email more than five minutes after its last check | Nothing to fix. The next email that copy sends uses the new format |
| The report charts' date labels are still in English | A known limitation: the chart axis labels ("Apr 16") are written in English whatever the format | Nothing to fix. The figures and the other dates follow this page |
| The AI settings page says the conversion rate is not set | The club's currency was changed, which clears the rate set for the old one | Enter the rate for the new currency on the AI settings page. **Admin → Audit Log**, action `AI_SPEND_CURRENCY_RATE_CLEARED`, says when and by whom |
| Saving an AI spend rate says the club's currency changed | Someone changed the currency while the rate was being saved, so it was not stored | Reload the page and enter the rate for the new currency |
| "Not usable" appears under a value | Something was written straight into the database, or restored from a backup that held a value this app cannot read | Save the value again on this page. Restarting will not repair it |
| The currency changed but an old invoice still shows the old one | Nothing already recorded is rewritten or re-converted. An amount of 8450 cents is still 8450 cents, in the currency it was paid in | Nothing to fix. No amount is converted: after a change the same numbers are shown, and new card charges are made, in the new currency |
| Saving a currency says it "does not count in hundredths" | The currency has no decimal places (`JPY`) or three (`KWD`), and every amount here is kept in hundredths | Choose a currency with two decimal places. Supporting other currencies is not planned for now |
| A card payment was charged in the old currency after a change | The member had already started paying before the change; the payment provider keeps the currency a payment started in | Nothing to fix on this page. Reconcile it in Stripe and Xero as a payment in the old currency |
| A payment-recovery retry failed straight after a currency change | The retry repeated a request in a different currency, which the payment provider refuses for 24 hours | Nothing to fix unless it is urgent: after 24 hours the retry is made afresh in the new currency. To settle it sooner, finish it by hand from the payment-recovery screens |
| "Not usable" appears under the currency, naming a currency such as JPY | A currency without two decimal places was recorded by hand or copied from `CURRENCY` before #3567; card payments cannot be taken in it, so the site falls back to the default | Set a currency with two decimal places on this page |
| Xero invoices appear in the wrong currency | The Xero organisation's base currency is not the club's currency. Invoices carry no currency of their own | Change the Xero organisation's base currency to match, or talk to the club's accountant first |
| A card was charged in a currency the club did not expect | Card payments follow this page. Before #3567 they followed the server's `CURRENCY` | Check the currency here. Changing `CURRENCY` on the server no longer affects card payments |
| A date reads 3/14/2026 when the club writes 14/03/2026 | The language tag names the wrong country — `en-US` rather than `en-NZ` | Set the tag to the club's own country |
| Someone changed it and nobody knows who | It is audited | **Admin → Audit Log**, action `CLUB_FORMAT_UPDATED`. The entry names the administrator, and the values before and after |
| The page says "You have view-only access to this area" and **Change currency and format** is greyed out | Your admin account is not a Full Administrator. Every admin can see these values; only a Full Administrator can change them | Ask a Full Administrator to make the change |

## Related links

- [Site & Setup guides index](../adopters/README.md) — the operator hub for
  configuration pages.
- Sibling guides: [Club Time Zone](club-time.md) — the same shape of setting for
  the club's time zone.
- [`CONFIGURATION.md`](../../CONFIGURATION.md) — the `CURRENCY` and `LOCALE`
  environment variables, which only seed this page on a first start.
- [`docs/invariants/product-configuration.md`](../invariants/product-configuration.md)
  — `INV-CONFIG-006`, the developer-facing rule this page implements.
