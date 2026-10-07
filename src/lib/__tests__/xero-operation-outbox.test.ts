import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Prisma } from "@prisma/client";

const mocks = vi.hoisted(() => ({
  createAuditLog: vi.fn(),
  findFirstLink: vi.fn(),
  findUniqueBooking: vi.fn(),
  findUniqueMember: vi.fn(),
  findUniqueMemberSubscription: vi.fn(),
  findUniquePayment: vi.fn(),
  findUniqueGroupSettlement: vi.fn(),
  findFirstPaymentTransaction: vi.fn(),
  findFirstRecoveryOperation: vi.fn(),
  findUniqueManualRefundTask: vi.fn(),
  findFirstOperation: vi.fn(),
  // #3170 fix round (F1): the outbox worker re-reads an operation's payload
  // AFTER it claims the row. Left returning `undefined` by default, which the
  // worker treats as "no fresher row", so every pre-existing dispatch test keeps
  // asserting against the payload its scan handed in. The tests that exercise
  // the re-read set it explicitly.
  findUniqueOperation: vi.fn(),
  findManyOperations: vi.fn(),
  countOperations: vi.fn(),
  sendAdminXeroSyncErrorAlert: vi.fn(),
  // #3635 C4: the claim store under `sendAdminAlertOnceEver`, whose rule runs
  // for real over it.
  claimAlertCooldown: vi.fn(),
  deferAlertCooldown: vi.fn(),
  releaseAlertCooldown: vi.fn(),
  getPaymentIntent: vi.fn(),
  updateManyOperation: vi.fn(),
  updateOperation: vi.fn(),
  startXeroSyncOperation: vi.fn(),
  completeXeroSyncOperation: vi.fn(),
  failXeroSyncOperation: vi.fn(),
  findCanonicalPaymentRefundCreditNote: vi.fn(),
  sumCoveredRefundCreditNoteCents: vi.fn(),
  resolveStripeCashRefundEvidence: vi.fn(),
  upsertXeroObjectLink: vi.fn(),
  getEntranceFeeContext: vi.fn(),
  createUnappliedXeroCreditNote: vi.fn(),
  createUnappliedXeroCreditNoteForModification: vi.fn(),
  allocateCreditNoteToInvoice: vi.fn(),
  createXeroCreditNote: vi.fn(),
  createXeroCreditNoteForModification: vi.fn(),
  allocateAppliedCreditForBooking: vi.fn(),
  deallocateExcessAppliedCreditForBooking: vi.fn(),
  createXeroEntranceFeeInvoice: vi.fn(),
  createXeroInvoiceForBooking: vi.fn(),
  createXeroInvoiceForGroupSettlement: vi.fn(),
  voidXeroInvoiceForCancelledGroupSettlement: vi.fn(),
  voidXeroInvoiceForAbandonedGroupSettlement: vi.fn(),
  createXeroMembershipSubscriptionInvoice: vi.fn(),
  updateXeroBookingInvoiceForBooking: vi.fn(),
  createXeroSupplementaryInvoice: vi.fn(),
  createXeroKeptLateCaptureInvoice: vi.fn(),
  createXeroMembershipCancellationCreditNote: vi.fn(),
  syncXeroMembershipCancellationContact: vi.fn(),
  isXeroConnected: vi.fn().mockResolvedValue(false),
  executeRaw: vi.fn(),
}));

/**
 * #3193 fix round: the double-bill regression below drives the REAL
 * `recordShortEditReviewChargeInvoice` - the function that decides whether a
 * refused ask buys a second invoice - because a test that re-states that rule
 * locally would pass against the bug it exists to catch. That module writes
 * audit rows, and nothing else in this file touches `@/lib/audit`, so the double
 * is inert for every other test here.
 */
vi.mock("@/lib/audit", () => ({
  createAuditLog: mocks.createAuditLog,
}));

// #3170 fix round: `enqueueXeroSupplementaryInvoiceOperation` now decides
// link-check -> queued-check -> write inside ONE advisory-locked transaction, so
// the double has to serve the transaction client too. It is the SAME object, so
// every existing assertion on `mocks.*` reads the in-transaction calls unchanged,
// and `mocks.executeRaw` is where the lock statement lands.
vi.mock("@/lib/prisma", () => {
  const client: Record<string, unknown> = {
    booking: {
      findUnique: mocks.findUniqueBooking,
    },
    member: {
      findUnique: mocks.findUniqueMember,
    },
    memberSubscription: {
      findUnique: mocks.findUniqueMemberSubscription,
    },
    payment: {
      findUnique: mocks.findUniquePayment,
    },
    // #3635 round-3 R1: no refund row names a late capture unless a test says so.
    paymentRefund: {
      findMany: async () => [],
    },
    groupBookingSettlement: {
      findUnique: mocks.findUniqueGroupSettlement,
    },
    paymentTransaction: {
      findFirst: mocks.findFirstPaymentTransaction,
    },
    // #3641 delta D1: a superseded intent's capture is refunded, found by its
    // supersede recovery. None unless a case says so.
    paymentRecoveryOperation: {
      findFirst: mocks.findFirstRecoveryOperation,
    },
    // #3635: a #3639 treasurer-approval task owns a held capture. None unless a
    // case says so (a reset mock answers undefined, read as none).
    manualRefundTask: {
      findUnique: async (...a: unknown[]) =>
        (await mocks.findUniqueManualRefundTask(...a)) ?? null,
    },
    xeroObjectLink: {
      findFirst: mocks.findFirstLink,
    },
    xeroSyncOperation: {
      findFirst: mocks.findFirstOperation,
      findUnique: mocks.findUniqueOperation,
      findMany: mocks.findManyOperations,
      count: mocks.countOperations,
      updateMany: mocks.updateManyOperation,
      update: mocks.updateOperation,
    },
    $executeRaw: mocks.executeRaw,
    $transaction: (fn: (tx: unknown) => unknown) => fn(client),
  };
  return { prisma: client };
});

// #3565: the outbox reads the club's format once per batch through the
// request-scoped server reader; the fake prisma above has no
// `clubFormatSettings`, so pin the test fixture rather than fall through to
// the environment seed.
vi.mock("@/lib/club-format-server", async () => {
  const { bindClubFormat } = await import("@/lib/club-format-bound");
  const { CLUB_FORMAT_TEST } = await import("@/lib/__tests__/support/club-format-fixture");
  return {
    clubFormatValues: vi.fn(async () => CLUB_FORMAT_TEST),
    clubFormat: vi.fn(async () => bindClubFormat(CLUB_FORMAT_TEST)),
  };
});

vi.mock("@/lib/logger", () => ({
  default: {
    error: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    debug: vi.fn(),
  },
}));

// #3193: the ONE mint of a supplementary invoice's key now has its own module,
// because the outbox imports the invoice module and neither could host it
// without a cycle. Left UNMOCKED and importing the stubbed
// `buildXeroIdempotencyKey` above, so the assertions below read the real key
// shape - three of them are about that shape, that a second ask can never
// collide with the invoice it follows.
vi.mock("@/lib/xero-sync", () => ({
  buildXeroIdempotencyKey: (...parts: Array<string | number | boolean | null | undefined>) =>
    parts
      .filter((part): part is string | number | boolean => part !== null && part !== undefined && part !== "")
      .map((part) => String(part))
      .join(":"),
  startXeroSyncOperation: mocks.startXeroSyncOperation,
  completeXeroSyncOperation: mocks.completeXeroSyncOperation,
  failXeroSyncOperation: mocks.failXeroSyncOperation,
  findCanonicalPaymentRefundCreditNote: mocks.findCanonicalPaymentRefundCreditNote,
  sumCoveredRefundCreditNoteCents: mocks.sumCoveredRefundCreditNoteCents,
  upsertXeroObjectLink: mocks.upsertXeroObjectLink,
}));

// #2902: the STRIPE enqueue cap reads provider-backed cash evidence, never
// the refundedAmountCents mirror. Resolution rules are unit-tested in
// stripe-cash-refund-evidence.test.ts; the default here (cash === mirror)
// keeps the pre-#2902 stepped-refund scenarios meaning what they said.
vi.mock("@/lib/stripe-cash-refund-evidence", () => ({
  resolveStripeCashRefundEvidence: mocks.resolveStripeCashRefundEvidence,
}));

vi.mock("@/lib/xero-group-settlement-invoices", () => ({
  createXeroInvoiceForGroupSettlement: mocks.createXeroInvoiceForGroupSettlement,
}));
vi.mock("@/lib/xero-group-settlement-invoice-voids", () => ({
  voidXeroInvoiceForAbandonedGroupSettlement:
    mocks.voidXeroInvoiceForAbandonedGroupSettlement,
  voidXeroInvoiceForCancelledGroupSettlement:
    mocks.voidXeroInvoiceForCancelledGroupSettlement,
}));
vi.mock("@/lib/xero-subscription-invoices", () => ({
  createXeroMembershipSubscriptionInvoice: mocks.createXeroMembershipSubscriptionInvoice,
}));

// #1208: xero-operation-outbox now imports from the source domain modules
// directly (not the @/lib/xero facade), so the doubles mock those modules.
vi.mock("@/lib/xero-booking-invoices", () => ({
  createXeroInvoiceForBooking: mocks.createXeroInvoiceForBooking,
  updateXeroBookingInvoiceForBooking: mocks.updateXeroBookingInvoiceForBooking,
}));

vi.mock("@/lib/xero-credit-notes", () => ({
  allocateCreditNoteToInvoice: mocks.allocateCreditNoteToInvoice,
  createUnappliedXeroCreditNote: mocks.createUnappliedXeroCreditNote,
  createUnappliedXeroCreditNoteForModification:
    mocks.createUnappliedXeroCreditNoteForModification,
  createXeroCreditNote: mocks.createXeroCreditNote,
  refundRequestCreditNoteKey: (paymentId: string, refundRequestId: string) =>
    `payment:${paymentId}:refund-request-credit-note:${refundRequestId}:v1`,
}));

vi.mock("@/lib/xero-entrance-fee-invoices", () => ({
  createXeroEntranceFeeInvoice: mocks.createXeroEntranceFeeInvoice,
}));

vi.mock("@/lib/xero-mappings", () => ({
  buildEntranceFeeInvoiceIdempotencyKey: (
    memberId: string,
    category: string,
    amountCents: number
  ) => `member:${memberId}:joining-fee-invoice:${category}:${amountCents}:v2`,
  getEntranceFeeContext: mocks.getEntranceFeeContext,
}));

vi.mock("@/lib/xero-applied-credit-allocation", () => ({
  allocateAppliedCreditForBooking: mocks.allocateAppliedCreditForBooking,
}));
vi.mock("@/lib/xero-applied-credit-deallocation", () => ({
  deallocateExcessAppliedCreditForBooking: mocks.deallocateExcessAppliedCreditForBooking,
}));
vi.mock("@/lib/xero-modification-credit-notes", () => ({
  createXeroCreditNoteForModification: mocks.createXeroCreditNoteForModification,
}));

vi.mock("@/lib/xero-supplementary-invoices", () => ({
  createXeroSupplementaryInvoice: mocks.createXeroSupplementaryInvoice,
}));
vi.mock("@/lib/xero-kept-late-capture-invoice", () => ({
  createXeroKeptLateCaptureInvoice: mocks.createXeroKeptLateCaptureInvoice,
}));

vi.mock("@/lib/xero-token-store", () => ({
  isXeroConnected: mocks.isXeroConnected,
}));

// #3641: the reaper asks Stripe, through the pay door, whether a declined ask
// was cancelled at the provider (locally a cancel and a decline are both FAILED).
vi.mock("@/lib/stripe", () => ({
  getPaymentIntent: mocks.getPaymentIntent,
}));

// #3641: the late-capture re-queue alerts an officer where re-issuing a retired
// invoice is unsafe.
vi.mock("@/lib/email", () => ({
  sendAdminXeroSyncErrorAlert: mocks.sendAdminXeroSyncErrorAlert,
}));

vi.mock("@/lib/alert-cooldown", async (importOriginal) => ({
  ...((await importOriginal()) as typeof import("@/lib/alert-cooldown")),
  claimAlertCooldown: mocks.claimAlertCooldown,
  deferAlertCooldown: mocks.deferAlertCooldown,
  releaseAlertCooldown: mocks.releaseAlertCooldown,
}));

vi.mock("@/lib/membership-cancellation-xero", () => ({
  createXeroMembershipCancellationCreditNote:
    mocks.createXeroMembershipCancellationCreditNote,
  syncXeroMembershipCancellationContact: mocks.syncXeroMembershipCancellationContact,
}));

import {
  attachPaymentIntentToWaitingSupplementaryInvoiceOperations,
  findWaitingSupplementaryInvoiceOperationForPaymentIntent,
  enqueueXeroAccountCreditNoteOperation,
  enqueueXeroSecondSupplementaryInvoiceOperation,
  enqueueXeroBookingInvoiceOperation,
  enqueueXeroBookingInvoiceUpdateOperation,
  enqueueXeroCreditNoteAllocationOperation,
  enqueueXeroEntranceFeeInvoiceOperation,
  enqueueXeroMembershipCancellationContactOperation,
  enqueueXeroMembershipCancellationCreditNoteOperation,
  enqueueXeroModificationAccountCreditNoteOperation,
  enqueueXeroModificationCreditNoteOperation,
  enqueueXeroRefundCreditNoteOperation,
  enqueueXeroSupplementaryInvoiceOperation,
  processQueuedXeroOutboxOperations,
  releaseXeroSupplementaryInvoiceOperationsForPaymentIntent,
  restatePendingSupplementaryInvoiceAmount,
} from "@/lib/xero-operation-outbox";
import { enqueueXeroRefundRequestCreditNoteOperation } from "@/lib/xero-refund-request-credit-note-outbox";
import {
  attachRecoveredIntentToWaitingSupplementaryInvoice,
  releaseXeroSupplementaryInvoiceForCapturedPaymentIntent,
} from "@/lib/xero-supplementary-invoice-late-capture";
import { reapStaleWaitingPaymentXeroOutboxOperations } from "@/lib/xero-waiting-invoice-reaper";
import {
  completeDeferredXeroSupplementaryInvoice,
  queueXeroBookingEditSettlement,
} from "@/lib/xero-booking-edit-settlement";
import { XERO_OUTBOX_QUEUE_TYPES } from "@/lib/xero-operation-outbox-payload";
import { XeroAppliedCreditOperationBusyError, XeroRefundCreditNoteInFlightError } from "@/lib/xero-applied-credit-operation-serialization";
import { CLUB_FORMAT_TEST } from "./support/club-format-fixture";

describe("enqueueXeroEntranceFeeInvoiceOperation", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.findFirstLink.mockResolvedValue(null);
    mocks.findUniqueBooking.mockResolvedValue({
      id: "booking_1",
      payment: {
        xeroInvoiceId: null,
      },
    });
    mocks.findUniquePayment.mockResolvedValue({
      id: "payment_1",
      xeroRefundCreditNoteId: null,
    });
    mocks.findFirstOperation.mockResolvedValue(null);
    mocks.getEntranceFeeContext.mockResolvedValue({
      category: "ADULT",
      feeMapping: {
        itemCode: "EF-ADULT",
        amountCents: 15000,
      },
    });
    mocks.startXeroSyncOperation.mockResolvedValue({ id: "op_entrance_1" });
  });

  it("creates a pending primary Xero sync operation for entrance fee invoices", async () => {
    await expect(
      enqueueXeroEntranceFeeInvoiceOperation("member_1", {
        createdByMemberId: "admin_1",
      })
    ).resolves.toEqual({
      queueOperationId: "op_entrance_1",
      message: "Xero joining fee invoice queued for background processing.",
    });

    expect(mocks.startXeroSyncOperation).toHaveBeenCalledWith(
      expect.objectContaining({
        direction: "OUTBOUND",
        entityType: "INVOICE",
        operationType: "CREATE",
        localModel: "Member",
        localId: "member_1",
        status: "PENDING",
        idempotencyKey: "member:member_1:joining-fee-invoice:ADULT:15000:v2",
        correlationKey: "member:member_1:joining-fee-invoice:ADULT:15000:v2",
        createdByMemberId: "admin_1",
        requestPayload: {
          queueType: "ENTRANCE_FEE_INVOICE",
          category: "ADULT",
          itemCode: "EF-ADULT",
          feeAmountCents: 15000,
        },
      })
    );
  });

  it("queues entrance fee invoices with admin amount and narration overrides", async () => {
    await expect(
      enqueueXeroEntranceFeeInvoiceOperation("member_1", {
        createdByMemberId: "admin_1",
        amountCents: 12345,
        description: "Entrance fee waived to adjusted family rate",
      })
    ).resolves.toEqual({
      queueOperationId: "op_entrance_1",
      message: "Xero joining fee invoice queued for background processing.",
    });

    expect(mocks.startXeroSyncOperation).toHaveBeenCalledWith(
      expect.objectContaining({
        idempotencyKey: "member:member_1:joining-fee-invoice:ADULT:12345:v2",
        correlationKey: "member:member_1:joining-fee-invoice:ADULT:12345:v2",
        requestPayload: {
          queueType: "ENTRANCE_FEE_INVOICE",
          category: "ADULT",
          itemCode: "EF-ADULT",
          feeAmountCents: 12345,
          description: "Entrance fee waived to adjusted family rate",
        },
      })
    );
  });

  it("skips queueing when there is no configured entrance fee", async () => {
    mocks.getEntranceFeeContext.mockResolvedValue({
      category: "CHILD",
      feeMapping: {
        itemCode: null,
        amountCents: null,
      },
    });

    await expect(
      enqueueXeroEntranceFeeInvoiceOperation("member_1")
    ).resolves.toEqual({
      queueOperationId: null,
      message: "No joining fee is configured for this membership type.",
    });

    expect(mocks.startXeroSyncOperation).not.toHaveBeenCalled();
  });
});

describe("enqueueXeroBookingInvoiceOperation", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.findFirstLink.mockResolvedValue(null);
    mocks.findUniqueBooking.mockResolvedValue({
      id: "booking_1",
      payment: {
        id: "payment_1",
        xeroInvoiceId: null,
      },
    });
    mocks.findFirstOperation.mockResolvedValue(null);
    mocks.startXeroSyncOperation.mockResolvedValue({ id: "op_booking_1" });
  });

  it("creates a pending primary Xero sync operation for booking invoices", async () => {
    await expect(
      enqueueXeroBookingInvoiceOperation("booking_1", {
        createdByMemberId: "admin_1",
        invoiceEmailDelivery: null,
      })
    ).resolves.toEqual({
      queueOperationId: "op_booking_1",
      message: "Xero booking invoice queued for background processing.",
    });

    expect(mocks.startXeroSyncOperation).toHaveBeenCalledWith(
      expect.objectContaining({
        direction: "OUTBOUND",
        entityType: "INVOICE",
        operationType: "CREATE",
        localModel: "Payment",
        localId: "payment_1",
        status: "PENDING",
        idempotencyKey: "booking:booking_1:invoice:v1",
        correlationKey: "booking:booking_1:invoice:v1",
        createdByMemberId: "admin_1",
        requestPayload: {
          queueType: "BOOKING_INVOICE",
          bookingId: "booking_1",
        },
      })
    );
  });

  it("queues no second invoice when an officer resolved the last create in Xero, unless force-sync overrides (#3635)", async () => {
    // The fence reads the payment's LATEST create; the dedupe reads by key.
    mocks.findFirstOperation.mockImplementation(async (args: { where: Record<string, unknown> }) =>
      args.where.correlationKey
        ? null
        : { id: "op_resolved_invoice", manuallyResolvedAt: new Date("2026-06-20T00:00:00.000Z") }
    );

    await expect(
      enqueueXeroBookingInvoiceOperation("booking_1", { invoiceEmailDelivery: null })
    ).resolves.toMatchObject({
      queueOperationId: null,
      resolvedInXeroOperationId: "op_resolved_invoice",
    });
    expect(mocks.startXeroSyncOperation).not.toHaveBeenCalled();

    await expect(
      enqueueXeroBookingInvoiceOperation("booking_1", {
        invoiceEmailDelivery: null,
        overrideResolvedInXero: true,
      })
    ).resolves.toMatchObject({
      queueOperationId: "op_booking_1",
      overrodeResolvedInXeroOperationId: "op_resolved_invoice",
    });
  });

  it("skips queueing when the booking payment is already linked to Xero", async () => {
    mocks.findUniqueBooking.mockResolvedValue({
      id: "booking_1",
      payment: {
        id: "payment_1",
        xeroInvoiceId: "inv_existing",
      },
    });

    await expect(
      enqueueXeroBookingInvoiceOperation("booking_1", {
        invoiceEmailDelivery: null,
      })
    ).resolves.toEqual({
      queueOperationId: null,
      message: "Xero booking invoice already linked for this booking.",
    });

    expect(mocks.startXeroSyncOperation).not.toHaveBeenCalled();
  });

  /*
    #2929 — the on-behalf "do not email the member" choice is persisted on the
    operation at enqueue, and this is the seam where it becomes durable. Read
    the reverse of these assertions as the failure they prevent: an enqueuer
    that silently dropped the instruction would leave the dispatcher with
    nothing to read, and a member would receive the invoice email the officer
    chose to withhold.
  */
  it("persists the creation-time invoice-email instruction the create passed it (#2929)", async () => {
    await enqueueXeroBookingInvoiceOperation("booking_1", {
      createdByMemberId: "admin_1",
      invoiceEmailDelivery: "WITHHELD_AT_CREATION",
    });

    expect(mocks.startXeroSyncOperation).toHaveBeenCalledWith(
      expect.objectContaining({ invoiceEmailDelivery: "WITHHELD_AT_CREATION" }),
    );
    // NOT in the payload, and that is the whole design: the booking-invoice
    // handler rewrites `requestPayload` wholesale before its first provider
    // call, so an instruction kept there would survive the happy path and
    // vanish on exactly the retry that needs it.
    const [input] = mocks.startXeroSyncOperation.mock.calls[0];
    expect(JSON.stringify(input.requestPayload)).not.toContain(
      "WITHHELD_AT_CREATION",
    );
  });

  it("records no instruction for the fifteen enqueuers with no choice to express, when nothing was recorded before (#2929)", async () => {
    // THE ONE PLACE THE LIVE POPULATION IS COUNTED. Seventeen call sites reach
    // this function; the two in `booking-create` carry the officer's answer and
    // the other FIFTEEN pass an explicit null — confirm-draft, waitlist-confirm,
    // charge-saved-method, switch-to-internet-banking, confirm-pending-guests,
    // cron-confirm-pending, group settlement, the school-booking-request
    // conversion (`approveSchoolBookingRequest`), the member whole-lodge request
    // approval (`approveMemberWholeLodgeRequest`, a SECOND site in that same
    // file and the one an earlier draft of this list missed), the booking-edit
    // settlement, the admin payment-invoice service, the invoice queue, and the
    // admin missing-invoices, force-sync and repair surfaces. They must keep
    // behaving exactly as they did before this issue when no earlier operation
    // for this same invoice expressed a choice.
    //
    // Recount with, and keep this list in step with:
    //   grep -rn "invoiceEmailDelivery: null" --include=*.ts src/ | grep -v __tests__
    await enqueueXeroBookingInvoiceOperation("booking_1", {
      createdByMemberId: "admin_1",
      invoiceEmailDelivery: null,
    });

    expect(mocks.startXeroSyncOperation).toHaveBeenCalledWith(
      expect.objectContaining({ invoiceEmailDelivery: null }),
    );
  });

  /*
    #2929 fix round — THE RE-MINT, which is the door the durable-instruction
    mechanism did not originally close.

    The dedup above short-circuits only on a PENDING or RUNNING row, and the
    link check only on an invoice that was actually raised. A booking-invoice
    operation that FAILED leaves neither, so the admin missing-invoices sweep,
    force-sync and the repair pass each mint a FRESH operation — passing null,
    because none of them has an officer in front of it. Without inheritance the
    fresh row records nothing and Xero emails the member the invoice the officer
    chose to withhold.

    `mocks.findFirstOperation` serves both lookups here, so these tests
    discriminate on the WHERE shape: the dedup asks for a status in
    PENDING/RUNNING, the inheritance lookup asks for `invoiceEmailDelivery: {
    not: null }`.
  */
  function priorOperationRecorded(invoiceEmailDelivery: string | null) {
    mocks.findFirstOperation.mockImplementation(
      async (args: { where?: Record<string, unknown> }) => {
        if (args?.where?.invoiceEmailDelivery) {
          return invoiceEmailDelivery === null
            ? null
            : { invoiceEmailDelivery };
        }
        // The dedup lookup: nothing pending or running.
        return null;
      },
    );
  }

  it("inherits the withhold when a re-mint of the SAME invoice states no choice of its own (#2929)", async () => {
    priorOperationRecorded("WITHHELD_AT_CREATION");

    await enqueueXeroBookingInvoiceOperation("booking_1", {
      createdByMemberId: "admin_1",
      invoiceEmailDelivery: null,
    });

    expect(mocks.startXeroSyncOperation).toHaveBeenCalledWith(
      expect.objectContaining({
        invoiceEmailDelivery: "WITHHELD_AT_CREATION",
      }),
    );
  });

  it("looks for the prior instruction under the SAME correlation key and payment, most recent first", async () => {
    priorOperationRecorded("WITHHELD_AT_CREATION");

    await enqueueXeroBookingInvoiceOperation("booking_1", {
      invoiceEmailDelivery: null,
    });

    const inheritanceCall = mocks.findFirstOperation.mock.calls.find(
      (call) => call[0]?.where?.invoiceEmailDelivery,
    );
    expect(inheritanceCall, "the inheritance lookup must run").toBeDefined();
    expect(inheritanceCall![0]).toMatchObject({
      where: {
        correlationKey: "booking:booking_1:invoice:v1",
        direction: "OUTBOUND",
        entityType: "INVOICE",
        operationType: "CREATE",
        localModel: "Payment",
        localId: "payment_1",
        invoiceEmailDelivery: { not: null },
      },
      orderBy: { createdAt: "desc" },
    });
  });

  it("also carries a recorded SEND forward, so a re-mint cannot turn a stated choice into no choice", async () => {
    priorOperationRecorded("SEND");

    await enqueueXeroBookingInvoiceOperation("booking_1", {
      invoiceEmailDelivery: null,
    });

    expect(mocks.startXeroSyncOperation).toHaveBeenCalledWith(
      expect.objectContaining({ invoiceEmailDelivery: "SEND" }),
    );
  });

  it("does not copy forward a stored value this application does not recognise", async () => {
    // Read back through `readXeroInvoiceEmailInstruction`, never raw: a corrupt
    // value must become "no instruction", not be propagated into new rows.
    priorOperationRecorded("withheld_at_creation");

    await enqueueXeroBookingInvoiceOperation("booking_1", {
      invoiceEmailDelivery: null,
    });

    expect(mocks.startXeroSyncOperation).toHaveBeenCalledWith(
      expect.objectContaining({ invoiceEmailDelivery: null }),
    );
  });

  it("lets an explicit instruction win, and does not look for an earlier one at all", async () => {
    priorOperationRecorded("WITHHELD_AT_CREATION");

    await enqueueXeroBookingInvoiceOperation("booking_1", {
      invoiceEmailDelivery: "SEND",
    });

    expect(mocks.startXeroSyncOperation).toHaveBeenCalledWith(
      expect.objectContaining({ invoiceEmailDelivery: "SEND" }),
    );
    expect(
      mocks.findFirstOperation.mock.calls.some(
        (call) => call[0]?.where?.invoiceEmailDelivery,
      ),
      "an officer's stated choice must not cost a second query",
    ).toBe(false);
  });

  it("does not reach the inheritance lookup when an operation is already queued", async () => {
    // The dedup is unchanged by #2929: a PENDING row short-circuits before any
    // of this, and the queued row keeps whatever it already recorded.
    mocks.findFirstOperation.mockImplementation(
      async (args: { where?: Record<string, unknown> }) =>
        args?.where?.invoiceEmailDelivery ? { invoiceEmailDelivery: "SEND" } : { id: "op_queued" },
    );

    await expect(
      enqueueXeroBookingInvoiceOperation("booking_1", {
        invoiceEmailDelivery: null,
      }),
    ).resolves.toEqual({
      queueOperationId: "op_queued",
      message: "Xero booking invoice is already queued for background processing.",
    });

    expect(mocks.startXeroSyncOperation).not.toHaveBeenCalled();
  });

  /*
    A TYPE-LEVEL PIN, not a runtime assertion (#2929 fix round). The option is
    REQUIRED so that a NEW booking-invoice enqueuer is a compile error
    until its author states its instruction — this repository prefers
    unrepresentable over policed, and the module next door already requires a
    typed context on every send for the same reason. `@ts-expect-error` reports
    an error when the line it guards does NOT error, so making the field
    optional again fails `pnpm run typecheck`.
  */
  it("keeps the instruction a REQUIRED option, so a new enqueuer cannot omit it", () => {
    const omitsTheInstruction = () =>
      // @ts-expect-error - invoiceEmailDelivery is required on every enqueuer
      enqueueXeroBookingInvoiceOperation("booking_1", {
        createdByMemberId: "admin_1",
      });
    expect(typeof omitsTheInstruction).toBe("function");
  });
});

