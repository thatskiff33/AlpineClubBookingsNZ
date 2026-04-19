# Finance Xero Config Contract

This document defines the Phase 2 config boundary introduced by task `#105`.

## Goal

Reserve a finance-only Xero OAuth configuration surface before any finance token storage, connect/status routes, or sync jobs land.

## Finance Env Names

Use these env vars for finance Xero work only:

- `FINANCE_XERO_CLIENT_ID`
- `FINANCE_XERO_CLIENT_SECRET`
- `FINANCE_XERO_REDIRECT_URI`

These names are intentionally separate from the operational Xero env vars:

- `XERO_CLIENT_ID`
- `XERO_CLIENT_SECRET`
- `XERO_REDIRECT_URI`

## Boundary Rules

- Finance config loading must not fall back to operational `XERO_*` credentials.
- Operational Xero code keeps using the existing `XERO_*` env names.
- The default local finance redirect target is `http://localhost:3000/api/finance/xero/callback`.
- Defining the finance redirect URI here does not mean the finance callback route exists yet.

## Not In Scope Yet

Task `#105` does not add:

- finance token storage
- finance encryption key handling
- finance connect, callback, status, or disconnect routes
- finance sync jobs
- finance usage metering persistence

Those belong to later Phase 2 tasks once the config boundary is in place.
