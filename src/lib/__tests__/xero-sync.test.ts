import { beforeEach, describe, expect, it, vi } from "vitest";
import { CreditNoteSpentOutsideAppError } from "@/lib/xero-credit-note-spent-outside-app";
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
  txPaymentUpdateMany: vi.fn(),
  txLinkUpdateMany: vi.fn(),
  txLinkUpsert: vi.fn(),
  txLinkFindUnique: vi.fn(),
  txLinkFindMany: vi.fn(),
  txExecuteRaw: vi.fn(),
  operationUpdate: vi.fn(),
  operationUpdateMany: vi.fn(),
  operationFindUniqueOrThrow: vi.fn(),
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
      update: mocks.operationUpdate,
      updateMany: mocks.operationUpdateMany,
      findUniqueOrThrow: mocks.operationFindUniqueOrThrow,
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

// The repeated-failure notifier is imported lazily by the fail/complete writers;
// a cold dynamic import of its real module chain could exceed the 5s test
// timeout (#3752 composed review). Nothing here asserts on it.
vi.mock("@/lib/xero-hardening", () => ({
  maybeNotifyXeroRepeatedFailure: vi.fn(),
}));

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
  completeXeroSyncOperation,
  failXeroSyncOperation,
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

  it("MUTATION (#3880): a per-refund note is never the payment's canonical one - not by the payment field, its refund payment, its create or its link", async () => {
    mocks.paymentFindUnique.mockResolvedValue({ xeroRefundCreditNoteId: "cn_review" });
    mocks.linkFindMany.mockImplementation(async ({ where }: any) => {
      if (where?.role === "REFUND_CREDIT_NOTE") {
        return [
          { xeroObjectId: "cn_review", xeroObjectNumber: "CN-R", metadata: { perDelta: true } },
          { xeroObjectId: "cn_single", xeroObjectNumber: "CN-S", metadata: { amountCents: 500 } },
        ];
      }
      if (where?.role === "REFUND_PAYMENT") return [{ metadata: { creditNoteId: "cn_review" } }];
      return [];
    });
    mocks.operationFindFirst.mockResolvedValue(null);

    await expect(findCanonicalPaymentRefundCreditNote("payment_1")).resolves.toEqual({
      xeroObjectId: "cn_single",
      xeroObjectNumber: "CN-S",
      source: "link",
    });
    expect(mocks.operationFindFirst).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ xeroObjectId: { not: null, notIn: ["cn_review"] } }) }),
    );
  });

  describe("INV-ADDPAY-041 (#4091): a note Xero voided is never re-adopted", () => {
    // A bank-transfer payment whose one refund note Xero voided: its mirror is
    // inactive and recorded VOIDED, but its refund payment link and its
    // succeeded create still name it.
    function voidedNoteOnPayment(field: string | null, active: Array<{ xeroObjectId: string; xeroObjectNumber: string }> = []) {
      mocks.paymentFindUnique.mockResolvedValue({ xeroRefundCreditNoteId: field });
      mocks.linkFindMany.mockImplementation(async ({ where }: any) => {
        if (where?.role === "REFUND_CREDIT_NOTE") {
          return where.active
            ? active
            : [{ xeroObjectId: "cn_voided", metadata: { amountCents: 20_000, status: "VOIDED" } }, ...active.map((link) => ({ ...link, metadata: { amountCents: 500 } }))];
        }
        if (where?.role === "REFUND_PAYMENT") return [{ metadata: { creditNoteId: "cn_voided" } }];
        return [];
      });
      mocks.operationFindFirst.mockImplementation(async ({ where }: any) =>
        where.xeroObjectId.notIn?.includes("cn_voided") ? null : { xeroObjectId: "cn_voided", xeroObjectNumber: "CN-V" },
      );
    }

    it("MUTATION: with the field released, neither its refund payment nor its create re-adopts it - a later request raises a fresh note", async () => {
      voidedNoteOnPayment(null);

      await expect(findCanonicalPaymentRefundCreditNote("payment_1")).resolves.toBeNull();
      expect(mocks.operationFindFirst).toHaveBeenCalledWith(
        expect.objectContaining({ where: expect.objectContaining({ xeroObjectId: { not: null, notIn: ["cn_voided"] } }) }),
      );
    });

    it("MUTATION: a field still naming the voided note does not re-adopt it, and a live note is still found", async () => {
      voidedNoteOnPayment("cn_voided", [{ xeroObjectId: "cn_live", xeroObjectNumber: "CN-L" }]);

      await expect(findCanonicalPaymentRefundCreditNote("payment_1")).resolves.toEqual({
        xeroObjectId: "cn_live",
        xeroObjectNumber: "CN-L",
        source: "link",
      });
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
    mocks.txPaymentUpdateMany.mockResolvedValue({ count: 1 });
    mocks.txLinkUpsert.mockResolvedValue({ id: "link_1" });
    mocks.txLinkFindUnique.mockResolvedValue(null);
    mocks.txLinkFindMany.mockResolvedValue([]);
    mocks.txExecuteRaw.mockResolvedValue(0);
    mocks.transaction.mockImplementation(async (callback: (tx: unknown) => Promise<unknown>) =>
      callback({
        $executeRaw: mocks.txExecuteRaw,
        payment: {
          findUnique: mocks.txPaymentFindUnique,
          updateMany: mocks.txPaymentUpdateMany,
        },
        xeroObjectLink: {
          updateMany: mocks.txLinkUpdateMany,
          upsert: mocks.txLinkUpsert,
          findUnique: mocks.txLinkFindUnique,
          findMany: mocks.txLinkFindMany,
        },
      })
    );
  });

  describe("#3880: a non-Stripe payment's per-refund notes", () => {
    it("MUTATION: a review's per-refund note on a bank-transfer payment stays active and retires none of its siblings", async () => {
      mocks.txPaymentFindUnique.mockResolvedValue({ source: "INTERNET_BANKING", xeroRefundCreditNoteId: "cn_first" });

      await upsertXeroObjectLink({
        localModel: "Payment",
        localId: "payment_1",
        xeroObjectType: "CREDIT_NOTE",
        xeroObjectId: "cn_second",
        role: "REFUND_CREDIT_NOTE",
        metadata: { amountCents: 1000, watermarkCents: 2000, perDelta: true },
      });

      expect(mocks.txLinkUpdateMany).not.toHaveBeenCalled();
      expect(mocks.txLinkUpsert).toHaveBeenCalledWith(
        expect.objectContaining({ create: expect.objectContaining({ active: true }), update: expect.objectContaining({ active: true }) }),
      );
    });

    it("MUTATION: a covering write with no metadata keeps a stored per-refund note active", async () => {
      mocks.txPaymentFindUnique.mockResolvedValue({ source: "INTERNET_BANKING", xeroRefundCreditNoteId: null });
      mocks.txLinkFindMany.mockResolvedValue([{ xeroObjectId: "cn_first", metadata: { amountCents: 1000, perDelta: true } }]);

      await upsertXeroObjectLink({ localModel: "Payment", localId: "payment_1", xeroObjectType: "CREDIT_NOTE", xeroObjectId: "cn_first", role: "REFUND_CREDIT_NOTE" });

      expect(mocks.txLinkUpdateMany).not.toHaveBeenCalled();
      expect(mocks.txLinkUpsert).toHaveBeenCalledWith(expect.objectContaining({ update: expect.objectContaining({ active: true }) }));
    });

    it("MUTATION (F1): a field an older writer pointed at a per-refund note is no canonical note - the cancellation's note, re-read, stays active", async () => {
      // H ($50, the cancellation's hand-back) beside D ($30, a review's), with the
      // field on D: before the fix H's inbound re-read was written INACTIVE.
      mocks.txPaymentFindUnique.mockResolvedValue({ source: "INTERNET_BANKING", xeroRefundCreditNoteId: "cn_review" });
      mocks.txLinkFindMany.mockResolvedValue([
        { xeroObjectId: "cn_review", metadata: { amountCents: 3000, perDelta: true } },
        { xeroObjectId: "cn_handback", metadata: { amountCents: 5000 } },
      ]);

      await upsertXeroObjectLink({
        localModel: "Payment", localId: "payment_1", xeroObjectType: "CREDIT_NOTE", xeroObjectId: "cn_handback", role: "REFUND_CREDIT_NOTE",
        metadata: { status: "AUTHORISED", total: 50 }, mergeMetadata: true,
      });

      expect(mocks.txLinkUpsert).toHaveBeenCalledWith(
        expect.objectContaining({ create: expect.objectContaining({ active: true }), update: expect.objectContaining({ active: true }) }),
      );
      expect(mocks.txLinkUpdateMany).toHaveBeenCalledWith(
        expect.objectContaining({ where: expect.objectContaining({ xeroObjectId: { not: "cn_handback", notIn: ["cn_review"] } }) }),
      );
    });

    it("MUTATION (F1): with the field on a per-refund note, the cancellation's note's refund payment link stays active", async () => {
      mocks.txPaymentFindUnique.mockResolvedValue({ source: "INTERNET_BANKING", xeroRefundCreditNoteId: "cn_review" });
      mocks.txLinkFindMany.mockResolvedValue([{ xeroObjectId: "cn_review", metadata: { perDelta: true } }]);

      await upsertXeroObjectLink({
        localModel: "Payment", localId: "payment_1", xeroObjectType: "PAYMENT", xeroObjectId: "pay_handback", role: "REFUND_PAYMENT",
        metadata: { creditNoteId: "cn_handback" },
      });

      expect(mocks.txLinkUpsert).toHaveBeenCalledWith(expect.objectContaining({ update: expect.objectContaining({ active: true }) }));
    });

    it("MUTATION: the payment's one canonical note retires older single notes but never a per-refund one", async () => {
      mocks.txPaymentFindUnique.mockResolvedValue({ source: "INTERNET_BANKING", xeroRefundCreditNoteId: "cn_canonical" });
      mocks.txLinkFindMany.mockResolvedValue([
        { xeroObjectId: "cn_review", metadata: { perDelta: true } },
        { xeroObjectId: "cn_old", metadata: { amountCents: 500 } },
      ]);

      await upsertXeroObjectLink({ localModel: "Payment", localId: "payment_1", xeroObjectType: "CREDIT_NOTE", xeroObjectId: "cn_canonical", role: "REFUND_CREDIT_NOTE" });

      expect(mocks.txLinkUpdateMany).toHaveBeenCalledWith(
        expect.objectContaining({ where: expect.objectContaining({ xeroObjectId: { not: "cn_canonical", notIn: ["cn_review"] } }) }),
      );
    });
  });

  describe("#4091: a bank-transfer payment's one canonical note, voided in Xero", () => {
    const voidCanonical = () =>
      upsertXeroObjectLink({
        localModel: "Payment", localId: "payment_1", xeroObjectType: "CREDIT_NOTE", xeroObjectId: "cn_canonical", role: "REFUND_CREDIT_NOTE",
        metadata: { status: "VOIDED", total: 200 }, mergeMetadata: true,
      });

    it("MUTATION: the mirror is written inactive and the pointer is released", async () => {
      mocks.txPaymentFindUnique.mockResolvedValue({ source: "INTERNET_BANKING", xeroRefundCreditNoteId: "cn_canonical" });

      await voidCanonical();

      // Before the fix the canonical branch wrote it active: the field named it.
      expect(mocks.txLinkUpsert).toHaveBeenCalledWith(
        expect.objectContaining({ create: expect.objectContaining({ active: false }), update: expect.objectContaining({ active: false }) }),
      );
      expect(mocks.txPaymentUpdateMany).toHaveBeenCalledWith({
        where: { id: "payment_1", xeroRefundCreditNoteId: "cn_canonical" },
        data: { xeroRefundCreditNoteId: null },
      });
    });

    it("MUTATION: a voided note retires no sibling, so the pointer can move to another live note", async () => {
      mocks.txPaymentFindUnique.mockResolvedValue({ source: "INTERNET_BANKING", xeroRefundCreditNoteId: "cn_canonical" });
      mocks.txLinkFindMany.mockResolvedValue([
        { id: "link_review", xeroObjectId: "cn_review", metadata: { amountCents: 3000, perDelta: true }, createdAt: new Date("2026-06-03T00:00:00.000Z") },
        { id: "link_other", xeroObjectId: "cn_other", metadata: { amountCents: 5000 }, createdAt: new Date("2026-06-02T00:00:00.000Z") },
      ]);

      await voidCanonical();

      expect(mocks.txLinkUpdateMany).not.toHaveBeenCalled();
      expect(mocks.txPaymentUpdateMany).toHaveBeenCalledWith({
        where: { id: "payment_1", xeroRefundCreditNoteId: "cn_canonical" },
        data: { xeroRefundCreditNoteId: "cn_other" },
      });
    });

    it("MUTATION: a redelivered void, after the pointer was released, stays inactive and retires nothing", async () => {
      // With the field empty the canonical branch fell back to the incoming
      // note itself, so a redelivery re-armed the mirror and retired siblings.
      mocks.txPaymentFindUnique.mockResolvedValue({ source: "INTERNET_BANKING", xeroRefundCreditNoteId: null });

      await voidCanonical();

      expect(mocks.txLinkUpsert).toHaveBeenCalledWith(expect.objectContaining({ update: expect.objectContaining({ active: false }) }));
      expect(mocks.txLinkUpdateMany).not.toHaveBeenCalled();
      expect(mocks.txPaymentUpdateMany).not.toHaveBeenCalled();
    });
  });

  describe("#4195: a refund request's own note, voided in Xero (INV-ADDPAY-041)", () => {
    const writeRequestNote = (status: string | undefined) =>
      upsertXeroObjectLink({
        localModel: "Payment", localId: "payment_1", xeroObjectType: "CREDIT_NOTE", xeroObjectId: "cn_request", role: "REFUND_REQUEST_CREDIT_NOTE",
        metadata: { ...(status ? { status } : {}), total: 50 }, mergeMetadata: true,
      });

    it.each(["VOIDED", "DELETED", "voided"])("MUTATION: a %s mirror is written inactive, and moves no pointer and no sibling", async (status) => {
      mocks.txPaymentFindUnique.mockResolvedValue({ source: "INTERNET_BANKING", xeroRefundCreditNoteId: "cn_canonical" });

      await writeRequestNote(status);

      // Before #4195 the request role skipped every void rule and stayed active.
      expect(mocks.txLinkUpsert).toHaveBeenCalledWith(
        expect.objectContaining({ create: expect.objectContaining({ active: false }), update: expect.objectContaining({ active: false }) }),
      );
      expect(mocks.txLinkUpdateMany).not.toHaveBeenCalled();
      expect(mocks.txPaymentUpdateMany).not.toHaveBeenCalled();
    });

    it("a live request note keeps the activity its write gives it", async () => {
      await writeRequestNote("AUTHORISED");
      await writeRequestNote(undefined);

      for (const [call] of mocks.txLinkUpsert.mock.calls as Array<[{ create: { active: boolean }; update: { active: boolean } }]>) {
        expect(call.create.active).toBe(true);
        expect(call.update.active).toBe(true);
      }
      expect(mocks.txLinkUpsert).toHaveBeenCalledTimes(2);
      // Never the payment's one note: it retires no refund note and reads no payment.
      expect(mocks.txLinkUpdateMany).not.toHaveBeenCalled();
      expect(mocks.txPaymentFindUnique).not.toHaveBeenCalled();
      expect(mocks.txPaymentUpdateMany).not.toHaveBeenCalled();
    });

    it("MUTATION (race): a write naming no status keeps a void the stored row records - inactive, its status kept", async () => {
      // The inbound void committed while this retry's write waited on the row lock.
      mocks.txLinkFindUnique.mockResolvedValue({ metadata: { amountCents: 5000, refundRequestId: "rr_1", status: "VOIDED" } });

      await upsertXeroObjectLink({
        localModel: "Payment", localId: "payment_1", xeroObjectType: "CREDIT_NOTE", xeroObjectId: "cn_request", role: "REFUND_REQUEST_CREDIT_NOTE",
        metadata: { amountCents: 5000, refundRequestId: "rr_1" },
      });

      const [call] = mocks.txLinkUpsert.mock.calls[0] as [{ create: { active: boolean }; update: { active: boolean; metadata: Record<string, unknown> } }];
      expect(call.update.active).toBe(false);
      expect(call.create.active).toBe(false);
      // Replacing the metadata would drop the status the after-void key and the create check read.
      expect(call.update.metadata).toEqual({ amountCents: 5000, refundRequestId: "rr_1", status: "VOIDED" });
      // The stored row is read under its lock, in the write's own transaction.
      // F-D: one row, by all five fields of its unique key, so a broader lock fails here.
      const [template, ...values] = mocks.txExecuteRaw.mock.calls[0] as [TemplateStringsArray, ...unknown[]];
      expect(template.join("?").replace(/\s+/g, " ").trim()).toBe(
        'SELECT 1 FROM "XeroObjectLink" WHERE "localModel" = ? AND "localId" = ? AND "xeroObjectType" = ? AND "xeroObjectId" = ? AND "role" = ? FOR UPDATE',
      );
      expect(values).toEqual(["Payment", "payment_1", "CREDIT_NOTE", "cn_request", "REFUND_REQUEST_CREDIT_NOTE"]);
      expect(mocks.txExecuteRaw.mock.invocationCallOrder[0]).toBeLessThan(mocks.txLinkFindUnique.mock.invocationCallOrder[0]!);
    });

    it("a write naming a status is judged on it, without reading the stored row", async () => {
      await writeRequestNote("AUTHORISED");
      expect(mocks.txExecuteRaw).not.toHaveBeenCalled();
    });
  });

  it("merges inbound metadata over the outbound per-delta keys when mergeMetadata is set (#1354)", async () => {
    const txLinkFindUnique = vi.fn().mockResolvedValue({
      metadata: { amountCents: 3000, watermarkCents: 8000 },
    });
    mocks.transaction.mockImplementation(async (callback: (tx: unknown) => Promise<unknown>) =>
      callback({
        payment: {
          findUnique: mocks.txPaymentFindUnique,
          updateMany: mocks.txPaymentUpdateMany,
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
          notIn: [],
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
          updateMany: mocks.txPaymentUpdateMany,
        },
        xeroObjectLink: {
          updateMany: mocks.txLinkUpdateMany,
          upsert: mocks.txLinkUpsert,
          findUnique: txLinkFindUnique,
          findMany: mocks.txLinkFindMany,
        },
      })
    );
    mocks.txLinkFindMany.mockResolvedValue([]);
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
    // The scalar named this note. With no other live note, it is cleared so
    // the nightly report does not call the inactive mirror "missing".
    expect(mocks.txPaymentUpdateMany).toHaveBeenCalledWith({
      where: { id: "payment_1", xeroRefundCreditNoteId: "cn_delta" },
      data: { xeroRefundCreditNoteId: null },
    });
  });

  it("repoints the payment's refund-note pointer at the newest other live note when a void deactivates the one it named", async () => {
    mocks.txLinkFindMany.mockResolvedValue([
      {
        id: "link_old",
        xeroObjectId: "cn_older",
        metadata: { status: "AUTHORISED" },
        createdAt: new Date("2026-06-01T00:00:00.000Z"),
      },
      {
        id: "link_new",
        xeroObjectId: "cn_newer",
        metadata: { status: "PAID" },
        createdAt: new Date("2026-06-02T00:00:00.000Z"),
      },
      {
        id: "link_void_sibling",
        xeroObjectId: "cn_also_void",
        metadata: { status: "VOIDED" },
        createdAt: new Date("2026-06-03T00:00:00.000Z"),
      },
    ]);
    mocks.txPaymentFindUnique.mockResolvedValue({
      source: "STRIPE",
      xeroRefundCreditNoteId: "cn_delta",
    });

    await upsertXeroObjectLink({
      localModel: "Payment",
      localId: "payment_1",
      xeroObjectType: "CREDIT_NOTE",
      xeroObjectId: "cn_delta",
      role: "REFUND_CREDIT_NOTE",
      metadata: { status: "DELETED" },
    });

    expect(mocks.txPaymentUpdateMany).toHaveBeenCalledWith({
      where: { id: "payment_1", xeroRefundCreditNoteId: "cn_delta" },
      data: { xeroRefundCreditNoteId: "cn_newer" },
    });
  });

  it("never repoints the refund-note pointer at a per-refund note when a void deactivates the one it named (#3880)", async () => {
    mocks.txLinkFindMany.mockResolvedValue([
      {
        id: "link_canonical",
        xeroObjectId: "cn_canonical",
        metadata: { status: "AUTHORISED" },
        createdAt: new Date("2026-06-01T00:00:00.000Z"),
      },
      {
        id: "link_per_refund",
        xeroObjectId: "cn_per_refund",
        metadata: { status: "AUTHORISED", perDelta: true },
        createdAt: new Date("2026-06-02T00:00:00.000Z"),
      },
    ]);
    mocks.txPaymentFindUnique.mockResolvedValue({
      source: "STRIPE",
      xeroRefundCreditNoteId: "cn_delta",
    });

    await upsertXeroObjectLink({
      localModel: "Payment",
      localId: "payment_1",
      xeroObjectType: "CREDIT_NOTE",
      xeroObjectId: "cn_delta",
      role: "REFUND_CREDIT_NOTE",
      metadata: { status: "VOIDED" },
    });

    expect(mocks.txPaymentUpdateMany).toHaveBeenCalledWith({
      where: { id: "payment_1", xeroRefundCreditNoteId: "cn_delta" },
      data: { xeroRefundCreditNoteId: "cn_canonical" },
    });
  });

  it("leaves the refund-note pointer alone when a voided note is not the one it names", async () => {
    mocks.txPaymentFindUnique.mockResolvedValue({
      source: "STRIPE",
      xeroRefundCreditNoteId: "cn_other",
    });

    await upsertXeroObjectLink({
      localModel: "Payment",
      localId: "payment_1",
      xeroObjectType: "CREDIT_NOTE",
      xeroObjectId: "cn_delta",
      role: "REFUND_CREDIT_NOTE",
      metadata: { status: "VOIDED" },
    });

    expect(mocks.txLinkUpsert).toHaveBeenCalledWith(
      expect.objectContaining({
        update: expect.objectContaining({ active: false }),
      }),
    );
    expect(mocks.txPaymentUpdateMany).not.toHaveBeenCalled();
  });

  it("does not move the refund-note pointer again once it no longer names the voided note", async () => {
    mocks.txPaymentFindUnique.mockResolvedValue({
      source: "STRIPE",
      xeroRefundCreditNoteId: null,
    });

    await upsertXeroObjectLink({
      localModel: "Payment",
      localId: "payment_1",
      xeroObjectType: "CREDIT_NOTE",
      xeroObjectId: "cn_delta",
      role: "REFUND_CREDIT_NOTE",
      metadata: { status: "VOIDED" },
    });

    expect(mocks.txPaymentUpdateMany).not.toHaveBeenCalled();
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

  // #3535: a handler that opens its own row with an execution-shape payload
  // names the queue type explicitly; the payload's own value still wins.
  it("takes an explicit queueType only when the payload names none (#3535)", async () => {
    await startXeroSyncOperation({
      direction: "OUTBOUND",
      entityType: "CREDIT_NOTE",
      operationType: "CREATE",
      localModel: "Booking",
      localId: "booking_retry",
      requestPayload: { invoiceId: "inv_1", refundAmountCents: 15000 },
      queueType: "MODIFICATION_CREDIT_NOTE",
    });
    await startXeroSyncOperation({
      direction: "OUTBOUND",
      entityType: "CREDIT_NOTE",
      operationType: "CREATE",
      localModel: "Booking",
      localId: "booking_retry",
      requestPayload: { queueType: "REFUND_CREDIT_NOTE" },
      queueType: "MODIFICATION_CREDIT_NOTE",
    });

    expect(mocks.operationCreate.mock.calls[0][0].data.queueType).toBe("MODIFICATION_CREDIT_NOTE");
    expect(mocks.operationCreate.mock.calls[1][0].data.queueType).toBe("REFUND_CREDIT_NOTE");
    expect(mocks.operationCreate.mock.calls[0][0].data).not.toHaveProperty("requestPayload.queueType");
  });
});

// #3635 round-3 N5: the outbox's catch runs after its handler, and an approval
// can withdraw a kept row in between; that withdrawal stands.
describe("failXeroSyncOperation keepCancelled", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.operationCount.mockResolvedValue(0);
  });

  it("leaves a CANCELLED row as it is and answers null", async () => {
    mocks.operationUpdateMany.mockResolvedValue({ count: 0 });
    await expect(
      failXeroSyncOperation("op_kept", new Error("boom"), undefined, { keepCancelled: true })
    ).resolves.toBeNull();
    expect(mocks.operationUpdateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "op_kept", status: { not: "CANCELLED" } },
        data: expect.objectContaining({ status: "FAILED" }),
      })
    );
    expect(mocks.operationUpdate).not.toHaveBeenCalled();
  });

  it("fails any other row as before", async () => {
    mocks.operationUpdateMany.mockResolvedValue({ count: 1 });
    mocks.operationFindUniqueOrThrow.mockResolvedValue({ id: "op_kept", status: "FAILED" });
    await expect(
      failXeroSyncOperation("op_kept", new Error("boom"), undefined, { keepCancelled: true })
    ).resolves.toMatchObject({ status: "FAILED" });
  });
});

