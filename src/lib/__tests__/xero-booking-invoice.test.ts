import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

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
  environmentSafetySettings: { findUnique: vi.fn().mockResolvedValue(null) },
  /*
    #3036 (ENV-SAFETY 3, INV-CONFIG-005): on a confirmed copy the funnel proves
    the invoice's contact can no longer reach a member BEFORE returning its id,
    and a missing delegate here is a refusal — which is the point, so it is
    declared rather than worked around.
  */
  xeroSandboxContactContainment: {
    findUnique: vi.fn().mockResolvedValue(null),
    upsert: vi.fn().mockResolvedValue({}),
  },
    $transaction: vi.fn(async (callback) => callback(tx)),
    // #1355: contact resolution now reads the member on the GLOBAL client
    // (phase 0/1) and re-reads via the tx client (phase 2). Alias the same
    // mock fns so every existing fixture serves both phases.
    member: tx.member,
    booking: {
      findUnique: vi.fn(),
    },
    // #2258: the withheld-send audit row written when the booking's
    // "No emails" switch stops Xero emailing the invoice.
    emailLog: {
      create: vi.fn().mockResolvedValue({ id: "emaillog_1" }),
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
    // #1930, E4: getHutFeeItemCodeMap resolves the FULL/NON_MEMBER ids for the
    // per-guest item-code fallback.
    membershipType: {
      findMany: vi.fn().mockResolvedValue([
        { id: "type-full", key: "FULL" },
        { id: "type-nonmember", key: "NON_MEMBER" },
      ]),
    },
    xeroSyncOperation: {
      update: vi.fn(),
      // #2929: the creation-time invoice-email instruction is read back off the
      // operation row a dispatcher claimed. Defaults to "no instruction was
      // recorded", which is every row this application has ever written before
      // that issue and every row an enqueuer with no on-behalf choice writes.
      findUnique: vi.fn().mockResolvedValue({ invoiceEmailDelivery: null }),
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
      // #3036: read the contact back, and contain it on a copy.
      getContact: vi.fn(),
      updateContact: vi.fn(),
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
    resolveStripeCashRefundEvidence: vi.fn(),
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

// #2902: delta-mode createXeroCreditNote recomputes its uncovered amount from
// provider-backed cash evidence, never the refundedAmountCents mirror.
// Resolution rules are unit-tested in stripe-cash-refund-evidence.test.ts;
// the default (cash === mirror) keeps the pre-#2902 scenarios intact.
vi.mock("@/lib/stripe-cash-refund-evidence", () => ({
  resolveStripeCashRefundEvidence: mocks.resolveStripeCashRefundEvidence,
}));

vi.mock("@/lib/xero-links", () => ({
  buildXeroContactUrl: vi.fn((contactId: string) => `https://go.xero.test/contact/${contactId}`),
  buildXeroInvoiceUrl: vi.fn((invoiceId: string) => `https://go.xero.test/invoice/${invoiceId}`),
}));

vi.mock("@/lib/xero-sync", async (importOriginal) => {
  const actual = (await importOriginal()) as typeof import("@/lib/xero-sync");

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

// DB-only Xero resolution (#2079): supply the operational config and the
// token-encryption key from a stub so the token round-trips below need no
// integration-credential DB rows.
vi.mock("@/lib/xero-config", async (importOriginal) => {
  const actual = (await importOriginal()) as typeof import("@/lib/xero-config");
  return {
    ...actual,
    getOperationalXeroConfig: vi.fn().mockResolvedValue({
      clientId: "test-client",
      clientSecret: "test-secret",
      redirectUris: ["https://example.com/api/admin/xero/callback"],
      scopes: [...actual.XERO_REQUIRED_REPORT_OAUTH_SCOPES],
      httpTimeout: 10_000,
    }),
    getOperationalXeroEncryptionKey: vi
      .fn()
      .mockResolvedValue(
        "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
      ),
  };
});

import {
  createXeroCreditNoteForModification,
  createXeroCreditNote,
  createXeroInvoiceForBooking,
  createXeroRefundPaymentForInvoice,
  encryptToken,
  resetXeroRateLimitStateForTests,
  updateXeroBookingInvoiceForBooking,
} from "@/lib/xero";
import { frozenTestNow } from "@/lib/__tests__/helpers/clock";
import { expectClubTimeZonePremise } from "@/lib/__tests__/helpers/club-time-zone";
import { declareEnvironmentRole } from "@/lib/__tests__/helpers/environment-role";
import { toXeroSandboxContactEmail } from "@/lib/xero-sandbox-contact-email";

// encryptToken is async (#2079); precompute the fixture ciphertexts once so the
// synchronous mock-setup blocks below need no await. The stubbed token key
// (getOperationalXeroEncryptionKey mock above) makes these deterministic.
let encryptedAccess: string;
let encryptedRefresh: string;

type XeroBookingFixture = Record<string, unknown> & {
  checkIn: Date | string;
  checkOut: Date | string;
  totalPriceCents?: number;
  promoAdjustmentCents?: number;
  guests: Array<
    Record<string, unknown> & {
      id?: string;
      priceCents: number;
      nights?: Array<
        Record<string, unknown> & {
          id?: string;
          stayDate?: Date | string;
          priceCents?: number | null;
          priceSource?: "SOLD" | "OFFICER_PRICED" | "EVEN_SPLIT" | "UNKNOWN";
        }
      >;
    }
  >;
  promoRedemption?: (Record<string, unknown> & { allocations?: unknown[] }) | null;
  nightAdjustments?: unknown[];
};

/**
 * The create-path mock ignores Prisma's select/include shape, so every booking
 * it returns must still carry the complete Stage 3 projection Prisma would
 * materialise. Keeping that repair in test code makes omitted relations a
 * fixture defect instead of production compatibility behaviour.
 */
function withMoneyBuildUpProjection<T extends XeroBookingFixture>(booking: T) {
  const checkIn = booking.checkIn instanceof Date ? booking.checkIn : new Date(booking.checkIn);
  const checkOut = booking.checkOut instanceof Date ? booking.checkOut : new Date(booking.checkOut);
  const guests = booking.guests.map((guest, guestIndex) => {
    const suppliedNights = guest.nights ?? [];
    const nights = (suppliedNights.length > 0
      ? suppliedNights
      : [{ stayDate: checkIn, priceCents: guest.priceCents, priceSource: "SOLD" as const }]
    ).map((night, nightIndex) => ({
      ...night,
      id: night.id ?? `guest-${guestIndex + 1}-night-${nightIndex + 1}`,
      stayDate:
        night.stayDate instanceof Date
          ? night.stayDate
          : new Date(night.stayDate ?? checkIn),
      priceCents: night.priceCents ?? guest.priceCents,
      priceSource: night.priceSource ?? ("SOLD" as const),
    }));
    return {
      ...guest,
      id: guest.id ?? `guest-${guestIndex + 1}`,
      stayStart: null,
      stayEnd: null,
      nights,
    };
  });
  return {
    ...booking,
    checkIn,
    checkOut,
    totalPriceCents:
      booking.totalPriceCents ?? guests.reduce((sum, guest) => sum + guest.priceCents, 0),
    promoAdjustmentCents: booking.promoAdjustmentCents ?? 0,
    guests,
    promoRedemption: booking.promoRedemption
      ? {
          ...booking.promoRedemption,
          allocations: booking.promoRedemption.allocations ?? [],
        }
      : null,
    nightAdjustments: booking.nightAdjustments ?? [],
  };
}

beforeAll(async () => {
  encryptedAccess = await encryptToken("access");
  encryptedRefresh = await encryptToken("refresh");
});

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

describe("createXeroInvoiceForBooking", () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    resetXeroRateLimitStateForTests();
    vi.stubEnv(
      "XERO_ENCRYPTION_KEY",
      "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"
    );
    vi.stubEnv("XERO_CLIENT_ID", "client-id");
    vi.stubEnv("XERO_CLIENT_SECRET", "client-secret");
    // #3036: on a copy the funnel reads the linked contact back and contains it
    // before returning its id. On the club's live site none of this runs.
    mocks.prisma.xeroSandboxContactContainment.findUnique.mockResolvedValue(null);
    mocks.prisma.xeroSandboxContactContainment.upsert.mockResolvedValue({});
    mocks.xeroClientInstance.accountingApi.getContact.mockResolvedValue({
      body: {
        contacts: [
          { contactID: "contact_1", emailAddress: "member@example.com" },
        ],
      },
    });
    mocks.xeroClientInstance.accountingApi.updateContact.mockResolvedValue({
      body: {},
    });

    mocks.prisma.$transaction.mockImplementation(async (callback) => callback(mocks.tx));
    mocks.tx.$executeRaw.mockResolvedValue(1);
    mocks.tx.member.findUnique.mockResolvedValue({
      id: "mem_1",
      email: "member@example.com",
      xeroContactId: "contact_1",
    });

    mocks.prisma.booking.findUnique.mockResolvedValue(withMoneyBuildUpProjection({
      id: "booking_1",
      memberId: "mem_1",
      member: { id: "mem_1" },
      // Booking.lodgeId is NOT NULL in the schema; the season read that picks
      // the hut-fee item code is scoped to it.
      lodgeId: "lodge_1",
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
        refundedAmountCents: 0,
        stripePaymentIntentId: null,
        xeroInvoiceId: null,
        xeroInvoiceNumber: null,
        source: "STRIPE",
      },
    }));
    mocks.prisma.payment.findUnique.mockResolvedValue(null);
    mocks.prisma.paymentTransaction.updateMany.mockResolvedValue({ count: 0 });
    mocks.prisma.season.findFirst.mockResolvedValue({ type: "WINTER" });
    mocks.prisma.payment.update.mockResolvedValue({ id: "pay_1" });
    mocks.prisma.xeroObjectLink.findFirst.mockResolvedValue(null);
    mocks.prisma.xeroToken.findFirst.mockResolvedValue({
      id: "token_1",
      accessToken: encryptedAccess,
      refreshToken: encryptedRefresh,
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

  it("resolves the item-code season from the booking's own lodge, not any lodge", async () => {
    // Lodges may run different season windows (lodge-scoping-contract.md), so an
    // unscoped read can match another lodge's season — and Season.type picks the
    // hut-fee item code, and therefore the GL account the revenue posts to.
    await expect(createXeroInvoiceForBooking("booking_1")).resolves.toBe("inv_1");

    expect(mocks.prisma.season.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ lodgeId: "lodge_1" }),
      }),
    );
  });

  describe("#1641 card applied-credit allocation", () => {
    function cardPayment(overrides: Record<string, unknown> = {}) {
      return {
        id: "pay_1",
        status: "SUCCEEDED",
        // effective (10000 finalPrice − 3000 applied credit)
        amountCents: 7000,
        refundedAmountCents: 0,
        creditAppliedCents: 3000,
        stripePaymentIntentId: "pi_1",
        xeroInvoiceId: null,
        xeroInvoiceNumber: null,
        source: "STRIPE",
        ...overrides,
      };
    }

    function cardCreditBooking(paymentOverrides: Record<string, unknown> = {}) {
      return withMoneyBuildUpProjection({
        id: "booking_1",
        memberId: "mem_1",
        member: { id: "mem_1" },
        totalPriceCents: 10000,
        checkIn: "2026-07-31T00:00:00.000Z",
        checkOut: "2026-08-02T00:00:00.000Z",
        createdAt: "2026-05-15T10:30:00.000Z",
        discountCents: 0,
        promoAdjustmentCents: 0,
        guests: [
          {
            id: "guest_1",
            firstName: "Jordan",
            lastName: "Hartley-Smith",
            ageTier: "ADULT",
            isMember: true,
            priceCents: 10000,
            nights: [],
          },
        ],
        payment: cardPayment(paymentOverrides),
      });
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

  it("does NOT let Xero email the invoice when the booking has No emails on, and records the withhold (#2258)", async () => {
    mocks.prisma.booking.findUnique.mockResolvedValue(withMoneyBuildUpProjection({
      id: "booking_1",
      memberId: "mem_1",
      member: { id: "mem_1", email: "member@example.test" },
      // The switch. The invoice itself is still raised in Xero — only the
      // emailing is withheld.
      noEmails: true,
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
    }));

    await expect(createXeroInvoiceForBooking("booking_1")).resolves.toBe("inv_1");

    expect(
      mocks.xeroClientInstance.accountingApi.emailInvoice
    ).not.toHaveBeenCalled();
    expect(mocks.prisma.emailLog.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        bookingId: "booking_1",
        templateName: "xero-booking-invoice-email",
        status: "SKIPPED_NO_EMAILS",
        to: "member@example.test",
        htmlBody: null,
      }),
      select: { id: true },
    });
    // The invoice was still created and linked — only the email is withheld.
    expect(
      mocks.xeroClientInstance.accountingApi.createInvoices
    ).toHaveBeenCalled();
    // A DELIBERATE withhold is a complete, intended outcome: no error, and the
    // flag distinguishes it from the ordinary "this source raises no emailed
    // invoice" skip.
    expect(mocks.completeXeroSyncOperation).toHaveBeenCalledWith(
      "op_1",
      expect.objectContaining({
        status: "SUCCEEDED",
        responsePayload: expect.objectContaining({
          invoiceEmailError: null,
          invoiceEmailWithheldByNoEmails: true,
        }),
      })
    );
  });

  // The corrected contract (#2258 review finding): an unreadable switch is a
  // FAULT, not a deliberate withhold. Filing it as SKIPPED_NO_EMAILS would put a
  // false "the admin asked for silence" line on a booking whose switch is OFF
  // (#2259's banner), and reporting the sync operation SUCCEEDED would strand an
  // unpaid internet-banking invoice the member was never told about, with no
  // re-drive path — the exact #1705 harm.
  it("reports an unreadable switch as a FAULT: PARTIAL sync op, no withheld row, no email (#2258)", async () => {
    const bookingRow = {
      id: "booking_1",
      memberId: "mem_1",
      member: { id: "mem_1", email: "member@example.test" },
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
    };
    // The invoice and Stage 3 evidence share the first coherent booking read;
    // the pre-email re-read throws.
    const projectedBookingRow = withMoneyBuildUpProjection(bookingRow);
    mocks.prisma.booking.findUnique
      .mockResolvedValueOnce(projectedBookingRow)
      .mockRejectedValueOnce(new Error("connection reset"));

    await expect(createXeroInvoiceForBooking("booking_1")).resolves.toBe("inv_1");

    expect(
      mocks.xeroClientInstance.accountingApi.emailInvoice
    ).not.toHaveBeenCalled();
    // NOT filed as a deliberate withhold.
    expect(mocks.prisma.emailLog.create).not.toHaveBeenCalled();
    // Visible and re-drivable: the operation completes PARTIAL with a populated
    // invoiceEmailError, exactly as a failed emailInvoice call would.
    expect(mocks.completeXeroSyncOperation).toHaveBeenCalledWith(
      "op_1",
      expect.objectContaining({
        status: "PARTIAL",
        responsePayload: expect.objectContaining({
          invoiceEmailError: expect.any(Error),
          invoiceEmailSkipped: true,
          invoiceEmailWithheldByNoEmails: false,
          // #3001: WHICH fault, recorded beside the error. The error value is
          // not redacted and is never read back out of this payload, so without
          // this key the booking's warning can only say "sending it failed" —
          // and for THIS cause the obvious remedy, "send it from Xero
          // yourself", may email a booking whose switch is on.
          invoiceEmailFailureCause: "NO_EMAILS_UNREADABLE",
        }),
      })
    );
  });

  /*
    #3035 (ENV-SAFETY 2, INV-CONFIG-004). The invoice is still raised and its
    ids still persisted; only the emailing is withheld, and the two non-allow
    outcomes are reported differently because they need different remedies.
  */
  describe("the environment-safety boundary", () => {
    function internetBankingBooking() {
      return withMoneyBuildUpProjection({
        id: "booking_1",
        memberId: "mem_1",
        member: { id: "mem_1", email: "member@example.test" },
        lodgeId: "lodge_1",
        checkIn: "2026-07-31T00:00:00.000Z",
        checkOut: "2026-08-02T00:00:00.000Z",
        createdAt: "2026-05-15T10:30:00.000Z",
        discountCents: 0,
        promoAdjustmentCents: 0,
        noEmails: false,
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
    }

    it("raises the invoice but emails nobody on a confirmed copy, and stays SUCCEEDED", async () => {
      declareEnvironmentRole("non-production");
      mocks.prisma.booking.findUnique.mockResolvedValue(internetBankingBooking());

      await expect(createXeroInvoiceForBooking("booking_1")).resolves.toBe(
        "inv_1"
      );

      expect(
        mocks.xeroClientInstance.accountingApi.emailInvoice
      ).not.toHaveBeenCalled();
      // NOT a withheld-email audit row: that row asserts an administrator turned
      // the booking's "No emails" switch on, and nobody did.
      expect(mocks.prisma.emailLog.create).not.toHaveBeenCalled();
      // The invoice ids are still persisted, so the booking is not left thinking
      // no invoice exists.
      expect(mocks.prisma.payment.update).toHaveBeenCalled();
      expect(mocks.completeXeroSyncOperation).toHaveBeenCalledWith(
        "op_1",
        expect.objectContaining({
          status: "SUCCEEDED",
          responsePayload: expect.objectContaining({
            invoiceEmailError: null,
            invoiceEmailSkipped: true,
            invoiceEmailWithheldByNoEmails: false,
            invoiceEmailWithheldForEnvironment: true,
          }),
        })
      );
    });

    it("contains the invoice's contact BEFORE the invoice exists, and keeps it AUTHORISED", async () => {
      /*
        #3036 (INV-CONFIG-005). The half #3035 could not cover: the invoice is
        AUTHORISED and stays that way, and XERO emails its own reminders for an
        outstanding authorised invoice with no API call from here. So the contact
        this invoice is raised against has to lose its real address BEFORE the
        invoice exists.
      */
      declareEnvironmentRole("non-production");
      mocks.prisma.booking.findUnique.mockResolvedValue(internetBankingBooking());

      await expect(createXeroInvoiceForBooking("booking_1")).resolves.toBe(
        "inv_1"
      );

      expect(
        mocks.xeroClientInstance.accountingApi.updateContact
      ).toHaveBeenCalledWith(
        "tenant_1",
        "contact_1",
        {
          contacts: [
            {
              contactID: "contact_1",
              emailAddress: toXeroSandboxContactEmail("member@example.com"),
            },
          ],
        },
        expect.any(String)
      );
      const [, invoicePayload] =
        mocks.xeroClientInstance.accountingApi.createInvoices.mock.calls[0];
      expect(invoicePayload.invoices[0].status).toBe("AUTHORISED");
    });

    it("raises NO invoice at all when the contact cannot be contained", async () => {
      // The point of putting the gate inside the funnel: an invoice writer that
      // cannot prove its contact is safe raises nothing, without needing to know
      // anything about containment itself.
      declareEnvironmentRole("non-production");
      mocks.prisma.booking.findUnique.mockResolvedValue(internetBankingBooking());
      mocks.xeroClientInstance.accountingApi.updateContact.mockRejectedValue(
        new Error("400 from Xero")
      );

      await expect(createXeroInvoiceForBooking("booking_1")).rejects.toThrow(
        /still able to reach a member/
      );

      expect(
        mocks.xeroClientInstance.accountingApi.createInvoices
      ).not.toHaveBeenCalled();
    });

    /*
      REWRITTEN BY #3036, and the change is the point rather than a test fix.
      Under #3035 alone an UNDECLARED installation raised the invoice and merely
      declined to email it, reporting PARTIAL so an operator could see the
      unemailed invoice. #3036 refuses EARLIER: the contact cannot be resolved at
      all without knowing which installation this is, because the answer decides
      what address may sit on that contact — so no invoice is raised, and there
      is nothing to report PARTIAL about.

      The PARTIAL / `invoiceEmailError` shape #3035 built is still asserted, in
      `xero-invoice-email-boundary.test.ts` ("withholds as a FAULT when the
      installation is undeclared"), and it is still reachable from these
      workflows in the narrow window where the role is readable when the contact
      is resolved and unreadable a moment later when the invoice is emailed.
    */
    it("raises no invoice at all when nobody has said what this installation is", async () => {
      vi.stubEnv("APP_ENVIRONMENT_ROLE", "");
      mocks.prisma.booking.findUnique.mockResolvedValue(internetBankingBooking());

      await expect(createXeroInvoiceForBooking("booking_1")).rejects.toThrow(
        /APP_ENVIRONMENT_ROLE/
      );

      expect(
        mocks.xeroClientInstance.accountingApi.createInvoices
      ).not.toHaveBeenCalled();
      expect(
        mocks.xeroClientInstance.accountingApi.updateContact
      ).not.toHaveBeenCalled();
      expect(
        mocks.xeroClientInstance.accountingApi.emailInvoice
      ).not.toHaveBeenCalled();
      expect(mocks.prisma.emailLog.create).not.toHaveBeenCalled();
    });
  });

  /*
    #2929 — the administrator's creation-time "do not email the member" choice,
    carried to the Xero invoice email that same creation raises.

    Every test here drives the INTERNET BANKING path with `syncOperationId`,
    because that is the whole point: the officer's choice is not a parameter to
    this function, it is a value on the operation row a dispatcher claimed. The
    request that made the choice ended long ago.
  */
  describe("the creation-time \"do not email the member\" choice", () => {
    function internetBankingBooking(
      overrides: Record<string, unknown> = {},
    ) {
      return {
        id: "booking_1",
        memberId: "mem_1",
        member: { id: "mem_1", email: "member@example.test" },
        lodgeId: "lodge_1",
        checkIn: "2026-07-31T00:00:00.000Z",
        checkOut: "2026-08-02T00:00:00.000Z",
        createdAt: "2026-05-15T10:30:00.000Z",
        discountCents: 0,
        promoAdjustmentCents: 0,
        noEmails: false,
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
        ...overrides,
      };
    }

    /** What the operation row a dispatcher claimed says about delivery. */
    function operationSays(invoiceEmailDelivery: string | null) {
      mocks.prisma.xeroSyncOperation.findUnique.mockResolvedValue({
        invoiceEmailDelivery,
      });
    }

    function completionPayload() {
      const call = mocks.completeXeroSyncOperation.mock.calls.at(-1);
      return (call?.[1] as { responsePayload: Record<string, unknown> })
        .responsePayload;
    }

    beforeEach(() => {
      mocks.prisma.booking.findUnique.mockResolvedValue(
        withMoneyBuildUpProjection(internetBankingBooking()),
      );
      mocks.xeroClientInstance.accountingApi.emailInvoice.mockResolvedValue({
        body: {},
      });
    });

    /*
      THE NAMED TEST the issue's last acceptance criterion asks for.

      THE MUTATION THAT FAILS IT: delete `!invoiceEmailWithheldByCreationChoice`
      from the `invoiceEmailPolicy` conjunction in xero-booking-invoices.ts —
      the gate that decides whether `sendXeroInvoiceEmail` is reached at all.
      Xero is then asked to email the invoice the officer chose not to send and
      the first assertion below fails.

      NOT the mutation you might reach for first. Deleting the
      `xeroInvoiceEmailIsWithheldAtCreation(...)` term from
      `invoiceEmailWithheldByCreationChoice` itself leaves that flag ALWAYS
      true, so the email is still withheld and this test still passes. (The
      suite as a whole does discriminate — "emails the invoice exactly as before
      when the officer chose to send" fails on that one — but the criterion asks
      for a NAMED test, and a comment pointing the next reader at the wrong edit
      is worse than no comment at all: they make it, see green, and conclude the
      suppression is untested.)
    */
    it("withholds the Xero invoice email when the officer who created the booking chose not to email the member (#2929)", async () => {
      operationSays("WITHHELD_AT_CREATION");

      await expect(
        createXeroInvoiceForBooking("booking_1", { syncOperationId: "op_1" }),
      ).resolves.toBe("inv_1");

      // The email, and ONLY the email, is withheld.
      expect(
        mocks.xeroClientInstance.accountingApi.emailInvoice,
      ).not.toHaveBeenCalled();
      // The invoice is still raised, and still AUTHORISED: the club is owed the
      // money either way, and Xero is where that one invoice is sent from.
      expect(
        mocks.xeroClientInstance.accountingApi.createInvoices,
      ).toHaveBeenCalled();
      const [, invoicePayload] =
        mocks.xeroClientInstance.accountingApi.createInvoices.mock.calls[0];
      expect(invoicePayload.invoices[0].status).toBe("AUTHORISED");
      // Its ids are persisted, so no surface thinks the invoice is missing.
      expect(mocks.prisma.payment.update).toHaveBeenCalled();

      // The withheld-email audit evidence, in the existing vocabulary, naming
      // THIS reason rather than the switch.
      expect(mocks.prisma.emailLog.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          bookingId: "booking_1",
          templateName: "xero-booking-invoice-email",
          status: "SKIPPED_NO_EMAILS",
          to: "member@example.test",
          htmlBody: null,
          errorMessage: expect.stringContaining(
            "chose not to email the member",
          ),
        }),
        select: { id: true },
      });

      // A deliberate, complete outcome: SUCCEEDED, no error, and reported under
      // its own key so no operator is told the persistent switch is on.
      expect(mocks.completeXeroSyncOperation).toHaveBeenCalledWith(
        "op_1",
        expect.objectContaining({ status: "SUCCEEDED" }),
      );
      expect(completionPayload()).toMatchObject({
        invoiceEmailError: null,
        invoiceEmailSkipped: true,
        invoiceEmailWithheldByCreationChoice: true,
        invoiceEmailWithheldByNoEmails: false,
        invoiceEmailWithheldForEnvironment: false,
      });
    });

    it("emails the invoice exactly as before when the officer chose to send", async () => {
      operationSays("SEND");

      await expect(
        createXeroInvoiceForBooking("booking_1", { syncOperationId: "op_1" }),
      ).resolves.toBe("inv_1");

      expect(
        mocks.xeroClientInstance.accountingApi.emailInvoice,
      ).toHaveBeenCalledWith(
        "tenant_1",
        "inv_1",
        expect.any(Object),
        "booking:booking_1:invoice-email:inv_1:v1",
      );
      expect(mocks.prisma.emailLog.create).not.toHaveBeenCalled();
      expect(completionPayload()).toMatchObject({
        invoiceEmailSkipped: false,
        invoiceEmailWithheldByCreationChoice: false,
      });
    });

    it("emails the invoice when the operation records no instruction at all — every row written before #2929", async () => {
      operationSays(null);

      await expect(
        createXeroInvoiceForBooking("booking_1", { syncOperationId: "op_1" }),
      ).resolves.toBe("inv_1");

      expect(
        mocks.xeroClientInstance.accountingApi.emailInvoice,
      ).toHaveBeenCalled();
      expect(completionPayload()).toMatchObject({
        invoiceEmailWithheldByCreationChoice: false,
      });
    });

    it("emails the invoice when the stored value is not one this application recognises", async () => {
      // Fail-open is the RIGHT answer only here: an unrecognised value is not a
      // withhold anybody asked for, and the member is owed the invoice they have
      // to pay. A typo in a future enqueuer must not silently stop invoices
      // reaching members.
      operationSays("withheld_at_creation");

      await expect(
        createXeroInvoiceForBooking("booking_1", { syncOperationId: "op_1" }),
      ).resolves.toBe("inv_1");

      expect(
        mocks.xeroClientInstance.accountingApi.emailInvoice,
      ).toHaveBeenCalled();
    });

    it("reads nothing at all when no dispatcher claimed a row for this run", async () => {
      // A self-minting run has no enqueuer and therefore no instruction; asking
      // the row we are about to write would be asking ourselves.
      await expect(createXeroInvoiceForBooking("booking_1")).resolves.toBe(
        "inv_1",
      );

      expect(
        mocks.prisma.xeroSyncOperation.findUnique,
      ).not.toHaveBeenCalled();
      expect(
        mocks.xeroClientInstance.accountingApi.emailInvoice,
      ).toHaveBeenCalled();
    });

    it("touches nothing persistent: not the switch, not the contact's address", async () => {
      operationSays("WITHHELD_AT_CREATION");

      await createXeroInvoiceForBooking("booking_1", {
        syncOperationId: "op_1",
      });

      // `prisma.booking` in this file's double has no `update` delegate at all,
      // so a write to Booking.noEmails here could not even be attempted — but
      // state it, because the rule is what matters and the double may grow one.
      expect(
        (mocks.prisma.booking as Record<string, unknown>).update,
      ).toBeUndefined();
      // The club's live site never rewrites the contact; that is the copy-only
      // containment path, and a withhold is not a reason to touch an address.
      expect(
        mocks.xeroClientInstance.accountingApi.updateContact,
      ).not.toHaveBeenCalled();
    });

    it("survives the payload rewrite, so an operator retry hours later still withholds", async () => {
      /*
        THE DURABILITY PROPERTY, and the reason this is a column rather than a
        `requestPayload` key. This function REWRITES requestPayload wholesale
        with the Xero invoice request before its first provider call. If the
        instruction lived there it would be destroyed by the run that then
        failed, and the retry — which is the execution that actually needs it —
        would find nothing and email the member.
      */
      operationSays("WITHHELD_AT_CREATION");

      await createXeroInvoiceForBooking("booking_1", {
        syncOperationId: "op_1",
      });

      // It is read from the column, by name.
      expect(mocks.prisma.xeroSyncOperation.findUnique).toHaveBeenCalledWith({
        where: { id: "op_1" },
        select: { invoiceEmailDelivery: true },
      });
      // And nothing this run writes can disturb it: no update through the
      // client, and no completion payload, names the column.
      for (const [, args] of mocks.prisma.xeroSyncOperation.update.mock.calls.entries()) {
        expect(JSON.stringify(args ?? {})).not.toContain("invoiceEmailDelivery");
      }
      for (const call of mocks.completeXeroSyncOperation.mock.calls) {
        expect(Object.keys(call[1] as object)).not.toContain(
          "invoiceEmailDelivery",
        );
      }
    });

    it("records the SWITCH, not this choice, when a silenced booking also carries one — one reason per event", async () => {
      // `INV-CONFIG-004`: the four non-delivery outcomes stay distinguishable,
      // and one event carries one reason. The persistent switch is the broader
      // fact and is what the officer has to act on, so it is the one recorded.
      operationSays("WITHHELD_AT_CREATION");
      mocks.prisma.booking.findUnique.mockResolvedValue(
        withMoneyBuildUpProjection(internetBankingBooking({ noEmails: true })),
      );

      await createXeroInvoiceForBooking("booking_1", {
        syncOperationId: "op_1",
      });

      expect(
        mocks.xeroClientInstance.accountingApi.emailInvoice,
      ).not.toHaveBeenCalled();
      expect(mocks.prisma.emailLog.create).toHaveBeenCalledTimes(1);
      expect(completionPayload()).toMatchObject({
        invoiceEmailWithheldByNoEmails: true,
        invoiceEmailWithheldByCreationChoice: false,
      });
    });

    /*
      ONE SUBJECT PER TEMPLATE, whichever decision withheld it (#2929 fix
      round).

      The withheld-emails banner groups by TEMPLATE NAME and renders a single
      representative subject for the group — whichever row is newest. Two
      withhold sites spelling the wording out separately therefore makes one
      kind of withheld email show two different subjects depending on which
      happened last, which reads to an officer as two different messages. The
      wording now lives in one constant above both sites; this is the guard that
      keeps it there.
    */
    it("gives the same withheld subject whichever decision withheld it", async () => {
      function subjectOfWithheldRow(index: number): string {
        const call = mocks.prisma.emailLog.create.mock.calls[index] as [
          { data: { subject: string } },
        ];
        return call[0].data.subject;
      }

      // The creation-time choice, on a booking whose switch was never used.
      operationSays("WITHHELD_AT_CREATION");
      await createXeroInvoiceForBooking("booking_1", {
        syncOperationId: "op_1",
      });

      // The persistent switch, with no creation-time instruction at all.
      operationSays(null);
      mocks.prisma.booking.findUnique.mockResolvedValue(
        withMoneyBuildUpProjection(internetBankingBooking({ noEmails: true })),
      );
      await createXeroInvoiceForBooking("booking_1", {
        syncOperationId: "op_1",
      });

      expect(mocks.prisma.emailLog.create).toHaveBeenCalledTimes(2);
      expect(subjectOfWithheldRow(1)).toBe(subjectOfWithheldRow(0));
      expect(subjectOfWithheldRow(0)).toContain(
        "for your Internet Banking booking payment",
      );
    });

    /*
      THE FOUR OUTCOMES, side by side (`INV-CONFIG-004`). Three of them send no
      email, and telling them apart is the whole reason each has its own key: a
      support call about "the member never got the invoice" is answered
      differently depending on which of these it was, and three states that look
      identical from outside are how the next one gets misdiagnosed.
    */
    it("keeps business suppression, environment-safety suppression, provider failure and an ordinary send distinguishable", async () => {
      async function signature() {
        const payload = completionPayload();
        return {
          emailed:
            mocks.xeroClientInstance.accountingApi.emailInvoice.mock.calls
              .length > 0,
          withheldRow: mocks.prisma.emailLog.create.mock.calls.length > 0,
          status: (
            mocks.completeXeroSyncOperation.mock.calls.at(-1)?.[1] as {
              status: string;
            }
          ).status,
          byCreationChoice: payload.invoiceEmailWithheldByCreationChoice,
          forEnvironment: payload.invoiceEmailWithheldForEnvironment,
          failed: payload.invoiceEmailError !== null,
          // #3001: three faults share one key, and they need three remedies.
          cause: payload.invoiceEmailFailureCause ?? null,
        };
      }

      // 1. This issue's business-rule suppression.
      operationSays("WITHHELD_AT_CREATION");
      await createXeroInvoiceForBooking("booking_1", {
        syncOperationId: "op_1",
      });
      const businessRule = await signature();

      // 2. The environment-safety suppression (#3035): NOT the club's decision,
      //    so no withheld row is written at all.
      vi.clearAllMocks();
      declareEnvironmentRole("non-production");
      operationSays("SEND");
      mocks.prisma.booking.findUnique.mockResolvedValue(withMoneyBuildUpProjection(internetBankingBooking()));
      mocks.xeroClientInstance.accountingApi.getContact.mockResolvedValue({
        body: {
          contacts: [
            { contactID: "contact_1", emailAddress: "member@example.com" },
          ],
        },
      });
      mocks.xeroClientInstance.accountingApi.updateContact.mockResolvedValue({
        body: {},
      });
      await createXeroInvoiceForBooking("booking_1", {
        syncOperationId: "op_1",
      });
      const environmentSafety = await signature();

      // 3. An outright provider failure: nothing was decided, something broke.
      vi.clearAllMocks();
      declareEnvironmentRole("production");
      operationSays("SEND");
      mocks.prisma.booking.findUnique.mockResolvedValue(withMoneyBuildUpProjection(internetBankingBooking()));
      mocks.xeroClientInstance.accountingApi.emailInvoice.mockRejectedValue(
        new Error("503 from Xero"),
      );
      await createXeroInvoiceForBooking("booking_1", {
        syncOperationId: "op_1",
      });
      const providerFailure = await signature();

      // 4. An ordinary send.
      vi.clearAllMocks();
      operationSays("SEND");
      mocks.prisma.booking.findUnique.mockResolvedValue(withMoneyBuildUpProjection(internetBankingBooking()));
      mocks.xeroClientInstance.accountingApi.emailInvoice.mockResolvedValue({
        body: {},
      });
      await createXeroInvoiceForBooking("booking_1", {
        syncOperationId: "op_1",
      });
      const ordinarySend = await signature();

      expect(businessRule).toEqual({
        emailed: false,
        withheldRow: true,
        status: "SUCCEEDED",
        byCreationChoice: true,
        forEnvironment: false,
        failed: false,
        cause: null,
      });
      expect(environmentSafety).toEqual({
        emailed: false,
        withheldRow: false,
        status: "SUCCEEDED",
        byCreationChoice: false,
        forEnvironment: true,
        failed: false,
        cause: null,
      });
      expect(providerFailure).toEqual({
        emailed: true,
        withheldRow: false,
        status: "PARTIAL",
        byCreationChoice: false,
        forEnvironment: false,
        failed: true,
        cause: "PROVIDER",
      });
      expect(ordinarySend).toEqual({
        emailed: true,
        withheldRow: false,
        status: "SUCCEEDED",
        byCreationChoice: false,
        forEnvironment: false,
        failed: false,
        cause: null,
      });

      // Belt and braces: no two of the four read the same from outside.
      const seen = [
        businessRule,
        environmentSafety,
        providerFailure,
        ordinarySend,
      ].map((s) => JSON.stringify(s));
      expect(new Set(seen).size).toBe(4);
    });
  });

  it("emails Internet Banking invoices and updates the Internet Banking transaction", async () => {
    mocks.prisma.booking.findUnique.mockResolvedValue(withMoneyBuildUpProjection({
      id: "booking_1",
      memberId: "mem_1",
      member: { id: "mem_1" },
      // Booking.lodgeId is NOT NULL in the schema; the season read that picks
      // the hut-fee item code is scoped to it.
      lodgeId: "lodge_1",
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
    }));
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
    mocks.prisma.booking.findUnique.mockResolvedValue(withMoneyBuildUpProjection({
      id: "booking_1",
      memberId: "mem_1",
      member: { id: "mem_1" },
      // Booking.lodgeId is NOT NULL in the schema; the season read that picks
      // the hut-fee item code is scoped to it.
      lodgeId: "lodge_1",
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
    }));
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

  it("keeps the due date an already-issued invoice was issued with (#2697)", async () => {
    // #2697 corrected the due date to the club's calendar day. That correction
    // must reach NEW invoices only — the owner decision is that already-issued
    // Xero invoices are untouched, with no write-back.
    //
    // Before that fix, recomputing the due date on update was value-stable, so
    // nobody had to think about it. Afterwards it is not: this booking was made
    // at 00:00 on 15 May NZST, which is still 14 May in UTC, so the old
    // derivation issued "2026-05-14" and the new one would produce "2026-05-15".
    // Recomputing here would silently move a live AUTHORISED invoice's due date
    // the next time an unrelated edit synced.
    mocks.prisma.booking.findUnique.mockResolvedValue({
      id: "booking_1",
      memberId: "mem_1",
      member: { id: "mem_1" },
      checkIn: "2026-08-03T00:00:00.000Z",
      checkOut: "2026-08-05T00:00:00.000Z",
      createdAt: "2026-05-14T12:00:00.000Z",
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
            // What Xero already holds: the pre-#2697 UTC-truncated day.
            dueDate: "2026-05-14",
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
      body: { invoices: [{ invoiceID: "inv_1", invoiceNumber: "INV-1" }] },
    });

    await expect(updateXeroBookingInvoiceForBooking("booking_1")).resolves.toBe("inv_1");

    expect(mocks.xeroClientInstance.accountingApi.updateInvoice).toHaveBeenCalledWith(
      "tenant_1",
      "inv_1",
      {
        invoices: [expect.objectContaining({ dueDate: "2026-05-14" })],
      },
      undefined,
      "booking:booking_1:invoice-update:inv_1:2026-08-03:2026-08-05:v1"
    );
  });

  /** The booking shape the update path needs: a payment carrying an invoice id. */
  function bookingWithExistingInvoice() {
    return {
      id: "booking_1",
      memberId: "mem_1",
      member: { id: "mem_1" },
      checkIn: "2026-08-03T00:00:00.000Z",
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
    };
  }

  /*
    INV-CONFIG-005 (#3036 review P0-2). Re-pricing an invoice can RAISE its
    amount due, and this path never goes through `findOrCreateXeroContact` — so
    on a copy restored from the club's live database nothing here had ever looked
    at what the invoice's contact holds, while Xero goes on emailing reminders
    for an outstanding AUTHORISED invoice from its own servers.
  */
  it("contains the invoice's contact before re-pricing it on a copy", async () => {
    declareEnvironmentRole("non-production");
    mocks.prisma.booking.findUnique.mockResolvedValue(
      bookingWithExistingInvoice()
    );
    mocks.prisma.member.findUnique.mockResolvedValue({
      email: "member@example.com",
      xeroContactId: "contact_1",
    });
    mocks.xeroClientInstance.accountingApi.getInvoice.mockResolvedValue({
      body: {
        invoices: [
          {
            invoiceID: "inv_1",
            invoiceNumber: "INV-1",
            type: "ACCREC",
            status: "AUTHORISED",
            contact: { contactID: "contact_1" },
            lineAmountTypes: "Inclusive",
            reference: "Booking booking_",
            lineItems: [
              {
                lineItemID: "line_1",
                description: "old",
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
      body: { invoices: [{ invoiceID: "inv_1", invoiceNumber: "INV-1" }] },
    });

    await expect(updateXeroBookingInvoiceForBooking("booking_1")).resolves.toBe(
      "inv_1"
    );

    expect(
      mocks.xeroClientInstance.accountingApi.updateContact
    ).toHaveBeenCalledWith(
      "tenant_1",
      "contact_1",
      {
        contacts: [
          {
            contactID: "contact_1",
            emailAddress: toXeroSandboxContactEmail("member@example.com"),
          },
        ],
      },
      expect.any(String)
    );
  });

  it("contains the INVOICE's contact, not the member's link, when they differ", async () => {
    /*
      The permissive defect this replaced. The update re-sends
      `currentInvoice.contact`, and after a member merge or an admin re-link that
      is a DIFFERENT contact from `Member.xeroContactId`. The first version of
      this check ran at the top of the function against the member's link, so it
      proved containment of a contact this update never touches while raising the
      amount due on one it does.
    */
    declareEnvironmentRole("non-production");
    mocks.prisma.booking.findUnique.mockResolvedValue(
      bookingWithExistingInvoice()
    );
    mocks.prisma.member.findUnique.mockResolvedValue({
      email: "member@example.com",
      xeroContactId: "contact_survivor",
    });
    mocks.xeroClientInstance.accountingApi.getInvoice.mockResolvedValue({
      body: {
        invoices: [
          {
            invoiceID: "inv_1",
            invoiceNumber: "INV-1",
            type: "ACCREC",
            status: "AUTHORISED",
            contact: { contactID: "contact_loser" },
            lineAmountTypes: "Inclusive",
            reference: "Booking booking_",
            lineItems: [
              {
                lineItemID: "line_1",
                description: "old",
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
    mocks.xeroClientInstance.accountingApi.getContact.mockResolvedValue({
      body: {
        contacts: [
          { contactID: "contact_loser", emailAddress: "member@example.com" },
        ],
      },
    });
    mocks.xeroClientInstance.accountingApi.updateInvoice.mockResolvedValue({
      body: { invoices: [{ invoiceID: "inv_1", invoiceNumber: "INV-1" }] },
    });

    await expect(updateXeroBookingInvoiceForBooking("booking_1")).resolves.toBe(
      "inv_1"
    );

    expect(
      mocks.xeroClientInstance.accountingApi.getContact
    ).toHaveBeenCalledWith("tenant_1", "contact_loser");
    expect(
      mocks.xeroClientInstance.accountingApi.updateContact
    ).toHaveBeenCalledWith(
      "tenant_1",
      "contact_loser",
      expect.objectContaining({
        contacts: [
          expect.objectContaining({ contactID: "contact_loser" }),
        ],
      }),
      expect.any(String)
    );
  });

  it("re-prices nothing on a copy that cannot prove the contact contained", async () => {
    declareEnvironmentRole("non-production");
    mocks.prisma.booking.findUnique.mockResolvedValue(
      bookingWithExistingInvoice()
    );
    mocks.prisma.member.findUnique.mockResolvedValue({
      email: "member@example.com",
      xeroContactId: "contact_1",
    });
    mocks.xeroClientInstance.accountingApi.getContact.mockRejectedValue(
      new Error("503 from Xero")
    );

    await expect(
      updateXeroBookingInvoiceForBooking("booking_1")
    ).rejects.toThrow(/cannot prove the contact is unable to reach a member/);
    expect(
      mocks.xeroClientInstance.accountingApi.updateInvoice
    ).not.toHaveBeenCalled();
  });

  it("asks none of that on the club's live site", async () => {
    declareEnvironmentRole("production");
    mocks.prisma.booking.findUnique.mockResolvedValue(
      bookingWithExistingInvoice()
    );
    mocks.xeroClientInstance.accountingApi.getInvoice.mockResolvedValue({
      body: {
        invoices: [
          {
            invoiceID: "inv_1",
            invoiceNumber: "INV-1",
            type: "ACCREC",
            status: "AUTHORISED",
            contact: { contactID: "contact_1" },
            lineAmountTypes: "Inclusive",
            reference: "Booking booking_",
            lineItems: [
              {
                lineItemID: "line_1",
                description: "old",
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
      body: { invoices: [{ invoiceID: "inv_1", invoiceNumber: "INV-1" }] },
    });

    await expect(updateXeroBookingInvoiceForBooking("booking_1")).resolves.toBe(
      "inv_1"
    );

    expect(
      mocks.xeroClientInstance.accountingApi.updateContact
    ).not.toHaveBeenCalled();
    expect(
      mocks.prisma.xeroSandboxContactContainment.findUnique
    ).not.toHaveBeenCalled();
  });

  // The Stripe payment recorded against a freshly raised invoice is
  // bank-reconciliation input, and its date decides which GST period the cash
  // falls in. It read the clock's UTC day, which is still yesterday for roughly
  // the first half of every New Zealand day (#2834, INV-DATE-019). The instants
  // below are chosen so a wrong zone fails them: the first is 00:00 NZST, which
  // any zone shallower than UTC+12 gets wrong, and the second is 00:30 NZDT,
  // which a fixed +12 zone with no daylight saving gets wrong.
  describe.each([
    {
      label: "NZST (UTC+12), the first instant of a club day",
      instant: new Date("2026-06-14T12:00:00.000Z"),
      utcDay: "2026-06-14",
      clubDay: "2026-06-15",
    },
    {
      label: "NZDT (UTC+13), 00:30 on a club day",
      instant: new Date("2026-01-14T11:30:00.000Z"),
      utcDay: "2026-01-14",
      clubDay: "2026-01-15",
    },
  ])("the recorded Stripe payment date — $label", ({ instant, utcDay, clubDay }) => {
    beforeEach(() => {
      // Say what actually happened before any date assertion can turn an
      // environment problem into what looks like the product bug.
      expectClubTimeZonePremise();
      // A fixture that drifted out of the divergence window would pass vacuously.
      expect(instant.toISOString().slice(0, 10)).toBe(utcDay);
      // The root freeze pins midday NZ, where the two calendars agree — the one
      // window this defect does not live in. Pin the divergent instant here.
      vi.setSystemTime(instant);
    });

    afterEach(() => {
      // Hand the clock back so the root `beforeEach` re-freezes the DEFAULT
      // instant for every test declared after this block. Without this the pin
      // leaks: `ensureFrozenTestClock()` returns early whenever anything is
      // already mocking `Date`, so it would never overwrite — nor restore — a
      // deliberate pin, and the rest of this file would silently run six months
      // earlier than 1 July 2026 (docs/TESTING.md rule 4).
      vi.useRealTimers();
    });

    it("is the club's calendar day, not the UTC one", async () => {
      mocks.prisma.booking.findUnique.mockResolvedValue(withMoneyBuildUpProjection({
        id: "booking_1",
        memberId: "mem_1",
        member: { id: "mem_1" },
        totalPriceCents: 10000,
        checkIn: "2026-07-31T00:00:00.000Z",
        checkOut: "2026-08-02T00:00:00.000Z",
        createdAt: "2026-05-15T10:30:00.000Z",
        discountCents: 0,
        guests: [
          {
            id: "guest_1",
            firstName: "Jordan",
            lastName: "Hartley-Smith",
            ageTier: "ADULT",
            isMember: true,
            priceCents: 10000,
            nights: [],
          },
        ],
        payment: {
          id: "pay_1",
          status: "SUCCEEDED",
          amountCents: 10000,
          refundedAmountCents: 0,
          creditAppliedCents: 0,
          stripePaymentIntentId: "pi_1",
          xeroInvoiceId: null,
          xeroInvoiceNumber: null,
          source: "STRIPE",
        },
      }));
      mocks.xeroClientInstance.accountingApi.createInvoices.mockResolvedValue({
        body: {
          invoices: [
            {
              invoiceID: "inv_1",
              invoiceNumber: "INV-1",
              total: 100,
              status: "AUTHORISED",
            },
          ],
        },
      });
      mocks.xeroClientInstance.accountingApi.createPayment.mockResolvedValue({
        body: { paymentID: "xpay_1" },
      });

      await expect(createXeroInvoiceForBooking("booking_1")).resolves.toBe("inv_1");

      const [, payment] =
        mocks.xeroClientInstance.accountingApi.createPayment.mock.calls[0];
      expect(payment.date).toBe(clubDay);
      expect(payment.date).not.toBe(utcDay);
    });
  });

  // The restore proof for the block above. It is declared AFTER it, so it runs
  // after it, and it fails the moment that `afterEach` stops handing the clock
  // back — which is the only thing standing between a scoped pin and roughly
  // 2,300 lines of later tests silently running on 14 January 2026 instead of
  // 1 July 2026, flipping past and future for every `2026-07-31` fixture in this
  // file. `frozenTestNow()` rather than the literal so the rollover canary's
  // `TEST_CLOCK_ISO` / `TEST_CLOCK_OFFSET_DAYS` runs still agree with it.
  it("hands the default frozen clock back to every test declared after the pinned block", () => {
    expect(new Date().toISOString()).toBe(frozenTestNow().toISOString());
  });

  describe("promo code discount line coding", () => {
    function bookingWithPromo(promo: {
      code: string;
      xeroItemCode: string | null;
      xeroAccountCode: string | null;
    } | null) {
      return withMoneyBuildUpProjection({
        id: "booking_1",
        memberId: "mem_1",
        member: { id: "mem_1" },
        totalPriceCents: 10000,
        checkIn: "2026-07-31T00:00:00.000Z",
        checkOut: "2026-08-02T00:00:00.000Z",
        createdAt: "2026-05-15T10:30:00.000Z",
        discountCents: 5000,
        promoAdjustmentCents: -5000,
        guests: [
          {
            id: "guest_1",
            firstName: "Jordan",
            lastName: "Hartley-Smith",
            ageTier: "ADULT",
            isMember: true,
            priceCents: 10000,
            nights: [],
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
        promoRedemption: promo
          ? {
              promoCode: promo,
              priceAdjustmentCents: -5000,
              allocations: [
                { memberId: "mem_1", priceAdjustmentCents: -5000 },
              ],
            }
          : null,
        nightAdjustments: [
          {
            bookingGuestId: "guest_1",
            beneficiaryMemberId: "mem_1",
            amountCents: -5000,
            bookingGuestNight: null,
          },
        ],
      });
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
      expect(mocks.startXeroSyncOperation).toHaveBeenCalledWith(
        expect.objectContaining({
          requestPayload: expect.objectContaining({
            moneyBuildUp: expect.objectContaining({
              moneyBuildUpOperation: "XERO_PROMO_LINE",
              moneyBuildUpSource: "STORED",
              moneyBuildUpStoredCents: -5000,
              moneyBuildUpDerivedCents: -5000,
            }),
          }),
        }),
      );
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

    it("classifies stale recorded promo rows even when today's Xero headline is zero", async () => {
      const booking = bookingWithPromo({
        code: "EXPIRED",
        xeroItemCode: null,
        xeroAccountCode: null,
      });
      booking.promoAdjustmentCents = 0;
      booking.discountCents = 0;
      mocks.prisma.booking.findUnique.mockResolvedValue(booking);

      await createXeroInvoiceForBooking("booking_1");

      expect(getPromoAdjustmentLine()).toBeUndefined();
      expect(mocks.prisma.booking.findUnique).toHaveBeenCalledTimes(1);
      expect(mocks.startXeroSyncOperation).toHaveBeenCalledWith(
        expect.objectContaining({
          requestPayload: expect.objectContaining({
            moneyBuildUp: expect.objectContaining({
              moneyBuildUpSource: "DERIVED_COMPATIBILITY_FALLBACK",
              moneyBuildUpFallbackClassification: "STORED_SIDE_DEFECT",
              moneyBuildUpStoredCents: -5000,
              moneyBuildUpDerivedCents: 0,
            }),
          }),
        }),
      );
    });
  });

  // #1765 — repay-after-refund: the Payment aggregate sits in
  // PARTIALLY_REFUNDED at invoice time (gross captures across generations
  // minus refunds), so the payment write must gate on captured-status +
  // positive NET cash and record the NET capture, never gate on
  // `status === "SUCCEEDED"` or write the gross aggregate.
  describe("#1765 repay-after-refund invoice payment", () => {
    function repayBooking(paymentOverrides: Record<string, unknown> = {}) {
      return withMoneyBuildUpProjection({
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
            priceCents: 9000,
          },
        ],
        payment: {
          id: "pay_1",
          // Production shape from #1765: paid 19500, fully refunded, repay
          // captured 9000 → gross 28500, refunded 19500, aggregate
          // PARTIALLY_REFUNDED. Net capture = 9000.
          status: "PARTIALLY_REFUNDED",
          amountCents: 28500,
          refundedAmountCents: 19500,
          creditAppliedCents: 0,
          stripePaymentIntentId: "pi_repay",
          xeroInvoiceId: null,
          xeroInvoiceNumber: null,
          source: "STRIPE",
          ...paymentOverrides,
        },
      });
    }

    beforeEach(() => {
      mocks.xeroClientInstance.accountingApi.createPayment.mockResolvedValue({
        body: { paymentID: "xpay_repay" },
      });
      mocks.allocateAppliedCreditForBooking.mockResolvedValue(undefined);
      mocks.xeroClientInstance.accountingApi.createInvoices.mockResolvedValue({
        body: {
          invoices: [
            {
              invoiceID: "inv_repay",
              invoiceNumber: "INV-9",
              total: 90,
              amountDue: 90,
              status: "AUTHORISED",
            },
          ],
        },
      });
    });

    it("records the NET capture (gross − refunded) as the invoice payment for a repay-settled booking", async () => {
      mocks.prisma.booking.findUnique.mockResolvedValue(repayBooking());

      await expect(createXeroInvoiceForBooking("booking_1")).resolves.toBe(
        "inv_repay"
      );

      expect(
        mocks.xeroClientInstance.accountingApi.createPayment
      ).toHaveBeenCalledTimes(1);
      const xeroPayment =
        mocks.xeroClientInstance.accountingApi.createPayment.mock.calls[0][1];
      // Net 9000 cents = $90, NOT the $285 gross aggregate.
      expect(xeroPayment.amount).toBe(90);
      expect(xeroPayment.reference).toBe("Stripe pi_repay");
      expect(mocks.completeXeroSyncOperation).toHaveBeenCalledWith(
        "op_1",
        expect.objectContaining({
          responsePayload: expect.objectContaining({
            paymentSkipped: false,
            paymentSkipReason: null,
          }),
        })
      );
    });

    it("caps the recorded payment at the invoice's amount due (Xero rejects overpayment)", async () => {
      // Legacy full-price capture on a booking whose invoice was repriced
      // below the captured cash: net 19500 > amountDue 9000.
      mocks.prisma.booking.findUnique.mockResolvedValue(
        repayBooking({
          status: "SUCCEEDED",
          amountCents: 19500,
          refundedAmountCents: 0,
        })
      );

      await createXeroInvoiceForBooking("booking_1");

      const xeroPayment =
        mocks.xeroClientInstance.accountingApi.createPayment.mock.calls[0][1];
      expect(xeroPayment.amount).toBe(90);
    });

    it("skips loudly, with a populated reason, when captured cash was fully refunded (net 0)", async () => {
      mocks.prisma.booking.findUnique.mockResolvedValue(
        repayBooking({
          status: "REFUNDED",
          amountCents: 19500,
          refundedAmountCents: 19500,
        })
      );

      await createXeroInvoiceForBooking("booking_1");

      expect(
        mocks.xeroClientInstance.accountingApi.createPayment
      ).not.toHaveBeenCalled();
      expect(mocks.logger.warn).toHaveBeenCalledWith(
        expect.objectContaining({
          bookingId: "booking_1",
          netCapturedCents: 0,
          paymentStatus: "REFUNDED",
        }),
        "Captured Stripe cash was fully refunded; no net cash remains to record against the invoice."
      );
      expect(mocks.completeXeroSyncOperation).toHaveBeenCalledWith(
        "op_1",
        expect.objectContaining({
          responsePayload: expect.objectContaining({
            paymentSkipped: true,
            paymentSkipReason:
              "Captured Stripe cash was fully refunded; no net cash remains to record against the invoice.",
          }),
        })
      );
    });

    it("still allocates applied credit for a repay booking that carries applied credit", async () => {
      // Repay generation captured the credit-reduced effective amount:
      // finalPrice 9000, applied 2000 → repay capture 7000; gross 26500.
      mocks.prisma.booking.findUnique.mockResolvedValue(
        repayBooking({
          amountCents: 26500,
          refundedAmountCents: 19500,
          creditAppliedCents: 2000,
        })
      );

      await expect(createXeroInvoiceForBooking("booking_1")).resolves.toBe(
        "inv_repay"
      );

      // Net cash $70 recorded, then the applied slice allocated — the old
      // status === "SUCCEEDED" gate skipped both for a PARTIALLY_REFUNDED
      // repay aggregate.
      const xeroPayment =
        mocks.xeroClientInstance.accountingApi.createPayment.mock.calls[0][1];
      expect(xeroPayment.amount).toBe(70);
      expect(mocks.allocateAppliedCreditForBooking).toHaveBeenCalledWith(
        "booking_1",
        expect.anything()
      );
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
    // #3036: on a copy the funnel reads the linked contact back and contains it
    // before returning its id. On the club's live site none of this runs.
    mocks.prisma.xeroSandboxContactContainment.findUnique.mockResolvedValue(null);
    mocks.prisma.xeroSandboxContactContainment.upsert.mockResolvedValue({});
    mocks.xeroClientInstance.accountingApi.getContact.mockResolvedValue({
      body: {
        contacts: [
          { contactID: "contact_1", emailAddress: "member@example.com" },
        ],
      },
    });
    mocks.xeroClientInstance.accountingApi.updateContact.mockResolvedValue({
      body: {},
    });

    mocks.prisma.$transaction.mockImplementation(async (callback) => callback(mocks.tx));
    mocks.tx.$executeRaw.mockResolvedValue(1);
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
      accessToken: encryptedAccess,
      refreshToken: encryptedRefresh,
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
    // #3036: on a copy the funnel reads the linked contact back and contains it
    // before returning its id. On the club's live site none of this runs.
    mocks.prisma.xeroSandboxContactContainment.findUnique.mockResolvedValue(null);
    mocks.prisma.xeroSandboxContactContainment.upsert.mockResolvedValue({});
    mocks.xeroClientInstance.accountingApi.getContact.mockResolvedValue({
      body: {
        contacts: [
          { contactID: "contact_1", emailAddress: "member@example.com" },
        ],
      },
    });
    mocks.xeroClientInstance.accountingApi.updateContact.mockResolvedValue({
      body: {},
    });

    mocks.prisma.xeroToken.findFirst.mockResolvedValue({
      id: "token_1",
      accessToken: encryptedAccess,
      refreshToken: encryptedRefresh,
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
    // #3036: on a copy the funnel reads the linked contact back and contains it
    // before returning its id. On the club's live site none of this runs.
    mocks.prisma.xeroSandboxContactContainment.findUnique.mockResolvedValue(null);
    mocks.prisma.xeroSandboxContactContainment.upsert.mockResolvedValue({});
    mocks.xeroClientInstance.accountingApi.getContact.mockResolvedValue({
      body: {
        contacts: [
          { contactID: "contact_1", emailAddress: "member@example.com" },
        ],
      },
    });
    mocks.xeroClientInstance.accountingApi.updateContact.mockResolvedValue({
      body: {},
    });
    mocks.findCanonicalPaymentRefundCreditNote.mockResolvedValue(null);
    mocks.prisma.xeroObjectLink.findMany.mockResolvedValue([]);
    // Default: every refunded cent is provider-backed cash (#2902 cases
    // override per test), so the pre-#2902 arithmetic is unchanged.
    mocks.resolveStripeCashRefundEvidence.mockImplementation(
      async (payment: { refundedAmountCents: number }) => ({
        cashRefundCents: payment.refundedAmountCents,
        countedRefundCents: payment.refundedAmountCents,
        refundLedgerRowCount: 1,
        accountCreditCents: 0,
        source: "provider-ledger",
      })
    );
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
      accessToken: encryptedAccess,
      refreshToken: encryptedRefresh,
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
        accessToken: encryptedAccess,
        refreshToken: encryptedRefresh,
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

    it("completes a queued account-credit-only operation without billing Xero (#2902)", async () => {
      // The pre-#2902 defect: an account-credit cancellation moved the mirror
      // (34100) with no Stripe cash, a fictitious delta op was queued, and
      // execution minted a real Xero note plus a Stripe-bank payment. The
      // execution-time recompute now reads the cash evidence (zero), so an
      // already-queued fictitious operation completes as a no-op.
      armCreatePath(34100, []);
      mocks.resolveStripeCashRefundEvidence.mockResolvedValue({
        cashRefundCents: 0,
        countedRefundCents: 0,
        refundLedgerRowCount: 0,
        accountCreditCents: 34100,
        source: "legacy-mirror",
      });

      await expect(
        createXeroCreditNote("pay_1", 34100, {
          watermarkCents: 34100,
          syncOperationId: "op_delta_x",
        })
      ).resolves.toBe("");

      expect(
        mocks.xeroClientInstance.accountingApi.createCreditNotes
      ).not.toHaveBeenCalled();
      expect(
        mocks.xeroClientInstance.accountingApi.createPayments
      ).not.toHaveBeenCalled();
      expect(mocks.completeXeroSyncOperation).toHaveBeenCalledWith(
        "op_delta_x",
        expect.objectContaining({
          responsePayload: expect.objectContaining({
            skippedNothingUncovered: true,
            cashRefundCents: 0,
            cashEvidenceSource: "legacy-mirror",
          }),
        })
      );
    });
  });
});
