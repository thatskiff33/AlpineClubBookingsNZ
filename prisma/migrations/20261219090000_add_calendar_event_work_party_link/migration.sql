-- Work party calendar link (fork #118): a nullable CalendarEvent column naming
-- the work party that manages the entry, its index, and a foreign key to
-- WorkPartyEvent. Work parties create one all-day occurrence per night of their
-- window; linked entries are read-only in the calendar.
--
-- Additive, blue/green-safe: a nullable ADD COLUMN is metadata-only on
-- PostgreSQL 11+ (no rewrite). The index and the foreign key are built over a
-- column that is NULL on every existing row. Neither CalendarEvent nor
-- WorkPartyEvent is a hot table. No DML. Old code never names the column, and
-- its inserts leave it NULL (an ordinary event). Its BLUE_GREEN_MIGRATION_SAFETY
-- ledger row records the reasoning.

-- AlterTable
ALTER TABLE "CalendarEvent" ADD COLUMN     "workPartyEventId" TEXT;

-- CreateIndex
CREATE INDEX "CalendarEvent_workPartyEventId_idx" ON "CalendarEvent"("workPartyEventId");

-- AddForeignKey
ALTER TABLE "CalendarEvent" ADD CONSTRAINT "CalendarEvent_workPartyEventId_fkey" FOREIGN KEY ("workPartyEventId") REFERENCES "WorkPartyEvent"("id") ON DELETE CASCADE ON UPDATE CASCADE;
