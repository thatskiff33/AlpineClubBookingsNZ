# Audit Retention And Archive Runbook

This runbook covers the production audit-log retention job and the optional archive database used by TACBookings.

## Runtime

- The audit retention job runs inside the existing `data-pruning` cron in `src/instrumentation.ts`.
- Schedule: daily at `03:30 Pacific/Auckland`.
- The job only runs on app instances with `CRON_ENABLED=true`; blue/green web slots should keep `CRON_ENABLED=false`.
- Cron run summaries are recorded under the `data-pruning` job name and include anonymized, archived, main-pruned, and archive-pruned counts.

## Retention Policy

- Raw request data (`ipAddress`, `userAgent`) is anonymized after 90 days unless `incidentPreserved=true`.
- `sensitive_access` and `standard` audit logs older than 12 months are copied to the archive database and then deleted from the main database when an archive database is configured.
- `critical` audit logs remain in the main database for 7 years before pruning, subject to `expiresAt`.
- `diagnostic_high_volume` audit logs are pruned from the main database when their `expiresAt` passes and are not moved to the archive database.
- Archive rows older than 7 years are pruned from the archive database.

## Archive Database Env Vars

Set one of these on the cron-enabled production app instance:

```bash
AUDIT_ARCHIVE_DATABASE_URL=postgresql://...
# Backward-compatible alias:
AUDIT_LOG_ARCHIVE_DATABASE_URL=postgresql://...
```

`AUDIT_ARCHIVE_DATABASE_URL` is preferred. If neither variable is set, the retention job logs `archive-db-not-configured`, still anonymizes request data, and still prunes expired main-database audit rows.

The archive database can be a separate PostgreSQL database. The job creates and maintains the `AuditLogArchive` table and supporting indexes automatically. Do not point the archive URL at the primary `DATABASE_URL`; archive movement deletes copied eligible rows from the main audit table.

## Operator Checks

1. Confirm the cron-enabled app has exactly one archive URL set when archive movement is required.
2. Confirm the archive DB is included in infrastructure backups before enabling the URL.
3. After the next `data-pruning` run, check the cron summary for `archiveSkipped=false` and non-error completion.
4. If archive movement must be paused, remove the archive URL and restart only the cron-enabled app instance.
