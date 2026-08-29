- Booking edits whose exact refund or credit cannot be read from the booking's
  own stored price history now hold the money as an explicit club-review task
  instead of it being guessed. The stay change still saves; the amount waits for
  an admin, who prices it from the booking's payment and rate history, enters the
  confirmed figure with a note, and only then does any money move. An amount that
  is not yet known is recorded as unknown rather than as `$0.00`, and a repeated
  or retried edit can only ever raise one review task.
- Closing a refund task at `$0.00` is now refused. Recording a completed refund
  of nothing said in the booking's history that money went back when none did;
  where the club reviews an adjustment and decides nothing is owed, the task is
  dismissed with a note instead. Completing a task that is a credit rather than a
  refund of a card payment no longer records a refund either, because no refund
  is made — the club's action is still recorded in the audit log.
- An admin who enters a refund larger than the club ever took on that payment is
  now told so plainly. The refusal itself is unchanged; before, it was reported
  as an unexplained failure.
