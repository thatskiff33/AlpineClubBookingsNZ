- **A Xero job that stalled and then came back cancelled or only partly done no
  longer undoes an officer's Retry.** If a stuck Xero job was reset and an
  officer pressed Retry, the old run could still arrive afterwards and close
  the queued job as cancelled or part-done, so the Retry never ran. The job now
  stays queued and the queued run records its own result. When the old run had
  already made something in Xero (a part-done invoice or credit note), the app
  does not record it over the queued job: it adds one entry to the audit log
  and sends finance officers one Xero sync error alert naming it, so they can
  check Xero for a duplicate.
