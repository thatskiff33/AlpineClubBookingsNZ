- **The expected arrival time now refuses times it was never meant to accept, and says so.** The
  booking screens have only ever offered times on the hour and half hour, but the two places that
  check what arrives — creating a booking, and editing the time afterwards — accepted `:10`, `:20`,
  `:40` and `:50` as well, while the message beside the check said "30-minute increments". The rule
  is now written once, matches the picker exactly, and its message names the real rule ("on the hour
  or half hour"). Existing bookings are untouched: nothing re-checks a stored time, so a booking that
  somehow carries `5:20 PM` keeps showing it, and the next edit through the picker moves it onto the
  half hour. Off-step times could only ever have been sent by something talking to the API directly,
  never by the app.

- **Editing an arrival time no longer says "Saved" when it was not.** The editor on your booking page
  reported success as soon as the request came back, whatever the answer was — so a time the server
  refused was announced as saved and left on screen, and only a page reload revealed it had not been.
  It now checks the answer, puts the control back to the stored time, and shows what the server said
  ("Cannot update arrival time after check-in date has passed", for instance) instead of a green
  "Saved".

- **Setting or clearing an arrival time is now recorded in the audit log.** Neither wrote an entry
  before, and a Full Administrator or Booking Officer may set the time on any member's booking — so
  there was no way to see who changed it, or to tell a member's own edit from an officer's. Both now
  record one, under the **Booking** category, naming the booking's owner and whether someone acted on
  their behalf. Clearing a time also records the time it removed, which is otherwise lost. There is no
  history for changes made before this release.

- **The arrival-time dropdown now has a name a screen reader can read.** All three places that show it
  already had a visible "Expected Arrival Time" label whose markup pointed at the dropdown — but the
  dropdown never carried the identifier the label was pointing at, so the connection did not exist and
  the control was announced as an unlabelled list reading "Not sure". The label markup looked correct
  in every one of them, which is why this went unnoticed.
