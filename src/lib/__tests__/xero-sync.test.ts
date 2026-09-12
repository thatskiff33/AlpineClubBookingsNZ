import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Prisma } from "@prisma/client";

const mocks = vi.hoisted(() => ({
  inboundFindUnique: vi.fn(),
  inboundCreate: vi.fn(),
  inboundUpdate: vi.fn(),
  paymentFindUnique: vi.fn(),
  linkFindMany: vi.fn(),
  operationFindFirst: vi.fn(),
  operationCount: vi.fn(),
  operationCreate: vi.fn(),
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
      count: mocks.operationCount,
      create: mocks.operationCreate,
    },
    $transaction: mocks.transaction,
  },
}));

vi.mock("@/lib/xero-error-shape", () => ({
  getXeroErrorStatusCode: vi.fn(),
}));

vi.mock("@/lib/xero-links", async (importOriginal) => {
  const actual = (await importOriginal()) as typeof import("@/lib/xero-links");

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
  startXeroSyncOperation,
  sumCoveredRefundCreditNoteCents,
  upsertXeroObjectLink,
} from "@/lib/xero-sync";
// The real builder — the mock above only replaces `buildXeroObjectUrl`.
import { buildXeroContactUrl } from "@/lib/xero-links";

describe("sumCoveredRefundCreditNoteCents (#1162)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("sums the recorded amounts of active refund credit note links", async () => {
    mocks.linkFindMany.mockResolvedValue([
      { xeroObjectId: "cn_1", metadata: { amountCents: 5000, watermarkCents: 5000 } },
      { xeroObjectId: "cn_2", metadata: { amountCents: 3000, watermarkCents: 8000 } },
    ]);

    await expect(sumCoveredRefundCreditNoteCents("payment_1")).resolves.toBe(8000);
    expect(mocks.operationFindFirst).not.toHaveBeenCalled();
  });

  it("falls back to the create operation's allocation amount for links without a recorded amount", async () => {
    mocks.linkFindMany.mockResolvedValue([
      { xeroObjectId: "cn_legacy", metadata: null },
    ]);
    mocks.operationFindFirst.mockResolvedValue({
      requestPayload: { allocation: { amount: 50 } },
    });

    await expect(sumCoveredRefundCreditNoteCents("payment_1")).resolves.toBe(5000);
    expect(mocks.operationFindFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          xeroObjectId: "cn_legacy",
          entityType: "CREDIT_NOTE",
          operationType: "CREATE",
          localModel: "Payment",
          localId: "payment_1",
        }),
      })
    );
  });

  it("counts nothing for a link whose recorded Xero status is VOIDED or DELETED (#2901 fix round)", async () => {
    mocks.linkFindMany.mockResolvedValue([
      { xeroObjectId: "cn_live", metadata: { amountCents: 9000, status: "AUTHORISED" } },
      // Status matching is trimmed + case-insensitive, like the inbound math.
      { xeroObjectId: "cn_voided", metadata: { amountCents: 1000, status: "voided" } },
      { xeroObjectId: "cn_deleted", metadata: { amountCents: 500, status: " DELETED " } },
    ]);

    await expect(sumCoveredRefundCreditNoteCents("payment_1")).resolves.toBe(9000);
    // A cancelled note is excluded outright — never "recovered" from the
    // create-operation payload either.
    expect(mocks.operationFindFirst).not.toHaveBeenCalled();
  });
});

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

  it("redacts sensitive error text before storing inbound event failures", async () => {
    mocks.inboundFindUnique.mockResolvedValue(null);
    mocks.inboundCreate.mockResolvedValue({ id: "evt_1" });

    await recordXeroInboundEvent({
      correlationKey: "contact:update:abc",
      eventType: "UPDATE",
      eventCategory: "CONTACT",
      payload: { contactID: "abc" },
      status: "FAILED",
      errorMessage:
        "Xero failed with Authorization: Bearer live-token and pi_123_secret_liveSecret",
    });

    expect(mocks.inboundCreate).toHaveBeenCalledWith({
      data: expect.objectContaining({
        status: "FAILED",
        errorMessage:
          "Xero failed with Authorization: Bearer [REDACTED] and [REDACTED]",
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

  it("merges inbound metadata over the outbound per-delta keys when mergeMetadata is set (#1354)", async () => {
    const txLinkFindUnique = vi.fn().mockResolvedValue({
      metadata: { amountCents: 3000, watermarkCents: 8000 },
    });
    mocks.transaction.mockImplementation(async (callback: (tx: unknown) => Promise<unknown>) =>
      callback({
        payment: {
          findUnique: mocks.txPaymentFindUnique,
        },
        xeroObjectLink: {
          updateMany: mocks.txLinkUpdateMany,
          upsert: mocks.txLinkUpsert,
          findUnique: txLinkFindUnique,
        },
      })
    );
    // STRIPE payment: per-delta links bypass canonical deactivation.
    mocks.txPaymentFindUnique.mockResolvedValue({
      source: "STRIPE",
      xeroRefundCreditNoteId: null,
    });

    await upsertXeroObjectLink({
      localModel: "Payment",
      localId: "payment_1",
      xeroObjectType: "CREDIT_NOTE",
      xeroObjectId: "cn_delta",
      xeroObjectNumber: "CN-8",
      role: "REFUND_CREDIT_NOTE",
      metadata: { status: "AUTHORISED", total: 30 },
      mergeMetadata: true,
    });

    // The update clause carries BOTH the outbound per-delta keys and the
    // inbound reconcile fields — pre-#1354 the replace destroyed
    // amountCents/watermarkCents minutes after every note was created.
    expect(mocks.txLinkUpsert).toHaveBeenCalledWith(
      expect.objectContaining({
        update: expect.objectContaining({
          metadata: {
            amountCents: 3000,
            watermarkCents: 8000,
            status: "AUTHORISED",
            total: 30,
          },
        }),
      })
    );
  });

  it("keeps replace semantics when mergeMetadata is not set", async () => {
    mocks.txPaymentFindUnique.mockResolvedValue({
      source: "STRIPE",
      xeroRefundCreditNoteId: null,
    });

    await upsertXeroObjectLink({
      localModel: "Payment",
      localId: "payment_1",
      xeroObjectType: "CREDIT_NOTE",
      xeroObjectId: "cn_delta",
      xeroObjectNumber: "CN-8",
      role: "REFUND_CREDIT_NOTE",
      metadata: { amountCents: 3000, watermarkCents: 8000 },
    });

    expect(mocks.txLinkUpsert).toHaveBeenCalledWith(
      expect.objectContaining({
        update: expect.objectContaining({
          metadata: { amountCents: 3000, watermarkCents: 8000 },
        }),
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

  it("deactivates a Stripe refund-note mirror when the incoming write carries a VOIDED status (#2901 fix round)", async () => {
    const txLinkFindUnique = vi.fn().mockResolvedValue({
      metadata: { amountCents: 3000, watermarkCents: 8000 },
    });
    mocks.transaction.mockImplementation(async (callback: (tx: unknown) => Promise<unknown>) =>
      callback({
        payment: {
          findUnique: mocks.txPaymentFindUnique,
        },
        xeroObjectLink: {
          updateMany: mocks.txLinkUpdateMany,
          upsert: mocks.txLinkUpsert,
          findUnique: txLinkFindUnique,
        },
      })
    );
    mocks.txPaymentFindUnique.mockResolvedValue({
      source: "STRIPE",
      xeroRefundCreditNoteId: "cn_delta",
    });

    // Inbound reconciliation (and the #2901 status recorder) write the live
    // provider status. A VOIDED note credits nothing, so its mirror must land
    // INACTIVE — before this, the upsert's update clause forced active: true
    // and re-armed phantom coverage the repair had just removed.
    await upsertXeroObjectLink({
      localModel: "Payment",
      localId: "payment_1",
      xeroObjectType: "CREDIT_NOTE",
      xeroObjectId: "cn_delta",
      xeroObjectNumber: "CN-8",
      role: "REFUND_CREDIT_NOTE",
      metadata: { status: "VOIDED", total: 30 },
      mergeMetadata: true,
    });

    expect(mocks.txLinkUpsert).toHaveBeenCalledWith(
      expect.objectContaining({
        create: expect.objectContaining({ active: false }),
        update: expect.objectContaining({
          active: false,
          metadata: expect.objectContaining({
            amountCents: 3000,
            watermarkCents: 8000,
            status: "VOIDED",
          }),
        }),
      })
    );
    // Sibling per-delta links are untouched either way.
    expect(mocks.txLinkUpdateMany).not.toHaveBeenCalled();
  });

  it("keeps every Stripe refund credit note link active so per-delta notes coexist (#1162)", async () => {
    mocks.txPaymentFindUnique.mockResolvedValue({
      source: "STRIPE",
      xeroRefundCreditNoteId: "cn_2",
    });

    await upsertXeroObjectLink({
      localModel: "Payment",
      localId: "payment_1",
      xeroObjectType: "CREDIT_NOTE",
      xeroObjectId: "cn_1",
      xeroObjectNumber: "CN-1",
      role: "REFUND_CREDIT_NOTE",
      metadata: { amountCents: 5000, watermarkCents: 5000 },
    });

    // A different note is canonical (cn_2), but cn_1's link must stay active and
    // its siblings must not be deactivated: each Stripe delta keeps its own note.
    expect(mocks.txLinkUpdateMany).not.toHaveBeenCalled();
    expect(mocks.txLinkUpsert).toHaveBeenCalledWith(
      expect.objectContaining({
        create: expect.objectContaining({ active: true }),
        update: expect.objectContaining({ active: true }),
      })
    );
  });

  // #2314: what this column HOLDS is organisation-agnostic, always. The
  // organisation is applied when the row is READ, because a short code baked
  // into a row is wrong the moment the club reconnects to a different Xero
  // organisation and nothing would ever correct it. Enforced at this funnel so
  // no caller has to remember — including the caller that hands one in.
  it("strips an organisation short code out of a URL a caller supplies", async () => {
    await upsertXeroObjectLink({
      localModel: "Member",
      localId: "member_1",
      xeroObjectType: "CONTACT",
      xeroObjectId: "contact_1",
      xeroObjectUrl: buildXeroContactUrl("contact_1", { shortCode: "!aBc12" }),
      role: "CONTACT",
    });

    const stored = mocks.txLinkUpsert.mock.calls[0][0];
    expect(stored.create.xeroObjectUrl).toBe(buildXeroContactUrl("contact_1"));
    expect(stored.update.xeroObjectUrl).toBe(buildXeroContactUrl("contact_1"));
    expect(stored.create.xeroObjectUrl).not.toContain("shortcode");
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

  it("deactivates older active canonical contact links before recording a new contact link", async () => {
    await upsertXeroObjectLink({
      localModel: "Member",
      localId: "member_1",
      xeroObjectType: "CONTACT",
      xeroObjectId: "contact_new",
      role: "CONTACT",
    });

    expect(mocks.txPaymentFindUnique).not.toHaveBeenCalled();
    expect(mocks.txLinkUpdateMany).toHaveBeenCalledWith({
      where: {
        localModel: "Member",
        localId: "member_1",
        role: "CONTACT",
        active: true,
        OR: [
          {
            xeroObjectType: {
              not: "CONTACT",
            },
          },
          {
            xeroObjectId: {
              not: "contact_new",
            },
          },
        ],
      },
      data: {
        active: false,
      },
    });
    expect(mocks.txLinkUpsert).toHaveBeenCalledWith(
      expect.objectContaining({
        create: expect.objectContaining({
          active: true,
          xeroObjectId: "contact_new",
        }),
        update: expect.objectContaining({
          active: true,
        }),
      })
    );
  });
});

describe("startXeroSyncOperation", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.operationCount.mockResolvedValue(0);
    mocks.operationCreate.mockImplementation(async ({ data }: { data: unknown }) => ({
      id: "op_started_1",
      data,
    }));
  });

  it("returns the winner's active row when the partial unique index rejects a lost concurrent enqueue (#1354)", async () => {
    mocks.operationCreate.mockRejectedValueOnce({ code: "P2002" });
    mocks.operationFindFirst.mockResolvedValue({
      id: "op_winner",
      status: "PENDING",
      correlationKey: "payment:payment_1:refund-credit-note:8000:v2",
    });

    const result = await startXeroSyncOperation({
      direction: "OUTBOUND",
      entityType: "CREDIT_NOTE",
      operationType: "CREATE",
      localModel: "Payment",
      localId: "payment_1",
      status: "PENDING",
      idempotencyKey: "payment:payment_1:refund-credit-note:8000:v2",
      correlationKey: "payment:payment_1:refund-credit-note:8000:v2",
    });

    expect(result).toMatchObject({ id: "op_winner" });
    expect(mocks.operationFindFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          correlationKey: "payment:payment_1:refund-credit-note:8000:v2",
          status: { in: ["PENDING", "RUNNING", "WAITING_PAYMENT"] },
        },
      })
    );
  });

  it("rethrows a unique violation with no surviving active row (or no correlation key)", async () => {
    mocks.operationCreate.mockRejectedValueOnce({ code: "P2002" });
    mocks.operationFindFirst.mockResolvedValue(null);

    await expect(
      startXeroSyncOperation({
        direction: "OUTBOUND",
        entityType: "CREDIT_NOTE",
        operationType: "CREATE",
        localModel: "Payment",
        localId: "payment_1",
        status: "PENDING",
        correlationKey: "key-x",
      })
    ).rejects.toMatchObject({ code: "P2002" });
  });

  it("writes via the global prisma client when no store is supplied and never leaks store into the payload", async () => {
    await startXeroSyncOperation({
      direction: "OUTBOUND",
      entityType: "CREDIT_NOTE",
      operationType: "CREATE",
      localModel: "Payment",
      localId: "payment_1",
      status: "PENDING",
      idempotencyKey: "payment:payment_1:unapplied-credit-note:4200:v1",
      correlationKey: "payment:payment_1:unapplied-credit-note:4200:v1",
    });

    // The default path exercises the attempt-count read and the create on the
    // global prisma client.
    expect(mocks.operationCount).toHaveBeenCalledWith({
      where: {
        OR: [
          { correlationKey: "payment:payment_1:unapplied-credit-note:4200:v1" },
          { idempotencyKey: "payment:payment_1:unapplied-credit-note:4200:v1" },
        ],
      },
    });
    expect(mocks.operationCreate).toHaveBeenCalledTimes(1);
    const createArg = mocks.operationCreate.mock.calls[0][0];
    expect(createArg.data).toEqual(
      expect.objectContaining({
        direction: "OUTBOUND",
        entityType: "CREDIT_NOTE",
        operationType: "CREATE",
        localModel: "Payment",
        localId: "payment_1",
        status: "PENDING",
        attemptCount: 1,
      })
    );
    expect(createArg.data).not.toHaveProperty("store");
  });

  it("writes through the supplied transaction store and leaves the global prisma client untouched", async () => {
    const txCount = vi.fn().mockResolvedValue(1);
    const txCreate = vi
      .fn()
      .mockImplementation(async ({ data }: { data: unknown }) => ({ id: "op_tx_1", data }));
    const store = {
      xeroSyncOperation: {
        count: txCount,
        create: txCreate,
      },
    } as unknown as Prisma.TransactionClient;

    const result = await startXeroSyncOperation({
      direction: "OUTBOUND",
      entityType: "CREDIT_NOTE",
      operationType: "CREATE",
      localModel: "Payment",
      localId: "payment_2",
      status: "PENDING",
      correlationKey: "payment:payment_2:unapplied-credit-note:9900:v1",
      store,
    });

    expect(result).toEqual(expect.objectContaining({ id: "op_tx_1" }));
    // The store handled both the attempt-count read and the create; the global
    // prisma client was never used.
    expect(txCount).toHaveBeenCalledTimes(1);
    expect(txCreate).toHaveBeenCalledTimes(1);
    expect(mocks.operationCount).not.toHaveBeenCalled();
    expect(mocks.operationCreate).not.toHaveBeenCalled();

    // attemptCount reflects the store's existing-attempt count (+1) and store is
    // not forwarded into the persisted row.
    const createArg = txCreate.mock.calls[0][0];
    expect(createArg.data.attemptCount).toBe(2);
    expect(createArg.data).not.toHaveProperty("store");
  });

  it("denormalizes queueType from the persisted payload with no drift (#1271)", async () => {
    await startXeroSyncOperation({
      direction: "OUTBOUND",
      entityType: "INVOICE",
      operationType: "CREATE",
      localModel: "Payment",
      localId: "payment_qt",
      status: "PENDING",
      idempotencyKey: "booking:booking_qt:invoice:v1",
      correlationKey: "booking:booking_qt:invoice:v1",
      requestPayload: {
        queueType: "BOOKING_INVOICE",
        bookingId: "booking_qt",
      },
    });

    const createArg = mocks.operationCreate.mock.calls[0][0];
    // At enqueue the denormalized column is derived from the SAME persisted
    // payload, so it is exactly equal to requestPayload.queueType.
    expect(createArg.data.queueType).toBe("BOOKING_INVOICE");
    expect(createArg.data.queueType).toBe(
      (createArg.data.requestPayload as { queueType?: string }).queueType
    );
    // #1272: this enqueue-time equality is the invariant #1272 relies on (it
    // scans only PENDING/WAITING_PAYMENT). Post-dispatch, handlers overwrite
    // requestPayload wholesale and drop queueType (e.g. xero-booking-invoices),
    // so the column keeps its enqueue value while payload.queueType is gone --
    // an intentional divergence that needs a DB round-trip to exercise, so it is
    // asserted here only at creation.
  });

  it("persists a null queueType for a REQUEUE payload that carries none (#1271)", async () => {
    await startXeroSyncOperation({
      direction: "OUTBOUND",
      entityType: "INVOICE",
      operationType: "REQUEUE",
      localModel: "Payment",
      localId: "payment_rq",
      status: "PENDING",
      correlationKey: "xero-operation:requeue:op_original_1",
      replayable: false,
      requestPayload: {
        originalOperationId: "op_original_1",
        originalOperationType: "CREATE",
        originalStatus: "FAILED",
      },
    });

    const createArg = mocks.operationCreate.mock.calls[0][0];
    // REQUEUE rows have no queueType in their payload, so the denormalized
    // column stays null and never invents a value.
    expect(createArg.data.queueType).toBeNull();
    expect(
      (createArg.data.requestPayload as { queueType?: string }).queueType
    ).toBeUndefined();
  });
});
