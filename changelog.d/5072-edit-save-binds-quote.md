- **Saving a booking edit can no longer settle a different amount from the
  preview the member approved (#4924).** The amount shown before Save used to
  be worked out again when the edit was saved, so if the club day moved into a
  later change-fee band, or a rate or promotion changed, in between, the
  booking could be charged or refunded a figure nobody had seen.

  Save now checks its figures against the preview the member was looking at.
  If they differ, nothing is saved or charged: the edit stays open, the panel
  says what the amount was and what it is now, and shows the new preview so
  the member can review it and save again. This covers an ordinary edit of one
  booking; accepting a linked move of two bookings together is not yet bound
  to its preview.
