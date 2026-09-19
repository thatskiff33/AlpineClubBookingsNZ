- **The safeguard that stops a booking's headline price being written without
  being worked out properly is now harder to talk past (#3544).** Nothing a club
  does day to day changes, and no price, invoice or screen is different.

  The system keeps one agreed way of working out what a booking is worth, and an
  automatic check refuses any code that stores a booking's price without going
  through it. In three places that check was satisfied by code that merely
  looked right — a price copied from some other record because it carried the
  same field name, a calculation waved through because of what the function
  happened to be called, and two decisions treated as one because they were
  written in the same words. No code in the club system did any of those things;
  the concern was what someone could write next year and have the check accept.

  The check now works out what the code actually refers to in all three places,
  so a price has to come from the booking being edited, a calculation has to
  prove it used this booking's own figures, and two decisions count as one only
  when they really are one.
