- **The adult-member hosting rules were reorganised into smaller files, with
  nothing about the rules themselves changed (#3128).** No booking behaves
  differently, no message or refusal has changed wording, and no threshold has
  moved. The code that decides whether a party has adult cover was one
  3,051-line file; the parts that never needed the rest — the refusal a member
  is shown, the limits that bound how many bookings one check reads, the check
  run before a booking is saved, and the re-check run when two member records
  are merged — now live in files of their own.

  **Why it was worth doing.** A file that size is where mistakes hide, and the
  size allowance written for it during the Club Time work said outright that it
  should be split rather than excused. Nothing here is a new decision: the code
  was moved rather than rewritten, and the explanatory notes travelled with the
  code they explain.
