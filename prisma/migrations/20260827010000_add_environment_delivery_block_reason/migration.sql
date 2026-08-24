-- ENV-SAFETY 2 (#3035; epic #2986): record what the environment-safety delivery
-- boundary held back, distinguishably from every other reason a message was not
-- sent. INV-CONFIG-004.
--
-- Blue/green EXPAND migration (see docs/BLUE_GREEN_MIGRATION_SAFETY.tsv):
--  * registers one new EmailLogStatus label,
--  * creates one new enum type,
--  * adds one nullable column to EmailLog.
-- Nothing is dropped, renamed, retyped, backfilled or indexed.

-- Terminal, non-retryable outcome for a send held back because this
-- installation is a confirmed copy rather than the club's live site. The
-- migration only REGISTERS the label and never USES it, so Prisma's
-- per-migration transaction is safe (same pattern as 20260727120000, which
-- registered SKIPPED_NO_EMAILS on this same type).
ALTER TYPE "EmailLogStatus" ADD VALUE IF NOT EXISTS 'SKIPPED_NON_PRODUCTION';

-- CreateEnum
CREATE TYPE "EmailDeliveryBlockReason" AS ENUM ('ENVIRONMENT_DECLARATION_MISSING', 'ENVIRONMENT_DECLARATION_INVALID', 'ENVIRONMENT_OVERRIDE_UNREADABLE', 'CAPTURE_TRANSPORT_IN_PRODUCTION');

-- AlterTable: nullable, no default, so PostgreSQL records catalog metadata only
-- and rewrites no heap. Every existing EmailLog row reads NULL, which is the
-- correct value for it: nothing before this release could be blocked this way.
ALTER TABLE "EmailLog" ADD COLUMN     "deliveryBlockReason" "EmailDeliveryBlockReason";
