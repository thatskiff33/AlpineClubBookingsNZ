- **The upgrade runbook no longer describes the v0.10 upgrade, and a release
  cannot be cut while the upgrade documents are out of date (#4979).** The
  production upgrade runbook now covers any jump from one release to a later
  one, and its staging rehearsal record is a blank template an operator fills
  in offline. The privacy-retention steps that sat above the guide's
  Unreleased section now sit inside it, and that section opens with one
  ordered checklist for the release.

  `pnpm run release:cut prepare` now refuses while the runbook names a release
  older than the current one or a release-specific section sits outside the
  Unreleased block, and it moves the Unreleased steps under the new release's
  heading as part of the release commit. The release checklist in
  `docs/MAINTENANCE.md` adds the upgrade-documents step.
