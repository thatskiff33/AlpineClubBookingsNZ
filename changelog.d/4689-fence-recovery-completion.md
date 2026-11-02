- **A card payment request for money still owed is no longer lost when a
  stalled background retry wakes late (#4675).** A retry that had stalled long
  enough to be handed to another retry could still mark the job finished,
  so the second retry's payment request was dropped and the member was never
  asked for the money. A retry can now only finish a job it still holds.

  Nothing changes for operators. In the rare case a refund is made by a retry
  that had already been handed on, the member's "we refunded you" email and
  the admin alert for that refund are not sent; the refund itself is made and
  recorded as before.
