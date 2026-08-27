import { beforeEach, describe, expect, it, vi } from "vitest";

// E14 (#1944) part 2: audited manual mark-paid / mark-unpaid. These tests pin
// the status/provenance writes, the status-fenced (updateMany) guard rails, the
// owner-decided "no manual mark-paid once a Xero invoice links" semantic, the
// reversal status logic, and the invariant that NO Xero module is ever imported
// or called on this path.

const { prismaMock, auditMock, emailMock, loggerMock, hostingMock } = vi.hoisted(() => ({
  prismaMock: {
    $transaction: vi.fn(),
    memberSubscription: {
      findUnique: vi.fn(),
      updateMany: vi.fn(),
      findUniqueOrThrow: vi.fn(),
    },
  },
  auditMock: { createAuditLog: vi.fn() },
  emailMock: { sendMembershipPaymentRecordedEmail: vi.fn() },
  loggerMock: { error: vi.fn(), warn: vi.fn(), info: vi.fn() },
  hostingMock: {
    enqueueHostingCoverageReevaluationForMember: vi.fn(async () => 0),
    settleHostingCoverageAfterCommit: vi.fn(async () => ({})),
  },
}));

vi.mock("@/lib/prisma", () => ({ prisma: prismaMock }));
vi.mock("@/lib/audit", () => auditMock);
vi.mock("@/lib/email/membership", () => emailMock);
vi.mock("@/lib/logger", () => ({
  default: loggerMock,
}));
vi.mock("@/lib/adult-member-hosting-review", () => ({
  enqueueHostingCoverageReevaluationForMember:
    hostingMock.enqueueHostingCoverageReevaluationForMember,
}));
vi.mock("@/lib/adult-member-hosting-coverage-drain", () => ({
  settleHostingCoverageAfterCommit: hostingMock.settleHostingCoverageAfterCommit,
}));
vi.mock("server-only", () => ({}));

// If any Xero module were imported by the manual-payment path, these mocks would
// register; we assert they are never called.
const xeroCall = vi.fn();
vi.mock("@/lib/xero", () => new Proxy({}, { get: () => xeroCall }));
vi.mock("@/lib/xero-membership-sync", () => new Proxy({}, { get: () => xeroCall }));
vi.mock("@/lib/xero-subscription-invoices", () => new Proxy({}, { get: () => xeroCall }));

import { prisma } from "@/lib/prisma";
import { createAuditLog } from "@/lib/audit";
import { sendMembershipPaymentRecordedEmail } from "@/lib/email/membership";
import logger from "@/lib/logger";
import {
  applyManualSubscriptionPayment,
  ManualSubscriptionPaymentError,
} from "@/lib/manual-subscription-payment";

function wireTransaction(
  subscriptionRow: Record<string, unknown> | null,
  options?: { fencedCount?: number },
) {
  const tx = {
    memberSubscription: {
      findUnique: vi.fn().mockResolvedValue(subscriptionRow),
      updateMany: vi.fn().mockResolvedValue({ count: options?.fencedCount ?? 1 }),
      findUniqueOrThrow: vi.fn().mockImplementation(async () => ({
        id: "sub-1",
        memberId: "m-1",
        seasonYear: 2026,
        status:
          tx.memberSubscription.updateMany.mock.calls[0]?.[0]?.data?.status ??
          subscriptionRow?.status,
      })),
    },
  };
  vi.mocked(prisma.$transaction).mockImplementation(async (cb: any) => cb(tx));
  return tx;
}

