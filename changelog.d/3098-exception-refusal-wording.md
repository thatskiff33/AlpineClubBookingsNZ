- **A refused booking-exception approval no longer blames a change that never
  happened (#3089).** When a Booking Officer approved a policy-exception request
  that could no longer be applied, they were told "the live booking has changed
  since this request was made", or "the booking policies have changed since this
  request was reviewed". Sometimes that was true. Sometimes nothing had changed
  at all and a corrected date reading simply worked the request out differently
  than it had been recorded — and the officer went looking for an edit nobody had
  made.

  The system cannot tell those two situations apart, so it no longer claims to.
  The refusal now says that the request can no longer be applied as it was
  reviewed, or that the exceptions it needs are not the ones that were reviewed,
  confirms that nothing has been changed, and asks the officer to have the member
  submit it again so the current situation can be reviewed.

  When a request is refused, and whether it is refused, are exactly as before —
  only the wording changed. The one refusal whose cause really is known, a
  request stored before the current approval format, keeps its own clearer
  message.
