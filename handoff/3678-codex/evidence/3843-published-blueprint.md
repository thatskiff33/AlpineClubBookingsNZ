# Dependency audit blocks reviewed work on an unpatched braces advisory

## What happens today

The required dependency audit now rejects otherwise reviewed branches because `braces@3.0.3` has a newly reviewed high-severity stack-exhaustion advisory. This prevents the officer-quote/school epic #3678 and other work from reaching a green merge gate. The locked dependency did not change when the advisory was refreshed.

[GHSA-vfj7-8cjw-p6xm](https://github.com/advisories/GHSA-vfj7-8cjw-p6xm) affects every published version through 3.0.3; no patched release is available. The current required audit reports one high finding. Deep brace patterns below the package's character limit reproduced `Maximum call stack size exceeded` through both public compile and expand APIs on Node 24.

## Impact and proposed outcome

Maintainers and adopting clubs need a verifiable mitigation before this security gate can become green. The sole locked path is the development dependency `eslint-config-next -> @next/eslint-plugin-next -> fast-glob -> micromatch -> braces`. Production-only audit is clear, but the Docker runner copies the builder's complete dependency tree, so this is not evidence that the package is absent from deployed images.

Proposed outcome: apply a reviewed bounded-depth patch to the exact package and make the canonical audit gate recognize **MITIGATED**, visibly retaining the advisory, only when the reviewed patch and dependency inputs match and the approval has not expired. This requires a new, narrowly bounded security-policy contract, so implementation awaits owner plan review.

## Alternatives considered

- **Wait for upstream:** safe and acceptable; audits and affected PRs remain red until a fixed release exists.
- **Ordinary upgrade:** current published Next ESLint and fast-glob releases still reach the affected braces version.
- **Ignore the GHSA or audit production dependencies only:** does not repair the package; the existing required wrapper deliberately rejects count/report inconsistencies and offers no approved exception mechanism.
- **Replace the glob engine or prune the runner dependency tree:** changes a broader compatibility/deployment contract than this repair needs.

Recommendation: review and apply the exact upstream patch with the verified, expiring mitigation contract below; otherwise wait for upstream. Existing #3755 approval does not authorize this new advisory or policy change.

## Blueprint for owner review

**Risk:** High. **Release shape:** separate standalone issue, branch and PR targeting `main`; this repair is independently complete and must not be bundled into epic #3678. No database, booking/payment lifecycle, lock or live-provider changes.

1. Review [upstream PR #72](https://github.com/micromatch/braces/pull/72), currently unmerged, at exact commit `d0d575e55e74a4e0218e5248fafb79efc3e54ebb`. Its immutable email patch has SHA256 `152af73bccc5e483ea0212ab795495e80e2903d92794f3e45baa81002f39dcec`; this is not a substitute for the final pnpm runtime-patch digest. Limit the installed patch to the five production files implementing parser and AST walker depth bounds; retain licensing. Independently establish compatibility and mitigation rather than relying on upstream test claims.
2. Register only `braces@3.0.3` in pnpm `patchedDependencies`; generate and verify a frozen lock/install. Copy the patch directory into Docker's dependency stage before frozen install. Verify every reachable occurrence uses the reviewed patch.
3. Add one per-issue fragment in `dependency-mitigations.d/` recording GHSA/package/version, upstream source, owner decision, expiry `2026-10-10T00:00:00Z`, patch path and SHA256, and exact reviewed workspace/lock SHA256 values. Dependency-input changes invalidate acceptance until reviewed again. The final patch/input digests are computed from the implemented bundle and reviewed before merge.
4. Preserve the unfiltered audit report and native exit. The canonical install-free wrapper may report MITIGATED only for a complete, nonempty report with native exit 1, exactly one high advisory and no critical finding, this exact GHSA/range, only the reviewed version/dev path, and matching digests/path/expiry. Reject duplicates, missing findings, extra advisories, unfamiliar report shapes, altered/unapplied patches, changed inputs and expired approval. Keep the original advisory visible; never report this raw result CLEAN.
5. Retain both audit jobs. Route the advisory dependency-review audit step through the same canonical wrapper if approved. Preserve required-job execution, outage handling and fail-closed malformed-report behavior; no threshold change, production-only audit, `continue-on-error`, environment bypass or job-level skip.
6. Update the maintenance/security/CI contract and directory entry guidance plus the issue's changelog. Scope is the patch/registration/lock, one mitigation fragment and its contract, canonical audit script and focused tests, the advisory audit step, and Docker patch copying.

## Validation and acceptance

- Reproduce the defect before repair; prove bounded rejection for strings and direct ASTs, boundary acceptance and normal glob compatibility using installed public APIs. Bound mutant execution in child processes; mutate each parser/walker guard and restore exact bytes.
- Prove patch application and every locked occurrence with frozen install. Validate both raw audit's still-visible advisory and the canonical MITIGATED result, including bare-checkout execution without installed dependencies.
- Mutation-test missing/changed patch and dependency digests, exact identity/path, expiry, duplicate/extra findings, malformed counts and report/exit disagreement. Existing outage and inconclusive results remain failures.
- Validate Docker dependency installation and actual build/trace/module contents through approved local/CI infrastructure. Do not infer deployed reachability from a development trace.
- Run focused checks, lint, generated-client typecheck and documentation gates; CI owns the full suite, build and security gates. Independent security/policy reviews and owner PR approval are required before merge.

## Recovery and stop conditions

Revert the complete patch/mitigation/gate/workflow/Docker bundle together; the raw audit returns to red until a fixed release exists. No data rollback. Retire the patch and acceptance when a usable fixed release is published, re-auditing without mitigation. Extension past expiry or altered sealed inputs requires a new reviewed change and explicit owner approval.

Stop if exact application/compatibility fails, wider dependencies or install-policy changes are needed, another unpatched copy or application-input path is discovered, audit identity/report completeness cannot be proved, or the gate needs broader acceptance. Keep the check failed in those cases.

## Current decision

Owner plan review pending. Read-only investigation is complete; no patch, audit-policy change or suppression has been implemented.
