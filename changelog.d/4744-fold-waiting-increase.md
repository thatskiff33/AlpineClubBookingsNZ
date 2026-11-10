- **A second price increase no longer leaves out an earlier increase
  whose card request is still waiting to be retried (#4744).** When a
  price increase could not set up its card request (for example, during a
  card-provider outage) and the member changes the booking again before
  the retry runs, the new card request now includes that earlier increase.
  The member is asked once. The earlier retry is closed, and its Xero
  invoice, if one was waiting, is collected with the new card request. If
  that retry is in the middle of being set up, the edit is refused for a
  moment and can be saved again straight away. Otherwise no operator
  action is needed.
