import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  inboundFindUnique: vi.fn(),
  inboundCreate: vi.fn(),
  inboundUpdate: vi.fn(),
  paymentFindUnique: vi.fn(),
  linkFindMany: vi.fn(),
  operationFindFirst: vi.fn(),
  transaction: vi.fn(),
  txPaymentFindUnique: vi.fn(),
  txLinkUpdateMany: vi.fn(),
  txLinkUpsert: vi.fn(),
}));

vi.mock("@/lib/prisma", () => ({
  prisma: {
    xeroInboundEvent: {
      findUnique: mocks.inboundFindUnique,
      create: mocks.inboundCreate,
      update: mocks.inboundUpdate,
    },
    payment: {
      findUnique: mocks.paymentFindUnique,
    },
    xeroObjectLink: {
      findMany: mocks.linkFindMany,
    },
    xeroSyncOperation: {
      findFirst: mocks.operationFindFirst,
    },
    $transaction: mocks.transaction,
  },
}));

vi.mock("@/lib/xero-error-shape", () => ({
  getXeroErrorStatusCode: vi.fn(),
}));

vi.mock("@/lib/xero-links", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/xero-links")>();

  return {
    ...actual,
    buildXeroObjectUrl: vi.fn(
      (xeroObjectType: string, xeroObjectId: string) =>
        `https://go.xero.test/${xeroObjectType}/${xeroObjectId}`
    ),
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

import {
  buildXeroPayloadHash,
  findCanonicalPaymentRefundCreditNote,
  recordXeroInboundEvent,
  sanitizeForJson,
  upsertXeroObjectLink,
} from "@/lib/xero-sync";

describe("buildXeroPayloadHash", () => {
  it("hashes the unredacted outbound payload while stored JSON remains redacted", () => {
    const firstPayload = {
      contacts: [
        {
          contactID: "contact_1",
          emailAddress: "first@example.com",
          phones: [{ phoneType: "MOBILE", phoneNumber: "0211234567" }],
        },
      ],
    };
    const secondPayload = {
      contacts: [
        {
          contactID: "contact_1",
          emailAddress: "second@example.com",
          phones: [{ phoneType: "MOBILE", phoneNumber: "0217654321" }],
        },
      ],
    };

    expect(sanitizeForJson(firstPayload)).toEqual(sanitizeForJson(secondPayload));
    expect(buildXeroPayloadHash(firstPayload)).not.toBe(
      buildXeroPayloadHash(secondPayload)
    );
  });
});

describe("recordXeroInboundEvent", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("creates a new inbound event when the correlation key is new", async () => {
    mocks.inboundFindUnique.mockResolvedValue(null);
    mocks.inboundCreate.mockResolvedValue({ id: "evt_1" });

    await recordXeroInboundEvent({
      correlationKey: "contact:update:abc",
      eventType: "UPDATE",
      eventCategory: "CONTACT",
      payload: { contactID: "abc" },
    });

    expect(mocks.inboundCreate).toHaveBeenCalledWith({
      data: expect.objectContaining({
        correlationKey: "contact:update:abc",
        status: "RECEIVED",
        processedAt: null,
      }),
    });
    expect(mocks.inboundUpdate).not.toHaveBeenCalled();
  });

  it("preserves a processed inbound event when a duplicate delivery is recorded", async () => {
    const processedAt = new Date("2026-04-14T08:00:00.000Z");
    mocks.inboundFindUnique.mockResolvedValue({
      id: "evt_1",
      status: "PROCESSED",
      processedAt,
    });
    mocks.inboundUpdate.mockResolvedValue({ id: "evt_1" });

    await recordXeroInboundEvent({
      correlationKey: "contact:update:abc",
      eventType: "UPDATE",
      eventCategory: "CONTACT",
      payload: { contactID: "abc" },
      status: "RECEIVED",
    });

    expect(mocks.inboundUpdate).toHaveBeenCalledWith({
      where: {
        id: "evt_1",
      },
      data: expect.objectContaining({
        status: "PROCESSED",
        processedAt,
      }),
    });
  });
});

describe("findCanonicalPaymentRefundCreditNote", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.paymentFindUnique.mockResolvedValue({
      xeroRefundCreditNoteId: null,
    });
    mocks.linkFindMany.mockImplementation(async ({ where }: any) => {
      if (where?.role === "REFUND_CREDIT_NOTE") {
        return [
          {
            xeroObjectId: "cn_stale",
            xeroObjectNumber: "CN-OLD",
          },
        ];
      }

      if (where?.role === "REFUND_PAYMENT") {
        return [
          {
            metadata: {
              creditNoteId: "cn_paid",
            },
          },
        ];
      }

      return [];
    });
    mocks.operationFindFirst.mockResolvedValue({
      xeroObjectId: "cn_success",
      xeroObjectNumber: "CN-SUCCESS",
    });
  });

  it("prefers the credit note referenced by the active refund payment link", async () => {
    await expect(
      findCanonicalPaymentRefundCreditNote("payment_1")
    ).resolves.toEqual({
      xeroObjectId: "cn_paid",
      xeroObjectNumber: null,
      source: "refund_payment",
    });
  });

  it("falls back to the latest succeeded credit note create when no durable link exists yet", async () => {
    mocks.linkFindMany.mockImplementation(async ({ where }: any) => {
      if (where?.role === "REFUND_CREDIT_NOTE") {
        return [];
      }

      return [];
    });

    await expect(
      findCanonicalPaymentRefundCreditNote("payment_1")
    ).resolves.toEqual({
      xeroObjectId: "cn_success",
      xeroObjectNumber: "CN-SUCCESS",
      source: "operation",
    });
  });
});

