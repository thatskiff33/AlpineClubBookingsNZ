import { readFileSync } from "fs";
import path from "path";
import { describe, expect, it } from "vitest";

function readRepoFile(relativePath: string) {
  // Test helper: reads a fixed repo file under process.cwd(); relativePath is test-controlled, not user input.
  // nosemgrep: javascript.lang.security.audit.path-traversal.path-join-resolve-traversal.path-join-resolve-traversal
  return readFileSync(path.resolve(process.cwd(), relativePath), "utf8");
}

/**
 * Strip whole-line `#` comments so an assertion reads the DIRECTIVES.
 *
 * Recurring defect in this file: a comment explaining at length why a directive
 * must never be removed satisfies the guard that was supposed to notice the
 * directive going missing. Three of the assertions below were found green
 * against a deleted directive for exactly that reason.
 */
function directivesOnly(text: string) {
  return text
    .split("\n")
    .filter((line) => !line.trim().startsWith("#"))
    .join("\n");
}

describe("deployment image contracts", () => {
  it("lets production Compose use prebuilt app and migration images", () => {
    const compose = readRepoFile("docker-compose.yml");

    expect(compose).toContain(
      "image: ${APP_IMAGE:-${COMPOSE_PROJECT_NAME:-tacbookings}-app:local}",
    );
    expect(compose).toContain(
      "image: ${MIGRATE_IMAGE:-${COMPOSE_PROJECT_NAME:-tacbookings}-migrate:local}",
    );
    expect(compose).toContain("target: builder");
  });

  it("publishes app and migration images to GHCR after CI passes", () => {
    const workflow = readRepoFile(".github/workflows/ci.yml");

    expect(workflow).toContain("publish-ghcr-images:");
    expect(workflow).toContain("packages: write");
    expect(workflow).toContain(
      "APP_IMAGE: ${{ vars.GHCR_APP_IMAGE_REPOSITORY || format('ghcr.io/{0}/alpineclubbookingsnz-app', github.repository_owner) }}:${{ github.sha }}",
    );
    expect(workflow).toContain(
      "MIGRATE_IMAGE: ${{ vars.GHCR_MIGRATE_IMAGE_REPOSITORY || format('ghcr.io/{0}/alpineclubbookingsnz-migrate', github.repository_owner) }}:${{ github.sha }}",
    );
    expect(workflow).toContain("uses: docker/build-push-action@v7");
    expect(workflow).toContain("target: builder");
  });

  it("pins scanner actions and images away from default branch refs", () => {
    const workflow = readRepoFile(".github/workflows/ci.yml");

    expect(workflow).toContain("SEMGREP_IMAGE: semgrep/semgrep:1.161.0");
    // The gitleaks pin moved OUT of this workflow in #2852, because the
    // scheduled sweep needs the same binary and a second copy of a version
    // string is how #2686's 8.24.3-versus-8.28.0 split happened. The
    // assertion follows it; the census below proves that file is its only
    // home, which is the half a `toContain` here could never do.
    expect(readRepoFile("scripts/ci/gitleaks-image.sh")).toContain(
      "GITLEAKS_IMAGE=ghcr.io/gitleaks/gitleaks:v8.28.0",
    );
    expect(workflow).toContain("uses: aquasecurity/trivy-action@v0.36.0");
    expect(workflow).not.toMatch(/uses:\s+\S+@(master|main)\b/);
  });

  it("mounts scanner source checkouts read-only", () => {
    const workflow = readRepoFile(".github/workflows/ci.yml");

    expect(workflow).toContain('-v "$PWD:/src:ro"');
    expect(workflow).toContain('-v "$RUNNER_TEMP/semgrep-output:/out"');
    // gitleaks mounts from the shared script now (#2852). `:ro` is the load-
    // bearing half: a scanner has no business writing to the tree it reads,
    // and the report path is a separate mount for exactly that reason.
    expect(readRepoFile("scripts/ci/gitleaks-scan.sh")).toContain(
      '-v "$(host_path "${REPO_ROOT}"):/repo:ro"',
    );
    expect(workflow).toContain("${{ runner.temp }}/semgrep-output/semgrep-results.sarif");
  });

  // #2686. Each of the three gates below is a REQUIRED protected-branch check,
  // and each has a specific way of going quiet without going red — which is the
  // worst failure available to a security gate, because the checks list still
  // reads green. The assertions pin the exact shape that makes each one real.
  describe("required security gates (#2686)", () => {
    it("runs the repository's own Semgrep rules in the blocking gate, without dropping the registry packs", () => {
      const workflow = readRepoFile(".github/workflows/ci.yml");

      // The custom rules must be IN the blocking scan. Matched as the
      // backslash-continued argument line, because `--config .semgrep/rules`
      // also appears in the fixture-test step above it — so the plain substring
      // stayed green when the flag was deleted from the scan itself, which is
      // the only place that makes the rules blocking. Mutation-testing found it.
      expect(workflow).toMatch(/^ +--config \.semgrep\/rules \\$/m);
      // ...and the four registry packs must still be there beside them. Wiring
      // custom rules in by REPLACING the packs is the silent-coverage-loss the
      // issue's review focus names.
      expect(workflow).toContain("--config p/nextjs");
      expect(workflow).toContain("--config p/typescript");
      expect(workflow).toContain("--config p/javascript");
      expect(workflow).toContain("--config p/react");
      // The fixtures must run. A custom rule that has stopped matching anything
      // scans clean, which is indistinguishable from a rule that found nothing.
      expect(workflow).toContain(
        "semgrep --test --config .semgrep/rules .semgrep/tests",
      );
      // The fixtures are deliberate violations, so the scan must not read them.
      expect(workflow).toContain("--exclude .semgrep/tests");
      // `--error` is what turns a finding into a non-zero exit.
      expect(workflow).toContain("--error");
    });

    // #2841. GitHub's SARIF ingest does not act on `suppressions`, so every
    // justified `nosemgrep` comment used to mint a code-scanning alert that could
    // never be closed — and a dangerous new raw-SQL call would have arrived in
    // that list looking identical to the known-safe ones. The filter that fixes
    // it has two ways of going wrong quietly, and this pins both: publishing the
    // raw file again (the alerts come back) and filtering the AUDIT artifact or
    // the blocking scan (which would hide real findings).
    it("publishes filtered alerts while keeping the blocking scan and the artifact unfiltered", () => {
      const workflow = readRepoFile(".github/workflows/ci.yml");

      // The code-scanning upload consumes the FILTERED file.
      expect(workflow).toMatch(
        /sarif_file: \$\{\{ runner\.temp \}\}\/semgrep-output\/semgrep-results\.published\.sarif/,
      );
      // The build artifact keeps the RAW file — it is the audit record the
      // triage was measured from.
      expect(workflow).toMatch(
        /name: semgrep-sarif-\$\{\{ github\.run_id \}\}\n\s+path: \$\{\{ runner\.temp \}\}\/semgrep-output\/semgrep-results\.sarif\n/,
      );
      // The filter runs on the raw output and writes a separate file, so the
      // scan's own exit code was decided before it ever ran.
      expect(workflow).toContain(
        "node scripts/ci/filter-suppressed-sarif.mjs \\",
      );
      expect(workflow.indexOf("--sarif-output /out/semgrep-results.sarif")).
        toBeLessThan(workflow.indexOf("filter-suppressed-sarif.mjs"));
      // ...and `semgrep scan` must never be pointed at the published copy, which
      // would make the filter part of the gate rather than part of the report.
      expect(workflow).not.toContain(
        "--sarif-output /out/semgrep-results.published.sarif",
      );
      // Conditions stay at STEP level: a job-level `if:` on a required check
      // reports "skipped", which GitHub counts as SATISFYING branch protection.
      const staticAnalysis = workflow.slice(
        workflow.indexOf("  static-analysis:"),
        workflow.indexOf("  secret-scan:"),
      );
      expect(staticAnalysis).not.toMatch(/^ {4}if:/m);
    });

    it("keeps the gitleaks gate on one pinned container, covering the PR range, main's history and the tree", () => {
      const workflow = readRepoFile(".github/workflows/ci.yml");

      const scan = readRepoFile("scripts/ci/gitleaks-scan.sh");

      expect(workflow).toContain("name: Secret scan (gitleaks)");
      // One container for all three scopes, and since #2852 the same one the
      // scheduled sweep runs. The gate names the SCOPES; the script owns the
      // image and the flags.
      expect(scan).toContain('. "${SCRIPT_DIR}/gitleaks-image.sh"');
      // THREE scopes, and each covers a hole the other two leave.
      //
      // The PR range is the precise signal, and it carries the merge flag too
      // because a PR that merges `main` into itself to resolve a conflict would
      // otherwise have that resolution scanned by nothing.
      expect(workflow).toContain(
        'GITLEAKS_LOG_OPTS="--diff-merges=first-parent ${PR_BASE_SHA}..${PR_HEAD_SHA}"',
      );
      // The history scan is scoped to a RESOLVED ref, never `--all`.
      // `actions/checkout` with `fetch-depth: 0` materialises every branch as
      // `refs/remotes/origin/*`, so `git log --all` made this required check
      // hostage to a leak on anyone's unrelated branch — red on every open PR,
      // and unfixable from your own branch.
      expect(workflow).toContain(
        'GITLEAKS_LOG_OPTS="--diff-merges=first-parent ${HISTORY_SCAN_SCOPE}"',
      );
      // Asserted against the DIRECTIVES: the job's comment quotes `--all` at
      // length while explaining why it is gone, and a banned flag named in order
      // to forbid it must not read as using it.
      const directives = workflow
        .split("\n")
        .filter((line) => !line.trim().startsWith("#"))
        .join("\n");
      expect(directives).not.toContain("--log-opts=--all");
      // ...and the scope must be resolved with a hard failure when the ref is
      // missing. A required secret gate that quietly scans an empty range is
      // the whole defect class #2686 exists to close.
      expect(workflow).toContain("HISTORY_SCAN_SCOPE=$scope");
      expect(workflow).toMatch(/if \[ -z "\$scope" \]; then\n\s+echo "::error::/);
      // The tree scan is topology-independent: whatever is in the checked-out
      // files right now is covered however it got there, including a pull
      // request's merge PREVIEW, which is not any commit either patch scan
      // walks. Anchored to the `dir` mode the gate asks the script for.
      expect(workflow).toContain("bash scripts/ci/gitleaks-scan.sh dir");
      expect(scan).toContain("scan=(dir /repo)");
      // Non-zero exit on a finding, and no secret echoed into a public log.
      //
      // `--exit-code=2`, not 1, and that is #2852's acceptance criterion
      // rather than a preference: gitleaks exits 1 BOTH when it finds a leak
      // and when it fails to run, so on 1 alone a required gate cannot say
      // which happened. Measured against v8.28.0 while writing this --
      // clean 0, findings 2, fatal error 1, bad flag 126, unresolvable image
      // 125. Both outcomes still fail the caller, so nothing about what
      // blocks a merge changed. The discrimination is fail-closed in both
      // directions, and exit 0 is reachable only from gitleaks exiting 0.
      expect(scan).toContain("LEAK_EXIT=2");
      expect(scan).toContain('args=(--exit-code="${LEAK_EXIT}" --redact)');
      expect(scan).toMatch(/if \[ "\$\{status\}" -eq 0 \]; then\n\s+echo "gitleaks found nothing/);
      expect(scan).toContain("SCANNER FAILURE, not a clean scan");
      // The action is no longer USED: it installed a DIFFERENT gitleaks (8.24.3
      // by default) than the pinned container, so the two jobs disagreed about
      // which tool was enforcing the gate. Matched on `uses:` rather than on the
      // bare name, because the job's own comment explains why it went.
      expect(workflow).not.toMatch(/uses:\s*gitleaks\/gitleaks-action/);
      // The SHAs reach the script through `env:`, not through `${{ }}` spliced
      // into the shell program.
      expect(workflow).toContain("PR_BASE_SHA: ${{ github.event.pull_request.base.sha }}");
      expect(workflow).toContain("PR_HEAD_SHA: ${{ github.event.pull_request.head.sha }}");
    });

    it("proves the secret scanner can still fail before trusting it to pass", () => {
      const workflow = readRepoFile(".github/workflows/ci.yml");
      const selftest = readRepoFile("scripts/ci/gitleaks-selftest.sh");

      // Every silent-failure mode #2686 found — an empty rule set, a shape
      // allowlist that swallowed a whole default rule, a scan that never looked
      // at merge commits — turned this gate GREEN. So the gate runs a failure
      // injection first, and the injection runs BEFORE the real scans.
      expect(workflow).toContain("run: bash scripts/ci/gitleaks-selftest.sh");
      expect(workflow.indexOf("gitleaks-selftest.sh")).toBeLessThan(
        workflow.indexOf("HISTORY_SCAN_SCOPE=$scope"),
      );
      // The three things the injection must actually assert. Named rather than
      // counted, so deleting one is a named failure.
      expect(selftest).toContain("acb-connection-string-password");
      expect(selftest).toContain("--diff-merges=first-parent main");
      expect(selftest).toContain("git merge --no-commit side");
      // ...and it must be able to fail. `exit 1` on a non-zero failure count is
      // the only line that makes any of the above load-bearing.
      expect(selftest).toMatch(/if \[ "\$failures" -ne 0 \]; then/);
      // No literal a rule matches may live in the script itself, or the tree
      // scan two steps later reports the self-test as a leak. The samples are
      // assembled from a prefix plus fresh randomness, which is why the live
      // Stripe prefix is split across a `printf` argument.
      expect(selftest).not.toMatch(/sk_live_[A-Za-z0-9]{10,}/);
      expect(selftest).not.toMatch(/ghp_[A-Za-z0-9]{20,}/);
    });

    it("never puts the required secret-scan job behind a job-level event condition", () => {
      const workflow = readRepoFile(".github/workflows/ci.yml");
      const job = workflow.slice(
        workflow.indexOf("  secret-scan:"),
        workflow.indexOf("  verify:"),
      );

      expect(job.length).toBeGreaterThan(0);
      // WHY, correctly. An earlier version of this comment said a skipped job
      // produces no status and leaves the branch unmergeable. That is false, and
      // this repository refutes it: on push 66448740c, `dependency-review` and
      // `gitleaks-pr-diff` both skipped via a JOB-level `if:` and both reported
      // a status. Only a WORKFLOW-level `on:` filter produces no status.
      //
      // The real hazard is the inverse, and worse: GitHub counts a `skipped`
      // required check as SATISFYING branch protection. A job-level `if:` on a
      // required security gate therefore makes it vacuously green — the gate
      // says "skipped" and the merge button turns on. So every condition in this
      // job stays at STEP level, where a skip leaves the job a real pass or a
      // real failure.
      expect(job).not.toMatch(/^ {4}if:/m);
      expect(job).toMatch(/^ {8}if: github\.event_name == 'pull_request'$/m);
    });

    /*
      #2852 added a SECOND thing that scans this repository for secrets, and a
      second scanner is a liability unless it is provably the same scanner. The
      four assertions below are the whole reason the pin and the invocation were
      moved into `scripts/ci/`: they are what stops the sweep quietly becoming a
      different tool over a different rule set, which is precisely the state
      #2686 found the two jobs it deleted in.
    */
    it("runs the scheduled sweep on the same pinned scanner as the required gate", () => {
      const sweep = readRepoFile(".github/workflows/gitleaks-scheduled.yml");
      const gate = readRepoFile(".github/workflows/ci.yml");

      // Both go through the one script, so a version bump is one edit and
      // cannot land on only one of them.
      expect(sweep).toContain("bash scripts/ci/gitleaks-scan.sh git");
      expect(sweep).toContain("bash scripts/ci/gitleaks-scan.sh dir");
      expect(gate).toContain("bash scripts/ci/gitleaks-scan.sh git");
      expect(gate).toContain("bash scripts/ci/gitleaks-scan.sh dir");
      // And neither one may reach for a container of its own. Asserted against
      // the DIRECTIVES because both files' comments discuss the image at
      // length, and a comment explaining the rule must not satisfy it.
      for (const [name, text] of [
        [".github/workflows/ci.yml", gate],
        [".github/workflows/gitleaks-scheduled.yml", sweep],
      ] as const) {
        expect(
          directivesOnly(text),
          `${name} names a gitleaks container of its own; the pin lives in scripts/ci/gitleaks-image.sh`,
        ).not.toContain("ghcr.io/gitleaks/gitleaks");
      }
      // The sweep proves the scanner can still fail before trusting its green,
      // exactly as the gate does. A weekly job nobody watches needs this more
      // than the gate does, not less.
      expect(sweep).toContain("run: bash scripts/ci/gitleaks-selftest.sh");
      // ...and the self-test runs the pinned binary rather than a default of
      // its own, or it proves nothing about the gate it guards.
      expect(readRepoFile("scripts/ci/gitleaks-selftest.sh")).toContain(
        '. "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/gitleaks-image.sh"',
      );
    });

    it("keeps `--all` in the sweep and out of the required gate", () => {
      const sweep = readRepoFile(".github/workflows/gitleaks-scheduled.yml");

      // The division of responsibility, pinned in both directions because each
      // half is a real defect. `--all` in the gate makes a required check
      // hostage to a leak on anybody's abandoned branch, red on every open pull
      // request and unfixable by its author (#2686). `--all` missing from the
      // sweep leaves the sweep scanning what the gate already scanned, which is
      // the "full repository scan" that #2686 measured doing nothing.
      expect(sweep).toContain(
        "GITLEAKS_LOG_OPTS: --diff-merges=first-parent --all",
      );
      expect(directivesOnly(readRepoFile(".github/workflows/ci.yml"))).not.toContain(
        "--all",
      );
      // Every branch's history is only reachable from a full clone. Against
      // the DIRECTIVES, because this workflow's own header quotes
      // `fetch-depth: 0` while explaining why the gate cannot use `--all` --
      // found by mutation-testing, which is the fourth time in this file a
      // comment about a directive has satisfied the guard on that directive.
      expect(directivesOnly(sweep)).toContain("fetch-depth: 0");
    });

    it("keeps the scheduled sweep incapable of becoming a merge gate by accident", () => {
      const sweep = readRepoFile(".github/workflows/gitleaks-scheduled.yml");
      const triggers = sweep.slice(sweep.indexOf("\non:"), sweep.indexOf("\npermissions:"));

      // #2852 explicitly does not add a branch-protection requirement, and the
      // mechanism that keeps it that way is the trigger list: a workflow with no
      // `pull_request` and no `push` trigger reports no status context on a pull
      // request at all, so there is nothing for branch protection to require and
      // nothing to sit "Expected — waiting for status" on an open PR. Making it
      // required later is the three-step sequence in `AGENTS.md`.
      expect(triggers).toContain("schedule:");
      expect(triggers).toContain("workflow_dispatch:");
      expect(triggers).not.toContain("pull_request");
      expect(triggers).not.toContain("push:");
      // A cancelled security scan reports neither clean nor dirty, and the next
      // one is a week away.
      expect(sweep).toContain("cancel-in-progress: false");
      // Read-only, and no `security-events: write`: the sweep publishes its
      // findings as a run summary and an artifact, so it never needs a token
      // that can write to the repository.
      expect(directivesOnly(sweep)).not.toContain(": write");
    });

    it("reports sweep findings with context and without the secret", () => {
      const sweep = readRepoFile(".github/workflows/gitleaks-scheduled.yml");
      const scan = readRepoFile("scripts/ci/gitleaks-scan.sh");

      // Actionable a week later means the rule, the file, the line and the
      // commit — and `--redact` means the matched value in that report is the
      // literal string REDACTED, so summarising it republishes nothing.
      // Verified against v8.28.0: the JSON report's `Match` and `Secret` fields
      // both come back as "REDACTED" while `File`, `StartLine`, `Commit` and
      // `RuleID` are intact.
      expect(scan).toContain("--report-format=json");
      expect(scan).toContain("--redact");
      expect(sweep).toContain("\\(.RuleID) | `\\(.File)` | \\(.StartLine) | \\(.Commit[0:12])");
      // Both scans run even when the first one fails, so one sweep gives one
      // complete answer rather than a partial one that has to be re-run.
      expect(sweep).toMatch(/- name: Sweep the checked-out tree\n\s+id: tree\n\s+if: always\(\)/);
      // A missing report is NOT "no findings". The distinction is the same one
      // `gitleaks-scan.sh` draws between a failed scan and a clean one, and it
      // has to survive into the summary or the sweep's green means nothing.
      expect(sweep).toContain("the scan did not complete");
    });

    it("names the Trivy gate for what it blocks and keeps it off the verify critical path", () => {
      const workflow = readRepoFile(".github/workflows/ci.yml");
      const job = workflow.slice(
        workflow.indexOf("  docker-image-security:"),
        workflow.indexOf("  publish-ghcr-images:"),
      );

      expect(job).toContain("name: Image security gate (Trivy CRITICAL)");
      // CRITICAL blocks...
      expect(job).toContain(
        "name: Trivy CRITICAL gate (REQUIRED — a finding here blocks the merge)",
      );
      // ...HIGH does not, and must keep its escape hatch or it would start
      // blocking merges under a policy nobody agreed to.
      expect(job).toContain(
        "name: Trivy HIGH report (ADVISORY — never blocks the merge)",
      );
      // Anchored: the step's own comment quotes `continue-on-error: true` while
      // explaining why it must stay, so the plain substring survived deleting
      // the directive. Third instance of that defect in this block, all three
      // found by mutation-testing rather than by reading.
      expect(job).toMatch(/^ +continue-on-error: true$/m);
      // `needs: verify` here would put a REQUIRED image scan behind a ~17-minute
      // job, making it the new critical path for every merge — and, because
      // GitHub counts a skipped required check as satisfied, a failed `verify`
      // would have reported this gate as skipped, i.e. as PASSING.
      //
      // The pattern accepts both YAML spellings. The first version matched only
      // the block-sequence form, so `needs: verify` and `needs: [verify]` — the
      // same dependency, one line shorter — both walked straight past it.
      expect(job).not.toMatch(/needs:\s*(\n\s*-\s*)?\[?\s*verify/);
    });

    it("keeps the gitleaks config extending the default rule set", () => {
      const config = readRepoFile(".gitleaks.toml");

      // Without this, the config REPLACES the built-in rules with the empty set
      // this file declares, and every gitleaks job in CI passes unconditionally.
      // That is exactly what shipped before #2686.
      //
      // Anchored to the start of a line on purpose. `toContain("[extend]")`
      // passes on the COMMENT above the directive, which explains at length why
      // the directive must never be removed — so deleting the directive left
      // this test green when it was first written. Mutation-testing it is what
      // found that; the file's own prose was satisfying the guard.
      expect(config).toMatch(/^\[extend\]$/m);
      expect(config).toMatch(/^useDefault\s*=\s*true$/m);
      // Allowlists stay content-scoped: a global allowlist carrying `paths`
      // suppresses EVERYTHING under those paths in gitleaks 8.28.0, whatever
      // else the entry says.
      expect(config).not.toMatch(/^\s*paths\s*=/m);
      // ...and they stay pinned to EXACT LITERALS, never to a shape. A global
      // allowlist applies to every rule, not the one its description names, so a
      // shape class silences rules nobody thought about: measured, the UUID
      // shape dropped `heroku-api-key` and a UUID `CRON_SECRET`, and
      // `^(?:pk|sk)_test_[A-Za-z0-9_]+$` forgave every Stripe test-mode key that
      // will ever exist here. Both regexes are forbidden by name.
      //
      // Asserted against the DIRECTIVES, with `#` comment lines stripped: the
      // file explains at length why each banned shape is banned, and quoting a
      // shape in order to forbid it must not read as using it. That is the same
      // prose-satisfies-the-guard defect as the `[extend]` case above, inverted.
      const directives = config
        .split("\n")
        .filter((line) => !line.trim().startsWith("#"))
        .join("\n");
      expect(directives).not.toContain("(?:pk|sk)_test_[A-Za-z0-9_]+");
      expect(directives).not.toContain("[0-9a-f]{8}-[0-9a-f]{4}");
      // `targetRules` is never the answer either: in 8.28.0 it silently voids
      // the allowlist entirely, which turns a narrowing into a widening.
      expect(directives).not.toContain("targetRules");
      // The one rule this repository owns. gitleaks' defaults have no rule for a
      // connection-string password, which on a PUBLIC repository holding member
      // and payment data is the most damaging plausible leak — the URL carries
      // the host as well as the credential.
      expect(config).toMatch(/^id = "acb-connection-string-password"$/m);
      expect(config).toMatch(/^entropy = /m);
    });

    it("keeps the .gitleaksignore free of fingerprints that suppress nothing", () => {
      const ignore = readRepoFile(".gitleaksignore");
      const entries = ignore
        .split("\n")
        .map((line) => line.trim())
        .filter((line) => line !== "" && !line.startsWith("#"));

      // The file shipped nine fingerprints described as "RE-VERIFIED against
      // gitleaks v8.28.0", and not one of them suppressed anything: replacing
      // the file with an empty one changed no scan result. An ignore file full
      // of dead entries is worse than an empty one, because it reads as
      // coverage.
      //
      // A fingerprint is also not durable here. The history scan passes
      // `--diff-merges=first-parent`, so a line is re-reported at every merge
      // that carried it forward — each with its own `commit:file:rule:line`
      // fingerprint — and pinning by fingerprint would need a new entry after
      // every merge, forever, on a REQUIRED check. Real suppressions are
      // exact-literal allowlists in `.gitleaks.toml` instead.
      //
      // This is not "the file must stay empty". It is: every entry must be
      // shaped like a fingerprint, so a fingerprint added for the one case that
      // still warrants one (a rotated credential whose value must not be
      // written down) passes, and a stale or malformed line does not.
      for (const entry of entries) {
        expect(entry, `${entry} is not a gitleaks fingerprint`).toMatch(
          /^[0-9a-f]{40}:[^:]+:[^:]+:\d+$/,
        );
      }
    });

    // #2946. The audit used to be a STEP near the front of `verify`. Actions
    // skips every later step in a job once one fails, so when a high-severity
    // advisory landed in a transitive dependency on 17 August (#2945) it took
    // lint, the file-size ratchet, `prisma generate`, typecheck, knip, `npm test`
    // and the build down with it — on every branch, silently, while the other
    // required checks stayed green. The check list read "one dependency thing is
    // red"; the suite had not run. #2947 restored it and the first real run
    // immediately failed on a defect (#2944) that had accumulated behind it.
    it("audits dependencies in a job of its own, so an advisory cannot silence verify (#2946)", () => {
      const workflow = readRepoFile(".github/workflows/ci.yml");
      const job = workflow.slice(
        workflow.indexOf("  dependency-audit:"),
        workflow.indexOf("  static-analysis:"),
      );

      expect(job.length).toBeGreaterThan(0);
      // The context name is what branch protection stores. Renaming it silently
      // un-requires the gate until someone re-reads the protection API.
      expect(job).toMatch(/^ {4}name: Dependency audit$/m);
      // Still BLOCKING, and still the same command (owner decision, 19 Aug 2026):
      // a new advisory is a supply-chain decision a human makes, not a report.
      // Anchored to the run line — the job's comment quotes the command while
      // explaining why it needs no install.
      expect(job).toMatch(/^ +run: npm audit --audit-level=high$/m);
      expect(job).not.toContain("continue-on-error");

      // ...and `verify` must no longer run it. Asserted against the DIRECTIVES,
      // because verify now carries a comment naming the departed step and saying
      // where it went, which a plain substring check would match.
      const verify = directivesOnly(
        workflow.slice(
          workflow.indexOf("  verify:"),
          workflow.indexOf("  migration-drift:"),
        ),
      );
      expect(verify.length).toBeGreaterThan(0);
      expect(verify).not.toContain("npm audit");
      // The gates that were skipped must all still be in `verify`, and none of
      // them may have acquired a condition of its own on the way out.
      for (const step of [
        "run: npm run lint",
        "run: npm run quality:budget",
        "run: npm run db:generate",
        "run: npm run typecheck",
        "run: npx knip",
        "run: npm test",
        "run: npm run build",
      ]) {
        expect(verify, `verify no longer runs \`${step}\``).toContain(step);
      }
    });

    // The generalisation of the two job-level assertions above, applied to every
    // required check at once (#2946). A skipped job REPORTS a status and GitHub
    // counts a skipped required check as SATISFYING branch protection, so a
    // job-level `if:` — or a `needs:` on a job that then fails — turns a gate
    // vacuously green and switches the merge button on. Conditions belong on
    // steps. The two exemptions are named, not inferred.
    it("puts no job-level `if:` or `needs:` on any required-check job (#2946)", () => {
      const workflow = readRepoFile(".github/workflows/ci.yml");

      // Deliberately NOT required, each for a reason that is itself the point:
      // `dependency-review` is advisory and pull-request-only (its job-level
      // `if:` is exactly why it can never be required), and
      // `publish-ghcr-images` is a release step rather than a gate.
      const notRequired = new Set(["dependency-review", "publish-ghcr-images"]);

      // From `jobs:` onward only — `on:` also carries two-space keys
      // (`pull_request:`, `push:`) that are not jobs.
      const jobsBlock = workflow.slice(workflow.indexOf("\njobs:\n"));
      expect(jobsBlock.length).toBeGreaterThan(0);

      const jobs = [...jobsBlock.matchAll(/^ {2}([a-z0-9-]+):$/gm)];
      expect(jobs.length).toBeGreaterThan(5);

      for (const [index, match] of jobs.entries()) {
        const id = match[1];
        if (notRequired.has(id)) continue;

        const start = match.index ?? 0;
        const end = jobs[index + 1]?.index ?? jobsBlock.length;
        const body = directivesOnly(jobsBlock.slice(start, end));

        expect(body, `job \`${id}\` has a job-level \`if:\``).not.toMatch(
          /^ {4}if:/m,
        );
        expect(body, `job \`${id}\` has a job-level \`needs:\``).not.toMatch(
          /^ {4}needs:/m,
        );
      }
    });

    it("releases only behind the renamed secret-scan gate", () => {
      const workflow = readRepoFile(".github/workflows/ci.yml");
      const publish = workflow.slice(workflow.indexOf("  publish-ghcr-images:"));

      expect(publish).toContain("- secret-scan");
      expect(publish).not.toContain("- gitleaks-full-repo");
    });
  });

  it("deploys the resolved commit SHA image references from the production script", () => {
    const deployScript = readRepoFile("scripts/run-production-blue-green-deploy.sh");

    expect(deployScript).toContain(
      'GHCR_APP_IMAGE_REPOSITORY="${GHCR_APP_IMAGE_REPOSITORY:-ghcr.io/thatskiff33/alpineclubbookingsnz-app}"',
    );
    expect(deployScript).toContain(
      'GHCR_MIGRATE_IMAGE_REPOSITORY="${GHCR_MIGRATE_IMAGE_REPOSITORY:-ghcr.io/thatskiff33/alpineclubbookingsnz-migrate}"',
    );
    expect(deployScript).toContain(
      'APP_IMAGE="${GHCR_APP_IMAGE_REPOSITORY}:${RESOLVED_REF}"',
    );
    expect(deployScript).toContain(
      'MIGRATE_IMAGE="${GHCR_MIGRATE_IMAGE_REPOSITORY}:${RESOLVED_REF}"',
    );
    expect(deployScript).toContain('APP_IMAGE="$APP_IMAGE"');
    expect(deployScript).toContain('MIGRATE_IMAGE="$MIGRATE_IMAGE"');
    expect(deployScript).toContain("--internal-blue-green-deploy");
  });

  it("pulls supplied app and migration images instead of building locally", () => {
    const deploy = readRepoFile("scripts/run-production-blue-green-deploy.sh");

    expect(deploy).toContain('APP_IMAGE="${APP_IMAGE:-}"');
    expect(deploy).toContain('MIGRATE_IMAGE="${MIGRATE_IMAGE:-}"');
    expect(deploy).toContain("validate_image_reference_contract");
    expect(deploy).toContain(
      'docker compose pull "$CRON_SERVICE" "$TARGET_SERVICE" "$MIGRATE_SERVICE"',
    );
    expect(deploy).toContain(
      'docker compose build --pull "$CRON_SERVICE" "$TARGET_SERVICE" "$MIGRATE_SERVICE"',
    );
  });

  it("copies standalone static assets without nesting static/static", () => {
    const dockerfile = readRepoFile("Dockerfile");

    expect(dockerfile).toContain(
      "COPY --from=builder /app/.next/standalone ./",
    );
    expect(dockerfile).toContain(
      "COPY --from=builder /app/.next/static/ ./.next/static/",
    );
    expect(dockerfile).not.toMatch(
      /^COPY --from=builder \/app\/\.next\/static \.\/\.next\/static$/m,
    );
  });
});
