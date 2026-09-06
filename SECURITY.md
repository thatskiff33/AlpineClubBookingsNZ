# Security Policy

## Supported Version

Security fixes are accepted for the current `main` branch. Public releases are
reference snapshots of the application and should be updated before production
use.

## Reporting a Vulnerability

Do not open a public issue for a suspected vulnerability.

Use GitHub private vulnerability reporting or a GitHub security advisory when
available. If private reporting is unavailable, contact the repository
maintainers through a private channel first and avoid including secrets,
personal data, or exploit details in public comments.

Reports should include:

- affected route, API endpoint, job, or integration
- expected and observed behaviour
- reproduction steps using non-production data
- impact assessment and any relevant logs with secrets redacted

## Security Baseline

This project uses:

- Next.js App Router with server-side route handlers
- Auth.js / NextAuth credentials sessions
- Prisma and PostgreSQL
- Stripe PaymentIntents, SetupIntents, and webhooks
- Xero OAuth and webhook integrations
- AWS SES email and SNS feedback ingestion
- gitleaks, Semgrep, npm audit, Trivy and CodeQL in CI

## Which CI security checks block a merge

Two are required protected-branch checks on `main` today, and three more are
pending an owner action (#2686, #2946) — see `AGENTS.md` → "Completion and
Merge" for the applied list, the rollout order, and the `gh api` call that reads
the live configuration rather than trusting a document:

- **`Static analysis gate`** (required today) — Semgrep, running four registry
  packs plus this repository's own rules in `.semgrep/rules/`. The same job
  first runs each custom rule against its must-fail/must-pass fixtures in
  `.semgrep/tests/`.
- **`verify`** (required today) — lint, types, `npm test` and the build.
- **`Dependency audit`** (**pending**) — `npm audit --audit-level=high` over the
  committed lockfile. It used to be a step inside `verify`, where a published
  advisory in a transitive dependency skipped every gate behind it — lint, the
  file-size ratchet, `prisma generate`, typecheck, knip, `npm test` and the
  build — on every branch, while the other required checks stayed green (#2945,
  split out in #2946). It is a job of its own for that reason and must stay one.
- **`Secret scan (gitleaks)`** (**pending**) — gitleaks in one pinned container
  over three scopes: the pull request's own commits, the history of `main`, and
  the checked-out tree. Suppressions are exact-literal, content-scoped
  allowlists in `.gitleaks.toml`; `.gitleaksignore` is deliberately empty and its
  header explains why a fingerprint is not durable here.
- **`Image security gate (Trivy CRITICAL)`** (**pending**) — a CRITICAL
  vulnerability in the built container image. HIGH findings are reported in the
  same job but are advisory and cannot block.

### The scheduled sweep is a different job with a different remit

`Secret scan (gitleaks)` above is the **gate**: it decides whether a change may
merge, so it is scoped to what a merge can affect — this pull request's commits,
the history of `main`, and the checked-out tree.

`Scheduled secret sweep` (#2852, `.github/workflows/gitleaks-scheduled.yml`) is
the **sweep**: weekly and on demand, over **every** branch's history, because a
secret on an unmerged branch of a public repository is public whether or not
anyone ever merges it. It is not a required check and cannot become one by
accident — it has no `pull_request` or `push` trigger, so it reports no status
on a pull request for branch protection to require. A finding there is a task,
not a merge freeze. That is deliberate: `--all` in the gate would let one leak
on somebody's abandoned branch redden a required check on every open pull
request, unfixable by the author (#2686).

Neither one is allowed its own scanner. The version is pinned once in
`scripts/ci/gitleaks-image.sh`, the invocation once in
`scripts/ci/gitleaks-scan.sh`, and both workflows call it; the rule set and
allowlists are the same `.gitleaks.toml` and `.gitleaksignore`. That script also
separates a scan that came back clean from a scanner that never ran, which
gitleaks itself does not — `docs/MAINTENANCE.md` states the rule and why.

The sweep's findings appear as a rule/file/line/commit table in the run summary
and as a redacted JSON artifact kept for fourteen days. `docs/MAINTENANCE.md` →
"The repository-wide secret sweep" is where to look when one turns up.

CodeQL runs as **advisory** analysis through GitHub code scanning default setup
(`actions`, `javascript`, `javascript-typescript`, `typescript`). Its findings
are investigated but never block a merge, and it does not report on pull requests
from forks.

### Reproducing the secret scan locally

Through the same script CI calls, so a local run and a CI run cannot disagree
about the version, the flags or the exit-code contract — which is the whole
reason the invocation has one home. Run all three scopes: they report
overlapping but different sets, because a rule that needs surrounding context
sees less in a diff hunk than in a whole file.

```bash
# 1. The history of main. `--diff-merges=first-parent` is not optional: git log
#    emits no patch for a merge commit, and about a third of this repository's
#    commits are merges, so without it the scan silently skips them — including
#    any secret written while resolving a conflict.
GITLEAKS_SCAN_LABEL="the history of main" \
GITLEAKS_LOG_OPTS="--diff-merges=first-parent origin/main" \
  bash scripts/ci/gitleaks-scan.sh git

# 2. Your own branch's commits, the way the pull-request step scans them.
#    On `main` itself this range is EMPTY, and an empty range is reported as a
#    scanner failure by design — a scan of nothing must never read as clean,
#    and no scope CI runs is ever legitimately empty. Run it from a branch.
GITLEAKS_SCAN_LABEL="this branch's own commits" \
GITLEAKS_LOG_OPTS="--diff-merges=first-parent origin/main..HEAD" \
  bash scripts/ci/gitleaks-scan.sh git

# 3. The working tree as it stands.
GITLEAKS_SCAN_LABEL="the checked-out tree" \
  bash scripts/ci/gitleaks-scan.sh dir
```

Note the scope is `origin/main`, not `--all`. `--all` walks every
`refs/remotes/origin/*` branch that `fetch-depth: 0` materialised, which makes
the required check hostage to a leak on somebody else's unrelated branch and
gives a different answer here than in CI. The `--all` sweep is the scheduled
job's job, and `docs/MAINTENANCE.md` carries its command.

Set `GITLEAKS_REPORT_PATH` to a path **outside this repository** for a JSON
report carrying the rule, file, line, commit and fingerprint of each finding.
The script always passes `--redact`, so the matched value comes back as the
literal string `REDACTED` — but the surrounding detail still says where a
credential is, so treat the file as sensitive and do not write it into a tree
you might commit.

To prove the scanner can still fail before trusting a green — which this
repository has needed three separate times — run the failure injection CI runs:

```bash
bash scripts/ci/gitleaks-selftest.sh
```

Never test against a live production deployment without written approval from
the deployment owner. Use local or staging environments with test Stripe keys,
Xero demo credentials, and synthetic data.
