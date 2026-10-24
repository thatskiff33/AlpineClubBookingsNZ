- **A Xero task that loses a start-up race to a failed twin now tries again
  instead of failing by mistake (#4338).** The app keeps at most one live Xero
  task per document. When two parts of the app started the same task at once,
  the second was told to use the first one's task; if the first had already
  failed in that split second, the second failed with a database error instead.
  It now starts its own attempt, as a retry a moment later would, so it makes
  one more call to Xero, which can fail again and add one failed entry towards
  the repeated-failure alert. If the first task had succeeded, part-succeeded,
  been cancelled or been marked resolved in Xero by an officer, the second
  still stops with the same error as before. The clearest case was
  applying a member's credit to a booking twice at once while the credit note
  had been used in Xero outside the app: the ledger was brought into line
  correctly, but one run showed as failed, and the second run's failed
  allocation could stay on the Active failures list. Both runs now finish, and
  every failed allocation from the pair is closed, and the second close is
  recorded in the audit log, when the ledger is brought into line. No credit balances, invoices or Xero records change.
