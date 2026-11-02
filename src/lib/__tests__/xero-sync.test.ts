import { beforeEach, describe, expect, it, vi } from "vitest";
import { CreditNoteSpentOutsideAppError } from "@/lib/xero-credit-note-spent-outside-app";
import type { Prisma } from "@prisma/client";
import {
  applyLinkMetadataMerge,
  isLinkMetadataMergeStatement,
  LINK_METADATA_MERGE_SQL_HEAD,
  rawSqlText,
  readLinkMetadataMerge,
} from "./support/xero-link-metadata-merge-double";

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
  txLinkCreateMany: vi.fn(),
  txLinkUpdateMany: vi.fn(),
  txLinkUpsert: vi.fn(),
  txLinkFindUnique: vi.fn(),
  txLinkFindUniqueOrThrow: vi.fn(),
  txLinkFindMany: vi.fn(),
  txExecuteRaw: vi.fn(),
  operationUpdate: vi.fn(),
  operationUpdateMany: vi.fn(),
  operationUpdateManyAndReturn: vi.fn(),
  operationFindUnique: vi.fn(),
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
      updateManyAndReturn: mocks.operationUpdateManyAndReturn,
      findUnique: mocks.operationFindUnique,
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
import { prisma } from "@/lib/prisma";
import { CREDIT_SPENT_OUTSIDE_APP_REASON_PREFIX } from "@/lib/xero-operation-resolution";
import { TEST_XERO_CLAIMED_AT, xeroClaim } from "@/lib/__tests__/helpers/xero-claim";

/** #4356: every guarded outcome but a claim's also stays off a repair's RUNNING claim (`INV-INT-029`). */
const NOT_A_REPAIR_CLAIM = {
  OR: [
    { status: { not: "RUNNING" } },
    { lastErrorCode: null },
    { lastErrorCode: { notIn: ["PARTIAL_REPAIR_RUNNING", "REFUND_NOTE_REPAIR_RUNNING"] } },
  ],
};
/** #4373: not RUNNING under a claim other than `xeroClaim`'s default. */
const NOT_ANOTHER_CLAIM = { OR: [{ status: { not: "RUNNING" } }, { startedAt: TEST_XERO_CLAIMED_AT }] };
/** #4356/#4373: the guard on an outcome other than SUCCEEDED, keeping `status`. */
const outcomeGuard = (status: object) => ({ AND: [{ status }, NOT_A_REPAIR_CLAIM, NOT_ANOTHER_CLAIM] });
/** #4673: a failure's guard - `xeroClaim`'s own row, in one of `statuses`, off a repair's claim. */
const failureGuard = (statuses: string[]) => ({
  AND: [{ status: { in: statuses }, startedAt: TEST_XERO_CLAIMED_AT }, NOT_A_REPAIR_CLAIM],
});

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

/**
 * #4445: a `mergeMetadata` write is one statement over the stored row, so these
 * mocks see its bound values, not a merged object. `metadataWrittenOver(stored)`
 * is what the first link write leaves on a row holding `stored`: a replace's
 * own value, or the statement applied by its one test double.
 */
const MERGE_SQL_HEAD = LINK_METADATA_MERGE_SQL_HEAD;
const rawSql = (call: unknown[]) => rawSqlText(call[0] as TemplateStringsArray);
const mergeCalls = () => mocks.txExecuteRaw.mock.calls.filter((call) => isLinkMetadataMergeStatement(call[0] as TemplateStringsArray));
const lockCalls = () => mocks.txExecuteRaw.mock.calls.filter((call) => !isLinkMetadataMergeStatement(call[0] as TemplateStringsArray));
function metadataWrittenOver(stored: unknown): unknown {
  const [{ update }] = mocks.txLinkUpsert.mock.calls[0] as [{ update: Record<string, unknown> }];
  if ("metadata" in update) return update.metadata;
  const merge = mergeCalls()[0];
  return merge ? applyLinkMetadataMerge(stored, readLinkMetadataMerge(merge.slice(1))) : stored;
}

