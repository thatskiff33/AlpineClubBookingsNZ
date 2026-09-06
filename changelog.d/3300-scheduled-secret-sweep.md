- **The repository is now swept for secrets on every branch, once a week, and a
  finding there no longer freezes anybody's merge (#2852).** The blocking check
  on a pull request is deliberately scoped to `main` and to the change in front
  of it: it walks every branch and one leak on somebody's abandoned branch would
  turn a required check red on every open pull request, unfixable by the person
  whose branch it is not. But a secret on an unmerged branch of a public
  repository is public whether or not anyone ever merges it, so the wide scan is
  still worth having. It now runs as its own scheduled job — every branch's
  history plus the checked-out files, weekly and on demand — where a finding is
  a task rather than a merge freeze. It reports the rule, file, line and commit
  in the run's summary and keeps a redacted report for a fortnight; the matched
  value itself is never printed.

- **Both scanners are now provably the same scanner (#2852).** The version, the
  container digest and the exact way it is invoked are written down once, in one
  file each, and the blocking gate and the weekly sweep both call it — so a
  version bump cannot land on one and miss the other, and a test fails if any
  workflow, script or document names a scanner of its own. This is not a
  hypothetical tidy-up: the two secret-scanning jobs this project used to run
  were on different versions of the tool for months, over the same commits, and
  nothing said so.

- **A secret scan that fails can no longer look like a secret scan that found
  nothing (#2852).** The tool exits with the same code when it finds a leak and
  when it cannot run at all, so the shared runner now separates them and says
  which happened. It also refuses a subtler false green found while building
  this: when the underlying `git` command fails — an unresolvable commit range,
  or a repository ownership refusal — the scanner logs the error, reports "0
  commits scanned, no leaks found", and exits successfully. A scan of nothing is
  now a failure, on the blocking gate as well as the sweep, because zero commits
  is never a legitimate answer here.