describe("enqueueXeroBookingInvoiceUpdateOperation", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.findUniqueBooking.mockResolvedValue({
      id: "booking_1",
      checkIn: new Date("2026-05-30T00:00:00.000Z"),
      checkOut: new Date("2026-05-31T00:00:00.000Z"),
      payment: {
        id: "payment_1",
        xeroInvoiceId: "inv_existing",
      },
    });
    mocks.findFirstOperation.mockResolvedValue(null);
    mocks.startXeroSyncOperation.mockResolvedValue({ id: "op_booking_update_1" });
  });

  it("creates a pending Xero sync operation for primary booking invoice updates", async () => {
    await expect(
      enqueueXeroBookingInvoiceUpdateOperation("booking_1", {
        createdByMemberId: "admin_1",
      })
    ).resolves.toEqual({
      queueOperationId: "op_booking_update_1",
      message: "Xero booking invoice update queued for background processing.",
    });

    expect(mocks.startXeroSyncOperation).toHaveBeenCalledWith(
      expect.objectContaining({
        direction: "OUTBOUND",
        entityType: "INVOICE",
        operationType: "UPDATE",
        localModel: "Payment",
        localId: "payment_1",
        status: "PENDING",
        idempotencyKey: "booking:booking_1:invoice-update:inv_existing:2026-05-30:2026-05-31:v1",
        correlationKey: "booking:booking_1:invoice-update:inv_existing:2026-05-30:2026-05-31:v1",
        createdByMemberId: "admin_1",
        requestPayload: {
          queueType: "BOOKING_INVOICE_UPDATE",
          bookingId: "booking_1",
          xeroInvoiceId: "inv_existing",
        },
      })
    );
  });

  it("skips queueing when there is no original Xero invoice", async () => {
    mocks.findUniqueBooking.mockResolvedValue({
      id: "booking_1",
      checkIn: new Date("2026-05-30T00:00:00.000Z"),
      checkOut: new Date("2026-05-31T00:00:00.000Z"),
      payment: {
        id: "payment_1",
        xeroInvoiceId: null,
      },
    });

    await expect(
      enqueueXeroBookingInvoiceUpdateOperation("booking_1")
    ).resolves.toEqual({
      queueOperationId: null,
      message: "No original Xero invoice exists for this booking.",
    });

    expect(mocks.startXeroSyncOperation).not.toHaveBeenCalled();
  });
});

describe("enqueueXeroSupplementaryInvoiceOperation", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.findFirstLink.mockResolvedValue(null);
    mocks.findUniqueBooking.mockResolvedValue({
      id: "booking_1",
      payment: {
        xeroInvoiceId: "inv_existing",
      },
    });
    mocks.findFirstOperation.mockResolvedValue(null);
    mocks.startXeroSyncOperation.mockResolvedValue({ id: "op_supplementary_1" });
  });

  it("creates a pending Xero sync operation for supplementary invoices", async () => {
    await expect(
      enqueueXeroSupplementaryInvoiceOperation(
        {
          bookingId: "booking_1",
          priceDiffCents: 2500,
          changeFeeCents: 500,
          bookingModificationId: "mod_1",
        },
        {
          createdByMemberId: "admin_1",
        }
      )
    ).resolves.toEqual({
      queueOperationId: "op_supplementary_1",
      outcome: "covers-total",
      message: "Xero supplementary invoice queued for background processing.",
    });

    expect(mocks.startXeroSyncOperation).toHaveBeenCalledWith(
      expect.objectContaining({
        direction: "OUTBOUND",
        entityType: "INVOICE",
        operationType: "CREATE",
        localModel: "BookingModification",
        localId: "mod_1",
        status: "PENDING",
        idempotencyKey: "booking-mod:mod_1:supplementary-invoice:2500:500:v1",
        correlationKey: "booking-mod:mod_1:supplementary-invoice:2500:500:v1",
        createdByMemberId: "admin_1",
        requestPayload: {
          queueType: "SUPPLEMENTARY_INVOICE",
          bookingId: "booking_1",
          priceDiffCents: 2500,
          changeFeeCents: 500,
          bookingModificationId: "mod_1",
          recordPayment: true,
          paymentIntentId: null,
          waitForConfirmedAdditionalPayment: false,
          // #3193: null on the ordinary path - this row IS the booking change's
          // supplementary invoice, not a follow-on for a share it went out
          // without.
          shortfallReviewTaskId: null,
        },
      })
    );
  });

  // #1356 (F16): mixed-sign components stay signed through the queue so the
  // executor can bill the exact net; a net that is not positive never becomes
  // a supplementary invoice (it belongs to the credit-note paths).
  it("queues mixed-sign components signed when the net is positive (#1356)", async () => {
    await expect(
      enqueueXeroSupplementaryInvoiceOperation(
        {
          bookingId: "booking_1",
          priceDiffCents: -500,
          changeFeeCents: 1000,
          bookingModificationId: "mod_mixed",
        },
        {
          createdByMemberId: "admin_1",
        }
      )
    ).resolves.toEqual({
      queueOperationId: "op_supplementary_1",
      outcome: "covers-total",
      message: "Xero supplementary invoice queued for background processing.",
    });

    expect(mocks.startXeroSyncOperation).toHaveBeenCalledWith(
      expect.objectContaining({
        idempotencyKey: "booking-mod:mod_mixed:supplementary-invoice:-500:1000:v1",
        requestPayload: expect.objectContaining({
          priceDiffCents: -500,
          changeFeeCents: 1000,
        }),
      })
    );
  });

  it("skips mixed-sign modifications whose net is not positive (#1356)", async () => {
    await expect(
      enqueueXeroSupplementaryInvoiceOperation(
        {
          bookingId: "booking_1",
          priceDiffCents: -1500,
          changeFeeCents: 1000,
          bookingModificationId: "mod_negative_net",
        },
        {
          createdByMemberId: "admin_1",
        }
      )
    ).resolves.toEqual({
      queueOperationId: null,
      outcome: "none",
      message: "No supplementary invoice is required for this modification.",
    });

    expect(mocks.startXeroSyncOperation).not.toHaveBeenCalled();
  });

  it("can hold supplementary invoices until additional Stripe payment succeeds", async () => {
    await expect(
      enqueueXeroSupplementaryInvoiceOperation(
        {
          bookingId: "booking_1",
          priceDiffCents: 2500,
          changeFeeCents: 500,
          bookingModificationId: "mod_1",
        },
        {
          createdByMemberId: "admin_1",
          paymentIntentId: "pi_additional",
          waitForConfirmedAdditionalPayment: true,
          recordPayment: true,
        }
      )
    ).resolves.toEqual({
      queueOperationId: "op_supplementary_1",
      outcome: "covers-total",
      message: "Xero supplementary invoice is waiting for confirmed additional payment.",
    });

    expect(mocks.startXeroSyncOperation).toHaveBeenCalledWith(
      expect.objectContaining({
        status: "WAITING_PAYMENT",
        requestPayload: expect.objectContaining({
          paymentIntentId: "pi_additional",
          waitForConfirmedAdditionalPayment: true,
          recordPayment: true,
        }),
      })
    );
  });

  it("releases waiting supplementary invoice operations after payment confirmation", async () => {
    mocks.findManyOperations.mockResolvedValue([{ id: "op_supplementary_1" }]);
    mocks.updateManyOperation.mockResolvedValue({ count: 1 });

    await expect(
      releaseXeroSupplementaryInvoiceOperationsForPaymentIntent("pi_additional")
    ).resolves.toEqual({
      released: 1,
      queueOperationIds: ["op_supplementary_1"],
    });

    expect(mocks.updateManyOperation).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          id: { in: ["op_supplementary_1"] },
          status: "WAITING_PAYMENT",
        }),
        data: expect.objectContaining({
          status: "PENDING",
          startedAt: null,
        }),
      })
    );
  });
});

// #3827, owner decision D-3813-8 (`INV-PAY-118`): a refund request's OWN note,
// queued when its task is marked paid back - keyed by the request, so a second
// request on the same payment is never absorbed, and a replay queues nothing.
describe("enqueueXeroRefundRequestCreditNoteOperation (D-3813-8)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.findManyOperations.mockResolvedValue([]);
    mocks.findFirstOperation.mockResolvedValue(null);
    mocks.startXeroSyncOperation.mockResolvedValue({ id: "op_request_note_1" });
  });

  it("queues one note for exactly the amount paid back, keyed by the request, never per-delta", async () => {
    await expect(
      enqueueXeroRefundRequestCreditNoteOperation({
        paymentId: "payment_1",
        refundRequestId: "req_1",
        amountCents: 4000,
        createdByMemberId: "admin_1",
      }),
    ).resolves.toMatchObject({ queueOperationId: "op_request_note_1" });
    expect(mocks.startXeroSyncOperation).toHaveBeenCalledWith(
      expect.objectContaining({
        direction: "OUTBOUND",
        entityType: "CREDIT_NOTE",
        operationType: "CREATE",
        localModel: "Payment",
        localId: "payment_1",
        status: "PENDING",
        idempotencyKey: "payment:payment_1:refund-request-credit-note:req_1:v1",
        correlationKey: "payment:payment_1:refund-request-credit-note:req_1:v1",
        createdByMemberId: "admin_1",
        requestPayload: {
          queueType: "REFUND_CREDIT_NOTE",
          refundAmountCents: 4000,
          refundMethod: "internet-banking",
          refundRequestId: "req_1",
        },
      }),
    );
    // Never the one-note-per-payment absorption, never Stripe coverage.
    expect(mocks.findCanonicalPaymentRefundCreditNote).not.toHaveBeenCalled();
    expect(mocks.sumCoveredRefundCreditNoteCents).not.toHaveBeenCalled();
  });

  it("a second request on the same payment gets its own key", async () => {
    await enqueueXeroRefundRequestCreditNoteOperation({ paymentId: "payment_1", refundRequestId: "req_1", amountCents: 4000 });
    await enqueueXeroRefundRequestCreditNoteOperation({ paymentId: "payment_1", refundRequestId: "req_2", amountCents: 3000 });
    const keys = mocks.startXeroSyncOperation.mock.calls.map(
      ([input]) => (input as { correlationKey: string }).correlationKey,
    );
    expect(keys).toEqual([
      "payment:payment_1:refund-request-credit-note:req_1:v1",
      "payment:payment_1:refund-request-credit-note:req_2:v1",
    ]);
  });

  it("a replay finds this request's row, whatever its status, and queues nothing", async () => {
    mocks.findFirstOperation.mockResolvedValue({ id: "op_done" });
    await expect(
      enqueueXeroRefundRequestCreditNoteOperation({ paymentId: "payment_1", refundRequestId: "req_1", amountCents: 4000 }),
    ).resolves.toMatchObject({ queueOperationId: "op_done" });
    expect(mocks.findFirstOperation).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.not.objectContaining({ status: expect.anything() }),
      }),
    );
    expect(mocks.findFirstOperation).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ correlationKey: "payment:payment_1:refund-request-credit-note:req_1:v1" }),
      }),
    );
    expect(mocks.startXeroSyncOperation).not.toHaveBeenCalled();
  });

  it("queues nothing for a zero amount", async () => {
    await expect(
      enqueueXeroRefundRequestCreditNoteOperation({ paymentId: "payment_1", refundRequestId: "req_1", amountCents: 0 }),
    ).resolves.toMatchObject({ queueOperationId: null });
    expect(mocks.startXeroSyncOperation).not.toHaveBeenCalled();
  });
});

describe("enqueueXeroRefundCreditNoteOperation", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // #3635: no hand-resolved refund note unless a test says so.
    mocks.findManyOperations.mockResolvedValue([]);
    mocks.findFirstLink.mockResolvedValue(null);
    mocks.findUniquePayment.mockResolvedValue({
      id: "payment_1",
      source: "INTERNET_BANKING",
      refundedAmountCents: 5000,
      xeroRefundCreditNoteId: null,
    });
    mocks.findFirstOperation.mockResolvedValue(null);
    mocks.findCanonicalPaymentRefundCreditNote.mockResolvedValue(null);
    mocks.sumCoveredRefundCreditNoteCents.mockResolvedValue(0);
    // Default: every refunded cent is provider-backed cash, so pre-#2902
    // scenarios keep their arithmetic. #2902 cases override per test.
    mocks.resolveStripeCashRefundEvidence.mockImplementation(
      async (payment: { refundedAmountCents: number }) => ({
        cashRefundCents: payment.refundedAmountCents,
        countedRefundCents: payment.refundedAmountCents,
        refundLedgerRowCount: 1,
        accountCreditCents: 0,
        source: "provider-ledger",
      })
    );
    mocks.startXeroSyncOperation.mockResolvedValue({ id: "op_credit_note_1" });
  });

  it("creates a pending primary Xero sync operation for non-Stripe refund credit notes", async () => {
    await expect(
      enqueueXeroRefundCreditNoteOperation("payment_1", 5000, {
        createdByMemberId: "admin_1",
      })
    ).resolves.toEqual({
      queueOperationId: "op_credit_note_1",
      message: "Xero refund credit note queued for background processing.",
    });

    expect(mocks.startXeroSyncOperation).toHaveBeenCalledWith(
      expect.objectContaining({
        direction: "OUTBOUND",
        entityType: "CREDIT_NOTE",
        operationType: "CREATE",
        localModel: "Payment",
        localId: "payment_1",
        status: "PENDING",
        idempotencyKey: "payment:payment_1:refund-credit-note:5000:v1",
        correlationKey: "payment:payment_1:refund-credit-note:5000:v1",
        createdByMemberId: "admin_1",
        requestPayload: {
          queueType: "REFUND_CREDIT_NOTE",
          refundAmountCents: 5000,
          watermarkCents: 5000,
        },
      })
    );
    // Non-Stripe payments never consult the cumulative refund watermark.
    expect(mocks.sumCoveredRefundCreditNoteCents).not.toHaveBeenCalled();
  });

  // #1357 (F17): a transaction-scoped enqueue must route EVERY internal
  // read/write through the caller's client so the outbox row commits
  // atomically with the caller's release (and the dedupe sees uncommitted
  // state), never through the global prisma client.
  // #3635 round 4 (review N1): a hand-resolved refund note covers its RECORDED
  // amount, never the whole payment. $50 refunded and its note raised by hand,
  // then a second refund of $30.
  const resolvedFiftyDollarNote = {
    id: "op_resolved_note",
    correlationKey: "payment:payment_1:refund-credit-note:5000:v2",
    requestPayload: { queueType: "REFUND_CREDIT_NOTE", refundAmountCents: 5000, watermarkCents: 5000 },
  };

  it("the Stripe webhook's later $30 refund still gets its own note beside a hand-resolved $50 one (#3635)", async () => {
    mocks.findUniquePayment.mockResolvedValue({
      id: "payment_1",
      source: "STRIPE",
      refundedAmountCents: 8000,
      xeroRefundCreditNoteId: null,
    });
    mocks.findManyOperations.mockResolvedValue([resolvedFiftyDollarNote]);
    // No link covers the hand-made note; cash evidence is the full $80.
    mocks.sumCoveredRefundCreditNoteCents.mockResolvedValue(0);

    await expect(
      enqueueXeroRefundCreditNoteOperation("payment_1", 3000)
    ).resolves.toMatchObject({ queueOperationId: "op_credit_note_1" });
    expect(mocks.startXeroSyncOperation).toHaveBeenCalledWith(
      expect.objectContaining({
        correlationKey: "payment:payment_1:refund-credit-note:8000:v2",
        requestPayload: expect.objectContaining({ refundAmountCents: 3000, watermarkCents: 8000 }),
      })
    );

    // And the self-heal asking for the whole uncovered figure re-mints nothing
    // the officer made: the same state, sized from the same coverage.
    mocks.startXeroSyncOperation.mockClear();
    await enqueueXeroRefundCreditNoteOperation("payment_1", 8000);
    expect(mocks.startXeroSyncOperation).toHaveBeenCalledWith(
      expect.objectContaining({
        requestPayload: expect.objectContaining({ refundAmountCents: 3000 }),
      })
    );
  });

  it("a refund-request approval of $30 on a non-Stripe payment is queued beside a hand-resolved $50 note (#3635)", async () => {
    mocks.findManyOperations.mockResolvedValue([
      {
        ...resolvedFiftyDollarNote,
        correlationKey: "payment:payment_1:refund-credit-note:5000:v1",
      },
    ]);

    await expect(
      enqueueXeroRefundCreditNoteOperation("payment_1", 3000, { createdByMemberId: "admin_1" })
    ).resolves.toMatchObject({ queueOperationId: "op_credit_note_1" });

    // The SAME refund again (a cron rerun) is the one the officer covered.
    mocks.startXeroSyncOperation.mockClear();
    await expect(enqueueXeroRefundCreditNoteOperation("payment_1", 5000)).resolves.toMatchObject({
      queueOperationId: null,
      resolvedInXeroOperationId: "op_resolved_note",
    });
    expect(mocks.startXeroSyncOperation).not.toHaveBeenCalled();
  });

  it("refuses loudly when a hand-resolved note's amount cannot be read (#3635)", async () => {
    mocks.findManyOperations.mockResolvedValue([
      { id: "op_unreadable", correlationKey: null, requestPayload: null },
    ]);

    await expect(enqueueXeroRefundCreditNoteOperation("payment_1", 3000)).resolves.toMatchObject({
      queueOperationId: null,
      resolvedInXeroOperationId: "op_unreadable",
      message: expect.stringContaining("by hand"),
    });
    expect(mocks.startXeroSyncOperation).not.toHaveBeenCalled();
  });

  it("routes all reads and the insert through the caller's store client", async () => {
    const store = {
      payment: {
        findUnique: vi.fn().mockResolvedValue({
          id: "payment_1",
          source: "INTERNET_BANKING",
          refundedAmountCents: 5000,
          xeroRefundCreditNoteId: null,
        }),
        update: vi.fn(),
      },
      xeroSyncOperation: {
        findFirst: vi.fn().mockResolvedValue(null),
        findMany: vi.fn().mockResolvedValue([]),
      },
    };

    await expect(
      enqueueXeroRefundCreditNoteOperation("payment_1", 5000, {
        createdByMemberId: "cron",
        store: store as never,
      })
    ).resolves.toEqual({
      queueOperationId: "op_credit_note_1",
      message: "Xero refund credit note queued for background processing.",
    });

    expect(store.payment.findUnique).toHaveBeenCalledTimes(1);
    // The queued-row dedupe; the #3635 coverage read goes through the store too.
    expect(store.xeroSyncOperation.findFirst).toHaveBeenCalledTimes(1);
    expect(store.xeroSyncOperation.findMany).toHaveBeenCalledTimes(1);
    // The global-prisma delegates stayed untouched.
    expect(mocks.findUniquePayment).not.toHaveBeenCalled();
    expect(mocks.findFirstOperation).not.toHaveBeenCalled();
    // Helpers and the operation insert received the same client.
    expect(mocks.findCanonicalPaymentRefundCreditNote).toHaveBeenCalledWith(
      "payment_1",
      store
    );
    expect(mocks.startXeroSyncOperation).toHaveBeenCalledWith(
      expect.objectContaining({
        localId: "payment_1",
        store,
      })
    );
  });

  it("queues the uncovered delta with a v2 watermark key for a second Stripe refund", async () => {
    mocks.findUniquePayment.mockResolvedValue({
      id: "payment_1",
      source: "STRIPE",
      refundedAmountCents: 8000,
      xeroRefundCreditNoteId: "cn_1",
    });
    mocks.sumCoveredRefundCreditNoteCents.mockResolvedValue(5000);

    await expect(
      enqueueXeroRefundCreditNoteOperation("payment_1", 3000, {
        createdByMemberId: "admin_1",
      })
    ).resolves.toEqual({
      queueOperationId: "op_credit_note_1",
      message: "Xero refund credit note queued for background processing.",
    });

    expect(mocks.startXeroSyncOperation).toHaveBeenCalledWith(
      expect.objectContaining({
        idempotencyKey: "payment:payment_1:refund-credit-note:8000:v2",
        correlationKey: "payment:payment_1:refund-credit-note:8000:v2",
        requestPayload: {
          queueType: "REFUND_CREDIT_NOTE",
          refundAmountCents: 3000,
          watermarkCents: 8000,
        },
      })
    );
  });

  // #3635 round-3 R4/R3: a late capture's note records the capture it answers
  // and the day its refund left Stripe, for the executor and the per-capture count.
  it("records the late capture a note answers, and its refund's day, on the queued row", async () => {
    mocks.findUniquePayment.mockResolvedValue({
      id: "payment_1",
      source: "STRIPE",
      refundedAmountCents: 8000,
      xeroRefundCreditNoteId: "cn_1",
    });
    mocks.sumCoveredRefundCreditNoteCents.mockResolvedValue(5000);

    await enqueueXeroRefundCreditNoteOperation("payment_1", 3000, {
      refundMethod: "card",
      paymentIntentId: "pi_late",
      documentDate: "2026-06-12",
    });

    expect(mocks.startXeroSyncOperation).toHaveBeenCalledWith(
      expect.objectContaining({
        requestPayload: {
          queueType: "REFUND_CREDIT_NOTE",
          refundAmountCents: 3000,
          watermarkCents: 8000,
          refundMethod: "card",
          paymentIntentId: "pi_late",
          documentDate: "2026-06-12",
        },
      })
    );
  });

  it("skips a replayed Stripe delta once the notes already cover the refund", async () => {
    mocks.findUniquePayment.mockResolvedValue({
      id: "payment_1",
      source: "STRIPE",
      refundedAmountCents: 8000,
      xeroRefundCreditNoteId: "cn_1",
    });
    mocks.sumCoveredRefundCreditNoteCents.mockResolvedValue(8000);

    await expect(
      enqueueXeroRefundCreditNoteOperation("payment_1", 3000)
    ).resolves.toEqual({
      queueOperationId: null,
      message:
        "No provider-backed Stripe cash refund remains uncovered by refund credit notes for this payment.",
    });

    expect(mocks.startXeroSyncOperation).not.toHaveBeenCalled();
  });

  it("enqueues nothing for an account-credit-only cancellation whose cash evidence is zero (#2902)", async () => {
    mocks.findUniquePayment.mockResolvedValue({
      id: "payment_1",
      bookingId: "booking_1",
      source: "STRIPE",
      // The mirror moved (the cancellation ran applyLocalRefundAllocation)
      // but no Stripe cash ever did.
      refundedAmountCents: 34100,
      xeroRefundCreditNoteId: null,
    });
    mocks.sumCoveredRefundCreditNoteCents.mockResolvedValue(0);
    mocks.resolveStripeCashRefundEvidence.mockResolvedValue({
      cashRefundCents: 0,
      countedRefundCents: 0,
      refundLedgerRowCount: 0,
      accountCreditCents: 34100,
      source: "legacy-mirror",
    });

    await expect(
      enqueueXeroRefundCreditNoteOperation("payment_1", 34100)
    ).resolves.toEqual({
      queueOperationId: null,
      message:
        "No provider-backed Stripe cash refund remains uncovered by refund credit notes for this payment.",
    });

    expect(mocks.startXeroSyncOperation).not.toHaveBeenCalled();
  });

  it("caps a mixed-disposition delta at the cash evidence, not the mirror (#2902)", async () => {
    mocks.findUniquePayment.mockResolvedValue({
      id: "payment_1",
      bookingId: "booking_1",
      source: "STRIPE",
      // 9000 mirror = 4000 Stripe cash + 5000 account credit.
      refundedAmountCents: 9000,
      xeroRefundCreditNoteId: null,
    });
    mocks.sumCoveredRefundCreditNoteCents.mockResolvedValue(1000);
    mocks.resolveStripeCashRefundEvidence.mockResolvedValue({
      cashRefundCents: 4000,
      countedRefundCents: 4000,
      refundLedgerRowCount: 2,
      accountCreditCents: 0,
      source: "provider-ledger",
    });

    await enqueueXeroRefundCreditNoteOperation("payment_1", 9000);

    // min(requested 9000, cash 4000 − covered 1000) = 3000 — never the
    // mirror-based 8000. The watermark stays covered + note.
    expect(mocks.startXeroSyncOperation).toHaveBeenCalledWith(
      expect.objectContaining({
        requestPayload: {
          queueType: "REFUND_CREDIT_NOTE",
          refundAmountCents: 3000,
          watermarkCents: 4000,
        },
      })
    );
  });

  it("gives two equal Stripe deltas distinct watermark correlation keys", async () => {
    mocks.findUniquePayment.mockResolvedValue({
      id: "payment_1",
      source: "STRIPE",
      refundedAmountCents: 5000,
      xeroRefundCreditNoteId: null,
    });
    mocks.sumCoveredRefundCreditNoteCents.mockResolvedValue(0);
    await enqueueXeroRefundCreditNoteOperation("payment_1", 5000);

    mocks.findUniquePayment.mockResolvedValue({
      id: "payment_1",
      source: "STRIPE",
      refundedAmountCents: 10000,
      xeroRefundCreditNoteId: "cn_1",
    });
    mocks.sumCoveredRefundCreditNoteCents.mockResolvedValue(5000);
    await enqueueXeroRefundCreditNoteOperation("payment_1", 5000);

    const firstKey = mocks.startXeroSyncOperation.mock.calls[0][0].correlationKey;
    const secondKey = mocks.startXeroSyncOperation.mock.calls[1][0].correlationKey;
    expect(firstKey).toBe("payment:payment_1:refund-credit-note:5000:v2");
    expect(secondKey).toBe("payment:payment_1:refund-credit-note:10000:v2");
    expect(firstKey).not.toBe(secondKey);
  });

  it("keeps the legacy single-note skip for non-Stripe payments already linked", async () => {
    mocks.findUniquePayment.mockResolvedValue({
      id: "payment_1",
      source: "INTERNET_BANKING",
      refundedAmountCents: 5000,
      xeroRefundCreditNoteId: "cn_existing",
    });
    mocks.findCanonicalPaymentRefundCreditNote.mockResolvedValue({
      xeroObjectId: "cn_existing",
      xeroObjectNumber: "CN-1",
      source: "payment",
    });

    await expect(
      enqueueXeroRefundCreditNoteOperation("payment_1", 5000)
    ).resolves.toEqual({
      queueOperationId: null,
      message: "Xero refund credit note already linked for this payment.",
    });

    expect(mocks.sumCoveredRefundCreditNoteCents).not.toHaveBeenCalled();
    expect(mocks.startXeroSyncOperation).not.toHaveBeenCalled();
  });

  it("skips queueing when the webhook delta is zero", async () => {
    await expect(
      enqueueXeroRefundCreditNoteOperation("payment_1", 0)
    ).resolves.toEqual({
      queueOperationId: null,
      message: "No additional Xero refund credit note is required for this payment.",
    });

    expect(mocks.findCanonicalPaymentRefundCreditNote).not.toHaveBeenCalled();
    expect(mocks.startXeroSyncOperation).not.toHaveBeenCalled();
  });

  // #3880: a review's refund on a CANCELLED booking - by card or handed back by
  // bank transfer - is noted per refund and keyed on its review task.
  describe("#3880 - a review's refund on a cancelled booking", () => {
    const bankTransferPayment = (refundedAmountCents: number) =>
      mocks.findUniquePayment.mockResolvedValue({
        id: "payment_1",
        source: "INTERNET_BANKING",
        refundedAmountCents,
        // The cancellation's or an earlier review's note is already linked.
        xeroRefundCreditNoteId: "cn_existing",
      });

    it("MUTATION: a bank-transfer hand-back is noted beside the payment's existing note, capped by coverage and keyed on the task", async () => {
      bankTransferPayment(3500);
      mocks.findCanonicalPaymentRefundCreditNote.mockResolvedValue({ xeroObjectId: "cn_existing", xeroObjectNumber: "CN-1", source: "payment" });
      mocks.sumCoveredRefundCreditNoteCents.mockResolvedValue(1000);

      await expect(
        enqueueXeroRefundCreditNoteOperation("payment_1", 2500, { refundMethod: "internet-banking", reviewTaskId: "task_1" })
      ).resolves.toMatchObject({ queueOperationId: "op_credit_note_1" });

      expect(mocks.startXeroSyncOperation).toHaveBeenCalledWith(
        expect.objectContaining({
          correlationKey: "payment:payment_1:refund-credit-note:3500:v2:review-task:task_1",
          idempotencyKey: "payment:payment_1:refund-credit-note:3500:v2:review-task:task_1",
          requestPayload: { queueType: "REFUND_CREDIT_NOTE", refundAmountCents: 2500, watermarkCents: 3500, refundMethod: "internet-banking", reviewTaskId: "task_1" },
        })
      );
    });

    it("MUTATION: two sibling reviews' equal $10 refunds are a note each, not one folded into the other", async () => {
      bankTransferPayment(2000);
      await enqueueXeroRefundCreditNoteOperation("payment_1", 1000, { reviewTaskId: "task_1" });
      await enqueueXeroRefundCreditNoteOperation("payment_1", 1000, { reviewTaskId: "task_2" });

      const keys = mocks.startXeroSyncOperation.mock.calls.map((call) => call[0].correlationKey);
      expect(keys).toEqual([
        "payment:payment_1:refund-credit-note:1000:v2:review-task:task_1",
        "payment:payment_1:refund-credit-note:1000:v2:review-task:task_2",
      ]);
    });

    it("a replay while the note is queued answers with the queued row; once it is raised, a replay raises nothing", async () => {
      mocks.findUniquePayment.mockResolvedValue({ id: "payment_1", source: "STRIPE", refundedAmountCents: 10500, xeroRefundCreditNoteId: "cn_cancel" });
      mocks.sumCoveredRefundCreditNoteCents.mockResolvedValue(8000);
      mocks.findFirstOperation.mockResolvedValue({ id: "op_queued" });

      await expect(enqueueXeroRefundCreditNoteOperation("payment_1", 2500, { reviewTaskId: "task_1" })).resolves.toMatchObject({
        queueOperationId: "op_queued",
      });
      expect(mocks.findFirstOperation).toHaveBeenCalledWith(
        expect.objectContaining({ where: expect.objectContaining({ correlationKey: "payment:payment_1:refund-credit-note:10500:v2:review-task:task_1" }) })
      );

      // Raised: its link covers the cash, so the same request sizes to nothing.
      mocks.findFirstOperation.mockResolvedValue(null);
      mocks.sumCoveredRefundCreditNoteCents.mockResolvedValue(10500);
      await expect(enqueueXeroRefundCreditNoteOperation("payment_1", 2500, { reviewTaskId: "task_1" })).resolves.toMatchObject({
        queueOperationId: null,
      });
      expect(mocks.startXeroSyncOperation).not.toHaveBeenCalled();
    });
  });
});

