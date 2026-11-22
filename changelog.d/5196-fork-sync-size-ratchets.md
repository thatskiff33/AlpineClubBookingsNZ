- **A deployment fork can sync down from upstream without re-declaring
  upstream's file and function lengths (#5196).** `pnpm run quality:budget`
  takes `--upstream-ref <ref>`, and CI passes it when the fork sets the
  repository variable `QUALITY_BUDGET_UPSTREAM_REPO`. Files and functions the
  sync brings in are judged against the longer of their length on the fork's
  base and on that upstream commit, so code left as upstream wrote it passes,
  while anything the fork itself lengthens is still refused or needs its own
  allowance. Allowance fragments identical to upstream's are treated as spent.
  Nothing changes for this repository, or for a fork that leaves the variable
  unset.
