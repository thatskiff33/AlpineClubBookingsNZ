# Finance Rollout and Cutover Checklist

This document is the minimum pre-cutover checklist for phase `#100`.

It defines what must be true before named-user rollout, how to run final UAT against the landed finance surface, how to roll back safely, and when the legacy dashboard can move from primary workspace to fallback path.

This document does not itself execute rollout, change access, or retire the legacy dashboard.

## Scope Boundary

- Covers only the finance rollout readiness for the phase `#93` through `#99` work already landed on `main`
- Keeps operational Xero out of scope unless current implementation evidence proves a new gap
- Treats the legacy dashboard as required rollback coverage until the freeze criteria below are met

## Entry Criteria Before UAT

- Phase `#93` through phase `#99` are merged and closed, and the native finance workspace is available on `main`
- The rollout owner and rollback owner are identified before any named-user access change
- The named finance viewer and finance manager list is approved
- Finance sync diagnostics show a recent successful run with no unresolved repeated failures
- Representative snapshot periods are available for bookings, revenue, costs, cash, balance sheet, pricing sensitivity, and working capital validation
- The manual comparison window against the legacy dashboard is chosen before UAT starts

## UAT Checklist

### Access and Security

- An approved finance viewer can sign in and open `/finance`
- An approved finance viewer can open the landed native report routes:
  - `/finance/bookings`
  - `/finance/revenue`
  - `/finance/costs`
  - `/finance/pricing-sensitivity`
  - `/finance/cash`
  - `/finance/balance-sheet`
  - `/finance/working-capital`
- An ordinary member cannot open `/finance`
- A finance viewer cannot execute finance manager actions
- An admin without finance access does not receive finance access implicitly

### Sync and Observability

- Finance Xero connection status is healthy from the finance-manager surface
- The latest finance sync completed successfully and exposes usable timestamps and dataset coverage
- Failures remain visible from finance diagnostics with enough detail to route follow-up work
- Repeated syncs remain overlap-safe
- Finance Xero usage remains separate from operational Xero usage

### Report Validation

- `/finance` loads with current sync and source-summary sections
- `/finance/bookings` matches representative TACBookings booking and payment records
- `/finance/revenue` matches representative finance snapshot periods
- `/finance/costs` matches representative monthly finance snapshot periods
- `/finance/pricing-sensitivity` matches the representative occupancy-assumption inputs used for comparison
- `/finance/cash` matches representative `BANK_BALANCES` snapshots
- `/finance/balance-sheet` matches representative `BALANCE_SHEET` snapshots
- `/finance/working-capital` matches the current-assets and current-liabilities sections of representative `BALANCE_SHEET` snapshots

### Sign-off Evidence

- Record the UAT date, participants, representative comparison periods, and unresolved gaps in the linked GitHub issue or PR
- Do not mark rollout complete while normal finance reporting still depends on the legacy dashboard for any blocker-level path

## Cutover Checklist

### Pre-Cutover

- Confirm every UAT item above is complete
- Record stakeholder sign-off for access, sync health, and report-surface readiness
- Choose the named-user rollout window and communication owner
- Keep the legacy dashboard available as the rollback fallback during rollout

### Cutover

- Grant TACBookings finance access only to the approved named users
- Direct those users to `/finance` as the primary finance workspace
- Watch first-use activity for auth failures, missing data, and route-level errors

### Stabilization

- Monitor at least the next scheduled finance sync after rollout
- Recheck representative report routes after that sync completes
- Capture user-reported mismatches before starting any legacy-dashboard freeze step

## Rollback Notes

- Trigger rollback if finance access is broken, the latest sync is stale or failed, manager-only boundaries regress, or a blocker-level report mismatch appears
- Pause named-user rollout immediately if any rollback trigger is hit
- Tell affected users to resume the legacy dashboard for normal finance operations until the fix lands
- Remove newly granted finance access only if that is the fastest safe containment path
- Preserve finance snapshots and diagnostics for investigation; do not delete snapshot evidence during rollback
- Do not reopen operational Xero scope unless current implementation evidence proves that boundary caused the failure
- Exit rollback only after the replacement fix lands and targeted UAT is rerun

## Legacy Dashboard Freeze Criteria

- The UAT checklist is complete with no unresolved blocker that still requires normal legacy-dashboard usage
- Named users are actively using TACBookings finance routes for normal reporting
- At least one scheduled finance sync succeeds after named-user rollout without introducing blocker-level regressions
- Stakeholder sign-off for access, sync, and report parity is recorded
- Rollback notes are communicated before any legacy-dashboard freeze action begins
- Actual legacy-dashboard retirement remains a separate phase `#100` follow-up after these criteria are satisfied
