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
- `FINANCE_XERO_ENCRYPTION_KEY_VERSION`
- `FINANCE_XERO_ENCRYPTION_KEY_PREVIOUS`

Finance Xero also requires its own OAuth app configuration:

- Redirect URI: `https://yourdomain.co.nz/api/finance/xero/callback` in production
- Scopes: `openid profile email accounting.contacts accounting.invoices accounting.payments accounting.settings.read accounting.reports.read offline_access`

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

## Finance Token Encryption Rotation

`FINANCE_XERO_ENCRYPTION_KEY` must be a 64-character hex string (32 bytes) and
is used only for finance Xero tokens. `FinanceXeroToken.encryptionKeyVersion`
records the key version used when tokens are written.

Planned rotation procedure:

1. Generate a new 32-byte hex key.
2. Set `FINANCE_XERO_ENCRYPTION_KEY_PREVIOUS` to the current key.
3. Set `FINANCE_XERO_ENCRYPTION_KEY` to the new key.
4. Increment `FINANCE_XERO_ENCRYPTION_KEY_VERSION`.
5. Deploy and run a finance Xero token refresh or reconnect. The token store can
   read existing tokens with the previous key and writes refreshed tokens with
   the current key version.
6. After confirming the stored row has the new `encryptionKeyVersion`, remove
   `FINANCE_XERO_ENCRYPTION_KEY_PREVIOUS`.

Recovery rule: if both the current and previous keys fail to decrypt the stored
row, the finance Xero connection is unrecoverable from the token row and a
finance manager must reconnect Xero to create fresh tokens.

## Not In Scope Yet

Tasks `#105` and `#108` do not add:

- finance connect, callback, status, or disconnect routes
- finance sync jobs

Those belong to later Phase 2 tasks once the config, token storage, and metering boundaries are in place.
