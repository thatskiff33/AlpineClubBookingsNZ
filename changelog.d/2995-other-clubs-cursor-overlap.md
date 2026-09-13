- **Another club's details can no longer go permanently stale in the Alpine
  Central Server download (#2995).** The nightly download remembers how far it
  got and next time asks the central server only for entries changed since then.
  That is safe only if changes become visible in the order they were stamped,
  and they do not: two entries saved at the central server at nearly the same
  moment can become visible out of order, and an entry caught on the wrong side
  of that gap was stepped over and never asked for again. The club's page kept
  showing an old booking officer or phone number, indefinitely, while the sync
  reported success every night.

  Each download now deliberately re-asks for a short window it has already
  covered — the last minute before where it got to — which closes that gap. You
  will not notice it: the re-offered entries are recognised as identical and
  written nowhere, so they do not appear as changes in the download summary, and
  an entry your club edited more recently is still never overwritten by the
  older copy the server holds. Nothing changes about the first download after
  you connect, and nothing changes about what your club uploads.

  The re-ask needs the central server to mark its place with a timestamp, which
  is what the Alpine Central Server does. A server that marks its place with a
  reference of its own instead gets no overlap — there is no way to ask for "a
  minute before" a reference — and the application log now says so on each such
  download, because the summary looks identical either way.