describe("upsertXeroObjectLink", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.txLinkCreateMany.mockResolvedValue({ count: 0 });
    mocks.txLinkUpdateMany.mockResolvedValue({ count: 1 });
    mocks.txPaymentUpdateMany.mockResolvedValue({ count: 1 });
    mocks.txLinkUpsert.mockResolvedValue({ id: "link_1" });
    mocks.txLinkFindUniqueOrThrow.mockResolvedValue({ id: "link_1" });
    mocks.txLinkFindUnique.mockResolvedValue(null);
    mocks.txLinkFindMany.mockResolvedValue([]);
    mocks.txExecuteRaw.mockResolvedValue(1);
    mocks.transaction.mockImplementation(async (callback: (tx: unknown) => Promise<unknown>) =>
      callback({
        $executeRaw: mocks.txExecuteRaw,
        payment: {
          findUnique: mocks.txPaymentFindUnique,
          updateMany: mocks.txPaymentUpdateMany,
        },
        xeroObjectLink: {
          createMany: mocks.txLinkCreateMany,
          updateMany: mocks.txLinkUpdateMany,
          upsert: mocks.txLinkUpsert,
          findUnique: mocks.txLinkFindUnique,
          findUniqueOrThrow: mocks.txLinkFindUniqueOrThrow,
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
      expect(metadataWrittenOver({ amountCents: 5000, refundRequestId: "rr_1", status: "VOIDED" })).toEqual({ amountCents: 5000, refundRequestId: "rr_1", status: "VOIDED" });
      // The stored row is read under its lock, in the write's own transaction.
      // F-D: one row, by all five fields of its unique key, so a broader lock fails here.
      const [template, ...values] = mocks.txExecuteRaw.mock.calls[0] as [TemplateStringsArray, ...unknown[]];
      expect(template.join("?").replace(/\s+/g, " ").trim()).toBe(
        'SELECT 1 FROM "XeroObjectLink" WHERE "localModel" = ? AND "localId" = ? AND "xeroObjectType" = ? AND "xeroObjectId" = ? AND "role" = ? FOR UPDATE',
      );
      expect(values).toEqual(["Payment", "payment_1", "CREDIT_NOTE", "cn_request", "REFUND_REQUEST_CREDIT_NOTE"]);
      expect(mocks.txExecuteRaw.mock.invocationCallOrder[0]).toBeLessThan(mocks.txLinkFindUnique.mock.invocationCallOrder[0]!);
    });

    it("#4288: a write naming a status re-reads the stored row under its own row lock too", async () => {
      await writeRequestNote("AUTHORISED");
      // #4223: it takes its own row first, as every refund-note link write does.
      expect(lockCalls()).toHaveLength(1);
      // #4288: the stored row is judged, only after the lock. #4445: the merge
      // reads the row in its own statement, so it is read through Prisma once.
      expect(mocks.txLinkFindUnique).toHaveBeenCalledTimes(1);
      expect(mergeCalls()).toHaveLength(1);
      expect(mocks.txExecuteRaw.mock.invocationCallOrder[0]).toBeLessThan(mocks.txLinkFindUnique.mock.invocationCallOrder[0]!);
    });
  });

  describe("#4288: an older live reading never revives a stored void (INV-ADDPAY-041)", () => {
    const STORED_VOID = {
      amountCents: 20000, watermarkCents: 20000, status: "VOIDED", total: 200, appliedAmount: 0, remainingCredit: 0,
      providerUpdatedAt: "2026-06-30T12:00:00.000Z",
    };
    /** What the inbound reconcile, the status recorder or a hand-made answer read from Xero before the void. */
    const OLDER_LIVE = { status: "AUTHORISED", total: 200, appliedAmount: 0, remainingCredit: 200, providerUpdatedAt: "2026-06-30T11:00:00.000Z" };
    const SKIP_LOCKED_SQL = 'SELECT 1 FROM "Payment" WHERE "id" = ? FOR NO KEY UPDATE SKIP LOCKED';
    const sqlOf = (call: unknown[]) => (call[0] as TemplateStringsArray).join("?").replace(/\s+/g, " ").trim();
    const write = (role: string, extra: Record<string, unknown> = {}) =>
      upsertXeroObjectLink({
        localModel: "Payment", localId: "payment_1", xeroObjectType: "CREDIT_NOTE", xeroObjectId: "cn_voided", role,
        metadata: OLDER_LIVE, mergeMetadata: true, ...extra,
      });

    it("MUTATION (bank-transfer canonical): kept inactive with the whole stored snapshot, no sibling retired, the pointer released without waiting", async () => {
      mocks.txLinkFindUnique.mockResolvedValue({ metadata: STORED_VOID, active: false });
      mocks.txPaymentFindUnique.mockResolvedValue({ source: "INTERNET_BANKING", xeroRefundCreditNoteId: "cn_voided" });

      await write("REFUND_CREDIT_NOTE");

      const [call] = mocks.txLinkUpsert.mock.calls[0] as [{ create: { active: boolean }; update: { active: boolean; metadata: Record<string, unknown> } }];
      // Before #4288 the live status was written over the void, active, and its siblings retired.
      expect(call.update.active).toBe(false);
      expect(call.create.active).toBe(false);
      expect(metadataWrittenOver(STORED_VOID)).toEqual(STORED_VOID);
      expect(mocks.txLinkUpdateMany).not.toHaveBeenCalled();
      // MUTATION (pointer): the kept void never waits on a Payment a Payment-first writer may hold.
      expect(sqlOf(lockCalls()[1]!)).toBe(SKIP_LOCKED_SQL);
      expect(mocks.txPaymentUpdateMany).toHaveBeenCalledWith({
        where: { id: "payment_1", xeroRefundCreditNoteId: "cn_voided" },
        data: { xeroRefundCreditNoteId: null },
      });
    });

    it("MUTATION (pointer): a kept void leaves the pointer to the heal when its Payment is busy", async () => {
      mocks.txLinkFindUnique.mockResolvedValue({ metadata: STORED_VOID, active: false });
      mocks.txPaymentFindUnique.mockResolvedValue({ source: "INTERNET_BANKING", xeroRefundCreditNoteId: "cn_voided" });
      mocks.txExecuteRaw.mockImplementation(async (template: TemplateStringsArray) => (template.join("?").includes("SKIP LOCKED") ? 0 : 1));

      await write("REFUND_CREDIT_NOTE");

      expect(mocks.txLinkUpsert).toHaveBeenCalledWith(expect.objectContaining({ update: expect.objectContaining({ active: false }) }));
      expect(metadataWrittenOver(STORED_VOID)).toEqual(STORED_VOID);
      expect(mocks.txPaymentUpdateMany).not.toHaveBeenCalled();
    });

    it("a caller that itself names VOIDED keeps its waiting order (#4200): no SKIP LOCKED", async () => {
      mocks.txLinkFindUnique.mockResolvedValue({ metadata: { status: "AUTHORISED" }, active: true });
      mocks.txPaymentFindUnique.mockResolvedValue({ source: "INTERNET_BANKING", xeroRefundCreditNoteId: "cn_voided" });

      await write("REFUND_CREDIT_NOTE", { metadata: { ...STORED_VOID } });

      expect(lockCalls()).toHaveLength(1);
      expect(mocks.txPaymentUpdateMany).toHaveBeenCalledWith({ where: { id: "payment_1", xeroRefundCreditNoteId: "cn_voided" }, data: { xeroRefundCreditNoteId: null } });
    });

    it.each([
      ["a Stripe per-delta note", "REFUND_CREDIT_NOTE", { source: "STRIPE", xeroRefundCreditNoteId: null }],
      ["a bank-transfer per-refund note", "REFUND_CREDIT_NOTE", { source: "INTERNET_BANKING", xeroRefundCreditNoteId: null }],
      ["a refund request's own note", "REFUND_REQUEST_CREDIT_NOTE", { source: "INTERNET_BANKING", xeroRefundCreditNoteId: null }],
    ])("MUTATION: %s stays inactive with its stored snapshot", async (_label, role, payment) => {
      mocks.txLinkFindUnique.mockResolvedValue({ metadata: { ...STORED_VOID, perDelta: true }, active: false });
      mocks.txPaymentFindUnique.mockResolvedValue(payment);

      await write(role);

      expect(mocks.txLinkUpsert).toHaveBeenCalledWith(
        expect.objectContaining({ update: expect.objectContaining({ active: false }) }),
      );
      expect(metadataWrittenOver({ ...STORED_VOID, perDelta: true })).toEqual({ ...STORED_VOID, perDelta: true });
      expect(mocks.txLinkUpdateMany).not.toHaveBeenCalled();
    });

    it("MUTATION: the status recorder's write, which passes the activity it read before its fetch, stays inactive", async () => {
      mocks.txLinkFindUnique.mockResolvedValue({ metadata: STORED_VOID, active: false });
      mocks.txPaymentFindUnique.mockResolvedValue({ source: "STRIPE", xeroRefundCreditNoteId: null });

      await write("REFUND_CREDIT_NOTE", { active: true });

      expect(mocks.txLinkUpsert).toHaveBeenCalledWith(expect.objectContaining({ update: expect.objectContaining({ active: false }) }));
      expect(metadataWrittenOver(STORED_VOID)).toEqual(STORED_VOID);
    });

    it("MUTATION (fallback): with no timestamp on either side a stored void still wins", async () => {
      const legacyVoid: Record<string, unknown> = { ...STORED_VOID };
      delete legacyVoid.providerUpdatedAt;
      const unstampedLive: Record<string, unknown> = { ...OLDER_LIVE };
      delete unstampedLive.providerUpdatedAt;
      mocks.txLinkFindUnique.mockResolvedValue({ metadata: legacyVoid, active: false });
      mocks.txPaymentFindUnique.mockResolvedValue({ source: "INTERNET_BANKING", xeroRefundCreditNoteId: null });

      await write("REFUND_CREDIT_NOTE", { metadata: unstampedLive });

      expect(mocks.txLinkUpsert).toHaveBeenCalledWith(expect.objectContaining({ update: expect.objectContaining({ active: false }) }));
      expect(metadataWrittenOver(legacyVoid)).toEqual(legacyVoid);
      expect(mocks.txLinkUpdateMany).not.toHaveBeenCalled();
    });

    it("MUTATION (order): an older live reading keeps a newer stored live snapshot - its status, figures and activity", async () => {
      const storedPaid = { amountCents: 20000, status: "PAID", total: 200, appliedAmount: 200, remainingCredit: 0, providerUpdatedAt: "2026-06-30T12:00:00.000Z" };
      mocks.txLinkFindUnique.mockResolvedValue({ metadata: storedPaid, active: true });
      mocks.txPaymentFindUnique.mockResolvedValue({ source: "STRIPE", xeroRefundCreditNoteId: null });

      await write("REFUND_CREDIT_NOTE");

      expect(mocks.txLinkUpsert).toHaveBeenCalledWith(expect.objectContaining({ update: expect.objectContaining({ active: true }) }));
      expect(metadataWrittenOver(storedPaid)).toEqual(storedPaid);
    });

    it("a newer live reading over a stored live snapshot is applied: AUTHORISED to PAID is ordinary", async () => {
      const storedAuthorised = { amountCents: 20000, ...OLDER_LIVE };
      const newerPaid = { status: "PAID", total: 200, appliedAmount: 200, remainingCredit: 0, providerUpdatedAt: "2026-06-30T13:00:00.000Z" };
      mocks.txLinkFindUnique.mockResolvedValue({ metadata: storedAuthorised, active: true });
      mocks.txPaymentFindUnique.mockResolvedValue({ source: "STRIPE", xeroRefundCreditNoteId: null });

      await write("REFUND_CREDIT_NOTE", { metadata: newerPaid });

      expect(mocks.txLinkUpsert).toHaveBeenCalledWith(
        expect.objectContaining({ update: expect.objectContaining({ active: true }) }),
      );
      expect(metadataWrittenOver(storedAuthorised)).toEqual({ ...storedAuthorised, ...newerPaid });
    });
  });

  describe("#4223: the payment's own refund notes, voided in Xero while a retry records one (INV-ADDPAY-041)", () => {
    const LOCK_SQL =
      'SELECT 1 FROM "XeroObjectLink" WHERE "localModel" = ? AND "localId" = ? AND "xeroObjectType" = ? AND "xeroObjectId" = ? AND "role" = ? FOR UPDATE';
    const STORED_VOID = { amountCents: 20000, watermarkCents: 20000, status: "VOIDED", total: 200, appliedAmount: 50, remainingCredit: 150, provenance: { source: "inbound" } };

    it("MUTATION (race): a canonical write naming no status keeps a stored void - inactive, status merged, no sibling retired, pointer released", async () => {
      // The inbound void committed while this retry's write waited on the row
      // lock; the retry read the note as live and still names the pointer at it.
      mocks.txLinkFindUnique.mockResolvedValue({ metadata: STORED_VOID });
      mocks.txPaymentFindUnique.mockResolvedValue({ source: "INTERNET_BANKING", xeroRefundCreditNoteId: "cn_canonical" });

      await upsertXeroObjectLink({ localModel: "Payment", localId: "payment_1", xeroObjectType: "CREDIT_NOTE", xeroObjectId: "cn_canonical", xeroObjectNumber: "CN-1", role: "REFUND_CREDIT_NOTE" });

      const [call] = mocks.txLinkUpsert.mock.calls[0] as [{ create: { active: boolean }; update: { active: boolean; metadata: Record<string, unknown> } }];
      // Before #4223 the canonical branch wrote it back active: the field (or its fallback) named it.
      expect(call.update.active).toBe(false);
      expect(call.create.active).toBe(false);
      // Merged over the stored row, so no stored key moves and the status rides the write.
      expect(metadataWrittenOver(STORED_VOID)).toEqual(STORED_VOID);
      // A voided note claims nothing: no sibling is retired for it...
      expect(mocks.txLinkUpdateMany).not.toHaveBeenCalled();
      // ...and a pointer naming it is released, as the inbound void's own write does.
      expect(mocks.txPaymentUpdateMany).toHaveBeenCalledWith({
        where: { id: "payment_1", xeroRefundCreditNoteId: "cn_canonical" },
        data: { xeroRefundCreditNoteId: null },
      });
      const [template, ...values] = mocks.txExecuteRaw.mock.calls[0] as [TemplateStringsArray, ...unknown[]];
      expect(template.join("?").replace(/\s+/g, " ").trim()).toBe(LOCK_SQL);
      expect(values).toEqual(["Payment", "payment_1", "CREDIT_NOTE", "cn_canonical", "REFUND_CREDIT_NOTE"]);
    });

    it("MUTATION (race): a card payment's note written with no status keeps a stored void too", async () => {
      mocks.txLinkFindUnique.mockResolvedValue({ metadata: STORED_VOID });
      mocks.txPaymentFindUnique.mockResolvedValue({ source: "STRIPE", xeroRefundCreditNoteId: null });

      await upsertXeroObjectLink({
        localModel: "Payment", localId: "payment_1", xeroObjectType: "CREDIT_NOTE", xeroObjectId: "cn_delta", role: "REFUND_CREDIT_NOTE",
        metadata: { amountCents: 20000, watermarkCents: 20000 },
      });

      // Before #4223 the per-delta rule kept `active ?? true`.
      expect(mocks.txLinkUpsert).toHaveBeenCalledWith(
        expect.objectContaining({ update: expect.objectContaining({ active: false }) }),
      );
      expect(metadataWrittenOver(STORED_VOID)).toEqual(STORED_VOID);
    });

    it.each(["REFUND_CREDIT_NOTE", "REFUND_REQUEST_CREDIT_NOTE"])("MUTATION: a statusless %s write merges its keys over every stored void detail", async (role) => {
      mocks.txLinkFindUnique.mockResolvedValue({ metadata: STORED_VOID });
      mocks.txPaymentFindUnique.mockResolvedValue({ source: "INTERNET_BANKING", xeroRefundCreditNoteId: null });

      await upsertXeroObjectLink({
        localModel: "Payment", localId: "payment_1", xeroObjectType: "CREDIT_NOTE", xeroObjectId: "cn_voided", role,
        metadata: { amountCents: 20000, refundRequestId: "rr_1" },
      });

      expect(mocks.txLinkUpsert).toHaveBeenCalledWith(expect.objectContaining({
        update: expect.objectContaining({ active: false }),
      }));
      expect(metadataWrittenOver(STORED_VOID)).toEqual({ ...STORED_VOID, refundRequestId: "rr_1" });
      expect(mocks.txLinkUpdateMany).not.toHaveBeenCalled();
    });

    it("MUTATION: a kept void commits inactive with all metadata when Payment is busy, leaving pointer cleanup to the heal", async () => {
      mocks.txLinkFindUnique.mockResolvedValue({ metadata: STORED_VOID });
      mocks.txPaymentFindUnique.mockResolvedValue({ source: "INTERNET_BANKING", xeroRefundCreditNoteId: "cn_canonical" });
      mocks.txExecuteRaw.mockImplementation(async (template: TemplateStringsArray) => (template.join("?").includes("SKIP LOCKED") ? 0 : 1));

      await upsertXeroObjectLink({ localModel: "Payment", localId: "payment_1", xeroObjectType: "CREDIT_NOTE", xeroObjectId: "cn_canonical", role: "REFUND_CREDIT_NOTE" });

      expect(mocks.txLinkUpsert).toHaveBeenCalledWith(expect.objectContaining({ update: expect.objectContaining({ active: false }) }));
      expect(metadataWrittenOver(STORED_VOID)).toEqual(STORED_VOID);
      expect(mocks.txPaymentUpdateMany).not.toHaveBeenCalled();
      expect(mocks.txLinkUpdateMany).not.toHaveBeenCalled();
      const skipLocked = mocks.txExecuteRaw.mock.calls.findIndex((call) => rawSql(call).includes("SKIP LOCKED"));
      const [template, ...values] = mocks.txExecuteRaw.mock.calls[skipLocked] as [TemplateStringsArray, ...unknown[]];
      expect(template.join("?").replace(/\s+/g, " ").trim()).toBe('SELECT 1 FROM "Payment" WHERE "id" = ? FOR NO KEY UPDATE SKIP LOCKED');
      expect(values).toEqual(["payment_1"]);
      expect(mocks.txLinkUpsert.mock.invocationCallOrder[0]!).toBeLessThan(mocks.txExecuteRaw.mock.invocationCallOrder[skipLocked]!);
    });

    it("a canonical write naming no status, over a stored live row, is written as before", async () => {
      mocks.txLinkFindUnique.mockResolvedValue({ metadata: { amountCents: 20000, status: "AUTHORISED" } });
      mocks.txPaymentFindUnique.mockResolvedValue({ source: "INTERNET_BANKING", xeroRefundCreditNoteId: "cn_canonical" });

      await upsertXeroObjectLink({ localModel: "Payment", localId: "payment_1", xeroObjectType: "CREDIT_NOTE", xeroObjectId: "cn_canonical", role: "REFUND_CREDIT_NOTE" });

      expect(mocks.txLinkUpsert).toHaveBeenCalledWith(expect.objectContaining({ update: expect.objectContaining({ active: true }) }));
      expect(mocks.txLinkUpsert.mock.calls[0]![0].update.metadata).toBeUndefined();
      expect(mocks.txPaymentUpdateMany).not.toHaveBeenCalled();
    });

    it.each([
      ["names no status", undefined],
      ["names a live status", { status: "AUTHORISED", total: 200 }],
    ])("MUTATION (lock order): a canonical write that %s takes its own row before any sibling's or the payment's", async (_label, metadata) => {
      mocks.txPaymentFindUnique.mockResolvedValue({ source: "INTERNET_BANKING", xeroRefundCreditNoteId: "cn_canonical" });

      await upsertXeroObjectLink({
        localModel: "Payment", localId: "payment_1", xeroObjectType: "CREDIT_NOTE", xeroObjectId: "cn_canonical", role: "REFUND_CREDIT_NOTE",
        ...(metadata ? { metadata, mergeMetadata: true } : {}),
      });

      // One order for every writer of the row: a mixed order (a retry's own row
      // first, an inbound live write's siblings first) could deadlock two
      // writers of one note that both retire an active sibling.
      expect(mocks.txLinkCreateMany).toHaveBeenCalledWith({
        data: [{ localModel: "Payment", localId: "payment_1", xeroObjectType: "CREDIT_NOTE", xeroObjectId: "cn_canonical", role: "REFUND_CREDIT_NOTE", active: false }],
        skipDuplicates: true,
      });
      const lockAt = mocks.txExecuteRaw.mock.invocationCallOrder[0]!;
      expect(mocks.txLinkCreateMany.mock.invocationCallOrder[0]!).toBeLessThan(lockAt);
      expect(lockCalls()).toHaveLength(1);
      expect(lockAt).toBeLessThan(mocks.txPaymentFindUnique.mock.invocationCallOrder[0]!);
      expect(lockAt).toBeLessThan(mocks.txLinkUpdateMany.mock.invocationCallOrder[0]!);
    });
  });

  it("merges inbound metadata over the outbound per-delta keys when mergeMetadata is set (#1354)", async () => {
    const txLinkFindUnique = vi.fn().mockResolvedValue({
      metadata: { amountCents: 3000, watermarkCents: 8000 },
    });
    mocks.transaction.mockImplementation(async (callback: (tx: unknown) => Promise<unknown>) =>
      callback({
        $executeRaw: mocks.txExecuteRaw,
        payment: {
          findUnique: mocks.txPaymentFindUnique,
          updateMany: mocks.txPaymentUpdateMany,
        },
        xeroObjectLink: {
          createMany: mocks.txLinkCreateMany,
          updateMany: mocks.txLinkUpdateMany,
          upsert: mocks.txLinkUpsert,
          findUnique: txLinkFindUnique,
          findUniqueOrThrow: mocks.txLinkFindUniqueOrThrow,
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

    // The row keeps BOTH the outbound per-delta keys and the inbound
    // reconcile fields — pre-#1354 the replace destroyed
    // amountCents/watermarkCents minutes after every note was created.
    expect(metadataWrittenOver({ amountCents: 3000, watermarkCents: 8000 })).toEqual({
      amountCents: 3000,
      watermarkCents: 8000,
      status: "AUTHORISED",
      total: 30,
    });
  });

  it("#4445: merges in one statement over the row the upsert holds, then returns the row as merged", async () => {
    mocks.txLinkUpsert.mockResolvedValue({ id: "link_merged", metadata: { stale: true } });
    mocks.txLinkFindUniqueOrThrow.mockResolvedValue({ id: "link_merged", metadata: { linkedVia: "created", contactPersonsFingerprint: "fp-2" } });

    const written = await upsertXeroObjectLink({
      localModel: "Organisation", localId: "org_1", xeroObjectType: "CONTACT", xeroObjectId: "contact_1", role: "CONTACT",
      metadata: { contactPersonsFingerprint: "fp-2", password: "not-a-real-password", cleared: undefined },
      mergeMetadata: true,
    });

    // The upsert writes no metadata over an existing row: no value read before it can win.
    const [{ create, update }] = mocks.txLinkUpsert.mock.calls[0] as [{ create: Record<string, unknown>; update: Record<string, unknown> }];
    expect(update).not.toHaveProperty("metadata");
    expect(create.metadata).toEqual({ contactPersonsFingerprint: "fp-2", password: "[REDACTED]" });
    // One merge, keyed on the row the upsert wrote, after it, with the redacted record.
    expect(mergeCalls()).toHaveLength(1);
    const [merge] = mergeCalls();
    expect(rawSql(merge!)).toBe(
      `${MERGE_SQL_HEAD} WHEN jsonb_typeof("metadata") = 'object' THEN ("metadata" - ?::text[]) || ?::jsonb ELSE ?::jsonb END WHERE "id" = ?`,
    );
    const overlay = JSON.stringify({ contactPersonsFingerprint: "fp-2", password: "[REDACTED]" });
    expect(merge!.slice(1)).toEqual([["cleared"], overlay, overlay, "link_merged"]);
    expect(mocks.txLinkUpsert.mock.invocationCallOrder[0]!).toBeLessThan(mocks.txExecuteRaw.mock.invocationCallOrder[0]!);
    // The caller gets the row as merged, read after the statement.
    expect(mocks.txLinkFindUniqueOrThrow).toHaveBeenCalledWith({ where: { id: "link_merged" } });
    expect(written).toEqual({ id: "link_merged", metadata: { linkedVia: "created", contactPersonsFingerprint: "fp-2" } });
  });

  it("#4445: a merge that names no metadata writes none and leaves the stored value alone", async () => {
    await upsertXeroObjectLink({
      localModel: "Organisation", localId: "org_1", xeroObjectType: "CONTACT", xeroObjectId: "contact_1", role: "CONTACT", mergeMetadata: true,
    });

    expect(mocks.txLinkUpsert.mock.calls[0]![0].update).not.toHaveProperty("metadata");
    expect(mergeCalls()).toHaveLength(0);
    expect(mocks.txLinkFindUniqueOrThrow).not.toHaveBeenCalled();
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
        $executeRaw: mocks.txExecuteRaw,
        payment: {
          findUnique: mocks.txPaymentFindUnique,
          updateMany: mocks.txPaymentUpdateMany,
        },
        xeroObjectLink: {
          createMany: mocks.txLinkCreateMany,
          updateMany: mocks.txLinkUpdateMany,
          upsert: mocks.txLinkUpsert,
          findUnique: txLinkFindUnique,
          findUniqueOrThrow: mocks.txLinkFindUniqueOrThrow,
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
        update: expect.objectContaining({ active: false }),
      })
    );
    expect(metadataWrittenOver({ amountCents: 3000, watermarkCents: 8000 })).toEqual(
      expect.objectContaining({
        amountCents: 3000,
        watermarkCents: 8000,
        status: "VOIDED",
      }),
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
    mocks.operationFindFirst.mockReset();
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

  // #4338: the active lookup finds nothing, then the newest-row read names the winner's outcome.
  const lostRaceInput = {
    direction: "OUTBOUND",
    entityType: "CREDIT_NOTE",
    operationType: "CREATE",
    localModel: "Payment",
    localId: "payment_1",
    status: "PENDING",
    correlationKey: "key-x",
  } as const;
  type WinnerResolution = { manuallyResolvedAt: Date; manuallyResolvedById: string | null; manuallyResolvedReason: string };
  const unresolved = { manuallyResolvedAt: null, manuallyResolvedById: null, manuallyResolvedReason: null };
  const resolvedAt = new Date("2026-07-01T00:00:00.000Z");
  // The converge's own close: no officer, the #4219 reason.
  const convergeClose: WinnerResolution = {
    manuallyResolvedAt: resolvedAt,
    manuallyResolvedById: null,
    manuallyResolvedReason: `${CREDIT_SPENT_OUTSIDE_APP_REASON_PREFIX}: the ledger was brought into line`,
  };
  // An officer's "resolved in Xero" mark.
  const officerMark: WinnerResolution = {
    manuallyResolvedAt: resolvedAt,
    manuallyResolvedById: "member_officer",
    manuallyResolvedReason: "Fixed by hand in Xero",
  };
  const winnerFinished =
    (status: string, resolution: WinnerResolution | typeof unresolved = unresolved) =>
    (args: { where: { status?: unknown } }) =>
      Promise.resolve(args.where.status ? null : { status, ...resolution });

  // A FAILED row a converge already closed still re-inserts: the loser's converge closes its own.
  it.each([
    ["unresolved", unresolved],
    ["closed by the converge", convergeClose],
  ] as const)(
    "inserts again when the winner ended FAILED (%s) before the lookup, as a retry a moment later would (#4338)",
    async (_label, resolution) => {
      const status = "FAILED";
      mocks.operationCreate
        .mockRejectedValueOnce({ code: "P2002" })
        .mockImplementationOnce(async ({ data }: { data: unknown }) => ({ id: "op_started_1", data }));
      mocks.operationFindFirst.mockImplementation(winnerFinished(status, resolution));
      // The winner's finished row now counts as an earlier attempt.
      mocks.operationCount.mockResolvedValueOnce(0).mockResolvedValueOnce(1);

      const result = await startXeroSyncOperation(lostRaceInput);

      expect(result).toMatchObject({ id: "op_started_1" });
      expect(mocks.operationCreate).toHaveBeenCalledTimes(2);
      expect(mocks.operationCreate.mock.calls[1][0].data.attemptCount).toBe(2);
      expect(mocks.operationFindFirst).toHaveBeenLastCalledWith({
        where: { correlationKey: "key-x" },
        orderBy: [{ createdAt: "desc" }, { id: "desc" }],
        select: { status: true, manuallyResolvedAt: true, manuallyResolvedById: true, manuallyResolvedReason: true },
      });
    }
  );

  // PARTIAL: the Xero object exists. An officer's mark is done (`INV-INT-025`), never re-minted beside.
  it.each([
    ["SUCCEEDED", "unresolved", unresolved],
    ["CANCELLED", "unresolved", unresolved],
    ["PARTIAL", "unresolved", unresolved],
    ["PARTIAL", "closed by the converge", convergeClose],
    ["FAILED", "marked by an officer", officerMark],
    // An officer who wrote the converge's reason by hand is still an officer.
    ["FAILED", "marked by an officer with the converge's reason", { ...convergeClose, manuallyResolvedById: "member_officer" }],
  ] as const)(
    "rethrows the unique violation, without a second insert, when the winner ended %s (%s) (#4338)",
    async (status, _label, resolution) => {
      mocks.operationCreate.mockRejectedValueOnce({ code: "P2002" });
      mocks.operationFindFirst.mockImplementation(winnerFinished(status, resolution));

      await expect(startXeroSyncOperation(lostRaceInput)).rejects.toMatchObject({ code: "P2002" });
      expect(mocks.operationCreate).toHaveBeenCalledTimes(1);
      expect(mocks.operationFindFirst).toHaveBeenCalledTimes(2);
    }
  );

  it("rethrows the unique violation once its bounded re-inserts all lose to a winner that FAILED (#4338)", async () => {
    mocks.operationCreate.mockRejectedValue({ code: "P2002" });
    mocks.operationFindFirst.mockImplementation(winnerFinished("FAILED"));

    await expect(startXeroSyncOperation(lostRaceInput)).rejects.toMatchObject({ code: "P2002" });
    expect(mocks.operationCreate).toHaveBeenCalledTimes(3);
  });

  it("rethrows a unique violation with no correlation key, without a lookup or a second insert", async () => {
    mocks.operationCreate.mockRejectedValueOnce({ code: "P2002" });

    await expect(
      startXeroSyncOperation({ ...lostRaceInput, correlationKey: undefined })
    ).rejects.toMatchObject({ code: "P2002" });
    expect(mocks.operationFindFirst).not.toHaveBeenCalled();
    expect(mocks.operationCreate).toHaveBeenCalledTimes(1);
  });

  it("rethrows on a caller's transaction before any lookup, since the violation has aborted it (#4338)", async () => {
    const txCreate = vi.fn().mockRejectedValue({ code: "P2002" });
    const txFindFirst = vi.fn().mockImplementation(winnerFinished("FAILED"));
    const store = {
      xeroSyncOperation: { count: vi.fn().mockResolvedValue(0), create: txCreate, findFirst: txFindFirst },
    } as unknown as Prisma.TransactionClient;

    await expect(startXeroSyncOperation({ ...lostRaceInput, store })).rejects.toMatchObject({ code: "P2002" });
    expect(txCreate).toHaveBeenCalledTimes(1);
    // A read on an aborted transaction throws 25P02 and would replace the violation.
    expect(txFindFirst).not.toHaveBeenCalled();
  });

  it("treats the root client passed as `store` as no transaction: it looks up and inserts again (#4338)", async () => {
    mocks.operationCreate
      .mockRejectedValueOnce({ code: "P2002" })
      .mockImplementationOnce(async ({ data }: { data: unknown }) => ({ id: "op_started_1", data }));
    mocks.operationFindFirst.mockImplementation(winnerFinished("FAILED"));

    const result = await startXeroSyncOperation({
      ...lostRaceInput,
      store: prisma as unknown as Prisma.TransactionClient,
    });

    expect(result).toMatchObject({ id: "op_started_1" });
    expect(mocks.operationCreate).toHaveBeenCalledTimes(2);
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
    mocks.operationUpdateManyAndReturn.mockResolvedValue([]);
    mocks.operationFindUnique.mockResolvedValue({ status: "CANCELLED" });
    await expect(
      failXeroSyncOperation(xeroClaim("op_kept"), new Error("boom"), undefined, { keepCancelled: true })
    ).resolves.toBeNull();
    expect(mocks.operationUpdateManyAndReturn).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "op_kept", ...failureGuard(["RUNNING", "FAILED"]) },
        data: expect.objectContaining({ status: "FAILED" }),
      })
    );
    expect(mocks.operationUpdate).not.toHaveBeenCalled();
  });

  it("fails any other row as before", async () => {
    mocks.operationUpdateManyAndReturn.mockResolvedValue([{ id: "op_kept", status: "FAILED" }]);
    await expect(
      failXeroSyncOperation(xeroClaim("op_kept"), new Error("boom"), undefined, { keepCancelled: true })
    ).resolves.toMatchObject({ status: "FAILED" });
  });
});