describe("enqueueXeroAccountCreditNoteOperation", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.findFirstLink.mockResolvedValue(null);
    mocks.findUniquePayment.mockResolvedValue({
      id: "payment_1",
    });
    mocks.findFirstOperation.mockResolvedValue(null);
    mocks.startXeroSyncOperation.mockResolvedValue({ id: "op_account_credit_1" });
  });

  it("creates a pending primary Xero sync operation for account-credit notes", async () => {
    await expect(
      enqueueXeroAccountCreditNoteOperation("payment_1", 4200, {
        createdByMemberId: "admin_1",
      })
    ).resolves.toEqual({
      queueOperationId: "op_account_credit_1",
      message: "Xero account-credit note queued for background processing.",
    });

    expect(mocks.startXeroSyncOperation).toHaveBeenCalledWith(
      expect.objectContaining({
        direction: "OUTBOUND",
        entityType: "CREDIT_NOTE",
        operationType: "CREATE",
        localModel: "Payment",
        localId: "payment_1",
        status: "PENDING",
        idempotencyKey: "payment:payment_1:unapplied-credit-note:4200:v1",
        correlationKey: "payment:payment_1:unapplied-credit-note:4200:v1",
        createdByMemberId: "admin_1",
        requestPayload: {
          queueType: "ACCOUNT_CREDIT_NOTE",
          refundAmountCents: 4200,
        },
      })
    );
  });

  it("skips queueing when the account-credit note is already linked", async () => {
    mocks.findFirstLink.mockResolvedValue({ id: "link_account_credit_1" });

    await expect(
      enqueueXeroAccountCreditNoteOperation("payment_1", 4200)
    ).resolves.toEqual({
      queueOperationId: null,
      message: "Xero account-credit note already linked for this payment.",
    });

    expect(mocks.startXeroSyncOperation).not.toHaveBeenCalled();
  });

  it("reads and enqueues through the supplied transaction store, leaving the global prisma client untouched", async () => {
    // Fresh store fns distinct from the global prisma mock so the assertions
    // below actually prove the store — not the global client — was used.
    const storePaymentFindUnique = vi.fn().mockResolvedValue({ id: "payment_1" });
    const storeLinkFindFirst = vi.fn().mockResolvedValue(null);
    const storeOperationFindFirst = vi.fn().mockResolvedValue(null);
    const store = {
      payment: { findUnique: storePaymentFindUnique },
      xeroObjectLink: { findFirst: storeLinkFindFirst },
      xeroSyncOperation: { findFirst: storeOperationFindFirst },
    } as unknown as Prisma.TransactionClient;

    await expect(
      enqueueXeroAccountCreditNoteOperation("payment_1", 4200, { store })
    ).resolves.toEqual({
      queueOperationId: "op_account_credit_1",
      message: "Xero account-credit note queued for background processing.",
    });

    // Every read went through the store.
    expect(storePaymentFindUnique).toHaveBeenCalledTimes(1);
    expect(storeLinkFindFirst).toHaveBeenCalledTimes(1);
    expect(storeOperationFindFirst).toHaveBeenCalledTimes(1);
    // The global prisma client was never touched.
    expect(mocks.findUniquePayment).not.toHaveBeenCalled();
    expect(mocks.findFirstLink).not.toHaveBeenCalled();
    expect(mocks.findFirstOperation).not.toHaveBeenCalled();
    // The store is threaded into the operation writer so the row commits in-tx.
    expect(mocks.startXeroSyncOperation).toHaveBeenCalledWith(
      expect.objectContaining({
        entityType: "CREDIT_NOTE",
        operationType: "CREATE",
        localModel: "Payment",
        localId: "payment_1",
        store,
      })
    );
  });

  it("dedups on an existing queued operation read through the supplied store", async () => {
    const storePaymentFindUnique = vi.fn().mockResolvedValue({ id: "payment_1" });
    const storeLinkFindFirst = vi.fn().mockResolvedValue(null);
    const storeOperationFindFirst = vi
      .fn()
      .mockResolvedValue({ id: "existing_queued_op" });
    const store = {
      payment: { findUnique: storePaymentFindUnique },
      xeroObjectLink: { findFirst: storeLinkFindFirst },
      xeroSyncOperation: { findFirst: storeOperationFindFirst },
    } as unknown as Prisma.TransactionClient;

    await expect(
      enqueueXeroAccountCreditNoteOperation("payment_1", 4200, { store })
    ).resolves.toEqual({
      queueOperationId: "existing_queued_op",
      message: "Xero account-credit note is already queued for background processing.",
    });

    expect(storeOperationFindFirst).toHaveBeenCalledTimes(1);
    expect(mocks.startXeroSyncOperation).not.toHaveBeenCalled();
    expect(mocks.findFirstOperation).not.toHaveBeenCalled();
  });
});

describe("enqueueXeroModificationCreditNoteOperation", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.findFirstLink.mockResolvedValue(null);
    mocks.findUniqueBooking.mockResolvedValue({
      id: "booking_1",
      payment: {
        xeroInvoiceId: "inv_existing",
      },
    });
    mocks.findFirstOperation.mockResolvedValue(null);
    mocks.startXeroSyncOperation.mockResolvedValue({ id: "op_mod_credit_note_1" });
  });

  it("creates a pending Xero sync operation for modification credit notes", async () => {
    await expect(
      enqueueXeroModificationCreditNoteOperation(
        {
          bookingId: "booking_1",
          refundAmountCents: 3200,
          bookingModificationId: "mod_1",
        },
        {
          createdByMemberId: "admin_1",
        }
      )
    ).resolves.toEqual({
      queueOperationId: "op_mod_credit_note_1",
      message: "Xero modification credit note queued for background processing.",
    });

    expect(mocks.startXeroSyncOperation).toHaveBeenCalledWith(
      expect.objectContaining({
        direction: "OUTBOUND",
        entityType: "CREDIT_NOTE",
        operationType: "CREATE",
        localModel: "BookingModification",
        localId: "mod_1",
        status: "PENDING",
        idempotencyKey: "booking-mod:mod_1:mod-credit-note:3200:v1",
        correlationKey: "booking-mod:mod_1:mod-credit-note:3200:v1",
        createdByMemberId: "admin_1",
        requestPayload: {
          queueType: "MODIFICATION_CREDIT_NOTE",
          bookingId: "booking_1",
          refundAmountCents: 3200,
          bookingModificationId: "mod_1",
        },
      })
    );
  });

  // #3535 (`INV-PAY-017`): the internet-banking hold-expiry release enqueues
  // this note inside its own transaction, anchored on the booking, told it
  // clears an invoice nobody paid.
  it("reads, dedupes and inserts through the supplied store for an unpaid-invoice clearing note", async () => {
    const storeBookingFindUnique = vi.fn().mockResolvedValue({
      id: "booking_1",
      payment: { xeroInvoiceId: "inv_existing" },
    });
    const storeLinkFindFirst = vi.fn().mockResolvedValue(null);
    const storeOperationFindFirst = vi.fn().mockResolvedValue(null);
    const store = {
      booking: { findUnique: storeBookingFindUnique },
      xeroObjectLink: { findFirst: storeLinkFindFirst },
      xeroSyncOperation: { findFirst: storeOperationFindFirst },
    } as unknown as Prisma.TransactionClient;

    await expect(
      enqueueXeroModificationCreditNoteOperation(
        { bookingId: "booking_1", refundAmountCents: 15000, clearsUnpaidInvoice: true },
        { store }
      )
    ).resolves.toEqual({
      queueOperationId: "op_mod_credit_note_1",
      message: "Xero modification credit note queued for background processing.",
    });

    expect(storeBookingFindUnique).toHaveBeenCalledTimes(1);
    expect(storeLinkFindFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          localModel: "Booking",
          localId: "booking_1",
          role: "MODIFICATION_CREDIT_NOTE",
          active: true,
        }),
      })
    );
    expect(storeOperationFindFirst).toHaveBeenCalledTimes(1);
    expect(mocks.findUniqueBooking).not.toHaveBeenCalled();
    expect(mocks.findFirstLink).not.toHaveBeenCalled();
    expect(mocks.findFirstOperation).not.toHaveBeenCalled();
    expect(mocks.startXeroSyncOperation).toHaveBeenCalledWith(
      expect.objectContaining({
        entityType: "CREDIT_NOTE",
        operationType: "CREATE",
        localModel: "Booking",
        localId: "booking_1",
        status: "PENDING",
        // The booking-anchored clearing key; the never-captured cancel path and
        // the repair tool's cancelled-open-invoice arm mint the same one when
        // they size the same booking alike (one helper, INV-PAY-017).
        idempotencyKey: "booking:booking_1:mod-credit-note:15000:v1",
        correlationKey: "booking:booking_1:mod-credit-note:15000:v1",
        requestPayload: {
          queueType: "MODIFICATION_CREDIT_NOTE",
          bookingId: "booking_1",
          refundAmountCents: 15000,
          bookingModificationId: null,
          clearsUnpaidInvoice: true,
        },
        store,
      })
    );
  });

  it("enqueues nothing new when the booking already holds a clearing note, read through the store", async () => {
    const store = {
      booking: {
        findUnique: vi.fn().mockResolvedValue({
          id: "booking_1",
          payment: { xeroInvoiceId: "inv_existing" },
        }),
      },
      xeroObjectLink: { findFirst: vi.fn().mockResolvedValue({ id: "link_1" }) },
      xeroSyncOperation: { findFirst: vi.fn() },
    } as unknown as Prisma.TransactionClient;

    await expect(
      enqueueXeroModificationCreditNoteOperation(
        { bookingId: "booking_1", refundAmountCents: 15000, clearsUnpaidInvoice: true },
        { store }
      )
    ).resolves.toEqual({
      queueOperationId: null,
      message: "Xero modification credit note already linked for this change.",
    });
    expect(mocks.startXeroSyncOperation).not.toHaveBeenCalled();
  });

  it("returns the queued operation instead of a second one when the same clearing note is already pending", async () => {
    const store = {
      booking: {
        findUnique: vi.fn().mockResolvedValue({
          id: "booking_1",
          payment: { xeroInvoiceId: "inv_existing" },
        }),
      },
      xeroObjectLink: { findFirst: vi.fn().mockResolvedValue(null) },
      xeroSyncOperation: {
        findFirst: vi.fn().mockResolvedValue({ id: "op_already_queued" }),
      },
    } as unknown as Prisma.TransactionClient;

    await expect(
      enqueueXeroModificationCreditNoteOperation(
        { bookingId: "booking_1", refundAmountCents: 15000, clearsUnpaidInvoice: true },
        { store }
      )
    ).resolves.toEqual({
      queueOperationId: "op_already_queued",
      message: "Xero modification credit note is already queued for background processing.",
    });
    expect(mocks.startXeroSyncOperation).not.toHaveBeenCalled();
  });
});

describe("enqueueXeroModificationAccountCreditNoteOperation", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.findFirstLink.mockResolvedValue(null);
    mocks.findUniqueBooking.mockResolvedValue({
      id: "booking_1",
      payment: {
        id: "payment_1",
      },
    });
    mocks.findFirstOperation.mockResolvedValue(null);
    mocks.startXeroSyncOperation.mockResolvedValue({ id: "op_mod_account_credit_1" });
  });

  it("creates a pending Xero sync operation for modification account-credit notes", async () => {
    await expect(
      enqueueXeroModificationAccountCreditNoteOperation(
        {
          bookingId: "booking_1",
          refundAmountCents: 3750,
          bookingModificationId: "mod_1",
        },
        {
          createdByMemberId: "admin_1",
        }
      )
    ).resolves.toEqual({
      queueOperationId: "op_mod_account_credit_1",
      message: "Xero modification account-credit note queued for background processing.",
    });

    expect(mocks.startXeroSyncOperation).toHaveBeenCalledWith(
      expect.objectContaining({
        direction: "OUTBOUND",
        entityType: "CREDIT_NOTE",
        operationType: "CREATE",
        localModel: "BookingModification",
        localId: "mod_1",
        status: "PENDING",
        idempotencyKey: "booking-mod:mod_1:mod-account-credit-note:3750:v1",
        correlationKey: "booking-mod:mod_1:mod-account-credit-note:3750:v1",
        createdByMemberId: "admin_1",
        requestPayload: {
          queueType: "MODIFICATION_ACCOUNT_CREDIT_NOTE",
          bookingId: "booking_1",
          paymentId: "payment_1",
          refundAmountCents: 3750,
          bookingModificationId: "mod_1",
        },
      })
    );
  });
});

describe("enqueueXeroCreditNoteAllocationOperation", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.findFirstLink.mockResolvedValue(null);
    mocks.findFirstOperation.mockResolvedValue(null);
    mocks.startXeroSyncOperation.mockResolvedValue({ id: "op_allocation_1" });
  });

  it("creates a pending Xero sync operation for credit-note allocations", async () => {
    await expect(
      enqueueXeroCreditNoteAllocationOperation(
        {
          localModel: "BookingModification",
          localId: "mod_1",
          creditNoteId: "cn_1",
          invoiceId: "inv_1",
          amountCents: 3200,
          role: "MODIFICATION_CREDIT_NOTE_ALLOCATION",
        },
        {
          createdByMemberId: "admin_1",
        }
      )
    ).resolves.toEqual({
      queueOperationId: "op_allocation_1",
      message: "Xero credit-note allocation queued for background processing.",
    });

    expect(mocks.startXeroSyncOperation).toHaveBeenCalledWith(
      expect.objectContaining({
        direction: "OUTBOUND",
        entityType: "ALLOCATION",
        operationType: "ALLOCATE",
        localModel: "BookingModification",
        localId: "mod_1",
        status: "PENDING",
        idempotencyKey:
          "credit-note:cn_1:invoice:inv_1:allocation:3200:MODIFICATION_CREDIT_NOTE_ALLOCATION:v1",
        correlationKey:
          "credit-note:cn_1:invoice:inv_1:allocation:3200:MODIFICATION_CREDIT_NOTE_ALLOCATION:v1",
        createdByMemberId: "admin_1",
        requestPayload: {
          queueType: "CREDIT_NOTE_ALLOCATION",
          creditNoteId: "cn_1",
          invoiceId: "inv_1",
          amountCents: 3200,
          role: "MODIFICATION_CREDIT_NOTE_ALLOCATION",
        },
      })
    );
  });
});

describe("membership cancellation Xero enqueue operations", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.findFirstLink.mockResolvedValue(null);
    mocks.findFirstOperation.mockResolvedValue(null);
    mocks.startXeroSyncOperation.mockResolvedValue({ id: "op_cancel_1" });
  });

  it("queues credit notes for unpaid current-season membership subscriptions", async () => {
    mocks.findUniqueMemberSubscription.mockResolvedValue({
      id: "sub_1",
      status: "UNPAID",
      xeroInvoiceId: "inv_sub_1",
    });

    await expect(
      enqueueXeroMembershipCancellationCreditNoteOperation(
        {
          subscriptionId: "sub_1",
          requestId: "request_1",
          participantId: "participant_1",
        },
        { createdByMemberId: "admin_1" }
      )
    ).resolves.toEqual({
      queueOperationId: "op_cancel_1",
      message: "Xero membership cancellation credit note queued for background processing.",
    });

    expect(mocks.startXeroSyncOperation).toHaveBeenCalledWith(
      expect.objectContaining({
        direction: "OUTBOUND",
        entityType: "CREDIT_NOTE",
        operationType: "CREATE",
        localModel: "MemberSubscription",
        localId: "sub_1",
        status: "PENDING",
        idempotencyKey:
          "member-subscription:sub_1:membership-cancellation-credit:participant_1:v1",
        correlationKey:
          "member-subscription:sub_1:membership-cancellation-credit:participant_1:v1",
        createdByMemberId: "admin_1",
        requestPayload: {
          queueType: "MEMBERSHIP_CANCELLATION_CREDIT_NOTE",
          subscriptionId: "sub_1",
          requestId: "request_1",
          participantId: "participant_1",
        },
      })
    );
  });

  it("does not queue membership cancellation credit notes for paid subscriptions", async () => {
    mocks.findUniqueMemberSubscription.mockResolvedValue({
      id: "sub_1",
      status: "PAID",
      xeroInvoiceId: "inv_sub_1",
    });

    await expect(
      enqueueXeroMembershipCancellationCreditNoteOperation({
        subscriptionId: "sub_1",
        requestId: "request_1",
        participantId: "participant_1",
      })
    ).resolves.toEqual({
      queueOperationId: null,
      message: "No Xero membership cancellation credit note is required for this subscription status.",
    });

    expect(mocks.startXeroSyncOperation).not.toHaveBeenCalled();
  });

  it("queues contact cleanup when the cancelling member has a Xero contact", async () => {
    mocks.findUniqueMember.mockResolvedValue({
      id: "member_1",
      xeroContactId: "contact_1",
    });

    await expect(
      enqueueXeroMembershipCancellationContactOperation(
        {
          memberId: "member_1",
          requestId: "request_1",
          participantId: "participant_1",
        },
        { createdByMemberId: "admin_1" }
      )
    ).resolves.toEqual({
      queueOperationId: "op_cancel_1",
      message: "Xero membership cancellation contact cleanup queued for background processing.",
    });

    expect(mocks.startXeroSyncOperation).toHaveBeenCalledWith(
      expect.objectContaining({
        direction: "OUTBOUND",
        entityType: "CONTACT",
        operationType: "UPDATE",
        localModel: "MembershipCancellationRequestParticipant",
        localId: "participant_1",
        status: "PENDING",
        idempotencyKey:
          "membership-cancellation:participant_1:contact:member_1:v1",
        correlationKey:
          "membership-cancellation:participant_1:contact:member_1:v1",
        createdByMemberId: "admin_1",
        requestPayload: {
          queueType: "MEMBERSHIP_CANCELLATION_CONTACT",
          memberId: "member_1",
          requestId: "request_1",
          participantId: "participant_1",
        },
      })
    );
  });
});

