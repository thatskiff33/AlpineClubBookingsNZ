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
- gitleaks, Semgrep, npm audit, and Trivy in CI

Never test against a live production deployment without written approval from
the deployment owner. Use local or staging environments with test Stripe keys,
Xero demo credentials, and synthetic data.