describe("failXeroSyncOperation named errors (#4218)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.operationCount.mockResolvedValue(0);
    mocks.operationUpdateManyAndReturn.mockResolvedValue([{ id: "op_1", status: "FAILED" }]);
  });

  it("records the named code for a credit note spent outside the app", async () => {
    await failXeroSyncOperation(
      xeroClaim("op_1"),
      new CreditNoteSpentOutsideAppError("only $0.00 left in Xero", "cn_1", 0, 5250)
    );
    expect(mocks.operationUpdateManyAndReturn).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "op_1", ...failureGuard(["RUNNING", "FAILED"]) },
        data: expect.objectContaining({
          status: "FAILED",
          lastErrorCode: "CREDIT_NOTE_SPENT_OUTSIDE_APP",
        }),
      })
    );
  });

  it("records no named code for any other failure", async () => {
    await failXeroSyncOperation(xeroClaim("op_1"), new Error("bad request"));
    const { data } = mocks.operationUpdateManyAndReturn.mock.calls[0][0];
    expect(data.lastErrorCode).not.toBe("CREDIT_NOTE_SPENT_OUTSIDE_APP");
  });
});

// #3462: a retry that claimed the original RUNNING abandons the claim when its
// handler throws early - but only its own claim, never a row the handler
// already completed or a later claim re-stamped.
describe("failXeroSyncOperation retryClaim", () => {
  const claimedAt = new Date("2026-07-01T00:00:00.000Z");

  beforeEach(() => {
    vi.clearAllMocks();
    mocks.operationCount.mockResolvedValue(0);
  });

  it("fails the row only while it is still this claim, and answers the failed row", async () => {
    mocks.operationUpdateManyAndReturn.mockResolvedValue([{ id: "op_1", status: "FAILED" }]);
    await expect(
      failXeroSyncOperation(xeroClaim("op_1", claimedAt), new Error("contact refused"), undefined, {
        retryClaim: true,
      })
    ).resolves.toMatchObject({ status: "FAILED" });
    expect(mocks.operationUpdateManyAndReturn).toHaveBeenCalledWith(
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
      failXeroSyncOperation(xeroClaim("op_1", claimedAt), new Error("boom"), undefined, {
        keepCancelled: true,
        // @ts-expect-error keepCancelled and retryClaim are exclusive
        retryClaim: true,
      });
    expect(typeof typeOnly).toBe("function");
  });

  it("leaves a row the handler already completed as it is and answers null", async () => {
    mocks.operationUpdateManyAndReturn.mockResolvedValue([]);
    mocks.operationFindUnique.mockResolvedValue({ status: "SUCCEEDED" });
    await expect(
      failXeroSyncOperation(xeroClaim("op_1", claimedAt), new Error("late throw"), undefined, {
        retryClaim: true,
      })
    ).resolves.toBeNull();
    expect(mocks.operationUpdate).not.toHaveBeenCalled();
    expect(mocks.operationFindUniqueOrThrow).not.toHaveBeenCalled();
  });

  it("records the operator message in place of the error's own, still redacted", async () => {
    // The operator message embeds the provider's raw error text, so the
    // override must pass through the same redaction as the error's own.
    mocks.operationUpdateManyAndReturn.mockResolvedValue([{ id: "op_2", status: "FAILED" }]);
    await failXeroSyncOperation(xeroClaim("op_2"), new Error("raw"), undefined, {
      lastErrorMessage:
        "Retry of Xero operation op_1 failed: Authorization: Bearer live-token.",
    });
    const recorded = mocks.operationUpdateManyAndReturn.mock.calls[0][0].data.lastErrorMessage;
    expect(recorded).toContain("Retry of Xero operation op_1 failed");
    expect(recorded).toContain("Bearer [REDACTED]");
    expect(recorded).not.toContain("live-token");
  });
});

// #3548 round 3 (R2-6): the loser of two concurrent refund-note legs never
// writes PARTIAL over the winner's SUCCEEDED. Once its own `keepSucceeded`
// option; since #4356 every PARTIAL completion is guarded so (`INV-INT-029`).
describe("a PARTIAL completion never lands on SUCCEEDED", () => {
  function store(count: number) {
    return {
      xeroSyncOperation: {
        updateMany: vi.fn().mockResolvedValue({ count }),
        update: vi.fn(),
        findUnique: vi.fn().mockResolvedValue({ status: "SUCCEEDED" }),
        findUniqueOrThrow: vi.fn().mockResolvedValue({ id: "op_note", status: "PARTIAL" }),
      },
    };
  }

  it("leaves a SUCCEEDED row as it is, writes no link, and answers null", async () => {
    const tx = store(0);
    await expect(
      completeXeroSyncOperation(
        xeroClaim("op_note"),
        { status: "PARTIAL", extraLinks: [{ localModel: "Payment", localId: "p", xeroObjectType: "CREDIT_NOTE", xeroObjectId: "cn", role: "REFUND_CREDIT_NOTE" }] },
        { store: tx as never },
      ),
    ).resolves.toBeNull();
    expect(tx.xeroSyncOperation.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "op_note", ...outcomeGuard({ not: "SUCCEEDED" }) },
        data: expect.objectContaining({ status: "PARTIAL" }),
      }),
    );
    expect(tx.xeroSyncOperation.update).not.toHaveBeenCalled();
    expect(mocks.txLinkUpsert).not.toHaveBeenCalled();
  });

  it("completes any other row as before", async () => {
    const tx = store(1);
    await expect(completeXeroSyncOperation(xeroClaim("op_note"), { status: "PARTIAL" }, { store: tx as never })).resolves.toMatchObject({
      status: "PARTIAL",
    });
    expect(tx.xeroSyncOperation.update).not.toHaveBeenCalled();
  });
});