describe("applyManualSubscriptionPayment (#1944)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    xeroCall.mockReset();
  });

  it("marks a subscription paid with provenance and audits, without calling Xero", async () => {
    const tx = wireTransaction({
      id: "sub-1", memberId: "m-1", seasonYear: 2026, status: "NOT_INVOICED",
      xeroInvoiceId: null, manuallyMarkedPaidAt: null,
    });

    const result = await applyManualSubscriptionPayment({
      subscriptionId: "sub-1",
      direction: "paid",
      note: "  cash payment  ",
      actingMemberId: "admin-1",
      notifyMember: false,
    });

    expect(result).toMatchObject({ status: "PAID", direction: "paid" });
    const args = tx.memberSubscription.updateMany.mock.calls[0][0];
    expect(args.data).toMatchObject({
      status: "PAID",
      manuallyMarkedPaidByMemberId: "admin-1",
      manualPaymentNote: "cash payment",
    });
    expect(args.data.manuallyMarkedPaidAt).toBeInstanceOf(Date);
    expect(args.data.paidAt).toBeInstanceOf(Date);
    // The write is status-fenced: every precondition is re-asserted atomically
    // inside the WHERE, so a concurrent double-mark or Xero sync loses the race
    // safely instead of double-applying (F4).
    expect(args.where).toMatchObject({
      id: "sub-1",
      status: { notIn: ["PAID", "NOT_REQUIRED"] },
      xeroInvoiceId: null,
      manuallyMarkedPaidAt: null,
    });
    expect(createAuditLog).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "membership-subscription.manual-payment.mark-paid",
        memberId: "admin-1",
        subjectMemberId: "m-1",
      }),
      expect.anything(),
    );
    expect(
      hostingMock.enqueueHostingCoverageReevaluationForMember,
    ).toHaveBeenCalledWith("m-1", tx, expect.any(Date), {
      cause: "SYSTEM_CHANGE",
      actorMemberId: "admin-1",
    });
    expect(hostingMock.settleHostingCoverageAfterCommit).toHaveBeenCalledTimes(1);
    expect(xeroCall).not.toHaveBeenCalled();
  });

  it("rejects marking paid when the row is already PAID", async () => {
    wireTransaction({
      id: "sub-1", memberId: "m-1", seasonYear: 2026, status: "PAID",
      xeroInvoiceId: null, manuallyMarkedPaidAt: null,
    });

    await expect(
      applyManualSubscriptionPayment({ subscriptionId: "sub-1", direction: "paid", actingMemberId: "admin-1", notifyMember: false }),
    ).rejects.toMatchObject({ status: 409 });
    expect(xeroCall).not.toHaveBeenCalled();
  });

  it("rejects marking paid when a Xero invoice links — the payment belongs in Xero (owner-decided semantic)", async () => {
    const tx = wireTransaction({
      id: "sub-1", memberId: "m-1", seasonYear: 2026, status: "UNPAID",
      xeroInvoiceId: "inv-123", manuallyMarkedPaidAt: null,
    });

    await expect(
      applyManualSubscriptionPayment({ subscriptionId: "sub-1", direction: "paid", actingMemberId: "admin-1", notifyMember: false }),
    ).rejects.toMatchObject({
      status: 409,
      message: expect.stringContaining("record the payment against the invoice in Xero"),
    });
    expect(tx.memberSubscription.updateMany).not.toHaveBeenCalled();
    expect(xeroCall).not.toHaveBeenCalled();
  });

  it("rejects marking a NOT_REQUIRED subscription paid — there is nothing to pay", async () => {
    const tx = wireTransaction({
      id: "sub-1", memberId: "m-1", seasonYear: 2026, status: "NOT_REQUIRED",
      xeroInvoiceId: null, manuallyMarkedPaidAt: null,
    });

    await expect(
      applyManualSubscriptionPayment({ subscriptionId: "sub-1", direction: "paid", actingMemberId: "admin-1", notifyMember: false }),
    ).rejects.toMatchObject({ status: 409 });
    expect(tx.memberSubscription.updateMany).not.toHaveBeenCalled();
  });

  it("409s when the fenced mark-paid write matches no row (concurrent change)", async () => {
    wireTransaction(
      {
        id: "sub-1", memberId: "m-1", seasonYear: 2026, status: "NOT_INVOICED",
        xeroInvoiceId: null, manuallyMarkedPaidAt: null,
      },
      { fencedCount: 0 },
    );

    await expect(
      applyManualSubscriptionPayment({ subscriptionId: "sub-1", direction: "paid", actingMemberId: "admin-1", notifyMember: false }),
    ).rejects.toMatchObject({ status: 409 });
    expect(createAuditLog).not.toHaveBeenCalled();
  });

  it("reversal restores NOT_INVOICED when there is no Xero invoice link and clears provenance", async () => {
    const tx = wireTransaction({
      id: "sub-1", memberId: "m-1", seasonYear: 2026, status: "PAID",
      xeroInvoiceId: null, manuallyMarkedPaidAt: new Date("2026-05-01"),
    });

    const result = await applyManualSubscriptionPayment({
      subscriptionId: "sub-1", direction: "unpaid", actingMemberId: "admin-1",
    });

    expect(result).toMatchObject({ status: "NOT_INVOICED", direction: "unpaid" });
    const args = tx.memberSubscription.updateMany.mock.calls[0][0];
    expect(args.data).toMatchObject({
      status: "NOT_INVOICED",
      paidAt: null,
      manuallyMarkedPaidAt: null,
      manuallyMarkedPaidByMemberId: null,
      manualPaymentNote: null,
    });
    // Reversal is fenced on the provenance column still being set (F4).
    expect(args.where).toMatchObject({
      id: "sub-1",
      manuallyMarkedPaidAt: { not: null },
    });
    expect(createAuditLog).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "membership-subscription.manual-payment.mark-unpaid",
        metadata: expect.objectContaining({
          previousStatus: "PAID",
          restoredStatus: "NOT_INVOICED",
        }),
      }),
      expect.anything(),
    );
    expect(
      hostingMock.enqueueHostingCoverageReevaluationForMember,
    ).toHaveBeenCalledWith("m-1", tx, expect.any(Date), {
      cause: "SYSTEM_CHANGE",
      actorMemberId: "admin-1",
    });
    expect(hostingMock.settleHostingCoverageAfterCommit).toHaveBeenCalledTimes(1);
    expect(xeroCall).not.toHaveBeenCalled();
  });

  it("reversal restores UNPAID when a Xero invoice link exists", async () => {
    const tx = wireTransaction({
      id: "sub-1", memberId: "m-1", seasonYear: 2026, status: "PAID",
      xeroInvoiceId: "inv-123", manuallyMarkedPaidAt: new Date("2026-05-01"),
    });

    const result = await applyManualSubscriptionPayment({
      subscriptionId: "sub-1", direction: "unpaid", actingMemberId: "admin-1",
    });

    expect(result).toMatchObject({ status: "UNPAID" });
    expect(tx.memberSubscription.updateMany.mock.calls[0][0].data.status).toBe("UNPAID");
  });

  it("rejects reversing a row that was not manually marked paid", async () => {
    wireTransaction({
      id: "sub-1", memberId: "m-1", seasonYear: 2026, status: "PAID",
      xeroInvoiceId: "inv-123", manuallyMarkedPaidAt: null,
    });

    await expect(
      applyManualSubscriptionPayment({ subscriptionId: "sub-1", direction: "unpaid", actingMemberId: "admin-1" }),
    ).rejects.toBeInstanceOf(ManualSubscriptionPaymentError);
  });

  it("409s when the fenced reversal write matches no row (provenance already cleared)", async () => {
    wireTransaction(
      {
        id: "sub-1", memberId: "m-1", seasonYear: 2026, status: "PAID",
        xeroInvoiceId: null, manuallyMarkedPaidAt: new Date("2026-05-01"),
      },
      { fencedCount: 0 },
    );

    await expect(
      applyManualSubscriptionPayment({ subscriptionId: "sub-1", direction: "unpaid", actingMemberId: "admin-1" }),
    ).rejects.toMatchObject({ status: 409 });
    expect(createAuditLog).not.toHaveBeenCalled();
  });

  it("404s when the subscription does not exist", async () => {
    wireTransaction(null);
    await expect(
      applyManualSubscriptionPayment({ subscriptionId: "missing", direction: "paid", actingMemberId: "admin-1", notifyMember: false }),
    ).rejects.toMatchObject({ status: 404 });
  });
});

