import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
  const tx = {
    $executeRaw: vi.fn(),
    member: {
      findUnique: vi.fn(),
      findFirst: vi.fn(),
      update: vi.fn(),
    },
  };

  const prisma = {
    $transaction: vi.fn(async (callback) => callback(tx)),
    // #1355: contact resolution now reads the member on the GLOBAL client
    // (phase 0/1) and re-reads via the tx client (phase 2). Alias the same
    // mock fns so every existing fixture serves both phases.
    member: tx.member,
    booking: {
      findUnique: vi.fn(),
    },
    season: {
      findFirst: vi.fn(),
    },
    payment: {
      findUnique: vi.fn(),
      update: vi.fn(),
    },
    paymentTransaction: {
      updateMany: vi.fn(),
    },
    xeroObjectLink: {
      findFirst: vi.fn(),
      findMany: vi.fn(),
    },
    xeroToken: {
      findFirst: vi.fn(),
    },
    xeroAccountMapping: {
      findUnique: vi.fn(),
    },
    xeroItemCodeMapping: {
      findMany: vi.fn(),
      findFirst: vi.fn(),
    },
    xeroSyncOperation: {
      update: vi.fn(),
    },
  };

  const xeroClientInstance = {
    initialize: vi.fn().mockResolvedValue(undefined),
    setTokenSet: vi.fn(),
    refreshWithRefreshToken: vi.fn(),
    accountingApi: {
      createInvoices: vi.fn(),
      getInvoice: vi.fn(),
      updateInvoice: vi.fn(),
      createPayment: vi.fn(),
      createPayments: vi.fn(),
      createCreditNoteAllocation: vi.fn(),
      emailInvoice: vi.fn(),
      createCreditNotes: vi.fn(),
      createContacts: vi.fn(),
      getContacts: vi.fn(),
    },
  };

  return {
    prisma,
    tx,
    xeroClientInstance,
    XeroClient: vi.fn(function MockXeroClient() {
      return xeroClientInstance;
    }),
    startXeroSyncOperation: vi.fn(),
    completeXeroSyncOperation: vi.fn(),
    failXeroSyncOperation: vi.fn(),
    findCanonicalPaymentRefundCreditNote: vi.fn(),
    upsertXeroObjectLink: vi.fn(),
    recordXeroApiUsage: vi.fn(),
    // #1641 — the card-path applied-credit allocation engine, dynamically imported
    // by createXeroInvoiceForBooking. Mocked so we assert the gate + placement
    // without re-driving the (separately unit-tested) engine.
    allocateAppliedCreditForBooking: vi.fn(),
    logger: {
      error: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      debug: vi.fn(),
    },
  };
});

vi.mock("xero-node", () => ({
  XeroClient: mocks.XeroClient,
  Contact: class {},
  ContactGroup: class {},
  Invoice: {
    TypeEnum: { ACCREC: "ACCREC" },
    StatusEnum: { AUTHORISED: "AUTHORISED" },
  },
  LineItem: class {},
  LineAmountTypes: { Inclusive: "Inclusive" },
  CreditNote: {
    TypeEnum: { ACCRECCREDIT: "ACCRECCREDIT" },
    StatusEnum: { AUTHORISED: "AUTHORISED" },
  },
  Payment: class {},
  RequestEmpty: class {},
  Phone: {
    PhoneTypeEnum: { MOBILE: "MOBILE" },
  },
  Address: {
    AddressTypeEnum: {
      STREET: "STREET",
      POBOX: "POBOX",
    },
  },
}));

vi.mock("@/lib/prisma", () => ({
  prisma: mocks.prisma,
}));

vi.mock("@/lib/email", () => ({
  sendPasswordResetEmail: vi.fn(),
}));

vi.mock("@/lib/pricing", () => ({
  getSeasonYear: vi.fn(() => 2026),
  getStayNights: vi.fn(() => [new Date("2026-07-31"), new Date("2026-08-01")]),
}));

vi.mock("@/lib/phone", () => ({
  formatXeroPhone: vi.fn(),
}));

vi.mock("@/lib/logger", () => ({
  default: mocks.logger,
}));

vi.mock("@/lib/xero-api-usage", () => ({
  recordXeroApiUsage: mocks.recordXeroApiUsage,
}));

vi.mock("@/lib/xero-links", () => ({
  buildXeroContactUrl: vi.fn((contactId: string) => `https://go.xero.test/contact/${contactId}`),
  buildXeroInvoiceUrl: vi.fn((invoiceId: string) => `https://go.xero.test/invoice/${invoiceId}`),
}));

vi.mock("@/lib/xero-sync", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/xero-sync")>();

  return {
    ...actual,
    buildXeroIdempotencyKey: vi.fn((...parts: unknown[]) => parts.join(":")),
    buildXeroPayloadHash: vi.fn(() => "payload-hash"),
    completeXeroSyncOperation: mocks.completeXeroSyncOperation,
    failXeroSyncOperation: mocks.failXeroSyncOperation,
    findCanonicalPaymentRefundCreditNote: mocks.findCanonicalPaymentRefundCreditNote,
    startXeroSyncOperation: mocks.startXeroSyncOperation,
    upsertXeroObjectLink: mocks.upsertXeroObjectLink,
  };
});

vi.mock("@/lib/xero-applied-credit-allocation", () => ({
  allocateAppliedCreditForBooking: mocks.allocateAppliedCreditForBooking,
}));

import {
  createXeroCreditNoteForModification,
  createXeroCreditNote,
  createXeroInvoiceForBooking,
  createXeroRefundPaymentForInvoice,
  encryptToken,
  resetXeroRateLimitStateForTests,
  updateXeroBookingInvoiceForBooking,
} from "@/lib/xero";

