# CI Security Gates

Last updated: 2026-05-09

## GitHub Advanced Security Status

GitHub Advanced Security is not currently available for the private `thatskiff33/TACBookings` repository. Because of that, CI must not rely on `actions/dependency-review-action` or CodeQL SARIF upload as blocking security controls. Those GitHub-native checks require repository features that are not enabled.

## Adopted Blocking Gates

Until GitHub Advanced Security is purchased and enabled, CI uses these non-GitHub-native blocking gates:

- `dependency-review` runs `npm audit --audit-level=high --package-lock-only` on pull requests and fails for high or critical dependency advisories in the committed dependency graph.
- `verify` runs `npm audit --audit-level=high` after `npm ci`, so the installed dependency graph is also checked before lint, tests, and build.
- `static-analysis` runs Semgrep `1.161.0` with the `p/nextjs`, `p/typescript`, `p/javascript`, and `p/react` rulesets and fails on blocking findings.
- `gitleaks-full-repo` scans repository history for committed secrets.
- `gitleaks-pr-diff` scans the pull request commit range for newly introduced secrets.
- `docker-image-security` blocks critical Trivy image vulnerabilities and warns on high image vulnerabilities.

## Accepted Residual Risk

This is a formal risk acceptance and alternate-control resolution for issue `#213`: until GitHub Advanced Security is available, TACBookings will not have GitHub-native dependency-diff annotations, CodeQL upload into the code-scanning UI, or GitHub code-scanning alert lifecycle management. Maintainers must review CI logs and uploaded Semgrep SARIF artifacts instead.

This acceptance does not waive the blocking gates above. Pull requests and pushes must pass the independent dependency, static-analysis, secret-scanning, test, build, and image-security checks before release.

## Revisit Criteria

When GitHub Advanced Security is purchased and enabled for the repository:

1. Restore `actions/dependency-review-action` as the pull request dependency gate.
2. Restore CodeQL SARIF upload into GitHub code scanning as a blocking gate.
3. Keep or retire the independent Semgrep and npm audit gates based on the current risk review.
4. Update this document and the security findings tracker with the new GHAS-backed control state.
