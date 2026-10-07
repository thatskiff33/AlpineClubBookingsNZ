- **Every admin can now see the club's currency and locale; only a Full Admin
  can change them (#3596).** Until now the **Club Currency & Locale** page was
  for Full Admins only, so a treasurer or a bookings officer trying to work out
  why an amount or a date was written a certain way could not check the setting
  that decides it.

  Any admin can now open the page from **Admin → Setup & Configuration → Club
  Currency & Locale** and read both values, where each came from, and who last
  changed them. Admins who are not Full Admins see them read-only, under a note
  saying changing them needs Full Admin, and the **Change currency and format**
  button is greyed out for them. The server still refuses a change from anyone
  but a Full Admin. Nothing else changes: saving still needs the same
  confirmation and is still recorded in the audit log, and the Club Time Zone
  and Environment Safety pages stay Full Admin only to open as well as to change.