describe("createXeroInvoiceForBooking", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetXeroRateLimitStateForTests();
    vi.stubEnv(
      "XERO_ENCRYPTION_KEY",
      "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"
    );
    vi.stubEnv("XERO_CLIENT_ID", "client-id");
    vi.stubEnv("XERO_CLIENT_SECRET", "client-secret");

    mocks.prisma.$transaction.mockImplementation(async (callback) => callback(mocks.tx));
    mocks.tx.$executeRaw.mockResolvedValue(undefined);
    mocks.tx.member.findUnique.mockResolvedValue({
      id: "mem_1",
      email: "member@example.com",
      xeroContactId: "contact_1",
    });

    mocks.prisma.booking.findUnique.mockResolvedValue({
      id: "booking_1",
      memberId: "mem_1",
      member: { id: "mem_1" },
      checkIn: "2026-07-31T00:00:00.000Z",
      checkOut: "2026-08-02T00:00:00.000Z",
      createdAt: "2026-05-15T10:30:00.000Z",
      discountCents: 10000,
      guests: [
        {
          firstName: "Jordan",
          lastName: "Hartley-Smith",
          ageTier: "ADULT",
          isMember: true,
          priceCents: 10000,
        },
      ],
      payment: {
        id: "pay_1",
        status: "SUCCEEDED",
        amountCents: 0,
        stripePaymentIntentId: null,
        xeroInvoiceId: null,
        xeroInvoiceNumber: null,
        source: "STRIPE",
      },
    });
    mocks.prisma.payment.findUnique.mockResolvedValue(null);
    mocks.prisma.paymentTransaction.updateMany.mockResolvedValue({ count: 0 });
    mocks.prisma.season.findFirst.mockResolvedValue({ type: "WINTER" });
    mocks.prisma.payment.update.mockResolvedValue({ id: "pay_1" });
    mocks.prisma.xeroObjectLink.findFirst.mockResolvedValue(null);
    mocks.prisma.xeroToken.findFirst.mockResolvedValue({
      id: "token_1",
      accessToken: encryptToken("access"),
      refreshToken: encryptToken("refresh"),
      expiresAt: new Date(Date.now() + 60 * 60 * 1000),
      tenantId: "tenant_1",
    });
    mocks.prisma.xeroAccountMapping.findUnique.mockResolvedValue(null);
    mocks.prisma.xeroItemCodeMapping.findMany.mockResolvedValue([]);
    mocks.startXeroSyncOperation.mockResolvedValue({ id: "op_1" });
    mocks.xeroClientInstance.accountingApi.createInvoices.mockResolvedValue({
      body: {
        invoices: [
          {
            invoiceID: "inv_1",
            invoiceNumber: "INV-1",
            total: 0,
            status: "PAID",
          },
        ],
      },
    });
  });

  describe("#1641 card applied-credit allocation", () => {
    function cardPayment(overrides: Record<string, unknown> = {}) {
      return {
        id: "pay_1",
        status: "SUCCEEDED",
        // effective (10000 finalPrice − 3000 applied credit)
        amountCents: 7000,
        creditAppliedCents: 3000,
        stripePaymentIntentId: "pi_1",
        xeroInvoiceId: null,
        xeroInvoiceNumber: null,
        source: "STRIPE",
        ...overrides,
      };
    }

    function cardCreditBooking(paymentOverrides: Record<string, unknown> = {}) {
      return {
        id: "booking_1",
        memberId: "mem_1",
        member: { id: "mem_1" },
        checkIn: "2026-07-31T00:00:00.000Z",
        checkOut: "2026-08-02T00:00:00.000Z",
        createdAt: "2026-05-15T10:30:00.000Z",
        discountCents: 0,
        promoAdjustmentCents: 0,
        guests: [
          {
            firstName: "Jordan",
            lastName: "Hartley-Smith",
            ageTier: "ADULT",
            isMember: true,
            priceCents: 10000,
          },
        ],
        payment: cardPayment(paymentOverrides),
      };
    }

    beforeEach(() => {
      mocks.xeroClientInstance.accountingApi.createPayment.mockResolvedValue({
        body: { paymentID: "xpay_1" },
      });
      mocks.allocateAppliedCreditForBooking.mockResolvedValue(undefined);
      mocks.xeroClientInstance.accountingApi.createInvoices.mockResolvedValue({
        body: {
          invoices: [
            { invoiceID: "inv_1", invoiceNumber: "INV-1", total: 10000, status: "AUTHORISED" },
          ],
        },
      });
    });

    it("allocates the applied credit against a freshly raised card invoice", async () => {
      mocks.prisma.booking.findUnique.mockResolvedValue(cardCreditBooking());

      await expect(createXeroInvoiceForBooking("booking_1")).resolves.toBe("inv_1");

      // Effective Stripe payment recorded, then the credit note allocated so the
      // invoice reaches PAID via (effective cash + credit).
      expect(mocks.xeroClientInstance.accountingApi.createPayment).toHaveBeenCalledTimes(1);
      expect(mocks.allocateAppliedCreditForBooking).toHaveBeenCalledWith(
        "booking_1",
        expect.anything()
      );
    });

    it("does NOT allocate for a legacy full-price card capture (creditAppliedCents = 0)", async () => {
      mocks.prisma.booking.findUnique.mockResolvedValue(
        cardCreditBooking({ amountCents: 10000, creditAppliedCents: 0 })
      );

      await expect(createXeroInvoiceForBooking("booking_1")).resolves.toBe("inv_1");
      expect(mocks.allocateAppliedCreditForBooking).not.toHaveBeenCalled();
    });

    it("does NOT allocate for an Internet-Banking invoice (its own outbox op handles it)", async () => {
      mocks.prisma.booking.findUnique.mockResolvedValue(
        cardCreditBooking({ source: "INTERNET_BANKING", status: "PENDING" })
      );

      await createXeroInvoiceForBooking("booking_1");
      expect(mocks.allocateAppliedCreditForBooking).not.toHaveBeenCalled();
    });

    it("fails the op when allocation rejects, and the retry does not re-create the invoice", async () => {
      mocks.prisma.booking.findUnique.mockResolvedValue(cardCreditBooking());
      mocks.allocateAppliedCreditForBooking.mockRejectedValueOnce(
        new Error("Xero allocation rejected")
      );

      // First run: invoice raised + effective payment recorded, THEN allocation
      // throws -> the op is failed and the function rejects (Q1: loud, not silent).
      await expect(createXeroInvoiceForBooking("booking_1")).rejects.toThrow(
        "Xero allocation rejected"
      );
      expect(mocks.failXeroSyncOperation).toHaveBeenCalled();
      expect(mocks.xeroClientInstance.accountingApi.createInvoices).toHaveBeenCalledTimes(1);

      // Retry: the invoice already exists (xeroInvoiceId persisted before the
      // allocation call), so the early-return path re-drives the idempotent
      // allocation WITHOUT creating a second invoice.
      mocks.xeroClientInstance.accountingApi.createInvoices.mockClear();
      mocks.prisma.booking.findUnique.mockResolvedValue(
        cardCreditBooking({ xeroInvoiceId: "inv_1", xeroInvoiceNumber: "INV-1" })
      );

      await expect(createXeroInvoiceForBooking("booking_1")).resolves.toBe("inv_1");
      expect(mocks.xeroClientInstance.accountingApi.createInvoices).not.toHaveBeenCalled();
      expect(mocks.allocateAppliedCreditForBooking).toHaveBeenCalledTimes(2);
    });
  });

  it("skips Xero payment creation when the booking invoice total is zero", async () => {
    await expect(createXeroInvoiceForBooking("booking_1")).resolves.toBe("inv_1");

    expect(mocks.xeroClientInstance.accountingApi.createInvoices).toHaveBeenCalledTimes(1);
    expect(mocks.xeroClientInstance.accountingApi.createInvoices).toHaveBeenCalledWith(
      "tenant_1",
      {
        invoices: [
          expect.objectContaining({
            date: "2026-07-31",
            dueDate: "2026-05-15",
          }),
        ],
      },
      undefined,
      undefined,
      "booking:booking_1:invoice:v1"
    );
    expect(mocks.xeroClientInstance.accountingApi.createPayment).not.toHaveBeenCalled();
    expect(mocks.xeroClientInstance.accountingApi.emailInvoice).not.toHaveBeenCalled();
    expect(mocks.prisma.payment.update).toHaveBeenCalledWith({
      where: { id: "pay_1" },
      data: {
        xeroInvoiceId: "inv_1",
        xeroInvoiceNumber: "INV-1",
      },
    });
    expect(mocks.completeXeroSyncOperation).toHaveBeenCalledWith(
      "op_1",
      expect.objectContaining({
        status: "SUCCEEDED",
        xeroObjectType: "INVOICE",
        xeroObjectId: "inv_1",
        responsePayload: expect.objectContaining({
          payment: null,
          paymentError: null,
          paymentSkipped: true,
          paymentSkipReason: "Zero-total invoice does not require Xero payment recording.",
          invoiceEmailSkipped: true,
        }),
      })
    );
  });

  it("emails Internet Banking invoices and updates the Internet Banking transaction", async () => {
    mocks.prisma.booking.findUnique.mockResolvedValue({
      id: "booking_1",
      memberId: "mem_1",
      member: { id: "mem_1" },
      checkIn: "2026-07-31T00:00:00.000Z",
      checkOut: "2026-08-02T00:00:00.000Z",
      createdAt: "2026-05-15T10:30:00.000Z",
      discountCents: 0,
      promoAdjustmentCents: 0,
      guests: [
        {
          firstName: "Jordan",
          lastName: "Hartley-Smith",
          ageTier: "ADULT",
          isMember: true,
          priceCents: 10000,
        },
      ],
      payment: {
        id: "pay_1",
        status: "PENDING",
        amountCents: 10000,
        stripePaymentIntentId: null,
        xeroInvoiceId: null,
        xeroInvoiceNumber: null,
        source: "INTERNET_BANKING",
      },
    });
    mocks.xeroClientInstance.accountingApi.emailInvoice.mockResolvedValue({
      body: {},
    });

    await expect(createXeroInvoiceForBooking("booking_1")).resolves.toBe("inv_1");

    expect(mocks.xeroClientInstance.accountingApi.createPayment).not.toHaveBeenCalled();
    expect(mocks.xeroClientInstance.accountingApi.emailInvoice).toHaveBeenCalledWith(
      "tenant_1",
      "inv_1",
      expect.any(Object),
      "booking:booking_1:invoice-email:inv_1:v1"
    );
    expect(mocks.prisma.paymentTransaction.updateMany).toHaveBeenCalledWith({
      where: {
        paymentId: "pay_1",
        source: "INTERNET_BANKING",
        kind: "PRIMARY",
      },
      data: {
        xeroInvoiceId: "inv_1",
        xeroInvoiceNumber: "INV-1",
      },
    });
    expect(mocks.completeXeroSyncOperation).toHaveBeenCalledWith(
      "op_1",
      expect.objectContaining({
        status: "SUCCEEDED",
        responsePayload: expect.objectContaining({
          invoiceEmail: {},
          invoiceEmailSkipped: false,
        }),
      })
    );
  });

  it("does not record settled Internet Banking invoices as Stripe Xero payments", async () => {
    mocks.prisma.booking.findUnique.mockResolvedValue({
      id: "booking_1",
      memberId: "mem_1",
      member: { id: "mem_1" },
      checkIn: "2026-07-31T00:00:00.000Z",
      checkOut: "2026-08-02T00:00:00.000Z",
      createdAt: "2026-05-15T10:30:00.000Z",
      discountCents: 0,
      promoAdjustmentCents: 0,
      guests: [
        {
          firstName: "Jordan",
          lastName: "Hartley-Smith",
          ageTier: "ADULT",
          isMember: true,
          priceCents: 10000,
        },
      ],
      payment: {
        id: "pay_1",
        status: "SUCCEEDED",
        amountCents: 10000,
        stripePaymentIntentId: null,
        xeroInvoiceId: null,
        xeroInvoiceNumber: null,
        source: "INTERNET_BANKING",
      },
    });
    mocks.xeroClientInstance.accountingApi.emailInvoice.mockResolvedValue({
      body: {},
    });

    await expect(createXeroInvoiceForBooking("booking_1")).resolves.toBe("inv_1");

    expect(mocks.xeroClientInstance.accountingApi.createPayment).not.toHaveBeenCalled();
    expect(mocks.xeroClientInstance.accountingApi.emailInvoice).toHaveBeenCalledWith(
      "tenant_1",
      "inv_1",
      expect.any(Object),
      "booking:booking_1:invoice-email:inv_1:v1"
    );
    expect(mocks.completeXeroSyncOperation).toHaveBeenCalledWith(
      "op_1",
      expect.objectContaining({
        status: "SUCCEEDED",
        responsePayload: expect.objectContaining({
          payment: null,
          paymentError: null,
          paymentSkipped: true,
          paymentSkipReason:
            "Internet Banking invoice payments are reconciled from Xero instead of recorded as Stripe bank payments.",
          invoiceEmailSkipped: false,
        }),
      })
    );
  });

  it("updates primary invoice dates and guest line narration without changing amounts", async () => {
    mocks.prisma.booking.findUnique.mockResolvedValue({
      id: "booking_1",
      memberId: "mem_1",
      member: { id: "mem_1" },
      checkIn: "2026-08-03T00:00:00.000Z",
      // A 2-night stay (checkIn + 2 days); getStayNights is mocked to length 2
      // above, so checkOut must be 08-05 for the fixture to be internally
      // consistent. The #1163 price-run splitter derives the line's end date from
      // the night count, so an inconsistent checkOut would misdescribe the range.
      checkOut: "2026-08-05T00:00:00.000Z",
      createdAt: "2026-05-15T10:30:00.000Z",
      discountCents: 0,
      guests: [
        {
          firstName: "Jordan",
          lastName: "Hartley-Smith",
          ageTier: "ADULT",
          isMember: true,
          priceCents: 10000,
        },
      ],
      payment: {
        id: "pay_1",
        status: "SUCCEEDED",
        amountCents: 10000,
        stripePaymentIntentId: "pi_1",
        xeroInvoiceId: "inv_1",
        xeroInvoiceNumber: "INV-1",
      },
    });
    mocks.xeroClientInstance.accountingApi.getInvoice.mockResolvedValue({
      body: {
        invoices: [
          {
            invoiceID: "inv_1",
            invoiceNumber: "INV-1",
            type: "ACCREC",
            contact: { contactID: "contact_1" },
            lineAmountTypes: "Inclusive",
            reference: "Booking booking_",
            lineItems: [
              {
                lineItemID: "line_1",
                description:
                  "Jordan Hartley-Smith - (ADULT, Member) - 1 night - 2026-07-31 - 2026-08-01",
                quantity: 1,
                unitAmount: 100,
                taxType: "OUTPUT2",
                accountCode: "200",
              },
            ],
          },
        ],
      },
    });
    mocks.xeroClientInstance.accountingApi.updateInvoice.mockResolvedValue({
      body: {
        invoices: [
          {
            invoiceID: "inv_1",
            invoiceNumber: "INV-1",
          },
        ],
      },
    });

    await expect(updateXeroBookingInvoiceForBooking("booking_1")).resolves.toBe("inv_1");

    expect(mocks.xeroClientInstance.accountingApi.updateInvoice).toHaveBeenCalledWith(
      "tenant_1",
      "inv_1",
      {
        invoices: [
          expect.objectContaining({
            date: "2026-08-03",
            dueDate: "2026-05-15",
            lineItems: [
              expect.objectContaining({
                lineItemID: "line_1",
                description:
                  "Jordan Hartley-Smith - (ADULT, Member) - 2 nights - 2026-08-03 - 2026-08-05",
                quantity: 1,
                unitAmount: 100,
                taxType: "OUTPUT2",
                accountCode: "200",
              }),
            ],
          }),
        ],
      },
      undefined,
      "booking:booking_1:invoice-update:inv_1:2026-08-03:2026-08-05:v1"
    );
    expect(mocks.completeXeroSyncOperation).toHaveBeenCalledWith(
      "op_1",
      expect.objectContaining({
        xeroObjectType: "INVOICE",
        xeroObjectId: "inv_1",
      })
    );
  });

  describe("promo code discount line coding", () => {
    function bookingWithPromo(promo: {
      code: string;
      xeroItemCode: string | null;
      xeroAccountCode: string | null;
    } | null) {
      return {
        id: "booking_1",
        memberId: "mem_1",
        member: { id: "mem_1" },
        checkIn: "2026-07-31T00:00:00.000Z",
        checkOut: "2026-08-02T00:00:00.000Z",
        createdAt: "2026-05-15T10:30:00.000Z",
        discountCents: 5000,
        promoAdjustmentCents: -5000,
        guests: [
          {
            firstName: "Jordan",
            lastName: "Hartley-Smith",
            ageTier: "ADULT",
            isMember: true,
            priceCents: 10000,
          },
        ],
        payment: {
          id: "pay_1",
          status: "SUCCEEDED",
          amountCents: 5000,
          stripePaymentIntentId: "pi_1",
          xeroInvoiceId: null,
          xeroInvoiceNumber: null,
        },
        promoRedemption: promo ? { promoCode: promo } : null,
      };
    }

    function getPromoAdjustmentLine() {
      const call = mocks.xeroClientInstance.accountingApi.createInvoices.mock.calls[0];
      const lineItems = call[1].invoices[0].lineItems as Array<{
        description?: string;
        itemCode?: string;
        accountCode?: string;
        unitAmount?: number;
      }>;
      return lineItems.find((l) => l.description?.toLowerCase().startsWith("promo adjustment"));
    }

    it("posts the promo adjustment line to the promo's xeroItemCode when set", async () => {
      mocks.prisma.booking.findUnique.mockResolvedValue(
        bookingWithPromo({ code: "SUMMER25", xeroItemCode: "PROMO-DISC", xeroAccountCode: null })
      );

      await createXeroInvoiceForBooking("booking_1");

      const discount = getPromoAdjustmentLine();
      expect(discount).toBeDefined();
      expect(discount?.description).toBe("Promo adjustment - SUMMER25");
      expect(discount?.itemCode).toBe("PROMO-DISC");
      expect(discount?.accountCode).toBeUndefined();
      expect(discount?.unitAmount).toBe(-50);
    });

    it("posts the promo adjustment line to the promo's xeroAccountCode when only an account code is set", async () => {
      mocks.prisma.booking.findUnique.mockResolvedValue(
        bookingWithPromo({ code: "PROMO10", xeroItemCode: null, xeroAccountCode: "201" })
      );

      await createXeroInvoiceForBooking("booking_1");

      const discount = getPromoAdjustmentLine();
      expect(discount).toBeDefined();
      expect(discount?.itemCode).toBeUndefined();
      expect(discount?.accountCode).toBe("201");
    });

    it("includes both itemCode and accountCode when both are set on the promo", async () => {
      mocks.prisma.booking.findUnique.mockResolvedValue(
        bookingWithPromo({ code: "WINTER20", xeroItemCode: "PROMO-DISC", xeroAccountCode: "201" })
      );

      await createXeroInvoiceForBooking("booking_1");

      const discount = getPromoAdjustmentLine();
      expect(discount?.itemCode).toBe("PROMO-DISC");
      expect(discount?.accountCode).toBe("201");
    });

    it("falls back to hut-fee item code when the promo has no Xero codes set", async () => {
      mocks.prisma.xeroAccountMapping.findUnique.mockImplementation(({ where }) => {
        if (where.key === "hutFeeItem") return Promise.resolve({ code: null, itemCode: "HUT-FEE" });
        return Promise.resolve(null);
      });
      mocks.prisma.booking.findUnique.mockResolvedValue(
        bookingWithPromo({ code: "LEGACY", xeroItemCode: null, xeroAccountCode: null })
      );

      await createXeroInvoiceForBooking("booking_1");

      const discount = getPromoAdjustmentLine();
      expect(discount?.description).toBe("Promo adjustment - LEGACY");
      expect(discount?.itemCode).toBe("HUT-FEE");
    });

    it("uses the generic promo adjustment description when no promo redemption is linked", async () => {
      mocks.prisma.booking.findUnique.mockResolvedValue(bookingWithPromo(null));

      await createXeroInvoiceForBooking("booking_1");

      const discount = getPromoAdjustmentLine();
      expect(discount?.description).toBe("Promo adjustment");
    });
  });
});

