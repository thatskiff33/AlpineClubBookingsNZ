- **Three small corrections to the Opening Credits and Exempt tax category
  checks (#4988).** They come from the review of the opening-credit import.

  The Xero health check and the configuration import's warning now say what
  happens on a card booking when Exempt has no usable rate: the booking's Xero
  invoice operation fails, and an officer retries it from the **Xero
  Operations** list once Exempt is mapped. Both used to say only that spent
  opening credits wait in the Xero queue, which is true of other bookings.

  **Clear** on the Exempt tax category is now refused while Xero is
  disconnected too, where the **Opening Credits** account is mapped and the
  club is, or is scheduled to be, GST-registered. Before, it could be cleared
  while disconnected, and spent opening credits then stalled once the same
  Xero organisation was reconnected. A mapping chosen in a different Xero
  organisation from the one connected now still clears.

  The Xero health check now reports an **Opening Credits** account stored on
  the Xero account another mapping uses. The account mapping already refuses
  to save that, so it can appear only when two people save mappings, or one
  saves while a configuration import runs, at the same moment. If the line
  appears, choose an account for Opening Credits that no other mapping uses.