describe("upsertXeroObjectLink", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.txLinkUpdateMany.mockResolvedValue({ count: 1 });
    mocks.txLinkUpsert.mockResolvedValue({ id: "link_1" });
    mocks.transaction.mockImplementation(async (callback: (tx: unknown) => Promise<unknown>) =>
      callback({
        payment: {
          findUnique: mocks.txPaymentFindUnique,
        },
        xeroObjectLink: {
          updateMany: mocks.txLinkUpdateMany,
          upsert: mocks.txLinkUpsert,
        },
      })
    );
  });

  it("deactivates older active refund credit note links when the payment already has a canonical note", async () => {
    mocks.txPaymentFindUnique.mockResolvedValue({
      xeroRefundCreditNoteId: "cn_canonical",
    });

    await upsertXeroObjectLink({
      localModel: "Payment",
      localId: "payment_1",
      xeroObjectType: "CREDIT_NOTE",
      xeroObjectId: "cn_canonical",
      xeroObjectNumber: "CN-1",
      role: "REFUND_CREDIT_NOTE",
    });

    expect(mocks.txLinkUpdateMany).toHaveBeenCalledWith({
      where: {
        localModel: "Payment",
        localId: "payment_1",
        xeroObjectType: "CREDIT_NOTE",
        role: "REFUND_CREDIT_NOTE",
        active: true,
        xeroObjectId: {
          not: "cn_canonical",
        },
      },
      data: {
        active: false,
      },
    });
    expect(mocks.txLinkUpsert).toHaveBeenCalledWith(
      expect.objectContaining({
        create: expect.objectContaining({
          active: true,
          xeroObjectNumber: "CN-1",
        }),
        update: expect.objectContaining({
          active: true,
          xeroObjectNumber: "CN-1",
        }),
      })
    );
  });

  it("keeps a stale duplicate refund credit note link inactive when it conflicts with the payment canonical note", async () => {
    mocks.txPaymentFindUnique.mockResolvedValue({
      xeroRefundCreditNoteId: "cn_canonical",
    });

    await upsertXeroObjectLink({
      localModel: "Payment",
      localId: "payment_1",
      xeroObjectType: "CREDIT_NOTE",
      xeroObjectId: "cn_duplicate",
      xeroObjectNumber: "CN-2",
      role: "REFUND_CREDIT_NOTE",
    });

    expect(mocks.txLinkUpdateMany).not.toHaveBeenCalled();
    expect(mocks.txLinkUpsert).toHaveBeenCalledWith(
      expect.objectContaining({
        create: expect.objectContaining({
          active: false,
          xeroObjectNumber: "CN-2",
        }),
        update: expect.objectContaining({
          active: false,
          xeroObjectNumber: "CN-2",
        }),
      })
    );
  });
});
