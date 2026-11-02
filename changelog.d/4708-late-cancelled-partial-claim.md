- **A Xero job that stalled and then came back cancelled or only partly done no
  longer undoes an officer's Retry.** If a stuck Xero job was reset and an
  officer pressed Retry, the old run could still arrive afterwards and close
  the queued job as cancelled or part-done, so the Retry never ran. The job now
  stays queued for the Retry to run. When the old run had already made
  something in Xero (a part-done invoice or credit note), the app does not
  write it over the queued job. It adds an entry to the audit log each time
  the old run reports back, and sends finance officers one Xero sync error
  alert naming it and what it left unfinished (for example an invoice email
  that failed), so they can check Xero for a duplicate and finish that part by
  hand. That happens even when the Retry has already finished, or is still
  running, by the time the old run reports back, because the Retry may not
  redo the unfinished part. A retried group invoice that was already raised
  now closes as done instead of staying stuck as running.
