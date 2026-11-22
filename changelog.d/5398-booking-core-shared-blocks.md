- **Booking code written out more than once now lives in one place (#5398).**
  Confirming a booking, saving it as a draft and joining the waitlist now send
  the reason for booking children without an adult the same way. A blank reason
  is never sent as an empty value, which the server refused with a generic
  "Invalid input". Members see no difference today: continuing to payment and
  joining the waitlist already stop a blank reason on screen, and a draft
  already reached the server's own message. The paid-booking confirmation
  email, booking-request approvals, member address copying, lodge hold
  conflicts, partner-link removal and the non-member hold after a date change
  each now run one shared piece of code, with no change to what they do.
