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

  The check now works out what the code actually refers to in all three places.
  A price has to come from the same record the rest of the payload is being
  written from; a calculation has to come from the one agreed helper, not from
  anything that merely hands that helper the right-looking figure; and two
  decisions count as one only when they can be shown to be one value rather
  than two matching spellings.

  Reviewing that work found the repairs did not go far enough, and the rest of
  the change is the difference. Each of them could still be talked past by
  declaring a value that is allowed to change afterwards, which the check was
  reading as though it could not — so a price could be set correctly, quietly
  replaced on the next line, and still pass. The check now refuses a value it
  cannot show is the one that was worked out, while still accepting the case
  where the code itself rules the change out.
