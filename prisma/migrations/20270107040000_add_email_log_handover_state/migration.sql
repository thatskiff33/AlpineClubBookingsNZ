-- #5298 (INV-INT-043): how far a QUEUED email got towards the mail server, so a
-- row a crash left QUEUED is re-sent only when it provably never reached it.
-- Expand only: a new enum and one nullable column with no default and no
-- backfill. Every existing row reads null, which the sweep treats as "may have
-- been delivered". No row is rewritten and no other table is touched.

-- CreateEnum
CREATE TYPE "EmailHandoverState" AS ENUM ('PENDING', 'STARTED', 'UNCONFIRMED');

-- AlterTable
ALTER TABLE "EmailLog" ADD COLUMN "handoverState" "EmailHandoverState";
