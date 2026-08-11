-- Record which Other Lodge (external/partner) a booking requester indicated
-- membership of, for the reciprocal "other club member" treatment at approval
-- time (#2749, Other Lodges epic). Additive EXPAND.
--
-- The new column is NULLABLE with no default, so ADD COLUMN is a catalog-only
-- change (no table rewrite, no backfill): every existing row reads NULL, which
-- means "No" (the form default, blank for backwards compatibility). The index
-- builds over a column that is NULL in every existing row, and the foreign-key
-- validation scan likewise finds only NULLs, so both hold their brief lock on
-- "BookingRequest" for a trivial, effectively empty scan rather than a full one.
-- No data is rewritten and no hot write path is blocked for more than that.

-- AlterTable
ALTER TABLE "BookingRequest" ADD COLUMN     "otherLodgeId" TEXT;

-- CreateIndex
CREATE INDEX "BookingRequest_otherLodgeId_idx" ON "BookingRequest"("otherLodgeId");

-- AddForeignKey
ALTER TABLE "BookingRequest" ADD CONSTRAINT "BookingRequest_otherLodgeId_fkey" FOREIGN KEY ("otherLodgeId") REFERENCES "OtherLodge"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
