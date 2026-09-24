BEGIN;

-- #3603 (owner decision D1 on PR #3608): session revocation is stored on the
-- server. A member whose login goes from on to off gets a "sessions revoked at"
-- time, and the per-request token refresh refuses any session issued before it,
-- exactly as it already refuses one issued before "passwordChangedAt". A cookie
-- copied before the switch-off therefore stays ended even after login is
-- switched back on: the refusal no longer depends on state the client holds.
--
-- THREE STATEMENTS, one transaction.
--
-- 1. ALTER TABLE ... ADD COLUMN: nullable, no default. Old-colour compatible:
--    the draining colour's generated client never selects the column and omits
--    it on writes, which a nullable column accepts.
--
-- 2. The trigger is the ONE writer of the column. It fires on every UPDATE that
--    moves "canLogin" from true to false, whichever path issues it. The census
--    of such writers when this was written: the admin member edit, the family
--    login-holder transfer, linking a member as a dependant with login
--    disabled, membership-cancellation approval, archive approval, deletion
--    anonymisation, and the age-up cron's compensating rollback. It equally
--    covers raw SQL, any future writer, and the draining colour during the
--    deploy window, none of which an application-side stamp could promise. It
--    never fires on INSERT: a row created without login has no session.
--
-- 3. The backfill stamps every member whose login is ALREADY off, so a session
--    minted before this release for such a member cannot be revived by a later
--    re-enable either. It writes only the new column (the existing
--    parent/partner statement trigger sees no edge change and does nothing).
--
-- Every value is explicit UTC (timezone('UTC', statement_timestamp())): the
-- column is a naive timestamp compared against the token's UTC issue time, so
-- session-local time would skew it on a non-UTC database.
--
-- LOCK IMPACT: ADD COLUMN with no default is catalog-only (no rewrite) and takes
-- ACCESS EXCLUSIVE on "Member" briefly; CREATE TRIGGER takes SHARE ROW
-- EXCLUSIVE; the backfill takes row locks on login-disabled members only. All
-- inside one short transaction, bounded by the deploy guard's lock timeout.
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

UPDATE "Member"
SET "sessionsRevokedAt" = timezone('UTC', statement_timestamp())
WHERE "canLogin" = false;

COMMIT;
