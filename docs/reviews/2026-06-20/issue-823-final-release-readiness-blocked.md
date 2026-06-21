# Issue #823: Final Release-Readiness Review

Date: 2026-06-22

This report supersedes the earlier blocked note. The original #823 review was
blocked until issues #812 through #822 were reviewed, remediated, merged, and
closed. That gate is now satisfied.

## Readiness decision

The review-backlog implementation is release-ready from the scope of issues
#812 through #822. No unresolved review-backlog code, schema, security,
payment, provider, email, waitlist, bed-allocation, lifecycle, operator
visibility, or UX follow-up remains open in GitHub as part of this batch.

This is not evidence that production credentials, live provider webhooks, live
Stripe, live Xero, live SES, live Sentry, or production data were exercised.
Normal human release approval, staging smoke checks, deployment environment
verification, and the staging accessibility checklist still apply before a
production rollout.

## Evidence reviewed

- `AGENTS.md`
- `README.md`
- `CONFIGURATION.md`
- `docs/README.md`
- `docs/ARCHITECTURE.md`
- `docs/agents/CODEX_WORKFLOW.md`
- `docs/DOMAIN_INVARIANTS.md`
- `docs/STATE_MACHINES.md`
- `docs/END_TO_END_TEST_MATRIX.md`
- `docs/UX_FLOW_MAP.md`
- `docs/reviews/2026-06-20/REVIEW_ISSUE_BACKLOG.md`
- `docs/reviews/2026-06-20/ISSUE_CREATION_PLAN.md`
- `docs/reviews/2026-06-20/BATCH_REVIEW_815_822_SUMMARY.md`
- Review reports for issues #812 through #822 in
  `docs/reviews/2026-06-20/`.
- GitHub issue state for #812 through #823.
- Merged implementation PRs from #840 through #876 that were tied to the
  review-backlog findings.

## Issue and PR resolution map

| Issue | Review report | Full-resolution implementation evidence |
| --- | --- | --- |
| #812 Security/auth/access-control route boundary review | #825 | #840 hardened route-boundary coverage; #856 neutralized public group join responses; #857 added payment client-secret owner-boundary tests; #859 added induction boundary tests; #860 documented rate-limit/proxy assumptions; #861 added payment-link refresh boundary tests; #874 added family-detail owner-boundary tests; #875 added method-aware member-route guard coverage. |
| #813 Booking/payment/membership lifecycle state-machine review | #824 | #841 locked down bed-allocation vs capacity ownership; #863 documented BookingEvent narrative scope; downstream lifecycle risks were closed through #816, #817, #818, #819, #820, and #822 implementation PRs. |
| #814 High-risk invariant test gap review | #826 | #842 added cron recording and health contract coverage. |
| #815 Stripe/Xero/SES idempotency and replay review | #831 | #843 added Stripe webhook idempotency/replay tests; #858 scoped processed webhook idempotency by provider and required SES/SNS SignatureVersion 2. |
| #816 Booking capacity, waitlist, bed allocation, and recovery review | #832 | #844 added booking status-set matrix coverage; #855 added bed-allocation reconciliation tests after date/guest changes; #870 surfaced waitlist offer-email failures; #871 audited force-confirmed overbookings. |
| #817 Membership, family, dependent, cancellation, archive/delete lifecycle review | #833 | #845 allowed admins to reject stuck `PENDING_NOMINATORS` applications; #864 surfaced membership approval follow-up warnings; #873 exposed the reject control in the admin UI. |
| #818 Payment, refund, credit, and accounting consistency review | #834 | #846 moved refund appeal approval to claim-first processing; #853 enqueued durable recovery for guest-removal refund failures; #862 reported refunds missing Xero credit notes; #865 added a daily cron alert for missing refund credit notes. |
| #819 Xero operational outbox and reconciliation review | #835 | #847 surfaced stale `RUNNING` Xero operations in admin health; #854 recovered stale inbound `PROCESSING` events; #866 locked Xero token refresh across workers; #867 flagged Xero repair amount mismatches. |
| #820 Email, notification, retry, and suppression review | #836 | #848 added email retry/suppression behavior tests; #868 escalated undeliverable admin alerts; #869 added token-email recovery and reissue actions. |
| #821 Admin, finance, and lodge recovery/visibility review | #837 | #849 surfaced exhausted payment recovery in health; #872 added the consolidated stuck-state operator dashboard. |
| #822 UI/UX journey clarity and accessibility review | #838 | #850 guaranteed booking next-step guidance for every status; cross-domain user/operator recovery visibility was also improved by #869, #870, and #872. |
| #823 Final release-readiness review | #839 blocked note, this superseding report | #876 fixed the release-blocking Docker image security scan surfaced during the capstone; this report records final readiness. |

All issues #812 through #822 were closed before this report was written. At the
time of this capstone pass, #823 was the only open issue in the review-backlog
set.

## Security and access-control readiness

The security route-boundary findings have been fully resolved for this batch.
The implementation now has stronger route-boundary regression coverage,
method-aware guard coverage for mixed public/protected member-route files,
neutral public group-join responses, and representative owner-boundary tests
for payment, payment-link, induction, and family-detail flows.

Provider replay and signature handling were also hardened: processed webhook
idempotency is source-scoped, and SES/SNS handling requires SignatureVersion 2.
Token-bearing and provider-facing details remain intentionally absent from this
public report.

Remaining release caveat: no DAST, live endpoint scan, production webhook
replay, or production credential validation was performed.

## Lifecycle and invariant readiness

