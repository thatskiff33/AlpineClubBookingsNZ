# Finance Xero Config Contract

This document defines the Phase 2 finance Xero boundary introduced by tasks `#105` and `#108`.

## Goal

Reserve a finance-only Xero OAuth and persistence surface before finance connect/status routes or sync jobs land.

## Finance Env Names

Use these env vars for finance Xero work only:

- `FINANCE_XERO_CLIENT_ID`
- `FINANCE_XERO_CLIENT_SECRET`
- `FINANCE_XERO_REDIRECT_URI`
- `FINANCE_XERO_ENCRYPTION_KEY`

These names are intentionally separate from the operational Xero env vars:

- `XERO_CLIENT_ID`
- `XERO_CLIENT_SECRET`
- `XERO_REDIRECT_URI`

## Boundary Rules

- Finance config loading must not fall back to operational `XERO_*` credentials.
- Finance token encryption must not fall back to operational `XERO_ENCRYPTION_KEY`.
- Operational Xero code keeps using the existing `XERO_*` env names.
- The default local finance redirect target is `http://localhost:3000/api/finance/xero/callback`.
- Defining the finance redirect URI here does not mean the finance callback route exists yet.
- Finance stored tokens persist through `FinanceXeroToken`, not operational `XeroToken`.
- Finance API usage persists through `FinanceXeroApiUsageDaily` and `FinanceXeroApiUsageEvent`, not the operational metering tables.

## Not In Scope Yet

Tasks `#105` and `#108` do not add:

- finance connect, callback, status, or disconnect routes
- finance sync jobs

Those belong to later Phase 2 tasks once the config, token storage, and metering boundaries are in place.
