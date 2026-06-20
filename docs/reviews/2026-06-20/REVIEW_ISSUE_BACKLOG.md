# Review Issue Backlog

Planning-only backlog for review issues. These stubs do not assert confirmed
bugs; use "to verify" findings where implementation detail is not confirmed.
Do not use production data, live providers, or detailed public exploit notes.

## 1. Security/auth/access-control route boundary review

- Title: Security/auth/access-control route boundary review
- Workstream: Security and route boundaries
- Risk: High
- Recommended effort: xhigh
- Mode: Review-only, human-attended, no app code edits
- Goal: Verify public, member, admin, finance, lodge, cron, deploy, and
  provider-signed API boundaries and identify focused follow-up issues.
- Context files to read: `AGENTS.md`, `docs/SECURITY-ATTACK-SURFACE.md`,
  `docs/DOMAIN_INVARIANTS.md`, `docs/ARCHITECTURE.md`, `prisma/schema.prisma`,
  to verify targeted route/security tests and auth helpers.
- Acceptance criteria: Route families are mapped to expected guards; public and
  provider-signed exceptions are justified; gaps are reported as to-verify
  findings without exploit detail; follow-up issues include safe validation.
- Validation commands: `git diff --check`; `npm run lint`
- Exact Codex prompt to run that issue:

```text
Read AGENTS.md first and obey it. Work exactly one issue: Security/auth/access-control route boundary review. This is a review-only security planning pass. Read the issue body and named context files, then inspect only targeted auth, route-boundary, and test files needed to verify the boundary map. Do not edit app code, do not use live providers or production data, do not run broad tests, and do not publish exploit instructions. Produce concise findings or say no confirmed issue was found, using "to verify" where details remain unconfirmed. Run only the validation commands named in the issue and report residual risk.
```

## 2. Booking/payment/membership lifecycle state-machine review

- Title: Booking/payment/membership lifecycle state-machine review
- Workstream: Lifecycle state machines
- Risk: High
- Recommended effort: xhigh
- Mode: Review-only, human-attended, no app code edits
- Goal: Compare documented booking, payment, refund, credit, waitlist, bed
  allocation, membership, nomination, cancellation, archive, delete, cron, and
  recovery states against focused implementation paths.
- Context files to read: `AGENTS.md`, `docs/STATE_MACHINES.md`,
  `docs/DOMAIN_INVARIANTS.md`, `docs/ARCHITECTURE.md`, `prisma/schema.prisma`,
  to verify targeted lifecycle services and tests.
- Acceptance criteria: State transitions are traced at a high level; terminal,
  retry, expiry, and repair paths are listed as confirmed or to verify; no
  specific bug is asserted without evidence; follow-up issues are split by
  lifecycle owner.
- Validation commands: `git diff --check`; `DATABASE_URL=postgresql://user:pass@localhost:5432/tacbookings npx prisma validate`
- Exact Codex prompt to run that issue:

```text
Read AGENTS.md first and obey it. Work exactly one issue: Booking/payment/membership lifecycle state-machine review. This is review-only. Read the issue body and named docs, then inspect only targeted lifecycle services, enums, and existing tests needed to compare implementation behavior to docs/STATE_MACHINES.md and docs/DOMAIN_INVARIANTS.md. Do not edit app code, do not use production data or live providers, and do not run broad tests. Output concise confirmed findings and to-verify gaps, with follow-up issue candidates where needed. Run only the validation commands named in the issue.
```

## 3. High-risk invariant test gap review

- Title: High-risk invariant test gap review
- Workstream: Test coverage and domain invariants
- Risk: High
- Recommended effort: high
- Mode: Review-only, human-attended, no app code edits
- Goal: Identify where high-risk invariants need route, service, policy,
  webhook, cron, or integration mock coverage before release.
- Context files to read: `AGENTS.md`, `docs/DOMAIN_INVARIANTS.md`,
  `docs/END_TO_END_TEST_MATRIX.md`, `docs/STATE_MACHINES.md`,
  `package.json`, to verify targeted existing test folders.
- Acceptance criteria: Invariants are grouped by risk and current known test
  type; gaps are marked to verify unless confirmed; proposed follow-ups name
  targeted validation commands; no broad test sweep is required for review.
- Validation commands: `git diff --check`; `npm run lint`
- Exact Codex prompt to run that issue:

```text
Read AGENTS.md first and obey it. Work exactly one issue: High-risk invariant test gap review. This is review-only and docs/findings only. Read the issue body and named context files, then inspect only targeted existing test indexes or nearby test files needed to verify coverage for the highest-risk invariants. Do not edit app code, do not run broad tests, and do not invent bugs. Produce concise coverage gaps with "to verify" where exact coverage is not confirmed, plus proposed targeted validation commands for follow-up issues. Run only the validation commands named in the issue.
```