describe("processQueuedXeroOutboxOperations", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.updateManyOperation.mockResolvedValue({ count: 1 });
  });

  it("scans the pending outbox by the indexed queueType column, not a requestPayload JSON predicate (#1272)", async () => {
    mocks.findManyOperations.mockResolvedValue([]);

    await processQueuedXeroOutboxOperations({ limit: 7 });

    expect(mocks.findManyOperations).toHaveBeenCalledTimes(1);
    const args = mocks.findManyOperations.mock.calls[0][0];
    // The scan now filters on the denormalized `queueType` column via the
    // single-source-of-truth list, keeping status/direction/order/limit intact.
    expect(args.where).toEqual({
      status: "PENDING",
      direction: "OUTBOUND",
      queueType: { in: [...XERO_OUTBOX_QUEUE_TYPES] },
    });
    expect(args.where.queueType.in).toHaveLength(17);
    // The legacy `requestPayload->>'queueType'` OR predicate is gone.
    expect(args.where.OR).toBeUndefined();
    expect(JSON.stringify(args.where)).not.toContain("requestPayload");
    expect(args.orderBy).toEqual({ createdAt: "asc" });
    expect(args.take).toBe(7);
  });

  it("closes CANCELLED, with no Xero call, a copy queued before an officer resolved the same document (#3635 N3)", async () => {
    const queuedAt = new Date("2026-06-10T00:00:00.000Z");
    mocks.findManyOperations.mockResolvedValue([
      {
        id: "op_stale_copy",
        localId: "payment_1",
        localModel: "Payment",
        entityType: "CREDIT_NOTE",
        operationType: "CREATE",
        correlationKey: "payment:payment_1:refund-credit-note:5000:v2",
        createdAt: queuedAt,
        createdByMemberId: null,
        requestPayload: { queueType: "REFUND_CREDIT_NOTE", refundAmountCents: 5000, watermarkCents: 5000 },
      },
    ]);
    mocks.findFirstOperation.mockImplementation(async (args: { where: Record<string, unknown> }) =>
      args.where.manuallyResolvedAt
        ? { id: "op_resolved_sibling", manuallyResolvedAt: new Date("2026-06-11T00:00:00.000Z") }
        : null
    );

    const result = await processQueuedXeroOutboxOperations({ limit: 1 });

    expect(result).toMatchObject({ processed: 1, skipped: 1, succeeded: 0, failed: 0 });
    expect(mocks.createXeroCreditNote).not.toHaveBeenCalled();
    expect(mocks.findFirstOperation).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          id: { not: "op_stale_copy" },
          correlationKey: "payment:payment_1:refund-credit-note:5000:v2",
          manuallyResolvedAt: { gt: queuedAt },
        }),
      })
    );
    expect(mocks.completeXeroSyncOperation).toHaveBeenCalledWith(
      "op_stale_copy",
      expect.objectContaining({
        status: "CANCELLED",
        responsePayload: expect.objectContaining({ resolvedOperationId: "op_resolved_sibling" }),
      })
    );
    mocks.findFirstOperation.mockReset();
  });

  it("returns a simultaneous applied-credit loser to PENDING instead of stranding it FAILED", async () => {
    mocks.findManyOperations.mockResolvedValue([
      {
        id: "op_alloc_busy",
        localId: "payment_1",
        localModel: "Payment",
        createdByMemberId: null,
        requestPayload: {
          queueType: "APPLIED_CREDIT_ALLOCATION",
          bookingId: "booking_1",
        },
      },
      {
        id: "op_dealloc_busy",
        localId: "payment_1",
        localModel: "Payment",
        createdByMemberId: null,
        requestPayload: {
          queueType: "APPLIED_CREDIT_DEALLOCATION",
          bookingId: "booking_1",
        },
      },
    ]);
    mocks.deallocateExcessAppliedCreditForBooking.mockRejectedValue(
      new XeroAppliedCreditOperationBusyError("allocation op is already running")
    );
    mocks.allocateAppliedCreditForBooking.mockRejectedValue(
      new XeroAppliedCreditOperationBusyError("deallocation op is already running")
    );

    await expect(processQueuedXeroOutboxOperations({ limit: 5 })).resolves.toEqual({
      found: 2,
      processed: 2,
      succeeded: 0,
      failed: 0,
      skipped: 2,
    });

    for (const id of ["op_alloc_busy", "op_dealloc_busy"]) {
      expect(mocks.updateManyOperation).toHaveBeenCalledWith({
        where: { id, status: "RUNNING" },
        data: {
          status: "PENDING",
          startedAt: null,
          lastErrorCode: null,
          // #3791: the busy reason stays on the requeued row.
          lastErrorMessage: expect.stringMatching(/\S/),
        },
      });
    }
    expect(mocks.failXeroSyncOperation).not.toHaveBeenCalled();
  });

  it("busy-requeues a manual retry, then executes its checkpointed deallocation once", async () => {
    const queued = {
      id: "op_dealloc_retry",
      localId: "payment_1",
      localModel: "Payment",
      createdByMemberId: null,
      requestPayload: {
        queueType: "APPLIED_CREDIT_DEALLOCATION",
        bookingId: "booking_1",
        checkpoint: { allocationIds: ["alloc-1"], phase: "BEFORE_DELETE" },
      },
    };
    mocks.findManyOperations.mockResolvedValue([queued]);
    mocks.deallocateExcessAppliedCreditForBooking
      .mockRejectedValueOnce(
        new XeroAppliedCreditOperationBusyError(
          "same-payment allocation is RUNNING",
        ),
      )
      .mockResolvedValueOnce(undefined);

    await expect(processQueuedXeroOutboxOperations({ limit: 1 })).resolves.toEqual({
      found: 1,
      processed: 1,
      succeeded: 0,
      failed: 0,
      skipped: 1,
    });
    expect(mocks.updateManyOperation).toHaveBeenCalledWith({
      where: { id: "op_dealloc_retry", status: "RUNNING" },
      data: {
        status: "PENDING",
        startedAt: null,
        lastErrorCode: null,
        lastErrorMessage: expect.stringMatching(/\S/),
      },
    });

    await expect(processQueuedXeroOutboxOperations({ limit: 1 })).resolves.toEqual({
      found: 1,
      processed: 1,
      succeeded: 1,
      failed: 0,
      skipped: 0,
    });
    expect(mocks.deallocateExcessAppliedCreditForBooking).toHaveBeenCalledTimes(2);
    expect(mocks.deallocateExcessAppliedCreditForBooking).toHaveBeenLastCalledWith(
      "booking_1",
      { syncOperationId: "op_dealloc_retry" },
    );
    expect(mocks.failXeroSyncOperation).not.toHaveBeenCalled();
  });

  it("claims and processes queued entrance fee operations", async () => {
    mocks.findManyOperations.mockResolvedValue([
      {
        id: "op_entrance_1",
        localId: "member_1",
        createdByMemberId: "admin_1",
        requestPayload: {
          queueType: "ENTRANCE_FEE_INVOICE",
          category: "ADULT",
          itemCode: "EF-ADULT",
          feeAmountCents: 15000,
        },
      },
    ]);
    mocks.createXeroEntranceFeeInvoice.mockResolvedValue("inv_1");

    await expect(processQueuedXeroOutboxOperations({ limit: 5 })).resolves.toEqual({
      found: 1,
      processed: 1,
      succeeded: 1,
      failed: 0,
      skipped: 0,
    });

    expect(mocks.createXeroEntranceFeeInvoice).toHaveBeenCalledWith("member_1", {
      createdByMemberId: "admin_1",
      syncOperationId: "op_entrance_1",
      precomputedEntranceFee: {
        category: "ADULT",
        feeMapping: {
          itemCode: "EF-ADULT",
          amountCents: 15000,
        },
      },
    });
  });

  it("claims and processes queued booking invoice operations", async () => {
    mocks.findManyOperations.mockResolvedValue([
      {
        id: "op_booking_1",
        localId: "payment_1",
        localModel: "Payment",
        createdByMemberId: "admin_1",
        requestPayload: {
          queueType: "BOOKING_INVOICE",
          bookingId: "booking_1",
        },
      },
    ]);
    mocks.createXeroInvoiceForBooking.mockResolvedValue("inv_1");

    await expect(processQueuedXeroOutboxOperations({ limit: 5 })).resolves.toEqual({
      found: 1,
      processed: 1,
      succeeded: 1,
      failed: 0,
      skipped: 0,
    });

    expect(mocks.createXeroInvoiceForBooking).toHaveBeenCalledWith("booking_1", {
      createdByMemberId: "admin_1",
      syncOperationId: "op_booking_1",
    });
  });

  it("claims and processes queued group settlement invoice operations", async () => {
    mocks.findManyOperations.mockResolvedValue([
      {
        id: "op_settle_1",
        localId: "settle_1",
        localModel: "GroupBookingSettlement",
        createdByMemberId: "admin_1",
        requestPayload: {
          queueType: "GROUP_SETTLEMENT_INVOICE",
          settlementId: "settle_1",
        },
      },
    ]);
    mocks.createXeroInvoiceForGroupSettlement.mockResolvedValue("xinv_1");

    await expect(processQueuedXeroOutboxOperations({ limit: 5 })).resolves.toEqual({
      found: 1,
      processed: 1,
      succeeded: 1,
      failed: 0,
      skipped: 0,
    });

    expect(mocks.createXeroInvoiceForGroupSettlement).toHaveBeenCalledWith(
      "settle_1",
      {
        createdByMemberId: "admin_1",
        syncOperationId: "op_settle_1",
      }
    );
  });

  it("claims and processes queued booking invoice update operations", async () => {
    mocks.findManyOperations.mockResolvedValue([
      {
        id: "op_booking_update_1",
        localId: "payment_1",
        localModel: "Payment",
        createdByMemberId: "admin_1",
        requestPayload: {
          queueType: "BOOKING_INVOICE_UPDATE",
          bookingId: "booking_1",
          xeroInvoiceId: "inv_existing",
        },
      },
    ]);
    mocks.updateXeroBookingInvoiceForBooking.mockResolvedValue("inv_existing");

    await expect(processQueuedXeroOutboxOperations({ limit: 5 })).resolves.toEqual({
      found: 1,
      processed: 1,
      succeeded: 1,
      failed: 0,
      skipped: 0,
    });

    expect(mocks.updateXeroBookingInvoiceForBooking).toHaveBeenCalledWith("booking_1", {
      createdByMemberId: "admin_1",
      syncOperationId: "op_booking_update_1",
    });
    expect(mocks.updateManyOperation).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          entityType: "INVOICE",
          operationType: "UPDATE",
        }),
      })
    );
  });

  it("claims and processes queued refund credit note operations, forwarding the watermark", async () => {
    mocks.findManyOperations.mockResolvedValue([
      {
        id: "op_credit_note_1",
        localId: "payment_1",
        localModel: "Payment",
        createdByMemberId: "admin_1",
        requestPayload: {
          queueType: "REFUND_CREDIT_NOTE",
          refundAmountCents: 3000,
          watermarkCents: 8000,
        },
      },
    ]);
    mocks.createXeroCreditNote.mockResolvedValue("cn_1");

    await expect(processQueuedXeroOutboxOperations({ limit: 5 })).resolves.toEqual({
      found: 1,
      processed: 1,
      succeeded: 1,
      failed: 0,
      skipped: 0,
    });

    expect(mocks.createXeroCreditNote).toHaveBeenCalledWith("payment_1", 3000, {
      createdByMemberId: "admin_1",
      syncOperationId: "op_credit_note_1",
      watermarkCents: 8000,
    });
  });

  // #3827 (D-3813-8): a refund request's own note reaches the builder as that
  // request's note - no watermark, the request id forwarded.
  it("dispatches a refund request's own note with its request id and no watermark", async () => {
    mocks.findManyOperations.mockResolvedValue([
      {
        id: "op_request_note_1",
        localId: "payment_1",
        localModel: "Payment",
        createdByMemberId: "admin_1",
        requestPayload: {
          queueType: "REFUND_CREDIT_NOTE",
          refundAmountCents: 4000,
          refundMethod: "internet-banking",
          refundRequestId: "req_1",
        },
      },
    ]);
    mocks.createXeroCreditNote.mockResolvedValue("cn_req_1");

    await processQueuedXeroOutboxOperations({ limit: 5 });

    expect(mocks.createXeroCreditNote).toHaveBeenCalledWith("payment_1", 4000, {
      createdByMemberId: "admin_1",
      syncOperationId: "op_request_note_1",
      watermarkCents: undefined,
      refundMethod: "internet-banking",
      refundRequestId: "req_1",
    });
  });

  it("MUTATION (#3880): a refund-note row whose payment has another note mid-raise goes back to PENDING, reason kept, never FAILED", async () => {
    mocks.findManyOperations.mockResolvedValue([
      {
        id: "op_hand_back_2",
        localId: "payment_1",
        localModel: "Payment",
        createdByMemberId: null,
        requestPayload: { queueType: "REFUND_CREDIT_NOTE", refundAmountCents: 1000, watermarkCents: 1000, refundMethod: "internet-banking" },
      },
    ]);
    mocks.createXeroCreditNote.mockRejectedValue(new XeroRefundCreditNoteInFlightError("payment_1", "op_hand_back_1"));

    await expect(processQueuedXeroOutboxOperations({ limit: 5 })).resolves.toEqual({
      found: 1,
      processed: 1,
      succeeded: 0,
      failed: 0,
      skipped: 1,
    });
    expect(mocks.updateManyOperation).toHaveBeenCalledWith({
      where: { id: "op_hand_back_2", status: "RUNNING" },
      data: { status: "PENDING", startedAt: null, lastErrorCode: null, lastErrorMessage: expect.stringContaining("op_hand_back_1") },
    });
    expect(mocks.failXeroSyncOperation).not.toHaveBeenCalled();
  });

  // #3548 (`INV-PAY-111`): the outbox's half of the crash-window contract. A
  // refund-note handler that dies after raising its note leaves the row
  // FAILED, never PENDING, so no second dispatch re-enters the builder; the
  // retry leg finishes the note the row names
  // (xero-refund-note-crash-window.test.ts drives both halves for real).
  it("fails, and never re-queues, a refund-note row whose handler dies after raising its note", async () => {
    mocks.findManyOperations.mockResolvedValue([
      {
        id: "op_credit_note_1",
        localId: "payment_1",
        localModel: "Payment",
        createdByMemberId: null,
        requestPayload: {
          queueType: "REFUND_CREDIT_NOTE",
          refundAmountCents: 5000,
          watermarkCents: 5000,
          refundMethod: "card",
        },
      },
    ]);
    const crash = new Error("process died after the note was recorded");
    mocks.createXeroCreditNote.mockRejectedValue(crash);

    await expect(processQueuedXeroOutboxOperations({ limit: 5 })).resolves.toEqual(
      expect.objectContaining({ processed: 1, succeeded: 0, failed: 1 })
    );

    expect(mocks.createXeroCreditNote).toHaveBeenCalledTimes(1);
    expect(mocks.createXeroCreditNote).toHaveBeenCalledWith("payment_1", 5000, {
      syncOperationId: "op_credit_note_1",
      watermarkCents: 5000,
      refundMethod: "card",
    });
    expect(mocks.failXeroSyncOperation).toHaveBeenCalledWith(
      "op_credit_note_1",
      crash,
      undefined,
      { keepCancelled: true }
    );
    // The un-claim back to PENDING is only for a refusal before any HTTP call.
    expect(mocks.updateManyOperation).not.toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ status: "PENDING" }) })
    );
  });

  it("claims and processes queued account-credit note operations", async () => {
    mocks.findManyOperations.mockResolvedValue([
      {
        id: "op_account_credit_1",
        localId: "payment_1",
        localModel: "Payment",
        createdByMemberId: "admin_1",
        requestPayload: {
          queueType: "ACCOUNT_CREDIT_NOTE",
          refundAmountCents: 4200,
        },
      },
    ]);
    mocks.createUnappliedXeroCreditNote.mockResolvedValue("cn_account_1");

    await expect(processQueuedXeroOutboxOperations({ limit: 5 })).resolves.toEqual({
      found: 1,
      processed: 1,
      succeeded: 1,
      failed: 0,
      skipped: 0,
    });

    expect(mocks.createUnappliedXeroCreditNote).toHaveBeenCalledWith("payment_1", 4200, CLUB_FORMAT_TEST, {
      createdByMemberId: "admin_1",
      syncOperationId: "op_account_credit_1",
    });
  });

  it("claims and processes queued supplementary invoice operations", async () => {
    mocks.findManyOperations.mockResolvedValue([
      {
        id: "op_supplementary_1",
        localId: "mod_1",
        localModel: "BookingModification",
        createdByMemberId: "admin_1",
        requestPayload: {
          queueType: "SUPPLEMENTARY_INVOICE",
          bookingId: "booking_1",
          priceDiffCents: 2500,
          changeFeeCents: 500,
          bookingModificationId: "mod_1",
        },
      },
    ]);
    mocks.createXeroSupplementaryInvoice.mockResolvedValue("inv_2");

    await expect(processQueuedXeroOutboxOperations({ limit: 5 })).resolves.toEqual({
      found: 1,
      processed: 1,
      succeeded: 1,
      failed: 0,
      skipped: 0,
    });

    expect(mocks.createXeroSupplementaryInvoice).toHaveBeenCalledWith({
      bookingId: "booking_1",
      priceDiffCents: 2500,
      changeFeeCents: 500,
      bookingModificationId: "mod_1",
      recordPayment: true,
      // #3193: undefined on the ordinary path. The handler branches on it, so
      // "absent" has to reach it as absent.
      shortfallReviewTaskId: undefined,
      createdByMemberId: "admin_1",
      syncOperationId: "op_supplementary_1",
      format: CLUB_FORMAT_TEST,
    });
  });

  /**
   * #3193: a SECOND ASK row reaches the handler with its anchor intact.
   *
   * Two ways this fails and both are silent. Dropping the marker sends the
   * handler down the ordinary path, which writes the invoice's link onto the
   * booking change and keys the create the way the change's own invoice is keyed
   * - so Xero answers with the invoice already sent and the difference is never
   * billed. And the row is anchored on `ManualRefundTask`, so the claim guard
   * has to accept that model or the operation is skipped on every pass forever.
   */
  it("claims and processes a second-ask supplementary invoice (#3193)", async () => {
    mocks.findManyOperations.mockResolvedValue([
      {
        id: "op_second_ask_1",
        localId: "task_2",
        localModel: "ManualRefundTask",
        createdByMemberId: "admin_1",
        requestPayload: {
          queueType: "SUPPLEMENTARY_INVOICE",
          bookingId: "booking_1",
          priceDiffCents: 3000,
          changeFeeCents: 0,
          bookingModificationId: "mod_1",
          recordPayment: false,
          shortfallReviewTaskId: "task_2",
        },
      },
    ]);
    mocks.createXeroSupplementaryInvoice.mockResolvedValue("inv_second");

    await expect(processQueuedXeroOutboxOperations({ limit: 5 })).resolves.toEqual({
      found: 1,
      processed: 1,
      succeeded: 1,
      failed: 0,
      skipped: 0,
    });

    expect(mocks.createXeroSupplementaryInvoice).toHaveBeenCalledWith({
      bookingId: "booking_1",
      priceDiffCents: 3000,
      changeFeeCents: 0,
      bookingModificationId: "mod_1",
      recordPayment: false,
      shortfallReviewTaskId: "task_2",
      createdByMemberId: "admin_1",
      syncOperationId: "op_second_ask_1",
      format: CLUB_FORMAT_TEST,
    });
  });

  it("claims and processes queued modification credit note operations", async () => {
    mocks.findManyOperations.mockResolvedValue([
      {
        id: "op_mod_credit_note_1",
        localId: "mod_1",
        localModel: "BookingModification",
        createdByMemberId: "admin_1",
        requestPayload: {
          queueType: "MODIFICATION_CREDIT_NOTE",
          bookingId: "booking_1",
          refundAmountCents: 3200,
          bookingModificationId: "mod_1",
        },
      },
    ]);
    mocks.createXeroCreditNoteForModification.mockResolvedValue("cn_2");

    await expect(processQueuedXeroOutboxOperations({ limit: 5 })).resolves.toEqual({
      found: 1,
      processed: 1,
      succeeded: 1,
      failed: 0,
      skipped: 0,
    });

    expect(mocks.createXeroCreditNoteForModification).toHaveBeenCalledWith({
      bookingId: "booking_1",
      refundAmountCents: 3200,
      bookingModificationId: "mod_1",
      createdByMemberId: "admin_1",
      syncOperationId: "op_mod_credit_note_1",
      format: CLUB_FORMAT_TEST,
    });
  });

  it("hands a queued unpaid-invoice clearing note to the builder as one (#3535)", async () => {
    mocks.findManyOperations.mockResolvedValue([
      {
        id: "op_clearing_1",
        localId: "booking_1",
        localModel: "Booking",
        createdByMemberId: null,
        requestPayload: {
          queueType: "MODIFICATION_CREDIT_NOTE",
          bookingId: "booking_1",
          refundAmountCents: 15000,
          bookingModificationId: null,
          clearsUnpaidInvoice: true,
        },
      },
    ]);
    mocks.createXeroCreditNoteForModification.mockResolvedValue("cn_clear");

    await expect(processQueuedXeroOutboxOperations({ limit: 5 })).resolves.toEqual(
      expect.objectContaining({ processed: 1, succeeded: 1, failed: 0 })
    );

    const [params] = mocks.createXeroCreditNoteForModification.mock.calls[0]!;
    expect(params).toEqual(
      expect.objectContaining({
        bookingId: "booking_1",
        refundAmountCents: 15000,
        clearsUnpaidInvoice: true,
        syncOperationId: "op_clearing_1",
      })
    );
    expect(params).not.toHaveProperty("refundMethod");
  });

  it("claims and processes queued credit-note allocation operations", async () => {
    mocks.findManyOperations.mockResolvedValue([
      {
        id: "op_allocation_1",
        localId: "mod_1",
        localModel: "BookingModification",
        createdByMemberId: "admin_1",
        requestPayload: {
          queueType: "CREDIT_NOTE_ALLOCATION",
          creditNoteId: "cn_1",
          invoiceId: "inv_1",
          amountCents: 3200,
          role: "MODIFICATION_CREDIT_NOTE_ALLOCATION",
        },
      },
    ]);
    mocks.allocateCreditNoteToInvoice.mockResolvedValue(undefined);

    await expect(processQueuedXeroOutboxOperations({ limit: 5 })).resolves.toEqual({
      found: 1,
      processed: 1,
      succeeded: 1,
      failed: 0,
      skipped: 0,
    });

    expect(mocks.allocateCreditNoteToInvoice).toHaveBeenCalledWith(
      "cn_1",
      "inv_1",
      3200,
      {
        localModel: "BookingModification",
        localId: "mod_1",
        role: "MODIFICATION_CREDIT_NOTE_ALLOCATION",
        createdByMemberId: "admin_1",
        syncOperationId: "op_allocation_1",
      }
    );
  });

  it("claims and processes queued membership cancellation credit notes", async () => {
    mocks.findManyOperations.mockResolvedValue([
      {
        id: "op_membership_cancel_credit_1",
        localId: "sub_1",
        localModel: "MemberSubscription",
        createdByMemberId: "admin_1",
        requestPayload: {
          queueType: "MEMBERSHIP_CANCELLATION_CREDIT_NOTE",
          subscriptionId: "sub_1",
          requestId: "request_1",
          participantId: "participant_1",
        },
      },
    ]);
    mocks.createXeroMembershipCancellationCreditNote.mockResolvedValue("cn_sub_1");

    await expect(processQueuedXeroOutboxOperations({ limit: 5 })).resolves.toEqual({
      found: 1,
      processed: 1,
      succeeded: 1,
      failed: 0,
      skipped: 0,
    });

    expect(mocks.createXeroMembershipCancellationCreditNote).toHaveBeenCalledWith({
      subscriptionId: "sub_1",
      requestId: "request_1",
      participantId: "participant_1",
      createdByMemberId: "admin_1",
      syncOperationId: "op_membership_cancel_credit_1",
    });
    expect(mocks.updateManyOperation).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          entityType: "CREDIT_NOTE",
          operationType: "CREATE",
          localModel: { in: ["MemberSubscription"] },
        }),
      })
    );
  });

  it("claims and processes queued membership cancellation contact cleanup", async () => {
    mocks.findManyOperations.mockResolvedValue([
      {
        id: "op_membership_cancel_contact_1",
        localId: "participant_1",
        localModel: "MembershipCancellationRequestParticipant",
        createdByMemberId: "admin_1",
        requestPayload: {
          queueType: "MEMBERSHIP_CANCELLATION_CONTACT",
          memberId: "member_1",
          requestId: "request_1",
          participantId: "participant_1",
        },
      },
    ]);
    mocks.syncXeroMembershipCancellationContact.mockResolvedValue({
      memberId: "member_1",
      xeroContactId: "contact_1",
      addedGroupIds: ["cancelled_group"],
      removedGroupIds: ["adult_group"],
      archived: true,
      skippedReason: null,
    });

    await expect(processQueuedXeroOutboxOperations({ limit: 5 })).resolves.toEqual({
      found: 1,
      processed: 1,
      succeeded: 1,
      failed: 0,
      skipped: 0,
    });

    expect(mocks.syncXeroMembershipCancellationContact).toHaveBeenCalledWith({
      memberId: "member_1",
      requestId: "request_1",
      participantId: "participant_1",
      createdByMemberId: "admin_1",
      syncOperationId: "op_membership_cancel_contact_1",
    });
    expect(mocks.updateManyOperation).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          entityType: "CONTACT",
          operationType: "UPDATE",
          localModel: { in: ["MembershipCancellationRequestParticipant"] },
        }),
      })
    );
  });

  it("fails malformed queued payloads", async () => {
    mocks.findManyOperations.mockResolvedValue([
      {
        id: "op_entrance_1",
        localModel: "Member",
        localId: "member_1",
        createdByMemberId: "admin_1",
        requestPayload: {
          queueType: "ENTRANCE_FEE_INVOICE",
        },
      },
    ]);

    await expect(processQueuedXeroOutboxOperations()).resolves.toEqual({
      found: 1,
      processed: 1,
      succeeded: 0,
      failed: 1,
      skipped: 0,
    });

    expect(mocks.createXeroEntranceFeeInvoice).not.toHaveBeenCalled();
    expect(mocks.failXeroSyncOperation).toHaveBeenCalledWith(
      "op_entrance_1",
      expect.objectContaining({
        message: "Queued Xero outbox payload is incomplete.",
      }),
      undefined,
      // #3635 round-3 N5: a row withdrawn in the meantime stays CANCELLED.
      { keepCancelled: true }
    );
  });

  it("skips a row it loses the claim race for (updateMany matched zero PENDING rows)", async () => {
    // A concurrent worker already flipped the row out of PENDING, so the
    // conditional claim matches nothing. The single-flight must then skip the
    // row (never dispatch its money-moving handler) rather than double-run it.
    mocks.findManyOperations.mockResolvedValue([
      {
        id: "op_booking_1",
        localId: "payment_1",
        localModel: "Payment",
        createdByMemberId: "admin_1",
        requestPayload: {
          queueType: "BOOKING_INVOICE",
          bookingId: "booking_1",
        },
      },
    ]);
    mocks.updateManyOperation.mockResolvedValue({ count: 0 });

    await expect(processQueuedXeroOutboxOperations({ limit: 5 })).resolves.toEqual({
      found: 1,
      processed: 0,
      succeeded: 0,
      failed: 0,
      skipped: 1,
    });

    expect(mocks.createXeroInvoiceForBooking).not.toHaveBeenCalled();
  });
});

describe("processQueuedXeroOutboxOperations dispatch domain (#1272)", () => {
  // Directly exercises the real if/else dispatch chain inside
  // `processQueuedXeroOutboxOperations` (not the parallel expected-operation
  // map). Feeding a valid op per queue type and asserting it routes to a
  // handler proves the chain covers exactly `XERO_OUTBOX_QUEUE_TYPES` — closing
  // the gap PR-a's map-based proxy left open. Residual (accepted, per #1272): an
  // orphan dispatch branch for a queueType NOT in the constant is dead code the
  // column scan never surfaces, so a pure black-box test cannot observe it.
  type OutboxFixture = {
    op: {
      id: string;
      localId?: string | null;
      localModel?: string | null;
      createdByMemberId?: string | null;
      requestPayload: Record<string, unknown>;
    };
    handler: ReturnType<typeof vi.fn>;
  };

  const fixtures: Record<
    (typeof XERO_OUTBOX_QUEUE_TYPES)[number],
    OutboxFixture
  > = {
    ENTRANCE_FEE_INVOICE: {
      op: {
        id: "op_entrance_1",
        localId: "member_1",
        localModel: "Member",
        createdByMemberId: "admin_1",
        requestPayload: {
          queueType: "ENTRANCE_FEE_INVOICE",
          category: "ADULT",
          itemCode: "EF-ADULT",
          feeAmountCents: 15000,
        },
      },
      handler: mocks.createXeroEntranceFeeInvoice,
    },
    BOOKING_INVOICE: {
      op: {
        id: "op_booking_1",
        localId: "payment_1",
        localModel: "Payment",
        createdByMemberId: "admin_1",
        requestPayload: { queueType: "BOOKING_INVOICE", bookingId: "booking_1" },
      },
      handler: mocks.createXeroInvoiceForBooking,
    },
    BOOKING_INVOICE_UPDATE: {
      op: {
        id: "op_booking_update_1",
        localId: "payment_1",
        localModel: "Payment",
        createdByMemberId: "admin_1",
        requestPayload: {
          queueType: "BOOKING_INVOICE_UPDATE",
          bookingId: "booking_1",
          xeroInvoiceId: "inv_existing",
        },
      },
      handler: mocks.updateXeroBookingInvoiceForBooking,
    },
    REFUND_CREDIT_NOTE: {
      op: {
        id: "op_credit_note_1",
        localId: "payment_1",
        localModel: "Payment",
        createdByMemberId: "admin_1",
        requestPayload: {
          queueType: "REFUND_CREDIT_NOTE",
          refundAmountCents: 3000,
          watermarkCents: 8000,
        },
      },
      handler: mocks.createXeroCreditNote,
    },
    ACCOUNT_CREDIT_NOTE: {
      op: {
        id: "op_account_credit_1",
        localId: "payment_1",
        localModel: "Payment",
        createdByMemberId: "admin_1",
        requestPayload: {
          queueType: "ACCOUNT_CREDIT_NOTE",
          refundAmountCents: 4200,
        },
      },
      handler: mocks.createUnappliedXeroCreditNote,
    },
    SUPPLEMENTARY_INVOICE: {
      op: {
        id: "op_supplementary_1",
        localId: "mod_1",
        localModel: "BookingModification",
        createdByMemberId: "admin_1",
        requestPayload: {
          queueType: "SUPPLEMENTARY_INVOICE",
          bookingId: "booking_1",
          priceDiffCents: 2500,
          changeFeeCents: 500,
          bookingModificationId: "mod_1",
        },
      },
      handler: mocks.createXeroSupplementaryInvoice,
    },
    MODIFICATION_CREDIT_NOTE: {
      op: {
        id: "op_mod_credit_note_1",
        localId: "mod_1",
        localModel: "BookingModification",
        createdByMemberId: "admin_1",
        requestPayload: {
          queueType: "MODIFICATION_CREDIT_NOTE",
          bookingId: "booking_1",
          refundAmountCents: 3200,
          bookingModificationId: "mod_1",
        },
      },
      handler: mocks.createXeroCreditNoteForModification,
    },
    MODIFICATION_ACCOUNT_CREDIT_NOTE: {
      op: {
        id: "op_mod_account_credit_1",
        localId: "mod_1",
        localModel: "BookingModification",
        createdByMemberId: "admin_1",
        requestPayload: {
          queueType: "MODIFICATION_ACCOUNT_CREDIT_NOTE",
          bookingId: "booking_1",
          paymentId: "payment_1",
          refundAmountCents: 3750,
          bookingModificationId: "mod_1",
        },
      },
      handler: mocks.createUnappliedXeroCreditNoteForModification,
    },
    CREDIT_NOTE_ALLOCATION: {
      op: {
        id: "op_allocation_1",
        localId: "mod_1",
        localModel: "BookingModification",
        createdByMemberId: "admin_1",
        requestPayload: {
          queueType: "CREDIT_NOTE_ALLOCATION",
          creditNoteId: "cn_1",
          invoiceId: "inv_1",
          amountCents: 3200,
          role: "MODIFICATION_CREDIT_NOTE_ALLOCATION",
        },
      },
      handler: mocks.allocateCreditNoteToInvoice,
    },
    APPLIED_CREDIT_ALLOCATION: {
      op: {
        id: "op_applied_credit_alloc_1",
        localId: "payment_1",
        localModel: "Payment",
        createdByMemberId: "admin_1",
        requestPayload: {
          queueType: "APPLIED_CREDIT_ALLOCATION",
          bookingId: "booking_1",
        },
      },
      handler: mocks.allocateAppliedCreditForBooking,
    },
    APPLIED_CREDIT_DEALLOCATION: {
      op: {
        id: "op_applied_credit_dealloc_1",
        localId: "payment_1",
        localModel: "Payment",
        requestPayload: { queueType: "APPLIED_CREDIT_DEALLOCATION", bookingId: "booking_1" },
      },
      handler: mocks.deallocateExcessAppliedCreditForBooking,
    },
    MEMBERSHIP_CANCELLATION_CREDIT_NOTE: {
      op: {
        id: "op_membership_cancel_credit_1",
        localId: "sub_1",
        localModel: "MemberSubscription",
        createdByMemberId: "admin_1",
        requestPayload: {
          queueType: "MEMBERSHIP_CANCELLATION_CREDIT_NOTE",
          subscriptionId: "sub_1",
          requestId: "request_1",
          participantId: "participant_1",
        },
      },
      handler: mocks.createXeroMembershipCancellationCreditNote,
    },
    MEMBERSHIP_CANCELLATION_CONTACT: {
      op: {
        id: "op_membership_cancel_contact_1",
        localId: "participant_1",
        localModel: "MembershipCancellationRequestParticipant",
        createdByMemberId: "admin_1",
        requestPayload: {
          queueType: "MEMBERSHIP_CANCELLATION_CONTACT",
          memberId: "member_1",
          requestId: "request_1",
          participantId: "participant_1",
        },
      },
      handler: mocks.syncXeroMembershipCancellationContact,
    },
    GROUP_SETTLEMENT_INVOICE: {
      op: {
        id: "op_settle_1",
        localId: "settle_1",
        localModel: "GroupBookingSettlement",
        createdByMemberId: "admin_1",
        requestPayload: {
          queueType: "GROUP_SETTLEMENT_INVOICE",
          settlementId: "settle_1",
        },
      },
      handler: mocks.createXeroInvoiceForGroupSettlement,
    },
    GROUP_SETTLEMENT_INVOICE_VOID: {
      op: {
        id: "op_settle_void_1",
        localId: "settle_1",
        localModel: "GroupBookingSettlement",
        createdByMemberId: "admin_1",
        requestPayload: {
          queueType: "GROUP_SETTLEMENT_INVOICE_VOID",
          settlementId: "settle_1",
        },
      },
      handler: mocks.voidXeroInvoiceForCancelledGroupSettlement,
    },
    MEMBERSHIP_SUBSCRIPTION_INVOICE: {
      op: {
        id: "op_subscription_charge_1",
        localId: "charge_1",
        localModel: "MembershipSubscriptionCharge",
        createdByMemberId: "admin_1",
        // #3971: what the enqueue writes - no id; the charge is `localId`.
        requestPayload: {
          queueType: "MEMBERSHIP_SUBSCRIPTION_INVOICE",
        },
      },
      handler: mocks.createXeroMembershipSubscriptionInvoice,
    },
    // #3635: a late capture a treasurer kept, anchored on its approval task.
    KEPT_LATE_CAPTURE_INVOICE: {
      op: {
        id: "op_kept_late_capture_1",
        localId: "task_kept_1",
        localModel: "ManualRefundTask",
        createdByMemberId: "admin_1",
        requestPayload: {
          queueType: "KEPT_LATE_CAPTURE_INVOICE",
          bookingId: "booking_1",
          manualRefundTaskId: "task_kept_1",
          paymentIntentId: "pi_kept",
          capturedCents: 24000,
          capturedOn: "2026-06-10",
        },
      },
      handler: mocks.createXeroKeptLateCaptureInvoice,
    },
  };

  beforeEach(() => {
    vi.clearAllMocks();
    mocks.updateManyOperation.mockResolvedValue({ count: 1 });
    // Every dispatch target resolves so a routed op reports success.
    mocks.createXeroEntranceFeeInvoice.mockResolvedValue("inv");
    mocks.createXeroInvoiceForBooking.mockResolvedValue("inv");
    mocks.updateXeroBookingInvoiceForBooking.mockResolvedValue("inv");
    mocks.createXeroCreditNote.mockResolvedValue("cn");
    mocks.createUnappliedXeroCreditNote.mockResolvedValue("cn");
    mocks.createXeroSupplementaryInvoice.mockResolvedValue("inv");
    mocks.createXeroCreditNoteForModification.mockResolvedValue("cn");
    mocks.createUnappliedXeroCreditNoteForModification.mockResolvedValue("cn");
    mocks.allocateCreditNoteToInvoice.mockResolvedValue(undefined);
    mocks.allocateAppliedCreditForBooking.mockResolvedValue(undefined);
    mocks.deallocateExcessAppliedCreditForBooking.mockResolvedValue(undefined);
    mocks.createXeroMembershipCancellationCreditNote.mockResolvedValue("cn");
    mocks.syncXeroMembershipCancellationContact.mockResolvedValue({
      memberId: "member_1",
      xeroContactId: "contact_1",
      addedGroupIds: [],
      removedGroupIds: [],
      archived: true,
      skippedReason: null,
    });
    mocks.createXeroInvoiceForGroupSettlement.mockResolvedValue("inv");
    mocks.voidXeroInvoiceForCancelledGroupSettlement.mockResolvedValue(undefined);
    mocks.createXeroMembershipSubscriptionInvoice.mockResolvedValue("inv");
  });

  it("has one dispatch fixture for every queue type and no extras", () => {
    expect(Object.keys(fixtures).sort()).toEqual(
      [...XERO_OUTBOX_QUEUE_TYPES].sort()
    );
  });

  it("routes each XERO_OUTBOX_QUEUE_TYPES member through the real dispatch chain to its own handler", async () => {
    for (const queueType of XERO_OUTBOX_QUEUE_TYPES) {
      const fixture = fixtures[queueType];
      mocks.findManyOperations.mockResolvedValue([fixture.op]);

      const result = await processQueuedXeroOutboxOperations({ limit: 1 });

      // succeeded:1 means it reached a concrete handler; the else-branch throw
      // ("payload is incomplete") would have produced failed:1 instead.
      expect(result).toEqual({
        found: 1,
        processed: 1,
        succeeded: 1,
        failed: 0,
        skipped: 0,
      });
      // Each queue type has a distinct handler, so exactly-once across the loop
      // proves the chain routed this type to the right one.
      expect(fixture.handler).toHaveBeenCalledTimes(1);
    }

    // No queue type slipped through to the incomplete-payload failure.
    expect(mocks.failXeroSyncOperation).not.toHaveBeenCalled();
  });

  /**
   * #3971 GUARD (`INV-INT-026`): a queued payload is stored through the
   * persisting redactor (`sanitizeForJson` -> `redactSensitiveRecord`), and the
   * worker reads the STORED row, never the object it was queued with. A key the redactor blanks
   * therefore never reaches the worker: `chargeId` matched the Stripe `charge`
   * rule, and every membership subscription invoice failed looking for a charge
   * of id "[REDACTED]". For every queue type this runs the real sanitizer over
   * the fixture's payload and requires the worker to call its handler with
   * exactly what it gets from the unredacted payload.
   */
  it("resolves every queue type's target from its STORED (redacted) payload exactly as from the queued one (#3971)", async () => {
    const { sanitizeForJson } = await vi.importActual<typeof import("@/lib/xero-sync")>(
      "@/lib/xero-sync"
    );
    const handlerArgsFor = async (
      queueType: (typeof XERO_OUTBOX_QUEUE_TYPES)[number],
      requestPayload: unknown
    ) => {
      vi.clearAllMocks();
      const fixture = fixtures[queueType];
      mocks.findManyOperations.mockResolvedValue([{ ...fixture.op, requestPayload }]);
      await processQueuedXeroOutboxOperations({ limit: 1 });
      return fixture.handler.mock.calls;
    };

    for (const queueType of XERO_OUTBOX_QUEUE_TYPES) {
      const queued = fixtures[queueType].op.requestPayload;
      const stored = sanitizeForJson(queued);
      const fromQueued = await handlerArgsFor(queueType, queued);
      const fromStored = await handlerArgsFor(queueType, stored);

      expect(
        fromQueued,
        `INV-INT-026 (#3971): ${queueType} did not reach its handler from the payload it was queued with`
      ).toHaveLength(1);
      expect(
        fromStored,
        `INV-INT-026 (#3971): ${queueType}'s worker resolves a different target once its payload is stored through the persisting redactor. A load-bearing id is being blanked; take it from the row's localId or rename the key, never weaken the redactor.`
      ).toEqual(fromQueued);
      expect(
        JSON.stringify(fromStored),
        `INV-INT-026 (#3971): ${queueType}'s handler received a redacted value`
      ).not.toContain("[REDACTED]");
    }
  });

  it("invoices the row's localId for a subscription row stored before #3971 with a blanked chargeId", async () => {
    mocks.findManyOperations.mockResolvedValue([
      {
        ...fixtures.MEMBERSHIP_SUBSCRIPTION_INVOICE.op,
        requestPayload: { queueType: "MEMBERSHIP_SUBSCRIPTION_INVOICE", chargeId: "[REDACTED]" },
      },
    ]);

    await expect(processQueuedXeroOutboxOperations({ limit: 1 })).resolves.toMatchObject({
      succeeded: 1,
      failed: 0,
    });
    expect(mocks.createXeroMembershipSubscriptionInvoice).toHaveBeenCalledWith({
      chargeId: "charge_1",
      createdByMemberId: "admin_1",
      syncOperationId: "op_subscription_charge_1",
    });
  });

  // #3642 (SSOT F7): one queue type, two VOIDs. A payload that names its invoice
  // is the abandon VOID of a live group; one that does not is the cancellation
  // VOID, which reads the invoice off the settlement. Swapping the branches
  // would void a live group's CURRENT invoice, or refuse every abandon VOID.
  it("routes a VOID that names its invoice to the abandon handler, and one that does not to the cancellation handler", async () => {
    mocks.voidXeroInvoiceForAbandonedGroupSettlement.mockResolvedValue(undefined);
    mocks.findManyOperations.mockResolvedValue([
      {
        ...fixtures.GROUP_SETTLEMENT_INVOICE_VOID.op,
        id: "op_settle_abandon_1",
        requestPayload: {
          queueType: "GROUP_SETTLEMENT_INVOICE_VOID",
          settlementId: "settle_1",
          xeroInvoiceId: "inv_abandoned",
        },
      },
    ]);

    await processQueuedXeroOutboxOperations({ limit: 1 });

    expect(mocks.voidXeroInvoiceForAbandonedGroupSettlement).toHaveBeenCalledWith(
      "settle_1",
      "inv_abandoned",
      { syncOperationId: "op_settle_abandon_1" }
    );
    expect(mocks.voidXeroInvoiceForCancelledGroupSettlement).not.toHaveBeenCalled();

    vi.clearAllMocks();
    mocks.updateManyOperation.mockResolvedValue({ count: 1 });
    mocks.voidXeroInvoiceForCancelledGroupSettlement.mockResolvedValue(undefined);
    mocks.findManyOperations.mockResolvedValue([fixtures.GROUP_SETTLEMENT_INVOICE_VOID.op]);

    await processQueuedXeroOutboxOperations({ limit: 1 });

    expect(mocks.voidXeroInvoiceForCancelledGroupSettlement).toHaveBeenCalledWith(
      "settle_1",
      { syncOperationId: "op_settle_void_1" }
    );
    expect(mocks.voidXeroInvoiceForAbandonedGroupSettlement).not.toHaveBeenCalled();
  });

  it("routes nothing outside the constant: representative non-members hit the incomplete-payload fallthrough", async () => {
    // REQUEUE/BACKFILL carry no outbox queueType and must never be dispatched by
    // this scan; a synthetic unknown stands in for a future stray type. All three
    // reach the else-branch, so none of the money-moving handlers fire.
    mocks.findManyOperations.mockResolvedValue([
      { id: "op_requeue", requestPayload: { queueType: "REQUEUE" } },
      { id: "op_backfill", requestPayload: { queueType: "BACKFILL" } },
      { id: "op_unknown", requestPayload: { queueType: "TOTALLY_NEW_TYPE" } },
    ]);

    await expect(processQueuedXeroOutboxOperations({ limit: 5 })).resolves.toEqual({
      found: 3,
      processed: 3,
      succeeded: 0,
      failed: 3,
      skipped: 0,
    });

    for (const fixture of Object.values(fixtures)) {
      expect(fixture.handler).not.toHaveBeenCalled();
    }
  });
});

