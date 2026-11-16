- **Browser tests now warn when they pass only after a retry (#4991).** Each
  CI browser job lists these tests and their failed attempts in its job summary.
  Retries still keep an otherwise passing run green; missing or unreadable
  reports fail loudly so test instability cannot disappear silently.
