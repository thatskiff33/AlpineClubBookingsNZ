- **The club's membership season is now worked out from the club's own calendar,
  not the server's (#2870).** Everything keyed on a membership year — which
  season a subscription is charged for, which age band a date of birth falls in
  and therefore which price a bed is quoted at, which season's rate a stay is
  priced against, which membership type a member counts as holding — was decided
  from the month showing on whichever machine the site happens to run on. For a
  server anywhere west of Greenwich that is the wrong month for part of every day,
  and on the one day of the year the financial year turns over it is a whole
  season out.

  **The day that matters is 1 April** (or the first of whatever month follows the
  club's own financial year-end, if the club has set a different one). For a
  server behind Greenwich, the whole of that day was still being treated as the
  previous season.

  **The most serious case was approving a new member.** Approving a membership
  application creates that member's first subscription charge and queues the
  matching Xero invoice, and neither can be edited afterwards. If the approval
  happened on the financial-year boundary, both could be written against the wrong
  season — the season the server thought it was, not the season the club was in.
  That is now the club's own day, read from the timezone set at
  **Settings → Club time**.

  **What an operator will notice.** Nothing, on any normal day, and nothing at all
  for a club whose server sits in New Zealand — a timezone ahead of Greenwich
  cannot produce the shift. On the day the financial year turns over, screens and
  charges that could previously disagree about which season it was now agree. A
  handful of admin screens that could show two different seasons in one place — a
  member's detail page, a bulk membership assignment, the subscriptions filter —
  now read the season once and show the same answer throughout.

  **Two screens were reading a season that was fixed when the site was built**,
  rather than the club's. The subscriptions page and the membership-types page
  both worked their default season out from a value baked in at build time, which
  meant every viewer saw the same answer and it was not necessarily the club's.
  Both now use the club's configured timezone. The subscriptions page also had the
  April year-start written into it directly, so a club that moves its financial
  year-end will now be followed there too.

  **A Xero invoice's season was being decided two different ways.** Two nearly
  identical rules had grown up for working out which membership season a Xero
  invoice belongs to, and one of them took the month the season starts while the
  other took the month the financial year ends. They are now one rule, so the two
  cannot drift apart and quietly disagree by a month.

  **AI Diagnostics was asking one question two ways.** The booking-and-membership
  evidence pack worked out "which season is this booking's stay in?" and "which
  season is the club in now?" through a single helper, which is what forced it to
  read the server's month. Those are genuinely different questions and are now
  answered separately, so a diagnostic finding about a member's subscription no
  longer depends on where the container is running.

- Anything holding a stored lodge night, date of birth or season edge now reads it
  as the plain calendar day it is, with no timezone applied at all, and **refuses**
  a value that carries a time of day instead of quietly rounding it down. That
  refusal immediately found a place where a booking's own stay dates were missing
  and the old code had silently substituted today's date — so a hosting check was
  being judged in whichever season the site happened to be in rather than the
  booking's.

- **Approving a membership application, importing members from Xero and creating a
  member by hand are all a little quicker, and none of them can now get the season
  wrong under load.** Working out which season the club is in means reading the
  club's timezone from the database, and in a handful of places that read had ended
  up inside the same database transaction that approves the application — where it
  competed for a connection with the work it was part of. Worse, that read is
  written to keep going rather than fail if the database is momentarily busy, so a
  slow moment could have produced a quietly wrong season, and on the membership
  approval path the season chooses the joining fee written onto an invoice that
  cannot be edited afterwards. The season is now worked out once, before that
  transaction starts, and passed in. A Xero member import used to do the same read
  once per contact; it now does it once for the whole import, which also means one
  import can no longer classify its first and last contacts into different seasons.
