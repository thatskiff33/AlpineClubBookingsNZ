- **A second tap on Mark Arrived or Mark Departed no longer undoes the first
  (#4965).** On slow lodge Wi-Fi the kiosk used to give no sign a tap had
  registered, so a hut leader who tapped again checked the guest straight back
  out. The kiosk now tells the server which state it wants, so a repeated tap,
  retry or resent request changes nothing and leaves no "cleared" entry in the
  audit log. While a check-in, check-out or chore tick is saving, its button
  reads "Saving…" and cannot be pressed.

  A failed check-in, check-out or chore tick now shows its message under the
  row that failed and keeps it there until the hut leader dismisses it or the
  next tap on that row succeeds. It used to flash at the top of the page for
  three seconds. Screen readers now announce it. A kiosk page left open from
  before the upgrade keeps working as it did until it is reloaded.
