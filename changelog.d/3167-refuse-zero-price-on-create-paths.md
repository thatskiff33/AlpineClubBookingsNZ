- **A booking can no longer be saved with a price of `$0.00` standing in for a
  price the system failed to work out (#3167).** Three places that write money
  onto a booking — adding a guest to an existing booking, creating a booking,
  and holding beds when a booking request is quoted — used to fall back to zero
  if the price list they were handed came up short of the nights or guests they
  were saving.

  Nothing in the club's current setup could produce that, and the callers were
  checked one by one before the change to be sure no member was relying on it.
  The reason for changing it anyway is that a zero cannot afterwards be told
  apart from a genuinely free night. It would not have shown up as the fault it
  was; it would have surfaced weeks later as an unexplained "needs review" on a
  completely different booking, when somebody edited it.

  These three now stop and report the fault instead of saving a zero, which is
  the same thing booking edits have done since the price-history work earlier in
  this epic. Nothing an operator does day to day changes.

  Two further places that write the same kind of money — approving a booking
  request, and repricing a booking when a waitlist offer goes out — never had
  that fall back to zero, but each was checking for the missing price in its own
  words. They now ask the same one question the other three ask, so the rule is
  written down once and a later change to it cannot reach some of these places
  and miss others. Nothing about what either of them does changes.
