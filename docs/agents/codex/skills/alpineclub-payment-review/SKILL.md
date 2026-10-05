---
name: alpineclub-payment-review
description: Payment and integration review workflow for AlpineClubBookingsNZ. Use for Stripe PaymentIntents, saved cards, refunds, member credits, Internet Banking/Xero settlement, Xero outbox/reconciliation, SES/SNS, Sentry redaction, and provider idempotency.
---

# AlpineClub Payment Review

## Read First

- `AGENTS.md`, and the rows of its routing table that match the surfaces you
  touch.
- For a routed reference doc (`docs/STATE_MACHINES.md`, `docs/ARCHITECTURE.md`,
  `docs/SECURITY-ATTACK-SURFACE.md`), read its headings first, then only the
  section that matches; never the whole file.
- `docs/agents/REVIEW_SEVERITY.md`
- The invariant domain files this
  review actually needs: `docs/invariants/money.md` (`INV-MONEY`),
  `docs/invariants/payment-and-settlement.md` (`INV-PAY`), and
  `docs/invariants/integrations.md` (`INV-INT`)

## Allowed Actions

- Review money-state, refund, credit, provider, webhook, outbox, and recovery
  behavior.
- Verify Stripe and Internet Banking/Xero settlement paths remain distinct.
- Propose focused issue splits and validation.

## Disallowed Actions

- Do not call live Stripe, Xero, SES, Sentry, or provider webhooks.
- Do not use production credentials, databases, or backups.
- Do not place provider calls inside long transactions without documented
  reason.
- Do not merge or close anything; merges follow `AGENTS.md` "Completion and
  Merge".

## Expected Output

- Severity-ranked payment/integration findings.
- Idempotency and retry analysis.
- Required tests, safe validation commands, residual risks, and manual checks.

## Validation

Use mocks, local tests, dry runs, and route/service tests. State clearly when a
provider behavior still needs staging or human verification.
