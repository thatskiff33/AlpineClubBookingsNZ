# Finance Dashboard Phases

This file defines the rollout order, boundaries, and exit criteria for the finance dashboard initiative.

GitHub tracking:
- Epic `#92`
- Phase 1 `#93`
- Phase 2 `#94`
- Phase 3 `#95`
- Phase 4 `#96`
- Phase 5 `#97`
- Phase 6 `#98`
- Phase 7 `#99`
- Phase 8 `#100`

## Phase 1: Architecture and Access Model

GitHub issue: `#93`

### Scope

- Confirm native TACBookings implementation
- Add finance access model design
- Define route structure and guard strategy
- Define finance manager vs finance viewer boundaries

### Deliverables

- Approved ADRs for architecture, access control, Xero boundary, and storage
- Initial schema proposal for finance access permissions
- Route plan for `/finance/*`

### Exit Criteria

- No unresolved architecture blockers
- Access model is specific enough to implement without reopening scope

## Phase 2: Finance Xero Boundary

GitHub issue: `#94`

### Scope

- Introduce a separate finance Xero OAuth client configuration
- Add dedicated token storage and usage metering
- Add finance connection status surface and admin-only connect/reconnect flows

### Deliverables

- Separate finance Xero env vars
- Finance token and usage tables
- Finance Xero service wrapper

### Exit Criteria

- Finance Xero auth can connect independently from operational Xero
- Finance usage can be measured independently

## Phase 3: Snapshot Storage and Daily Sync

GitHub issue: `#95`

### Scope

- Replace CSV snapshot assumptions with Postgres-backed finance snapshots
- Add daily finance sync cron jobs with overlap guards and run logging
- Define refresh failure behavior and observability

### Deliverables

- Snapshot schema
- Sync service and cron registration
- Admin diagnostics for last sync, row counts, and failures

### Exit Criteria

- Daily sync can run unattended
- Sync state is queryable from TACBookings

## Phase 4: Booking and Guest Data Adapter

GitHub issue: `#96`

### Scope

- Replace Checkfront inputs with TACBookings booking and guest data
- Define canonical guest-night, forward-booking, and occupancy contracts
- Add query layer for finance reporting pages

### Deliverables

- Finance booking adapter library
- Metric definitions in `data-contracts.md`
- Tests covering status handling and edge cases

### Exit Criteria

- Finance booking metrics no longer depend on Checkfront-shaped data
- Metric definitions are explicit and tested

## Phase 5: Finance Dashboard Shell

GitHub issue: `#97`

### Scope

- Create `/finance` route group and layout
- Add navigation entry points for allowed users
- Add page-level auth and unauthorized handling

### Deliverables

- Finance layout and guard helpers
- Navigation updates
- Initial landing page with sync status and section links

### Exit Criteria

- Authorized users can access the finance shell
- Unauthorized users cannot access finance routes or APIs

## Phase 6: Revenue and Bookings Reporting

GitHub issue: `#98`

### Scope

- Port the most valuable revenue, guest-night, and forward-booking views
- Rebuild charts and tables natively in TACBookings
- Validate output against source finance logic

### Deliverables

- Revenue and bookings page
- Supporting API/service layer
- Regression checks for key metrics

### Exit Criteria

- Stakeholders can use TACBookings for revenue and bookings finance reporting

## Phase 7: Costs, Cash, and Balance Sheet

GitHub issue: `#99`

### Scope

- Port costs and pricing sensitivity
- Port cash and working capital views
- Port balance sheet and equity views

### Deliverables

- Remaining finance reporting pages
- Supporting snapshot queries
- Validation notes for financial outputs

### Exit Criteria

- The TACBookings finance surface covers the functional scope of the legacy dashboard

## Phase 8: Rollout, Cutover, and Retirement

GitHub issue: `#100`

### Scope

- Final UAT and operations checks
- Access rollout to named users
- Legacy dashboard freeze and retirement

### Deliverables

- Cutover checklist
- Rollback notes
- Legacy shutdown steps

### Exit Criteria

- Named users are live on TACBookings finance dashboard
- Legacy dashboard is no longer the operational source

## Dependency Notes

- Phase 1 must finish before code changes beyond prototyping.
- Phase 2 must land before any production finance sync implementation.
- Phase 4 should complete before finalizing finance revenue views.
- Phase 8 should not begin until Phases 5-7 have completed UAT.
