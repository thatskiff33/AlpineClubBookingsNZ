/**
 * #4531: an inbound audit row can say what happened. The retire of a deleted
 * Xero payment's link passes its own summary, so the row reads "retired"
 * rather than the default "Xero payment reconciled".
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({ createAuditLog: vi.fn(), paymentFindMany: vi.fn() }));

vi.mock("@/lib/prisma", () => ({ prisma: { payment: { findMany: h.paymentFindMany } } }));
vi.mock("@/lib/audit", () => ({ createAuditLog: h.createAuditLog }));
vi.mock("@/lib/logger", () => ({ default: { warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() } }));

import { writeXeroInboundAuditLogs } from "@/lib/xero-inbound/audit";

const link = { localModel: "Payment", localId: "pay-1", xeroObjectType: "PAYMENT", xeroObjectId: "xpay-1", role: "INVOICE_PAYMENT" };

beforeEach(() => {
  vi.clearAllMocks();
  h.paymentFindMany.mockResolvedValue([{ id: "pay-1", bookingId: "booking-1", booking: { memberId: "member-1" } }]);
});

describe("inbound Xero audit rows (#4531)", () => {
  it("keep the default summary when none is given", async () => {
    await writeXeroInboundAuditLogs({ source: "xero-inbound-payment", links: [link] });
    expect(h.createAuditLog).toHaveBeenCalledWith(
      expect.objectContaining({ summary: "Xero payment reconciled", details: "Xero payment reconciled for Payment", category: "xero" }),
    );
  });

  it("carry the caller's summary, in the summary and the details", async () => {
    await writeXeroInboundAuditLogs({ source: "xero-inbound-deleted-payment-retired", links: [link], summary: "Xero payment link retired: payment deleted in Xero" });
    expect(h.createAuditLog).toHaveBeenCalledWith(
      expect.objectContaining({
        summary: "Xero payment link retired: payment deleted in Xero",
        details: "Xero payment link retired: payment deleted in Xero for Payment",
        category: "xero",
        metadata: expect.objectContaining({ source: "xero-inbound-deleted-payment-retired" }),
      }),
    );
  });
});
