- **A change to a booking now says so when it could not apply the promo code
  (#3179).** When a member edits a booking and the club cannot work out the
  amount from the booking's own price history, the change still saves and the
  money waits for a person to confirm it. Nothing is repriced on that path — and
  that includes a promotional code the member added or removed in the same edit,
  which was quietly dropped. They got a success message, a changed booking, and
  no discount, with nothing anywhere saying why.

  The edit now tells them. Before saving, the edit panel says the promotional
  code will not be applied and why; after saving it holds the panel open with the
  same message instead of closing as though everything had gone through. The
  confirmation email carries the same sentence, and it is kept on the booking's
  own history so the office can see months later exactly what the member was
  told.

  The rest of the change — the dates, the people — still saves exactly as it did,
  and the message says exactly what became of each code involved. A code that was
  never applied is still free to use on another booking. A member who asked to
  REMOVE one is told it is still on this booking. A member who re-entered the
  code they already had is told it stays exactly as it was, discount and all,
  rather than being told it is unused — and where one code was being swapped for
  another, the message names both, so nobody is left wondering why their total
  still shows a discount. What a member is told is written in one place, so
  softening the wording is one edit that every screen and email follows.

  This closes the silence; it does not make the promotional code apply. Applying
  a promotion to a stay whose amount is already with somebody to check is a
  separate question, and a member who needs it is pointed at the club.