// #3462: a retry that claimed the original RUNNING abandons the claim when its
// handler throws early - but only its own claim, never a row the handler
// already completed or a later claim re-stamped.
describe("failXeroSyncOperation terminal errors (#4218)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.operationCount.mockResolvedValue(0);
    mocks.operationUpdate.mockResolvedValue({ id: "op_1", status: "FAILED" });
  });

  it("records a named code and a non-replayable row for a credit note spent outside the app", async () => {
    await failXeroSyncOperation(
      "op_1",
      new CreditNoteSpentOutsideAppError("only $0.00 left in Xero", "cn_1", 0, 5250)
    );
    expect(mocks.operationUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "op_1" },
        data: expect.objectContaining({
          status: "FAILED",
          lastErrorCode: "CREDIT_NOTE_SPENT_OUTSIDE_APP",
          replayable: false,
        }),
      })
    );
  });

  it("leaves every other failure replayable", async () => {
    await failXeroSyncOperation("op_1", new Error("bad request"));
    const { data } = mocks.operationUpdate.mock.calls[0][0];
    expect(data.lastErrorCode).not.toBe("CREDIT_NOTE_SPENT_OUTSIDE_APP");
    expect(data).not.toHaveProperty("replayable");
  });
});

describe("failXeroSyncOperation onlyIfRunningSince", () => {
  const claimedAt = new Date("2026-07-01T00:00:00.000Z");

  beforeEach(() => {
    vi.clearAllMocks();
    mocks.operationCount.mockResolvedValue(0);
  });

  it("fails the row only while it is still this claim, and answers the failed row", async () => {
    mocks.operationUpdateMany.mockResolvedValue({ count: 1 });
    mocks.operationFindUniqueOrThrow.mockResolvedValue({ id: "op_1", status: "FAILED" });
    await expect(
      failXeroSyncOperation("op_1", new Error("contact refused"), undefined, {
        onlyIfRunningSince: claimedAt,
      })
    ).resolves.toMatchObject({ status: "FAILED" });
    expect(mocks.operationUpdateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "op_1", status: "RUNNING", startedAt: claimedAt },
        data: expect.objectContaining({
          status: "FAILED",
          lastErrorMessage: "contact refused",
        }),
      })
    );
    expect(mocks.operationUpdate).not.toHaveBeenCalled();
  });

  it("cannot be handed both write guards at once", () => {
    // Compile-time: the two guards are one discriminated option (#3462), so
    // one can never be silently dropped in favour of the other. The call is
    // never made; `pnpm run typecheck` is the assertion.
    const typeOnly = () =>
      failXeroSyncOperation("op_1", new Error("boom"), undefined, {
        keepCancelled: true,
        // @ts-expect-error keepCancelled and onlyIfRunningSince are exclusive
        onlyIfRunningSince: claimedAt,
      });
    expect(typeof typeOnly).toBe("function");
  });

  it("leaves a row the handler already completed as it is and answers null", async () => {
    mocks.operationUpdateMany.mockResolvedValue({ count: 0 });
    await expect(
      failXeroSyncOperation("op_1", new Error("late throw"), undefined, {
        onlyIfRunningSince: claimedAt,
      })
    ).resolves.toBeNull();
    expect(mocks.operationUpdate).not.toHaveBeenCalled();
    expect(mocks.operationFindUniqueOrThrow).not.toHaveBeenCalled();
  });

  it("records the operator message in place of the error's own, still redacted", async () => {
    // The operator message embeds the provider's raw error text, so the
    // override must pass through the same redaction as the error's own.
    mocks.operationUpdate.mockResolvedValue({ id: "op_2", status: "FAILED" });
    await failXeroSyncOperation("op_2", new Error("raw"), undefined, {
      lastErrorMessage:
        "Retry of Xero operation op_1 failed: Authorization: Bearer live-token.",
    });
    const recorded = mocks.operationUpdate.mock.calls[0][0].data.lastErrorMessage;
    expect(recorded).toContain("Retry of Xero operation op_1 failed");
    expect(recorded).toContain("Bearer [REDACTED]");
    expect(recorded).not.toContain("live-token");
  });
});

