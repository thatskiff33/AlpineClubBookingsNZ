- **Every step to do after a release is deployed now arrives with the release
  as one checklist (#5379).** A pull request whose change needs someone to act
  once it is deployed — run a report, map a setting, check a page — now writes
  that step as its own `changelog.d/<pr-number>-<slug>.deploy.md` file, saying
  who does it (owner, operator or officer), what to do, and how to check it
  worked. Before, these steps lived only in pull request descriptions and had to
  be collected by hand.

  `pnpm run release:cut prepare` files the steps under "After deploying this
  release" in the release's section of `docs/UPGRADING.md` and in its notes
  page, and refuses to cut, changing nothing, while one is malformed.
  `pnpm run release:cut publish` then opens a "vX.Y.Z post-deploy checklist"
  issue, assigned to the repository's owner (or to `--checklist-assignee
  <login>`), with one box per step linking the pull request it came from, and
  links it from the GitHub release. If the issue cannot be opened, the release
  is still published and the exact commands to open it are printed.

  The `verify` check (and `pnpm run pr:check`) now fails a pull request whose
  "Manual Checks Required" or "Migration Or Deployment Impact" section names a
  step for after the deploy without such a file, or whose file is malformed. A
  pull request with no such step answers "None. No after-deploy step.", which
  passes.
  The steps already gathered for the release after v0.14.0 (#5378) are written
  this way, so the next release produces that checklist itself.