/**
 * #3641, `INV-PAY-104`: the waiting-invoice reaper. It releases an invoice whose
 * payment has arrived, keeps one the member can still pay, and retires only one
 * the member can no longer pay. Stripe is asked only for a FAILED ask, which is
 * the one case the local rows cannot answer, and at most 25 times a run.
 */
describe("reapStaleWaitingPaymentXeroOutboxOperations", () => {
  const DAY_MS = 24 * 60 * 60 * 1000;
  const SENT_TO_ONE_ADMIN = {
    deliveryAllowed: true,
    recipients: 1,
    sent: 1,
    queuedForRetry: 0,
    notDelivered: 0,
  };
  const waitingOp = (id: string, paymentIntentId: string | null, ageDays = 0) => ({
    id,
    createdAt: new Date(Date.now() - ageDays * DAY_MS),
    requestPayload: paymentIntentId ? { paymentIntentId } : {},
  });
  const transaction = (status: string, failedHoursAgo = 48, amountCents = 12000) => ({
    status,
    amountCents,
    updatedAt: new Date(Date.now() - failedHoursAgo * 60 * 60 * 1000),
  });
  /** The `Payment` row the pay door reads, found by the intent. */
  const payableAsk = (
    paymentIntentId: string,
    overrides: {
      additionalPaymentStatus?: string | null;
      bookingStatus?: string;
      deletedAt?: Date | null;
      additionalPaymentIntentId?: string | null;
    } = {},
  ) => ({
    additionalPaymentIntentId:
      overrides.additionalPaymentIntentId === undefined
        ? paymentIntentId
        : overrides.additionalPaymentIntentId,
    additionalPaymentStatus: overrides.additionalPaymentStatus ?? "FAILED",
    booking: {
      status: overrides.bookingStatus ?? "CONFIRMED",
      deletedAt: overrides.deletedAt ?? null,
    },
  });
  const retireCall = () =>
    mocks.updateManyOperation.mock.calls.find(
      ([args]) => (args as { data: { status?: string } }).data.status === "CANCELLED",
    );

  let waiting: unknown[] = [];
  beforeEach(() => {
    vi.clearAllMocks();
    waiting = [];
    // The sweep's own read has no intent filter; the late-capture release's
    // reads (waiting on one intent, retired on one intent) do.
    mocks.findManyOperations.mockReset();
    mocks.findManyOperations.mockImplementation(
      async (args: { where: { requestPayload?: unknown } }) =>
        args.where.requestPayload ? [] : waiting,
    );
    mocks.findFirstPaymentTransaction.mockReset();
    mocks.findFirstPaymentTransaction.mockResolvedValue(null);
    mocks.findFirstRecoveryOperation.mockReset();
    mocks.findFirstRecoveryOperation.mockResolvedValue(null);
    mocks.findUniqueManualRefundTask.mockReset();
    mocks.updateManyOperation.mockReset();
    mocks.updateManyOperation.mockResolvedValue({ count: 1 });
    mocks.findUniquePayment.mockReset();
    mocks.findUniquePayment.mockResolvedValue(null);
    mocks.getPaymentIntent.mockReset();
    mocks.getPaymentIntent.mockResolvedValue({ status: "requires_payment_method" });
    mocks.countOperations.mockResolvedValue(0);
    mocks.claimAlertCooldown.mockReset();
    mocks.claimAlertCooldown.mockResolvedValue(true);
    mocks.deferAlertCooldown.mockResolvedValue(undefined);
    mocks.releaseAlertCooldown.mockResolvedValue(undefined);
    mocks.sendAdminXeroSyncErrorAlert.mockReset();
    mocks.sendAdminXeroSyncErrorAlert.mockResolvedValue(SENT_TO_ONE_ADMIN);
  });

  it("retires a waiting invoice FAILED past the grace window whose request the booking no longer names", async () => {
    waiting = [waitingOp("op_waiting_1", "pi_superseded")];
    mocks.findFirstPaymentTransaction.mockResolvedValue(transaction("FAILED", 48));

    const result = await reapStaleWaitingPaymentXeroOutboxOperations();

    expect(mocks.findManyOperations).toHaveBeenCalledWith(
      expect.objectContaining({ orderBy: { updatedAt: "asc" } }),
    );
    expect(mocks.findUniquePayment).toHaveBeenCalledWith(
      expect.objectContaining({ where: { additionalPaymentIntentId: "pi_superseded" } }),
    );
    expect(retireCall()?.[0]).toEqual({
      where: { id: { in: ["op_waiting_1"] }, status: "WAITING_PAYMENT" },
      data: expect.objectContaining({
        status: "CANCELLED",
        lastErrorCode: "STALE_WAITING_PAYMENT",
      }),
    });
    expect(result).toEqual({
      reaped: 1,
      released: 0,
      queueOperationIds: ["op_waiting_1"],
    });
  });

  it("does NOT look at an ask whose transaction failed inside the grace window (F19, #1887)", async () => {
    waiting = [waitingOp("op_waiting_recent_fail", "pi_recent_fail")];
    mocks.findFirstPaymentTransaction.mockResolvedValue(transaction("FAILED", 1));

    const result = await reapStaleWaitingPaymentXeroOutboxOperations();

    expect(mocks.findUniquePayment).not.toHaveBeenCalled();
    expect(retireCall()).toBeUndefined();
    expect(result.reaped).toBe(0);
  });

  it("honours a custom failedTransactionGraceHours override (F19, #1887)", async () => {
    waiting = [waitingOp("op_waiting_custom", "pi_custom")];
    mocks.findFirstPaymentTransaction.mockResolvedValue(transaction("FAILED", 2));

    const inside = await reapStaleWaitingPaymentXeroOutboxOperations({
      failedTransactionGraceHours: 3,
    });
    expect(inside.reaped).toBe(0);

    const past = await reapStaleWaitingPaymentXeroOutboxOperations({
      failedTransactionGraceHours: 1,
    });
    expect(past.reaped).toBe(1);
  });

  it("retires a 14-day-old waiting invoice the member can no longer pay without asking Stripe", async () => {
    waiting = [waitingOp("op_waiting_old", "pi_still_pending", 16)];
    mocks.findFirstPaymentTransaction.mockResolvedValue(transaction("PENDING"));

    const result = await reapStaleWaitingPaymentXeroOutboxOperations();

    expect(mocks.getPaymentIntent).not.toHaveBeenCalled();
    expect(result.reaped).toBe(1);
  });

  it("leaves a recent waiting invoice with an unfailed payment alone", async () => {
    waiting = [waitingOp("op_waiting_fresh", "pi_still_active")];
    mocks.findFirstPaymentTransaction.mockResolvedValue(transaction("PENDING"));

    const result = await reapStaleWaitingPaymentXeroOutboxOperations();

    expect(mocks.findUniquePayment).not.toHaveBeenCalled();
    expect(result.reaped).toBe(0);
  });

  it("keeps a 14-day-old waiting invoice whose PENDING request the member can still pay, on local rows alone", async () => {
    waiting = [waitingOp("op_waiting_old_live", "pi_live", 16)];
    mocks.findFirstPaymentTransaction.mockResolvedValue(transaction("PENDING"));
    mocks.findUniquePayment.mockResolvedValue(
      payableAsk("pi_live", { additionalPaymentStatus: "PENDING" }),
    );

    const result = await reapStaleWaitingPaymentXeroOutboxOperations();

    expect(mocks.getPaymentIntent).not.toHaveBeenCalled();
    expect(retireCall()).toBeUndefined();
    expect(result.reaped).toBe(0);
  });

  it("keeps a waiting invoice after a decline while Stripe still lets the member pay it, with a bounded read", async () => {
    waiting = [waitingOp("op_waiting_declined", "pi_declined")];
    mocks.findFirstPaymentTransaction.mockResolvedValue(transaction("FAILED", 48));
    mocks.findUniquePayment.mockResolvedValue(payableAsk("pi_declined"));

    const result = await reapStaleWaitingPaymentXeroOutboxOperations();

    expect(mocks.getPaymentIntent).toHaveBeenCalledWith("pi_declined", {
      timeoutMs: 10_000,
      expand: ["latest_charge"],
    });
    expect(retireCall()).toBeUndefined();
    expect(result.reaped).toBe(0);
  });

  it.each([
    ["the booking was cancelled", { bookingStatus: "CANCELLED" }],
    ["the booking was bumped", { bookingStatus: "BUMPED" }],
    ["the booking was deleted", { deletedAt: new Date() }],
    [
      "a later change superseded the request",
      { additionalPaymentIntentId: "pi_replacement" },
    ],
  ])(
    "still retires an abandoned waiting invoice on both arms when %s",
    async (_label, overrides) => {
      waiting = [
        waitingOp("op_aged", "pi_gone", 16),
        waitingOp("op_failed", "pi_gone"),
      ];
      mocks.findFirstPaymentTransaction.mockResolvedValue(transaction("FAILED", 48));
      mocks.findUniquePayment.mockResolvedValue(payableAsk("pi_gone", overrides));
      mocks.updateManyOperation.mockResolvedValue({ count: 2 });

      const result = await reapStaleWaitingPaymentXeroOutboxOperations();

      expect(mocks.getPaymentIntent).not.toHaveBeenCalled();
      expect(retireCall()?.[0]).toEqual({
        where: { id: { in: ["op_aged", "op_failed"] }, status: "WAITING_PAYMENT" },
        data: expect.objectContaining({ lastErrorCode: "STALE_WAITING_PAYMENT" }),
      });
      expect(result.reaped).toBe(2);
    },
  );

  it.each([
    ["cancelled the intent", async () => ({ status: "canceled" })],
    [
      "has no such intent",
      async () => {
        throw Object.assign(new Error("No such payment_intent"), {
          code: "resource_missing",
        });
      },
    ],
  ])(
    "retires a declined ask the local door still opens once Stripe says it %s",
    async (_label, retrieve) => {
      waiting = [waitingOp("op_gone_at_stripe", "pi_cancelled", 16)];
      mocks.findFirstPaymentTransaction.mockResolvedValue(transaction("FAILED", 48));
      mocks.findUniquePayment.mockResolvedValue(payableAsk("pi_cancelled"));
      mocks.getPaymentIntent.mockImplementation(retrieve);

      const result = await reapStaleWaitingPaymentXeroOutboxOperations();

      expect(result.reaped).toBe(1);
    },
  );

  it.each([
    ["Stripe cannot be read", async () => {
      throw new Error("stripe unavailable");
    }],
    ["Stripe has already taken the money", async () => ({ status: "succeeded" })],
  ])("keeps a payable ask when %s", async (_label, retrieve) => {
    waiting = [waitingOp("op_kept", "pi_unknown", 16)];
    mocks.findFirstPaymentTransaction.mockResolvedValue(transaction("FAILED", 48));
    mocks.findUniquePayment.mockResolvedValue(payableAsk("pi_unknown"));
    mocks.getPaymentIntent.mockImplementation(retrieve);

    const result = await reapStaleWaitingPaymentXeroOutboxOperations();

    expect(retireCall()).toBeUndefined();
    expect(result.reaped).toBe(0);
  });

  it("reads Stripe at most 25 times a run and sends the rows it read to the back of the next run", async () => {
    waiting = Array.from({ length: 30 }, (_, i) => waitingOp(`op_${i}`, `pi_${i}`, 16));
    mocks.findFirstPaymentTransaction.mockResolvedValue(transaction("FAILED", 48));
    mocks.findUniquePayment.mockImplementation(
      async (args: { where: { additionalPaymentIntentId: string } }) =>
        payableAsk(args.where.additionalPaymentIntentId),
    );

    const result = await reapStaleWaitingPaymentXeroOutboxOperations();

    expect(mocks.getPaymentIntent).toHaveBeenCalledTimes(25);
    const touch = mocks.updateManyOperation.mock.calls.find(
      ([args]) => (args as { data: { updatedAt?: Date } }).data.updatedAt,
    );
    expect(touch?.[0]).toEqual({
      where: {
        id: { in: Array.from({ length: 25 }, (_, i) => `op_${i}`) },
        status: "WAITING_PAYMENT",
      },
      data: { updatedAt: expect.any(Date) },
    });
    expect(result.reaped).toBe(0);
  });

  it("RELEASES, never retires, a waiting invoice whose payment was already captured", async () => {
    const op = waitingOp("op_paid", "pi_paid", 16);
    waiting = [op];
    mocks.findManyOperations.mockImplementation(
      async (args: { where: { status: string; requestPayload?: unknown } }) => {
        if (!args.where.requestPayload) return waiting;
        return args.where.status === "WAITING_PAYMENT"
          ? [
              {
                id: "op_paid",
                localModel: "BookingModification",
                localId: "mod_1",
                requestPayload: {
                  queueType: "SUPPLEMENTARY_INVOICE",
                  bookingId: "booking_1",
                  priceDiffCents: 12000,
                  changeFeeCents: 0,
                  paymentIntentId: "pi_paid",
                },
              },
            ]
          : [];
      },
    );
    mocks.findFirstPaymentTransaction.mockResolvedValue(transaction("SUCCEEDED"));

    const result = await reapStaleWaitingPaymentXeroOutboxOperations();

    expect(retireCall()).toBeUndefined();
    expect(mocks.updateManyOperation).toHaveBeenCalledWith({
      where: { id: { in: ["op_paid"] }, status: "WAITING_PAYMENT" },
      data: expect.objectContaining({ status: "PENDING" }),
    });
    expect(result).toEqual({
      reaped: 0,
      released: 1,
      queueOperationIds: ["op_paid"],
    });
  });

  /**
   * #3641 delta D1: the "already paid" release is for a capture the webhook
   * KEPT. These two are refunded by design, so their invoice retires (#3403
   * unchanged), never goes out with a receipt for money being handed back.
   */
  it("retires, never releases, the waiting invoice of a cancelled booking whose stale-tab payment the webhook refunded", async () => {
    waiting = [waitingOp("op_cancelled_booking", "pi_stale_tab")];
    mocks.findFirstPaymentTransaction.mockResolvedValue({
      ...transaction("REFUNDED"),
      payment: { booking: { status: "CANCELLED" } },
    });

    const result = await reapStaleWaitingPaymentXeroOutboxOperations();

    expect(
      mocks.updateManyOperation.mock.calls.some(
        ([args]) => (args as { data: { status?: string } }).data.status === "PENDING",
      ),
    ).toBe(false);
    expect(retireCall()?.[0]).toEqual({
      where: { id: { in: ["op_cancelled_booking"] }, status: "WAITING_PAYMENT" },
      data: expect.objectContaining({ lastErrorCode: "STALE_WAITING_PAYMENT" }),
    });
    expect(result).toEqual({
      reaped: 1,
      released: 0,
      queueOperationIds: ["op_cancelled_booking"],
    });
  });

  it("retires, never releases, the waiting invoice of a superseded intent whose late capture is being refunded (#3403)", async () => {
    waiting = [waitingOp("op_superseded", "pi_superseded")];
    mocks.findFirstPaymentTransaction.mockResolvedValue({
      ...transaction("SUCCEEDED"),
      payment: { booking: { status: "CONFIRMED" } },
    });
    mocks.findFirstRecoveryOperation.mockResolvedValue({ id: "recovery_cancel_pi" });

    const result = await reapStaleWaitingPaymentXeroOutboxOperations();

    expect(mocks.findFirstRecoveryOperation).toHaveBeenCalledWith({
      where: {
        paymentIntentId: "pi_superseded",
        type: { in: ["CANCEL_PAYMENT_INTENT", "REFUND_SUPERSEDED_PAYMENT"] },
      },
      select: { id: true },
    });
    expect(result.released).toBe(0);
    expect(result.reaped).toBe(1);
  });

  /**
   * #3635 (owner decision 29 Sep 2026): on a cancelled booking a #3639 approval
   * task, when one owns the capture, decides - not the booking's status. One
   * fixture, the task in each state, plus the no-task control above (a
   * CANCELLED booking with no task still retires).
   */
  describe("a held late capture on a cancelled booking (#3635)", () => {
    const heldCapture = () => {
      waiting = [waitingOp("op_held", "pi_held", 16)];
      mocks.findManyOperations.mockImplementation(
        async (args: { where: { status: string; requestPayload?: unknown } }) => {
          if (!args.where.requestPayload) return waiting;
          return args.where.status === "WAITING_PAYMENT"
            ? [
                {
                  id: "op_held",
                  localModel: "BookingModification",
                  localId: "mod_1",
                  requestPayload: {
                    queueType: "SUPPLEMENTARY_INVOICE",
                    bookingId: "booking_1",
                    priceDiffCents: 12000,
                    changeFeeCents: 0,
                    paymentIntentId: "pi_held",
                  },
                },
              ]
            : [];
        },
      );
      mocks.findFirstPaymentTransaction.mockResolvedValue({
        ...transaction("SUCCEEDED"),
        payment: { booking: { status: "CANCELLED" } },
      });
    };
    const released = () =>
      mocks.updateManyOperation.mock.calls.some(
        ([args]) => (args as { data: { status?: string } }).data.status === "PENDING",
      );

    it("keeps the invoice WAITING while the treasurer decides (task OPEN), however old", async () => {
      heldCapture();
      mocks.findUniqueManualRefundTask.mockResolvedValue({ status: "OPEN" });

      const result = await reapStaleWaitingPaymentXeroOutboxOperations();

      expect(mocks.findUniqueManualRefundTask).toHaveBeenCalledWith({
        where: { lateCaptureApprovalIntentId: "pi_held" },
        select: { status: true },
      });
      expect(retireCall()).toBeUndefined();
      expect(released()).toBe(false);
      // Decided in the sweep itself, never handed to the release as "captured".
      expect(mocks.findUniqueManualRefundTask).toHaveBeenCalledTimes(1);
      expect(result).toEqual({ reaped: 0, released: 0, queueOperationIds: [] });
    });

    it("retires it once the refund is approved (task COMPLETED)", async () => {
      heldCapture();
      mocks.findUniqueManualRefundTask.mockResolvedValue({ status: "COMPLETED" });

      const result = await reapStaleWaitingPaymentXeroOutboxOperations();

      expect(released()).toBe(false);
      expect(result.reaped).toBe(1);
    });

    it("RELEASES it once the treasurer kept the money (task DISMISSED)", async () => {
      heldCapture();
      mocks.findUniqueManualRefundTask.mockResolvedValue({ status: "DISMISSED" });

      const result = await reapStaleWaitingPaymentXeroOutboxOperations();

      expect(retireCall()).toBeUndefined();
      expect(mocks.updateManyOperation).toHaveBeenCalledWith({
        where: { id: { in: ["op_held"] }, status: "WAITING_PAYMENT" },
        data: expect.objectContaining({ status: "PENDING" }),
      });
      expect(result).toEqual({ reaped: 0, released: 1, queueOperationIds: ["op_held"] });
    });
  });

  /**
   * #3641 delta D3: Stripe has the money, our rows never recorded it (the
   * webhook did not arrive). The sweep cannot release it from a FAILED local
   * row, so once Stripe's three-day redelivery window has passed it tells an
   * officer, once, and stops reading Stripe for that row.
   */
  it("alerts an officer once when Stripe has held a capture our rows never recorded for three days", async () => {
    waiting = [waitingOp("op_unrecorded", "pi_unrecorded", 16)];
    mocks.findFirstPaymentTransaction.mockResolvedValue(transaction("FAILED", 200));
    mocks.findUniquePayment.mockResolvedValue(payableAsk("pi_unrecorded"));
    const fourDaysAgo = Math.floor((Date.now() - 4 * DAY_MS) / 1000);
    mocks.getPaymentIntent.mockResolvedValue({
      status: "succeeded",
      created: fourDaysAgo,
      latest_charge: { created: fourDaysAgo },
    });

    const result = await reapStaleWaitingPaymentXeroOutboxOperations();

    expect(mocks.updateManyOperation).toHaveBeenCalledWith({
      where: { id: "op_unrecorded", status: "WAITING_PAYMENT", lastErrorCode: null },
      data: expect.objectContaining({ lastErrorCode: "PROVIDER_CAPTURED_UNRECORDED" }),
    });
    expect(mocks.sendAdminXeroSyncErrorAlert).toHaveBeenCalledTimes(1);
    expect(mocks.sendAdminXeroSyncErrorAlert).toHaveBeenCalledWith(
      expect.objectContaining({
        errorType: "SUPPLEMENTARY_INVOICE_CAPTURE_UNRECORDED",
        errorMessage: expect.stringContaining("pi_unrecorded"),
      }),
    );
    expect(retireCall()).toBeUndefined();
    expect(result.reaped).toBe(0);
    // #3635 C4: the once-ever rule's claim, keyed on the outbox row.
    expect(mocks.claimAlertCooldown).toHaveBeenCalledWith(
      expect.objectContaining({ key: "xero-waiting-invoice-capture-unrecorded:op_unrecorded" }),
    );
    // Delivered: the claim is kept.
    expect(mocks.deferAlertCooldown).not.toHaveBeenCalled();
    expect(mocks.releaseAlertCooldown).not.toHaveBeenCalled();

    // A later run: the row is stamped, so Stripe is not read again, and the
    // claim is held, so no second alert.
    vi.clearAllMocks();
    waiting = [{ ...waitingOp("op_unrecorded", "pi_unrecorded", 16), lastErrorCode: "PROVIDER_CAPTURED_UNRECORDED" }];
    mocks.updateManyOperation.mockResolvedValue({ count: 0 });
    mocks.claimAlertCooldown.mockResolvedValue(false);
    await reapStaleWaitingPaymentXeroOutboxOperations();
    expect(mocks.getPaymentIntent).not.toHaveBeenCalled();
    expect(mocks.sendAdminXeroSyncErrorAlert).not.toHaveBeenCalled();
  });

  // #3635 C4: the stamp stopped every later read AND every later alert, so an
  // alert nobody received was lost for good. The stamp now only stops the
  // Stripe reads; the alert follows the one once-ever rule.
  function unrecordedCaptureFourDaysOld() {
    waiting = [waitingOp("op_unrecorded", "pi_unrecorded", 16)];
    mocks.findFirstPaymentTransaction.mockResolvedValue(transaction("FAILED", 200));
    mocks.findUniquePayment.mockResolvedValue(payableAsk("pi_unrecorded"));
    const fourDaysAgo = Math.floor((Date.now() - 4 * DAY_MS) / 1000);
    mocks.getPaymentIntent.mockResolvedValue({
      status: "succeeded",
      created: fourDaysAgo,
      latest_charge: { created: fourDaysAgo },
    });
  }

  it("C4: holds the unrecorded-capture claim a day when nobody can receive it, then alerts again from the stamped row", async () => {
    unrecordedCaptureFourDaysOld();
    mocks.sendAdminXeroSyncErrorAlert.mockResolvedValueOnce({
      ...SENT_TO_ONE_ADMIN,
      sent: 0,
      notDelivered: 1,
    });

    await reapStaleWaitingPaymentXeroOutboxOperations();

    const claim = mocks.claimAlertCooldown.mock.calls[0][0];
    expect(mocks.deferAlertCooldown).toHaveBeenCalledWith({
      key: "xero-waiting-invoice-capture-unrecorded:op_unrecorded",
      claimedAt: claim.now,
      windowMs: 36_500 * 86_400_000,
      retryAfterMs: 86_400_000,
    });

    // A day later the claim is free again: the stamped row is alerted about
    // again, with no further Stripe read.
    mocks.getPaymentIntent.mockClear();
    waiting = [{ ...waitingOp("op_unrecorded", "pi_unrecorded", 16), lastErrorCode: "PROVIDER_CAPTURED_UNRECORDED" }];
    mocks.updateManyOperation.mockResolvedValue({ count: 0 });
    await reapStaleWaitingPaymentXeroOutboxOperations();
    expect(mocks.getPaymentIntent).not.toHaveBeenCalled();
    expect(mocks.sendAdminXeroSyncErrorAlert).toHaveBeenCalledTimes(2);
  });

  it("C4: gives the unrecorded-capture claim back when the send throws", async () => {
    unrecordedCaptureFourDaysOld();
    mocks.sendAdminXeroSyncErrorAlert.mockRejectedValueOnce(new Error("SES down"));

    await reapStaleWaitingPaymentXeroOutboxOperations();

    const claim = mocks.claimAlertCooldown.mock.calls[0][0];
    expect(mocks.releaseAlertCooldown).toHaveBeenCalledWith({
      key: "xero-waiting-invoice-capture-unrecorded:op_unrecorded",
      claimedAt: claim.now,
    });
  });

  it("waits out Stripe's redelivery window before alerting about an unrecorded capture", async () => {
    waiting = [waitingOp("op_recent_capture", "pi_recent", 16)];
    mocks.findFirstPaymentTransaction.mockResolvedValue(transaction("FAILED", 200));
    mocks.findUniquePayment.mockResolvedValue(payableAsk("pi_recent"));
    const oneDayAgo = Math.floor((Date.now() - DAY_MS) / 1000);
    mocks.getPaymentIntent.mockResolvedValue({
      status: "succeeded",
      created: Math.floor((Date.now() - 20 * DAY_MS) / 1000),
      latest_charge: { created: oneDayAgo },
    });

    await reapStaleWaitingPaymentXeroOutboxOperations();

    expect(mocks.sendAdminXeroSyncErrorAlert).not.toHaveBeenCalled();
    expect(retireCall()).toBeUndefined();
  });

  it("stops reading Stripe for a row an officer was already told about", async () => {
    waiting = [
      { ...waitingOp("op_told", "pi_told", 16), lastErrorCode: "PROVIDER_CAPTURED_UNRECORDED" },
    ];
    mocks.findFirstPaymentTransaction.mockResolvedValue(transaction("FAILED", 200));
    mocks.findUniquePayment.mockResolvedValue(payableAsk("pi_told"));

    await reapStaleWaitingPaymentXeroOutboxOperations();

    expect(mocks.getPaymentIntent).not.toHaveBeenCalled();
    expect(retireCall()).toBeUndefined();
  });

  it("retires an aged waiting invoice with no payment request without reading any payment", async () => {
    waiting = [waitingOp("op_no_intent", null, 16)];

    const result = await reapStaleWaitingPaymentXeroOutboxOperations();

    expect(mocks.findFirstPaymentTransaction).not.toHaveBeenCalled();
    expect(mocks.findUniquePayment).not.toHaveBeenCalled();
    expect(result.reaped).toBe(1);
  });
});

