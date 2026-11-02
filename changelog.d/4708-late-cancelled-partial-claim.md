- **A Xero job that stalled and then came back cancelled or only partly done no
  longer undoes an officer's Retry.** If a stuck Xero job was reset and an
  officer pressed Retry, the old run could still arrive afterwards and close
  the queued job as cancelled or part-done, so the Retry never ran. The job now
  stays queued for the Retry to run. When the old run had already made
  something in Xero (a part-done invoice or credit note), the app does not
  record it over the queued job: it adds an entry to the audit log each time
  the old run reports back, and sends finance officers one Xero sync error
  alert naming it and what it left unfinished (for example an invoice email
  that failed), so they can check Xero for a duplicate and finish that part by
  hand: the Retry may not redo it. A retried group invoice that was already
  raised now closes as done instead of staying stuck as running.
