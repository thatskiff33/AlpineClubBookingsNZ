# ADR-003: Keep a Separate Finance Xero OAuth Boundary

## Status

Accepted

## Context

The existing TACBookings Xero integration serves operational workflows such as:

- member contacts
- subscriptions
- booking invoices
- refund credit notes
- operational reconciliation

The finance dashboard has its own API-usage concerns and should not consume the same OAuth app, token pool, or usage budget.

## Decision

Implement finance reporting against a separate Xero OAuth client/app and separate persistence boundary inside the TACBookings codebase.

This means separate:

- environment variables
- token storage
- usage metering
- sync run history

It does not require a separate repository or separate production application.

## Consequences

### Positive

- preserves independent API budget and OAuth lifecycle
- avoids operational Xero workflows being impacted by finance reporting usage
- still allows one deployment and one user login surface

### Negative

- duplicates some Xero integration scaffolding
- requires care to keep operational and finance boundaries from being mixed in code
