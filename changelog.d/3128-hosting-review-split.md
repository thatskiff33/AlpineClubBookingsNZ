- **The adult-member hosting engine was split into smaller files, with nothing
  about the rule itself changed (#3128).** At 3,051 lines
  `adult-member-hosting-review.ts` was the third-largest file in the system, and
  the size allowance written for it during the Club Time work said outright that
  it should be split rather than excused. Four self-contained pieces moved into
  files of their own: the refusal a member is shown when a booking has no adult
  cover, the ceilings that bound how many bookings one check will read, the
  preflight that judges a party before it is saved, and the plan that re-checks
  hosting cover when two member records are merged.

  **Nothing an administrator or a member does behaves differently.** No rule, no
  message, no refusal and no threshold changed. The code was moved rather than
  rewritten: of 461 lines relocated, four were altered, and all four are the
  single word that makes a function visible to the file it moved out of. Every
  one of the 153 explanatory comment lines that travelled with the code is
  character-for-character identical to what it said before, checked by machine
  rather than by eye.

  **Why it is worth doing at all.** A file this size is where mistakes hide. The
  Club Time migration had to thread a change through it and found the size the
  main obstacle; the pieces now separated are the ones that never needed to know
  about the rest. The engine still holds everything that turns a saved booking
  into a hosting answer, which is the part that genuinely belongs together.
