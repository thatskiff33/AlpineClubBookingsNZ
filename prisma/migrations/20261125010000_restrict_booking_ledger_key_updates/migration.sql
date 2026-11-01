-- #4453 review (S-F1, N7): a ledger line may not be rewritten through its parent's key.
--
-- With the least-privilege roles the application may only INSERT and SELECT
-- "BookingLedgerLine". A referential action, though, runs with the rights of the
-- referencing table's OWNER, so the ledger's `ON UPDATE CASCADE` keys would let
-- an application that could UPDATE "Booking"."id" or "Lodge"."id" rewrite
-- `bookingId` and `lodgeId` on posted lines it may not touch directly.
--
-- So a key change on either parent is refused outright: a BEFORE UPDATE OF "id"
-- trigger on "Booking" and on "Lodge", firing only when the value really changes,
-- raises `restrict_violation` before any referential action can run. The foreign
-- keys are left exactly as they are. Changing their action would need DROP
-- CONSTRAINT, which takes ACCESS EXCLUSIVE on "Booking" and "Lodge" through a
-- validation scan and makes the deploy a breaking one; these triggers take SHARE
-- ROW EXCLUSIVE briefly, scan nothing, and need no override. The application
-- cannot disable them: that needs the table's owner, and
-- `session_replication_role` is superuser-only.
--
-- `bookingId` still has `ON DELETE CASCADE`: deleting a booking removes its
-- lines. That is booking deletion's behaviour, tracked in #4482.
--
-- OLD CODE: nothing in the application, the scripts or the migrations updates
-- "Booking"."id" or "Lodge"."id" (census in the #4479 PR), so both colours behave
-- exactly as before. No row changes: this is shape-only.
BEGIN;

CREATE FUNCTION "refuseKeyChange"()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'The key of a % row is immutable: booking-ledger lines may name it (#4453).', TG_TABLE_NAME
    USING ERRCODE = 'restrict_violation';
END;
$$;

CREATE TRIGGER "Booking_id_immutable"
BEFORE UPDATE OF "id" ON "Booking"
FOR EACH ROW
WHEN (OLD."id" IS DISTINCT FROM NEW."id")
EXECUTE FUNCTION "refuseKeyChange"();

CREATE TRIGGER "Lodge_id_immutable"
BEFORE UPDATE OF "id" ON "Lodge"
FOR EACH ROW
WHEN (OLD."id" IS DISTINCT FROM NEW."id")
EXECUTE FUNCTION "refuseKeyChange"();

COMMIT;
