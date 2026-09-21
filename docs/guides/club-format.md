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

**Recorded here now; in force as the rest of this work ships.** This page is
where the club's currency and format are *recorded*, and it is the setting the
whole product is moving onto. Today the amounts and dates the site shows are
still worked out from the `CURRENCY` and `LOCALE` values the server was started
with. So while both exist, **keep the two in step**: if you change a value here,
change the server setting to match. What is already true, and permanent: nothing
on this page rewrites any amount already recorded.

**These used to be server settings, and they are not any more.** `CURRENCY` and
`LOCALE` were copied here once, on the first start after upgrading, so nothing
changed for anyone. From then on this page is the authority: **editing the
server setting does nothing at all.** That is the point of the change — one
place answers the question, so nobody has to work out which of two is winning.

Changing either value is a **Full Administrator** job. It needs an explicit
confirmation, and every such change is written to the audit log with who made it
and what it was before.

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
| Changing `CURRENCY` on the server changed nothing | Expected since this page exists. The recorded setting is the authority and the server setting only ever seeded it | Change it here instead |
| The amounts on screen are still in the old currency after saving | Expected for now. This page records the club's choice; the screens that display money are moved onto it in the changes that follow this one | Nothing to fix. Until then, keep the server's `CURRENCY` in step with this page |
| "Not usable" appears under a value | Something was written straight into the database, or restored from a backup that held a value this app cannot read | Save the value again on this page. Restarting will not repair it |
| The currency changed but an old invoice still shows the old one | Nothing already recorded is rewritten or re-converted. An amount of 8450 cents is still 8450 cents | Nothing to fix. This setting changes how an amount is *written*, never what it is worth |
| Card payments are still taken in the old currency | The payment provider's currency is a separate, server-side setting, and moving a club to a different currency is a conversation with the provider and the club's accountant | Raise it with the club's technical contact before changing anything here |
| A date reads 3/14/2026 when the club writes 14/03/2026 | The language tag names the wrong country — `en-US` rather than `en-NZ` | Set the tag to the club's own country |
| Someone changed it and nobody knows who | It is audited | **Admin → Audit Log**, action `CLUB_FORMAT_UPDATED`. The entry names the administrator, and the values before and after |

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
