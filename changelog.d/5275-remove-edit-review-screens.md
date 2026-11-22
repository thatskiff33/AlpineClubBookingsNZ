- **The officer review screens for booking changes are gone (#4344).**
  Every booking change has been priced automatically since #4317, and the club's
  clean-up settled or closed every review that was still open, so the screens
  that priced reviews by hand have been removed: the settle box on the finance
  queue (its direction, amount and per-night price boxes, the cash-or-bank
  question and the still-owed line) and the **Nights whose sold price the
  records cannot tell us** tool on a booking's Admin tools card.

  The finance queue lists no review and offers none to put back; a page left
  open from before the change shows one read-only, and closing it is refused
  with a sentence saying the review was retired. Every other item on the queue
  works as before.

  Nothing about the money changes. A review that was settled or closed is still
  in the booking's history and audit log, and any refund, credit or charge it
  made is still in the booking's payments and in Xero.
