# Club Currency & Locale

Audience: Operator

## What it is

The currency this club charges in, and the way it writes numbers and dates.
Find it at `/admin/club-format`
(**Admin → Setup & Configuration → Club Currency & Locale**).

Two settings sit on one page because they are the same kind of answer:

- **Currency** — the three-letter code for the money the club takes, such as
  `NZD` or `CHF`. It decides how an amount is *written*. It never converts one.
- **Number and date format** — a language tag such as `en-NZ` or `de-CH`, which
  decides whether a date reads 14/03/2026 or 3/14/2026 and whether a thousand
  is written 1,000 or 1 000. It is **not** the language the site is in; the
  site is in English either way.

Both are properties of the **club**, not of the server the software runs on and
not of whoever is looking. A member reading the site from another country sees
the club's currency, not their own.

**Recorded here, and in force for every amount and every date the site
writes.** This page is where the club's currency and format are *recorded*, and
every price, invoice figure, statement line, email total and Xero description
follows it as soon as you save — and so does every date and time on screen, in
the club's time zone and written the club's way. Nothing on this page rewrites
any amount already recorded.

**These used to be server settings, and this page is where they are changed
now.** `CURRENCY` and `LOCALE` were copied here once, on the first start after
upgrading, so nothing changed for anyone. From then on this page is the
authority: editing the server value no longer changes what the site shows. That
is the point of the change — one place answers the question, so nobody has to
work out which of two is winning.

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

**What does not follow it.** Three things stay in English whatever is set
here, and are recorded rather than fixed for now:

- the date labels along the bottom of the report charts (for example
  "Apr 16") — the figures and every other date on the reports page do follow
  this page;
- the day-of-week names on the chore schedule and minimum-stay setup screens,
  which are fixed lists of choices rather than dates;
- relative times such as "3 hours ago", which are wording, not a date format.

On `en-NZ` the one visible change this brought is September: the bookings
filter's month options and the reports page's "Joined between" line now write
"Sept", the way every other `en-NZ` date on the site already did.

**Expect some screens to look different on another format.** A different
language tag does more than reorder the day and month. `de-CH`, for example,
writes the time on a 24-hour clock ("14:30" rather than "2:30 pm") and spells
the month out in German, so a long month name can make the lobby display's
date line wider. That is the setting working, not a fault.

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
4. Choose **Save currency and format**.

Nothing is saved until you press Save, and re-saving the same values on purpose
writes nothing at all — no audit entry for a change that did not happen.

## Settings reference

| Setting | What it is | Accepted values | Default |
| --- | --- | --- | --- |
| Currency | The currency the club charges and displays money in | A three-letter ISO 4217 code: `NZD`, `AUD`, `CHF`. Not a symbol (`$`) and not a name (`dollars`) | `NZD` |
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
| The currency changed but an old invoice still shows the old one | Nothing already recorded is rewritten or re-converted. An amount of 8450 cents is still 8450 cents | Nothing to fix. This setting changes how an amount is *written*, never what it is worth |
| Card payments are still taken in the old currency | The payment provider's currency is a separate, server-side setting, and moving a club to a different currency is a conversation with the provider and the club's accountant | Raise it with the club's technical contact before changing anything here |
| A date reads 3/14/2026 when the club writes 14/03/2026 | The language tag names the wrong country — `en-US` rather than `en-NZ` | Set the tag to the club's own country |
| Someone changed it and nobody knows who | It is audited | **Admin → Audit Log**, action `CLUB_FORMAT_UPDATED`. The entry names the administrator, and the values before and after |
| The page says "You have view-only access to this area" and **Change currency and format** is greyed out | Your admin account is not a Full Administrator. Every admin can see these values; only a Full Administrator can change them | Ask a Full Administrator to make the change |

## Related links

- [Site & Setup guides index](../adopters/README.md) — the operator hub for
  configuration pages.
- Sibling guides: [Club Time Zone](club-time.md) — the same shape of setting for
  the club's time zone.
- [`CONFIGURATION.md`](../../CONFIGURATION.md) — the `CURRENCY` /
  `NEXT_PUBLIC_CURRENCY` and `LOCALE` / `NEXT_PUBLIC_LOCALE` environment
  variables and what they still do.
- [`docs/invariants/product-configuration.md`](../invariants/product-configuration.md)
  — `INV-CONFIG-006`, the developer-facing rule this page implements.
