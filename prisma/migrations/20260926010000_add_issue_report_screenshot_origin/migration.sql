BEGIN;

-- #2703 (MAD epic #2725), INV-PRIV-020: admin-origin issue-report screenshots
-- are Full-Admin-only. That invariant is the one home for the rule; this
-- comment covers only the column.
--
-- THE DEFECT. Viewing an issue report needs "support: view", and "support" is a
-- separate permission area from "membership". So an officer given support access
-- to triage issue reports, and deliberately NOT given membership access, could
-- read member names, addresses and dates of birth off a screenshot captured on
-- an admin member page. An image walked through a boundary the permission model
-- draws.
--
-- WHAT THIS COLUMN IS. The privilege context the capture was taken in, as a
-- classification the SERVER decides, not a page address the client posts. The
-- owner rule is explicit that "pageUrl", route strings and caller flags are not
-- authority: "pageUrl" is posted by the reporting widget and is controllable by
-- anyone who can file a report, so a report claiming a harmless page must never
-- unlock a screenshot of a member page. The value is derived at creation from
-- the reporter's own stored access roles and from the signed session, and is
-- never recomputed or rewritten afterwards.
--
-- TWO VALUES, AND WHY THE ENUM IS CLOSED. ADMIN means the reporter could reach
-- admin screens at the moment they filed, so the pixels may hold another
-- member's record; those pixels now require the Full Admin role in addition to
-- the ordinary report-read permission. MEMBER means they could not, and that
-- screenshot keeps exactly the access model it has today. A PostgreSQL enum
-- rather than free text so no writer can invent a third classification that a
-- reader would then have to guess about.
--
-- EXPAND ONLY, AND NO STORED VALUE CHANGES. Two statements: CREATE TYPE, then a
-- NULLABLE ADD COLUMN with NO DEFAULT. NO DML OF ANY KIND, so every existing row
-- of every table is byte-identical afterwards.
--
-- WHY NULL IS TRUTHFUL, AND WHY THERE IS NO BACKFILL. NULL means "this row was
-- written before the classification existed", which is the honest state of every
-- stored report: nothing recorded the reporter's standing at the time and it
-- cannot be reconstructed now (the reporter's roles may have changed, and
-- "pageUrl" is the one thing that must not be used to reconstruct it). The
-- application reads NULL as ADMIN, so THE UNKNOWN CASE FAILS CLOSED: a
-- pre-release screenshot is withheld from a non-Full-Admin rather than shown.
-- A backfill was considered and refused by the owner decision on #2703, because
-- the only inputs available to it are the rejected ones; the existing 30-day
-- retention sweep drains the whole NULL population on its own within a release
-- cycle, after which every remaining row carries a real classification.
--
-- OLD-CODE COMPATIBLE IN BOTH WINDOWS. Prisma names its columns explicitly, so
-- the draining colour's generated client neither selects "screenshotOrigin" nor
-- knows the type, and its INSERTs omit the column -- which a nullable column
-- with no default accepts. A report filed through the old colour during the
-- window is stored NULL and is therefore withheld from non-Full-Admins by the
-- new colour, which is the strict direction. In the other direction the old
-- colour keeps serving screenshots exactly as it does on main today: that is
-- the pre-existing behaviour this issue fixes, not a new failure the migration
-- introduces, and it ends when the old colour stops serving.
--
-- LOCK IMPACT. CREATE TYPE takes no table lock. ADD COLUMN of a nullable enum
-- with no default is a catalog-only change that rewrites no row, taking ACCESS
-- EXCLUSIVE on "IssueReport" for the catalog update alone; reads and writes of
-- that one table block for the duration of a short DDL-only transaction.
-- "IssueReport" is not on the migration gate's hot-table list and is written
-- only when a member files a report. No index, constraint, trigger or foreign
-- key is added. The explicit BEGIN/COMMIT envelope means a later-statement
-- failure rolls the whole migration back. No advisory-lock key, lock order,
-- transaction boundary, status transition, capacity claim, settlement path or
-- new counterpart writer is introduced, so INV-LOCK-001 and INV-LOCK-002 are
-- unaffected; the runtime writer is the existing report-create, which sets the
-- column inside the INSERT it already performs and takes no lock at all.
--
-- REVERSE: drop the column, then the type. Only the classification is lost, and
-- every reader then falls back to the NULL reading, which is the strict one. No
-- rollback.sql is required because this is not a windowed migration.
-- IDEMPOTENCY: not idempotent (CREATE TYPE / ADD COLUMN); Prisma's ledger
-- prevents replay. NO SESSION CLOCK appears in a payload; the migration writes
-- no rows.

CREATE TYPE "IssueReportOrigin" AS ENUM ('ADMIN', 'MEMBER');

ALTER TABLE "IssueReport"
  ADD COLUMN "screenshotOrigin" "IssueReportOrigin";

COMMIT;
