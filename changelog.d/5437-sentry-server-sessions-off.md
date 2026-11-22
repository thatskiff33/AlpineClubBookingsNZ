- **The server no longer sends Sentry session data (#5262).** Server error
  reports carry the installed version so they can be sorted by release, and
  that tag is meant to be all it adds. With a server Sentry address set, the
  Sentry software was also sending two things of its own accord: a count of
  requests by outcome for each minute, with the version and environment, and
  session updates for the server process when an error was reported before its
  first request, or when it exited without serving one. Both are now switched off. The request counts held only
  the minute, the totals, the version and the environment.

  Error reports and performance traces are unchanged and still carry the
  version. Sentry gets no session data from the server for its release-health
  figures. Nothing to set or change.
