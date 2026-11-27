- **Groundwork for bookings paid by a deposit, with the balance due later
  (#5008).** The app can now record that a booking was settled by a deposit
  smaller than its price: the booking is paid and keeps its beds, and the rest
  is held as one balance request with a due date. Nothing on any screen, email
  or scheduled job uses this yet, so clubs will see no change. Paying the
  balance, its reminders and the "part paid" wording follow in later releases.

  This release adds one empty date column for the balance's due date; no
  existing booking or payment changes.