/**
 * #3641, `INV-PAY-104`: a capture never silently releases nothing. A waiting
 * invoice is released or refused with an alert; a retired one is re-queued from
 * that same row, exactly once, or alerted where issuing it is unsafe.
 */
describe("releaseXeroSupplementaryInvoiceForCapturedPaymentIntent (#3641)", () => {
  const payload = (priceDiffCents: number) => ({
    queueType: "SUPPLEMENTARY_INVOICE",
    bookingId: "booking_1",
    bookingModificationId: "mod_1",
    priceDiffCents,
    changeFeeCents: 0,
    paymentIntentId: "pi_late",
  });
  const retiredOperation = (
    overrides: {
      id?: string;
      lastErrorCode?: string;
      priceDiffCents?: number;
      createdAt?: Date;
    } = {},
  ) => ({
    id: overrides.id ?? "op_retired",
    localModel: "BookingModification",
    localId: "mod_1",
    lastErrorCode: overrides.lastErrorCode ?? "STALE_WAITING_PAYMENT",
    requestPayload: payload(overrides.priceDiffCents ?? 12000),
    createdAt: overrides.createdAt ?? new Date("2026-06-01T00:00:00.000Z"),
  });
  const waitingOperation = (id = "op_waiting", priceDiffCents = 12000) => ({
    id,
    localModel: "BookingModification",
    localId: "mod_1",
    requestPayload: payload(priceDiffCents),
  });

  let waiting: unknown[] = [];
  let retired: unknown[] = [];
  beforeEach(() => {
    vi.clearAllMocks();
    waiting = [];
    retired = [];
    mocks.findManyOperations.mockReset();
    mocks.findManyOperations.mockImplementation(
      async (args: { where: { status: string } }) =>
        args.where.status === "WAITING_PAYMENT" ? waiting : retired,
    );
    mocks.updateManyOperation.mockReset();
    mocks.updateManyOperation.mockResolvedValue({ count: 1 });
    mocks.countOperations.mockResolvedValue(0);
    mocks.findFirstLink.mockReset();
    mocks.findFirstLink.mockResolvedValue(null);
    mocks.findFirstOperation.mockReset();
    mocks.findFirstOperation.mockResolvedValue(null);
    mocks.findUniqueBooking.mockReset();
    mocks.findUniqueBooking.mockResolvedValue({ status: "CONFIRMED" });
    mocks.findFirstPaymentTransaction.mockReset();
    mocks.findFirstPaymentTransaction.mockResolvedValue({
      status: "SUCCEEDED",
      amountCents: 12000,
      payment: { booking: { status: "CONFIRMED" } },
    });
    mocks.findFirstRecoveryOperation.mockReset();
    mocks.findFirstRecoveryOperation.mockResolvedValue(null);
    mocks.findUniqueManualRefundTask.mockReset();
  });

  const writeWith = (predicate: (data: Record<string, unknown>) => boolean) =>
    mocks.updateManyOperation.mock.calls
      .map(([args]) => args as { where: Record<string, unknown>; data: Record<string, unknown> })
      .filter((args) => predicate(args.data));
  const reviveCalls = () =>
    writeWith((data) => data.status === "PENDING" && "completedAt" in data);
  const capturedStamps = () =>
    writeWith((data) => data.lastErrorCode === "STALE_WAITING_PAYMENT_CAPTURED");
  const coveredStamps = () =>
    writeWith((data) => data.lastErrorCode === "STALE_WAITING_PAYMENT_COVERED");

  it("releases a waiting invoice the capture covers, through the one release write", async () => {
    waiting = [waitingOperation()];

    const result =
      await releaseXeroSupplementaryInvoiceForCapturedPaymentIntent("pi_late");

    expect(mocks.findManyOperations).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          status: "WAITING_PAYMENT",
          queueType: "SUPPLEMENTARY_INVOICE",
        }),
      }),
    );
    expect(mocks.updateManyOperation).toHaveBeenCalledWith({
      where: { id: { in: ["op_waiting"] }, status: "WAITING_PAYMENT" },
      data: expect.objectContaining({ status: "PENDING" }),
    });
    expect(result).toEqual({
      released: 1,
      queueOperationIds: ["op_waiting"],
      outcome: "released",
    });
  });

  it("does not issue a still-waiting invoice on a short capture: it is cancelled unsent and an officer told, once", async () => {
    waiting = [waitingOperation("op_waiting", 23000)];

    const result =
      await releaseXeroSupplementaryInvoiceForCapturedPaymentIntent("pi_late");

    expect(capturedStamps()[0]).toEqual({
      where: { id: "op_waiting", status: "WAITING_PAYMENT" },
      data: expect.objectContaining({ status: "CANCELLED" }),
    });
    expect(
      writeWith((data) => data.status === "PENDING").flatMap(
        (args) => (args.where.id as { in: string[] }).in,
      ),
    ).toEqual([]);
    expect(mocks.sendAdminXeroSyncErrorAlert).toHaveBeenCalledTimes(1);
    expect(result.outcome).toBe("alerted");
    expect(result.released).toBe(0);

    // A replay racing it loses the WAITING_PAYMENT claim and alerts nobody.
    vi.clearAllMocks();
    mocks.updateManyOperation.mockResolvedValue({ count: 0 });
    await releaseXeroSupplementaryInvoiceForCapturedPaymentIntent("pi_late");
    expect(mocks.sendAdminXeroSyncErrorAlert).not.toHaveBeenCalled();
  });

  it("re-queues the retired row itself, under the change's anchor lock, when the capture covers it", async () => {
    retired = [retiredOperation()];

    const result =
      await releaseXeroSupplementaryInvoiceForCapturedPaymentIntent("pi_late");

    expect(mocks.findManyOperations).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          status: "CANCELLED",
          queueType: "SUPPLEMENTARY_INVOICE",
          localId: { not: null },
          lastErrorCode: {
            in: ["STALE_WAITING_PAYMENT", "STALE_WAITING_PAYMENT_CAPTURED"],
          },
          requestPayload: { path: ["paymentIntentId"], equals: "pi_late" },
        }),
      }),
    );
    // The enqueue's key, through the one helper: namespace and anchor.
    expect(mocks.executeRaw).toHaveBeenCalledTimes(1);
    const [strings, ...values] = mocks.executeRaw.mock.calls[0] as [
      TemplateStringsArray,
      ...unknown[],
    ];
    expect(strings.join("?")).toContain("pg_advisory_xact_lock");
    expect(values).toEqual(["xero-supplementary-invoice", "mod_1"]);
    expect(reviveCalls()).toEqual([
      {
        where: {
          id: "op_retired",
          status: "CANCELLED",
          lastErrorCode: "STALE_WAITING_PAYMENT",
        },
        data: {
          status: "PENDING",
          startedAt: null,
          completedAt: null,
          lastErrorCode: null,
          lastErrorMessage: null,
        },
      },
    ]);
    expect(mocks.startXeroSyncOperation).not.toHaveBeenCalled();
    expect(mocks.sendAdminXeroSyncErrorAlert).not.toHaveBeenCalled();
    expect(result).toEqual({
      released: 1,
      queueOperationIds: ["op_retired"],
      outcome: "requeued",
    });
  });

  it("revives only the row billing the most of a raised ask ($100 then $130), and stamps the other covered", async () => {
    retired = [
      retiredOperation({
        id: "op_100",
        priceDiffCents: 10000,
        createdAt: new Date("2026-06-01T00:00:00.000Z"),
      }),
      retiredOperation({
        id: "op_130",
        priceDiffCents: 13000,
        createdAt: new Date("2026-06-05T00:00:00.000Z"),
      }),
    ];
    mocks.findFirstPaymentTransaction.mockResolvedValue({
      status: "SUCCEEDED",
      amountCents: 13000,
    });

    const result =
      await releaseXeroSupplementaryInvoiceForCapturedPaymentIntent("pi_late");

    expect(reviveCalls().map((args) => args.where.id)).toEqual(["op_130"]);
    expect(coveredStamps().map((args) => args.where.id)).toEqual([
      { in: ["op_100"] },
    ]);
    expect(mocks.sendAdminXeroSyncErrorAlert).not.toHaveBeenCalled();
    expect(result.outcome).toBe("requeued");
    expect(result.queueOperationIds).toEqual(["op_130"]);
  });

  it("revives the larger ask even when a stale, smaller settlement was written after it (the restate never lowers)", async () => {
    retired = [
      retiredOperation({
        id: "op_130",
        priceDiffCents: 13000,
        createdAt: new Date("2026-06-01T00:00:00.000Z"),
      }),
      retiredOperation({
        id: "op_100_stale",
        priceDiffCents: 10000,
        createdAt: new Date("2026-06-05T00:00:00.000Z"),
      }),
    ];
    mocks.findFirstPaymentTransaction.mockResolvedValue({
      status: "SUCCEEDED",
      amountCents: 13000,
      payment: { booking: { status: "CONFIRMED" } },
    });

    await releaseXeroSupplementaryInvoiceForCapturedPaymentIntent("pi_late");

    expect(reviveCalls().map((args) => args.where.id)).toEqual(["op_130"]);
    expect(coveredStamps().map((args) => args.where.id)).toEqual([
      { in: ["op_100_stale"] },
    ]);
  });

  it("names a row once in what it returns, when the reaper retired it between the release's read and its write", async () => {
    waiting = [waitingOperation("op_raced")];
    retired = [retiredOperation({ id: "op_raced" })];
    mocks.updateManyOperation
      .mockResolvedValueOnce({ count: 0 }) // the release write: already retired
      .mockResolvedValue({ count: 1 }); // the revive

    const result =
      await releaseXeroSupplementaryInvoiceForCapturedPaymentIntent("pi_late");

    expect(result).toEqual({
      released: 1,
      queueOperationIds: ["op_raced"],
      outcome: "requeued",
    });
  });

  it("a caller that loses the race (or a replay) re-queues nothing and alerts nobody", async () => {
    retired = [retiredOperation()];
    mocks.updateManyOperation.mockResolvedValue({ count: 0 });

    const result =
      await releaseXeroSupplementaryInvoiceForCapturedPaymentIntent("pi_late");

    expect(reviveCalls()).toHaveLength(1);
    expect(mocks.sendAdminXeroSyncErrorAlert).not.toHaveBeenCalled();
    expect(result).toEqual({
      released: 0,
      queueOperationIds: [],
      outcome: "already-released",
    });
  });

  it("alerts once instead of re-issuing when the capture is short of what the retired invoice bills", async () => {
    retired = [retiredOperation({ priceDiffCents: 23000 })];

    const result =
      await releaseXeroSupplementaryInvoiceForCapturedPaymentIntent("pi_late");

    expect(reviveCalls()).toEqual([]);
    expect(capturedStamps()[0]?.where).toEqual({
      id: "op_retired",
      status: "CANCELLED",
      lastErrorCode: "STALE_WAITING_PAYMENT",
    });
    expect(mocks.sendAdminXeroSyncErrorAlert).toHaveBeenCalledTimes(1);
    expect(mocks.sendAdminXeroSyncErrorAlert).toHaveBeenCalledWith(
      expect.objectContaining({
        errorType: "SUPPLEMENTARY_INVOICE_NOT_ISSUED_ON_CAPTURE",
        errorMessage: expect.stringContaining("pi_late"),
      }),
    );
    expect(result.outcome).toBe("alerted");
    expect(result.released).toBe(0);
  });

  it("reports nothing alerted when another caller already claimed the row", async () => {
    retired = [retiredOperation({ priceDiffCents: 23000 })];
    mocks.updateManyOperation.mockResolvedValue({ count: 0 });

    const result =
      await releaseXeroSupplementaryInvoiceForCapturedPaymentIntent("pi_late");

    expect(mocks.sendAdminXeroSyncErrorAlert).not.toHaveBeenCalled();
    expect(result.outcome).toBe("already-released");
  });

  it("a row an earlier capture already alerted about is left alone and named as such", async () => {
    retired = [retiredOperation({ lastErrorCode: "STALE_WAITING_PAYMENT_CAPTURED" })];

    const result =
      await releaseXeroSupplementaryInvoiceForCapturedPaymentIntent("pi_late");

    expect(mocks.executeRaw).not.toHaveBeenCalled();
    expect(mocks.sendAdminXeroSyncErrorAlert).not.toHaveBeenCalled();
    expect(result.outcome).toBe("already-alerted");
  });

  it("alerts instead of re-issuing when the change already has another supplementary invoice in Xero", async () => {
    retired = [retiredOperation()];
    mocks.findFirstLink.mockResolvedValue({ id: "link_existing" });

    const result =
      await releaseXeroSupplementaryInvoiceForCapturedPaymentIntent("pi_late");

    expect(mocks.findFirstLink).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          localModel: "BookingModification",
          localId: "mod_1",
          role: "SUPPLEMENTARY_INVOICE",
          active: true,
        }),
      }),
    );
    expect(reviveCalls()).toEqual([]);
    expect(mocks.sendAdminXeroSyncErrorAlert).toHaveBeenCalledTimes(1);
    expect(result.outcome).toBe("alerted");
  });

  it("alerts instead of re-issuing when another ask's invoice is already queued for the change", async () => {
    retired = [retiredOperation()];
    mocks.findFirstOperation
      .mockResolvedValueOnce(null) // nothing for THIS request
      .mockResolvedValueOnce({ id: "op_other" }); // another ask outstanding

    const result =
      await releaseXeroSupplementaryInvoiceForCapturedPaymentIntent("pi_late");

    expect(reviveCalls()).toEqual([]);
    expect(mocks.sendAdminXeroSyncErrorAlert).toHaveBeenCalledTimes(1);
    expect(result.outcome).toBe("alerted");
  });

  it("an invoice for this same request already queued or SENT covers the capture: no alert, even with its link in place", async () => {
    retired = [retiredOperation()];
    // The repair tool re-parked an invoice on this intent; the first caller
    // released it and the outbox SENT it, so the change now carries its link.
    // The row as the worker leaves it: the Xero body recorded BESIDE the queued
    // fields (`createXeroSupplementaryInvoice` keeps them, pinned in
    // xero-supplementary-invoices.test.ts), so its `paymentIntentId` survives,
    // and the double below answers the covering query only from that shape.
    const sentRow = {
      id: "op_reparked",
      status: "SUCCEEDED",
      localId: "mod_1",
      requestPayload: {
        ...payload(12000),
        invoices: [{ reference: "Supplementary for booking booking_" }],
        priceLines: { source: "FALLBACK_SINGLE_LINE" },
      } as Record<string, unknown>,
    };
    mocks.findFirstOperation.mockImplementation(
      async (args: {
        where: {
          localId?: string;
          status?: { not?: string };
          requestPayload?: { path: string[]; equals: string };
        };
      }) => {
        const wanted = args.where.requestPayload;
        const key = wanted?.path[0];
        const matches =
          args.where.localId === sentRow.localId &&
          args.where.status?.not !== undefined &&
          args.where.status.not !== sentRow.status &&
          key !== undefined &&
          sentRow.requestPayload[key] === wanted?.equals;
        return matches ? { id: sentRow.id } : null;
      },
    );
    mocks.findFirstLink.mockResolvedValue({ id: "link_from_reparked" });

    const result =
      await releaseXeroSupplementaryInvoiceForCapturedPaymentIntent("pi_late");

    expect(mocks.findFirstOperation).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          id: { notIn: ["op_retired"] },
          localId: "mod_1",
          status: { not: "CANCELLED" },
          requestPayload: { path: ["paymentIntentId"], equals: "pi_late" },
        }),
      }),
    );
    expect(coveredStamps()[0]?.where).toEqual({
      id: { in: ["op_retired"] },
      status: "CANCELLED",
      lastErrorCode: "STALE_WAITING_PAYMENT",
    });
    expect(reviveCalls()).toEqual([]);
    expect(mocks.sendAdminXeroSyncErrorAlert).not.toHaveBeenCalled();
    expect(result.outcome).toBe("already-released");
  });

  it("the second late-success caller, after the row was stamped covered, finds nothing to alert about", async () => {
    // The covered stamp is outside the retired lookup, so the second caller
    // sees no retired row, and the released invoice names the capture.
    retired = [];
    mocks.countOperations.mockResolvedValue(1);

    const result =
      await releaseXeroSupplementaryInvoiceForCapturedPaymentIntent("pi_late");

    expect(mocks.executeRaw).not.toHaveBeenCalled();
    expect(mocks.sendAdminXeroSyncErrorAlert).not.toHaveBeenCalled();
    expect(result.outcome).toBe("already-released");
  });

  it("releases and revives nothing on a CANCELLED booking, whose capture the webhook refunds", async () => {
    waiting = [waitingOperation()];
    retired = [retiredOperation()];
    mocks.findFirstPaymentTransaction.mockResolvedValue({
      status: "REFUNDED",
      amountCents: 12000,
      payment: { booking: { status: "CANCELLED" } },
    });

    const result =
      await releaseXeroSupplementaryInvoiceForCapturedPaymentIntent("pi_late");

    expect(mocks.executeRaw).not.toHaveBeenCalled();
    expect(mocks.updateManyOperation).not.toHaveBeenCalled();
    expect(mocks.sendAdminXeroSyncErrorAlert).not.toHaveBeenCalled();
    expect(result).toEqual({ released: 0, queueOperationIds: [], outcome: "left-retired" });
  });

  it("releases and revives nothing for a superseded intent, whose capture is refunded (#3403)", async () => {
    waiting = [waitingOperation()];
    retired = [retiredOperation()];
    mocks.findFirstRecoveryOperation.mockResolvedValue({ id: "recovery_cancel_pi" });

    const result =
      await releaseXeroSupplementaryInvoiceForCapturedPaymentIntent("pi_late");

    expect(mocks.updateManyOperation).not.toHaveBeenCalled();
    expect(result.outcome).toBe("left-retired");
  });

  /**
   * #3635: the same three task states for the late-capture release, which the
   * dismissal calls. The no-task control is the CANCELLED case above.
   */
  it("#3635: touches nothing, waiting or retired, while a treasurer decides a cancelled booking's capture", async () => {
    waiting = [waitingOperation()];
    retired = [retiredOperation()];
    mocks.findFirstPaymentTransaction.mockResolvedValue({
      status: "SUCCEEDED",
      amountCents: 12000,
      payment: { booking: { status: "CANCELLED" } },
    });
    mocks.findUniqueManualRefundTask.mockResolvedValue({ status: "OPEN" });

    const result =
      await releaseXeroSupplementaryInvoiceForCapturedPaymentIntent("pi_late");

    expect(mocks.executeRaw).not.toHaveBeenCalled();
    expect(mocks.updateManyOperation).not.toHaveBeenCalled();
    expect(result).toEqual({
      released: 0,
      queueOperationIds: [],
      outcome: "awaiting-decision",
    });
  });

  it("#3635: an approved refund (task COMPLETED) leaves it retired, as before", async () => {
    retired = [retiredOperation()];
    mocks.findFirstPaymentTransaction.mockResolvedValue({
      status: "SUCCEEDED",
      amountCents: 12000,
      payment: { booking: { status: "CANCELLED" } },
    });
    mocks.findUniqueManualRefundTask.mockResolvedValue({ status: "COMPLETED" });

    const result =
      await releaseXeroSupplementaryInvoiceForCapturedPaymentIntent("pi_late");

    expect(mocks.updateManyOperation).not.toHaveBeenCalled();
    expect(result.outcome).toBe("left-retired");
  });

  it("#3635: a capture closed without refunding AFTER a full dashboard refund is still KEPT: recorded gross, its refund noted apart", async () => {
    retired = [retiredOperation()];
    mocks.findFirstPaymentTransaction.mockResolvedValue({
      status: "REFUNDED",
      amountCents: 12000,
      refundedAmountCents: 12000,
      payment: { booking: { status: "CANCELLED" } },
    });
    mocks.findUniqueManualRefundTask.mockResolvedValue({ status: "DISMISSED" });

    const result =
      await releaseXeroSupplementaryInvoiceForCapturedPaymentIntent("pi_late");

    // Recorded gross (orchestrator decision 29 Sep 2026); the dashboard refund
    // is answered by its own refund note, so netting here would count it twice.
    expect(reviveCalls()).toHaveLength(1);
    expect(result.outcome).toBe("requeued");
  });

  it("#3635: a KEPT capture on a cancelled booking (task DISMISSED) revives the retired row itself", async () => {
    retired = [retiredOperation()];
    mocks.findFirstPaymentTransaction.mockResolvedValue({
      status: "SUCCEEDED",
      amountCents: 12000,
      payment: { booking: { status: "CANCELLED" } },
    });
    mocks.findUniqueManualRefundTask.mockResolvedValue({ status: "DISMISSED" });

    const result =
      await releaseXeroSupplementaryInvoiceForCapturedPaymentIntent("pi_late");

    expect(reviveCalls()).toHaveLength(1);
    expect(result.outcome).toBe("requeued");
  });

  it("never leaves a BUMPED booking's capture silent: the money was kept, so the invoice is re-issued", async () => {
    retired = [retiredOperation()];
    mocks.findFirstPaymentTransaction.mockResolvedValue({
      status: "SUCCEEDED",
      amountCents: 12000,
      payment: { booking: { status: "BUMPED" } },
    });

    const result =
      await releaseXeroSupplementaryInvoiceForCapturedPaymentIntent("pi_late");

    expect(reviveCalls().map((args) => args.where.id)).toEqual(["op_retired"]);
    expect(result.outcome).toBe("requeued");
  });

  it.each([
    [1, "already-released"],
    [0, "none-queued"],
  ])(
    "with nothing waiting or retired, names why nothing was released (released elsewhere: %i)",
    async (releasedCount, outcome) => {
      mocks.countOperations.mockResolvedValue(releasedCount);

      const result =
        await releaseXeroSupplementaryInvoiceForCapturedPaymentIntent("pi_late");

      expect(result).toEqual({ released: 0, queueOperationIds: [], outcome });
    },
  );
});

/**
 * #3641 review round: the payment recovery's attach of a recovered intent to
 * the change's waiting invoice must not fail silently, or the invoice waits on
 * no intent while the member pays.
 */
describe("attachRecoveredIntentToWaitingSupplementaryInvoice (#3641)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.findManyOperations.mockReset();
  });

  it("alerts an officer when the attach fails", async () => {
    mocks.findManyOperations.mockRejectedValue(new Error("database is down"));

    await attachRecoveredIntentToWaitingSupplementaryInvoice({
      bookingModificationId: "mod_1",
      paymentIntentId: "pi_recovered",
      recoveryOperationId: "recovery_1",
    });

    expect(mocks.sendAdminXeroSyncErrorAlert).toHaveBeenCalledWith(
      expect.objectContaining({
        errorType: "SUPPLEMENTARY_INVOICE_INTENT_NOT_ATTACHED",
        errorMessage: expect.stringContaining("pi_recovered"),
      }),
    );
  });

  it("stays quiet when the attach succeeds", async () => {
    mocks.findManyOperations.mockResolvedValue([]);

    await attachRecoveredIntentToWaitingSupplementaryInvoice({
      bookingModificationId: "mod_1",
      paymentIntentId: "pi_recovered",
      recoveryOperationId: "recovery_1",
    });

    expect(mocks.sendAdminXeroSyncErrorAlert).not.toHaveBeenCalled();
  });
});

/**
 * #3170 (epic #2797): ONE EDIT, ONE ASK, on the Xero side.
 *
 * A booking edit whose money could not be valued can raise two review tasks, and
 * an officer may settle both as money owed to the club. The owner's decision is
 * that both contribute to a single request for the total, so the supplementary
 * invoice has to bill $230 rather than $200 and then $30. Queueing the second one
 * is not an option: `enqueueXeroSupplementaryInvoiceOperation` refuses an anchor
 * that already has an active SUPPLEMENTARY_INVOICE link and returns a MESSAGE
 * rather than an error, so the second share would be dropped in silence.
 */
describe("restatePendingSupplementaryInvoiceAmount (#3170)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.updateManyOperation.mockResolvedValue({ count: 1 });
  });

  function waitingOperation(overrides: Record<string, unknown> = {}) {
    return {
      id: "op_supplementary_1",
      requestPayload: {
        queueType: "SUPPLEMENTARY_INVOICE",
        bookingId: "booking_1",
        priceDiffCents: 20000,
        changeFeeCents: 0,
        bookingModificationId: "mod_1",
        recordPayment: true,
        paymentIntentId: "pi_additional_1",
        waitForConfirmedAdditionalPayment: true,
      },
      ...overrides,
    };
  }

  it("raises the queued invoice to the combined total, key and all", async () => {
    mocks.findManyOperations.mockResolvedValue([waitingOperation()]);

    await expect(
      restatePendingSupplementaryInvoiceAmount({
        bookingModificationId: "mod_1",
        priceDiffCents: 23000,
        changeFeeCents: 0,
      })
    ).resolves.toEqual({ restated: 1, alreadyCovering: 0 });

    expect(mocks.updateManyOperation).toHaveBeenCalledWith({
      where: {
        id: "op_supplementary_1",
        // #3170 fix round (F3): the SAME status predicate the read used. An
        // operation the outbox claimed between the two statements matches
        // nothing here, so the write cannot contradict an ask already going out.
        status: { in: ["PENDING", "WAITING_PAYMENT"] },
      },
      data: {
        requestPayload: expect.objectContaining({
          priceDiffCents: 23000,
          changeFeeCents: 0,
          // Everything else the operation was carrying survives - in particular
          // the intent it is waiting on, without which the payment webhook can
          // never release it.
          paymentIntentId: "pi_additional_1",
          waitForConfirmedAdditionalPayment: true,
        }),
        // The correlation key is built FROM the amount, so leaving it stale would
        // let a later enqueue for the new total find no match and queue a
        // duplicate.
        idempotencyKey: "booking-mod:mod_1:supplementary-invoice:23000:0:v1",
        correlationKey: "booking-mod:mod_1:supplementary-invoice:23000:0:v1",
      },
    });
  });

  it("only looks at operations that have not run yet", async () => {
    mocks.findManyOperations.mockResolvedValue([]);

    await restatePendingSupplementaryInvoiceAmount({
      bookingModificationId: "mod_1",
      priceDiffCents: 23000,
      changeFeeCents: 0,
    });

    // PENDING and WAITING_PAYMENT are the two states in which nothing has reached
    // Xero, so restating changes what WILL be billed rather than contradicting
    // what was. A RUNNING, SUCCEEDED or FAILED operation is left alone and the
    // caller's pre-claim refusal is what stops a share reaching an ask already
    // sent.
    expect(mocks.findManyOperations).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          status: { in: ["PENDING", "WAITING_PAYMENT"] },
          localModel: "BookingModification",
          localId: "mod_1",
          operationType: "CREATE",
          entityType: "INVOICE",
        }),
      })
    );
  });

  /**
   * #3170 fix round (F3). The test above asserted the READ filter and stopped
   * there, which is exactly how the write came to carry no filter at all: the
   * docblock said "only operations that have not run yet" and half the function
   * obeyed it. A row that left PENDING between the read and the write is a row
   * the outbox is already sending, and rewriting its amount contradicts an ask in
   * flight.
   */
  it("counts nothing restated when the operation left PENDING before the write", async () => {
    mocks.findManyOperations.mockResolvedValue([waitingOperation()]);
    // The status-guarded updateMany matches no row: the outbox claimed it.
    mocks.updateManyOperation.mockResolvedValue({ count: 0 });

    await expect(
      restatePendingSupplementaryInvoiceAmount({
        bookingModificationId: "mod_1",
        priceDiffCents: 23000,
        changeFeeCents: 0,
      })
    ).resolves.toEqual({ restated: 0, alreadyCovering: 0 });
  });

  it("a replay at the same figures writes nothing but still reports the operation", async () => {
    mocks.findManyOperations.mockResolvedValue([waitingOperation()]);

    await expect(
      restatePendingSupplementaryInvoiceAmount({
        bookingModificationId: "mod_1",
        priceDiffCents: 20000,
        changeFeeCents: 0,
      })
    ).resolves.toEqual({ restated: 0, alreadyCovering: 1 });

    // Reported, because the caller must NOT then enqueue a second invoice; but
    // not written, because nothing changed.
    expect(mocks.updateManyOperation).not.toHaveBeenCalled();
  });

  /**
   * #3170 fix round (F2, interleaving A) - THE STALE RUN CANNOT LOWER THE ASK.
   *
   * Two settlements of one edit derive their totals independently. Whichever
   * commits last necessarily sees both shares, so the LARGER figure is always the
   * newer one - but the two Xero legs can still land in either order. Without a
   * comparison the stale $200 run's restate lands after the $230 one, takes the
   * queued invoice back down to $200, and returns "restated" - so its caller
   * returns early and nothing ever re-queues the missing $30. The provider leg's
   * compare-and-set never covered this leg; this is that guard, on the accounting
   * side.
   *
   * No database is needed to prove it: a stale total and an already-restated
   * operation are two arguments.
   */
  it("refuses to lower a queued invoice when a stale, smaller total lands last", async () => {
    // The $230 run already restated this operation.
    mocks.findManyOperations.mockResolvedValue([
      waitingOperation({
        requestPayload: {
          ...waitingOperation().requestPayload,
          priceDiffCents: 23000,
        },
      }),
    ]);

    // The $200 run's Xero leg arrives afterwards.
    await expect(
      restatePendingSupplementaryInvoiceAmount({
        bookingModificationId: "mod_1",
        priceDiffCents: 20000,
        changeFeeCents: 0,
      })
    ).resolves.toEqual({ restated: 0, alreadyCovering: 1 });

    // Nothing written: the member is still billed $230.
    expect(mocks.updateManyOperation).not.toHaveBeenCalled();
  });

  /**
   * The control for the guard above: the same two runs in the other order must
   * still RAISE. A guard that refused everything would pass the test above and be
   * useless.
   */
  it("still raises when the larger total lands last", async () => {
    mocks.findManyOperations.mockResolvedValue([waitingOperation()]);

    await expect(
      restatePendingSupplementaryInvoiceAmount({
        bookingModificationId: "mod_1",
        priceDiffCents: 23000,
        changeFeeCents: 0,
      })
    ).resolves.toEqual({ restated: 1, alreadyCovering: 0 });
    expect(mocks.updateManyOperation).toHaveBeenCalled();
  });

  /**
   * "Never lower" is about what the invoice BILLS, which is the sum of its two
   * signed components. Comparing `priceDiffCents` alone would let a queued
   * $200 price + $50 fee be replaced by a $210 price with no fee - a lower net
   * dressed as a higher number.
   */
  it("compares the net the invoice bills, not the price component alone", async () => {
    mocks.findManyOperations.mockResolvedValue([
      waitingOperation({
        requestPayload: {
          ...waitingOperation().requestPayload,
          priceDiffCents: 20000,
          changeFeeCents: 5000,
        },
      }),
    ]);

    await expect(
      restatePendingSupplementaryInvoiceAmount({
        bookingModificationId: "mod_1",
        priceDiffCents: 21000,
        changeFeeCents: 0,
      })
    ).resolves.toEqual({ restated: 0, alreadyCovering: 1 });
    expect(mocks.updateManyOperation).not.toHaveBeenCalled();
  });

  it("reports nothing to restate when this edit has queued no invoice", async () => {
    // The FIRST share's ordinary answer, and what tells the caller to enqueue
    // normally.
    mocks.findManyOperations.mockResolvedValue([]);

    await expect(
      restatePendingSupplementaryInvoiceAmount({
        bookingModificationId: "mod_1",
        priceDiffCents: 20000,
        changeFeeCents: 0,
      })
    ).resolves.toEqual({ restated: 0, alreadyCovering: 0 });

    expect(mocks.updateManyOperation).not.toHaveBeenCalled();
  });
});

