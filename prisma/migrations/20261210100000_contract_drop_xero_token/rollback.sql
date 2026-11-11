-- Reverse script for 20261210100000_contract_drop_xero_token.
--
-- WHAT THIS IS FOR. That migration is declared `old_code_compatible=windowed` in
-- docs/BLUE_GREEN_MIGRATION_SAFETY.tsv, so its rollback boundary is the MIGRATE
-- step, not the cutover: once it commits, the previous release is already broken
-- and aborting the deploy no longer restores service. This script is the path that
-- undoes the schema change without a full restore. See
-- docs/BLUE_GREEN_MIGRATION_POLICY.md -> "A `windowed` migration moves the
-- rollback boundary".
--
-- Prisma never applies, checksums or even reads this file. Run it by hand, as the
-- migration role, against the database you are rolling back. Stop the new colour
-- first, run this, then start R2 (`20261124010000_add_xero_connection`).
--
-- WHAT IT RESTORES, AND WHAT IT DOES NOT.
--
--   * THE SHAPE of `XeroToken` as R2 left it, both follow functions, and the
--     statement trigger, copied from that migration so R2's follow behaviour is
--     the same definition again.
--   * ONE NON-SECRET ROW, when a `XeroConnection` row exists: id `r3-rollback`,
--     empty token columns, and the tenant, expiry, lease and timestamps copied
--     from the connection. When no connection row exists, nothing is inserted.
--     R2 treats no `XeroToken` row as not connected. `XeroConnection` and
--     `IntegrationCredential` are not deleted or updated.
--
--   * THE CIPHERTEXT IS NOT RESTORED, and cannot be. Those columns have been
--     empty since R2. R2 reads the credential store, so Xero keeps working on
--     the restored row. A rollback past R2, to a release that reads `XeroToken`
--     ciphertext, needs an administrator to reconnect Xero. The pre-migrate
--     backup is the only recovery of those columns.
--
-- The insert fires the restored trigger. Copying the same tenant and expiry
-- makes the follow function's update a no-op, and the trigger never writes the
-- lease column.

BEGIN;

CREATE TABLE "XeroToken" (
    "id" TEXT NOT NULL,
    "accessToken" TEXT NOT NULL DEFAULT '',
    "refreshToken" TEXT NOT NULL DEFAULT '',
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "tenantId" TEXT,
    "refreshInProgressUntil" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "XeroToken_pkey" PRIMARY KEY ("id")
);

CREATE FUNCTION xero_connection_follow_token()
RETURNS void
LANGUAGE plpgsql
AS $xero_connection_follow_token$
DECLARE
  stamp TIMESTAMP(3) := timezone('UTC', statement_timestamp());
BEGIN
  -- ONE statement, so every part of it reads one snapshot, taken after its lock
  -- on "XeroConnection" is granted. Separate statements would each read their
  -- own, and a write committing between them would be overwritten by the
  -- earlier read: a stale tenant or expiry, or a just-made connection deleted.
  WITH latest AS (
    SELECT "tenantId", "expiresAt"
      FROM "XeroToken"
     ORDER BY "updatedAt" DESC, "id" DESC
     LIMIT 1
  ),
  disconnected AS (
    DELETE FROM "XeroConnection"
     WHERE NOT EXISTS (SELECT 1 FROM "XeroToken")
  ),
  followed AS (
    UPDATE "XeroConnection" AS connection
       SET "tenantId" = latest."tenantId",
           "expiresAt" = latest."expiresAt",
           "updatedAt" = stamp
      FROM latest
     WHERE connection."id" = 'default'
       AND (connection."tenantId" IS DISTINCT FROM latest."tenantId"
            OR connection."expiresAt" IS DISTINCT FROM latest."expiresAt")
  )
  INSERT INTO "XeroConnection" ("id", "tenantId", "expiresAt", "createdAt", "updatedAt")
  SELECT 'default', latest."tenantId", latest."expiresAt", stamp, stamp
    FROM latest
   WHERE NOT EXISTS (SELECT 1 FROM "XeroConnection")
  ON CONFLICT ("id") DO NOTHING;
END
$xero_connection_follow_token$;

CREATE FUNCTION xero_connection_follow_token_trigger()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $xero_connection_follow_token_trigger$
BEGIN
  PERFORM xero_connection_follow_token();
  RETURN NULL;
END
$xero_connection_follow_token_trigger$;

CREATE TRIGGER "XeroToken_xero_connection_follow"
AFTER INSERT OR UPDATE OR DELETE OR TRUNCATE ON "XeroToken"
FOR EACH STATEMENT
EXECUTE FUNCTION xero_connection_follow_token_trigger();

INSERT INTO "XeroToken" (
    "id",
    "accessToken",
    "refreshToken",
    "expiresAt",
    "tenantId",
    "refreshInProgressUntil",
    "createdAt",
    "updatedAt"
)
SELECT
    'r3-rollback',
    '',
    '',
    "expiresAt",
    "tenantId",
    "refreshInProgressUntil",
    "createdAt",
    "updatedAt"
FROM "XeroConnection";

COMMIT;
