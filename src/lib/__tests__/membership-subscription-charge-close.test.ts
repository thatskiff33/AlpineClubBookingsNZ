import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * #4098: closing a membership subscription charge that conflicted because every
 * subscription it covers is already PAID. The race itself (two closes, a close
 * against a reversal) runs on real PostgreSQL in
 * `membership-subscription-charge-close.realdb.test.ts`; this file pins each
 * guard and each write's shape.
 */
const mocks = vi.hoisted(() => ({
  chargeFindUnique: vi.fn(),
  chargeUpdateMany: vi.fn(),
  subscriptionUpdateMany: vi.fn(),
  coverageUpdateMany: vi.fn(),
  audit: vi.fn(),
  findLiveOperation: vi.fn(),
  postSubscriptionCloseReceipt: vi.fn(async () => null),
  tx: {} as Record<string, unknown>,
}));

vi.mock("@/lib/prisma", () => {
  const tx = {
    membershipSubscriptionCharge: { findUnique: mocks.chargeFindUnique, updateMany: mocks.chargeUpdateMany },
    memberSubscription: { updateMany: mocks.subscriptionUpdateMany },
    membershipSubscriptionChargeCoverage: { updateMany: mocks.coverageUpdateMany },
  };
  mocks.tx = tx;
  return { prisma: { $transaction: vi.fn(async (callback: (client: typeof tx) => unknown) => callback(tx)) } };
});
vi.mock("@/lib/audit", () => ({ createAuditLog: mocks.audit }));
// #4519: R08's close receipt has its own suites; here the door only records the call.
vi.mock("@/lib/member-money/doors", async (importOriginal) => ({
  ...((await importOriginal()) as typeof import("@/lib/member-money/doors")),
  resolveSubscriptionMoneyPostingContext: vi.fn(async () => ({ journal: "context" })),
  postSubscriptionCloseReceipt: mocks.postSubscriptionCloseReceipt,
}));
vi.mock("@/lib/xero-subscription-invoices", () => ({
  findLiveSubscriptionInvoiceOperation: mocks.findLiveOperation,
}));

import {
  CloseAlreadyPaidChargeError,
  closeAlreadyPaidSubscriptionCharge,
} from "@/lib/membership-subscription-charge-close";

function conflictedCharge(overrides: Record<string, unknown> = {}) {
  return {
    id: "charge-1",
    seasonYear: 2026,
    status: "CONFLICT",
    billingBasis: "PER_FAMILY",
    lastErrorCode: "SUBSCRIPTION_ALREADY_PAID",
    xeroInvoiceId: null,
    coverage: [
      { subscriptionId: "sub-1", memberName: "Ana Paid", subscription: { status: "PAID", memberId: "member-1" } },
      { subscriptionId: "sub-2", memberName: "Ben Paid", subscription: { status: "PAID", memberId: "member-2" } },
    ],
    ...overrides,
  };
}

const INPUT = { chargeId: "charge-1", reason: "  Paid in cash at the AGM  ", actorMemberId: "officer-1" };

function expectNoWrites() {
  expect(mocks.chargeUpdateMany).not.toHaveBeenCalled();
  expect(mocks.subscriptionUpdateMany).not.toHaveBeenCalled();
  expect(mocks.coverageUpdateMany).not.toHaveBeenCalled();
  expect(mocks.audit).not.toHaveBeenCalled();
}

async function expectRefusal(status: number, message?: RegExp) {
  const error = await closeAlreadyPaidSubscriptionCharge(INPUT).catch((caught: unknown) => caught);
  expect(error).toBeInstanceOf(CloseAlreadyPaidChargeError);
  expect((error as CloseAlreadyPaidChargeError).status).toBe(status);
  if (message) expect((error as Error).message).toMatch(message);
}