/**
 * #3170 fix round (F2, interleaving B) - TWO CONCURRENT SETTLEMENTS, ONE INVOICE.
 *
 * The regression this closes was introduced by the combined request itself.
 * Before it, each share queued its own amount and the concurrent case summed
 * correctly. After it, both settlements restate first (finding nothing, because
 * neither has queued yet) and then both enqueue - and the queued-operation lookup
 * deduped on a correlation key BUILT FROM THE AMOUNT, so $200 and $230 were two
 * different keys, two operations, and two Xero invoices totalling $430 for a $230
 * edit.
 *
 * Two changes close it and both are asserted here: the enqueue decides under a
 * per-anchor advisory lock, and it looks for an outstanding invoice by ANCHOR
 * rather than by amount.
 */
describe("enqueueXeroSupplementaryInvoiceOperation: one invoice per anchor (#3170)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.findFirstLink.mockResolvedValue(null);
    mocks.findUniqueBooking.mockResolvedValue({
      id: "booking_1",
      payment: { xeroInvoiceId: "inv_existing" },
    });
    mocks.findFirstOperation.mockResolvedValue(null);
    mocks.findManyOperations.mockResolvedValue([]);
    mocks.updateManyOperation.mockResolvedValue({ count: 1 });
    mocks.startXeroSyncOperation.mockResolvedValue({ id: "op_supplementary_1" });
  });

  it("takes the per-anchor advisory lock before it decides", async () => {
    await enqueueXeroSupplementaryInvoiceOperation({
      bookingId: "booking_1",
      priceDiffCents: 20000,
      changeFeeCents: 0,
      bookingModificationId: "mod_1",
    });

    expect(mocks.executeRaw).toHaveBeenCalledTimes(1);
    const [strings, ...values] = mocks.executeRaw.mock.calls[0] as [
      TemplateStringsArray,
      ...unknown[],
    ];
    expect(strings.join("?")).toContain("pg_advisory_xact_lock");
    // Namespaced and scoped to the anchor: a different edit does not contend.
    expect(values).toEqual(["xero-supplementary-invoice", "mod_1"]);
  });

  /**
   * The second settlement of the same edit, arriving after the first has queued
   * $200 and asking for the $230 combined total. It must find that invoice
   * DESPITE the amounts differing, and raise it rather than queue its own.
   */
  it("finds the first settlement's invoice by anchor and raises it instead of queueing a second", async () => {
    mocks.findFirstOperation.mockResolvedValue({ id: "op_supplementary_1" });
    mocks.findManyOperations.mockResolvedValue([
      {
        id: "op_supplementary_1",
        requestPayload: {
          queueType: "SUPPLEMENTARY_INVOICE",
          bookingId: "booking_1",
          priceDiffCents: 20000,
          changeFeeCents: 0,
          bookingModificationId: "mod_1",
        },
      },
    ]);

    await expect(
      enqueueXeroSupplementaryInvoiceOperation({
        bookingId: "booking_1",
        priceDiffCents: 23000,
        changeFeeCents: 0,
        bookingModificationId: "mod_1",
      })
    ).resolves.toEqual({
      queueOperationId: "op_supplementary_1",
      // The ask now bills the combined total, so the caller has nothing to
      // record and nothing to collect by hand.
      outcome: "covers-total",
      message:
        "Xero supplementary invoice already queued for this change was raised to the combined amount.",
    });

    // ONE invoice, and it bills the combined total.
    expect(mocks.startXeroSyncOperation).not.toHaveBeenCalled();
    expect(mocks.updateManyOperation).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          requestPayload: expect.objectContaining({ priceDiffCents: 23000 }),
        }),
      })
    );
  });

  /**
   * The lookup is by anchor, not by correlation key. This is the assertion that
   * fails if anyone puts the amount-derived key back into the `where`.
   */
  it("looks for an outstanding invoice by anchor, never by the amount-derived key", async () => {
    await enqueueXeroSupplementaryInvoiceOperation({
      bookingId: "booking_1",
      priceDiffCents: 23000,
      changeFeeCents: 0,
      bookingModificationId: "mod_1",
    });

    const where = mocks.findFirstOperation.mock.calls[0]?.[0]?.where as Record<
      string,
      unknown
    >;
    expect(where).toMatchObject({
      localModel: "BookingModification",
      localId: "mod_1",
      queueType: "SUPPLEMENTARY_INVOICE",
      status: { in: ["PENDING", "RUNNING", "WAITING_PAYMENT"] },
    });
    expect(where.correlationKey).toBeUndefined();
  });

  /**
   * The stale run reaching the enqueue rather than the restate: it must not lower
   * what the queued invoice bills, and it must still not queue a second one.
   */
  it("a stale, smaller total neither lowers the queued invoice nor queues a second", async () => {
    mocks.findFirstOperation.mockResolvedValue({ id: "op_supplementary_1" });
    mocks.findManyOperations.mockResolvedValue([
      {
        id: "op_supplementary_1",
        requestPayload: {
          queueType: "SUPPLEMENTARY_INVOICE",
          bookingId: "booking_1",
          priceDiffCents: 23000,
          changeFeeCents: 0,
          bookingModificationId: "mod_1",
        },
      },
    ]);

    await expect(
      enqueueXeroSupplementaryInvoiceOperation({
        bookingId: "booking_1",
        priceDiffCents: 20000,
        changeFeeCents: 0,
        bookingModificationId: "mod_1",
      })
    ).resolves.toEqual({
      queueOperationId: "op_supplementary_1",
      // Already asking for MORE than this stale run derived, so the ask covers
      // the total either way.
      outcome: "covers-total",
      message:
        "Xero supplementary invoice is already queued for background processing.",
    });

    expect(mocks.startXeroSyncOperation).not.toHaveBeenCalled();
    expect(mocks.updateManyOperation).not.toHaveBeenCalled();
  });
});

/**
 * #3193 (epic #2797): THE SECOND ASK - a settled review share's OWN invoice,
 * raised because the booking change's invoice had already gone out without it.
 *
 * The owner's 31 Aug 2026 decision bills the difference through the system
 * rather than leaving it to be collected by hand. It NARROWS #3170's "one
 * booking edit, one ask" rather than overturning it: while the change's invoice
 * is still in the queue a later share RAISES it and the member is asked once,
 * which the block above pins and which these tests must not disturb.
 *
 * A STATEFUL ROW STORE, deliberately, not a per-call `mockResolvedValue`. Every
 * property here is about what the enqueue's OWN link-check and queued-check
 * decide when the rows they read are the rows earlier calls wrote - and a double
 * that answers each read from a script cannot fail the way the real thing can.
 * The store below filters on exactly the columns Prisma would, and nothing in it
 * knows anything about second asks.
 */
describe("enqueueXeroSecondSupplementaryInvoiceOperation: the second ask (#3193)", () => {
  type StoredOperation = {
    id: string;
    localModel: string;
    localId: string;
    status: string;
    queueType: string;
    correlationKey: string;
    requestPayload: Record<string, unknown>;
  };
  type StoredLink = { localModel: string; localId: string; role: string; active: boolean };

  let operations: StoredOperation[];
  let links: StoredLink[];
  let nextOperationId: number;

  beforeEach(() => {
    vi.clearAllMocks();
    operations = [];
    links = [];
    nextOperationId = 1;

    mocks.findUniqueBooking.mockResolvedValue({
      id: "booking_1",
      payment: { xeroInvoiceId: "inv_existing" },
    });
    mocks.executeRaw.mockResolvedValue(1);

    mocks.findFirstLink.mockImplementation(
      async ({ where }: { where: Record<string, unknown> }) =>
        links.find(
          (link) =>
            link.localModel === where.localModel &&
            link.localId === where.localId &&
            link.role === where.role &&
            link.active === where.active,
        ) ?? null,
    );

    const matchOperations = (where: Record<string, unknown>) => {
      const status = where.status as { in?: string[] } | undefined;
      const payloadFilter = where.requestPayload as
        | { path?: string[]; equals?: unknown }
        | undefined;
      return operations.filter((operation) => {
        if (where.localModel && operation.localModel !== where.localModel) return false;
        if (where.localId && operation.localId !== where.localId) return false;
        if (where.queueType && operation.queueType !== where.queueType) return false;
        if (status?.in && !status.in.includes(operation.status)) return false;
        if (
          payloadFilter?.path?.[0] === "queueType" &&
          operation.requestPayload.queueType !== payloadFilter.equals
        ) {
          return false;
        }
        // #3193 fix round: the attach read below filters on THIS payload path
        // rather than on the anchor, which is why it is the one change-scoped
        // read that could ever see a second ask.
        if (
          payloadFilter?.path?.[0] === "bookingModificationId" &&
          operation.requestPayload.bookingModificationId !== payloadFilter.equals
        ) {
          return false;
        }
        if (where.status && typeof where.status === "string" && operation.status !== where.status) {
          return false;
        }
        return true;
      });
    };

    mocks.findFirstOperation.mockImplementation(
      async ({ where }: { where: Record<string, unknown> }) =>
        matchOperations(where)[0] ?? null,
    );
    mocks.findManyOperations.mockImplementation(
      async ({ where }: { where: Record<string, unknown> }) => matchOperations(where),
    );
    mocks.updateManyOperation.mockImplementation(
      async ({
        where,
        data,
      }: {
        where: Record<string, unknown>;
        data: Record<string, unknown>;
      }) => {
        const status = where.status as { in?: string[] } | undefined;
        const target = operations.find(
          (operation) =>
            operation.id === where.id &&
            (!status?.in || status.in.includes(operation.status)),
        );
        if (!target) return { count: 0 };
        if (data.requestPayload) {
          target.requestPayload = data.requestPayload as Record<string, unknown>;
        }
        if (typeof data.correlationKey === "string") {
          target.correlationKey = data.correlationKey;
        }
        return { count: 1 };
      },
    );
    mocks.startXeroSyncOperation.mockImplementation(
      async (input: {
        localModel: string;
        localId: string;
        status: string;
        correlationKey: string;
        requestPayload: Record<string, unknown>;
      }) => {
        const created: StoredOperation = {
          id: `op_${nextOperationId++}`,
          localModel: input.localModel,
          localId: input.localId,
          status: input.status,
          queueType: input.requestPayload.queueType as string,
          correlationKey: input.correlationKey,
          requestPayload: input.requestPayload,
        };
        operations.push(created);
        return { id: created.id };
      },
    );
  });

  /** The change's own invoice, already sent: an active link on the anchor. */
  function theChangesInvoiceHasGoneOut() {
    links.push({
      localModel: "BookingModification",
      localId: "mod_1",
      role: "SUPPLEMENTARY_INVOICE",
      active: true,
    });
  }

  const secondAsk = (shareCents: number, reviewTaskId = "task_2") =>
    enqueueXeroSecondSupplementaryInvoiceOperation({
      bookingId: "booking_1",
      bookingModificationId: "mod_1",
      reviewTaskId,
      shareCents,
    });

  it("queues one invoice anchored on the review task, for the share alone", async () => {
    theChangesInvoiceHasGoneOut();

    await expect(secondAsk(3000)).resolves.toMatchObject({
      outcome: "covers-total",
    });

    expect(operations).toHaveLength(1);
    const [queued] = operations;
    // The ANCHOR is what makes this safe. On the change's own anchor this row
    // would be found by the change's restate and raised to the combined total,
    // on top of an invoice already sent.
    expect(queued.localModel).toBe("ManualRefundTask");
    expect(queued.localId).toBe("task_2");
    expect(queued.requestPayload).toMatchObject({
      bookingId: "booking_1",
      bookingModificationId: "mod_1",
      shortfallReviewTaskId: "task_2",
      // THE SHARE, NEVER THE TOTAL.
      priceDiffCents: 3000,
      changeFeeCents: 0,
      // Unpaid and sent now: on the card route the card was taken at the
      // earlier figure, so there is no payment to wait for or to record.
      recordPayment: false,
      waitForConfirmedAdditionalPayment: false,
      paymentIntentId: null,
    });
    // PENDING, never WAITING_PAYMENT, and that is the property to hold rather
    // than a detail. A supplementary invoice parked on an intent is released
    // only when that intent's webhook fires; parked on one that has ALREADY
    // been paid it is never released at all, and the 14-day reaper cancels it
    // with no invoice raised - so the shortfall this whole path exists to bill
    // would be hidden for a fortnight and then silently dropped (#3187). This
    // path attaches to no intent, so it cannot reach that state at all.
    expect(queued.status).toBe("PENDING");
  });

  /**
   * THE ORDINARY ENQUEUE CANNOT BE TALKED INTO A TASK ANCHOR (#3193 fix round,
   * second pass), and this test exists because the type alone did not stop it.
   *
   * `shortfallReviewTaskId` was moved off the exported entry point's options
   * type, and a docblock then claimed the misuse was unrepresentable. It was
   * not: TypeScript's excess-property check fires only on a FRESH OBJECT
   * LITERAL at the call site, so a caller that assembles its options into a
   * variable first - the ordinary shape the moment one field is conditional -
   * compiled clean with the flag still on the object, and the exported function
   * forwarded that object wholesale to the implementation, which read the key.
   * The variable below is that caller, and it type-checks; only the field-by-
   * field forward makes it harmless.
   *
   * The money at stake is the reason: the flag anchors the row on the task and
   * makes it invisible to every change-scoped read BY DESIGN, so an edit's
   * COMBINED total queued through here would be raised as a whole second
   * invoice on top of the one already sent - $560 billed for a $280 edit.
   */
  it("ignores a review-task anchor smuggled in on a pre-built options object", async () => {
    // Assembled first, exactly as a caller with a conditional field would. No
    // literal reaches the call, so nothing rejects it at compile time.
    const builtOptions = {
      createdByMemberId: "admin_1",
      shortfallReviewTaskId: "task_2",
    };

    await enqueueXeroSupplementaryInvoiceOperation(
      {
        bookingId: "booking_1",
        priceDiffCents: 28000,
        changeFeeCents: 0,
        bookingModificationId: "mod_1",
      },
      builtOptions,
    );

    expect(operations).toHaveLength(1);
    const [queued] = operations;
    expect(queued.localModel).toBe("BookingModification");
    expect(queued.localId).toBe("mod_1");
    // `null`, the ordinary path's value, rather than the id that was smuggled.
    expect(queued.requestPayload.shortfallReviewTaskId).toBeNull();
    // And therefore it is a row the change's own reads CAN see, which is what
    // stops a second invoice for the same money.
    expect(queued.correlationKey).toBe(
      "booking-mod:mod_1:supplementary-invoice:28000:0:v1",
    );
  });

  /**
   * The key sent to Xero as the create-invoice idempotency key. If the second ask
   * shared a key with the invoice it follows, Xero would answer the create with
   * the EARLIER invoice and the difference would never be billed - a silent
   * failure wearing a successful response.
   */
  it("mints a key Xero cannot confuse with the change's own invoice", async () => {
    theChangesInvoiceHasGoneOut();
    await secondAsk(3000);

    expect(operations[0].correlationKey).toBe(
      "review-task:task_2:supplementary-shortfall-invoice:3000:0:v1",
    );
    expect(operations[0].correlationKey).not.toContain("mod_1");
  });

  /**
   * SAFE TO RUN TWICE. The settlement dispatches this fire-and-forget, so a
   * retried completion arrives here again with the same share.
   */
  it("queues nothing on a second run for the same share", async () => {
    theChangesInvoiceHasGoneOut();
    await secondAsk(3000);
    await secondAsk(3000);

    expect(operations).toHaveLength(1);
  });

  /** And nothing once this share's own invoice has itself been sent. */
  it("queues nothing once this share's own invoice has gone out", async () => {
    theChangesInvoiceHasGoneOut();
    links.push({
      localModel: "ManualRefundTask",
      localId: "task_2",
      role: "SUPPLEMENTARY_INVOICE",
      active: true,
    });

    await secondAsk(3000);

    expect(operations).toHaveLength(0);
  });

  /**
   * TWO SHARES RACING, which is the case that decides whether this can
   * double-bill. Both settle after the change's invoice has GONE OUT, so both
   * are `short-sent`, and each bills ITSELF - the club bills $200 + $30 + $50
   * for a $280 edit rather than two copies of one difference.
   */
  it("bills each racing share once, never the same difference twice", async () => {
    theChangesInvoiceHasGoneOut();

    await secondAsk(3000, "task_2");
    await secondAsk(5000, "task_3");

    expect(operations).toHaveLength(2);
    expect(
      operations.map((operation) => operation.requestPayload.priceDiffCents),
    ).toEqual([3000, 5000]);
    expect(operations.map((operation) => operation.localId)).toEqual([
      "task_2",
      "task_3",
    ]);
  });

  /**
   * THE ASSERTION THAT PROTECTS #3170, and the one this design would be unsafe
   * without. A pending second ask must be invisible to the booking change's own
   * restate: found there, a $30 row would be RAISED to the $230 combined total,
   * on top of the $200 invoice already with the member.
   */
  it("is invisible to the booking change's own restate", async () => {
    theChangesInvoiceHasGoneOut();
    await secondAsk(3000);

    await expect(
      restatePendingSupplementaryInvoiceAmount({
        bookingModificationId: "mod_1",
        priceDiffCents: 23000,
        changeFeeCents: 0,
      }),
    ).resolves.toEqual({ restated: 0, alreadyCovering: 0 });

    expect(operations[0].requestPayload.priceDiffCents).toBe(3000);
  });

  /**
   * CONTROL, on the same store: the ordinary path still finds and raises its OWN
   * queued invoice. Without this the test above would pass just as well if the
   * restate had stopped working altogether.
   */
  it("CONTROL: the change's restate still raises the change's own queued invoice", async () => {
    await enqueueXeroSupplementaryInvoiceOperation({
      bookingId: "booking_1",
      priceDiffCents: 20000,
      changeFeeCents: 0,
      bookingModificationId: "mod_1",
    });

    await expect(
      restatePendingSupplementaryInvoiceAmount({
        bookingModificationId: "mod_1",
        priceDiffCents: 23000,
        changeFeeCents: 0,
      }),
    ).resolves.toEqual({ restated: 1, alreadyCovering: 0 });

    expect(operations[0].requestPayload.priceDiffCents).toBe(23000);
  });

  /**
   * And the ordinary enqueue never sees a second ask either, so a third share
   * arriving later still reports `short-sent` and raises its own rather than
   * being told the difference is already covered by somebody else's row.
   */
  it("is invisible to the change's own enqueue", async () => {
    theChangesInvoiceHasGoneOut();
    await secondAsk(3000);

    await expect(
      enqueueXeroSupplementaryInvoiceOperation({
        bookingId: "booking_1",
        priceDiffCents: 28000,
        changeFeeCents: 0,
        bookingModificationId: "mod_1",
      }),
    ).resolves.toMatchObject({ outcome: "short-sent" });
  });

  it("takes the advisory lock on the TASK, so two edits never contend", async () => {
    theChangesInvoiceHasGoneOut();
    await secondAsk(3000);

    expect(mocks.executeRaw).toHaveBeenCalledTimes(1);
    const [, ...values] = mocks.executeRaw.mock.calls[0] as [
      TemplateStringsArray,
      ...unknown[],
    ];
    expect(values).toEqual(["xero-supplementary-invoice", "task_2"]);
  });

  /**
   * `none` is the one answer that leaves the difference unbilled, and the
   * settlement turns it into the officer-findable audit row. A booking with no
   * primary Xero invoice has nothing to supplement.
   */
  it("reports `none` when the booking has no invoice to supplement", async () => {
    mocks.findUniqueBooking.mockResolvedValue({ id: "booking_1", payment: null });

    await expect(secondAsk(3000)).resolves.toMatchObject({ outcome: "none" });
    expect(operations).toHaveLength(0);
  });

  /**
   * THE DOUBLE-BILL, and the reason a refused ask is TWO outcomes rather than
   * one (#3193 fix round).
   *
   * A single `short` meant two different facts: an invoice that exists, and a
   * row the outbox has merely CLAIMED. Only the first is durable. A RUNNING row
   * returns to PENDING without ever reaching Xero when a cooldown refuses it
   * before any HTTP call - `processXeroOutbox` un-claims it precisely so an
   * outage does not condemn un-attempted work - and the next settlement then
   * raises it to the COMBINED total, which already contains any share billed
   * separately in the meantime. The change-anchored restate cannot see that
   * separate invoice to cap itself, because the task anchor that makes a second
   * ask idempotent is the same anchor that hides it.
   *
   * Three shares, one edit: $200, then $30 while the row is RUNNING, then $50
   * after it comes back. The member owes $280. Before this round they were
   * billed $310 - worse than the shortfall the second ask exists to remove,
   * because without a second ask at all this sequence produced ONE correct $280
   * invoice.
   *
   * It drives the real `recordShortEditReviewChargeInvoice` rather than
   * asserting the enqueue's outcome string, because the outcome is only half the
   * rule: what makes this safe is that the settlement raises a second invoice on
   * `short-sent` and never on `short-in-flight`, and a test that re-stated that
   * rule here would pass against the bug.
   */
  it("never bills a share twice when the change's invoice comes back to the queue", async () => {
    const { recordShortEditReviewChargeInvoice } = await import(
      "@/lib/edit-financial-review-charge-request"
    );
    const settle = async (
      totalCents: number,
      reviewTaskId: string,
      shareCents: number,
    ) => {
      const queued = await enqueueXeroSupplementaryInvoiceOperation({
        bookingId: "booking_1",
        priceDiffCents: totalCents,
        changeFeeCents: 0,
        bookingModificationId: "mod_1",
      });
      await recordShortEditReviewChargeInvoice({
        format: CLUB_FORMAT_TEST,
        outcome: queued.outcome,
        bookingId: "booking_1",
        bookingModificationId: "mod_1",
        reviewTaskId,
        memberId: "member_1",
        totalCents,
        shareCents,
      });
      return queued.outcome;
    };

    // T1 settles $200. The change's own invoice is queued and still PENDING.
    await expect(settle(20000, "task_1", 20000)).resolves.toBe("covers-total");
    expect(operations).toHaveLength(1);
    const changeInvoice = operations[0];

    // The worker claims it. A Xero call is in flight and the amount is frozen.
    changeInvoice.status = "RUNNING";

    // T2 settles $30. The restate cannot touch a RUNNING row, so the ask is
    // refused - but nothing has been SENT, so this share must not be billed on
    // its own invoice.
    await expect(settle(23000, "task_2", 3000)).resolves.toBe("short-in-flight");

    // Xero's cooldown refused the row BEFORE any HTTP call, so the outbox
    // returned it to PENDING un-attempted. Nothing reached the member.
    changeInvoice.status = "PENDING";

    // T3 settles $50. The combined total is $280 and the restate can land now.
    await expect(settle(28000, "task_3", 5000)).resolves.toBe("covers-total");

    // WHAT THE MEMBER IS BILLED, summed across every row that will send. One
    // invoice, for exactly the edit's total.
    const billedCents = operations.reduce(
      (sum, operation) =>
        sum +
        (operation.requestPayload.priceDiffCents as number) +
        (operation.requestPayload.changeFeeCents as number),
      0,
    );
    expect(billedCents).toBe(28000);
    expect(operations).toHaveLength(1);
    expect(
      operations.some((operation) => operation.localModel === "ManualRefundTask"),
    ).toBe(false);
  });

  /**
   * THE ONE READ SCOPED TO THE CHANGE THAT COULD SEE A SECOND ASK (#3193 fix
   * round).
   *
   * `attachPaymentIntentToWaitingSupplementaryInvoiceOperations` matches on the
   * payload's `bookingModificationId`, not on the anchor - and a second ask
   * carries that id, because the invoice it bills still belongs to that change.
   * What kept it away was the wrapper hard-coding
   * `waitForConfirmedAdditionalPayment: false`, a call-site value rather than a
   * property of the anchor. A future caller flipping that flag would have parked
   * an already-settled share's invoice on a PaymentIntent that is already paid,
   * released by nothing and reaped fourteen days later with no invoice raised.
   *
   * The row below is therefore built in the WAITING_PAYMENT state the wrapper
   * never produces. That is the point: the fence has to hold on the row, not on
   * the caller.
   */
  it("never attaches a PaymentIntent to a second ask, even one left WAITING_PAYMENT", async () => {
    operations.push(
      {
        id: "op_change",
        localModel: "BookingModification",
        localId: "mod_1",
        status: "WAITING_PAYMENT",
        queueType: "SUPPLEMENTARY_INVOICE",
        correlationKey: "booking-mod:mod_1:20000:0",
        requestPayload: {
          queueType: "SUPPLEMENTARY_INVOICE",
          bookingId: "booking_1",
          bookingModificationId: "mod_1",
          priceDiffCents: 20000,
          changeFeeCents: 0,
        },
      },
      {
        id: "op_second_ask",
        localModel: "ManualRefundTask",
        localId: "task_2",
        status: "WAITING_PAYMENT",
        queueType: "SUPPLEMENTARY_INVOICE",
        correlationKey: "review-task:task_2:3000:0",
        requestPayload: {
          queueType: "SUPPLEMENTARY_INVOICE",
          bookingId: "booking_1",
          bookingModificationId: "mod_1",
          shortfallReviewTaskId: "task_2",
          priceDiffCents: 3000,
          changeFeeCents: 0,
        },
      },
    );
    mocks.updateOperation.mockImplementation(
      async ({ where, data }: { where: { id: string }; data: Record<string, unknown> }) => {
        const target = operations.find((operation) => operation.id === where.id)!;
        target.requestPayload = data.requestPayload as Record<string, unknown>;
        return target;
      },
    );

    await expect(
      attachPaymentIntentToWaitingSupplementaryInvoiceOperations({
        bookingModificationId: "mod_1",
        paymentIntentId: "pi_1",
      }),
    ).resolves.toEqual({ attached: 1 });

    expect(
      operations.find((operation) => operation.id === "op_change")!.requestPayload
        .paymentIntentId,
    ).toBe("pi_1");
    expect(
      operations.find((operation) => operation.id === "op_second_ask")!
        .requestPayload.paymentIntentId,
    ).toBeUndefined();
  });

  /**
   * THE SAME READ, ASKED THE OTHER WAY (#3220 fix round).
   *
   * `findWaitingSupplementaryInvoiceOperationForPaymentIntent` is what lets a
   * dead payment recovery tell "this ask is a duplicate of an invoice already
   * raised" from "this ask is what an invoice is still waiting for". Only the
   * second kind may be left standing, and only the first may be withdrawn - so
   * the intent id has to be part of the match, not just the change.
   */
  it("finds the waiting invoice operation parked on that exact PaymentIntent", async () => {
    operations.push({
      id: "op_change",
      localModel: "BookingModification",
      localId: "mod_1",
      status: "WAITING_PAYMENT",
      queueType: "SUPPLEMENTARY_INVOICE",
      correlationKey: "booking-mod:mod_1:20000:0",
      requestPayload: {
        queueType: "SUPPLEMENTARY_INVOICE",
        bookingId: "booking_1",
        bookingModificationId: "mod_1",
        paymentIntentId: "pi_1",
        priceDiffCents: 20000,
        changeFeeCents: 0,
      },
    });

    await expect(
      findWaitingSupplementaryInvoiceOperationForPaymentIntent({
        bookingModificationId: "mod_1",
        paymentIntentId: "pi_1",
      }),
    ).resolves.toEqual({ id: "op_change" });

    // A row waiting on some OTHER intent is not this ask's blocker. Reading it
    // as one would leave a genuine duplicate instrument standing against an
    // invoice the repair pass has already raised unpaid.
    await expect(
      findWaitingSupplementaryInvoiceOperationForPaymentIntent({
        bookingModificationId: "mod_1",
        paymentIntentId: "pi_other",
      }),
    ).resolves.toBeNull();
  });

  it("finds nothing for a change whose invoice is waiting on no intent at all", async () => {
    // The ordinary shape: enqueued but not yet attached. Nothing is waiting on
    // this ask, so a dead recovery withdraws it.
    operations.push({
      id: "op_change",
      localModel: "BookingModification",
      localId: "mod_1",
      status: "WAITING_PAYMENT",
      queueType: "SUPPLEMENTARY_INVOICE",
      correlationKey: "booking-mod:mod_1:20000:0",
      requestPayload: {
        queueType: "SUPPLEMENTARY_INVOICE",
        bookingId: "booking_1",
        bookingModificationId: "mod_1",
        priceDiffCents: 20000,
        changeFeeCents: 0,
      },
    });

    await expect(
      findWaitingSupplementaryInvoiceOperationForPaymentIntent({
        bookingModificationId: "mod_1",
        paymentIntentId: "pi_1",
      }),
    ).resolves.toBeNull();
  });

  /**
   * THE CONTROL, and it is what stops the fix above from being "never raise a
   * second ask". Once the invoice has actually been SENT its amount is fixed
   * forever, so the share IS billed separately - which is the whole of #3193.
   */
  it("still bills the share separately once the change's invoice has gone out", async () => {
    const { recordShortEditReviewChargeInvoice } = await import(
      "@/lib/edit-financial-review-charge-request"
    );
    theChangesInvoiceHasGoneOut();

    const queued = await enqueueXeroSupplementaryInvoiceOperation({
      bookingId: "booking_1",
      priceDiffCents: 23000,
      changeFeeCents: 0,
      bookingModificationId: "mod_1",
    });
    expect(queued.outcome).toBe("short-sent");

    await recordShortEditReviewChargeInvoice({
      format: CLUB_FORMAT_TEST,
      outcome: queued.outcome,
      bookingId: "booking_1",
      bookingModificationId: "mod_1",
      reviewTaskId: "task_2",
      memberId: "member_1",
      totalCents: 23000,
      shareCents: 3000,
    });

    expect(operations).toHaveLength(1);
    expect(operations[0].localModel).toBe("ManualRefundTask");
    expect(operations[0].localId).toBe("task_2");
    // THE SHARE, NEVER THE TOTAL.
    expect(operations[0].requestPayload.priceDiffCents).toBe(3000);
  });

  /**
   * And the in-flight refusal is RECORDED rather than silent, with the officer
   * instruction the uncertainty demands: nobody can yet say whether the invoice
   * went out at the earlier figure, so the record says what to check instead of
   * telling anyone to bill.
   */
  it("records the in-flight refusal as withheld, not as money to collect", async () => {
    const { recordShortEditReviewChargeInvoice } = await import(
      "@/lib/edit-financial-review-charge-request"
    );
    await enqueueXeroSupplementaryInvoiceOperation({
      bookingId: "booking_1",
      priceDiffCents: 20000,
      changeFeeCents: 0,
      bookingModificationId: "mod_1",
    });
    operations[0].status = "RUNNING";

    await recordShortEditReviewChargeInvoice({
      format: CLUB_FORMAT_TEST,
      outcome: "short-in-flight",
      bookingId: "booking_1",
      bookingModificationId: "mod_1",
      reviewTaskId: "task_2",
      memberId: "member_1",
      totalCents: 23000,
      shareCents: 3000,
    });

    expect(mocks.createAuditLog).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "booking.editFinancialReview.chargeShareUncollected",
        metadata: expect.objectContaining({ secondAsk: "withheld" }),
      }),
    );
    const [row] = mocks.createAuditLog.mock.calls.map(
      (call) => call[0] as { details: string },
    );
    // The instruction turns on the uncertainty rather than hiding it.
    expect(row.details).toContain("Check the Xero invoices for this booking");
    expect(row.details).not.toContain("Raise one by hand for the difference only");
  });
});

