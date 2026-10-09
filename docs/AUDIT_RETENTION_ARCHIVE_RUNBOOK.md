# Audit Retention And Archive Runbook

This runbook covers the production audit-log retention job and the optional archive database used by AlpineClubBookingsNZ.

## Runtime

- The audit retention job runs inside the existing `data-pruning` cron in `src/instrumentation.ts`.
- Schedule: daily at `03:30` club time, in the club's saved timezone (`INV-CONFIG-002`).
- The job only runs on app instances with `CRON_ENABLED=true`; blue/green web slots should keep `CRON_ENABLED=false`.
- Cron run summaries are recorded under the `data-pruning` job name and include anonymized, archived, main-pruned, and archive-pruned counts.

## Retention Policy

- Raw request data (`ipAddress`, `userAgent`) is anonymized after 90 days unless `incidentPreserved=true`.
- `sensitive_access` and `standard` audit logs older than 12 months are copied to the archive database and then deleted from the main database when an archive database is configured.
- `critical` audit logs remain in the main database for 7 years before pruning, subject to `expiresAt`.
- `diagnostic_high_volume` audit logs are pruned from the main database when their `expiresAt` passes and are not moved to the archive database.
- Archive rows older than 7 years are pruned from the archive database.
- Unclassified rows (no `retentionClass`, from before every writer recorded a category) are pruned when their `expiresAt` passes unless their severity is `critical`, which keeps them for 7 years like the `critical` class. A row whose severity was **never set** counts as not critical and is pruned on its expiry (#3524); see "Unclassified rows with no severity" below.
- A row with no `expiresAt` at all is never pruned, whatever its class or severity. That is the deliberate keep-forever escape hatch, and #3524 did not change it.

## Hard invariant: prune never outruns archival (#2506)

**Prune may never delete an audit row that is destined for the archive but has not yet been archived.** The archive step copies at most a bounded 500 rows per night (oldest first), while pruning acts on `expiresAt`. Left ungated, a club sustaining more than 500 archive-eligible rows/day could accumulate a backlog large enough that an archivable row (`sensitive_access`, `standard`) reaches its `expiresAt` — 24 months for `sensitive_access`, 7 years for `standard` — while still sitting unarchived in the main table. Pruning it then would permanently delete a row the archive never received. The archive copy is the only surviving record once the source row is gone, so that loss is unrecoverable.

Two guards enforce the invariant, in depth (`src/lib/audit-retention.ts`):

1. **Cross-step guard.** If the archive step *throws* (most plausibly an archive schema drifted behind the `AuditLog` model), the whole retention job aborts before either prune runs. See "Adding a column to AuditLog", step 3.
2. **In-prune archive gate.** Even when the archive step *succeeds but is behind*, `pruneExpiredAuditLogs` refuses to delete an archivable-class row unless it is provably archived. When an archive is configured, the prune keys the archivable classes on the durable per-row `archivedAt` marker: a row is prune-eligible only once archival has captured it. Archival writes the row to the archive database and then removes it from the main table, so an archivable row still present in the main table is by definition unarchived and is retained — the prune waits, rather than deleting, until archival catches up. The gate lives inside the single `DELETE … WHERE` predicate, so PostgreSQL evaluates it atomically against committed rows and no stale watermark can be read even if an archive run is committing concurrently.

The accepted cost of this gate is that an expired archivable row can outlive its documented `expiresAt` while a backlog drains — a recoverable data-minimisation delay that resolves as archival catches up. Unrecoverable loss loses to recoverable delay.

Because that over-retention is otherwise invisible, the archive step emits a nightly **backlog warning** so drift does not go unnoticed: whenever a run's archive batch comes back full (the bounded 500 rows), more archivable rows remain unarchived, so the job logs `reason: "archive-backlog"` at `warn` level. A one-off warning is normal after a busy day and clears the first night the batch is not full; a warning that **persists** night after night means archival is falling behind — expired rows are being retained past their window — and archive throughput (or the batch size) should be investigated.

When **no** archive database is configured there is no archive to outrun and nowhere for the data to go, so archivable rows are pruned on `expiresAt` as normal; the gate applies only to the archive-active case. `diagnostic_high_volume` and the unclassified/`critical` classes are never archived, so they always prune on their own expiry regardless of archive state.

## Unclassified rows with no severity (#3524)

**What changed.** The prune used to keep an unclassified row whose severity was never set, indefinitely. Nobody chose that: the database reads "is not critical" as *unknown* rather than *yes* when the severity is empty, and an unknown never matches a delete. The owner decided on 6 Oct 2026 ([#3524](https://github.com/thatskiff33/AlpineClubBookingsNZ/issues/3524)) that such a row counts as **not critical**, so it now ages out on its own `expiresAt` like any other non-critical unclassified row.

**One deliberate asymmetry.** Today's writer, `classifyAuditRetention` in `src/lib/audit.ts`, files a new event with no severity and no special category as `critical` (seven years). A legacy row with no class and no severity is instead pruned at its explicit expiry. The two differ on purpose: the writer's rule governs rows recorded from now on, and #3524 only settles the rows that were recorded before every writer classified its events.

**What the first run after deploy does.** It deletes, once, every row that only this behaviour had kept: no `retentionClass`, no `severity`, and an `expiresAt` already in the past. They are not copied to the archive first (unclassified rows never are), so this is permanent. After that night the rows age out one by one as they reach their expiry, like everything else.

**Count them before you deploy, on a copy.** Run the query below on a **restored copy** of the production database, never on production itself and never on the primary. It only reads, and the transaction is opened read-only so a mistyped edit fails instead of running:

```sql
BEGIN TRANSACTION READ ONLY;

-- Rows the first post-deploy prune will delete that the previous release kept.
-- Exactly the widened predicate: unclassified, no severity, already expired.
SELECT count(*)              AS "willPrune",
       min("createdAt")      AS "oldestCreated",
       max("createdAt")      AS "newestCreated",
       max("expiresAt")      AS "latestExpiry"
FROM "AuditLog"
WHERE "retentionClass" IS NULL
  AND "severity" IS NULL
  AND "expiresAt" < timezone('UTC', now());

-- The same rows, by category and event name, so you can see what they are.
SELECT "category", "action", "incidentPreserved", count(*)
FROM "AuditLog"
WHERE "retentionClass" IS NULL
  AND "severity" IS NULL
  AND "expiresAt" < timezone('UTC', now())
GROUP BY 1, 2, 3
ORDER BY 4 DESC;

ROLLBACK;
```

`now()` is the moment you run it. The nightly job runs at 03:30 club time, so a row whose expiry falls between your count and that run is deleted too; it would have been deleted on that night under the new rule anyway. Rows with no `expiresAt` are not in this count and are not deleted.

If the number is larger than you expected, or the breakdown shows entries the club wants to keep, hold the deploy and raise it on the issue before upgrading. Do not edit the audit rows by hand to save them: the audit log is append-only evidence.

## Archive Database Env Vars

Set one of these on the cron-enabled production app instance:

```bash
AUDIT_ARCHIVE_DATABASE_URL=postgresql://...
# Backward-compatible alias:
AUDIT_LOG_ARCHIVE_DATABASE_URL=postgresql://...
```

`AUDIT_ARCHIVE_DATABASE_URL` is preferred. If neither variable is set, the retention job logs `archive-db-not-configured`, still anonymizes request data, and still prunes expired main-database audit rows on `expiresAt`. That applies only when no archive is *configured*. When an archive **is** configured, pruning of the archivable classes is gated on archival — a configured archive that **fails** stops the pruning entirely ("Adding a column to AuditLog", step 3), and a configured archive that merely **lags** retains the not-yet-archived rows ("Hard invariant: prune never outruns archival").

The archive database can be a separate PostgreSQL database. The job creates and maintains the `AuditLogArchive` table and supporting indexes automatically. Do not point the archive URL at the primary `DATABASE_URL`; archive movement deletes copied eligible rows from the main audit table.

## Archive Table Columns

`AuditLogArchive` mirrors **every** column of the `AuditLog` model. The archive copy is the only surviving record — archive movement deletes the source row — so a column left out of the archive would be lost permanently.

Coverage is no longer a hand-kept list. `src/lib/audit-retention.ts` holds one manifest, `AUDIT_ARCHIVE_COLUMNS`, and generates all three archive surfaces from it: the Prisma `select` that reads eligible rows, the `CREATE TABLE` that provisions the archive, and the `INSERT` that writes each row. The manifest's key type comes from the `AuditLog` model itself, so the coverage is exhaustive by construction (#2290).

Two columns are stored differently from the main table, by design:

- `archivedAt` records when the copy was written and is `NOT NULL` in the archive, even though it is nullable in the main table.
- `ipAddress` and `userAgent` are written as `NULL` unless the row is `incidentPreserved`, matching the 90-day request-data policy above.

### Adding a column to AuditLog

1. **Nothing to remember in the app.** Adding a column to the `AuditLog` model fails the TypeScript build in `src/lib/audit-retention.ts` until the column is added to `AUDIT_ARCHIVE_COLUMNS` (one line: its archive column type) or listed in `AUDIT_ARCHIVE_EXCLUDED_COLUMNS` with a written reason for dropping it on archival. `src/lib/__tests__/audit-archive-columns.test.ts` checks the same contract in CI.

2. **An existing archive database needs a migration.** The job provisions the archive table with `CREATE TABLE IF NOT EXISTS`, so an archive database created before the new column will not gain it automatically. Add it once, on the archive database, before the next `data-pruning` run:

   ```sql
   ALTER TABLE "AuditLogArchive" ADD COLUMN IF NOT EXISTS "newColumn" TEXT;
   ```

   Use the manifest's SQL type (`TEXT`, `TIMESTAMP(3)`, `JSONB`, `BOOLEAN`, ...) but **add the column nullable, even when the manifest declares `NOT NULL`**. Rows already in the archive predate the column and genuinely have no value for it, so `ADD COLUMN ... NOT NULL` is rejected by PostgreSQL on a populated table (`column ... contains null values`). The manifest's `NOT NULL` describes a *freshly provisioned* archive, where every row is written by the `INSERT` and always carries a value.

   The one exception is a manifest entry that declares a keyword default, such as `BOOLEAN NOT NULL DEFAULT false` — copy that verbatim, because PostgreSQL backfills the existing rows from the `DEFAULT`:

   ```sql
   ALTER TABLE "AuditLogArchive"
     ADD COLUMN IF NOT EXISTS "newFlag" BOOLEAN NOT NULL DEFAULT false;
   ```

   Leaving the column nullable on an older archive is safe and expected: the `INSERT` supplies a value for every row it writes, and the nullable column additionally tolerates the older rows that predate it. Do not try to backfill old rows to make the column `NOT NULL` — there is no correct historical value to invent.

3. **If step 2 is missed, the whole retention job stops — deliberately.** The `INSERT` names the new column, PostgreSQL rejects it, and the archive step raises before any row is deleted from the main table. Nothing is archived, **and no expired audit rows are pruned either** — not from the main database, and not from the archive. That is intentional: pruning deletes on `expiresAt` alone and does not check whether a row was archived, so letting it run while archiving is stalled would permanently delete audit rows the archive never received. Over-retaining for a few days is recoverable; deleting an unarchived row is not.

   So the blast radius of a missed `ALTER TABLE` is: **archiving paused + audit-retention deletions paused**, on the club's whole audit trail, until the archive table is corrected. The cron records a `data-pruning` FAILURE whose message names both halves. Treat it as time-bound, not cosmetic — extended over-retention of expired audit rows is a data-minimisation problem in its own right. The next nightly run catches up on both once the column exists.

### Checking an existing archive for drift

The archive must carry every column of the `AuditLog` model (minus anything listed in `AUDIT_ARCHIVE_EXCLUDED_COLUMNS`, which is empty today). Both lists can be read straight from PostgreSQL, so no access to the source is needed. Run the first query on the **main application database** and the second on the **archive database**:

```sql
-- Main database: the columns the archive is expected to carry.
SELECT string_agg(column_name, ', ' ORDER BY column_name) AS expected_columns
FROM information_schema.columns
WHERE table_schema = current_schema() AND table_name = 'AuditLog';
```

```sql
-- Archive database: the columns it actually carries.
SELECT string_agg(column_name, ', ' ORDER BY column_name) AS archive_columns
FROM information_schema.columns
WHERE table_schema = current_schema() AND table_name = 'AuditLogArchive';
```

The two strings must be identical. Anything in the first and not the second is the column to add with the `ALTER TABLE` above. `current_schema()` matches where the job creates the table, and keeps the result from picking up a same-named table in another schema on a shared server.

To inspect types and nullability as well — for example after applying an `ALTER TABLE` by hand — list them per column:

```sql
SELECT column_name, data_type, is_nullable
FROM information_schema.columns
WHERE table_schema = current_schema() AND table_name = 'AuditLogArchive'
ORDER BY column_name;
```

Expect `is_nullable = NO` only for `id`, `action`, `createdAt`, `archivedAt` and `incidentPreserved` on an archive provisioned from scratch. A column added later by hand shows `YES` even where the manifest says `NOT NULL`, which is the expected outcome of step 2 above and not drift.

Rows archived before a column existed keep `NULL` for it; the archive is not backfilled.

## Operator Checks

1. Confirm the cron-enabled app has exactly one archive URL set when archive movement is required.
2. Confirm the archive DB is included in infrastructure backups before enabling the URL.
3. After the next `data-pruning` run, check the cron summary for `archiveSkipped=false` and non-error completion.
4. If archive movement must be paused, remove the archive URL and restart only the cron-enabled app instance.
5. After a release that adds a column to `AuditLog`, apply the `ALTER TABLE` in "Adding a column to AuditLog" to the archive database before the next `data-pruning` run. If you are not sure whether a release added one, run the two drift queries in "Checking an existing archive for drift" — they need only database access.
6. Treat a `data-pruning` FAILURE that names the audit archive as time-bound. While it persists, expired audit rows are not being deleted from either database, so fix the archive schema (step 2) rather than waiting for it to clear on its own. The failure message states both halves.
