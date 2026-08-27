- Booking edits whose exact refund or credit cannot be read from the booking's
  own stored price history now hold the money as an explicit club-review task
  instead of it being guessed. The stay change still saves; the amount waits for
  an admin, who prices it from the booking's payment and rate history, enters the
  confirmed figure with a note, and only then does any money move. An amount that
  is not yet known is recorded as unknown rather than as `$0.00`, and a repeated
  or retried edit can only ever raise one review task.
