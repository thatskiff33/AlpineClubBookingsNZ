- **Booking confirmation emails now carry add-to-calendar links (fork #35).**
  The confirmation lists three links for the stay: a calendar file (`.ics`)
  download that works in Apple Calendar and most other apps, and one-click
  "add this event" links for Google Calendar and Outlook.com (personal
  Microsoft accounts; work Microsoft 365 accounts use the `.ics` file
  instead). Each puts the stay
  in the recipient's calendar as all-day entries from check-in through the
  checkout day — no times, matching how lodge nights work. The download link
  carries its own signed key, so it works from the email without signing in;
  it expires 60 days after checkout, and it stops serving a booking that was
  later cancelled or bumped (an event already added to someone's calendar
  stays until they remove it — the email for a cancellation does not yet carry
  a matching removal). Re-downloading after a date change updates the existing
  calendar entry rather than adding a second one. Clubs that edit the Booking
  Confirmed template control the section with the new `{{ical}}` token;
  existing saved overrides are unaffected until an admin chooses to add it.
