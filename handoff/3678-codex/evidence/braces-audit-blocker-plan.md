# Braces dependency-audit blocker: owner-review blueprint

Audience: Owner, Developer, Agent. Investigation date: 2026-10-03.

Status: READ ONLY. No dependency/config/code edit, install, worktree creation, suppression, push, GitHub write, full suite or provider operation. This is a separate main-targeted High-risk dependency/security issue; neither #3794 nor prior #3755 approval authorizes its implementation or a new audit acceptance mechanism.

## Recommendation and decision needed

Recommend owner review of the exact upstream PR72 bounded-depth patch for braces@3.0.3, installed through pnpm patchedDependencies, together with a narrowly verified, expiring MITIGATED audit verdict for this one GHSA. The verdict must depend on the reviewed patch bytes and sealed dependency inputs, not package name or dev-only classification. If the owner declines that new audit contract or independent patch review cannot establish safety, wait for a published upstream fix and keep Dependency audit red. Current policy provides no approved way to green this finding merely by ignoring its GHSA.

Proposed decision: authorize the reviewed local mitigation plus its exact evidence-verifying gate, with expiry 2026-10-10T00:00:00Z (seven days), or choose to wait for upstream. Earlier publication of a usable fixed release retires the local patch/acceptance immediately. Any extension or change of patch/dependency inputs requires a new reviewed diff and explicit owner approval.

## Verified blocker

- [GHSA-vfj7-8cjw-p6xm](http[historical local path omitted]): GitHub Reviewed High, CVSS8.7, CVE-2026-93687; published Sep18, reviewed/updated Oct2. Affected braces<=3.0.3; patched versions: none. Recursive AST walkers have no depth guard. Inputs below the character limit can exhaust the call stack.
- Registry queries today confirm braces latest3.0.3. Both cached b0 CI jobs report the same real advisory, not an advisory-service outage: `handoff/3678-codex/evidence/3794-dependency-audit-job.log` and `3794-dependency-review-job.log`. The required job fails with high1 and no fixed release; native audit exits1.
- During investigation root advanced the dedicated3413 HEAD to c265eb2474dc6af53ed0ff7b79f70720ba730571. Current origin/main is 0678af38bf5947faca72111fdf4b08af27b75158. Both lockfile blobs equal 9011cfec9e0348cf9a6a1cbf32a518982ea891ed. The advisory changed while this dependency lock did not.

## Complete dependency graph and exposure

`pnpm why braces`, a reverse graph over every pnpm-lock.yaml importer/snapshot dependency and optionalDependency, and `pnpm list --lockfile-only --depth Infinity --json braces` agree: one version, one reachable root path, devDependencies only:

alpine-club-bookings-nz -> eslint-config-next16.3.6 -> @next/eslint-plugin-next16.3.6 -> fast-glob3.3.1 -> micromatch4.0.8 -> braces3.0.3.

Ranges: Next plugin pins fast-glob3.3.1; fast-glob accepts micromatch^4.0.4; micromatch accepts braces^3.0.3. Lock packages and snapshots each contain exactly one braces entry. Resolved physical import chains confirm these versions; selecting arbitrary stale virtual-store directory names is not evidence of the active version.

Raw full audit: advisory numeric id1240992, stable github_advisory_id GHSA-vfj7-8cjw-p6xm, findings version3.0.3, the exact path above, dev=true/optional=false/bundled=false, patched_versions=null. Complete counts: high1, other severities0; totalDependencies1098. `pnpm audit --prod --audit-level=high --json --config.fetch-retries=0` exits0, no advisories, totalDependencies658. These establish logical dev reachability, not runtime image absence.

Runtime findings:

- No imports of braces/micromatch/fast-glob were found in src/, scripts/ or prisma/. Next16.3.6 has no `next/dist/compiled/braces` or `next/dist/compiled/micromatch` module. Two Next source mentions of micromatch are explanatory comments, not imports of this package.
- The actual Next ESLint fast-glob caller is dist/utils/get-root-dirs.js. It glob-matches only configured settings.next.rootDir strings. The current resolved ESLint config (`eslint --print-config` parsed with native JSON) has nextSettings=null and hasNextRootDir=false, so its default directory is context.cwd. No application request-input route to the vulnerable function was identified.
- In-memory Next nodeFileTrace of installed server/lib/start-server.js and server/next-server.js reads3273 files and finds no braces/micromatch/fast-glob paths. It emits141 warnings and is not a built application trace. This worktree has no .next/standalone/server.js or built .nft.json files. Therefore no deployed standalone absence claim is justified from this diagnostic alone.
- Dockerfile installs full dependencies in deps and the runner copies `/app/node_modules` wholesale from builder as well as copying `.next/standalone`. Thus the dev-only package can be physically present in the runtime image. Pruning that tree is a separate product/deployment change and is outside the proposed issue.

