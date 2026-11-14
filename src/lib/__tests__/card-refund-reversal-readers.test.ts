/**
 * #5017 review (`INV-PAY-151`): a failed-card-refund reversal invoice is money
 * back in the Stripe account, never the booking's bill. Every reader that
 * treats an invoice create or invoice link on the Payment as the booking's bill
 * excludes it.
 *
 * The filter itself, and the null-safe form that keeps a create with no queue
 * type, are proved on real PostgreSQL in
 * `card-refund-paid-another-way.realdb.test.ts`; the inbound void retirement
 * in `xero-deleted-payment-links.realdb.test.ts`. This file pins the repair
 * tool's admission guard by behaviour, and each reader's exclusion by census:
 * this test reads source from disk, so run it with `pnpm run test:named`.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { isAdmissibleRepairOperation } from "@/lib/xero-booking-repair-utils";
import { XERO_OUTBOX_CARD_REFUND_REVERSAL_INVOICE_TYPE } from "@/lib/xero-card-refund-reversal-outbox";

const BOOKING_INVOICE = "BOOKING_INVOICE";
const op = (queueType: string | null, requestPayload: unknown = null) => ({
  queueType,
  requestPayload,
  correlationKey: null,
  idempotencyKey: null,
});

describe("the repair tool never admits a reversal as the booking invoice (#5017)", () => {
  it("MUTATION: refuses a reversal named by its queue-type column or by its payload", () => {
    expect(isAdmissibleRepairOperation(op(XERO_OUTBOX_CARD_REFUND_REVERSAL_INVOICE_TYPE), BOOKING_INVOICE)).toBe(false);
    expect(isAdmissibleRepairOperation(op(XERO_OUTBOX_CARD_REFUND_REVERSAL_INVOICE_TYPE), undefined)).toBe(false);
    expect(
      isAdmissibleRepairOperation(op(null, { queueType: XERO_OUTBOX_CARD_REFUND_REVERSAL_INVOICE_TYPE }), undefined),
    ).toBe(false);
  });

  it("still admits a booking invoice, and a create with no queue type", () => {
    expect(isAdmissibleRepairOperation(op(BOOKING_INVOICE), BOOKING_INVOICE)).toBe(true);
    expect(isAdmissibleRepairOperation(op(null), BOOKING_INVOICE)).toBe(true);
  });
});

// Each reader and the number of exclusions it must carry. Removing one fails
// here; adding a reader means adding its row.
const READERS: Array<{ file: string; token: string; count: number }> = [
  { file: "src/lib/payment-reconciliation.ts", token: "...NOT_CARD_REFUND_REVERSAL_INVOICE,", count: 2 },
  { file: "src/lib/manual-booking-payment-state.ts", token: "...NOT_CARD_REFUND_REVERSAL_INVOICE,", count: 1 },
  { file: "src/app/api/admin/bookings/search/route.ts", token: "...NOT_CARD_REFUND_REVERSAL_INVOICE,", count: 1 },
  { file: "src/lib/xero-resolved-in-xero-fences.ts", token: "...NOT_CARD_REFUND_REVERSAL_INVOICE,", count: 1 },
  { file: "src/lib/xero-credit-note-outside-spend.ts", token: "...NOT_CARD_REFUND_REVERSAL_INVOICE_LINK,", count: 1 },
  { file: "src/lib/xero-inbound/modification-note-refunds.ts", token: "...NOT_CARD_REFUND_REVERSAL_INVOICE_LINK,", count: 1 },
  { file: "src/lib/xero-sync-now.ts", token: "link.role !== CARD_REFUND_REVERSAL_INVOICE_ROLE", count: 1 },
  { file: "src/lib/xero-booking-repair-analysis.ts", token: "isAdmissibleRepairOperation(operation, XERO_OUTBOX_BOOKING_INVOICE_TYPE)", count: 1 },
  { file: "src/lib/xero-inbound/invoice.ts", token: "...(retired ?? {}),", count: 1 },
];

describe("census: every booking-bill reader excludes the reversal (#5017)", () => {
  it.each(READERS)("$file carries its exclusion", ({ file, token, count }) => {
    const source = readFileSync(path.join(process.cwd(), file), "utf8");
    expect(source.split(token).length - 1).toBe(count);
  });
});
