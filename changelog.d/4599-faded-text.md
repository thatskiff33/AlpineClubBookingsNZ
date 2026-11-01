- **More greyed-out text is now readable, and says what state it shows
  (#4594).** Several screens faded text to show a state, which made it hard to
  read. They now keep their normal text and say the state in words:

  - On the admin booking calendar, past days keep their bed counts and "+N
    more" buttons at full strength; past days stay grey, and a screen reader
    hears "past".
  - On the lodge kiosk, a guest who has left shows a "Departed" tag and a
    dashed outline instead of fading.
  - When editing a booking, a guest you have taken off stays crossed out and
    gains a "Removed" tag.
  - On Notification Recipients, an alert an admin cannot receive now reads
    "Locked:" followed by the reason, and a screen reader reads that reason
    with the checkbox.
  - A member already added as a guest, and the page editor's fixed slug and
    menu order, are no longer faded.