describe("createXeroCreditNoteForModification", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetXeroRateLimitStateForTests();
    vi.stubEnv(
      "XERO_ENCRYPTION_KEY",
      "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"
    );
    vi.stubEnv("XERO_CLIENT_ID", "client-id");
    vi.stubEnv("XERO_CLIENT_SECRET", "client-secret");

    mocks.prisma.$transaction.mockImplementation(async (callback) => callback(mocks.tx));
    mocks.tx.$executeRaw.mockResolvedValue(undefined);
    mocks.tx.member.findUnique.mockResolvedValue({
      id: "mem_1",
      email: "member@example.com",
      xeroContactId: "contact_1",
    });
    mocks.prisma.booking.findUnique.mockResolvedValue({
      id: "booking_1",
      memberId: "mem_1",
      checkIn: "2026-07-31T00:00:00.000Z",
      checkOut: "2026-08-02T00:00:00.000Z",
      payment: {
        id: "pay_1",
        xeroInvoiceId: "inv_1",
      },
    });
    mocks.prisma.xeroToken.findFirst.mockResolvedValue({
      id: "token_1",
      accessToken: encryptToken("access"),
      refreshToken: encryptToken("refresh"),
      expiresAt: new Date(Date.now() + 60 * 60 * 1000),
      tenantId: "tenant_1",
    });
    mocks.prisma.xeroAccountMapping.findUnique.mockResolvedValue(null);
    mocks.xeroClientInstance.accountingApi.createCreditNotes.mockResolvedValue({
      body: {
        creditNotes: [
          {
            creditNoteID: "cn_1",
            creditNoteNumber: "CN-1",
          },
        ],
      },
    });
  });

  it("keeps created modification credit notes partial when allocation fails", async () => {
    mocks.xeroClientInstance.accountingApi.createCreditNoteAllocation.mockRejectedValue(
      new Error("allocation failed")
    );

    await expect(
      createXeroCreditNoteForModification({
        bookingId: "booking_1",
        refundAmountCents: 3200,
        bookingModificationId: "mod_1",
        syncOperationId: "op_1",
      })
    ).resolves.toBe("cn_1");

    expect(mocks.completeXeroSyncOperation).toHaveBeenCalledWith(
      "op_1",
      expect.objectContaining({
        status: "PARTIAL",
        xeroObjectType: "CREDIT_NOTE",
        xeroObjectId: "cn_1",
        xeroObjectNumber: "CN-1",
        extraLinks: [
          expect.objectContaining({
            localModel: "BookingModification",
            localId: "mod_1",
            xeroObjectType: "CREDIT_NOTE",
            xeroObjectId: "cn_1",
            role: "MODIFICATION_CREDIT_NOTE",
          }),
        ],
      })
    );
    expect(mocks.failXeroSyncOperation).not.toHaveBeenCalled();
  });
});

