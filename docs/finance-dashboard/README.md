# Finance Dashboard Integration

This directory is the durable source of truth for operating and extending the native finance dashboard inside `TACBookings`.

Use these documents for production rollout, support handoff, and future finance development. Chat history is not the source of truth.

## Non-Developer Handoff

For rollout or support work that does not involve code changes, start here:

1. Use `/finance` as the native finance workspace once named-user rollout begins.
2. Confirm the approved users and access levels before changing finance access. `VIEWER` can read reports; `MANAGER` can connect finance Xero and trigger sync actions.
3. Follow `finance-rollout-cutover-checklist.md` before named-user rollout.
4. During rollout, record evidence in `finance-post-cutover-evidence-template.md`.
5. Keep the legacy dashboard available as fallback until `finance-legacy-freeze-monitoring-runbook.md` reaches `freeze eligible`.
6. Use `finance-legacy-retirement-runbook.md` only after freeze eligibility is recorded.

For technical implementation work, use `agent-runbook.md` and `handoff.md`.

## Current Baseline

- Phase 1 finance access-boundary implementation landed separately in task `#101` via PR `#102`.
- Operational Xero follow-up is currently closed on `main`; see `docs/XERO_HANDOFF.md` before reopening any Xero-adjacent scope.
- The native finance workspace, finance-only Xero boundary, snapshot storage, sync, reports, rollout checklist, freeze monitoring runbook, and retirement runbook are present on `main`.

## Objective

Deliver a native finance dashboard inside `TACBookings` that:

- uses existing TACBookings credentials and sessions
- allows access only to explicitly approved admins and members
- keeps finance Xero OAuth and API usage budget separate from the operational Xero integration
- replaces Checkfront-derived booking inputs with first-party TACBookings booking and guest data
- runs finance data sync automatically on a daily schedule

## Non-goals

- Embedding the existing Streamlit app into the production TACBookings container
- Reusing the operational Xero OAuth client, tokens, or daily usage budget for finance reporting
- Preserving the shared dashboard password model
- Keeping CSV files as the long-term production data store for finance datasets

## Constraints

- TACBookings production runtime is a Node/Next.js container, not a Python app runtime.
- Current admin layout admits only `ADMIN`; finance viewers must not require full admin privileges.
- TACBookings already contains operational Xero OAuth, usage metering, cron scheduling, and booking data.
- The finance dashboard requires accounting snapshots plus booking-derived occupancy and guest-night metrics.

## Delivery Model

1. Repo docs define architecture, sequencing, contracts, and handoff state.
2. GitHub issues define execution units and acceptance criteria.
3. GitHub PRs carry implementation, validation evidence, and next-step handoff.
4. Each agent session starts by reading this directory plus the linked issue/PR.

## GitHub Tracking

- Epic: `#92` Finance Dashboard Integration
- Phase 1: `#93` Architecture and access model
- Phase 2: `#94` Separate finance Xero boundary
- Phase 3: `#95` Finance snapshot storage and daily sync
- Phase 4: `#96` TACBookings booking and guest data adapter
- Phase 5: `#97` Finance dashboard shell and navigation
- Phase 6: `#98` Revenue and bookings reporting
- Phase 7: `#99` Costs, cash, and balance sheet reporting
- Phase 8: `#100` Rollout, cutover, and legacy retirement

## Document Index

