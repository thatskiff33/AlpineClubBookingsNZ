import { beforeEach, describe, expect, it, vi } from "vitest";
import { Invoice, LineAmountTypes } from "xero-node";

const mocks = vi.hoisted(() => ({
  chargeFind: vi.fn(),
  chargeUpdate: vi.fn(),
  txChargeUpdateMany: vi.fn(),
  txChargeFindUnique: vi.fn(),
  memberSubscriptionUpdateMany: vi.fn(),
  linkUpsert: vi.fn(),
  transaction: vi.fn(),
  getInvoices: vi.fn(),
  createInvoices: vi.fn(),
  emailInvoice: vi.fn(),
  complete: vi.fn(),
  findContact: vi.fn(),
  events: [] as string[],
}));

vi.mock("@/lib/xero-tax-anchors", () => import("./support/xero-tax-anchors-baseline"));
vi.mock("@/lib/prisma", () => ({
  prisma: {
    environmentSafetySettings: { findUnique: vi.fn().mockResolvedValue(null) },
    // #4098: the already-paid conflict write is a status-guarded updateMany.
    membershipSubscriptionCharge: { findUnique: mocks.chargeFind, update: mocks.chargeUpdate, updateMany: mocks.chargeUpdate },
    memberSubscription: { updateMany: mocks.memberSubscriptionUpdateMany },
    xeroObjectLink: { upsert: mocks.linkUpsert },
    $transaction: mocks.transaction,
  },
}));
vi.mock("@/lib/xero-api-client", () => ({
  getAuthenticatedXeroClient: vi.fn().mockResolvedValue({
    tenantId: "tenant-1",
    xero: { accountingApi: {
      getInvoices: mocks.getInvoices,
      createInvoices: mocks.createInvoices,
      emailInvoice: mocks.emailInvoice,
    } },
  }),
  callXeroApi: vi.fn(async (callback: () => Promise<unknown>) => callback()),
}));
vi.mock("@/lib/xero-contacts", () => ({ findOrCreateXeroContact: mocks.findContact }));
vi.mock("@/lib/xero-sync", () => ({
  buildXeroIdempotencyKey: vi.fn((...parts: unknown[]) => parts.join(":")),
  completeXeroSyncOperation: mocks.complete,
  startXeroSyncOperation: vi.fn(),
}));
vi.mock("@/lib/logger", () => ({ default: { warn: vi.fn(), info: vi.fn(), error: vi.fn() } }));

import { createXeroMembershipSubscriptionInvoice } from "@/lib/xero-subscription-invoices";
import { declareEnvironmentRole } from "@/lib/__tests__/helpers/environment-role";
import { xeroClaim } from "@/lib/__tests__/helpers/xero-claim";

function charge(overrides: Record<string, unknown> = {}) {
  return {
    id: "charge-1",
    billingBasis: "PER_MEMBER",
    recipientMemberId: "member-1",
    xeroAccountCode: "203",
    xeroItemCode: "SUB",
    xeroInvoiceId: null,
    xeroInvoiceNumber: null,
    xeroInvoiceAdopted: false,
    invoicePersistedAt: null,
    invoiceReference: "MEMSUB-charge-1",
    chargedAmountCents: 12_000,
    membershipTypeName: "Full",
    seasonYear: 2026,
    coveredMonths: 12,
    dueDays: 30,
    coverage: [{ memberName: "Bill Member", subscription: { id: "subscription-1", status: "NOT_INVOICED", manuallyMarkedPaidAt: null } }],
    // The prod query includes charge components (#1932, E6); a legacy charge
    // with none takes the synthetic single-line fallback these tests assert.
    components: [],
    ...overrides,
  };
}

function providerInvoice(overrides: Partial<Invoice> = {}): Invoice {
  return {
    invoiceID: "invoice-1",
    invoiceNumber: "INV-1",
    type: Invoice.TypeEnum.ACCREC,
    status: Invoice.StatusEnum.AUTHORISED,
    reference: "MEMSUB-charge-1",
    contact: { contactID: "contact-1" },
    lineAmountTypes: LineAmountTypes.Inclusive,
    date: "2026-07-01",
    dueDate: "2026-07-31",
    total: 120,
    lineItems: [{ accountCode: "203", itemCode: "SUB", taxType: "OUTPUT2", quantity: 1, unitAmount: 120, lineAmount: 120 }],
    ...overrides,
  };
}

