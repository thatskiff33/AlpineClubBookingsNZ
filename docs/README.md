# Documentation

Start here when you are evaluating, adapting, or operating
AlpineClubBookingsNZ.

## New Adopters

1. Read `../README.md` for the product scope, stack, and quick setup.
2. Follow `IMPLEMENTATION_GUIDE.md` to configure a fork for your own club.
3. Use `../CONFIGURATION.md` as the environment and `config/club.json`
   reference.
4. Read `DEPLOYMENT.md` before putting a shared or production environment
   online.

## Developers

- `ARCHITECTURE.md` explains the runtime shape, module boundaries, data model,
  integrations, cron jobs, and deployment approach.
- `DOMAIN_INVARIANTS.md`, `STATE_MACHINES.md`,
  `END_TO_END_TEST_MATRIX.md`, and `UX_FLOW_MAP.md` capture the first-pass
  domain and review map used by Codex issue work.
- `CONCURRENCY_AND_LOCKING.md` maps the advisory-lock families (capacity,
  credit, member-night, and the single-domain locks), what each protects, and
  the ordering disciplines — read it before changing any lock key or adding a
  capacity/credit write path.
- `agents/CODEX_WORKFLOW.md` is the operating guide for Codex agents.
  `agents/ISSUE_WORKFLOW.md`, `agents/CODEX_PROMPTS.md`,
  `agents/PROFILE_GUIDE.md`, `agents/SUBAGENT_GUIDE.md`,
  `agents/REVIEW_SEVERITY.md`, and `agents/PROMPT_INJECTION_GUIDE.md` cover
  issue contracts, invocation prompts, execution profiles, subagent use,
  review severity, and prompt-injection handling.
- `ONGOING_DEVELOPMENT_WORKFLOW.md` explains how generic public changes and
  private deployment-fork changes should flow.
- `MAINTENANCE.md` records the public validation and release checklist.
- `E2E_PLAYWRIGHT.md` covers the Playwright browser E2E suite that drives the
  Critical journeys against the staging compose stack.
- `EMAIL_MESSAGE_REGISTRY.md` records the current outbound email templates,
  approved tokens, and subject/body safety rules.
- `xero/ARCHITECTURE.md` maps the operational Xero subsystem: module map,
  reconciliation-ledger data model, and sequence diagrams for the outbound,
  inbound, and repair flows.
- `STAGING_ACCESSIBILITY.md` covers non-production browser and Lighthouse
  checks.

## Operators

- `DEPLOYMENT.md` is the bootstrap and blue/green deployment reference.
- `UPGRADING.md` covers downstream release upgrades for deployment forks.
- `PRODUCTION_UPGRADE_RUNBOOK.md` is the owner-driven runbook for upgrading a
  live deployment across a release (pre-flight backup, blue/green migrate,
  post-upgrade checklist, and rollback).
- `BLUE_GREEN_MIGRATION_POLICY.md` defines how migrations must be structured
  for safe cutover.
- `CANCELLATIONS.md` documents membership cancellation refund, credit-note,
  and GST policy.
- `AUDIT_RETENTION_ARCHIVE_RUNBOOK.md` covers audit-log retention and optional
  archival.
- `TOKEN_HASHING.md` documents the current hash-at-rest token design.

## Finance Dashboard

The `finance-dashboard/` directory contains the finance reporting contracts,
architecture decisions, data-contract notes, and test plan. Start with
`finance-dashboard/README.md`.

## Multi-Lodge Support (In Progress)

The `multi-lodge/` directory contains the design, scoping contract,
implementation plan, and test plan for supporting more than one lodge
property. Start with `multi-lodge/README.md`.

## Configuration Export & Import (Planned)

The `config-transfer/` directory holds the decision records for the portable
configuration/content/lodge-setup export & import tool (feature issue
hoppers99/AlpineClubBookingsNZ#22). Start with `config-transfer/README.md`.