/**
 * #3170 FIX ROUND, F1: THE WORKER RE-READS THE PAYLOAD AFTER IT CLAIMS THE ROW.
 *
 * The scan loads every row's `requestPayload` in ONE query and the loop then
 * does a Xero round trip per row before claiming the next, so row N's scanned
 * payload is N-1 provider calls old by the time it is claimed - tens of seconds
 * to minutes at a limit of 50. In that window the row is still PENDING, so
 * `restatePendingSupplementaryInvoiceAmount` MATCHES, writes, and honestly
 * reports `restated: 1` while the send below used the scanned figure. The
 * settlement then returns early believing the combined total is billed, and on
 * the internet-banking route - where the supplementary invoice IS the ask - the
 * second share is invoiced nowhere.
 */
describe("processQueuedXeroOutboxOperations: the payload is re-read after the claim (#3170)", () => {
  const scannedRow = {
    id: "op_supplementary_restated",
    localId: "mod_1",
    localModel: "BookingModification",
    createdByMemberId: "admin_1",
    requestPayload: {
      queueType: "SUPPLEMENTARY_INVOICE",
      bookingId: "booking_1",
      priceDiffCents: 20000,
      changeFeeCents: 0,
      bookingModificationId: "mod_1",
    },
  };

  beforeEach(() => {
    vi.clearAllMocks();
    mocks.updateManyOperation.mockResolvedValue({ count: 1 });
    mocks.findManyOperations.mockResolvedValue([scannedRow]);
    mocks.createXeroSupplementaryInvoice.mockResolvedValue("inv_1");
  });

  it("sends the amount the row holds NOW, not the amount its scan read", async () => {
    // The restate landed between the scan and the claim: the row is still
    // PENDING, so it matched and wrote $230.
    mocks.findUniqueOperation.mockResolvedValue({
      requestPayload: { ...scannedRow.requestPayload, priceDiffCents: 23000 },
    });

    await processQueuedXeroOutboxOperations({ limit: 5 });

    expect(mocks.createXeroSupplementaryInvoice).toHaveBeenCalledWith(
      expect.objectContaining({ priceDiffCents: 23000 })
    );
    // The scanned figure is what the member would have been under-billed by.
    expect(mocks.createXeroSupplementaryInvoice).not.toHaveBeenCalledWith(
      expect.objectContaining({ priceDiffCents: 20000 })
    );
  });

  /**
   * THE CONTROL. Nothing restated it, so the fresh read and the scan agree and
   * the sent figure is the one the enqueue chose. A re-read that changed what an
   * untouched operation bills would be a far worse bug than the one it fixes.
   */
  it("sends the scanned amount unchanged when nothing restated the row", async () => {
    mocks.findUniqueOperation.mockResolvedValue({
      requestPayload: { ...scannedRow.requestPayload },
    });

    await processQueuedXeroOutboxOperations({ limit: 5 });

    expect(mocks.createXeroSupplementaryInvoice).toHaveBeenCalledWith(
      expect.objectContaining({ priceDiffCents: 20000, changeFeeCents: 0 })
    );
  });

  /**
   * ORDER IS THE WHOLE POINT. Re-reading BEFORE the claim would be the same bug
   * with an extra query: the row is still PENDING there, so a restate could
   * still land after the read and before the send.
   */
  it("re-reads only after the claim has committed", async () => {
    const order: string[] = [];
    mocks.updateManyOperation.mockImplementation(async () => {
      order.push("claim");
      return { count: 1 };
    });
    mocks.findUniqueOperation.mockImplementation(async () => {
      order.push("re-read");
      return { requestPayload: { ...scannedRow.requestPayload } };
    });

    await processQueuedXeroOutboxOperations({ limit: 5 });

    expect(order[0]).toBe("claim");
    expect(order[1]).toBe("re-read");
    expect(mocks.findUniqueOperation).toHaveBeenCalledWith({
      where: { id: "op_supplementary_restated" },
      select: { requestPayload: true },
    });
  });

  /**
   * A LOST CLAIM MUST NOT COST A QUERY. The row belongs to another worker, so
   * there is nothing to send and nothing to read.
   */
  it("does not re-read a row it failed to claim", async () => {
    mocks.updateManyOperation.mockResolvedValue({ count: 0 });

    await expect(
      processQueuedXeroOutboxOperations({ limit: 5 })
    ).resolves.toMatchObject({ processed: 0, skipped: 1 });

    expect(mocks.findUniqueOperation).not.toHaveBeenCalled();
    expect(mocks.createXeroSupplementaryInvoice).not.toHaveBeenCalled();
  });

  /**
   * The fallback, stated rather than assumed: a re-read that comes back with
   * nothing leaves the scanned payload in charge, so this can only ever be a
   * FRESHER read and never a new way to drop an operation.
   */
  it("falls back to the scanned payload when the re-read returns nothing", async () => {
    mocks.findUniqueOperation.mockResolvedValue(null);

    await expect(
      processQueuedXeroOutboxOperations({ limit: 5 })
    ).resolves.toMatchObject({ processed: 1, succeeded: 1 });

    expect(mocks.createXeroSupplementaryInvoice).toHaveBeenCalledWith(
      expect.objectContaining({ priceDiffCents: 20000 })
    );
  });

  /**
   * ROUTING STAYS WITH THE SCAN. The claim guard was built from the scanned
   * `queueType`, so a fresh payload claiming to be a different queue type cannot
   * be allowed to redirect the dispatch - it would run a handler the claim never
   * authorised. The schema forbids the column ever moving; this is what makes
   * that a checked property rather than a comment.
   */
  it("ignores a re-read payload whose queue type does not match the claim", async () => {
    mocks.findUniqueOperation.mockResolvedValue({
      requestPayload: {
        queueType: "BOOKING_INVOICE",
        bookingId: "booking_other",
      },
    });

    await processQueuedXeroOutboxOperations({ limit: 5 });

    expect(mocks.createXeroInvoiceForBooking).not.toHaveBeenCalled();
    expect(mocks.createXeroSupplementaryInvoice).toHaveBeenCalledWith(
      expect.objectContaining({
        bookingId: "booking_1",
        priceDiffCents: 20000,
      })
    );
  });
});

/**
 * #3170 FIX ROUND, F2: THE ENQUEUE SAYS WHETHER THE ASK COVERS THE TOTAL.
 *
 * The `message` beside it is prose for an operator's repair report and nothing
 * could branch on it, so the settlement had no way to tell "the invoice now
 * bills the combined total" from "the invoice had already left the queue and
 * bills the earlier figure". The second is a settled share the club has to
 * collect by hand, and it produced no record of any kind.
 */
describe("enqueueXeroSupplementaryInvoiceOperation: does the ask cover the total? (#3170)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.findFirstLink.mockResolvedValue(null);
    mocks.findUniqueBooking.mockResolvedValue({
      id: "booking_1",
      payment: { xeroInvoiceId: "inv_existing" },
    });
    mocks.findFirstOperation.mockResolvedValue(null);
    mocks.findManyOperations.mockResolvedValue([]);
    mocks.updateManyOperation.mockResolvedValue({ count: 1 });
    mocks.startXeroSyncOperation.mockResolvedValue({ id: "op_supplementary_1" });
  });

  it("reports `covers-total` when it queues the invoice itself", async () => {
    await expect(
      enqueueXeroSupplementaryInvoiceOperation({
        bookingId: "booking_1",
        priceDiffCents: 23000,
        changeFeeCents: 0,
        bookingModificationId: "mod_1",
      })
    ).resolves.toMatchObject({ outcome: "covers-total" });
  });

  /**
   * THE WINDOW THAT REMAINS, and the reason the settlement now writes an audit
   * row. The outbox has CLAIMED the operation, so it is RUNNING - outstanding
   * enough that a second invoice must not be queued behind it, but outside the
   * restatable set, so its amount can no longer be raised.
   */
  it("reports `short-in-flight` when the invoice is already being sent and cannot be raised", async () => {
    mocks.findFirstOperation.mockResolvedValue({ id: "op_supplementary_1" });
    // RUNNING, so the restate's status-guarded read matches nothing.
    mocks.findManyOperations.mockResolvedValue([]);

    await expect(
      enqueueXeroSupplementaryInvoiceOperation({
        bookingId: "booking_1",
        priceDiffCents: 23000,
        changeFeeCents: 0,
        bookingModificationId: "mod_1",
      })
    ).resolves.toEqual({
      queueOperationId: "op_supplementary_1",
      outcome: "short-in-flight",
      message:
        "Xero supplementary invoice for this change is already being sent and could not be raised.",
    });

    // Still exactly one invoice: a shortfall is something to record, never a
    // licence to queue a second ask. And `short-in-flight` specifically is not
    // even that yet - nothing has reached Xero, so this row may still come back
    // and be raised to the combined total (#3193 fix round).
    expect(mocks.startXeroSyncOperation).not.toHaveBeenCalled();
  });

  it("reports `short-sent` when the invoice has already been sent and linked", async () => {
    mocks.findFirstLink.mockResolvedValue({ id: "link_1" });

    await expect(
      enqueueXeroSupplementaryInvoiceOperation({
        bookingId: "booking_1",
        priceDiffCents: 23000,
        changeFeeCents: 0,
        bookingModificationId: "mod_1",
      })
    ).resolves.toMatchObject({ queueOperationId: null, outcome: "short-sent" });

    expect(mocks.startXeroSyncOperation).not.toHaveBeenCalled();
  });

  /**
   * NOT A SHORTFALL, and the difference matters: there is no accounting ask for
   * a share to fall short of, so recording one would bury the rows that mean
   * something.
   */
  it("reports `none` when there is nothing positive to bill", async () => {
    await expect(
      enqueueXeroSupplementaryInvoiceOperation({
        bookingId: "booking_1",
        priceDiffCents: -5000,
        changeFeeCents: 0,
        bookingModificationId: "mod_1",
      })
    ).resolves.toMatchObject({ outcome: "none" });
  });

  it("reports `none` when the booking has no primary Xero invoice to supplement", async () => {
    mocks.findUniqueBooking.mockResolvedValue({
      id: "booking_1",
      payment: { xeroInvoiceId: null },
    });

    await expect(
      enqueueXeroSupplementaryInvoiceOperation({
        bookingId: "booking_1",
        priceDiffCents: 23000,
        changeFeeCents: 0,
        bookingModificationId: "mod_1",
      })
    ).resolves.toMatchObject({ outcome: "none" });
  });

  /**
   * NIT 3. With no modification id the anchor is the BOOKING, and the restate
   * used to be handed that booking id under a hard-coded
   * `localModel: "BookingModification"` - so it matched nothing by construction
   * and the raise was skipped in silence, while the docblock claimed an
   * operation asking for less is always raised.
   */
  it("raises a BOOKING-anchored queued invoice too, rather than matching nothing", async () => {
    mocks.findFirstOperation.mockResolvedValue({ id: "op_booking_anchored" });
    mocks.findManyOperations.mockImplementation(async (args: {
      where: { localModel: string; localId: string };
    }) =>
      args.where.localModel === "Booking" && args.where.localId === "booking_1"
        ? [
            {
              id: "op_booking_anchored",
              requestPayload: {
                queueType: "SUPPLEMENTARY_INVOICE",
                bookingId: "booking_1",
                priceDiffCents: 20000,
                changeFeeCents: 0,
                bookingModificationId: null,
              },
            },
          ]
        : []
    );

    await expect(
      enqueueXeroSupplementaryInvoiceOperation({
        bookingId: "booking_1",
        priceDiffCents: 23000,
        changeFeeCents: 0,
      })
    ).resolves.toMatchObject({ outcome: "covers-total" });

    expect(mocks.updateManyOperation).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          requestPayload: expect.objectContaining({ priceDiffCents: 23000 }),
          // The key moves with the anchor's model, not only with the amount:
          // `booking:`, never `booking-mod:`.
          correlationKey: expect.stringContaining("booking:booking_1"),
        }),
      })
    );
  });
});

/**
 * #3181: A RECOVERED ADDITIONAL PAYMENT RAISES EXACTLY ONE SUPPLEMENTARY INVOICE.
 *
 * The defect: the inline edit path skips the supplementary invoice while no
 * additional PaymentIntent exists, and the recovery replay that later mints one
 * only ever ATTACHED it to an operation already waiting. Nothing was waiting,
 * because the inline attempt had skipped it - so the member got a collectable
 * payment request and the club's accounts got no invoice.
 *
 * WHY THESE RUN AGAINST THE REAL ENQUEUE. "Exactly one" is a property of
 * `enqueueXeroSupplementaryInvoiceOperation`'s anchor-scoped link-check ->
 * queued-check -> write, and its dedupe DROPS A SECOND ATTEMPT SILENTLY - so a
 * fix that queues nothing at all and a fix that queues correctly look identical
 * to a caller-side double. The store below models the two tables that decision
 * reads, and every assertion counts the rows really created.
 *
 * WHAT THEY DO NOT PROVE: that two CONCURRENT settlements serialise. That is a
 * property of the per-anchor advisory lock and belongs to
 * `edit-financial-review-races.realdb.test.ts`, which proves it against a real
 * server. The replay case is sequential by construction - one cron worker, one
 * claimed operation - so this is the right instrument for it.
 */
describe("a recovered additional payment raises exactly one supplementary invoice (#3181)", () => {
  type StoredOperation = {
    id: string;
    localModel: string;
    localId: string;
    status: string;
    requestPayload: Record<string, unknown>;
  };

  const OUTSTANDING = ["PENDING", "RUNNING", "WAITING_PAYMENT"];
  const RESTATABLE = ["PENDING", "WAITING_PAYMENT"];

  let store: StoredOperation[] = [];

  /** Every supplementary-invoice row the enqueue created for this anchor. */
  function supplementaryRowsFor(localId: string) {
    return store.filter(
      (row) =>
        row.localId === localId &&
        row.requestPayload.queueType === "SUPPLEMENTARY_INVOICE",
    );
  }

  /**
   * EVERY row of any kind for this anchor, which is what a "raises nothing" case
   * has to assert over (#3181 fix round).
   *
   * `supplementaryRowsFor` filters on `queueType`, so it is blind to exactly the
   * row a wrong answer here would create: handed a reduction, the settlement
   * dispatcher does not do nothing, it queues a MODIFICATION_CREDIT_NOTE - a
   * refund to the member, from a function named for an invoice. Asserting the
   * absence of one row type proved nothing about the other, and the negative-net
   * case below passed for that reason rather than because it was right.
   */
  function allRowsFor(localId: string) {
    return store.filter((row) => row.localId === localId);
  }

  beforeEach(() => {
    vi.clearAllMocks();
    store = [];
    mocks.findFirstLink.mockResolvedValue(null);
    mocks.findUniqueBooking.mockResolvedValue({
      id: "booking_1",
      payment: { xeroInvoiceId: "inv_existing" },
    });
    mocks.isXeroConnected.mockResolvedValue(false);

    mocks.startXeroSyncOperation.mockImplementation(
      (args: Record<string, unknown>) => {
        const row: StoredOperation = {
          id: `op_${store.length + 1}`,
          localModel: String(args.localModel),
          localId: String(args.localId),
          status: String(args.status ?? "PENDING"),
          requestPayload: args.requestPayload as Record<string, unknown>,
        };
        store.push(row);
        return Promise.resolve({ id: row.id });
      },
    );
    mocks.findFirstOperation.mockImplementation(
      (args: { where?: { localId?: string } }) =>
        Promise.resolve(
          store.find(
            (row) =>
              row.localId === args.where?.localId &&
              row.requestPayload.queueType === "SUPPLEMENTARY_INVOICE" &&
              OUTSTANDING.includes(row.status),
          ) ?? null,
        ),
    );
    mocks.findManyOperations.mockImplementation(
      (args: { where?: { localId?: string } }) =>
        Promise.resolve(
          store.filter(
            (row) =>
              row.localId === args.where?.localId &&
              row.requestPayload.queueType === "SUPPLEMENTARY_INVOICE" &&
              RESTATABLE.includes(row.status),
          ),
        ),
    );
    mocks.updateManyOperation.mockImplementation(
      (args: { where?: { id?: string }; data?: Record<string, unknown> }) => {
        const row = store.find((candidate) => candidate.id === args.where?.id);
        if (!row || !RESTATABLE.includes(row.status)) {
          return Promise.resolve({ count: 0 });
        }
        row.requestPayload = args.data?.requestPayload as Record<
          string,
          unknown
        >;
        return Promise.resolve({ count: 1 });
      },
    );
  });

  /** The recovery replay, once the intent it was waiting for exists. */
  function recoverIntent(paymentIntentId = "pi_recovered") {
    return completeDeferredXeroSupplementaryInvoice({
      bookingId: "booking_1",
      bookingModificationId: "mod_1",
      paymentIntentId,
      priceDiffCents: 4500,
      changeFeeCents: 500,
      hasIssuedXeroInvoice: true,
      originalPaymentStatus: "SUCCEEDED",
    });
  }

  /** The ordinary edit dispatch, whose mint either succeeded or did not. */
  function dispatchInlineEdit(additionalPaymentIntentId: string | null) {
    return queueXeroBookingEditSettlement({
      bookingId: "booking_1",
      bookingModificationId: "mod_1",
      hasIssuedXeroInvoice: true,
      originalPaymentStatus: "SUCCEEDED",
      priceDiffCents: 4500,
      changeFeeCents: 500,
      requiresAdditionalStripePayment: true,
      additionalPaymentIntentId,
    });
  }

  it("raises one invoice, waiting on the recovered intent and recording its payment", async () => {
    await expect(recoverIntent()).resolves.toBe("covers-total");

    const rows = supplementaryRowsFor("mod_1");
    expect(rows).toHaveLength(1);
    expect(rows[0].status).toBe("WAITING_PAYMENT");
    expect(rows[0].requestPayload).toMatchObject({
      bookingId: "booking_1",
      bookingModificationId: "mod_1",
      paymentIntentId: "pi_recovered",
      waitForConfirmedAdditionalPayment: true,
      recordPayment: true,
      priceDiffCents: 4500,
      changeFeeCents: 500,
    });
  });

  it("raises no second invoice when the recovery replays", async () => {
    await recoverIntent();
    await recoverIntent();

    expect(supplementaryRowsFor("mod_1")).toHaveLength(1);
    expect(mocks.startXeroSyncOperation).toHaveBeenCalledTimes(1);
  });

  /**
   * THE REGRESSION ANCHOR. The first call is the edit whose mint failed: it must
   * queue nothing, because there is nothing to invoice against yet. The second is
   * the replay, which must queue the one invoice the first deferred. Make the
   * deferral queue eagerly and the first assertion fails; remove the completion
   * and the second does.
   */
  it("queues nothing while no intent exists, and the recovery then queues exactly one", async () => {
    await dispatchInlineEdit(null);
    expect(supplementaryRowsFor("mod_1")).toHaveLength(0);

    await recoverIntent();
    expect(supplementaryRowsFor("mod_1")).toHaveLength(1);
  });

  /**
   * CONTROL: the ordinary path, whose mint succeeded, is untouched - one invoice,
   * queued inline. A recovery replay arriving behind it finds that invoice and
   * adds nothing.
   */
  it("leaves the inline path raising exactly one, and adds none behind it", async () => {
    await dispatchInlineEdit("pi_inline");

    const inlineRows = supplementaryRowsFor("mod_1");
    expect(inlineRows).toHaveLength(1);
    expect(inlineRows[0].requestPayload).toMatchObject({
      paymentIntentId: "pi_inline",
      waitForConfirmedAdditionalPayment: true,
    });

    await recoverIntent();
    expect(supplementaryRowsFor("mod_1")).toHaveLength(1);
  });

  /**
   * CONTROL. An invoice that has already been SENT carries an active link on the
   * anchor, and the enqueue refuses to queue a second behind it. `short-sent`
   * rather than `covers-total` is what tells the caller the difference is owed
   * outside the invoice; reporting success here would hide it.
   */
  it("refuses a second invoice for an anchor that already has a sent one", async () => {
    mocks.findFirstLink.mockResolvedValue({ id: "link_1" });

    await expect(recoverIntent()).resolves.toBe("short-sent");
    expect(supplementaryRowsFor("mod_1")).toHaveLength(0);
  });

  /**
   * CONTROL. A booking with no primary Xero invoice has nothing to supplement, so
   * the recovery must not invent one - `none` is not a shortfall and not a
   * success.
   */
  it("raises nothing for a booking with no primary Xero invoice", async () => {
    mocks.findUniqueBooking.mockResolvedValue({
      id: "booking_1",
      payment: { xeroInvoiceId: null },
    });

    await expect(
      completeDeferredXeroSupplementaryInvoice({
        bookingId: "booking_1",
        bookingModificationId: "mod_1",
        paymentIntentId: "pi_recovered",
        priceDiffCents: 4500,
        changeFeeCents: 500,
        hasIssuedXeroInvoice: false,
        originalPaymentStatus: "SUCCEEDED",
      }),
    ).resolves.toBe("none");
    expect(supplementaryRowsFor("mod_1")).toHaveLength(0);
  });

  /**
   * CONTROL, AND IT ASSERTS OVER EVERY ROW BECAUSE THE FIRST VERSION DID NOT.
   *
   * A mixed-sign edit whose net is not positive settles through the credit-note
   * paths; the recovery must not gross-bill the fee (#1356). The earlier form of
   * this test asserted `"none"` and zero SUPPLEMENTARY rows, and both passed
   * while the dispatcher queued a $40 MODIFICATION_CREDIT_NOTE - a refund to the
   * member, issued by a function called "complete the deferred supplementary
   * invoice", reached from a replay whose whole subject is money the member OWES.
   * A non-positive net now returns before the dispatcher, so nothing at all is
   * queued, and `allRowsFor` is what can tell the difference.
   */
  it("raises nothing at all when the edit's net is not positive", async () => {
    await expect(
      completeDeferredXeroSupplementaryInvoice({
        bookingId: "booking_1",
        bookingModificationId: "mod_1",
        paymentIntentId: "pi_recovered",
        priceDiffCents: -4500,
        changeFeeCents: 500,
        hasIssuedXeroInvoice: true,
        originalPaymentStatus: "SUCCEEDED",
      }),
    ).resolves.toBe("none");
    expect(allRowsFor("mod_1")).toHaveLength(0);
  });

  /**
   * The boundary itself: a net of exactly zero is not a positive delta, and it is
   * the shape a parked review edit leaves behind (`priceDiffCents +
   * changeFeeCents == 0`), so it is the one most likely to arrive here.
   *
   * IT IS NOT THIS CASE THAT HOLDS THE EARLY RETURN UP, and saying so is the
   * honest version (#3181 delta review). Deleting the `<= 0` guard in
   * `completeDeferredXeroSupplementaryInvoice` was measured: the not-positive
   * test above FAILS, and this one still passes, because `-500 + 500` reaches
   * `classifyXeroBookingEditSettlement` and falls through its own zero branch to
   * `"none"` anyway. So this pins behaviour at the boundary and the case above is
   * the one that bites the guard. Both are kept: a zero net must stay refused
   * whichever layer refuses it, and the layer is free to move.
   */
  it("raises nothing at all when the edit's net is exactly zero", async () => {
    await expect(
      completeDeferredXeroSupplementaryInvoice({
        bookingId: "booking_1",
        bookingModificationId: "mod_1",
        paymentIntentId: "pi_recovered",
        priceDiffCents: -500,
        changeFeeCents: 500,
        hasIssuedXeroInvoice: true,
        originalPaymentStatus: "SUCCEEDED",
      }),
    ).resolves.toBe("none");
    expect(allRowsFor("mod_1")).toHaveLength(0);
  });

  /**
   * CONTROL for both of those: the same assertion over EVERY row still sees the
   * one invoice a positive net raises, so "nothing at all" is a real refusal
   * rather than an instrument that cannot see anything.
   */
  it("still queues exactly one row in total for a positive net", async () => {
    await recoverIntent();

    expect(allRowsFor("mod_1")).toHaveLength(1);
    expect(allRowsFor("mod_1")[0].requestPayload.queueType).toBe(
      "SUPPLEMENTARY_INVOICE",
    );
  });
});
