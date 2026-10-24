-- Alpine Central Server API 2.2 (#61): eight non-member rates on the
-- other-lodge registry - a winter and a summer rate for each guideline age
-- group (under 5, 5-11, 12-17, 18+), per person per night, NZD incl. GST.
--
-- INTEGER CENTS (INV-MONEY-001). The central server carries dollars; the one
-- conversion is `src/lib/servernz-rate.ts`. Each CHECK holds the server's
-- bound (0..99999.99 dollars) so no writer can store what the server refuses.
--
-- PURELY ADDITIVE. Eight nullable INTEGER columns with no default, each with a
-- CHECK that every existing row (NULL) satisfies. NO DML: nothing is rewritten
-- and existing lodges read as "not set" until the next download.
--
-- OLD-CODE COMPATIBLE: the draining colour's client never names these columns;
-- its inserts leave them NULL and its reads ignore them.
--
-- LOCK IMPACT: one catalogue-only ALTER taking ACCESS EXCLUSIVE on "OtherLodge"
-- briefly; adding a CHECK scans the table, which is a small admin registry and
-- not a hot table.

-- AlterTable
ALTER TABLE "OtherLodge"
  ADD COLUMN "winterRateUnder5Cents" INTEGER,
  ADD COLUMN "winterRate5To11Cents" INTEGER,
  ADD COLUMN "winterRate12To17Cents" INTEGER,
  ADD COLUMN "winterRateAdultCents" INTEGER,
  ADD COLUMN "summerRateUnder5Cents" INTEGER,
  ADD COLUMN "summerRate5To11Cents" INTEGER,
  ADD COLUMN "summerRate12To17Cents" INTEGER,
  ADD COLUMN "summerRateAdultCents" INTEGER,
  ADD CONSTRAINT "OtherLodge_winterRateUnder5Cents_range" CHECK ("winterRateUnder5Cents" BETWEEN 0 AND 9999999),
  ADD CONSTRAINT "OtherLodge_winterRate5To11Cents_range" CHECK ("winterRate5To11Cents" BETWEEN 0 AND 9999999),
  ADD CONSTRAINT "OtherLodge_winterRate12To17Cents_range" CHECK ("winterRate12To17Cents" BETWEEN 0 AND 9999999),
  ADD CONSTRAINT "OtherLodge_winterRateAdultCents_range" CHECK ("winterRateAdultCents" BETWEEN 0 AND 9999999),
  ADD CONSTRAINT "OtherLodge_summerRateUnder5Cents_range" CHECK ("summerRateUnder5Cents" BETWEEN 0 AND 9999999),
  ADD CONSTRAINT "OtherLodge_summerRate5To11Cents_range" CHECK ("summerRate5To11Cents" BETWEEN 0 AND 9999999),
  ADD CONSTRAINT "OtherLodge_summerRate12To17Cents_range" CHECK ("summerRate12To17Cents" BETWEEN 0 AND 9999999),
  ADD CONSTRAINT "OtherLodge_summerRateAdultCents_range" CHECK ("summerRateAdultCents" BETWEEN 0 AND 9999999);