// #4049: a row that succeeds no longer carries an earlier wait's or failure's
// code and message (the operations panel showed them in red); PARTIAL keeps them.
describe("completeXeroSyncOperation clears a stale error on success", () => {
  function store() {
    return {
      xeroSyncOperation: {
        updateMany: vi.fn().mockResolvedValue({ count: 1 }),
        update: vi.fn(async ({ data }: { data: Record<string, unknown> }) => ({ id: "op_note", ...data })),
        findUniqueOrThrow: vi.fn().mockResolvedValue({ id: "op_note", status: "SUCCEEDED" }),
      },
    };
  }

  it("MUTATION: a SUCCEEDED completion clears lastErrorCode and lastErrorMessage", async () => {
    const tx = store();
    await completeXeroSyncOperation(xeroClaim("op_note"), {}, { store: tx as never });
    expect(tx.xeroSyncOperation.updateMany).toHaveBeenCalledWith({
      where: { id: "op_note", ...NOT_ANOTHER_CLAIM },
      data: expect.objectContaining({ status: "SUCCEEDED", lastErrorCode: null, lastErrorMessage: null }),
    });
  });

  it("a PARTIAL completion leaves them as they are", async () => {
    const tx = store();
    await completeXeroSyncOperation(xeroClaim("op_note"), { status: "PARTIAL" }, { store: tx as never });
    const [{ data }] = tx.xeroSyncOperation.updateMany.mock.calls[0] as [{ data: Record<string, unknown> }];
    expect(data).not.toHaveProperty("lastErrorCode");
    expect(data).not.toHaveProperty("lastErrorMessage");
  });
});

