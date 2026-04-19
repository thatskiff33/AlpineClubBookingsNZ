# ADR-004: Store Finance Data in Postgres-Backed Snapshots Instead of CSV

## Status

Accepted

## Context

The legacy finance dashboard reads CSV snapshots from disk and refreshes them through local scripts.

TACBookings production runs in a read-only application container with Postgres already available as the system database.

## Decision

Persist finance reporting data in Postgres-backed snapshot or normalized finance tables, with sync metadata stored alongside them.

CSV files may be used during one-off migration or validation work, but they are not the target production architecture.

## Consequences

### Positive

- works with TACBookings production runtime and deployment model
- enables proper authorization, querying, and observability
- removes ad hoc file transfer and local HTTP export patterns

### Negative

- requires schema design and migrations
- may need snapshot retention and pruning policy
