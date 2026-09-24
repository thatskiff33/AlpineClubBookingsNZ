BEGIN;

-- #3603 (owner decision D1 on PR #3608): session revocation is stored on the
-- server. A member whose login goes from on to off gets a "sessions revoked at"
-- time, and the per-request token refresh refuses any session issued before it,
-- exactly as it already refuses one issued before "passwordChangedAt". A cookie
-- copied before the switch-off therefore stays ended even after login is
-- switched back on: the refusal no longer depends on state the client holds.
--
-- THREE STATEMENTS, one transaction: the column, its trigger function, and
-- the trigger. The backfill for members whose login is ALREADY off is the
-- next migration (20261009020000_backfill_member_sessions_revoked_at), so the
-- exclusive lock this ALTER takes is released when this transaction commits
-- rather than held across a data rewrite. Between the two, the trigger is live
-- for every new switch-off, and the refresh refuses any login-disabled member
-- outright, so nothing is uncovered.
--
-- 1. ALTER TABLE ... ADD COLUMN: nullable, no default. Old-colour compatible:
--    the draining colour's generated client never selects the column and omits
--    it on writes, which a nullable column accepts.
--
-- 2. The trigger is the ONE writer of the column for a switch-off. It fires on
--    every UPDATE that moves "canLogin" from true to false, whichever path
--    issues it. The census of such writers when this was written: the admin
--    member edit, the family login-holder transfer, linking a member as a
--    dependant with login disabled, membership-cancellation approval, archive
--    approval, deletion anonymisation, and the age-up cron's compensating
--    rollback. It equally covers raw SQL, any future writer, and the draining
--    colour during the deploy window, none of which an application-side stamp
--    could promise. It never fires on INSERT: a row created without login has
--    no session.
--
-- The stamp is explicit UTC (timezone('UTC', statement_timestamp())): the
-- column is a naive timestamp compared against the token's UTC issue time, so
-- session-local time would skew it on a non-UTC database.
--
-- LOCK IMPACT: ADD COLUMN with no default is catalog-only (no rewrite) and
-- takes ACCESS EXCLUSIVE on "Member"; CREATE TRIGGER takes SHARE ROW
-- EXCLUSIVE. Both are held only until this DDL-only transaction commits. The
-- deploy guard's lock timeout bounds how long the ALTER may WAIT for its lock,
-- not how long the lock is held; keeping the transaction DDL-only is what keeps
-- the hold short.
ALTER TABLE "Member"
  ADD COLUMN "sessionsRevokedAt" TIMESTAMP(3);

CREATE FUNCTION member_stamp_sessions_revoked_at()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $member_stamp_sessions_revoked_at$
BEGIN
  NEW."sessionsRevokedAt" := timezone('UTC', statement_timestamp());
  RETURN NEW;
END
$member_stamp_sessions_revoked_at$;

CREATE TRIGGER "Member_stamp_sessions_revoked_at"
BEFORE UPDATE OF "canLogin" ON "Member"
FOR EACH ROW
WHEN (OLD."canLogin" IS TRUE AND NEW."canLogin" IS FALSE)
EXECUTE FUNCTION member_stamp_sessions_revoked_at();

COMMIT;
