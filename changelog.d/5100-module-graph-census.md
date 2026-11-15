- **Internal tidy-up of how the booking, payment and Xero code fits together
  (#4930).** Several money modules used to load each other in a loop, which
  could make a page or a scheduled job fail depending on which part of the
  app started first. The loops are gone, an old all-in-one Xero module has been
  retired in favour of the focused ones behind it, and an automated check now
  stops new loops being added. Nothing a member or administrator sees has
  changed.
