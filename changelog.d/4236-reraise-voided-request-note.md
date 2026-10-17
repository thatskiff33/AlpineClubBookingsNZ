- **Raise a fresh credit note for a refund request whose note was voided in
  Xero (#4214).** When a refund request is paid back by bank transfer, the
  booking system raises that request's own credit note in Xero. If the
  treasurer later voids that note in Xero, nothing raises a new one by itself,
  because the note was voided for a reason, and before this release the
  officer had to raise the replacement by hand in Xero.

  Xero Operations now lists each such request under **Voided refund request
  notes**, with the voided note, the amount and the payment. An officer with
  finance edit access can press **Raise a fresh credit note** and confirm.
  This queues one new note for the same amount, and Xero receives it under a
  new key, so it cannot hand the voided note back. The refund itself is not
  touched. Two officers pressing at once still queue only one note, and the
  button is refused once the request has a live note again. Each press is
  recorded in the audit log under Xero. Officers with view-only finance
  access see the list but cannot press the button.

  Retry, Requeue and Retry all still refuse such a request's note, and their
  message now points to the new button. A row of such a request on Xero
  Operations shows that message instead of a Retry button. The booking repair
  tool's message points to it too.

  Deploying: no database change. A note queued by this release is raised the
  same way by the previous release if you roll back.
