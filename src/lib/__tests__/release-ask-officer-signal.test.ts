import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  findFirst: vi.fn(),
  audit: vi.fn(),
  logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn() },
}));

vi.mock("@/lib/prisma", () => ({ prisma: { auditLog: { findFirst: mocks.findFirst } } }));
vi.mock("@/lib/audit", () => ({ createAuditLog: mocks.audit }));
vi.mock("@/lib/logger", () => ({ default: mocks.logger }));

import { signalCreditReleaseToOfficers } from "@/lib/release-ask-officer-signal";

/*
  #4253 release 2 (`INV-ADDPAY-051`): why a released-credit request is no longer chased by the app
  is told to the officers once, in the audit log they already read, keyed so a cron that meets the
  same request every pass adds nothing.
*/
beforeEach(() => {
  vi.clearAllMocks();
  mocks.findFirst.mockResolvedValue(null);
  mocks.audit.mockResolvedValue(undefined);
});

describe("signalCreditReleaseToOfficers", () => {
  it("writes one payment audit row on the booking, naming why", async () => {
    expect(
      await signalCreditReleaseToOfficers({ bookingId: "bk-1", reason: "invoice-part-paid", key: "k-1", metadata: { shareCents: 4000 } }),
    ).toBe(true);
    expect(mocks.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { action: "payment.credit_release_ask.left_to_officers", targetId: "bk-1", metadata: { path: ["key"], equals: "k-1" } },
      }),
    );
    expect(mocks.audit).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "payment.credit_release_ask.left_to_officers",
        entityType: "Booking",
        entityId: "bk-1",
        category: "payment",
        details: "invoice-part-paid",
        metadata: { key: "k-1", reason: "invoice-part-paid", shareCents: 4000 },
      }),
    );
  });

  it("writes nothing a second time for the same key", async () => {
    mocks.findFirst.mockResolvedValue({ id: "audit-1" });
    expect(await signalCreditReleaseToOfficers({ bookingId: "bk-1", reason: "waiting-on-edit-request", key: "k-1" })).toBe(false);
    expect(mocks.audit).not.toHaveBeenCalled();
  });

  it("never throws: the caller's wait or withhold happens whatever the audit log does", async () => {
    mocks.audit.mockRejectedValue(new Error("db down"));
    expect(await signalCreditReleaseToOfficers({ bookingId: "bk-1", reason: "request-unmatched", key: "k-2" })).toBe(false);
    expect(mocks.logger.error).toHaveBeenCalled();
  });
});
