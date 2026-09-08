- **A change of server language settings can no longer make the system tell an
  officer that a member altered a request nobody had touched (#3252).** When a
  member asks for an exception to a booking rule, the request stores a
  fingerprint of exactly what was proposed. An officer approving it later causes
  that fingerprint to be rebuilt and compared, so anything that changed
  underneath is caught. That check is doing real work and it stays.

  The fingerprint was built from the party sorted into name order, and the sort
  used whatever alphabetical rules the server happened to be configured with.
  Those rules are not the same everywhere: a surname with a space in it, or a
  name that differs only in capital letters, sorts in a different position under
  different settings. Nothing in the project pinned that setting, and an
  ordinary routine rebuild of the server image is enough to move it. Nothing was
  wrong today. Had it moved, though, every waiting request whose party ordered
  differently under the new rules would have been refused at approval on the
  grounds that the proposal had changed — and the officer would have been shown a
  message saying so about a request that was exactly as the member had left it.
  The problem would have looked like corrupted data rather than a settings
  change, and it would only have appeared weeks later, on approval.

  Anywhere an ordering becomes part of a stored fingerprint, the system now sorts
  in a way that cannot vary with the server's settings — not only in the
  proposal fingerprint, but in the two other places where the same failure would
  have re-appeared through a different door, including the record of which
  guest-nights lacked adult cover. Sorting for people to read — screens, emails,
  spreadsheets, reports — is unchanged and still uses proper alphabetical rules,
  which is correct there.

  Because the fingerprints of requests already on file were worked out under the
  old rules, they were re-derived as part of this upgrade, so that the fix itself
  could not refuse anything already waiting. That was checked against the live
  club's data first and found to affect no request at all — every request on file
  had already been decided — but it ships anyway, so a request submitted in the
  meantime is safe too.

  As a second line of defence the server image now states the language setting it
  was already using, so it cannot drift on its own. Nothing changes order
  anywhere in the product as a result.

- **Two smaller tidy-ups shipped with it, both about a name that misled the
  reader (#3250, #3251).** One internal helper was called "stable digest" and
  behaved differently from the shared function of that name everywhere else in
  the system, on the accounting-integration path; it now uses the shared one, and
  that was proven to change no stored value rather than assumed to. Another was
  named as though it produced the same thing as a shared function and did not
  quite; it keeps its own behaviour, which is the right one where it is used, and
  is renamed and documented so nobody unifies the two by mistake. Neither changes
  anything a member or an administrator sees.
