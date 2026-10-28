- **Backup safeguards share one implementation (#4497).** Database dumps and
  restore validation now share process cleanup, timeout and diagnostic limits.
  Backup operation and error messages remain the same; no operator action is needed.