describe("createXeroRefundPaymentForInvoice", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetXeroRateLimitStateForTests();
    vi.stubEnv(
      "XERO_ENCRYPTION_KEY",
      "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"
    );
    vi.stubEnv("XERO_CLIENT_ID", "client-id");
    vi.stubEnv("XERO_CLIENT_SECRET", "client-secret");

    mocks.prisma.xeroToken.findFirst.mockResolvedValue({
      id: "token_1",
      accessToken: encryptToken("access"),
      refreshToken: encryptToken("refresh"),
      expiresAt: new Date(Date.now() + 60 * 60 * 1000),
      tenantId: "tenant_1",
    });
    mocks.prisma.xeroAccountMapping.findUnique.mockResolvedValue(null);
    mocks.startXeroSyncOperation.mockResolvedValue({ id: "op_payment_1" });
    mocks.xeroClientInstance.accountingApi.createPayments.mockResolvedValue({
      body: {
        payments: [
          {
            paymentID: "xpay_1",
            creditNoteNumber: "CN-1",
          },
        ],
      },
    });
  });

  it("creates the Xero refund payment against the credit note", async () => {
    await expect(
      createXeroRefundPaymentForInvoice({
        paymentId: "pay_1",
        invoiceId: "inv_1",
        creditNoteId: "cn_1",
        refundAmountCents: 2500,
      })
    ).resolves.toBe("xpay_1");

    expect(mocks.xeroClientInstance.accountingApi.createPayments).toHaveBeenCalledWith(
      "tenant_1",
      {
        payments: [
          expect.objectContaining({
            creditNote: { creditNoteID: "cn_1" },
            account: { code: "606" },
            amount: 25,
          }),
        ],
      },
      undefined,
      "payment:pay_1:refund-payment:2500:cn_1:v2"
    );
    expect(mocks.completeXeroSyncOperation).toHaveBeenCalledWith(
      "op_payment_1",
      expect.objectContaining({
        xeroObjectType: "PAYMENT",
        xeroObjectId: "xpay_1",
        xeroObjectNumber: "CN-1",
      })
    );
  });
});

