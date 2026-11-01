-- #4453 review (S-F4): an audit row's request data may be cleared, never forged.
--
-- The audit-retention role exists to anonymise: after 90 days it sets
-- "ipAddress" and "userAgent" to NULL. Its column grant cannot say "only to
-- NULL", so without this trigger the credential could also write a made-up
-- address into any row. A BEFORE UPDATE trigger on just those two columns
-- refuses any UPDATE that changes either one to a non-NULL value, whoever runs
-- it. Clearing, or leaving it unchanged, is allowed.
--
-- No DELETE guard: deleting expired and archived rows is the retention job's
-- purpose, and which rows may go is the prune's predicate (#2506, #3939). A
-- trigger restating that predicate would be a second definition of the
-- retention policy that would drift from the first.
--
-- OLD CODE: the only UPDATE of these columns anywhere (application, scripts,
-- migrations) is `anonymizeExpiredAuditRequestData`, which sets both to NULL,
-- so both colours behave exactly as before. A column added to
-- AUDIT_ANONYMISED_REQUEST_COLUMNS later needs a migration extending this
-- function and its trigger's column list.
--
-- LOCK IMPACT: CREATE FUNCTION takes no table lock; CREATE TRIGGER takes SHARE
-- ROW EXCLUSIVE on "AuditLog" for this short DDL-only transaction, briefly
-- holding back audit inserts. No row is read or changed.
BEGIN;

CREATE FUNCTION "auditLogRequestDataOnlyClears"()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  IF (NEW."ipAddress" IS DISTINCT FROM OLD."ipAddress" AND NEW."ipAddress" IS NOT NULL)
     OR (NEW."userAgent" IS DISTINCT FROM OLD."userAgent" AND NEW."userAgent" IS NOT NULL) THEN
    RAISE EXCEPTION 'AuditLog request data (ipAddress, userAgent) may only be cleared, never set or changed (#4453).'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER "AuditLog_request_data_update_only_clears"
BEFORE UPDATE OF "ipAddress", "userAgent" ON "AuditLog"
FOR EACH ROW
EXECUTE FUNCTION "auditLogRequestDataOnlyClears"();

COMMIT;
