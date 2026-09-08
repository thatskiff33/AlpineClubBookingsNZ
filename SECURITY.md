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
  committed lockfile, run through `scripts/ci/audit-dependencies.mjs` so that
  "the advisory service was unreachable" and "this branch ships a
  vulnerability" are told apart on the first line of the output rather than
  looking identical. An unreachable service is retried and then still fails
  (#3254): green means the audit really ran. It used to be a step inside `verify`, where a published
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

CodeQL runs as **advisory** analysis through GitHub code scanning default setup
(`actions`, `javascript`, `javascript-typescript`, `typescript`). Its findings
are investigated but never block a merge, and it does not report on pull requests
from forks.

### Reproducing the secret scan locally

The same pinned image CI uses, in the same three scopes. Run all three: they
report overlapping but different sets, because a rule that needs surrounding
context sees less in a diff hunk than in a whole file.

```bash
# 1. The history of main. `--diff-merges=first-parent` is not optional: git log
#    emits no patch for a merge commit, and about a third of this repository's
#    commits are merges, so without it the scan silently skips them — including
#    any secret written while resolving a conflict.
docker run --rm -v "$PWD:/repo:ro" ghcr.io/gitleaks/gitleaks:v8.28.0 \
  git /repo --log-opts="--diff-merges=first-parent origin/main" \
  --exit-code=1 --redact

# 2. Your own branch's commits, the way the pull-request step scans them.
docker run --rm -v "$PWD:/repo:ro" ghcr.io/gitleaks/gitleaks:v8.28.0 \
  git /repo --log-opts="--diff-merges=first-parent origin/main..HEAD" \
  --exit-code=1 --redact

# 3. The working tree as it stands.
docker run --rm -v "$PWD:/repo:ro" ghcr.io/gitleaks/gitleaks:v8.28.0 \
  dir /repo --exit-code=1 --redact
```

Note the scope is `origin/main`, not `--all`. `--all` walks every
`refs/remotes/origin/*` branch that `fetch-depth: 0` materialised, which makes
the required check hostage to a leak on somebody else's unrelated branch and
gives a different answer here than in CI.

Add `--report-format=json --report-path=/repo/leaks.json` to see the unredacted
detail. That report contains every matched value in clear text and is **not**
git-ignored — write it outside the repository, or delete it before you commit.

To prove the scanner can still fail before trusting a green — which this
repository has needed three separate times — run the failure injection CI runs:

```bash
bash scripts/ci/gitleaks-selftest.sh
```

Never test against a live production deployment without written approval from
the deployment owner. Use local or staging environments with test Stripe keys,
Xero demo credentials, and synthetic data.
