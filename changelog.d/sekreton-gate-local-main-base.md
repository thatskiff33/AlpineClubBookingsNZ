- **Sekreton's `fast-censuses` and `migrations` gates no longer fail in a
  sandbox without an `origin` remote.** One shared helper,
  `scripts/ci/sekreton-prepare-base.sh`, now sets up the `origin/main` they
  compare against: it fetches GitHub's main when there is a remote, and
  otherwise uses the sandbox's local snapshot of main, which may be older. PR CI
  remains the authority.

  This is for contributors and operators of the agent pipeline only. Nothing
  changes for club members or administrators.
