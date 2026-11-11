-- #3806 release R3 (owner decision 26 Oct 2026, confirmed 10 Nov 2026): one
-- maintenance window drops the follow trigger, both functions and the
-- `XeroToken` table together. R2 (`20261124010000_add_xero_connection`) already
-- moved the connection and the refresh lease to `XeroConnection` and stopped
-- reading and writing the token columns. This release assumes the #3454 colour
-- and the R2 colour are both stopped before migrate.
--
-- WHY THE WINDOW. R2's client still selects `XeroToken`. Once this drop
-- commits, that colour fails with relation-does-not-exist, and aborting the
-- deploy does not restore service. The operator stops the old web colour and
-- every old worker, scheduler and queue consumer, confirms no old database
-- connection remains, then migrates. The reverse script is the sibling
-- rollback.sql; Prisma never applies it.
--
-- FOUR STATEMENTS, one transaction (Prisma's migration transaction). No data
-- change, so there is no verification fixture.
--
-- LOCK IMPACT. Each statement takes a brief ACCESS EXCLUSIVE lock, or the
-- lock a trigger drop takes, on a one-row table (rarely two). No new advisory
-- key. With the application stopped there is nothing to queue behind; let the
-- deploy guard stop on lock timeout regardless.

DROP TRIGGER "XeroToken_xero_connection_follow" ON "XeroToken";

DROP FUNCTION xero_connection_follow_token_trigger();

DROP FUNCTION xero_connection_follow_token();

DROP TABLE "XeroToken";
