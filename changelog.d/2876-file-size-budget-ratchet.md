- **The file-size budgets are now enforced, as a ratchet rather than a cliff
  (#2687).** The repository has documented size budgets for route handlers,
  page shells and domain modules, but nothing checked them — the report that
  was supposed to flag oversized files compared against a hand-maintained list
  of nine. At the initial baseline after `main` commit `aafbd08f3`, 281 of the
  1,903 production files were over budget and carried 131,709 lines of size
  debt. Three of the nine recorded line counts were wrong by two orders of
  magnitude, so the one artefact that looked like enforcement was the least
  accurate thing in the repository.

  A check in the blocking CI job now enforces the budgets. Existing debt is
  allowed to stay; what fails is a file that newly goes over budget, or a file
  already over budget that grows. Shrinking is always accepted, and the smaller
  length becomes the ceiling the next change is measured against, so removed
  debt cannot quietly return. (When this entry was written the check compared
  against a checked-in list of every over-budget file, kept up to date by hand
  with its own command. Neither reached a release — both were replaced first, by
  the change described under #2979 below.)

  Nothing about the code itself changed, and no production file had to be
  altered to make the tree pass. A contract pins the public package command to
  the blocking `verify` job. The gate's TypeScript tests under
  `scripts/__tests__/` are now covered by `npm run typecheck` (#2875); existing
  JavaScript/MJS Vitest files are loaded by the test project but remain outside
  static `checkJs` analysis until #2693 converts that boundary.
