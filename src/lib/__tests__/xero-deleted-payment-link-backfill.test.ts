/**
 * #4531: the backfill's dry run lists only active links of payments Xero lists
 * DELETED and writes nothing; `--apply` retires only those Xero confirms again.
 * Synthetic fixtures and a doubled Xero client only.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  linkFindMany: vi.fn(),
  linkUpdateMany: vi.fn(),
  linkFindUnique: vi.fn(),
  budgetAllows: vi.fn(),
  writeAudit: vi.fn(),
  getPayments: vi.fn(),
  getPayment: vi.fn(),
}));

vi.mock("@/lib/prisma", () => ({
  prisma: {
    xeroObjectLink: { findMany: h.linkFindMany, updateMany: h.linkUpdateMany, findUnique: h.linkFindUnique },
  },
}));
vi.mock("@/lib/xero-api-usage", () => ({ xeroDailyBudgetAllowsDeferrableCall: h.budgetAllows }));
vi.mock("@/lib/xero-inbound/audit", () => ({ writeXeroInboundAuditLogs: h.writeAudit }));
vi.mock("@/lib/logger", () => ({ default: { warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() } }));
vi.mock("@/lib/xero-api-client", async (importOriginal) => {
  const actual = (await importOriginal()) as typeof import("@/lib/xero-api-client");
  return { ...actual, callXeroApi: (fn: () => Promise<unknown>) => fn() };
});

import { XeroDailyLimitError } from "@/lib/xero-api-client";
import {
  applyDeletedPaymentLinkBackfill,
  DELETED_PAYMENT_LIST_PAGE_SIZE,
  findDeletedPaymentLinkBackfill,
  formatDeletedPaymentLinkBackfillReport,
} from "@/lib/xero-deleted-payment-link-backfill";

const UPDATED = new Date("2026-06-30T10:00:00.000Z");
const session = { tenantId: "tenant-test", xero: { accountingApi: { getPayments: h.getPayments, getPayment: h.getPayment } } } as never;

function link(xeroObjectId: string) {
  return {
    id: `link-${xeroObjectId}`,
    localModel: "Payment",
    localId: `local-${xeroObjectId}`,
    role: "INVOICE_PAYMENT",
    xeroObjectId,
    xeroObjectNumber: null,
    metadata: { invoiceId: "inv-4531", amount: 120, status: null },
    updatedAt: UPDATED,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  h.budgetAllows.mockResolvedValue(true);
  h.linkUpdateMany.mockResolvedValue({ count: 1 });
  h.linkFindUnique.mockResolvedValue({ active: false, metadata: {}, updatedAt: UPDATED });
});

describe("the deleted-payment link backfill (#4531)", () => {
  it("dry run: names active links of payments Xero lists DELETED, and writes nothing", async () => {
    h.getPayments.mockResolvedValue({
      body: {
        payments: [
          { paymentID: "deleted-1", status: "DELETED" },
          // A filter Xero ignored must not make a live payment a candidate.
          { paymentID: "live-1", status: "AUTHORISED" },
        ],
      },
    });
    h.linkFindMany.mockResolvedValue([link("deleted-1")]);

    const report = await findDeletedPaymentLinkBackfill(session);

    expect(h.getPayments).toHaveBeenCalledWith("tenant-test", undefined, 'Status=="DELETED"', undefined, 1, DELETED_PAYMENT_LIST_PAGE_SIZE);
    expect(h.linkFindMany.mock.calls[0][0].where).toEqual({ xeroObjectType: "PAYMENT", active: true, xeroObjectId: { in: ["deleted-1"] } });
    expect(report).toMatchObject({ listedDeletedPayments: 1, pagesRead: 1, listComplete: true, xeroCalls: 1 });
    expect(report.candidates).toEqual([{ paymentId: "deleted-1", links: [link("deleted-1")] }]);
    expect(h.getPayment).not.toHaveBeenCalled();
    expect(h.linkUpdateMany).not.toHaveBeenCalled();
    expect(formatDeletedPaymentLinkBackfillReport(report)).toContain("link link-deleted-1: Payment local-deleted-1, INVOICE_PAYMENT, invoice inv-4531");
  });

  it("pages until a short page, and reports a list cut short by Xero's daily limit", async () => {
    const fullPage = Array.from({ length: DELETED_PAYMENT_LIST_PAGE_SIZE }, (_, index) => ({ paymentID: `d${index}`, status: "DELETED" }));
    h.getPayments.mockResolvedValueOnce({ body: { payments: fullPage } }).mockRejectedValueOnce(new XeroDailyLimitError(3600, false));
    h.linkFindMany.mockResolvedValue([]);
    const report = await findDeletedPaymentLinkBackfill(session);
    expect(report).toMatchObject({ listedDeletedPayments: DELETED_PAYMENT_LIST_PAGE_SIZE, pagesRead: 1, listComplete: false, xeroCalls: 2 });
  });

  it("lists nothing when the day's budget is already spent", async () => {
    h.budgetAllows.mockResolvedValue(false);
    const report = await findDeletedPaymentLinkBackfill(session);
    expect(h.getPayments).not.toHaveBeenCalled();
    expect(report).toMatchObject({ listedDeletedPayments: 0, listComplete: false, candidates: [] });
  });

  it("--apply: retires only the payments Xero confirms DELETED again", async () => {
    h.getPayments.mockResolvedValue({
      body: { payments: [{ paymentID: "deleted-1", status: "DELETED" }, { paymentID: "deleted-2", status: "DELETED" }] },
    });
    h.linkFindMany.mockResolvedValue([link("deleted-1"), link("deleted-2")]);
    h.getPayment.mockImplementation(async (_tenant: string, id: string) => ({
      body: { payments: [{ paymentID: id, status: id === "deleted-1" ? "DELETED" : "AUTHORISED" }] },
    }));

    const result = await applyDeletedPaymentLinkBackfill(session);

    expect(result).toMatchObject({ confirmedDeleted: ["deleted-1"], confirmedLive: ["deleted-2"], retiredLinks: 1, xeroCalls: 3 });
    expect(h.linkUpdateMany).toHaveBeenCalledTimes(1);
    expect(h.linkUpdateMany).toHaveBeenCalledWith({
      where: { id: "link-deleted-1", xeroObjectType: "PAYMENT", active: true, updatedAt: UPDATED },
      data: { active: false, metadata: { invoiceId: "inv-4531", amount: 120, status: "DELETED" } },
    });
    expect(h.writeAudit).toHaveBeenCalledWith(
      expect.objectContaining({ source: "xero-deleted-payment-link-backfill", links: [expect.objectContaining({ xeroObjectId: "deleted-1" })] }),
    );
  });

  it("--apply --payment scopes the run to the named payments", async () => {
    h.getPayments.mockResolvedValue({
      body: { payments: [{ paymentID: "deleted-1", status: "DELETED" }, { paymentID: "deleted-2", status: "DELETED" }] },
    });
    h.linkFindMany.mockResolvedValue([link("deleted-2")]);
    h.getPayment.mockResolvedValue({ body: { payments: [{ paymentID: "deleted-2", status: "DELETED" }] } });
    const result = await applyDeletedPaymentLinkBackfill(session, { paymentIds: ["deleted-2"] });
    expect(h.linkFindMany.mock.calls[0][0].where.xeroObjectId).toEqual({ in: ["deleted-2"] });
    expect(h.getPayment).toHaveBeenCalledTimes(1);
    expect(result.retiredLinks).toBe(1);
  });

  it("--apply: defers the rest once the budget is spent mid-run", async () => {
    h.getPayments.mockResolvedValue({
      body: { payments: [{ paymentID: "deleted-1", status: "DELETED" }, { paymentID: "deleted-2", status: "DELETED" }] },
    });
    h.linkFindMany.mockResolvedValue([link("deleted-1"), link("deleted-2")]);
    h.budgetAllows.mockResolvedValueOnce(true).mockResolvedValue(false);
    const result = await applyDeletedPaymentLinkBackfill(session);
    expect(h.getPayment).not.toHaveBeenCalled();
    expect(result).toMatchObject({ deferred: ["deleted-1", "deleted-2"], retiredLinks: 0 });
    expect(h.linkUpdateMany).not.toHaveBeenCalled();
  });
});
