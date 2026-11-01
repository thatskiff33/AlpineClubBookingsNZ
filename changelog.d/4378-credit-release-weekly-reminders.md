- **Members asked to pay for account credit used elsewhere are now reminded
  weekly, can pay by bank transfer, and the older cases are picked up.** The
  request for credit that was used elsewhere in the club's accounts is emailed
  at once, then reminded every 7 days, four reminders after the request (five
  emails at most); after that only the officers' queues chase it, and the
  reminders carry on after the stay has ended. Where the club has written its bank
  details (a new "Bank transfer details for a payment request" message under
  Admin → Booking messages), the email offers a bank
  transfer as well as card, quoting the booking's Xero invoice number as the
  payment reference, and the request closes when Xero shows the invoice paid. The
  transfer is offered only when it would pay exactly what is asked; if Xero shows the
  invoice part-paid, the automatic reminders stop and the officers are told in the
  audit log, rather than the member being asked to pay by card what may already be paid.
  Every screen and email now says why a request exists (a booking change, credit
  used elsewhere, or both, when a change was made while the request was unpaid and
  the two became one). Credit released before the requests were switched on can be
  asked for in small, audited batches behind a second switch (see
  `docs/xero/ARCHITECTURE.md`); each is re-checked against Xero first, so nothing is
  asked that is no longer owed.
  Credit released while a request for a booking change is still unpaid now waits for
  that request to be paid or withdrawn, however long it takes, and is asked for then;
  before, it gave up after a few retries and was never asked for.
