# Club Time Zone

Audience: Operator

## What it is

The single answer to "what time is it at the club?" Every date and time this
platform shows a member — a booking confirmation, an invoice date, an email
timestamp, the roster — is written in **club time**, and this page is where the
club's time zone is recorded. Find it at `/admin/club-time`
(**Admin → Setup & Configuration → Club Time Zone**).

It is stored as a **place**, not as a number of hours: `Pacific/Auckland`, not
"NZT" and not "+12:00". That matters because a place carries its own
daylight-saving rules, so the platform knows on its own that New Zealand clocks
move in late September and early April, and it keeps knowing when the rules
change. A fixed number of hours would quietly be wrong for half the year.

**This is not your server's time zone.** They are two different things:

| | What it is | Who sets it |
| --- | --- | --- |
| **Club time zone** | The club's civil time — what every member sees, and when club-local scheduled work runs | You, here |
| Server / container time zone | The clock of the machine the software happens to run on | Whoever runs the server |

**Recorded here now; in force as the rest of the time-zone work ships.** This
page is where the club's time zone is *recorded*, and it is the setting the whole
product is moving onto. Today the times the site displays are still worked out
from the `TZ` value the server was started with. So while both exist, **keep the
two in step**: if you change the zone here, change `TZ` to match. What is already
true, and permanent: nothing on this page rewrites anything already recorded.

A member opening the site from London sees exactly the same club times as a
member standing in the lodge: the browser never converts anything to the reader's
own time. That part is already true.

Changing the club time zone on this page is a **Full Administrator** job. It
needs an explicit confirmation, and every such change is written to the audit log
with who made it and what it was before. (The one other way it can be set is
`npm run setup` at the command line, by whoever runs the server. That is not
audited the same way, because there is no signed-in administrator to record.)

## When you'd use it

- **First-time setup.** The setup checklist asks for it, and setup is not
  finished until a valid time zone is recorded.
- **You upgraded and want to check what was carried over.** An upgrade keeps the
  time zone the installation was already effectively using — it does not reset
  anyone to New Zealand — and this page is where you confirm that.
- **A club outside New Zealand is running this software.** Set the club's own
  zone here, and — while the note above still applies — set the server's `TZ` to
  match it.
- **The club genuinely moves**, or the zone was recorded wrongly at setup and
  displayed times have been out by an hour or a day.

## Step-by-step