Local vulnerability reproduction with the unmodified installed package, default Node24.15.0: pattern `'{' repeated4998 + 'a,b' + '}' repeated4998` is9999 characters; both braces(pattern) and braces.expand(pattern) throw RangeError with message Maximum call stack size exceeded. Expand also throws at depth4500/9003chars. At depth4000 both returned on this platform; thresholds depend on runtime. Errors were caught in the diagnostic process. No package source was changed.

## Upstream candidate and upgrade alternatives

[Upstream PR72](http[historical local path omitted]) is OPEN, not merged or released. Its one commit is d0d575e55e74a4e0218e5248fafb79efc3e54ebb. The page shows one public non-maintainer approval and zero checks; this is not maintainer approval. The author reports899 passing Mocha tests. That result was not independently run in this read-only investigation.

[Immutable upstream patch](http[historical local path omitted]) was fetched into memory:11500 UTF8 bytes, SHA256152af73bccc5e483ea0212ab795495e80e2903d92794f3e45baa81002f39dcec. Eleven changed files: two docs, five production JS files, four test files. This is the upstream email-patch digest, NOT the future pnpm runtime-patch digest.

Source review: constants exports MAX_DEPTH100. parse limits combined brace/parenthesis nesting; compile, expand and stringify separately bound recursive child-node depth for caller-supplied ASTs. Finite caller maxDepth can lower the limit, but cannot raise it above100; non-finite values use100. The upstream tests cover direct ASTs, parser rejection, allowed boundary and lower limits. Scope the actual installed patch to lib/constants.js, lib/parse.js, lib/compile.js, lib/expand.js and lib/stringify.js. Review against the exact npm3.0.3 contents, preserve license, and port meaningful regression/compatibility tests into the repository.

Ordinary upgrade does not fix this today: registry eslint-config-next latest16.3.8 pins Next plugin16.3.8, whose dependency still pins fast-glob3.3.1. Fast-glob latest3.3.3 still requires micromatch^4.0.8. No released braces fix exists. Direct substitution with brace-expansion or another glob engine is not a compatible replacement for braces' parse/compile/expand/stringify API and options. Replacing fast-glob or removing Next's lint rules changes directory matching or coverage and has no verified narrow compatibility proof here. Prefer the five-file upstream patch over those changes if an immediate mitigation is approved.

Primary package sources: [braces registry](http[historical local path omitted]), [Next plugin16.3.8 registry](http[historical local path omitted]), [fast-glob3.3.3 registry](http[historical local path omitted]).

## Existing policy and proposed bounded gate

Read AGENTS/core and routed security/supply-chain material, docs/MAINTENANCE.md Dependency Policy/override register/advisory failure contract, CONTRIBUTING.md pnpm contract and docs/agents/CODEX_WORKFLOW.md. Current audit-dependencies.mjs is install-free and fails closed on missing/non-numeric counts, malformed reports, zero audited packages, service failures and exit/count disagreements. It explicitly records that pnpm11 ignoreGhsas removes an advisory from the list and native exit but leaves its metadata count: it does NOT clear the required gate. MAINTENANCE currently authorizes upgrades/registered overrides, not expiry exceptions. [pnpm audit documentation](http[historical local path omitted]) describes ignore settings, but does not supersede repository policy.

A pnpm patch preserves package version3.0.3, so the registry advisory remains even when the installed code is mitigated. [pnpm patch](http[historical local path omitted]) supports exact-version patchedDependencies and fails application errors under v11. Use exactly braces@3.0.3, not a name-only or range patch; do not permit unused/non-applied patches.

Smallest sound acceptance shape for owner review:

1. Commit the exact reviewed runtime patch at patches/braces@3.0.3.patch; register only that exact version in pnpm-workspace.yaml; regenerate pnpm-lock.yaml through authorized pnpm tooling.
2. Add one per-issue mitigation JSON fragment under dependency-mitigations.d/. It records exact GHSA/package/version, upstream commit URL, owner decision issue, expiry, runtime patch relative path and SHA256, plus SHA256 of the exact reviewed pnpm-workspace.yaml and pnpm-lock.yaml bytes. Those dependency-input digests seal the graph/registration/lock patch metadata without introducing an install-dependent YAML parser into the bare-checkout gate. Approve them only after frozen-install proof that every reachable braces copy is patched. Any dependency/config change invalidates the acceptance until re-reviewed; this conservative maintenance cost is intentional and explicit.
3. Preserve the unfiltered `pnpm audit --audit-level=high --json` report and native exit. Permit a new MITIGATED outcome only when it is a complete nonempty report, native exit1, high exactly1/critical0, the sole failing advisory is this exact GHSA/package/range, every finding is version3.0.3 on the reviewed dev path, and all approved digests/expiry/path constraints match. Reject duplicates, missing findings, unfamiliar report shapes and any second failing advisory. No count subtraction and no generic name/GHSA ignore list.
4. Print the original finding, exact patch/decision/expiry and MITIGATED verdict. Do not label the raw report CLEAN. Keep outage retries/timeout unchanged and preserve failing malformed/inconclusive cases. Expiry or any proof mismatch stays red.
5. Keep both jobs running. The advisory dependency-review job currently invokes bare pnpm audit and would remain red after a patch; route that step through the same canonical wrapper if the owner approves consistent mitigation semantics. Retain its existing advisory remit. Required Dependency audit gets no job-level if/needs, no continue-on-error, no prod-only audit, no threshold change and no environment bypass.