The lifecycle follow-ups now cover the previously risky state boundaries:
booking status-set semantics, bed-allocation versus booking-capacity ownership,
bed reconciliation after date and guest changes, stuck nominator application
rejection, membership approval warning visibility, and BookingEvent narrative
scope.

The implementation preserves the documented domain invariants for this batch:
money remains integer cents, lodge nights remain New Zealand date-only values,
Stripe and Internet Banking/Xero settlement paths remain distinct, and cron or
webhook work remains idempotent.

Remaining release caveat: the capstone did not execute broad end-to-end browser
journeys or staging data rehearsals.

## Payments, refunds, credits, and accounting readiness

Refund approval was moved to a claim-first pattern before external refund work,
legacy guest-removal refund failures now enqueue durable recovery, refunds
missing Xero credit notes are reportable, and the credit-balance reconciliation
cron emits an explicit daily alert for missing refund credit notes.

Payment recovery visibility was expanded so exhausted or failed recovery work
is not hidden behind stale/pending-only health semantics. Xero repair amount
mismatches are now flagged so local money movement and provider accounting
links can be reconciled more explicitly.

Remaining release caveat: no live Stripe or Xero calls were made. Provider
objects, tenant IDs, payment identifiers, and real money examples were not used.

## Xero, email, and provider operations readiness

Xero operational reliability now has stale `RUNNING` outbox visibility, stale
inbound `PROCESSING` recovery, a cross-worker OAuth token refresh lock, and
amount-versus-link reconciliation for Xero repairs.

Email recovery now includes retry/suppression behavior coverage, operator
reissue/resend actions for failed token-bearing lifecycle emails, and escalation
when all admin alert recipients are suppressed or undeliverable.

During this final review, GitHub CI surfaced a Docker image security failure in
the runtime base image and npm-bundled dependencies. #876 refreshed the Node 24
Alpine runtime image and removed npm, npx, and corepack from the production
runtime layer. The production image still runs the standalone Next server with
`node server.js`.

Remaining release caveat: no live Xero OAuth refresh, live SES/SNS feedback, or
production email delivery test was performed.

## Operator and UX readiness

Operator visibility is materially stronger after this batch. Admins now have a
consolidated stuck-state dashboard covering payment recovery, Xero outbox and
inbound work, email failures, waitlist offer failures, bed allocation, and
lodge operations. Waitlist offer-email failures and force-confirmed
overbookings are visible and auditable.

Booking status narratives now produce next-step guidance for every booking
status, reducing reliance on successful email delivery as the only source of
user instructions.

Remaining release caveat: accessibility was statically reviewed only. A human
staging pass using `docs/STAGING_ACCESSIBILITY.md` is still a normal release
gate for dense admin, lodge, finance, and booking flows.

## Tests and validation reviewed

The backlog was not validated by running broad local CI, in line with the batch
workflow. Instead, each implementation PR used focused local validation plus
GitHub CI. The current post-backlog tree was revalidated by #876 after all
review-backlog implementation PRs had landed.

Observed validation evidence includes:

- `gh issue list` confirmed #812 through #822 closed and #823 open before the
  capstone.
- `gh pr list --state open` showed no open backlog PRs before the capstone
  branch was prepared.
- #876 GitHub CI passed: dependency review, gitleaks full-repo and PR-diff,
  static analysis, migration drift, verify, CodeQL, and Docker image security.
- Local #876 validation passed:
  - `docker build --build-arg NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY=pk_test_fake --build-arg NEXT_PUBLIC_SENTRY_DSN= --build-arg NEXT_PUBLIC_CONTACT_EMAIL=bookings@example.com --tag tacbookings-ci:local-docker-refresh .`
  - `docker run --rm --entrypoint sh tacbookings-ci:local-docker-refresh -lc 'node -v; command -v npm || true; command -v npx || true; command -v corepack || true; apk list -I libcrypto3 libssl3; find /usr/local/lib/node_modules -maxdepth 2 -type d -name undici -print'`
  - `docker run --rm -v /var/run/docker.sock:/var/run/docker.sock aquasec/trivy:latest image --format table --exit-code 1 --severity CRITICAL,HIGH tacbookings-ci:local-docker-refresh`
  - `DATABASE_URL="postgresql://u:p@127.0.0.1:1/db" npx prisma validate`
  - `git diff --check`

This capstone changes documentation only. Its own validation should remain
limited to docs-safe checks plus GitHub CI on the final PR.

## Migrations and deployment readiness

The migration drift gate passed after the backlog implementation work. The
schema-affecting follow-ups included timestamped migrations after the prior
latest migration, including processed-webhook source scoping and Xero token
refresh lease storage. This capstone does not add or alter any Prisma schema or
migration.

Deployment-specific checks still belong to the release operator: production
environment variables, secrets, provider callback URLs, one-off migration
execution, backup/rollback readiness, and post-deploy smoke checks were not
performed in this review.

## Final residual risks

- Production provider behavior is unverified in this pass by design.
- Manual accessibility and keyboard/screen-reader validation remains a staging
  release gate.
- Operator runbooks and alert routing should be smoke-tested in staging with
  representative admin, finance, and lodge roles.
- The final production image should be built by the normal deployment pipeline,
  not from the local validation image.
- Any newly discovered provider, dependency, or infrastructure advisories after
  this report should be handled through the normal release-blocker path.

## Final recommendation

Close #823 after this report lands and its PR is green. The #812 through #823
review-backlog batch is fully resolved from the repository-review perspective,
with only normal human release/staging gates remaining.
