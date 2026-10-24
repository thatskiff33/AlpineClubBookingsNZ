- **The braces dependency-audit mitigation is retired (#3851).** GitHub
  withdrew advisory GHSA-vfj7-8cjw-p6xm against `braces@3.0.3` on 23 October
  2026, and the dependency audit now reports CLEAN without it. The mitigation
  record, the local braces patch and its `patchedDependencies` entry are
  removed, and the lockfile drops the patch hash; no package version changes.
  The MITIGATED mechanism stays in place, with no live records, for any future
  advisory that has no fix. Deployments pick this up with the next image build.