- [phases.md](/home/ubuntu/TACBookings/docs/finance-dashboard/phases.md)
- [data-contracts.md](/home/ubuntu/TACBookings/docs/finance-dashboard/data-contracts.md)
- [finance-xero-config-contract.md](/home/ubuntu/TACBookings/docs/finance-dashboard/finance-xero-config-contract.md)
- [finance-snapshot-storage-contract.md](/home/ubuntu/TACBookings/docs/finance-dashboard/finance-snapshot-storage-contract.md)
- [finance-sync-service-contract.md](/home/ubuntu/TACBookings/docs/finance-dashboard/finance-sync-service-contract.md)
- [finance-sync-cron-contract.md](/home/ubuntu/TACBookings/docs/finance-dashboard/finance-sync-cron-contract.md)
- [finance-sync-diagnostics-contract.md](/home/ubuntu/TACBookings/docs/finance-dashboard/finance-sync-diagnostics-contract.md)
- [finance-manual-sync-contract.md](/home/ubuntu/TACBookings/docs/finance-dashboard/finance-manual-sync-contract.md)
- [finance-booking-metrics-contract.md](/home/ubuntu/TACBookings/docs/finance-dashboard/finance-booking-metrics-contract.md)
- [finance-landing-page-contract.md](/home/ubuntu/TACBookings/docs/finance-dashboard/finance-landing-page-contract.md)
- [finance-bookings-report-contract.md](/home/ubuntu/TACBookings/docs/finance-dashboard/finance-bookings-report-contract.md)
- [finance-revenue-report-contract.md](/home/ubuntu/TACBookings/docs/finance-dashboard/finance-revenue-report-contract.md)
- [finance-costs-report-contract.md](/home/ubuntu/TACBookings/docs/finance-dashboard/finance-costs-report-contract.md)
- [finance-pricing-sensitivity-report-contract.md](/home/ubuntu/TACBookings/docs/finance-dashboard/finance-pricing-sensitivity-report-contract.md)
- [finance-working-capital-report-contract.md](/home/ubuntu/TACBookings/docs/finance-dashboard/finance-working-capital-report-contract.md)
- [finance-cash-report-contract.md](/home/ubuntu/TACBookings/docs/finance-dashboard/finance-cash-report-contract.md)
- [finance-balance-sheet-report-contract.md](/home/ubuntu/TACBookings/docs/finance-dashboard/finance-balance-sheet-report-contract.md)
- [finance-rollout-cutover-checklist.md](/home/ubuntu/TACBookings/docs/finance-dashboard/finance-rollout-cutover-checklist.md)
- [finance-legacy-freeze-monitoring-runbook.md](/home/ubuntu/TACBookings/docs/finance-dashboard/finance-legacy-freeze-monitoring-runbook.md)
- [finance-legacy-retirement-runbook.md](/home/ubuntu/TACBookings/docs/finance-dashboard/finance-legacy-retirement-runbook.md)
- [finance-post-cutover-evidence-template.md](/home/ubuntu/TACBookings/docs/finance-dashboard/finance-post-cutover-evidence-template.md)
- [test-plan.md](/home/ubuntu/TACBookings/docs/finance-dashboard/test-plan.md)
- [agent-runbook.md](/home/ubuntu/TACBookings/docs/finance-dashboard/agent-runbook.md)
- [handoff.md](/home/ubuntu/TACBookings/docs/finance-dashboard/handoff.md)

### ADRs

- [ADR-001-native-finance-dashboard-in-tacbookings.md](/home/ubuntu/TACBookings/docs/finance-dashboard/decisions/ADR-001-native-finance-dashboard-in-tacbookings.md)
- [ADR-002-finance-access-control.md](/home/ubuntu/TACBookings/docs/finance-dashboard/decisions/ADR-002-finance-access-control.md)
- [ADR-003-separate-finance-xero-boundary.md](/home/ubuntu/TACBookings/docs/finance-dashboard/decisions/ADR-003-separate-finance-xero-boundary.md)
- [ADR-004-postgres-snapshots-over-csv.md](/home/ubuntu/TACBookings/docs/finance-dashboard/decisions/ADR-004-postgres-snapshots-over-csv.md)

## Working Rules

- Do not rely on undocumented metric definitions. Update `data-contracts.md` first.
- Do not merge behavior changes without corresponding acceptance criteria in the linked issue.
- Do not reuse operational Xero token storage for finance sync.
- Do not add finance access by broadening `ADMIN` unless an ADR explicitly changes that decision.
- Do not reopen operational Xero work unless current repo or production evidence proves a new gap; otherwise leave `docs/XERO_HANDOFF.md` unchanged.
- Update `handoff.md` whenever finance phase state or the next-agent instruction meaningfully changes.
- Future agents should follow `agent-runbook.md` and avoid reading unrelated project context.

## Planned Execution Shape

- Epic: `#92` Integrate finance dashboard into TACBookings
- Phase issues: `#93` through `#100`
- Task issues: only create once a phase is ready to split

## Recommended Session Start Prompt

Read:

- `docs/finance-dashboard/README.md`
- `docs/finance-dashboard/agent-runbook.md`
- `docs/finance-dashboard/handoff.md`
- `docs/XERO_HANDOFF.md` if the task could overlap Xero boundary work or the current handoff says to
- the linked GitHub issue and current PR, if any

Then execute the `Next Prompt` block from `handoff.md` if it exists. Only fall back to the runbook control loop when that block is missing or stale.
