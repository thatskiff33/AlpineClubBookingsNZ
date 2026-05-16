# Finance Dashboard Test Plan

This initiative needs both automated and manual verification. Finance changes are not merge-ready with green CI alone.

## Required Automated Coverage

### Unit Tests

- finance access guard helpers
- finance Xero config and boundary separation
- finance snapshot mapping and persistence
- booking-to-finance metric adapters
- status inclusion and exclusion rules for guest nights and forward pipeline
- any financial calculation ported from the legacy dashboard

### Integration Tests

- finance route authorization
- finance Xero connect/status/manual-sync APIs
- daily finance sync cron behavior
- finance page loaders against seeded snapshot data

### Regression Tests

- operational Xero flows remain unaffected by finance Xero introduction
- existing admin-only pages do not become accessible to finance viewers
- booking metrics do not count cancelled, bumped, waitlisted, or draft stays

## Manual Verification

### Access and Security

- selected finance viewer can sign in and access `/finance`
- ordinary member cannot access `/finance`
- finance viewer cannot reach finance manager actions
- admin without finance access does not receive finance access implicitly unless intended

### Data Validation

- compare a representative period against the legacy dashboard
- verify guest nights and forward bookings against AlpineClubBookingsNZ records
- verify finance Xero sync row counts and last sync timestamps

### Operational Checks

- daily sync runs on schedule
- failures are visible in app diagnostics
- repeated syncs are overlap-safe
- finance Xero usage is visible independently from operational Xero usage

## PR Gate Checklist

Every finance PR should include:

- linked issue
- acceptance criteria checklist
- automated test evidence
- note on whether docs changed
- explicit statement of remaining risks

## Release Exit Gates

### Access And Xero Boundary

- permissions and finance Xero boundary are implemented and tested

### Data Pipeline

- snapshot pipeline and booking metric contracts are stable

### UAT

- full UAT across access, sync, and reports is complete
- cutover checklist is prepared
