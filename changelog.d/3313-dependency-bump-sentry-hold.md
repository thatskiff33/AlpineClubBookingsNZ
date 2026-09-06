- **Routine library updates, with one library deliberately left behind (#3313).**
  Seventeen of the third-party libraries this system is built on were due for
  their regular update. Sixteen have been taken. The seventeenth — the service
  that reports errors to the club's monitoring — ships a broken release that
  refuses to start, so it is held at the version already running until its
  authors fix it. The reason and the exact condition that lifts the hold are
  written down in the maintenance guide, so nobody has to rediscover them.

  Nothing changes for anyone using the site. This is housekeeping, and it is
  recorded because a library held back on purpose looks identical to one that was
  forgotten.

- **A gap in how tool calls are recorded in the audit log has closed upstream, and
  the checks that watch for it were re-aimed (#3313).** The diagnostics tools keep
  a permanent audit record of what each call asked for. One of the libraries doing
  the checking used to quietly delete certain special field names from a request
  before that record was written, which meant two different calls could be written
  down identically. The system already refused such requests itself, so the audit
  record was never actually wrong — but the checks proving it stayed correct have
  been rewritten to match what the updated library now does, and two new ones added
  to cover the case it still gets wrong.