// #4256: a retry's completion lands only on its own claim, clears the claim's
// marker code, and a repair that stays PARTIAL can opt out of the alert.
describe("completeXeroSyncOperation retryClaim", () => {
  const claimedAt = new Date("2026-06-30T23:59:00.000Z");
  function store(count: number) {
    return {
      xeroSyncOperation: {
        updateMany: vi.fn().mockResolvedValue({ count }),
        update: vi.fn(),
        findUnique: vi.fn().mockResolvedValue({ status: "PARTIAL" }),
        findUniqueOrThrow: vi.fn().mockResolvedValue({ id: "op_repair", status: "PARTIAL" }),
      },
    };
  }

  it("MUTATION: writes only onto that RUNNING claim, and answers null when the claim is gone", async () => {
    const tx = store(0);
    await expect(
      completeXeroSyncOperation(xeroClaim("op_repair", claimedAt), { status: "SUCCEEDED" }, { store: tx as never, retryClaim: true }),
    ).resolves.toBeNull();
    expect(tx.xeroSyncOperation.updateMany).toHaveBeenCalledWith({
      where: { id: "op_repair", status: "RUNNING", startedAt: claimedAt },
      data: expect.objectContaining({ status: "SUCCEEDED" }),
    });
    expect(tx.xeroSyncOperation.update).not.toHaveBeenCalled();
  });

  it("MUTATION: a PARTIAL completion onto the claim clears its marker code and takes the message it is given", async () => {
    const tx = store(1);
    await completeXeroSyncOperation(
      xeroClaim("op_repair", claimedAt),
      { status: "PARTIAL", lastErrorMessage: "The invoice email still failed." },
      { store: tx as never, retryClaim: true },
    );
    expect(tx.xeroSyncOperation.updateMany.mock.calls[0][0].data).toMatchObject({
      status: "PARTIAL",
      lastErrorCode: null,
      lastErrorMessage: "The invoice email still failed.",
    });
  });

  it("MUTATION: alert false raises no repeated-failure alert for a row left PARTIAL", async () => {
    const { maybeNotifyXeroRepeatedFailure } = await import("@/lib/xero-hardening");
    vi.mocked(maybeNotifyXeroRepeatedFailure).mockClear();
    await completeXeroSyncOperation(xeroClaim("op_repair", claimedAt), { status: "PARTIAL" }, { store: store(1) as never, retryClaim: true, alert: false });
    expect(maybeNotifyXeroRepeatedFailure).not.toHaveBeenCalled();
    await completeXeroSyncOperation(xeroClaim("op_repair", claimedAt), { status: "PARTIAL" }, { store: store(1) as never, retryClaim: true });
    expect(maybeNotifyXeroRepeatedFailure).toHaveBeenCalledTimes(1);
  });
});

