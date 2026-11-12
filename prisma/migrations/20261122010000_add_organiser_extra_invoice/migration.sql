-- #4299 (`INV-PAY-142`, owner decisions 25 Oct 2026): the group organiser's
-- extra invoice for a change that raised the price of a joiner's place the
-- organiser paid for by Internet Banking. Purely additive: a new table the
-- draining old colour never reads or writes, one foreign key to
-- "BookingModification" (a cold table: no write on it is blocked beyond the
-- key's own validation of an empty table), no backfill. Rows are written by
-- the new release's edit doors and by the back-bill repair.
CREATE TABLE "OrganiserExtraInvoice" (
    "id" TEXT NOT NULL,
    "bookingModificationId" TEXT NOT NULL,
    "bookingId" TEXT NOT NULL,
    "groupSettlementId" TEXT NOT NULL,
    "combinedInvoiceId" TEXT NOT NULL,
    "combinedInvoiceNumber" TEXT,
    "priceDiffCents" INTEGER NOT NULL,
    "changeFeeCents" INTEGER NOT NULL,
    "billedCents" INTEGER NOT NULL,
    "paidCents" INTEGER NOT NULL DEFAULT 0,
    "reducedCents" INTEGER NOT NULL DEFAULT 0,
    "refundedCents" INTEGER NOT NULL DEFAULT 0,
    "source" TEXT NOT NULL,
    "xeroInvoiceId" TEXT,
    "xeroInvoiceNumber" TEXT,
    "organiserNotifiedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "OrganiserExtraInvoice_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "OrganiserExtraInvoice_bookingModificationId_key" ON "OrganiserExtraInvoice"("bookingModificationId");
CREATE INDEX "OrganiserExtraInvoice_bookingId_idx" ON "OrganiserExtraInvoice"("bookingId");
CREATE INDEX "OrganiserExtraInvoice_groupSettlementId_idx" ON "OrganiserExtraInvoice"("groupSettlementId");

ALTER TABLE "OrganiserExtraInvoice" ADD CONSTRAINT "OrganiserExtraInvoice_bookingModificationId_fkey" FOREIGN KEY ("bookingModificationId") REFERENCES "BookingModification"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
