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
- **Email bodies are now edited in a rich editor — bold, italic, underline,
  lists and alignment, styled as you type (fork #38).** The Admin → Email
  Messages body editor works like the message board's composer: select text,
  use the toolbar, and see the styling in place; Preview still shows the
  exact email a member receives, and `{{tokens}}` work exactly as before.
  Colours, fonts, sizes, images and links are deliberately not offered, so
  every email stays on the club's theme in every mail client — and anything
  pasted from elsewhere is reduced to the allowed formatting on save, so
  pasted content can never reach a member as raw markup. Wording saved
  before this release keeps rendering exactly as it always has until an
  admin re-saves it from the new editor (it opens as plain paragraphs, ready
  to format).
- **The add-to-calendar links on booking confirmations are now icons (fork
  #41).** Instead of three written-out links, the confirmation shows three
  tappable icons — a calendar-file tile for the `.ics` download, a
  Google-Calendar tile and an Outlook.com tile — hosted by your own site
  like the club logo, so no third-party image service is involved. When a
  member's mail app blocks images, each icon still reads as its service
  name, and the links work exactly as before.
- **The add-to-calendar icons now appear in customised email wording too
  (fork #43).** A club that has written its own Booking Confirmed body sees
  `{{ical}}` render the same three icons as the built-in message — calendar
  file, Google Calendar, Outlook.com — instead of long written-out web
  addresses, with the service names shown when a mail app blocks images.
  Members never see the raw links, and the editor's Preview shows the icon
  row exactly as it sends.
