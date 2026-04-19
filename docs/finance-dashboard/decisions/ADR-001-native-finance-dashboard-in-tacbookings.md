# ADR-001: Implement the Finance Dashboard Natively in TACBookings

## Status

Accepted

## Context

The current finance dashboard is a separate Streamlit application with:

- a shared password gate
- local file-based config and token storage
- CSV snapshot assumptions
- a Python runtime and subprocess-based refresh flow

TACBookings production is a Node/Next.js application with:

- first-party authentication
- role-aware layouts and APIs
- production cron scheduling
- operational Xero integration and booking data already in the database

## Decision

Implement the finance dashboard natively inside TACBookings under a dedicated `/finance` surface.

Do not embed, proxy, or iframe the Streamlit dashboard into production TACBookings.

## Consequences

### Positive

- reuse TACBookings authentication and session model
- remove shared password risk
- remove Python runtime dependency from production dashboard delivery
- use first-party booking and guest data directly
- align finance reporting with existing deployment, observability, and cron patterns

### Negative

- requires UI and calculation porting work rather than a thin wrapper
- needs new finance-specific route and permission model
