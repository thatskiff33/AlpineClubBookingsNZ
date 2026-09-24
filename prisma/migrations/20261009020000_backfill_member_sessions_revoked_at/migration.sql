-- #3603 (owner decision D1 on PR #3608): stamp the revocation time for every
-- member whose login is ALREADY off, so a session minted before this release for
-- such a member cannot be revived by a later re-enable either.
--
-- Its own migration, after 20261009010000_add_member_sessions_revoked_at has
-- committed: that DDL-only transaction takes the exclusive lock on "Member" and
-- releases it at commit, so this data rewrite runs under row locks only. The
-- trigger from that migration is already live, so a switch-off made between the
-- two is stamped by the trigger, and the "sessionsRevokedAt" IS NULL guard below
-- leaves that more accurate time alone. Until this statement runs, the token
-- refresh still refuses every login-disabled member outright, so nothing is
-- uncovered in the gap.
--
-- One value-scoped UPDATE, idempotent: a second run matches no rows. It writes
-- only the new column; the existing Member parent/partner statement trigger
-- sees no edge change and does nothing. Explicit UTC, never session time.
UPDATE "Member"
SET "sessionsRevokedAt" = timezone('UTC', statement_timestamp())
WHERE "canLogin" = false
  AND "sessionsRevokedAt" IS NULL;