## 4. Stripe/Xero/SES idempotency and replay review

- Title: Stripe/Xero/SES idempotency and replay review
- Workstream: Provider idempotency and replay safety
- Risk: Critical
- Recommended effort: xhigh
- Mode: Review-only, human-attended, no app code edits
- Goal: Verify safe retry, replay, signature, token-redaction, and recovery
  expectations for Stripe, operational Xero, finance Xero, SES/SNS, cron, and
  provider queues without live calls.
- Context files to read: `AGENTS.md`, `docs/SECURITY-ATTACK-SURFACE.md`,
  `docs/DOMAIN_INVARIANTS.md`, `docs/ARCHITECTURE.md`,
  `docs/END_TO_END_TEST_MATRIX.md`, to verify targeted provider route/service
  tests.
- Acceptance criteria: Provider callback and retry paths are mapped; replay and
  idempotency controls are confirmed or marked to verify; no live provider
  steps or exploit details are included; follow-up issues use mocked tests.
- Validation commands: `git diff --check`; `npm run lint`
- Exact Codex prompt to run that issue:

```text
Read AGENTS.md first and obey it. Work exactly one issue: Stripe/Xero/SES idempotency and replay review. This is review-only. Read the issue body and named context files, then inspect only targeted webhook, cron, provider queue, redaction, and mocked-test files needed to verify idempotency and replay behavior. Do not call live Stripe, Xero, SES, Sentry, production webhooks, or production data. Do not publish exploit instructions or sensitive token details. Output concise confirmed findings and to-verify gaps with mocked validation commands. Run only the validation commands named in the issue.
```

## 5. Booking capacity, waitlist, bed allocation, and recovery review

- Title: Booking capacity, waitlist, bed allocation, and recovery review
- Workstream: Booking capacity and lodge allocation
- Risk: Critical
- Recommended effort: xhigh
- Mode: Review-only, human-attended, no app code edits
- Goal: Review capacity-holding statuses, per-guest date ranges, waitlist
  offers, bed allocation reconciliation, booking edits, and payment recovery
  interactions.
- Context files to read: `AGENTS.md`, `docs/DOMAIN_INVARIANTS.md`,
  `docs/STATE_MACHINES.md`, `docs/ARCHITECTURE.md`,
  `docs/END_TO_END_TEST_MATRIX.md`, `prisma/schema.prisma`, to verify targeted
  booking and bed-allocation services/tests.
- Acceptance criteria: Capacity and allocation invariants are mapped; waitlist
  and recovery paths are listed as confirmed or to verify; follow-up issues
  preserve NZ date-only semantics and integer cents.
- Validation commands: `git diff --check`; `DATABASE_URL=postgresql://user:pass@localhost:5432/tacbookings npx prisma validate`
- Exact Codex prompt to run that issue:

```text
Read AGENTS.md first and obey it. Work exactly one issue: Booking capacity, waitlist, bed allocation, and recovery review. This is review-only. Read the issue body and named docs, then inspect only targeted booking status, capacity, waitlist, bed allocation, booking modification, and payment recovery files needed to verify invariants. Do not edit app code, do not use production data, and do not run broad tests. Preserve NZ date-only and integer-cent assumptions in any follow-up. Output concise confirmed findings and to-verify gaps. Run only the validation commands named in the issue.
```

## 6. Membership, family, dependent, cancellation, archive/delete lifecycle review

- Title: Membership, family, dependent, cancellation, archive/delete lifecycle review
- Workstream: Membership lifecycle integrity
- Risk: High
- Recommended effort: xhigh
- Mode: Review-only, human-attended, no app code edits
- Goal: Verify membership application, nomination, family/dependent,
  cancellation, archive, delete, invite, token, email, audit, and Xero contact
  lifecycle expectations.
- Context files to read: `AGENTS.md`, `docs/DOMAIN_INVARIANTS.md`,
  `docs/STATE_MACHINES.md`, `docs/ARCHITECTURE.md`, `prisma/schema.prisma`,
  to verify targeted member lifecycle services/tests.
- Acceptance criteria: Durable history and hard-delete blockers are mapped;
  token and confirmation paths are marked confirmed or to verify; follow-up
  issues keep financial, booking, family, audit, and Xero history intact.
- Validation commands: `git diff --check`; `DATABASE_URL=postgresql://user:pass@localhost:5432/tacbookings npx prisma validate`
- Exact Codex prompt to run that issue:

```text
Read AGENTS.md first and obey it. Work exactly one issue: Membership, family, dependent, cancellation, archive/delete lifecycle review. This is review-only. Read the issue body and named context files, then inspect only targeted membership, family, dependent, cancellation, archive/delete, token, email, audit, and Xero contact sync files needed to verify lifecycle integrity. Do not edit app code, use production data, or run broad tests. Output concise confirmed findings and to-verify gaps, preserving durable-history requirements in any follow-up. Run only the validation commands named in the issue.
```

## 7. Payment, refund, credit, and accounting consistency review

- Title: Payment, refund, credit, and accounting consistency review
- Workstream: Money, refunds, credits, and accounting
- Risk: Critical
- Recommended effort: xhigh
- Mode: Review-only, human-attended, no app code edits
- Goal: Verify integer-cent money handling, Stripe and Internet Banking/Xero
  separation, refund totals, member credits, supplementary invoices, credit
  notes, audit, and reconciliation expectations.
- Context files to read: `AGENTS.md`, `docs/DOMAIN_INVARIANTS.md`,
  `docs/STATE_MACHINES.md`, `docs/ARCHITECTURE.md`,
  `docs/END_TO_END_TEST_MATRIX.md`, `prisma/schema.prisma`, to verify targeted
  payment/refund/credit/Xero accounting services/tests.
- Acceptance criteria: Money paths are grouped by source and state; accounting
  consistency checks are confirmed or to verify; follow-up issues name mocked
  provider tests and avoid live provider steps.
- Validation commands: `git diff --check`; `DATABASE_URL=postgresql://user:pass@localhost:5432/tacbookings npx prisma validate`
- Exact Codex prompt to run that issue:

```text
Read AGENTS.md first and obey it. Work exactly one issue: Payment, refund, credit, and accounting consistency review. This is review-only. Read the issue body and named context files, then inspect only targeted payment, refund, credit, Stripe, Xero invoice, credit-note, audit, and reconciliation files needed to verify money invariants. Do not edit app code, do not call live providers, do not use production data, and do not run broad tests. Output concise confirmed findings and to-verify gaps. Run only the validation commands named in the issue.
```

## 8. Xero operational outbox and reconciliation review

- Title: Xero operational outbox and reconciliation review
- Workstream: Operational Xero reliability
- Risk: High
- Recommended effort: xhigh
- Mode: Review-only, human-attended, no app code edits
- Goal: Verify operational Xero outbox claiming, retry, stale reset, inbound
  event reconciliation, tenant selection, object links, health visibility, and
  repair paths without live Xero.
- Context files to read: `AGENTS.md`, `docs/ARCHITECTURE.md`,
  `docs/DOMAIN_INVARIANTS.md`, `docs/STATE_MACHINES.md`,
  `docs/SECURITY-ATTACK-SURFACE.md`, `prisma/schema.prisma`, to verify targeted
  Xero outbox/reconciliation services/tests.
- Acceptance criteria: Queue and reconciliation lifecycle is mapped; retry and
  alert behavior is confirmed or to verify; no live Xero steps or sensitive
  token details are included; follow-ups use mocked validation.
- Validation commands: `git diff --check`; `npm run lint`
- Exact Codex prompt to run that issue:

```text
Read AGENTS.md first and obey it. Work exactly one issue: Xero operational outbox and reconciliation review. This is review-only. Read the issue body and named context files, then inspect only targeted operational Xero outbox, retry, reconciliation, object-link, health, repair, and mocked-test files needed to verify behavior. Do not call live Xero, use production data, expose token details, or run broad tests. Output concise confirmed findings and to-verify gaps with mocked follow-up validation. Run only the validation commands named in the issue.
```

## 9. Email, notification, retry, and suppression review

- Title: Email, notification, retry, and suppression review
- Workstream: Email and notification reliability
- Risk: High
- Recommended effort: high
- Mode: Review-only, human-attended, no app code edits
- Goal: Verify outbound email, templates, delivery policies, retry/backoff,
  SES/SNS feedback, suppression, admin visibility, redaction, and
  business-critical notification recovery.
- Context files to read: `AGENTS.md`, `docs/SECURITY-ATTACK-SURFACE.md`,
  `docs/DOMAIN_INVARIANTS.md`, `docs/STATE_MACHINES.md`,
  `docs/END_TO_END_TEST_MATRIX.md`, `prisma/schema.prisma`, to verify targeted
  email/notification services/tests.
- Acceptance criteria: Critical email flows and retry states are listed as
  confirmed or to verify; suppression and failure visibility are mapped; no
  live SES/SNS or mailbox actions are included.
- Validation commands: `git diff --check`; `npm run lint`
- Exact Codex prompt to run that issue:

```text
Read AGENTS.md first and obey it. Work exactly one issue: Email, notification, retry, and suppression review. This is review-only. Read the issue body and named context files, then inspect only targeted email, notification, retry, SES/SNS webhook, suppression, template, admin visibility, and mocked-test files needed to verify behavior. Do not call live SES/SNS, send live email, use production data, expose sensitive recipient data, or run broad tests. Output concise confirmed findings and to-verify gaps. Run only the validation commands named in the issue.
```

