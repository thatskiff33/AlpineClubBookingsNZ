import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  prisma: {
    xeroSyncCursor: { findUnique: vi.fn() },
    memberCredit: { findMany: vi.fn() },
    paymentRecoveryOperation: { findMany: vi.fn() },
    payment: { findFirst: vi.fn() },
  },
  enqueue: vi.fn(),
  record: vi.fn(),
  close: vi.fn(),
  audit: vi.fn(),
}));

vi.mock("@/lib/prisma", () => ({ prisma: mocks.prisma }));
vi.mock("@/lib/audit", () => ({ createAuditLog: mocks.audit }));
vi.mock("@/lib/payment-recovery", () => ({ createAdditionalPaymentIntentRecoveryOnce: mocks.enqueue }));
vi.mock("@/lib/credit-release-xero-payment", () => ({ recordCreditReleasePayments: mocks.record }));
vi.mock("@/lib/credit-release-ask-close", () => ({ closeCreditReleaseAsksPaidInXero: mocks.close }));
vi.mock("@/lib/logger", () => ({ default: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));

import {
  CREDIT_RELEASE_BACKLOG_DEFAULT_PER_RUN,
  CREDIT_RELEASE_BACKLOG_MAX_PER_RUN,
  CREDIT_RELEASE_SETTLE_WINDOW_MS,
  creditReleaseAskWriterSince,
  creditReleaseBacklogPerRun,
  enqueueCreditReleaseAsks,
  runCreditReleaseAskSweep,
  runCreditReleaseBacklog,
} from "@/lib/credit-release-ask-sweep";
import {
  buildCreditReleaseAskRecoveryIdempotencyKey,
  buildCreditReleaseAskStripeIdempotencyKey,
} from "@/lib/credit-release-ask-keys";

/*
  #4253 (`INV-ADDPAY-045`): the sweep's switch, its enqueue and its error isolation.
  Time is the frozen test clock (2026-07-01); the settle window is measured from it.
*/
const NOW = new Date("2026-07-01T00:00:00.000Z");
const SINCE = new Date("2026-06-30T00:00:00.000Z");

beforeEach(() => {
  vi.clearAllMocks();
  mocks.prisma.xeroSyncCursor.findUnique.mockResolvedValue(null);
  mocks.prisma.memberCredit.findMany.mockResolvedValue([]);
  mocks.prisma.paymentRecoveryOperation.findMany.mockResolvedValue([]);
  mocks.prisma.payment.findFirst.mockResolvedValue({ id: "pay-1" });
  // Created by this call: the ordinary case.
  mocks.enqueue.mockResolvedValue(true);
  mocks.record.mockResolvedValue({ recorded: 0, held: 0, failed: 0, waiting: 0 });
  mocks.close.mockResolvedValue({ closed: 0, left: 0 });
});

describe("creditReleaseAskWriterSince", () => {
  const CREATED = new Date("2026-06-30T00:00:00.000Z");
  it.each([
    ["no row", null, null],
    ["enabled true", { metadata: { enabled: true }, createdAt: CREATED }, CREATED],
    ["enabled the string true", { metadata: { enabled: "true" }, createdAt: CREATED }, null],
    ["enabled false", { metadata: { enabled: false }, createdAt: CREATED }, null],
    ["no metadata", { metadata: null, createdAt: CREATED }, null],
    ["array metadata", { metadata: [true], createdAt: CREATED }, null],
  ])("%s", async (_name, row, expected) => {
    mocks.prisma.xeroSyncCursor.findUnique.mockResolvedValue(row);
    expect(await creditReleaseAskWriterSince()).toEqual(expected);
  });
});

describe("enqueueCreditReleaseAsks", () => {
  const release = { id: "rel-1", amountCents: 4000, appliedToBookingId: "bk-1" };

  it("only looks at releases older than the settle window", async () => {
    await enqueueCreditReleaseAsks({ now: NOW, since: SINCE });
    const where = mocks.prisma.memberCredit.findMany.mock.calls[0]![0].where;
    expect(where.createdAt.lt).toEqual(new Date(NOW.getTime() - CREDIT_RELEASE_SETTLE_WINDOW_MS));
    // Releases from before the switch row existed are the backlog, which is release 2's run.
    expect(where.createdAt.gte).toEqual(SINCE);
    expect(where.outsideSpendConvergedAt).toEqual({ not: null });
    expect(where.amountCents).toEqual({ gt: 0 });
  });

  it("enqueues one recovery row per release under the release-named key, with no supplementary invoice", async () => {
    mocks.prisma.memberCredit.findMany.mockResolvedValue([release]);
    expect(await enqueueCreditReleaseAsks({ now: NOW, since: SINCE })).toBe(1);
    expect(mocks.enqueue).toHaveBeenCalledWith({
      bookingId: "bk-1",
      paymentId: "pay-1",
      idempotencyKey: buildCreditReleaseAskRecoveryIdempotencyKey("rel-1"),
      amountCents: 4000,
      stripeIdempotencyKey: buildCreditReleaseAskStripeIdempotencyKey("rel-1"),
      hadIssuedXeroInvoice: false,
    });
  });

  it("never looks at the same release twice", async () => {
    mocks.prisma.memberCredit.findMany.mockResolvedValue([release]);
    mocks.prisma.paymentRecoveryOperation.findMany.mockResolvedValue([
      { idempotencyKey: buildCreditReleaseAskRecoveryIdempotencyKey("rel-1") },
    ]);
    expect(await enqueueCreditReleaseAsks({ now: NOW, since: SINCE })).toBe(0);
    expect(mocks.enqueue).not.toHaveBeenCalled();
  });

  it("skips a release whose booking has no payment row", async () => {
    mocks.prisma.memberCredit.findMany.mockResolvedValue([release]);
    mocks.prisma.payment.findFirst.mockResolvedValue(null);
    expect(await enqueueCreditReleaseAsks({ now: NOW, since: SINCE })).toBe(0);
    expect(mocks.enqueue).not.toHaveBeenCalled();
  });

  it("stops at the limit", async () => {
    mocks.prisma.memberCredit.findMany.mockResolvedValue([
      release,
      { ...release, id: "rel-2" },
      { ...release, id: "rel-3" },
    ]);
    expect(await enqueueCreditReleaseAsks({ now: NOW, limit: 2, since: SINCE })).toBe(2);
  });
});

describe("runCreditReleaseAskSweep", () => {
  it("raises nothing while the writer switch is off, but still records and closes", async () => {
    mocks.prisma.memberCredit.findMany.mockResolvedValue([{ id: "rel-1", amountCents: 4000, appliedToBookingId: "bk-1" }]);
    const result = await runCreditReleaseAskSweep();
    expect(result.enqueued).toBe(0);
    expect(mocks.prisma.memberCredit.findMany).not.toHaveBeenCalled();
    expect(mocks.enqueue).not.toHaveBeenCalled();
    expect(mocks.record).toHaveBeenCalledTimes(1);
    expect(mocks.close).toHaveBeenCalledTimes(1);
  });

  it("enqueues once the switch is on, and leaves the backlog alone while its own switch is off", async () => {
    mocks.prisma.xeroSyncCursor.findUnique.mockImplementation(async ({ where }) =>
      where.resourceType_scope.scope === "WRITER" ? { metadata: { enabled: true }, createdAt: SINCE } : null,
    );
    mocks.prisma.memberCredit.findMany.mockResolvedValue([{ id: "rel-1", amountCents: 4000, appliedToBookingId: "bk-1" }]);
    const result = await runCreditReleaseAskSweep();
    expect(result.enqueued).toBe(1);
    expect(result.backlogEnqueued).toBe(0);
    expect(mocks.audit).not.toHaveBeenCalled();
  });

  it("a failing step never stops the next, and the sweep still reports the failure", async () => {
    mocks.record.mockRejectedValue(new Error("xero down"));
    await expect(runCreditReleaseAskSweep()).rejects.toThrow(/1 credit-release sweep step/);
    expect(mocks.close).toHaveBeenCalledTimes(1);
  });
});

describe("the backlog (#4253 release 2, D4)", () => {
  const FLOOR = new Date("2026-06-30T00:00:00.000Z");
  const switches = (backlog: unknown, writer: unknown = { metadata: { enabled: true }, createdAt: FLOOR }) =>
    mocks.prisma.xeroSyncCursor.findUnique.mockImplementation(async ({ where }) =>
      where.resourceType_scope.scope === "WRITER" ? writer : backlog,
    );

  describe("creditReleaseBacklogPerRun", () => {
    it.each([
      ["no row", null, null],
      ["off", { metadata: { enabled: false } }, null],
      ["enabled the string true", { metadata: { enabled: "true" } }, null],
      ["no metadata", { metadata: null }, null],
      ["on, no size", { metadata: { enabled: true } }, CREDIT_RELEASE_BACKLOG_DEFAULT_PER_RUN],
      ["on, a size", { metadata: { enabled: true, perRun: 3 } }, 3],
      ["on, too big a size", { metadata: { enabled: true, perRun: 500 } }, CREDIT_RELEASE_BACKLOG_MAX_PER_RUN],
      ["on, a nonsense size", { metadata: { enabled: true, perRun: 0 } }, CREDIT_RELEASE_BACKLOG_DEFAULT_PER_RUN],
      ["on, a fractional size", { metadata: { enabled: true, perRun: 2.5 } }, CREDIT_RELEASE_BACKLOG_DEFAULT_PER_RUN],
    ])("%s", async (_name, row, expected) => {
      mocks.prisma.xeroSyncCursor.findUnique.mockResolvedValue(row);
      expect(await creditReleaseBacklogPerRun()).toEqual(expected);
    });
  });

  it("does nothing while the backlog switch is off", async () => {
    switches(null);
    expect(await runCreditReleaseBacklog()).toBe(0);
    expect(mocks.prisma.memberCredit.findMany).not.toHaveBeenCalled();
  });

  it("does nothing while the writer is off, however the backlog switch reads", async () => {
    switches({ metadata: { enabled: true } }, null);
    expect(await runCreditReleaseBacklog()).toBe(0);
    expect(mocks.prisma.memberCredit.findMany).not.toHaveBeenCalled();
  });

  it("takes only releases written before the writer's floor, in a small batch, and audits the batch", async () => {
    switches({ metadata: { enabled: true, perRun: 2 } });
    mocks.prisma.memberCredit.findMany.mockResolvedValue([
      { id: "rel-1", amountCents: 4000, appliedToBookingId: "bk-1" },
      { id: "rel-2", amountCents: 3000, appliedToBookingId: "bk-2" },
      { id: "rel-3", amountCents: 2000, appliedToBookingId: "bk-3" },
    ]);
    expect(await runCreditReleaseBacklog()).toBe(2);
    const where = mocks.prisma.memberCredit.findMany.mock.calls[0][0].where;
    expect(where.createdAt.gte).toBeUndefined();
    expect(where.createdAt.lt.getTime()).toBeLessThanOrEqual(FLOOR.getTime());
    expect(mocks.enqueue).toHaveBeenCalledTimes(2);
    expect(mocks.audit).toHaveBeenCalledTimes(1);
    expect(mocks.audit).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "payment.credit_release_ask.backlog_batch_taken",
        metadata: expect.objectContaining({ releaseIds: ["rel-1", "rel-2"], perRun: 2 }),
      }),
    );
  });

  it("still names the releases already queued when the enqueue fails part-way", async () => {
    switches({ metadata: { enabled: true } });
    mocks.prisma.memberCredit.findMany.mockResolvedValue([
      { id: "rel-1", amountCents: 4000, appliedToBookingId: "bk-1" },
      { id: "rel-2", amountCents: 3000, appliedToBookingId: "bk-2" },
    ]);
    mocks.enqueue.mockResolvedValueOnce(true).mockRejectedValueOnce(new Error("db down"));
    await expect(runCreditReleaseBacklog()).rejects.toThrow("db down");
    expect(mocks.audit).toHaveBeenCalledWith(
      expect.objectContaining({ metadata: expect.objectContaining({ releaseIds: ["rel-1"] }) }),
    );
  });

  it("counts and names only the requests THIS run created, when another payments cycle raised one first", async () => {
    switches({ metadata: { enabled: true, perRun: 2 } });
    mocks.prisma.memberCredit.findMany.mockResolvedValue([
      { id: "rel-1", amountCents: 4000, appliedToBookingId: "bk-1" },
      { id: "rel-2", amountCents: 3000, appliedToBookingId: "bk-2" },
      { id: "rel-3", amountCents: 2000, appliedToBookingId: "bk-3" },
    ]);
    // The overlapping cycle won rel-1's row; this run creates rel-2 and rel-3.
    mocks.enqueue.mockResolvedValueOnce(false).mockResolvedValue(true);
    expect(await runCreditReleaseBacklog()).toBe(2);
    expect(mocks.audit).toHaveBeenCalledTimes(1);
    expect(mocks.audit).toHaveBeenCalledWith(
      expect.objectContaining({ metadata: expect.objectContaining({ releaseIds: ["rel-2", "rel-3"] }) }),
    );
  });

  it("writes no batch row when the overlapping cycle raised every request first", async () => {
    switches({ metadata: { enabled: true } });
    mocks.prisma.memberCredit.findMany.mockResolvedValue([{ id: "rel-1", amountCents: 4000, appliedToBookingId: "bk-1" }]);
    mocks.enqueue.mockResolvedValue(false);
    expect(await runCreditReleaseBacklog()).toBe(0);
    expect(mocks.audit).not.toHaveBeenCalled();
  });

  it("writes no audit row for a batch that took nothing", async () => {
    switches({ metadata: { enabled: true } });
    expect(await runCreditReleaseBacklog()).toBe(0);
    expect(mocks.audit).not.toHaveBeenCalled();
  });

  it("never asks twice for a release the writer or an earlier batch already took", async () => {
    switches({ metadata: { enabled: true } });
    mocks.prisma.memberCredit.findMany.mockResolvedValue([{ id: "rel-1", amountCents: 4000, appliedToBookingId: "bk-1" }]);
    mocks.prisma.paymentRecoveryOperation.findMany.mockResolvedValue([
      { idempotencyKey: buildCreditReleaseAskRecoveryIdempotencyKey("rel-1") },
    ]);
    expect(await runCreditReleaseBacklog()).toBe(0);
    expect(mocks.enqueue).not.toHaveBeenCalled();
  });

  it("is a step of the sweep, error-isolated like the others", async () => {
    switches({ metadata: { enabled: true } });
    mocks.prisma.memberCredit.findMany.mockResolvedValue([{ id: "rel-1", amountCents: 4000, appliedToBookingId: "bk-1" }]);
    mocks.audit.mockRejectedValue(new Error("audit down"));
    await expect(runCreditReleaseAskSweep()).rejects.toThrow(/credit-release sweep step/);
    expect(mocks.record).toHaveBeenCalledTimes(1);
    expect(mocks.close).toHaveBeenCalledTimes(1);
  });
});