// #3548 round 3 (R2-6): the loser of two concurrent refund-note legs never
// writes PARTIAL over the winner's SUCCEEDED.
describe("completeXeroSyncOperation keepSucceeded", () => {
  function store(count: number) {
    return {
      xeroSyncOperation: {
        updateMany: vi.fn().mockResolvedValue({ count }),
        update: vi.fn(),
        findUniqueOrThrow: vi.fn().mockResolvedValue({ id: "op_note", status: "PARTIAL" }),
      },
    };
  }

  it("leaves a SUCCEEDED row as it is, writes no link, and answers null", async () => {
    const tx = store(0);
    await expect(
      completeXeroSyncOperation(
        "op_note",
        { status: "PARTIAL", extraLinks: [{ localModel: "Payment", localId: "p", xeroObjectType: "CREDIT_NOTE", xeroObjectId: "cn", role: "REFUND_CREDIT_NOTE" }] },
        { store: tx as never, keepSucceeded: true },
      ),
    ).resolves.toBeNull();
    expect(tx.xeroSyncOperation.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "op_note", status: { not: "SUCCEEDED" } },
        data: expect.objectContaining({ status: "PARTIAL" }),
      }),
    );
    expect(tx.xeroSyncOperation.update).not.toHaveBeenCalled();
    expect(mocks.txLinkUpsert).not.toHaveBeenCalled();
  });

  it("completes any other row as before", async () => {
    const tx = store(1);
    await expect(
      completeXeroSyncOperation("op_note", { status: "PARTIAL" }, { store: tx as never, keepSucceeded: true }),
    ).resolves.toMatchObject({ status: "PARTIAL" });
    expect(tx.xeroSyncOperation.update).not.toHaveBeenCalled();
  });
});
