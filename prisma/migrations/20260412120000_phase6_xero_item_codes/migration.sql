-- Phase 6: Add itemCode to XeroAccountMapping for Xero Item Code support
ALTER TABLE "XeroAccountMapping" ADD COLUMN "itemCode" TEXT;
