- **Groundwork for a new finance-queue item: an amount the club may not have
  asked for (#3213).** When a booking change is settled as money a member owes,
  the club raises a Xero invoice for it. Once in a while that settlement lands in
  the seconds while the invoice is already being sent, and an invoice in that
  state cannot be changed.

  The club deliberately does not invoice the extra automatically. A send that has
  started is not proof a send finished: the job can come back to the queue and go
  out later at the full amount, and if a second invoice had been raised in the
  meantime the member would be billed twice for one change. Until now the amount
  was recorded only in the booking's audit history, where somebody had to happen
  across it.

  It will become a row in the **Money to settle by hand** card on
  `/admin/payments`, saying which booking and how much, telling the officer to
  check the booking's Xero invoices first and bill only what is missing — never
  the change's full total — and then to close the row with a note saying what
  they found. Closing it moves no money and there is no control that does: unlike
  every other row in that card, this one has nothing for the club to pay or to
  take, and the system refuses a settlement against one however it is asked. One
  withheld amount can only ever produce one row, however many times the recovery
  pass runs over the same booking change, so nobody is asked to check the same
  thing twice.

  **Nothing has changed on screen yet, and that is on purpose.** A database
  change like this one has to be released a step ahead of the code that uses it,
  or the version still serving members during an upgrade meets rows it does not
  understand — which here would have taken down the whole "money to settle by
  hand" list, including real refunds the club owes people. So this release
  prepares the ground and the next one turns it on. Until then a withheld amount
  is recorded in the booking's audit history exactly as it has been, naming the
  change and the total in plain words.

  Operators need do nothing. There is no setting to choose and no data to
  migrate.
