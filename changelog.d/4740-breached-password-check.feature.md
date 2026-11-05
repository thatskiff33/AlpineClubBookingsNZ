- **A new password that has already leaked in a public data breach is now
  refused (#4610).** Until now a password only had to meet the club's length
  and character rules, so a password reused from a breached website was
  accepted, and those are the passwords attackers try first.

  When someone changes their password, chooses one from a reset or
  account-setup link, or an officer sets a kiosk password, the app now checks it
  against a public list of breached passwords and asks for a different one if
  it is listed. The password never leaves the server: only the first five
  characters of a one-way code made from it are sent, and the comparison is
  made by the app. Passwords already set are not re-checked, and sign-in is
  unchanged.

  The check is on by default. A club can switch it off under **Admin → Login &
  Security → Password policy**. If the breach list does not answer within three
  seconds the password is accepted, so an outage never stops anyone setting a
  password. A server that restricts outbound traffic must allow HTTPS to
  `api.pwnedpasswords.com` for the check to work (`CONFIGURATION.md`).