describe("closeAlreadyPaidSubscriptionCharge (#4098)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.chargeFindUnique.mockResolvedValue(conflictedCharge());
    mocks.chargeUpdateMany.mockResolvedValue({ count: 1 });
    mocks.subscriptionUpdateMany.mockResolvedValue({ count: 2 });
    releaseClaimsSettledAs({ PAID: 2 });
    mocks.findLiveOperation.mockResolvedValue(null);
  });

  /** The per-status release writes, answering how many claims each status had. */
  function releaseClaimsSettledAs(counts: Partial<Record<"PAID" | "NOT_REQUIRED", number>>) {
    mocks.coverageUpdateMany.mockImplementation(
      async ({ where }: { where: { subscription: { status: "PAID" | "NOT_REQUIRED" } } }) =>
        ({ count: counts[where.subscription.status] ?? 0 }),
    );
  }

  it("closes the charge, re-checks PAID in a guarded write, releases the claims and audits the officer and reason", async () => {
    await expect(closeAlreadyPaidSubscriptionCharge(INPUT)).resolves.toEqual({
      closed: true,
      message: "Charge closed as already paid. No Xero invoice will be raised for it.",
    });

    expect(mocks.chargeUpdateMany).toHaveBeenCalledWith({
      where: { id: "charge-1", status: "CONFLICT", lastErrorCode: "SUBSCRIPTION_ALREADY_PAID", xeroInvoiceId: null },
      data: { status: "NOT_REQUIRED", lastErrorCode: null, lastErrorMessage: null },
    });
    expect(mocks.subscriptionUpdateMany).toHaveBeenCalledWith({
      where: { id: { in: ["sub-1", "sub-2"] }, status: { in: ["PAID", "NOT_REQUIRED"] } },
      data: { voidGeneration: { increment: 1 } },
    });
    // Each claim records the status it was settled with (#4110 review F1).
    expect(mocks.coverageUpdateMany.mock.calls.map(([args]) => args)).toEqual([
      { where: { chargeId: "charge-1", releasedAt: null, subscription: { status: "PAID" } }, data: { releasedAt: expect.any(Date), subscriptionStatusAtClose: "PAID" } },
      { where: { chargeId: "charge-1", releasedAt: null, subscription: { status: "NOT_REQUIRED" } }, data: { releasedAt: expect.any(Date), subscriptionStatusAtClose: "NOT_REQUIRED" } },
    ]);
    // #4519: the charge's face collected as cash, at the close's own instant.
    const releasedAt = (mocks.coverageUpdateMany.mock.calls[0][0] as { data: { releasedAt: Date } }).data.releasedAt;
    expect(mocks.postSubscriptionCloseReceipt).toHaveBeenCalledWith(mocks.tx, { journal: "context" },
      expect.objectContaining({ chargeId: "charge-1", closedAt: releasedAt }));
    expect(mocks.audit).toHaveBeenCalledTimes(1);
    const [entry, client] = mocks.audit.mock.calls[0];
    expect(client).toBeDefined();
    expect(entry).toMatchObject({
      action: "membership-subscription-billing.close-already-paid",
      category: "payment",
      entityType: "MembershipSubscriptionCharge",
      entityId: "charge-1",
      memberId: "officer-1",
      targetId: "charge-1",
    });
    expect(JSON.parse(entry.details)).toEqual({
      reason: "Paid in cash at the AGM",
      seasonYear: 2026,
      previousStatus: "CONFLICT",
      status: "NOT_REQUIRED",
      subscriptionIds: ["sub-1", "sub-2"],
      memberIds: ["member-1", "member-2"],
      coverageReleased: 2,
    });
  });

  it("refuses a blank reason before reading anything", async () => {
    const error = await closeAlreadyPaidSubscriptionCharge({ ...INPUT, reason: "   " }).catch((caught: unknown) => caught);
    expect((error as CloseAlreadyPaidChargeError).status).toBe(400);
    expect(mocks.chargeFindUnique).not.toHaveBeenCalled();
    expectNoWrites();
  });

  it("refuses an unknown charge", async () => {
    mocks.chargeFindUnique.mockResolvedValue(null);
    await expectRefusal(404);
    expectNoWrites();
  });

  it.each(["DUPLICATE_REFERENCE", "PROVIDER_MISMATCH", "MISSING_MAPPING_SNAPSHOT", null])(
    "refuses a CONFLICT with another code (%s)",
    async (lastErrorCode) => {
      mocks.chargeFindUnique.mockResolvedValue(conflictedCharge({ lastErrorCode }));
      await expectRefusal(409, /Only a charge in conflict because its subscription is already paid/);
      expectNoWrites();
    },
  );

  it.each(["QUEUED", "PROCESSING", "INVOICE_CREATED", "EMAIL_FAILED", "EMAILED", "VOIDED"])(
    "refuses a %s charge",
    async (status) => {
      mocks.chargeFindUnique.mockResolvedValue(conflictedCharge({ status }));
      await expectRefusal(409);
      expectNoWrites();
    },
  );

  it("refuses a zero-cent NO_INVOICE charge, which is NOT_REQUIRED but was never closed", async () => {
    mocks.chargeFindUnique.mockResolvedValue(conflictedCharge({ status: "NOT_REQUIRED", billingBasis: "NO_INVOICE", lastErrorCode: null }));
    await expectRefusal(409);
    expectNoWrites();
  });

  it("refuses a charge that already has a Xero invoice", async () => {
    mocks.chargeFindUnique.mockResolvedValue(conflictedCharge({ xeroInvoiceId: "xero-invoice-1" }));
    await expectRefusal(409);
    expectNoWrites();
  });

  it("refuses when a covered subscription is no longer PAID, naming the member", async () => {
    mocks.chargeFindUnique.mockResolvedValue(conflictedCharge({
      coverage: [
        { subscriptionId: "sub-1", memberName: "Ana Paid", subscription: { status: "PAID", memberId: "member-1" } },
        { subscriptionId: "sub-2", memberName: "Ben Reversed", subscription: { status: "NOT_INVOICED", memberId: "member-2" } },
      ],
    }));
    await expectRefusal(409, /Still unpaid: Ben Reversed\. Not every covered subscription is paid/);
    // Both paths that work are named; Retry alone would loop (money F1).
    await expectRefusal(409, /record the remaining payments and then close it/);
    await expectRefusal(409, /reverse every payment recorded for it .* and then Retry/);
    expectNoWrites();
  });

  it("refuses, writing nothing, while an invoice operation for the charge is queued or running", async () => {
    mocks.findLiveOperation.mockResolvedValue({ id: "op-live" });
    await expectRefusal(409, /still queued or running/);
    // Read inside the close's own transaction, for this charge.
    expect(mocks.findLiveOperation).toHaveBeenCalledWith(mocks.tx, "charge-1");
    expectNoWrites();
  });

  it("closes a family charge whose other covered member is exempt (NOT_REQUIRED) — owner decision on #4110", async () => {
    mocks.chargeFindUnique.mockResolvedValue(conflictedCharge({
      coverage: [
        { subscriptionId: "sub-1", memberName: "Ana Paid", subscription: { status: "PAID", memberId: "member-1" } },
        { subscriptionId: "sub-2", memberName: "Cub Exempt", subscription: { status: "NOT_REQUIRED", memberId: "member-2" } },
      ],
    }));
    releaseClaimsSettledAs({ PAID: 1, NOT_REQUIRED: 1 });
    await expect(closeAlreadyPaidSubscriptionCharge(INPUT)).resolves.toMatchObject({ closed: true });
    expect(mocks.subscriptionUpdateMany).toHaveBeenCalledWith({
      where: { id: { in: ["sub-1", "sub-2"] }, status: { in: ["PAID", "NOT_REQUIRED"] } },
      data: { voidGeneration: { increment: 1 } },
    });
  });

  it("rolls back when the per-status releases do not account for every claim it counted", async () => {
    releaseClaimsSettledAs({ PAID: 1 });
    await expectRefusal(409, /changed while you were closing it/);
    expect(mocks.audit).not.toHaveBeenCalled();
  });

  it("refuses a charge with no active coverage", async () => {
    mocks.chargeFindUnique.mockResolvedValue(conflictedCharge({ coverage: [] }));
    await expectRefusal(409);
    expectNoWrites();
  });

  it("rolls back when a reversal lands between the read and the guarded write", async () => {
    mocks.subscriptionUpdateMany.mockResolvedValue({ count: 1 });
    await expectRefusal(409, /stopped being paid while you were closing this charge\. Not every covered subscription is paid/);
    await expectRefusal(409, /record the remaining payments and then close it/);
    // The throw is what rolls the claim back; nothing after it runs.
    expect(mocks.coverageUpdateMany).not.toHaveBeenCalled();
    expect(mocks.audit).not.toHaveBeenCalled();
  });

  it("is an idempotent success, writing nothing, when the charge is already closed", async () => {
    mocks.chargeFindUnique.mockResolvedValue(conflictedCharge({ status: "NOT_REQUIRED", lastErrorCode: null }));
    await expect(closeAlreadyPaidSubscriptionCharge(INPUT)).resolves.toEqual({
      closed: false,
      message: "This charge is already closed as paid.",
    });
    expectNoWrites();
  });

  it("is an idempotent success when a concurrent close won the claim", async () => {
    mocks.chargeUpdateMany.mockResolvedValue({ count: 0 });
    mocks.chargeFindUnique
      .mockResolvedValueOnce(conflictedCharge())
      .mockResolvedValueOnce({ status: "NOT_REQUIRED", billingBasis: "PER_FAMILY" });
    await expect(closeAlreadyPaidSubscriptionCharge(INPUT)).resolves.toMatchObject({ closed: false });
    expect(mocks.subscriptionUpdateMany).not.toHaveBeenCalled();
    expect(mocks.coverageUpdateMany).not.toHaveBeenCalled();
    expect(mocks.audit).not.toHaveBeenCalled();
  });

  it("refuses when the claim is lost to anything other than a close", async () => {
    mocks.chargeUpdateMany.mockResolvedValue({ count: 0 });
    mocks.chargeFindUnique
      .mockResolvedValueOnce(conflictedCharge())
      .mockResolvedValueOnce({ status: "QUEUED", billingBasis: "PER_FAMILY" });
    await expectRefusal(409, /changed while you were closing it/);
    expect(mocks.subscriptionUpdateMany).not.toHaveBeenCalled();
    expect(mocks.audit).not.toHaveBeenCalled();
  });
});