*(No screenshot yet: this page is not in the screenshot harness manifest, so
following the [screenshot conventions](../STYLE_GUIDE.md#screenshot-conventions)
there is nothing to embed. It gets one when the manifest gains the page.)*

### 1. See the current club time zone

1. Open **Admin → Setup & Configuration → Club Time Zone** (`/admin/club-time`).
2. The page shows the zone in use and where it came from:
   - **Configured** — recorded in this installation's settings. This is the
     normal, finished state.
   - **From the environment** — nothing has been recorded yet, so the platform is
     still using the `TZ` value the server was started with. This is what an
     installation looks like between an upgrade and its next restart. Restarting
     the app records it; so does running `npm run config:self-heal`.
   - **Default** — nothing has been recorded and the server says nothing either,
     so the platform is using `Pacific/Auckland`.
   - **Not usable** — something *is* recorded, but it is not a zone this app can
     use: a hand-edit, or a restore that brought back a bad value. The platform
     falls back to `Pacific/Auckland`, and restarting will **not** repair it —
     only saving a zone here will. The page names the unusable value so you can
     see what is stored.

   The setup checklist has two further states the page does not. **Could not be
   read** means the setting itself could not be loaded — typically the database
   migration has not run yet, which is a deployment problem rather than a
   configuration one. And a **warning asking you to confirm the zone** means
   `Pacific/Auckland` was recorded because the server's `TZ` named no actual
   place, so nothing could be preserved from it; acknowledge it if that is right
   for your club, or set the real zone here if it is not.

### 2. Change it

1. Choose **Change time zone**.
2. Find the zone in the list. Type part of a city or region name to filter it —
   the list holds every zone the platform can use, named as `Region/City`.
3. Read the confirmation. It states plainly what changes and what does not (see
   below), and shows the current zone next to the one you have chosen.
4. Tick the acknowledgement, then **Save**.

If you are not a Full Administrator the page tells you so and offers nothing to
change. Ask a Full Administrator; the restriction is deliberate, because this
setting decides every displayed time in the product.

### 3. What changing it does and does not do

**It does not rewrite anything already recorded.** No stored date or time moves.
A booking made last winter still has the same nights; a payment still has the
same date; an invoice keeps its date. Nothing is edited, converted, or migrated.

**What does change:**

- **Which zone recorded moments are written in, from then on.** A booking created
  at a particular instant is still that same instant — it is simply written out in
  the new zone, so its date or clock time on screen can read differently.
- **The club-local hour overnight work runs at.** Scheduled jobs are set by a
  club-local time, so they move with the zone.
- **The deadline on payment links issued from then on, and the deadline the
  overnight job holds existing ones to.** A payment link for a booking request
  lasts until the end of the check-in day, and which moment that is depends on
  this zone. Links issued after the change get the new zone's deadline, which is
  what you want. The catch is the links **already out with members**: each keeps
  the exact moment it was issued with, because nothing recorded is rewritten — but
  the overnight job that cancels unpaid requests now works the new zone's day out
  afresh. So for a short window the two can disagree.

  It matters in one direction. If you move the club **eastward** — to a zone whose
  clocks are ahead of the old one, say from London to Auckland — the new zone's
  check-in day ends *earlier* in real terms, so the overnight job can cancel an
  unpaid request, release its beds and kill its payment link **before** the
  deadline the member was given. Up to about a day, in the extreme. Moving
  **westward** is harmless the other way about: the beds stay held a little past a
  link that has already stopped working, and the next night's run tidies it up.

  This only affects requests that were **already approved and still unpaid** when
  you changed the zone, and it clears itself as those are paid or lapse. If that
  set is not empty and you are moving the club eastward by more than an hour or
  two, the safe order is: change the zone, then look at
  **Admin → Booking Requests** for approved-and-unpaid requests, and re-send a
  fresh link to anyone whose check-in has not passed. A re-sent link is minted on
  the new zone, so it and the overnight job then agree exactly.

Both of those follow the note in **What it is** while `TZ` still exists: today the
displayed times come from `TZ`, and this setting takes over as the rest of the
time-zone work ships. Keep the two the same and the distinction never matters.

**Lodge nights are unaffected.** A stay is a set of calendar dates — "the nights
of 12 and 13 July" — and calendar dates are not converted by a time zone change.
That now holds in the emails as well: a night, a roster date or a season date in
a message is the day itself and no zone is consulted to write it, whether the
club has edited that template's wording or not. Only the moments in a message — a
payment deadline, a timestamp — follow this setting. See
[Email messages](email-messages.md).

**The membership season is decided from this zone.** "Which membership year is it
now?" is a club decision, so it is answered from the club's day here rather than
from the server's. That matters on exactly one day a year — the first day of the
month after the club's financial year-end, 1 April by default — where a club and
a server in different parts of the world can be on different sides of the
boundary. It decides which season a new member's first subscription is charged
for, which age band a date of birth falls in and therefore which price a bed is
quoted at, and which season's rates a stay is priced against. Setting this zone
correctly is what makes those agree; the club's financial year-end month itself is
set separately, under membership settings.

If you change the zone, expect to spend a moment reading a few recent records
before assuming something is wrong: a timestamp that now reads a day earlier or
later has not moved, it is being written in a different zone.

## Settings reference

| Setting | What it controls | Default | Constraint |
| --- | --- | --- | --- |
| **Club time zone** | The club's civil time: every date and time shown to a member, and the club-local hour scheduled work runs at | `Pacific/Auckland` on a brand-new installation with nothing else configured | An IANA zone identifier naming a place, e.g. `Pacific/Auckland`, `Australia/Sydney`, `America/Denver`. Abbreviations (`NZT`, `EST`), fixed offsets (`+12:00`, `Etc/GMT-12`), single-word aliases (`NZ`, `Japan`) and the `Etc/*` / `SystemV/*` families are refused. Full Administrator only; confirmation required; audited |

The related environment variables `TZ` and `NEXT_PUBLIC_TZ` are now a **seed
only**. They are what an existing installation's time zone is copied *from*, once,
on the first start after the upgrade. After that the recorded setting is the
authority and changing them does not change the club's time. See
[`CONFIGURATION.md`](../../CONFIGURATION.md) → App Defaults.

## Troubleshooting

| Symptom | Cause | Fix |
| --- | --- | --- |
| The setup checklist says the club time zone is not recorded yet | The installation has been upgraded but not restarted since, so nothing has been written to the settings yet. The zone in use is still correct — it is the one the server was started with | Restart the application, or run `npm run config:self-heal`. Then reload the setup checklist |
| The setup checklist warns that the club time zone could not be confirmed | The server's `TZ` names no actual place — `UTC`, `Etc/UTC`, `Etc/GMT-12` — so there was nothing to preserve and `Pacific/Auckland` was recorded instead. The platform is telling you it guessed | If the club is in New Zealand, acknowledge the step and carry on. If it is not, set the club's real zone here — this is the one case where leaving it alone would leave a non-NZ club's times wrong |
| A time zone will not save: "abbreviations and fixed offsets are not accepted" | The value is not a place — for example `NZST`, `EST`, `+12:00`, or `Etc/GMT-12` | Choose the named zone for the club's location, such as `Pacific/Auckland`. Use the filter box rather than typing an abbreviation |
| The page says it is available to full administrators only | Your admin account is not a Full Administrator | Ask a Full Administrator to make the change. Everyone with admin access can still see the current zone on the setup checklist |
| Times moved by an hour after a change, but only some of them | Expected. Recorded moments are re-displayed in the new zone; calendar dates such as lodge nights are not converted at all | Nothing to fix. If the zone itself is wrong, change it back — no data was altered either way |
| Times look wrong and the club time zone is correct | Something outside this setting is formatting a date on its own | This is a defect, not a configuration problem. Raise it with the club's technical contact and quote `INV-CONFIG-002` |
| A scheduled job still runs at the old time after a zone change | Expected, and it needs an action. The nightly jobs read the zone once when the application starts, so they keep the old one until it is restarted | Restart the application. Until you do, **Admin → Setup & Configuration → System health** says so in a banner on the Cron Jobs section, and shows the zone the jobs are **actually running** alongside the one that has been configured |
| A job is due at 2am and the clocks change that night | One hour is skipped in spring and one happens twice in autumn, and several nightly jobs are scheduled between 2am and 3am | Nothing to configure. The zone panel warns about this at the point of change; if a job matters on those two nights, ask the club's technical contact to move it outside that hour |
| A member says their payment link stopped working before the date they were given, shortly after the club's zone was changed | The link was issued under the old zone and keeps the exact deadline it was issued with; the overnight job now works the check-in day out in the new zone, and if the new zone is ahead of the old one that day ends earlier. So the job cancelled the request and revoked the link first. Nothing was lost or miscalculated — the two were simply measured in different zones | Re-send the member a payment link from **Admin → Booking Requests**. A new link is issued on the current zone, so it and the overnight job agree. To avoid it in the first place, re-send links to approved-and-unpaid requests straight after moving the club eastward — see **What changing it does and does not do** above |
| Someone changed the zone and nobody knows who | It is audited | **Admin → Audit Log**, action `CLUB_TIME_ZONE_UPDATED`. The entry names the administrator, and the zone before and after |

## Related links

- [Site & Setup guides index](../adopters/README.md) — the operator hub for
  configuration pages.
- [`CONFIGURATION.md`](../../CONFIGURATION.md) — the `TZ` / `NEXT_PUBLIC_TZ`
  environment variables and what they still do.
- [`docs/invariants/product-configuration.md`](../invariants/product-configuration.md)
  — `INV-CONFIG-002`, the developer-facing rule this page implements.
- [`docs/invariants/booking-dates-and-capacity.md`](../invariants/booking-dates-and-capacity.md)
  — why a lodge night is a calendar date and is never time-zone converted.
- [Setup checklist guide](setup.md) — where the club time zone appears during
  first-time setup.
- [Audit Log guide](audit-log.md) — reading the record of a change.