/*
  #3035 (ENV-SAFETY 2): asking Xero to email an invoice is a provider SEND, so it
  now goes through the environment-safety boundary. Both halves of the role have
  to be declared or it resolves UNKNOWN and no invoice is emailed — a missing
  `environmentSafetySettings` delegate is an UNREADABLE override, not "no
  override". See src/lib/__tests__/helpers/environment-role.ts.
*/
beforeEach(() => {
  declareEnvironmentRole("production");
});

describe("subscription invoice delivery behavior", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.events.length = 0;
    mocks.findContact.mockResolvedValue("contact-1");
    mocks.memberSubscriptionUpdateMany.mockResolvedValue({ count: 1 });
    mocks.txChargeUpdateMany.mockResolvedValue({ count: 1 });
    mocks.chargeUpdate.mockResolvedValue({ count: 1 });
    mocks.getInvoices.mockResolvedValue({ body: { invoices: [] } });
    mocks.createInvoices.mockImplementation(async () => {
      mocks.events.push("create");
      return { body: { invoices: [providerInvoice()] } };
    });
    mocks.emailInvoice.mockImplementation(async () => {
      mocks.events.push("email");
      return { body: {} };
    });
    mocks.transaction.mockImplementation(async (callback: (tx: unknown) => unknown) => {
      mocks.events.push("persist");
      return callback({
        membershipSubscriptionCharge: { updateMany: mocks.txChargeUpdateMany, findUnique: mocks.txChargeFindUnique },
        memberSubscription: { updateMany: mocks.memberSubscriptionUpdateMany },
        xeroObjectLink: { upsert: mocks.linkUpsert },
      });
    });
  });

  it("persists a created invoice before email and retries only email after partial failure", async () => {
    mocks.chargeFind
      .mockResolvedValueOnce(charge())
      .mockResolvedValueOnce(charge({
        xeroInvoiceId: "invoice-1",
        xeroInvoiceNumber: "INV-1",
        invoicePersistedAt: new Date("2026-07-13T00:00:00.000Z"),
      }));
    mocks.emailInvoice.mockRejectedValueOnce(new Error("mail unavailable")).mockResolvedValueOnce({ body: {} });

    await createXeroMembershipSubscriptionInvoice({ chargeId: "charge-1", syncOperation: xeroClaim("op-1") });
    expect(mocks.events.slice(0, 2)).toEqual(["create", "persist"]);
    expect(mocks.transaction.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.emailInvoice.mock.invocationCallOrder[0]
    );
    expect(mocks.chargeUpdate).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ status: "EMAIL_FAILED", lastErrorCode: "EMAIL_FAILED" }),
    }));

    await createXeroMembershipSubscriptionInvoice({ chargeId: "charge-1", syncOperation: xeroClaim("op-2") });
    expect(mocks.createInvoices).toHaveBeenCalledTimes(1);
    expect(mocks.getInvoices).toHaveBeenCalledTimes(1);
    expect(mocks.emailInvoice).toHaveBeenCalledTimes(2);
    expect(mocks.complete).toHaveBeenLastCalledWith(expect.objectContaining({ id: "op-2" }), expect.objectContaining({ xeroObjectId: "invoice-1" }));
  });

  // #3971: a FAILED row retried from Xero Operations can be claimed after
  // another attempt for the same charge already invoiced and emailed it.
  it("does nothing for a charge already invoiced and emailed, and records the invoice on the row", async () => {
    mocks.chargeFind.mockResolvedValue(charge({
      status: "EMAILED",
      xeroInvoiceId: "invoice-1",
      xeroInvoiceNumber: "INV-1",
      emailSentAt: new Date("2026-06-20T00:00:00.000Z"),
    }));

    await expect(
      createXeroMembershipSubscriptionInvoice({ chargeId: "charge-1", syncOperation: xeroClaim("op-3") }),
    ).resolves.toBe("invoice-1");

    expect(mocks.getInvoices).not.toHaveBeenCalled();
    expect(mocks.createInvoices).not.toHaveBeenCalled();
    expect(mocks.emailInvoice).not.toHaveBeenCalled();
    expect(mocks.chargeUpdate).not.toHaveBeenCalled();
    expect(mocks.complete).toHaveBeenCalledWith(expect.objectContaining({ id: "op-3" }), expect.objectContaining({
      responsePayload: { skipped: true, reason: "ALREADY_EMAILED" },
      xeroObjectId: "invoice-1",
    }));
  });

  it("adopts and emails an exact AUTHORISED invoice", async () => {
    mocks.chargeFind.mockResolvedValue(charge());
    mocks.getInvoices.mockResolvedValue({ body: { invoices: [providerInvoice()] } });
    await createXeroMembershipSubscriptionInvoice({ chargeId: "charge-1", syncOperation: xeroClaim("op-1") });
    expect(mocks.createInvoices).not.toHaveBeenCalled();
    expect(mocks.emailInvoice).toHaveBeenCalledWith("tenant-1", "invoice-1", expect.anything(), expect.any(String));
    expect(mocks.events[0]).toBe("persist");
    expect(mocks.transaction.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.emailInvoice.mock.invocationCallOrder[0]
    );
  });

  /*
    #3035 (ENV-SAFETY 2, INV-CONFIG-004). The charge stays at INVOICE_CREATED and
    its email attempt count is untouched: nothing was attempted, so EMAIL_FAILED
    would be a lie, and INVOICE_CREATED is also the state the admin
    subscription-billing panel already offers Retry on.
  */
  it("raises the invoice but emails nobody on a confirmed copy, and does not mark the charge EMAIL_FAILED", async () => {
    declareEnvironmentRole("non-production");
    mocks.chargeFind.mockResolvedValue(charge());
    mocks.getInvoices.mockResolvedValue({ body: { invoices: [providerInvoice()] } });

    await createXeroMembershipSubscriptionInvoice({ chargeId: "charge-1", syncOperation: xeroClaim("op-1") });

    expect(mocks.emailInvoice).not.toHaveBeenCalled();
    for (const call of mocks.chargeUpdate.mock.calls) {
      expect(call[0].data.status).not.toBe("EMAIL_FAILED");
      expect(call[0].data.status).not.toBe("EMAILED");
      expect(call[0].data).not.toHaveProperty("emailAttemptCount");
    }
    // Nothing failed, so nothing is reported as a failure.
    expect(mocks.complete).toHaveBeenLastCalledWith(expect.objectContaining({ id: "op-1" }), expect.objectContaining({
      status: "SUCCEEDED",
      responsePayload: expect.objectContaining({
        emailError: null,
        invoiceEmailWithheldForEnvironment: true,
      }),
    }));
  });

  it("reports PARTIAL, without an EMAIL_FAILED charge, when nobody has said what this installation is", async () => {
    vi.stubEnv("APP_ENVIRONMENT_ROLE", "");
    mocks.chargeFind.mockResolvedValue(charge());
    mocks.getInvoices.mockResolvedValue({ body: { invoices: [providerInvoice()] } });

    await createXeroMembershipSubscriptionInvoice({ chargeId: "charge-1", syncOperation: xeroClaim("op-1") });

    expect(mocks.emailInvoice).not.toHaveBeenCalled();
    for (const call of mocks.chargeUpdate.mock.calls) {
      expect(call[0].data.status).not.toBe("EMAIL_FAILED");
    }
    expect(mocks.complete).toHaveBeenLastCalledWith(expect.objectContaining({ id: "op-1" }), expect.objectContaining({
      status: "PARTIAL",
      responsePayload: expect.objectContaining({
        emailError: expect.any(String),
        invoiceEmailWithheldForEnvironment: false,
      }),
    }));
  });

  it("conflicts instead of invoicing when a covered subscription is already PAID (#1944)", async () => {
    // A charge QUEUED (or retrying) before a treasurer manually marks the
    // subscription paid must never mint an invoice or downgrade the row.
    mocks.chargeFind.mockResolvedValue(charge({
      coverage: [{
        memberName: "Cash Payer",
        subscription: { id: "subscription-1", status: "PAID", manuallyMarkedPaidAt: new Date("2026-07-01T00:00:00.000Z") },
      }],
    }));

    const result = await createXeroMembershipSubscriptionInvoice({ chargeId: "charge-1", syncOperation: xeroClaim("op-1") });

    expect(result).toBeNull();
    expect(mocks.getInvoices).not.toHaveBeenCalled();
    expect(mocks.createInvoices).not.toHaveBeenCalled();
    expect(mocks.emailInvoice).not.toHaveBeenCalled();
    expect(mocks.memberSubscriptionUpdateMany).not.toHaveBeenCalled();
    expect(mocks.chargeUpdate).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ status: "CONFLICT", lastErrorCode: "SUBSCRIPTION_ALREADY_PAID" }),
    }));
    expect(mocks.complete).toHaveBeenCalledWith(expect.objectContaining({ id: "op-1" }), expect.objectContaining({
      responsePayload: expect.objectContaining({ conflict: "SUBSCRIPTION_ALREADY_PAID", manuallyMarkedPaid: true }),
    }));
    // #4098: the write cannot reopen a charge an officer closed meanwhile.
    expect(mocks.chargeUpdate).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: "charge-1", status: { notIn: ["NOT_REQUIRED", "VOIDED"] } },
    }));
    // #4098: the message names the real choices, not a "resolve" action that
    // never existed.
    expect(mocks.chargeUpdate).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        lastErrorMessage: "Covered subscription is already PAID (Cash Payer); no Xero invoice was created. Close it as already paid on the Subscriptions page, or reverse the payment (Mark as unpaid on the subscription, or void it in Xero) and Retry.",
      }),
    }));
  });

  it("tells a partly paid charge to reverse the payment or finish paying, not to close (#4098)", async () => {
    // The worker conflicts when ANY covered subscription is PAID, but the close
    // needs EVERY one paid, so a partly paid charge is told how to finish it.
    mocks.chargeFind.mockResolvedValue(charge({
      coverage: [
        { memberName: "Cash Payer", subscription: { id: "subscription-1", status: "PAID", manuallyMarkedPaidAt: new Date("2026-07-01T00:00:00.000Z") } },
        { memberName: "Still Owing", subscription: { id: "subscription-2", status: "NOT_INVOICED", manuallyMarkedPaidAt: null } },
      ],
    }));

    await createXeroMembershipSubscriptionInvoice({ chargeId: "charge-1", syncOperation: xeroClaim("op-1") });

    expect(mocks.createInvoices).not.toHaveBeenCalled();
    expect(mocks.chargeUpdate).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        status: "CONFLICT",
        lastErrorMessage: "Covered subscription is already PAID (Cash Payer); no Xero invoice was created. Not every covered subscription is paid (or not required), so it can't be closed as paid. Either record the remaining payments and then close it, or reverse every payment recorded for it (Mark as unpaid on the subscription, or void it in Xero) and then Retry to invoice the whole charge.",
      }),
    }));
  });

  it("offers the close when the only other covered member is exempt (NOT_REQUIRED) — owner decision on #4110", async () => {
    mocks.chargeFind.mockResolvedValue(charge({
      coverage: [
        { memberName: "Cash Payer", releasedAt: null, subscription: { id: "subscription-1", status: "PAID", manuallyMarkedPaidAt: new Date("2026-07-01T00:00:00.000Z") } },
        { memberName: "Cub Exempt", releasedAt: null, subscription: { id: "subscription-2", status: "NOT_REQUIRED", manuallyMarkedPaidAt: null } },
      ],
    }));

    await createXeroMembershipSubscriptionInvoice({ chargeId: "charge-1", syncOperation: xeroClaim("op-1") });

    expect(mocks.createInvoices).not.toHaveBeenCalled();
    expect(mocks.chargeUpdate).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        lastErrorMessage: expect.stringContaining("Close it as already paid on the Subscriptions page"),
      }),
    }));
  });

  it("records the invoice with a status-guarded write, and emails through guarded writes too (#4098 review)", async () => {
    mocks.chargeFind.mockResolvedValue(charge());

    await createXeroMembershipSubscriptionInvoice({ chargeId: "charge-1", syncOperation: xeroClaim("op-1") });

    const liveOnly = { id: "charge-1", status: { notIn: ["NOT_REQUIRED", "VOIDED"] } };
    expect(mocks.txChargeUpdateMany).toHaveBeenCalledWith(expect.objectContaining({
      where: liveOnly,
      data: expect.objectContaining({ status: "INVOICE_CREATED", xeroInvoiceId: "invoice-1" }),
    }));
    expect(mocks.chargeUpdate).toHaveBeenCalledWith(expect.objectContaining({
      where: liveOnly,
      data: expect.objectContaining({ status: "EMAILED" }),
    }));
  });

  it("a close landing while the invoice was in Xero leaves a stray to void, written in the same transaction: nothing linked, nothing downgraded, no email (#4098 review)", async () => {
    // RUNNING -> close -> success: the worker read the charge QUEUED, Xero raised
    // the invoice, and by the time it records it the officer has closed the
    // charge, so the guarded INVOICE_CREATED write matches nothing.
    mocks.chargeFind.mockResolvedValue(charge());
    mocks.txChargeUpdateMany.mockResolvedValueOnce({ count: 0 }).mockResolvedValueOnce({ count: 1 });
    mocks.txChargeFindUnique.mockResolvedValue({ status: "NOT_REQUIRED", billingBasis: "PER_MEMBER" });

    const result = await createXeroMembershipSubscriptionInvoice({ chargeId: "charge-1", syncOperation: xeroClaim("op-1") });

    expect(result).toBeNull();
    expect(mocks.createInvoices).toHaveBeenCalledTimes(1);
    expect(mocks.memberSubscriptionUpdateMany).not.toHaveBeenCalled();
    expect(mocks.linkUpsert).not.toHaveBeenCalled();
    expect(mocks.emailInvoice).not.toHaveBeenCalled();
    // The stray marker is the SECOND write inside the recording transaction
    // (crash-safe with the lost claim), and nothing is written outside it.
    expect(mocks.chargeUpdate).not.toHaveBeenCalled();
    expect(mocks.txChargeUpdateMany).toHaveBeenNthCalledWith(2, {
      where: { id: "charge-1", status: "NOT_REQUIRED" },
      data: {
        lastErrorCode: "STRAY_INVOICE_AFTER_CLOSE",
        lastErrorMessage: expect.stringMatching(/^This charge was closed as already paid while Xero invoice INV-1 was being raised for it\. .*Void it in Xero promptly: until then the membership sync may attach it to the recipient's subscription\. This note stays on the closed charge as the record/),
      },
    });
    expect(mocks.complete).toHaveBeenCalledWith(expect.objectContaining({ id: "op-1" }), expect.objectContaining({
      status: "PARTIAL",
      responsePayload: expect.objectContaining({ conflict: "STRAY_INVOICE_AFTER_CLOSE", email: null }),
      xeroObjectId: "invoice-1",
      xeroObjectNumber: "INV-1",
    }));
  });

  it("a charge VOIDED while the attempt was in Xero is finished, not marked a stray (#4098 review)", async () => {
    mocks.chargeFind.mockResolvedValue(charge());
    mocks.txChargeUpdateMany.mockResolvedValueOnce({ count: 0 });
    mocks.txChargeFindUnique.mockResolvedValue({ status: "VOIDED", billingBasis: "PER_MEMBER" });

    await createXeroMembershipSubscriptionInvoice({ chargeId: "charge-1", syncOperation: xeroClaim("op-1") });

    expect(mocks.txChargeUpdateMany).toHaveBeenCalledTimes(1);
    expect(mocks.emailInvoice).not.toHaveBeenCalled();
    expect(mocks.complete).toHaveBeenCalledWith(expect.objectContaining({ id: "op-1" }), { responsePayload: { skipped: true, reason: "VOIDED" } });
  });

  it("a resume of an invoice the charge already held is finished, not marked a stray, when the charge was voided meanwhile (#4098 review)", async () => {
    // Resume path: the charge already carries its invoice (email retry), so this
    // attempt raised nothing new. The void sync voided it in Xero meanwhile.
    mocks.chargeFind.mockResolvedValue(charge({
      xeroInvoiceId: "invoice-1", xeroInvoiceNumber: "INV-1", invoicePersistedAt: new Date("2026-07-13T00:00:00.000Z"),
    }));
    mocks.getInvoices.mockResolvedValue({ body: { invoices: [providerInvoice()] } });
    mocks.txChargeUpdateMany.mockResolvedValueOnce({ count: 0 });
    mocks.txChargeFindUnique.mockResolvedValue({ status: "VOIDED", billingBasis: "PER_MEMBER" });

    await createXeroMembershipSubscriptionInvoice({ chargeId: "charge-1", syncOperation: xeroClaim("op-1") });

    expect(mocks.createInvoices).not.toHaveBeenCalled();
    expect(mocks.txChargeUpdateMany).toHaveBeenCalledTimes(1);
    expect(mocks.emailInvoice).not.toHaveBeenCalled();
    expect(mocks.complete).toHaveBeenCalledWith(expect.objectContaining({ id: "op-1" }), { responsePayload: { skipped: true, reason: "VOIDED" } });
  });

  it("a resume never marks a stray even if it reads the charge closed: it raised no new invoice (#4098 review)", async () => {
    mocks.chargeFind.mockResolvedValue(charge({
      xeroInvoiceId: "invoice-1", xeroInvoiceNumber: "INV-1", invoicePersistedAt: new Date("2026-07-13T00:00:00.000Z"),
    }));
    mocks.txChargeUpdateMany.mockResolvedValueOnce({ count: 0 });
    mocks.txChargeFindUnique.mockResolvedValue({ status: "NOT_REQUIRED", billingBasis: "PER_MEMBER" });

    await createXeroMembershipSubscriptionInvoice({ chargeId: "charge-1", syncOperation: xeroClaim("op-1") });

    expect(mocks.txChargeUpdateMany).toHaveBeenCalledTimes(1);
    expect(mocks.complete).toHaveBeenCalledWith(expect.objectContaining({ id: "op-1" }), { responsePayload: { skipped: true, reason: "NOT_REQUIRED" } });
  });

  it("skips a charge an officer closed as already paid, with no provider call (#4098)", async () => {
    mocks.chargeFind.mockResolvedValue(charge({ status: "NOT_REQUIRED" }));

    const result = await createXeroMembershipSubscriptionInvoice({ chargeId: "charge-1", syncOperation: xeroClaim("op-1") });

    expect(result).toBeNull();
    expect(mocks.findContact).not.toHaveBeenCalled();
    expect(mocks.getInvoices).not.toHaveBeenCalled();
    expect(mocks.createInvoices).not.toHaveBeenCalled();
    expect(mocks.chargeUpdate).not.toHaveBeenCalled();
    expect(mocks.complete).toHaveBeenCalledWith(expect.objectContaining({ id: "op-1" }), { responsePayload: { skipped: true, reason: "NOT_REQUIRED" } });
  });

  it("resume path still delivers an already-minted invoice but the coverage write is fenced against PAID rows (#1944)", async () => {
    // Once an invoice exists (crash/email retry), the ALREADY_PAID guard does
    // not block delivery — but the UNPAID coverage write must exclude PAID rows
    // so a manual mark-paid landing in the window is never downgraded.
    mocks.chargeFind.mockResolvedValue(charge({
      xeroInvoiceId: "invoice-1",
      xeroInvoiceNumber: "INV-1",
      invoicePersistedAt: new Date("2026-07-13T00:00:00.000Z"),
      coverage: [{
        memberName: "Cash Payer",
        subscription: { id: "subscription-1", status: "PAID", manuallyMarkedPaidAt: new Date("2026-07-01T00:00:00.000Z") },
      }],
    }));
    mocks.memberSubscriptionUpdateMany.mockResolvedValue({ count: 0 });

    await createXeroMembershipSubscriptionInvoice({ chargeId: "charge-1", syncOperation: xeroClaim("op-1") });

    expect(mocks.createInvoices).not.toHaveBeenCalled();
    expect(mocks.memberSubscriptionUpdateMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({ status: { not: "PAID" } }),
      data: expect.objectContaining({ status: "UNPAID" }),
    }));
  });

  it.each([
    ["mismatched amount", providerInvoice({ total: 119 })],
    ["draft", providerInvoice({ status: Invoice.StatusEnum.DRAFT })],
    ["submitted", providerInvoice({ status: Invoice.StatusEnum.SUBMITTED })],
    ["paid", providerInvoice({ status: Invoice.StatusEnum.PAID })],
  ])("records provider conflict for %s without rewriting or emailing", async (_label, invoice) => {
    mocks.chargeFind.mockResolvedValue(charge());
    mocks.getInvoices.mockResolvedValue({ body: { invoices: [invoice] } });
    await createXeroMembershipSubscriptionInvoice({ chargeId: "charge-1", syncOperation: xeroClaim("op-1") });
    expect(mocks.createInvoices).not.toHaveBeenCalled();
    expect(mocks.emailInvoice).not.toHaveBeenCalled();
    expect(mocks.chargeUpdate).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ status: "CONFLICT", lastErrorCode: "PROVIDER_MISMATCH" }),
    }));
  });
});