This is a new security-policy contract requiring explicit owner plan review. It is not authorized yet. A patch alone reduces the code defect but does not green raw pnpm audit; an ignore alone neither mitigates it nor clears the required wrapper.

## Proposed bounded implementation scope

Separate main-targeted issue/branch/PR, High risk, reviewed before implementation. Touch only the runtime patch, pnpm-workspace/lock, one mitigation fragment plus its directory contract, canonical audit script/targeted tests, the advisory-review step if accepted, Docker dependency-stage patch COPY, and relevant maintenance/security/CI contract documentation plus per-issue changelog. Docker must copy patches into deps BEFORE frozen install; current Dockerfile copies only manifest/lock/workspace and Prisma there. Do not prune runtime dependencies, replace glob grammar, bump unrelated packages, alter install-script allowBuilds or change booking/payment/provider behavior. No database/lock/lifecycle mutation is part of this issue.

## Validation required after approval

- Root prepares an isolated physical dependency tree. Apply the patch with pnpm's supported patch tooling, generate the lock and run frozen install. Verify resolved braces3.0.3 file contents match the five reviewed upstream changes and every graph occurrence is patched. Produce/check the final runtime-patch and dependency-input digests; the upstream email-patch digest cannot substitute for them.
- Installed-public-API regressions: reject depth101/4998 strings deliberately before stack exhaustion; accept depth100 and stricter valid boundaries; reject direct deep/cyclic AST input for compile/expand/stringify; test maxDepth0/1/100/101/Infinity/NaN, braces plus parentheses, escaped braces/quoted/malformed inputs. Use bounded child processes so a mutant cannot hang CI. Demonstrate current unpatched implementation fails the regressions and removing each parser/walker guard kills its corresponding case.
- Compatibility: representative brace lists/ranges, escaped braces, extglob/parentheses and fast-glob directory matching used by the Next lint caller; meaningful lint-config/guard cases, repository lint and typecheck. Independently execute the upstream regression suite or record a precise inability; author899 is not local proof.
- Audit gate tests with real report shape: original/advisory-only ignore still fail; reviewed patched bundle gives MITIGATED; modified/missing patch, changed workspace/lock, added unpatched occurrence/version/path, duplicate/second GHSA, extra high/critical, expiry boundary, malformed/partial counts, zero packages and non-agreeing exits all fail. Missing advisory list with nonzero counts remains red. Mutation verification must remove digest/expiry/exact-identity checks one by one and see the relevant tests fail.
- Bare-checkout/no-node_modules execution proves the gate remains install-free. Raw pnpm audit must still visibly report the GHSA while the canonical wrapper reports verified MITIGATED; that difference is expected and must be disclosed. No blanket suppression.
- Docker deps/image build in approved local/CI infrastructure proves patch COPY and frozen application. Inspect actual generated app .nft.json/standalone contents and runner module sources for additional copies; runtime image may carry dev modules. No live deployment/browser/provider scanning.
- Focused local tests/lint/typecheck/docs/index/budget/workflow gates; full suite/build/security jobs remain CI-owned. Independently scoped adversarial security/policy review and explicit owner merge approval.

## Rollback, retirement and stop conditions

Rollback the entire coherent dependency/mitigation change together: patch registration/file, sealed fragment, audit-contract/workflow changes and Docker COPY. Raw required audit returns to failing until an upstream fix exists; never retain green acceptance after removing the patch. No data rollback is needed. When a usable patched release is published, update within upstream-compatible ranges, remove local patch/acceptance, re-audit unfiltered and repeat compatibility/image checks.

Stop for owner review if the patch differs from immutable PR72 semantics, fails exact application or compatibility, needs wider dependency/install-script changes, exposes another bundled/unpatched copy or an application-input route, cannot prove every locked occurrence is patched, or needs any broader/malformed-report acceptance. No extension past expiry without new owner review. If the approved mechanism cannot be proved install-free or CI shape differs, remain failed rather than guessing.

## Read-only command evidence and limits

Executed: pnpm why braces; native pnpm audit full and prod JSON (full nativeexit1, prodexit0); pnpm list --lockfile-only --depth Infinity --json braces; registry pnpm view queries; lock YAML reverse graph; physical createRequire resolution; installed depth reproduction; in-memory Next nodeFileTrace; eslint --print-config parsed with native JSON; source/cached-log reads and Git lock-blob comparison. No install or build was run. An initial PowerShell JSON parse of ESLint config failed on case-distinct ai/AI keys; the subsequent native JSON parse succeeded and is the evidence used above. No independent patched-code or upstream Mocha run was performed. Standalone/deployed reachability remains a validation requirement, not a claimed result.
