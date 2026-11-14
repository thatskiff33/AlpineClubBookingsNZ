- **A release can no longer be tagged on a commit that has no images (#4989).**
  Every merge to `main` now gets a CI run that finishes, instead of a later
  merge cancelling it, so each `main` commit gets its app and migrator images.
  `pnpm run release:cut publish` also asks GitHub whether the commit's CI run
  published them, and refuses before tagging if it did not, naming the run and
  how to re-run it. Before this, a busy day could leave a release tag pointing
  at a commit whose deploy failed with "not found".
