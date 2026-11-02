- **A Xero job that stalled and then failed late no longer undoes an officer's
  Retry.** If a stuck Xero job was reset and an officer pressed Retry, the old
  run's failure could arrive afterwards and mark the job failed again, with the
  old error, cancelling the Retry and possibly raising the repeated-failure
  alert. That late failure is now set aside: the job stays queued, the queued
  run goes ahead and records its own result, and the old run is counted as
  skipped rather than failed.