describe("everyActiveCoveredSubscriptionSettled (#4098, #4110 exempt decision)", () => {
  it.each([
    ["every active row PAID", [{ releasedAt: null, subscription: { status: "PAID" } }], true],
    ["a row without releasedAt is read as active", [{ subscription: { status: "PAID" } }], true],
    ["one active row unpaid", [{ releasedAt: null, subscription: { status: "PAID" } }, { releasedAt: null, subscription: { status: "UNPAID" } }], false],
    ["only released rows", [{ releasedAt: "2026-06-01T00:00:00.000Z", subscription: { status: "PAID" } }], false],
    ["a released unpaid row is ignored", [{ releasedAt: null, subscription: { status: "PAID" } }, { releasedAt: "2026-06-01T00:00:00.000Z", subscription: { status: "NOT_INVOICED" } }], true],
    ["no coverage", [], false],
    ["an exempt (NOT_REQUIRED) member counts as settled", [{ releasedAt: null, subscription: { status: "PAID" } }, { releasedAt: null, subscription: { status: "NOT_REQUIRED" } }], true],
    ["an OVERDUE member does not", [{ releasedAt: null, subscription: { status: "PAID" } }, { releasedAt: null, subscription: { status: "OVERDUE" } }], false],
  ])("%s", async (_label, coverage, expected) => {
    const { everyActiveCoveredSubscriptionSettled } = await import("@/lib/subscription-charge-already-paid");
    expect(everyActiveCoveredSubscriptionSettled(coverage as never)).toBe(expected);
  });
});