// #4356 (`INV-INT-029`): two callers can hold one operation row (a start that
// loses the insert race is handed the winner's ACTIVE row, #1354) and each
// records its own outcome there. An outcome never replaces a better one already
// recorded, nor lands on a repair's claim. A one-row double evaluates each
// write's guard against the row the way PostgreSQL would, so these pin the
// DECISION, not the `where` spelling.
describe("outcome writes never replace a recorded success (#4356, INV-INT-029)", () => {
  type Row = {
    id: string;
    status: string;
    startedAt: Date | null;
    lastErrorCode: string | null;
    xeroObjectId: string | null;
    [key: string]: unknown;
  };
  type StatusFilter = string | { not: string } | { notIn: string[] } | { in: string[] };
  type CodeFilter = null | { notIn: string[] };
  type Where = {
    id?: string;
    startedAt?: Date | null;
    status?: StatusFilter;
    lastErrorCode?: CodeFilter;
    OR?: Where[];
    AND?: Where[];
  };
  const STATUSES = ["PENDING", "RUNNING", "WAITING_PAYMENT", "FAILED", "PARTIAL", "SUCCEEDED", "CANCELLED"] as const;
  const REPAIR_MARKERS = ["PARTIAL_REPAIR_RUNNING", "REFUND_NOTE_REPAIR_RUNNING"] as const;

  const statusMatches = (status: string, filter: StatusFilter) => {
    if (typeof filter === "string") return status === filter;
    if ("not" in filter) return status !== filter.not;
    if ("in" in filter) return filter.in.includes(status);
    return !filter.notIn.includes(status);
  };
  // SQL: `x NOT IN (...)` is never true for a null x.
  const codeMatches = (code: string | null, filter: CodeFilter) =>
    filter === null ? code === null : code !== null && !filter.notIn.includes(code);
  // The guard's `where` as PostgreSQL reads it: every key, and every AND and OR branch.
  const whereMatches = (row: Row, where: Where): boolean =>
    (where.id === undefined || where.id === row.id) &&
    (where.startedAt === undefined ||
      (where.startedAt === null ? row.startedAt === null : where.startedAt.getTime() === row.startedAt?.getTime())) &&
    (where.status === undefined || statusMatches(row.status, where.status)) &&
    (where.lastErrorCode === undefined || codeMatches(row.lastErrorCode, where.lastErrorCode)) &&
    (where.OR === undefined || where.OR.some((branch) => whereMatches(row, branch))) &&
    (where.AND === undefined || where.AND.every((branch) => whereMatches(row, branch)));

  function oneRow(status: string, xeroObjectId: string | null = null, lastErrorCode: string | null = null) {
    const row: Row = {
      id: "op_shared",
      status,
      // #4373: the claim both callers sharing the row hold (`xeroClaim`'s default).
      startedAt: TEST_XERO_CLAIMED_AT,
      lastErrorCode,
      xeroObjectId,
    };
    let present = true;
    const matches = (where: Where) => present && where.id === row.id && whereMatches(row, where);
    const xeroSyncOperation = {
      updateMany: vi.fn(async ({ where, data }: { where: Where; data: Partial<Row> }) => {
        if (!matches(where)) return { count: 0 };
        Object.assign(row, data);
        return { count: 1 };
      }),
      updateManyAndReturn: vi.fn(async ({ where, data }: { where: Where; data: Partial<Row> }) => {
        if (!matches(where)) return [];
        Object.assign(row, data);
        return [{ ...row }];
      }),
      update: vi.fn(async ({ where, data }: { where: Where; data: Partial<Row> }) => {
        if (!present || where.id !== row.id) throw new Error("no such row");
        Object.assign(row, data);
        return { ...row };
      }),
      findUnique: vi.fn(async () => (present ? { ...row } : null)),
      findUniqueOrThrow: vi.fn(async () => {
        if (!present) throw new Error("no such row");
        return { ...row };
      }),
    };
    // `failXeroSyncOperation` writes on the module client; route it to this row.
    mocks.operationUpdateMany.mockImplementation(xeroSyncOperation.updateMany);
    mocks.operationUpdateManyAndReturn.mockImplementation(xeroSyncOperation.updateManyAndReturn);
    mocks.operationUpdate.mockImplementation(xeroSyncOperation.update);
    mocks.operationFindUnique.mockImplementation(xeroSyncOperation.findUnique);
    mocks.operationFindUniqueOrThrow.mockImplementation(xeroSyncOperation.findUniqueOrThrow);
    return {
      row,
      store: { xeroSyncOperation } as never,
      remove: () => {
        present = false;
      },
    };
  }

  const recordedSuccess = (status: string) => status === "SUCCEEDED" || status === "PARTIAL";

  beforeEach(() => {
    vi.clearAllMocks();
    mocks.operationCount.mockResolvedValue(0);
  });

  // #4673: a failure lands only on its own claim's row - RUNNING, or the FAILED
  // end that claim already wrote - never a PENDING, waiting, skipped or (PR #4687
  // review) CANCELLED row, whatever its `startedAt`.
  const failureLandsOn = (status: string) => ["RUNNING", "FAILED"].includes(status);

  it.each(STATUSES)("MUTATION: a failure lands on its own claim's %s row only when it is RUNNING or FAILED", async (existing) => {
    const { row } = oneRow(existing);
    const outcome = await failXeroSyncOperation(xeroClaim("op_shared"), new Error("Xero 429"));
    expect(row.status).toBe(failureLandsOn(existing) ? "FAILED" : existing);
    expect(outcome === null).toBe(!failureLandsOn(existing));
  });

  it.each(STATUSES)("MUTATION: a PARTIAL completion lands on a %s row unless it is SUCCEEDED", async (existing) => {
    const { row, store } = oneRow(existing);
    await completeXeroSyncOperation(xeroClaim("op_shared"), { status: "PARTIAL", xeroObjectId: "inv_l" }, { store });
    expect(row.status).toBe(existing === "SUCCEEDED" ? "SUCCEEDED" : "PARTIAL");
  });

  it.each(STATUSES)("MUTATION: a CANCELLED completion lands on a %s row only when it holds no recorded success", async (existing) => {
    const { row, store } = oneRow(existing);
    await completeXeroSyncOperation(xeroClaim("op_shared"), { status: "CANCELLED" }, { store });
    expect(row.status).toBe(recordedSuccess(existing) ? existing : "CANCELLED");
  });

  it.each(STATUSES)("MUTATION (#4673): a FAILED completion lands on its own claim's %s row only as a failure does", async (existing) => {
    const { row, store } = oneRow(existing);
    await completeXeroSyncOperation(xeroClaim("op_shared"), { status: "FAILED" }, { store });
    expect(row.status).toBe(failureLandsOn(existing) ? "FAILED" : existing);
  });

  it.each(STATUSES)("a SUCCEEDED completion lands on a %s row: the truer outcome of the same keyed call", async (existing) => {
    const { row, store } = oneRow(existing);
    await completeXeroSyncOperation(xeroClaim("op_shared"), { xeroObjectType: "PAYMENT", xeroObjectId: "pay_l" }, { store });
    expect(row).toMatchObject({ status: "SUCCEEDED", xeroObjectId: "pay_l", lastErrorCode: null, lastErrorMessage: null });
  });

  it("W completes SUCCEEDED, then L fails on the same row: the row keeps W's success and the alert never sees L's failure", async () => {
    const { maybeNotifyXeroRepeatedFailure } = await import("@/lib/xero-hardening");
    const { row, store } = oneRow("RUNNING");
    await completeXeroSyncOperation(xeroClaim("op_shared"), { xeroObjectType: "PAYMENT", xeroObjectId: "pay_w" }, { store });
    await expect(failXeroSyncOperation(xeroClaim("op_shared"), new Error("Xero 409: idempotency key in use"))).resolves.toBeNull();
    expect(row).toMatchObject({ status: "SUCCEEDED", xeroObjectId: "pay_w", lastErrorMessage: null });
    expect(maybeNotifyXeroRepeatedFailure).not.toHaveBeenCalled();
  });

  it("a PARTIAL completion that may not land writes no link and raises no alert", async () => {
    const { maybeNotifyXeroRepeatedFailure } = await import("@/lib/xero-hardening");
    const { row, store } = oneRow("SUCCEEDED", "cn_w");
    await expect(
      completeXeroSyncOperation(
        xeroClaim("op_shared"),
        { status: "PARTIAL", xeroObjectId: "cn_l", extraLinks: [{ localModel: "Payment", localId: "p", xeroObjectType: "CREDIT_NOTE", xeroObjectId: "cn_l", role: "REFUND_CREDIT_NOTE" }] },
        { store },
      ),
    ).resolves.toBeNull();
    expect(row).toMatchObject({ status: "SUCCEEDED", xeroObjectId: "cn_w" });
    expect(mocks.txLinkUpsert).not.toHaveBeenCalled();
    expect(maybeNotifyXeroRepeatedFailure).not.toHaveBeenCalled();
  });

  it("a failure that lands is still offered to the repeated-failure alert", async () => {
    const { maybeNotifyXeroRepeatedFailure } = await import("@/lib/xero-hardening");
    oneRow("RUNNING");
    await expect(failXeroSyncOperation(xeroClaim("op_shared"), new Error("Xero 500"))).resolves.toMatchObject({ status: "FAILED" });
    expect(maybeNotifyXeroRepeatedFailure).toHaveBeenCalledWith(expect.objectContaining({ id: "op_shared", status: "FAILED" }));
  });

  // Review F3: the row answered and alerted is the row this write wrote, not a
  // later read another caller's outcome may already have replaced.
  it("MUTATION: the failed row returned and offered to the alert is the one this write wrote", async () => {
    const { maybeNotifyXeroRepeatedFailure } = await import("@/lib/xero-hardening");
    oneRow("RUNNING");
    mocks.operationFindUniqueOrThrow.mockResolvedValue({ id: "op_shared", status: "SUCCEEDED" });
    await expect(failXeroSyncOperation(xeroClaim("op_shared"), new Error("Xero 500"))).resolves.toMatchObject({ status: "FAILED" });
    expect(maybeNotifyXeroRepeatedFailure).toHaveBeenCalledWith(expect.objectContaining({ status: "FAILED" }));
  });

  it("keepCancelled still keeps CANCELLED on top of the guard", async () => {
    const cancelled = oneRow("CANCELLED");
    await expect(failXeroSyncOperation(xeroClaim("op_shared"), new Error("late"), undefined, { keepCancelled: true })).resolves.toBeNull();
    expect(cancelled.row.status).toBe("CANCELLED");
  });

  it("a retry's claim guard is unchanged: it writes onto its own RUNNING claim and nothing else", async () => {
    const { row, store } = oneRow("RUNNING");
    const claimedAt = row.startedAt!;
    await completeXeroSyncOperation(xeroClaim("op_shared", claimedAt), { status: "PARTIAL" }, { store, retryClaim: true });
    expect(row.status).toBe("PARTIAL");
    const failed = oneRow("FAILED");
    await expect(
      failXeroSyncOperation(xeroClaim("op_shared", failed.row.startedAt!), new Error("x"), undefined, { retryClaim: true }),
    ).resolves.toBeNull();
  });

  // #4373: every outcome carries the claim it was made under. A RUNNING row a
  // later claim stamped (a retry, after a stale reset or a failure) takes no
  // outcome of the earlier attempt, a success included.
  describe("an earlier attempt's late outcome (#4373)", () => {
    const EARLIER = new Date("2026-06-30T23:00:00.000Z");
    const outcomes: Array<[string, (store: never) => Promise<unknown>]> = [
      ["a failure", () => failXeroSyncOperation(xeroClaim("op_shared", EARLIER), new Error("Xero 429"))],
      ["a kept-CANCELLED failure", () => failXeroSyncOperation(xeroClaim("op_shared", EARLIER), new Error("late"), undefined, { keepCancelled: true })],
      ...(["PARTIAL", "FAILED", "CANCELLED", "SUCCEEDED"] as const).map(
        (status): [string, (store: never) => Promise<unknown>] => [
          `a ${status} completion`,
          (store) => completeXeroSyncOperation(xeroClaim("op_shared", EARLIER), { status, xeroObjectId: "inv_late" }, { store }),
        ],
      ),
    ];

    it.each(outcomes)("MUTATION: %s never lands on a later claim's RUNNING row: null, no link, no alert", async (_label, write) => {
      const { maybeNotifyXeroRepeatedFailure } = await import("@/lib/xero-hardening");
      const { row, store } = oneRow("RUNNING");
      await expect(write(store)).resolves.toBeNull();
      expect(row).toMatchObject({ status: "RUNNING", startedAt: TEST_XERO_CLAIMED_AT, xeroObjectId: null });
      expect(mocks.txLinkUpsert).not.toHaveBeenCalled();
      expect(maybeNotifyXeroRepeatedFailure).not.toHaveBeenCalled();
    });

    // Review F1: a success refused on a later claim still records its Xero links,
    // so a retry that then fails does not leave the object recorded nowhere.
    // A supplementary invoice's links live only in `extraLinks`.
    const supplementaryLinks = [
      { localModel: "BookingModification", localId: "mod_1", xeroObjectType: "INVOICE", xeroObjectId: "inv_late", role: "SUPPLEMENTARY_INVOICE" },
      { localModel: "BookingModification", localId: "mod_1", xeroObjectType: "PAYMENT", xeroObjectId: "pay_late", role: "SUPPLEMENTARY_INVOICE_PAYMENT" },
    ];
    const withLinkWriter = (store: never) => {
      mocks.txLinkUpsert.mockResolvedValue({ id: "link_late" });
      mocks.txLinkFindUniqueOrThrow.mockResolvedValue({ id: "link_late" });
      mocks.txLinkFindUnique.mockResolvedValue(null);
      mocks.txLinkFindMany.mockResolvedValue([]);
      mocks.txLinkUpdateMany.mockResolvedValue({ count: 0 });
      mocks.txLinkCreateMany.mockResolvedValue({ count: 0 });
      mocks.txExecuteRaw.mockResolvedValue(1);
      return {
        ...(store as object),
        $executeRaw: mocks.txExecuteRaw,
        payment: { findUnique: mocks.txPaymentFindUnique, updateMany: mocks.txPaymentUpdateMany },
        xeroObjectLink: {
          createMany: mocks.txLinkCreateMany,
          updateMany: mocks.txLinkUpdateMany,
          upsert: mocks.txLinkUpsert,
          findUnique: mocks.txLinkFindUnique,
          findUniqueOrThrow: mocks.txLinkFindUniqueOrThrow,
          findMany: mocks.txLinkFindMany,
        },
      } as never;
    };

    it.each(["SUCCEEDED", "PARTIAL"])(
      "MUTATION (review F1): a %s refused on a later claim still records its supplementary-invoice links, row untouched, warned",
      async (status) => {
        const { maybeNotifyXeroRepeatedFailure } = await import("@/lib/xero-hardening");
        const logger = (await import("@/lib/logger")).default;
        const { row, store } = oneRow("RUNNING");
        await expect(
          completeXeroSyncOperation(
            xeroClaim("op_shared", EARLIER),
            { status, xeroObjectType: "INVOICE", xeroObjectId: "inv_late", extraLinks: supplementaryLinks },
            { store: withLinkWriter(store) },
          ),
        ).resolves.toBeNull();
        expect(row).toMatchObject({ status: "RUNNING", startedAt: TEST_XERO_CLAIMED_AT, xeroObjectId: null });
        const written = mocks.txLinkUpsert.mock.calls.map(([args]) => (args as { create: { xeroObjectId: string; role: string } }).create);
        expect(written).toEqual([
          expect.objectContaining({ xeroObjectId: "inv_late", role: "SUPPLEMENTARY_INVOICE" }),
          expect.objectContaining({ xeroObjectId: "pay_late", role: "SUPPLEMENTARY_INVOICE_PAYMENT" }),
        ]);
        expect(logger.warn).toHaveBeenCalledWith(
          expect.objectContaining({ operationId: "op_shared", xeroObjectId: "inv_late", claimStartedAt: EARLIER, heldClaimStartedAt: TEST_XERO_CLAIMED_AT }),
          expect.stringContaining("links were recorded"),
        );
        expect(maybeNotifyXeroRepeatedFailure).not.toHaveBeenCalled();
      },
    );

    it.each(["FAILED", "CANCELLED"])("a %s completion refused on a later claim still records nothing", async (status) => {
      const { row, store } = oneRow("RUNNING");
      await expect(
        completeXeroSyncOperation(xeroClaim("op_shared", EARLIER), { status, extraLinks: supplementaryLinks }, { store: withLinkWriter(store) }),
      ).resolves.toBeNull();
      expect(row.status).toBe("RUNNING");
      expect(mocks.txLinkUpsert).not.toHaveBeenCalled();
    });

    it("logs the refusal, as INV-INT-029's refusals are", async () => {
      const logger = (await import("@/lib/logger")).default;
      oneRow("RUNNING");
      await failXeroSyncOperation(xeroClaim("op_shared", EARLIER), new Error("Xero 429"));
      expect(logger.info).toHaveBeenCalledWith(
        expect.objectContaining({ operationId: "op_shared", status: "FAILED", heldStatus: "RUNNING" }),
        expect.stringContaining("INV-INT-029"),
      );
    });

    it("MUTATION: the claim's own outcome lands on its RUNNING row", async () => {
      for (const status of ["PARTIAL", "FAILED", "CANCELLED", "SUCCEEDED"]) {
        const { row, store } = oneRow("RUNNING");
        await completeXeroSyncOperation(xeroClaim("op_shared"), { status }, { store });
        expect(row.status).toBe(status);
      }
      const failing = oneRow("RUNNING");
      await expect(failXeroSyncOperation(xeroClaim("op_shared"), new Error("Xero 429"))).resolves.toMatchObject({ status: "FAILED" });
      expect(failing.row.status).toBe("FAILED");
    });

    it("a success still lands on a FAILED row another claim ended, as INV-INT-029 allows; a failure does not (#4673)", async () => {
      const { maybeNotifyXeroRepeatedFailure } = await import("@/lib/xero-hardening");
      const failed = oneRow("FAILED");
      await completeXeroSyncOperation(xeroClaim("op_shared", EARLIER), { xeroObjectId: "inv_late" }, { store: failed.store });
      expect(failed.row).toMatchObject({ status: "SUCCEEDED", xeroObjectId: "inv_late" });
      const again = oneRow("FAILED", null, "LATER_ATTEMPT_ERROR");
      await expect(failXeroSyncOperation(xeroClaim("op_shared", EARLIER), new Error("Xero 429"))).resolves.toBeNull();
      expect(again.row).toMatchObject({ status: "FAILED", startedAt: TEST_XERO_CLAIMED_AT, lastErrorCode: "LATER_ATTEMPT_ERROR" });
      expect(maybeNotifyXeroRepeatedFailure).not.toHaveBeenCalled();
    });

    it("a caller handed a row before any claim (null startedAt) writes onto no RUNNING claim", async () => {
      const { row, store } = oneRow("RUNNING");
      await expect(completeXeroSyncOperation(xeroClaim("op_shared", null), { status: "SUCCEEDED" }, { store })).resolves.toBeNull();
      expect(row.status).toBe("RUNNING");
    });
  });

  // Review F1 case (a): a repair's claim holds the payload the repair reads and
  // gives back; another caller's late outcome landing there would make the give-
  // back lose and send the next retry down the create path, which records no payment.
  describe.each(REPAIR_MARKERS)("a repair's RUNNING claim (%s)", (marker) => {
    it("MUTATION: takes no other caller's failure, or PARTIAL, FAILED or CANCELLED completion", async () => {
      const { row, store } = oneRow("RUNNING", "inv_1", marker);
      await expect(failXeroSyncOperation(xeroClaim("op_shared"), new Error("Xero 409: key in use"))).resolves.toBeNull();
      await expect(failXeroSyncOperation(xeroClaim("op_shared"), new Error("late"), undefined, { keepCancelled: true })).resolves.toBeNull();
      for (const status of ["PARTIAL", "FAILED", "CANCELLED"]) {
        await expect(completeXeroSyncOperation(xeroClaim("op_shared"), { status }, { store })).resolves.toBeNull();
      }
      expect(row).toMatchObject({ status: "RUNNING", lastErrorCode: marker, xeroObjectId: "inv_1" });
    });

    it("still takes the repair's own completion onto its claim, and a success", async () => {
      const own = oneRow("RUNNING", "inv_1", marker);
      await completeXeroSyncOperation(xeroClaim("op_shared", own.row.startedAt!), { status: "PARTIAL" }, { store: own.store, retryClaim: true });
      expect(own.row).toMatchObject({ status: "PARTIAL", lastErrorCode: null });
      const succeeded = oneRow("RUNNING", "inv_1", marker);
      await completeXeroSyncOperation(xeroClaim("op_shared"), { xeroObjectId: "inv_1" }, { store: succeeded.store });
      expect(succeeded.row.status).toBe("SUCCEEDED");
    });
  });

  // The stated limit of `INV-INT-029` (#4373): a plain retry's claim carries no
  // marker, so another caller's late failure still lands on it, and a
  // completion guarded on that claim then loses. Pinned so a fix changes it on purpose.
  it("LIMIT (#4373): a late failure lands on a plain retry's unmarked claim, and the claim's own completion then loses", async () => {
    const { row, store } = oneRow("RUNNING", null, "XERO_429");
    const claimedAt = row.startedAt!;
    await expect(failXeroSyncOperation(xeroClaim("op_shared"), new Error("Xero 409: key in use"))).resolves.toMatchObject({ status: "FAILED" });
    expect(row.status).toBe("FAILED");
    await expect(
      completeXeroSyncOperation(xeroClaim("op_shared", claimedAt), { status: "PARTIAL" }, { store, retryClaim: true }),
    ).resolves.toBeNull();
    expect(row.status).toBe("FAILED");
  });

  it("refuses an outcome with no operation id rather than write every row", async () => {
    oneRow("RUNNING");
    await expect(failXeroSyncOperation(xeroClaim(undefined as unknown as string), new Error("x"))).rejects.toThrow("operation's id");
    expect(mocks.operationUpdateManyAndReturn).not.toHaveBeenCalled();
  });

  // #4673: a stalled run is reset FAILED, an officer's Retry queues the same row
  // again (PENDING, `startedAt` cleared, `requeueOutboxRowForRetry`), then the
  // stalled run answers with a failure. It lost its claim: dropped, so the queued
  // run writes its own outcome.
  describe("a failure lands only on its own claim's row (#4673)", () => {
    const queuedAgain = (status = "PENDING") => {
      const queued = oneRow(status);
      queued.row.startedAt = null;
      return queued;
    };

    it("MUTATION: a stalled run's late failure leaves the row an officer's Retry queued again: null, nothing written, no alert", async () => {
      const { maybeNotifyXeroRepeatedFailure } = await import("@/lib/xero-hardening");
      const logger = (await import("@/lib/logger")).default;
      for (const options of [undefined, { keepCancelled: true } as const]) {
        const { row } = queuedAgain();
        await expect(failXeroSyncOperation(xeroClaim("op_shared"), new Error("Xero 500"), undefined, options)).resolves.toBeNull();
        expect(row).toMatchObject({ status: "PENDING", startedAt: null, lastErrorCode: null });
        await expect(completeXeroSyncOperation(xeroClaim("op_shared"), { status: "FAILED" }, { store: oneRow("PENDING").store })).resolves.toBeNull();
      }
      expect(maybeNotifyXeroRepeatedFailure).not.toHaveBeenCalled();
      expect(logger.info).toHaveBeenCalledWith(
        expect.objectContaining({ operationId: "op_shared", status: "FAILED", heldStatus: "PENDING" }),
        expect.stringContaining("INV-INT-029"),
      );
    });

    it.each(["PENDING", "WAITING_PAYMENT", "SKIPPED"])(
      "MUTATION: a caller holding no claim (null startedAt) fails no %s row either",
      async (status) => {
        const { row } = queuedAgain(status);
        await expect(failXeroSyncOperation(xeroClaim("op_shared", null), new Error("Xero 500"))).resolves.toBeNull();
        expect(row.status).toBe(status);
      },
    );

    it("MUTATION: the stalled run's own row, reset FAILED, takes its late failure: the error is refreshed and alerted", async () => {
      const { maybeNotifyXeroRepeatedFailure } = await import("@/lib/xero-hardening");
      const { row } = oneRow("FAILED", null, "XERO_ORPHANED_STALE_RUNNING");
      await expect(failXeroSyncOperation(xeroClaim("op_shared"), new Error("Xero 500"))).resolves.toMatchObject({ status: "FAILED" });
      expect(row.lastErrorCode).not.toBe("XERO_ORPHANED_STALE_RUNNING");
      expect(maybeNotifyXeroRepeatedFailure).toHaveBeenCalledWith(expect.objectContaining({ id: "op_shared", status: "FAILED" }));
    });

    // PR #4687 review: a withdrawal cancels a FAILED row keeping its `startedAt`, so
    // a CANCELLED row under this claim may be a treasurer's, not this claim's end.
    it("MUTATION: a CANCELLED row takes no failure, under its own claim or any, with or without keepCancelled", async () => {
      const { maybeNotifyXeroRepeatedFailure } = await import("@/lib/xero-hardening");
      const own = oneRow("CANCELLED");
      await expect(failXeroSyncOperation(xeroClaim("op_shared"), new Error("late"))).resolves.toBeNull();
      expect(own.row.status).toBe("CANCELLED");
      expect(maybeNotifyXeroRepeatedFailure).not.toHaveBeenCalled();
      const withdrawn = queuedAgain("CANCELLED");
      await expect(failXeroSyncOperation(xeroClaim("op_shared"), new Error("late"))).resolves.toBeNull();
      expect(withdrawn.row.status).toBe("CANCELLED");
      const kept = oneRow("CANCELLED");
      await expect(failXeroSyncOperation(xeroClaim("op_shared"), new Error("late"), undefined, { keepCancelled: true })).resolves.toBeNull();
      expect(kept.row.status).toBe("CANCELLED");
    });

    it("a caller holding no claim still fails a FAILED row no claim stamped", async () => {
      const { row } = queuedAgain("FAILED");
      await expect(failXeroSyncOperation(xeroClaim("op_shared", null), new Error("Xero 500"))).resolves.toMatchObject({ status: "FAILED" });
      expect(row.lastErrorMessage).toBeTruthy();
    });
  });

  // Review: a refusal says why. A row that is not there is not "kept its outcome".
  describe("a write that matched nothing", () => {
    it("MUTATION: logs that the row kept its outcome when the row is there", async () => {
      const logger = (await import("@/lib/logger")).default;
      oneRow("SUCCEEDED");
      await expect(failXeroSyncOperation(xeroClaim("op_shared"), new Error("late"))).resolves.toBeNull();
      expect(logger.info).toHaveBeenCalledWith(
        { operationId: "op_shared", status: "FAILED", heldStatus: "SUCCEEDED" },
        expect.stringContaining("kept the outcome or claim it holds"),
      );
      expect(logger.warn).not.toHaveBeenCalled();
    });

    it("MUTATION: throws for a missing row the caller did not guard, as the unguarded write did", async () => {
      const { store, remove } = oneRow("RUNNING");
      remove();
      await expect(failXeroSyncOperation(xeroClaim("op_shared"), new Error("x"))).rejects.toThrow("op_shared was not found");
      await expect(completeXeroSyncOperation(xeroClaim("op_shared"), { status: "PARTIAL" }, { store })).rejects.toThrow(
        "op_shared was not found",
      );
    });

    it("MUTATION: logs a missing row a guarded caller wrote to, and answers null", async () => {
      const logger = (await import("@/lib/logger")).default;
      const { store, remove } = oneRow("RUNNING");
      remove();
      await expect(failXeroSyncOperation(xeroClaim("op_shared"), new Error("x"), undefined, { keepCancelled: true })).resolves.toBeNull();
      await expect(
        completeXeroSyncOperation(xeroClaim("op_shared", new Date()), { status: "PARTIAL" }, { store, retryClaim: true }),
      ).resolves.toBeNull();
      expect(logger.warn).toHaveBeenCalledTimes(2);
      expect(logger.warn).toHaveBeenCalledWith(
        { operationId: "op_shared", status: "FAILED" },
        expect.stringContaining("row was not found"),
      );
      expect(logger.info).not.toHaveBeenCalled();
    });
  });
});
