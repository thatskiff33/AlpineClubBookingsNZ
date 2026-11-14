- **An open pull request no longer fails the documentation check just because
  `main` gained a new rule after the branch was cut.** For a pull request, the
  check that merged rule ids are never deleted now compares the branch with the
  point where it left `main`, rather than with `main`'s latest commit. A branch
  that only falls behind passes; a branch that deletes a rule it started with
  still fails and names it. If the check cannot find that branch point (for
  example, a shallow checkout), it fails with a clear message rather than
  guessing.

  This is for contributors only. Nothing changes for club members or
  administrators.