describe("createXeroCreditNote", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetXeroRateLimitStateForTests();
    vi.stubEnv(
      "XERO_ENCRYPTION_KEY",
      "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"
    );
    vi.stubEnv("XERO_CLIENT_ID", "client-id");
    vi.stubEnv("XERO_CLIENT_SECRET", "client-secret");
    mocks.findCanonicalPaymentRefundCreditNote.mockResolvedValue(null);
    mocks.prisma.xeroObjectLink.findMany.mockResolvedValue([]);
  });

  it("reuses an existing refund credit note link before attempting a new create", async () => {
    mocks.prisma.payment.findUnique.mockResolvedValue({
      id: "pay_1",
      xeroInvoiceId: "inv_1",
      xeroRefundCreditNoteId: null,
      booking: {
        id: "booking_1",
        memberId: "mem_1",
        member: { id: "mem_1" },
        guests: [],
        checkIn: "2026-07-31T00:00:00.000Z",
        checkOut: "2026-08-02T00:00:00.000Z",
      },
    });
    mocks.prisma.xeroObjectLink.findFirst.mockResolvedValue({
      xeroObjectId: "cn_existing",
      xeroObjectNumber: "CN-99",
    });
    mocks.findCanonicalPaymentRefundCreditNote.mockResolvedValue({
      xeroObjectId: "cn_existing",
      xeroObjectNumber: "CN-99",
      source: "link",
    });
    mocks.prisma.payment.update.mockResolvedValue({ id: "pay_1" });

    await expect(createXeroCreditNote("pay_1", 2500)).resolves.toBe("cn_existing");

    expect(mocks.prisma.payment.update).toHaveBeenCalledWith({
      where: { id: "pay_1" },
      data: {
        xeroRefundCreditNoteId: "cn_existing",
      },
    });
    expect(mocks.upsertXeroObjectLink).toHaveBeenCalledWith({
      localModel: "Payment",
      localId: "pay_1",
      xeroObjectType: "CREDIT_NOTE",
      xeroObjectId: "cn_existing",
      xeroObjectNumber: "CN-99",
      role: "REFUND_CREDIT_NOTE",
    });
    expect(mocks.xeroClientInstance.accountingApi.createCreditNotes).not.toHaveBeenCalled();
    expect(mocks.xeroClientInstance.accountingApi.createPayments).not.toHaveBeenCalled();
  });

  it("skips the delta note when an active link already covers the watermark (#1162)", async () => {
    mocks.prisma.payment.findUnique.mockResolvedValue({
      id: "pay_1",
      xeroInvoiceId: "inv_1",
      xeroRefundCreditNoteId: null,
      refundedAmountCents: 8000,
      booking: {
        id: "booking_1",
        memberId: "mem_1",
        member: { id: "mem_1" },
        guests: [],
        checkIn: "2026-07-31T00:00:00.000Z",
        checkOut: "2026-08-02T00:00:00.000Z",
      },
    });
    mocks.prisma.xeroObjectLink.findMany.mockResolvedValue([
      {
        xeroObjectId: "cn_delta",
        xeroObjectNumber: "CN-8",
        metadata: { amountCents: 8000, watermarkCents: 8000 },
      },
    ]);
    mocks.prisma.payment.update.mockResolvedValue({ id: "pay_1" });

    await expect(
      createXeroCreditNote("pay_1", 3000, { watermarkCents: 8000 })
    ).resolves.toBe("cn_delta");

    // A covering note already settles this watermark: no new Xero writes, and
    // the canonical single-note lookup is bypassed in delta mode.
    expect(mocks.xeroClientInstance.accountingApi.createCreditNotes).not.toHaveBeenCalled();
    expect(mocks.xeroClientInstance.accountingApi.createPayments).not.toHaveBeenCalled();
    expect(mocks.findCanonicalPaymentRefundCreditNote).not.toHaveBeenCalled();
    expect(mocks.prisma.payment.update).toHaveBeenCalledWith({
      where: { id: "pay_1" },
      data: { xeroRefundCreditNoteId: "cn_delta" },
    });
  });

  it("creates a new delta note when no active link covers the higher watermark (#1162)", async () => {
    mocks.prisma.payment.findUnique.mockResolvedValue({
      id: "pay_1",
      xeroInvoiceId: "inv_1",
      xeroRefundCreditNoteId: "cn_delta",
      refundedAmountCents: 11000,
      booking: {
        id: "booking_1",
        memberId: "mem_1",
        member: { id: "mem_1" },
        guests: [],
        checkIn: "2026-07-31T00:00:00.000Z",
        checkOut: "2026-08-02T00:00:00.000Z",
      },
    });
    mocks.prisma.xeroObjectLink.findMany.mockResolvedValue([
      {
        xeroObjectId: "cn_delta",
        xeroObjectNumber: "CN-8",
        metadata: { amountCents: 8000, watermarkCents: 8000 },
      },
    ]);
    mocks.tx.member.findUnique.mockResolvedValue({
      id: "mem_1",
      email: "member@example.com",
      xeroContactId: "contact_1",
    });
    mocks.prisma.xeroToken.findFirst.mockResolvedValue({
      id: "token_1",
      accessToken: encryptToken("access"),
      refreshToken: encryptToken("refresh"),
      expiresAt: new Date(Date.now() + 60 * 60 * 1000),
      tenantId: "tenant_1",
    });
    mocks.prisma.xeroAccountMapping.findUnique.mockResolvedValue(null);
    mocks.prisma.xeroItemCodeMapping.findMany.mockResolvedValue([]);
    mocks.prisma.payment.update.mockResolvedValue({ id: "pay_1" });
    mocks.startXeroSyncOperation.mockResolvedValue({ id: "op_delta_1" });
    mocks.xeroClientInstance.accountingApi.createCreditNotes.mockResolvedValue({
      body: { creditNotes: [{ creditNoteID: "cn_new", creditNoteNumber: "CN-11" }] },
    });
    mocks.xeroClientInstance.accountingApi.createPayments.mockResolvedValue({
      body: { payments: [{ paymentID: "xpay_new" }] },
    });

    await expect(
      createXeroCreditNote("pay_1", 3000, {
        watermarkCents: 11000,
        syncOperationId: "op_delta_1",
      })
    ).resolves.toBe("cn_new");

    expect(mocks.xeroClientInstance.accountingApi.createCreditNotes).toHaveBeenCalledTimes(1);
    // The credit note is keyed on the new cumulative watermark, not the amount.
    expect(mocks.xeroClientInstance.accountingApi.createCreditNotes).toHaveBeenCalledWith(
      "tenant_1",
      expect.anything(),
      undefined,
      undefined,
      "payment:pay_1:refund-credit-note:11000:v2"
    );
  });

  // ---------------------------------------------------------------------------
  // F4 (#1354): delta amounts are derived from EXECUTION-TIME state. The
  // enqueue-time watermark can be stale (two refunds in one outbox interval),
  // and pre-#1354 a stale-low watermark made an existing higher note look
  // covering — the delta was marked done without creating anything.
  // ---------------------------------------------------------------------------
  describe("execution-time watermark recompute (#1354)", () => {
    function armCreatePath(refundedAmountCents: number, linkRows: unknown[]) {
      mocks.prisma.payment.findUnique.mockResolvedValue({
        id: "pay_1",
        xeroInvoiceId: "inv_1",
        xeroRefundCreditNoteId: null,
        refundedAmountCents,
        booking: {
          id: "booking_1",
          memberId: "mem_1",
          member: { id: "mem_1" },
          guests: [],
          checkIn: "2026-07-31T00:00:00.000Z",
          checkOut: "2026-08-02T00:00:00.000Z",
        },
      });
      mocks.prisma.xeroObjectLink.findMany.mockResolvedValue(linkRows);
      mocks.tx.member.findUnique.mockResolvedValue({
        id: "mem_1",
        email: "member@example.com",
        xeroContactId: "contact_1",
      });
      mocks.prisma.xeroToken.findFirst.mockResolvedValue({
        id: "token_1",
        accessToken: encryptToken("access"),
        refreshToken: encryptToken("refresh"),
        expiresAt: new Date(Date.now() + 60 * 60 * 1000),
        tenantId: "tenant_1",
      });
      mocks.prisma.xeroAccountMapping.findUnique.mockResolvedValue(null);
      mocks.prisma.xeroItemCodeMapping.findMany.mockResolvedValue([]);
      mocks.prisma.payment.update.mockResolvedValue({ id: "pay_1" });
      mocks.startXeroSyncOperation.mockResolvedValue({ id: "op_delta_x" });
      mocks.xeroClientInstance.accountingApi.createPayments.mockResolvedValue({
        body: { payments: [{ paymentID: "xpay_x" }] },
      });
    }

    it("creates the uncovered delta even when the enqueue-time watermark is stale-low (the F4 swallow)", async () => {
      // Ledger says 8000c refunded; one 5000c note exists (watermark 5000).
      // The second refund's op carries the STALE watermark 3000 — pre-#1354
      // the 5000-watermark note looked covering (5000 >= 3000) and the 3000c
      // delta was silently swallowed.
      armCreatePath(8000, [
        {
          xeroObjectId: "cn_first",
          xeroObjectNumber: "CN-1",
          metadata: { amountCents: 5000, watermarkCents: 5000 },
        },
      ]);
      mocks.xeroClientInstance.accountingApi.createCreditNotes.mockResolvedValue({
        body: { creditNotes: [{ creditNoteID: "cn_second", creditNoteNumber: "CN-2" }] },
      });

      await expect(
        createXeroCreditNote("pay_1", 3000, {
          watermarkCents: 3000,
          syncOperationId: "op_delta_x",
        })
      ).resolves.toBe("cn_second");

      // The note is created for the true uncovered amount, keyed by the
      // EXECUTION-TIME watermark (5000 covered + 3000 = 8000).
      expect(mocks.xeroClientInstance.accountingApi.createCreditNotes).toHaveBeenCalledWith(
        "tenant_1",
        expect.objectContaining({
          creditNotes: [
            expect.objectContaining({
              lineItems: [expect.objectContaining({ unitAmount: 30 })],
            }),
          ],
        }),
        undefined,
        undefined,
        "payment:pay_1:refund-credit-note:8000:v2"
      );
      // Completion records the execution-time amounts for future coverage math.
      expect(mocks.completeXeroSyncOperation).toHaveBeenCalledWith(
        "op_delta_x",
        expect.objectContaining({
          extraLinks: expect.arrayContaining([
            expect.objectContaining({
              role: "REFUND_CREDIT_NOTE",
              metadata: { amountCents: 3000, watermarkCents: 8000 },
            }),
          ]),
        })
      );
    });

    it("caps the note at the ledger's uncovered amount when a competing note landed first", async () => {
      // Requested 5000 but the ledger only shows 2000 uncovered.
      armCreatePath(7000, [
        {
          xeroObjectId: "cn_first",
          xeroObjectNumber: "CN-1",
          metadata: { amountCents: 5000, watermarkCents: 5000 },
        },
      ]);
      mocks.xeroClientInstance.accountingApi.createCreditNotes.mockResolvedValue({
        body: { creditNotes: [{ creditNoteID: "cn_cap", creditNoteNumber: "CN-3" }] },
      });

      await createXeroCreditNote("pay_1", 5000, {
        watermarkCents: 10000,
        syncOperationId: "op_delta_x",
      });

      expect(mocks.xeroClientInstance.accountingApi.createCreditNotes).toHaveBeenCalledWith(
        "tenant_1",
        expect.objectContaining({
          creditNotes: [
            expect.objectContaining({
              lineItems: [expect.objectContaining({ unitAmount: 20 })],
            }),
          ],
        }),
        undefined,
        undefined,
        "payment:pay_1:refund-credit-note:7000:v2"
      );
    });

    it("two stepped refunds sum to the exact refunded total whatever order their operations execute (#1354 validation)", async () => {
      // Stripe refunded 5000 then 3000 (ledger 8000). The ops execute in the
      // BUG order: the 3000 op (stale watermark) runs FIRST here, then the
      // 5000 op — the created notes must still sum to exactly 8000.
      armCreatePath(8000, []);
      mocks.xeroClientInstance.accountingApi.createCreditNotes.mockResolvedValueOnce({
        body: { creditNotes: [{ creditNoteID: "cn_a", creditNoteNumber: "CN-A" }] },
      });
      await createXeroCreditNote("pay_1", 3000, {
        watermarkCents: 3000,
        syncOperationId: "op_delta_x",
      });
      const firstCall =
        mocks.xeroClientInstance.accountingApi.createCreditNotes.mock.calls[0];
      const firstCents = Math.round(
        firstCall[1].creditNotes[0].lineItems[0].unitAmount * 100
      );

      // The first note (3000c, watermark 3000) is now an active link.
      mocks.prisma.xeroObjectLink.findMany.mockResolvedValue([
        {
          xeroObjectId: "cn_a",
          xeroObjectNumber: "CN-A",
          metadata: { amountCents: firstCents, watermarkCents: firstCents },
        },
      ]);
      mocks.xeroClientInstance.accountingApi.createCreditNotes.mockResolvedValueOnce({
        body: { creditNotes: [{ creditNoteID: "cn_b", creditNoteNumber: "CN-B" }] },
      });
      await createXeroCreditNote("pay_1", 5000, {
        watermarkCents: 8000,
        syncOperationId: "op_delta_x",
      });
      const secondCall =
        mocks.xeroClientInstance.accountingApi.createCreditNotes.mock.calls[1];
      const secondCents = Math.round(
        secondCall[1].creditNotes[0].lineItems[0].unitAmount * 100
      );

      expect(firstCents + secondCents).toBe(8000);
      expect(
        mocks.xeroClientInstance.accountingApi.createCreditNotes
      ).toHaveBeenCalledTimes(2);
    });
  });
});
