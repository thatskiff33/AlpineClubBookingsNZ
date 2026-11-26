- **A pull request that changes application code can no longer skip its
  changelog fragment by editing `CHANGELOG.md` directly (#5263).** When
  fragments came in (#2452), the changelog check also accepted a direct edit,
  so pull requests already open were not failed. Those have long since merged,
  and the allowance was letting new work bring back the merge conflicts the
  fragments ended, or put an entry into a section that was already released.

  The check now asks for a `changelog.d/` fragment or the no-entry marker, and
  its failure message says a direct edit does not count. The release pull
  request that compiles fragments into `CHANGELOG.md` still passes, because it
  changes no application code. Nothing changes for clubs running the app.