// #2260: the standard "email the member or not" choice on manual mark-paid.
// Both choices mark the subscription paid identically; the choice itself is
// recorded in the audit log, and a reversal never emails anyone.
describe("manual mark-paid member notification (#2260)", () => {
  const charge = (overrides: Record<string, unknown> = {}) => ({
    charge: {
      chargedAmountCents: 12345,
      billingBasis: "PER_MEMBER",
      _count: { coverage: 1 },
      ...overrides,
    },
  });

  const paidRow = (overrides: Record<string, unknown> = {}) => ({
    id: "sub-1",
    memberId: "m-1",
    seasonYear: 2026,
    status: "NOT_INVOICED",
    xeroInvoiceId: null,
    manuallyMarkedPaidAt: null,
    member: { firstName: "Ada", email: "ada@example.org" },
    chargeCoverage: [charge()],
    ...overrides,
  });

  beforeEach(() => {
    vi.clearAllMocks();
    xeroCall.mockReset();
    vi.mocked(sendMembershipPaymentRecordedEmail).mockResolvedValue({
      status: "sent",
      emailLogId: "log-1",
      messageId: "msg-1",
    });
  });

  it("emails the member a receipt when the admin chooses to, with the season, the frozen charge amount in cents and the recorded timestamp", async () => {
    const tx = wireTransaction(paidRow());

    const result = await applyManualSubscriptionPayment({
      subscriptionId: "sub-1",
      direction: "paid",
      actingMemberId: "admin-1",
      notifyMember: true,
    });

    expect(result).toMatchObject({ memberNotified: true, receipt: "queued" });
    expect(sendMembershipPaymentRecordedEmail).toHaveBeenCalledTimes(1);
    const sent = vi.mocked(sendMembershipPaymentRecordedEmail).mock.calls[0][0];
    expect(sent).toMatchObject({
      email: "ada@example.org",
      firstName: "Ada",
      seasonYear: 2026,
      amountCents: 12345,
    });
    // The receipt states the same instant that was written to the row, not a
    // second clock read after the transaction.
    expect(sent.recordedAt).toEqual(
      tx.memberSubscription.updateMany.mock.calls[0][0].data.manuallyMarkedPaidAt,
    );
  });

  it("sends nothing when the admin declines the email, and still marks the subscription paid", async () => {
    const tx = wireTransaction(paidRow());

    const result = await applyManualSubscriptionPayment({
      subscriptionId: "sub-1",
      direction: "paid",
      actingMemberId: "admin-1",
      notifyMember: false,
    });

    expect(result).toMatchObject({
      status: "PAID",
      memberNotified: false,
      receipt: "not_requested",
    });
    expect(tx.memberSubscription.updateMany.mock.calls[0][0].data.status).toBe("PAID");
    expect(sendMembershipPaymentRecordedEmail).not.toHaveBeenCalled();
  });

  it.each([true, false])(
    "records the admin's notify choice (%s) in the mark-paid audit entry",
    async (notifyMember) => {
      wireTransaction(paidRow());

      await applyManualSubscriptionPayment({
        subscriptionId: "sub-1",
        direction: "paid",
        actingMemberId: "admin-1",
        notifyMember,
      });

      // Recorded BOTH ways on purpose: an only-on-decline record cannot tell
      // "chose not to email" from "was never offered the choice".
      expect(createAuditLog).toHaveBeenCalledWith(
        expect.objectContaining({
          action: "membership-subscription.manual-payment.mark-paid",
          metadata: expect.objectContaining({ notifyMember }),
        }),
        expect.anything(),
      );
    },
  );

  it("omits the amount when the season has no active charge coverage", async () => {
    wireTransaction(paidRow({ chargeCoverage: [] }));

    await applyManualSubscriptionPayment({
      subscriptionId: "sub-1",
      direction: "paid",
      actingMemberId: "admin-1",
      notifyMember: true,
    });

    expect(sendMembershipPaymentRecordedEmail).toHaveBeenCalledWith(
      expect.objectContaining({ amountCents: null }),
    );
  });

  it("omits the amount when the charge covers a whole family, not this member", async () => {
    // F2: chargedAmountCents is the CHARGE's total. A PER_FAMILY charge covers
    // every family member's subscription with one figure, so printing it here
    // would tell one member — possibly a dependent — that the whole family's
    // fee was recorded against them and there is nothing further to pay, while
    // their relatives' subscriptions are still unpaid.
    wireTransaction(
      paidRow({
        chargeCoverage: [
          charge({ billingBasis: "PER_FAMILY", _count: { coverage: 3 } }),
        ],
      }),
    );

    await applyManualSubscriptionPayment({
      subscriptionId: "sub-1",
      direction: "paid",
      actingMemberId: "admin-1",
      notifyMember: true,
    });

    expect(sendMembershipPaymentRecordedEmail).toHaveBeenCalledWith(
      expect.objectContaining({ amountCents: null }),
    );
  });

  it("omits the amount when one charge fans out over several subscriptions, whatever its basis", async () => {
    // The basis says what the amount MEANS; the coverage fan-out says what it
    // actually paid for. Either one being wrong is enough to withhold it.
    wireTransaction(
      paidRow({
        chargeCoverage: [charge({ _count: { coverage: 2 } })],
      }),
    );

    await applyManualSubscriptionPayment({
      subscriptionId: "sub-1",
      direction: "paid",
      actingMemberId: "admin-1",
      notifyMember: true,
    });

    expect(sendMembershipPaymentRecordedEmail).toHaveBeenCalledWith(
      expect.objectContaining({ amountCents: null }),
    );
  });

  it("omits the amount for a zero-cent (no-invoice) fee rather than printing $0.00", async () => {
    wireTransaction(
      paidRow({
        chargeCoverage: [
          charge({ chargedAmountCents: 0, billingBasis: "NO_INVOICE" }),
        ],
      }),
    );

    await applyManualSubscriptionPayment({
      subscriptionId: "sub-1",
      direction: "paid",
      actingMemberId: "admin-1",
      notifyMember: true,
    });

    expect(sendMembershipPaymentRecordedEmail).toHaveBeenCalledWith(
      expect.objectContaining({ amountCents: null }),
    );
  });

  it("reads only the ACTIVE coverage claim for the amount", async () => {
    const tx = wireTransaction(paidRow());

    await applyManualSubscriptionPayment({
      subscriptionId: "sub-1",
      direction: "paid",
      actingMemberId: "admin-1",
      notifyMember: true,
    });

    const select = tx.memberSubscription.findUnique.mock.calls[0][0].select;
    expect(select.chargeCoverage.where).toEqual({ releasedAt: null });
  });

  it("never emails on a reversal, and pins that absence in the audit entry", async () => {
    wireTransaction(
      paidRow({ status: "PAID", manuallyMarkedPaidAt: new Date("2026-05-01") }),
    );

    const result = await applyManualSubscriptionPayment({
      subscriptionId: "sub-1",
      direction: "unpaid",
      actingMemberId: "admin-1",
    });

    expect(result).toMatchObject({
      memberNotified: false,
      receipt: "not_requested",
    });
    expect(sendMembershipPaymentRecordedEmail).not.toHaveBeenCalled();
    // Its OWN key: "no choice was offered here" is a different fact from an
    // admin's decline on the paid path, and a raw metadata render must not
    // blur the two.
    const metadata = vi
      .mocked(createAuditLog)
      .mock.calls.find(
        (call) =>
          call[0].action ===
          "membership-subscription.manual-payment.mark-unpaid",
      )?.[0].metadata;
    expect(metadata).toMatchObject({ notifyMemberOffered: false });
    expect(metadata).not.toHaveProperty("notifyMember");
  });

  it("keeps the committed money state when the receipt fails to send, and reports it unsent", async () => {
    wireTransaction(paidRow());
    vi.mocked(sendMembershipPaymentRecordedEmail).mockRejectedValueOnce(
      new Error("SES down"),
    );

    // The status write has already committed; a mail failure must not turn a
    // successful mark-paid into an error the admin has to re-attempt — but it
    // must not read back as a delivered receipt either.
    const result = await applyManualSubscriptionPayment({
      subscriptionId: "sub-1",
      direction: "paid",
      actingMemberId: "admin-1",
      notifyMember: true,
    });

    expect(result).toMatchObject({
      status: "PAID",
      memberNotified: true,
      receipt: "not_delivered",
    });
  });

  it.each(["suppressed", "skipped_placeholder_recipient"] as const)(
    "reports a %s recipient as not delivered, never as emailed",
    async (status) => {
      wireTransaction(paidRow());
      vi.mocked(sendMembershipPaymentRecordedEmail).mockResolvedValueOnce({
        status,
        emailLogId: null,
        reason: "test",
        ...(status === "suppressed" ? { emailSuppressionId: "sup-1" } : {}),
      } as never);

      const result = await applyManualSubscriptionPayment({
        subscriptionId: "sub-1",
        direction: "paid",
        actingMemberId: "admin-1",
        notifyMember: true,
      });

      // The admin chose to email; the mailer did not send. Saying "emailed"
      // here is the false belief this whole feature exists to avoid.
      expect(result).toMatchObject({
        memberNotified: true,
        receipt: "not_delivered",
      });
    },
  );

  it("says so, loudly, when a receipt is requested for a member with no address", async () => {
    wireTransaction(paidRow({ member: { firstName: "Ada", email: "" } }));

    const result = await applyManualSubscriptionPayment({
      subscriptionId: "sub-1",
      direction: "paid",
      actingMemberId: "admin-1",
      notifyMember: true,
    });

    expect(result.receipt).toBe("not_delivered");
    expect(sendMembershipPaymentRecordedEmail).not.toHaveBeenCalled();
    expect(vi.mocked(logger.warn)).toHaveBeenCalled();
  });

  it("does not email when the marking never happened (a rejected mark-paid)", async () => {
    wireTransaction(paidRow({ status: "PAID" }));

    await expect(
      applyManualSubscriptionPayment({
        subscriptionId: "sub-1",
        direction: "paid",
        actingMemberId: "admin-1",
        notifyMember: true,
      }),
    ).rejects.toMatchObject({ status: 409 });
    expect(sendMembershipPaymentRecordedEmail).not.toHaveBeenCalled();
  });
});
