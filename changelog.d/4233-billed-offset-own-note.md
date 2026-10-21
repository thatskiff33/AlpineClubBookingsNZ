- **A booking-repair credit note no longer waits for a credit note that will
  never be raised, and a Xero operation that succeeded no longer shows an old
  error (#4049).** When a price reduction cancelled an unpaid card request
  that the booking's Xero invoice had already billed, the booking system
  raises an invoice-correction credit note for that part. That note waits for
  the change's own credit note, if the change raises one. If the repair tool
  had to queue the correction note itself, it guessed whether the change
  raised its own note. It guessed wrongly when the change gave back applied
  credit with nothing paid by card, or when an organiser's card refund raises
  the note. The correction note then waited six hours and appeared as a
  second item for a person to review.

  Each change now records on its history whether it raises its own note, and
  the repair tool reads that record. Changes made before this release have no
  record, and the repair tool uses its old reading for them. At worst that
  holds the note for a person to review, and it never raises the note in the
  wrong order.

  A Xero operation that succeeds, including after an operator's retry, no
  longer keeps an earlier attempt's error code and message, and the Xero
  Operations and record-activity panels never show an error line on a
  succeeded operation. Previously such a row could still show an old message,
  such as "BILLED_OFFSET_AWAITING_OWN_NOTE", in red. Operations that succeeded
  before this release keep the old text in the database, but the panels no
  longer display it.
