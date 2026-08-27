## Linked Issue

- Closes or relates to:

## Summary

-

## Risk Level

- [ ] Critical
- [ ] High
- [ ] Medium
- [ ] Low
- [ ] Informational/docs only

## Changed Areas

- [ ] Booking/capacity
- [ ] Payment/refund/credits
- [ ] Membership/family lifecycle
- [ ] Xero/Stripe/SES/Sentry integration
- [ ] Auth/security/privacy
- [ ] Admin/finance/lodge UI
- [ ] Public UI/UX/accessibility
- [ ] Database schema/migrations
- [ ] Deployment/operations
- [ ] Docs/agent workflow only

## Tests Added Or Updated

-

## Validation Commands Run

```bash

```

## Commands Not Run And Why

-

## Screenshots Or UI Evidence

- Required for UI changes; otherwise write `N/A`.

## Security And Privacy Impact

-

## Data Integrity Impact

-

## Concurrency And Lock Impact

<!-- Each field's value must sit on the SAME line as its label. A value wrapped
     onto the following line reads as EMPTY and fails the gate; continuation
     lines after that first line are fine. Do not reword the heading or the
     labels — they are matched exactly.
     Check before pushing:  npm run pr:check -- <body-file>  -->

- [ ] N/A — no transaction, lifecycle, capacity, settlement, credit, webhook,
      cron, or concurrency-sensitive writer changed.
- Writer class(es), canonical lock key(s), and acquisition order:
- Immutable pre-lock key source and mutable under-lock re-read:
- Status-guarded claim and proof that a lost claim runs no side effect:
- Relevant open/last-10 PR numbers, counterpart writers/tests, and compatibility evidence:
- Provider calls inside a transaction (write `None`, or justify the bounded exception from `docs/CONCURRENCY_AND_LOCKING.md`):

## Single Source Of Truth

<!-- INV-SSOT. Not a checkbox: name the fact, and where it is DEFINED. A second
     FORM of one fact is fine; a second DEFINITION is the defect. Write `N/A`
     only when this change defines no constant, helper, formatter, type,
     validation rule or config value that a second place could need. -->

- New or moved definitions, and the one module each now lives in:
- If anything was copied rather than imported, or a guard was added instead of
  making the wrong thing unrepresentable — which structural option was rejected
  and why:

## Payment Or Accounting Impact

-

## Migration Or Deployment Impact

-

## Docs Updated

-

## Changelog Entry

- Fragment added (`changelog.d/<pr-number>-<slug>.md`):
- Or, if this change genuinely needs no entry, put the no-entry marker
  documented in `changelog.d/README.md` on its own line here, with the reason.
  (The marker is deliberately not pre-filled: a marker in every PR body would
  switch the gate off for everyone.)

## Residual Risks

-

## Manual Checks Required

-

## Safety Confirmation

- [ ] I did not use production credentials, production databases, production
      backups, live Stripe, live Xero, live SES, live Sentry, or live provider
      webhooks for exploratory validation.
- [ ] Merge handling follows the `AGENTS.md` "Completion and Merge" risk gate:
      eligible Low/Medium-risk PRs may merge (and close their linked issue) once
      CI is green; Critical or High-risk changes — security, payments, booking,
      membership, Xero/Stripe/SES/Sentry, schema/migrations, deployment, or data
      integrity — wait for explicit owner approval. Merge commits only.
