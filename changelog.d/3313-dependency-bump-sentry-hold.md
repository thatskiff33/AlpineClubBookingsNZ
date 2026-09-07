- **Routine library updates, with one library deliberately left behind (#3313).**
  Seventeen of the third-party libraries this system is built on were due for
  their regular update. Sixteen have been taken. The seventeenth — the service
  that reports errors to the club's monitoring — ships a release that fails while
  it is being loaded, so it is held at the version already running until its
  authors fix it. The reason and the exact condition that lifts the hold are
  written down in the maintenance guide, so nobody has to rediscover them.

  Nothing changes for anyone using the site. This is housekeeping, and it is
  recorded because a library held back on purpose looks identical to one that was
  forgotten.

- **An internal safety check was re-aimed after a library fixed the behaviour it
  was watching for (#3313).** One of the libraries used to check incoming requests
  has closed a gap the diagnostics tools already guarded against themselves. The
  guard stays, because the fix is only partial. Nothing an operator or member sees
  has changed, and no record was ever written incorrectly.
