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

**Recorded here, and in force for every amount the site writes.** This page
is where the club's currency and format are *recorded*, and every price,
invoice figure, statement line, email total and Xero description now follows it
as soon as you save. **Dates and times** are the part still worked out from the
`LOCALE` value the server was started with: this change is money only, by the
owner's decision, and the date locale moves in [#3566](https://github.com/thatskiff33/AlpineClubBookingsNZ/issues/3566).
Until then, **keep the server's `LOCALE` in step** with the format recorded here.
What is already true, and permanent: nothing on this page rewrites any amount
already recorded.

**These used to be server settings, and this page is where they are changed
now.** `CURRENCY` and `LOCALE` were copied here once, on the first start after
upgrading, so nothing changed for anyone. From then on this page is the
authority **for the setting**: editing the server value no longer changes what
this page shows. That is the point of the change — one place will answer the
question, so nobody has to work out which of two is winning.

**What already follows this page, and what does not yet.** These now come from
the setting recorded here, as soon as you save it:

- **every amount** the site writes — a price, a nightly rate, a promo code
  amount, an invoice figure, a statement line, a finance dashboard figure, a
  booking-request total, an email total, and the amount inside a description
  sent to Xero. All of them go through one shared money formatter, and every
  place that formatter is used now takes the setting from this page;
- the currency code shown beside a fee or a monthly AI spend cap;
- the date and time on an audit-log entry, and on every row of the health
  dashboard;
- the grouped counts in a promo-code export notice;
- the date on the lobby display.

These do **not** yet, and still come from the server's `LOCALE`:

- every other date and time, which go through the shared date formatters and
  move in [#3566](https://github.com/thatskiff33/AlpineClubBookingsNZ/issues/3566). **Two of them sit on screens listed above**, and are
  the only places you will see the two answers side by side: the "Last refresh"
  line at the top of the health dashboard, and the live clock on the lobby
  display. Both are written by the shared machinery rather than by their own
  screen, so they stay on the server's `LOCALE` while the rows and the date
  beneath them follow this page.

**So keep the server's `LOCALE` set, and keep it matching this page** until
that change lands. Removing it is the one mistake worth warning about, and a
mismatch is the other: you would see dates written one way beside amounts
written another, with nothing flagging it. `CURRENCY` no longer affects
anything an existing club sees; it is read only on the very first start of a
fresh install, to seed this page.

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
| Changing `CURRENCY` on the server DID change the amounts on screen | Also expected, for now. Amounts are written by a shared formatter that has not moved onto the recorded setting yet | Keep the two in step until the later stages land |
| The currency code changed but the amounts beside it did not | Expected for now. The labels follow this page; the amounts are written by a shared formatter moved in the next change | Nothing to fix. Until then, keep the server's `CURRENCY` in step with this page |
| Nothing at all changed after saving | Check which screen. Fees, promo codes, the AI spend cap, booking requests, the audit log, the health dashboard's rows and the lobby display's date follow this page; everything else follows the server settings for now | Nothing to fix |
| The health dashboard's rows changed but its "Last refresh" line did not — or the lobby display's date changed but its clock did not | Expected. Those two are written by the shared date machinery, not by their own screen, so they still follow the server's `LOCALE` | Nothing to fix. Keep `LOCALE` in step with this page and the two read the same until the next change moves them |
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