## 10. Admin, finance, and lodge recovery/visibility review

- Title: Admin, finance, and lodge recovery/visibility review
- Workstream: Operator visibility and recovery
- Risk: High
- Recommended effort: high
- Mode: Review-only, human-attended, no app code edits
- Goal: Verify admin, finance, lodge, kiosk, cron, import/export, audit,
  reports, health, queue visibility, failure surfacing, and operator repair
  paths.
- Context files to read: `AGENTS.md`, `docs/ARCHITECTURE.md`,
  `docs/DOMAIN_INVARIANTS.md`, `docs/STATE_MACHINES.md`,
  `docs/END_TO_END_TEST_MATRIX.md`, `prisma/schema.prisma`, to verify targeted
  admin/finance/lodge services/tests.
- Acceptance criteria: Operator surfaces are grouped by role and risk; recovery
  and visibility gaps are confirmed or to verify; follow-ups distinguish admin,
  finance, lodge, and cron ownership.
- Validation commands: `git diff --check`; `npm run lint`
- Exact Codex prompt to run that issue:

```text
Read AGENTS.md first and obey it. Work exactly one issue: Admin, finance, and lodge recovery/visibility review. This is review-only. Read the issue body and named context files, then inspect only targeted admin, finance, lodge, kiosk, cron, import/export, audit, reports, health, and queue visibility files needed to verify operator recovery paths. Do not edit app code, use production data, run browser automation against production, or run broad tests. Output concise confirmed findings and to-verify gaps. Run only the validation commands named in the issue.
```

## 11. UI/UX journey clarity and accessibility review

- Title: UI/UX journey clarity and accessibility review
- Workstream: UX and accessibility
- Risk: Medium
- Recommended effort: high
- Mode: Review-only, may run unattended if non-production only
- Goal: Review visitor, member, admin, finance, lodge, application, booking,
  payment, family, cancellation, waitlist, recovery, empty, pending, failure,
  and accessibility journeys for clarity.
- Context files to read: `AGENTS.md`, `docs/END_TO_END_TEST_MATRIX.md`,
  `docs/ARCHITECTURE.md`, `docs/DOMAIN_INVARIANTS.md`, to verify targeted UI
  flow docs, component tests, and non-production accessibility guidance.
- Acceptance criteria: Journey risks are grouped by persona; gaps are marked
  confirmed or to verify; no production browser automation is run; follow-ups
  include manual non-production checks where needed.
- Validation commands: `git diff --check`; `npm run lint`
- Exact Codex prompt to run that issue:

```text
Read AGENTS.md first and obey it. Work exactly one issue: UI/UX journey clarity and accessibility review. This is review-only. Read the issue body and named context files, then inspect only targeted UI flow docs, page/component files, and existing component or accessibility tests needed to verify journey clarity. Do not edit app code, do not run browser automation or accessibility scans against production, and do not run broad tests. Output concise confirmed findings and to-verify gaps, with non-production manual checks for follow-up. Run only the validation commands named in the issue.
```

## 12. Final release-readiness review

- Title: Final release-readiness review
- Workstream: Release readiness
- Risk: High
- Recommended effort: xhigh
- Mode: Review-only, human-attended, no app code edits
- Goal: Verify that prior review findings, docs, tests, CI, migration safety,
  dependency/security gates, deployment notes, validation evidence, and
  residual risks are ready for a public release decision.
- Context files to read: `AGENTS.md`, `docs/ARCHITECTURE.md`,
  `docs/DOMAIN_INVARIANTS.md`, `docs/END_TO_END_TEST_MATRIX.md`,
  `docs/SECURITY-ATTACK-SURFACE.md`, `package.json`, `prisma/schema.prisma`,
  to verify release-specific docs and PR evidence.
- Acceptance criteria: Release evidence is summarized; blockers and residual
  risks are separated; unresolved security details are kept non-public; no
  deploy, merge, or issue closure is performed without explicit approval.
- Validation commands: `git diff --check`; `npm run lint`; `DATABASE_URL=postgresql://user:pass@localhost:5432/tacbookings npx prisma validate`
- Exact Codex prompt to run that issue:

```text
Read AGENTS.md first and obey it. Work exactly one issue: Final release-readiness review. This is review-only. Read the issue body, named context files, and relevant release PR evidence. Do not edit app code, do not deploy, do not merge, do not close issues, do not use production credentials or live providers, and do not publish detailed public security findings. Summarize validation evidence, blockers, residual risks, and manual follow-up needed for release. Run only the validation commands named in the issue.
```
