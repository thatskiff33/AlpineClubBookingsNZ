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

import {
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

  it("updates primary invoice dates and guest line narration without changing amounts", async () => {
    mocks.prisma.booking.findUnique.mockResolvedValue({
      id: "booking_1",
      memberId: "mem_1",
      member: { id: "mem_1" },
      checkIn: "2026-08-03T00:00:00.000Z",
      checkOut: "2026-08-04T00:00:00.000Z",
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
                  "Jordan Hartley-Smith - (ADULT, Member) - 2 nights - 2026-08-03 - 2026-08-04",
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
      "booking:booking_1:invoice-update:inv_1:2026-08-03:2026-08-04:v1"
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
      "payment:pay_1:refund-payment:2500:v1"
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
});
