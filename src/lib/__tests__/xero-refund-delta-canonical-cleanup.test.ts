import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * #2901 cross-module regression: note creation/normalization
 * (`upsertXeroObjectLink`), canonical cleanup
 * (`cleanupStaleCanonicalXeroObjectLinks`), coverage calculation
 * (`sumCoveredRefundCreditNoteCents` / `getRefundsMissingXeroCreditNotes`) and
 * the daily credit reconciliation (`reconcileCreditBalances`) run REPEATEDLY
 * over one Stripe payment refunded in two steps (90c + 10c of a 100c
 * cumulative refund, the anonymised production shape that accumulated 21
 * duplicate notes).
 *
 * The invariant pinned here is INV-ADDPAY-020's converse: once the per-delta
 * notes sum to the refunded total, re-running every job any number of times
 * keeps 90 + 10 = 100, keeps both links active, and enqueues NOTHING — the
 * duplicate-note loop cannot start, and cannot restart.
 *
 * Backed by a stateful in-memory Prisma fake so the modules under test run
 * their real queries against real row state. One of the two links is a legacy
 * link with no metadata amount, so the loop also proves the create-operation
 * payload recovery path end to end.
 */

interface FakeLinkRow {
  id: string;
  localModel: string;
  localId: string;
  xeroObjectType: string;
  xeroObjectId: string;
  xeroObjectNumber: string | null;
  xeroObjectUrl: string | null;
  role: string;
  active: boolean;
  metadata: Record<string, unknown> | null;
  createdAt: Date;
  updatedAt: Date;
}

const state = vi.hoisted(() => ({
  payments: [] as Array<{
    id: string;
    bookingId: string;
    source: string;
    refundedAmountCents: number;
    xeroInvoiceId: string | null;
    xeroRefundCreditNoteId: string | null;
    updatedAt: Date;
    booking: { member: { firstName: string; lastName: string; email: string } };
  }>,
  links: [] as FakeLinkRow[],
  operations: [] as Array<{
    direction: string;
    entityType: string;
    operationType: string;
    localModel: string;
    localId: string;
    xeroObjectId: string;
    requestPayload: unknown;
    createdAt: Date;
  }>,
  // #2902 cash-evidence inputs. Empty by default: no PaymentRefund ledger
  // rows and no account-credit disposition resolves through the legacy-mirror
  // fallback to cash target === refundedAmountCents — the pre-#2902 meaning
  // of every #2901 scenario.
  paymentRefunds: [] as Array<{
    paymentId: string;
    status: string;
    amountCents: number;
  }>,
  memberCredits: [] as Array<{
    sourceBookingId: string;
    type: string;
    amountCents: number;
    restoredFromBookingId: string | null;
  }>,
  linkIdCounter: 0,
}));

const fakePrisma = vi.hoisted(() => {
  const matchesRole = (rowRole: string, filter: unknown): boolean => {
    if (filter === undefined) return true;
    if (typeof filter === "string") return rowRole === filter;
    const inFilter = (filter as { in?: string[] }).in;
    return !inFilter || inFilter.includes(rowRole);
  };

  const matchesLinkWhere = (
    row: FakeLinkRow,
    where: Record<string, unknown>
  ): boolean => {
    if (where.localModel !== undefined && row.localModel !== where.localModel) return false;
    if (where.localId !== undefined && row.localId !== where.localId) return false;
    if (where.xeroObjectType !== undefined && row.xeroObjectType !== where.xeroObjectType) return false;
    if (where.role !== undefined && !matchesRole(row.role, where.role)) return false;
    if (typeof where.active === "boolean" && row.active !== where.active) return false;
    const idFilter = where.id as { in?: string[] } | undefined;
    if (idFilter?.in && !idFilter.in.includes(row.id)) return false;
    const objectIdFilter = where.xeroObjectId as
      | string
      | { not?: string }
      | undefined;
    if (typeof objectIdFilter === "string" && row.xeroObjectId !== objectIdFilter) return false;
    if (
      objectIdFilter &&
      typeof objectIdFilter === "object" &&
      objectIdFilter.not !== undefined &&
      row.xeroObjectId === objectIdFilter.not
    ) {
      return false;
    }
    const orFilter = where.OR as Array<Record<string, unknown>> | undefined;
    if (orFilter && !orFilter.some((branch) => matchesLinkWhere(row, branch))) return false;
    return true;
  };

  const client = {
    member: { findMany: async () => [] },
    memberSubscription: { findMany: async () => [] },
    memberCredit: {
      groupBy: async () => [],
      count: async () => 0,
      // #2902 legacy fallback: the account-credit disposition sourced from
      // the payment's booking, excluding restore rows.
      aggregate: async (args: {
        where: {
          sourceBookingId: string;
          type: { in: string[] };
          amountCents: { gt: number };
          restoredFromBookingId: null;
        };
      }) => {
        const sum = state.memberCredits
          .filter(
            (row) =>
              row.sourceBookingId === args.where.sourceBookingId &&
              args.where.type.in.includes(row.type) &&
              row.amountCents > args.where.amountCents.gt &&
              row.restoredFromBookingId === null
          )
          .reduce((total, row) => total + row.amountCents, 0);
        return { _sum: { amountCents: sum > 0 ? sum : null } };
      },
    },
    paymentRefund: {
      // Mirrors resolveStripeCashRefundEvidence's groupBy(["status"]) shape.
      groupBy: async (args: { by: string[]; where: { paymentId: string } }) => {
        const rows = state.paymentRefunds.filter(
          (row) => row.paymentId === args.where.paymentId
        );
        const byStatus = new Map<string, { sum: number; count: number }>();
        for (const row of rows) {
          const bucket = byStatus.get(row.status) ?? { sum: 0, count: 0 };
          bucket.sum += row.amountCents;
          bucket.count += 1;
          byStatus.set(row.status, bucket);
        }
        return [...byStatus.entries()].map(([status, bucket]) => ({
          status,
          _sum: { amountCents: bucket.sum },
          _count: { _all: bucket.count },
        }));
      },
      // #3635 round-3 R1: the note-eligible cash reads which refunds name a
      // late capture; these fixtures carry no intent, so none do.
      findMany: async () => [],
    },
    payment: {
      findMany: async (args: { where: Record<string, unknown> }) => {
        const where = args.where;
        return state.payments
          .filter((row) => {
            if (where.source !== undefined && row.source !== where.source) return false;
            const idFilter = where.id as { in?: string[] } | undefined;
            if (idFilter?.in && !idFilter.in.includes(row.id)) return false;
            const refunded = where.refundedAmountCents as { gt?: number } | undefined;
            if (refunded?.gt !== undefined && !(row.refundedAmountCents > refunded.gt)) return false;
            const invoiceFilter = where.xeroInvoiceId as { not?: null } | undefined;
            if (invoiceFilter && "not" in invoiceFilter && row.xeroInvoiceId === null) return false;
            const updatedAtFilter = where.updatedAt as { lt?: Date } | undefined;
            if (updatedAtFilter?.lt && !(row.updatedAt < updatedAtFilter.lt)) return false;
            const orFilter = where.OR as Array<Record<string, unknown>> | undefined;
            if (orFilter) {
              const matchesOr = orFilter.some((branch) => {
                if ("xeroInvoiceId" in branch) return row.xeroInvoiceId !== null;
                if ("xeroRefundCreditNoteId" in branch) return row.xeroRefundCreditNoteId !== null;
                return false;
              });
              if (!matchesOr) return false;
            }
            return true;
          })
          .map((row) => ({ ...row }));
      },
      findUnique: async (args: { where: { id: string } }) => {
        const row = state.payments.find((payment) => payment.id === args.where.id);
        return row ? { ...row } : null;
      },
      update: async (args: {
        where: { id: string };
        data: Record<string, unknown>;
      }) => {
        const row = state.payments.find((payment) => payment.id === args.where.id);
        if (!row) throw new Error(`payment ${args.where.id} not found`);
        Object.assign(row, args.data);
        return { ...row };
      },
    },
    xeroObjectLink: {
      findMany: async (args: { where: Record<string, unknown> }) =>
        state.links.filter((row) => matchesLinkWhere(row, args.where)).map((row) => ({ ...row })),
      findUnique: async (args: {
        where: {
          localModel_localId_xeroObjectType_xeroObjectId_role?: {
            localModel: string;
            localId: string;
            xeroObjectType: string;
            xeroObjectId: string;
            role: string;
          };
        };
      }) => {
        const key = args.where.localModel_localId_xeroObjectType_xeroObjectId_role;
        if (!key) return null;
        const row = state.links.find(
          (link) =>
            link.localModel === key.localModel &&
            link.localId === key.localId &&
            link.xeroObjectType === key.xeroObjectType &&
            link.xeroObjectId === key.xeroObjectId &&
            link.role === key.role
        );
        return row ? { ...row } : null;
      },
      upsert: async (args: {
        where: {
          localModel_localId_xeroObjectType_xeroObjectId_role: {
            localModel: string;
            localId: string;
            xeroObjectType: string;
            xeroObjectId: string;
            role: string;
          };
        };
        create: Record<string, unknown>;
        update: Record<string, unknown>;
      }) => {
        const key = args.where.localModel_localId_xeroObjectType_xeroObjectId_role;
        const existing = state.links.find(
          (link) =>
            link.localModel === key.localModel &&
            link.localId === key.localId &&
            link.xeroObjectType === key.xeroObjectType &&
            link.xeroObjectId === key.xeroObjectId &&
            link.role === key.role
        );
        if (existing) {
          Object.assign(existing, args.update, { updatedAt: new Date() });
          return { ...existing };
        }
        state.linkIdCounter += 1;
        const created: FakeLinkRow = {
          id: `link_${state.linkIdCounter}`,
          xeroObjectNumber: null,
          xeroObjectUrl: null,
          metadata: null,
          active: true,
          createdAt: new Date(),
          updatedAt: new Date(),
          ...key,
          ...(args.create as Partial<FakeLinkRow>),
        } as FakeLinkRow;
        state.links.push(created);
        return { ...created };
      },
      updateMany: async (args: {
        where: Record<string, unknown>;
        data: Record<string, unknown>;
      }) => {
        const rows = state.links.filter((row) => matchesLinkWhere(row, args.where));
        for (const row of rows) {
          Object.assign(row, args.data, { updatedAt: new Date() });
        }
        return { count: rows.length };
      },
    },
    xeroSyncOperation: {
      findFirst: async (args: {
        where: { localId?: string; xeroObjectId?: string | { not: null } };
      }) => {
        const rows = state.operations
          .filter(
            (row) =>
              (args.where.localId === undefined || row.localId === args.where.localId) &&
              (typeof args.where.xeroObjectId !== "string" ||
                row.xeroObjectId === args.where.xeroObjectId)
          )
          .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
        const row = rows[0];
        return row ? { requestPayload: row.requestPayload, xeroObjectId: row.xeroObjectId, xeroObjectNumber: null } : null;
      },
      // #3635 round 4: the resolved-in-Xero coverage read. No operation in
      // these fixtures is resolved by an officer.
      findMany: async () => [],
    },
    $transaction: async <T>(fn: (tx: unknown) => Promise<T>) => fn(client),
  };
  return client;
});

const outboxMocks = vi.hoisted(() => ({
  enqueueXeroRefundCreditNoteOperation: vi.fn(),
  kickQueuedXeroOutboxOperationsIfConnected: vi.fn(),
}));
const reportCronError = vi.hoisted(() => vi.fn());

vi.mock("@/lib/prisma", () => ({ prisma: fakePrisma }));
vi.mock("@/lib/logger", () => ({
  default: { error: vi.fn(), info: vi.fn(), warn: vi.fn(), debug: vi.fn() },
}));
vi.mock("@/lib/xero", () => ({ isXeroConnected: vi.fn(async () => false) }));
vi.mock("@/lib/orphaned-applied-credit-backfill", () => ({
  findOrphanedAppliedCredits: vi.fn(async () => ({ findings: [] })),
}));
vi.mock("@/lib/xero-operation-outbox", () => outboxMocks);
vi.mock("@/lib/observability-bridge", () => ({ reportCronError }));

import { cleanupStaleCanonicalXeroObjectLinks } from "@/lib/xero-hardening-canonical-links";
import { reconcileCreditBalances } from "@/lib/cron-credit-reconciliation";
import { getRefundsMissingXeroCreditNotes } from "@/lib/xero-admin-health";
import {
  sumCoveredRefundCreditNoteCents,
  upsertXeroObjectLink,
} from "@/lib/xero-sync";

beforeEach(() => {
  vi.clearAllMocks();
  state.linkIdCounter = 0;
  state.links = [];
  state.operations = [];
  state.paymentRefunds = [];
  state.memberCredits = [];
  state.payments = [
    {
      id: "pay_1",
      bookingId: "book_1",
      source: "STRIPE",
      refundedAmountCents: 100,
      xeroInvoiceId: "inv_1",
      xeroRefundCreditNoteId: null,
      // Older than the 24h refund-note grace window against the frozen test
      // clock (2026-07-01T00:00:00Z), so the health check does not skip it.
      updatedAt: new Date("2026-06-01T00:00:00Z"),
      booking: {
        member: { firstName: "Kea", lastName: "Climber", email: "kea@example.test" },
      },
    },
  ];
});

/** The two stepped Stripe refund deltas, written the way the pipeline writes them. */
async function settleBothDeltas() {
  // Delta 1 (90c): a LEGACY-shaped link — no amountCents in metadata, so its
  // contribution must be recovered from the create operation's persisted
  // request payload (allocation.amount in dollars).
  await upsertXeroObjectLink({
    localModel: "Payment",
    localId: "pay_1",
    xeroObjectType: "CREDIT_NOTE",
    xeroObjectId: "cn_90",
    role: "REFUND_CREDIT_NOTE",
  });
  state.operations.push({
    direction: "OUTBOUND",
    entityType: "CREDIT_NOTE",
    operationType: "CREATE",
    localModel: "Payment",
    localId: "pay_1",
    xeroObjectId: "cn_90",
    requestPayload: { allocation: { invoiceId: "inv_1", amount: 0.9 } },
    createdAt: new Date("2026-06-01T01:00:00Z"),
  });
  state.payments[0].xeroRefundCreditNoteId = "cn_90";

  // Delta 2 (10c): the modern shape with per-delta metadata, and the scalar
  // pointer moved to the latest note — exactly what the outbox worker does.
  await upsertXeroObjectLink({
    localModel: "Payment",
    localId: "pay_1",
    xeroObjectType: "CREDIT_NOTE",
    xeroObjectId: "cn_10",
    role: "REFUND_CREDIT_NOTE",
    metadata: { amountCents: 10, watermarkCents: 100 },
  });
  state.payments[0].xeroRefundCreditNoteId = "cn_10";
}

function activeRefundNoteIds() {
  return state.links
    .filter((link) => link.role === "REFUND_CREDIT_NOTE" && link.active)
    .map((link) => link.xeroObjectId)
    .sort();
}

describe("Stripe per-delta refund notes vs canonical cleanup and reconciliation (#2901)", () => {
  it("keeps 90 + 10 = 100 covered and queues nothing across repeated cleanup + reconciliation cycles", async () => {
    await settleBothDeltas();

    // The link writer's normalization must keep both per-delta notes active
    // even though the scalar names only cn_10 (#1162 contract).
    expect(activeRefundNoteIds()).toEqual(["cn_10", "cn_90"]);
    expect(await sumCoveredRefundCreditNoteCents("pay_1")).toBe(100);

    for (let cycle = 0; cycle < 3; cycle += 1) {
      const cleanup = await cleanupStaleCanonicalXeroObjectLinks();
      expect(cleanup.deactivatedLinks).toBe(0);
      expect(cleanup.preservedStripeRefundCreditNoteLinks).toBe(2);
      expect(activeRefundNoteIds()).toEqual(["cn_10", "cn_90"]);

      // Coverage stays exactly the refunded total: 90 (recovered from the
      // create-operation payload) + 10 (recorded metadata) = 100.
      expect(await sumCoveredRefundCreditNoteCents("pay_1")).toBe(100);

      const missing = await getRefundsMissingXeroCreditNotes();
      expect(missing.count).toBe(0);

      const reconciliation = await reconcileCreditBalances();
      expect(reconciliation.refundsMissingXeroCreditNotes).toBe(0);
      expect(outboxMocks.enqueueXeroRefundCreditNoteOperation).not.toHaveBeenCalled();
      expect(outboxMocks.kickQueuedXeroOutboxOperationsIfConnected).not.toHaveBeenCalled();
      expect(reportCronError).not.toHaveBeenCalled();
    }
  });

  it("keeps the per-delta metadata and coverage stable when inbound normalization re-runs between cycles", async () => {
    await settleBothDeltas();

    for (let cycle = 0; cycle < 2; cycle += 1) {
      // Inbound reconcile re-upserts the note link with merge semantics
      // (F4/#1354): the status fields land WITHOUT destroying amountCents.
      await upsertXeroObjectLink({
        localModel: "Payment",
        localId: "pay_1",
        xeroObjectType: "CREDIT_NOTE",
        xeroObjectId: "cn_10",
        role: "REFUND_CREDIT_NOTE",
        metadata: { status: "AUTHORISED", total: 0.1 },
        mergeMetadata: true,
      });

      const cleanup = await cleanupStaleCanonicalXeroObjectLinks();
      expect(cleanup.deactivatedLinks).toBe(0);
      expect(activeRefundNoteIds()).toEqual(["cn_10", "cn_90"]);
      expect(await sumCoveredRefundCreditNoteCents("pay_1")).toBe(100);

      const cn10 = state.links.find((link) => link.xeroObjectId === "cn_10");
      expect(cn10?.metadata).toMatchObject({
        amountCents: 10,
        watermarkCents: 100,
        status: "AUTHORISED",
      });

      await reconcileCreditBalances();
      expect(outboxMocks.enqueueXeroRefundCreditNoteOperation).not.toHaveBeenCalled();
    }
  });

  it("still flags and self-heals a GENUINELY uncovered refund delta (positive control)", async () => {
    // Only the 90c delta ever settled; 10c of the cumulative refund is
    // genuinely uncovered, so the health check and the self-heal must both
    // still fire — the #2901 fix must not blind the detector.
    await upsertXeroObjectLink({
      localModel: "Payment",
      localId: "pay_1",
      xeroObjectType: "CREDIT_NOTE",
      xeroObjectId: "cn_90",
      role: "REFUND_CREDIT_NOTE",
      metadata: { amountCents: 90, watermarkCents: 90 },
    });
    state.payments[0].xeroRefundCreditNoteId = "cn_90";
    outboxMocks.enqueueXeroRefundCreditNoteOperation.mockResolvedValue({
      queueOperationId: "op_selfheal",
    });

    const cleanup = await cleanupStaleCanonicalXeroObjectLinks();
    expect(cleanup.deactivatedLinks).toBe(0);

    const missing = await getRefundsMissingXeroCreditNotes();
    expect(missing.count).toBe(1);
    expect(missing.payments[0]).toMatchObject({
      paymentId: "pay_1",
      refundedAmountCents: 100,
      cashRefundedCents: 100,
      uncoveredCents: 10,
    });

    // #2902: the self-heal asks for the CASH uncovered delta (10), never the
    // full mirror; the enqueue re-caps against cash evidence either way.
    await reconcileCreditBalances();
    expect(outboxMocks.enqueueXeroRefundCreditNoteOperation).toHaveBeenCalledTimes(1);
    expect(outboxMocks.enqueueXeroRefundCreditNoteOperation).toHaveBeenCalledWith(
      "pay_1",
      10
    );
  });

  it("restores the self-heal when a settled note is voided in Xero (#2901 fix round)", async () => {
    await settleBothDeltas();
    expect(await sumCoveredRefundCreditNoteCents("pay_1")).toBe(100);

    // The operator voids cn_10 in Xero; inbound reconciliation re-upserts the
    // link with the live status. The write itself deactivates the mirror
    // (normalize is status-aware), and a VOIDED note counts as nothing in the
    // coverage sum either way — pre-fix, this state kept coverage at 100
    // forever and the member's 10c refund was never re-credited in Xero.
    await upsertXeroObjectLink({
      localModel: "Payment",
      localId: "pay_1",
      xeroObjectType: "CREDIT_NOTE",
      xeroObjectId: "cn_10",
      role: "REFUND_CREDIT_NOTE",
      metadata: { status: "VOIDED", total: 0.1 },
      mergeMetadata: true,
    });

    expect(activeRefundNoteIds()).toEqual(["cn_90"]);
    expect(await sumCoveredRefundCreditNoteCents("pay_1")).toBe(90);

    // The detector now sees the honest 10c shortfall and the daily
    // reconciliation re-enqueues exactly one replacement delta.
    outboxMocks.enqueueXeroRefundCreditNoteOperation.mockResolvedValue({
      queueOperationId: "op_reissue",
    });
    const missing = await getRefundsMissingXeroCreditNotes();
    expect(missing.count).toBe(1);
    expect(missing.payments[0]).toMatchObject({
      paymentId: "pay_1",
      uncoveredCents: 10,
    });
    await reconcileCreditBalances();
    expect(outboxMocks.enqueueXeroRefundCreditNoteOperation).toHaveBeenCalledWith(
      "pay_1",
      10
    );
  });

  it("cleanup deactivates a stamped-VOIDED mirror that is somehow still active (#2901 fix round)", async () => {
    await settleBothDeltas();
    // A row stamped VOIDED while the write-time deactivation did not exist yet
    // (or by a racing writer): still active, status merged.
    const cn10 = state.links.find((link) => link.xeroObjectId === "cn_10");
    expect(cn10).toBeDefined();
    cn10!.metadata = { ...(cn10!.metadata ?? {}), status: "VOIDED" };
    expect(cn10!.active).toBe(true);

    const cleanup = await cleanupStaleCanonicalXeroObjectLinks();

    expect(cleanup.deactivatedLinkIds).toHaveLength(1);
    expect(cleanup.byCategory.paymentRefundCreditNotes).toBe(1);
    expect(activeRefundNoteIds()).toEqual(["cn_90"]);
    expect(await sumCoveredRefundCreditNoteCents("pay_1")).toBe(90);
  });

  it("an account-credit-only cancellation queues NO refund note across repeated reconciliation cycles (#2902 acceptance)", async () => {
    // The anonymised production shape: the cancellation held the whole value
    // as member account credit. applyLocalRefundAllocation moved the mirror
    // (341.00), an ACCOUNT_CREDIT_NOTE documents the credit in Xero, and NO
    // PaymentRefund row exists because no Stripe cash ever moved. Pre-#2902
    // every reconciliation run read the mirror as missing Stripe cash and
    // minted a fictitious REFUND_CREDIT_NOTE plus a Stripe-bank payment.
    state.payments[0].refundedAmountCents = 34100;
    state.memberCredits.push({
      sourceBookingId: "book_1",
      type: "CANCELLATION_REFUND",
      amountCents: 34100,
      restoredFromBookingId: null,
    });
    await upsertXeroObjectLink({
      localModel: "MemberCredit",
      localId: "credit_1",
      xeroObjectType: "CREDIT_NOTE",
      xeroObjectId: "cn_account_credit",
      role: "ACCOUNT_CREDIT_NOTE",
    });

    for (let cycle = 0; cycle < 3; cycle += 1) {
      const missing = await getRefundsMissingXeroCreditNotes();
      expect(missing.count).toBe(0);

      const reconciliation = await reconcileCreditBalances();
      expect(reconciliation.refundsMissingXeroCreditNotes).toBe(0);
      expect(
        outboxMocks.enqueueXeroRefundCreditNoteOperation
      ).not.toHaveBeenCalled();
    }

    // The account-credit document is untouched and no REFUND_CREDIT_NOTE
    // link ever appeared for the payment.
    const accountCreditLink = state.links.find(
      (link) => link.role === "ACCOUNT_CREDIT_NOTE"
    );
    expect(accountCreditLink?.active).toBe(true);
    expect(activeRefundNoteIds()).toEqual([]);
  });

  it("a genuine Stripe refund with provider-ledger evidence self-heals exactly once, summing stepped PaymentRefund rows (#2902 acceptance)", async () => {
    // Modern shape: two stepped Stripe cash refunds (90c + 10c) each recorded
    // a succeeded PaymentRefund row BEFORE its enqueue; only the 90c note
    // ever settled. A failed refund attempt must not count.
    state.paymentRefunds.push(
      { paymentId: "pay_1", status: "succeeded", amountCents: 90 },
      { paymentId: "pay_1", status: "succeeded", amountCents: 10 },
      { paymentId: "pay_1", status: "failed", amountCents: 500 }
    );
    await upsertXeroObjectLink({
      localModel: "Payment",
      localId: "pay_1",
      xeroObjectType: "CREDIT_NOTE",
      xeroObjectId: "cn_90",
      role: "REFUND_CREDIT_NOTE",
      metadata: { amountCents: 90, watermarkCents: 90 },
    });
    state.payments[0].xeroRefundCreditNoteId = "cn_90";
    outboxMocks.enqueueXeroRefundCreditNoteOperation.mockResolvedValue({
      queueOperationId: "op_selfheal",
    });

    const missing = await getRefundsMissingXeroCreditNotes();
    expect(missing.count).toBe(1);
    expect(missing.payments[0]).toMatchObject({
      paymentId: "pay_1",
      refundedAmountCents: 100,
      cashRefundedCents: 100,
      uncoveredCents: 10,
    });

    await reconcileCreditBalances();
    expect(
      outboxMocks.enqueueXeroRefundCreditNoteOperation
    ).toHaveBeenCalledTimes(1);
    expect(outboxMocks.enqueueXeroRefundCreditNoteOperation).toHaveBeenCalledWith(
      "pay_1",
      10
    );

    // The healed note lands; repeat runs flag nothing and queue nothing more —
    // the self-heal fires exactly once.
    await upsertXeroObjectLink({
      localModel: "Payment",
      localId: "pay_1",
      xeroObjectType: "CREDIT_NOTE",
      xeroObjectId: "cn_10",
      role: "REFUND_CREDIT_NOTE",
      metadata: { amountCents: 10, watermarkCents: 100 },
    });
    outboxMocks.enqueueXeroRefundCreditNoteOperation.mockClear();
    for (let cycle = 0; cycle < 3; cycle += 1) {
      const healed = await getRefundsMissingXeroCreditNotes();
      expect(healed.count).toBe(0);
      await reconcileCreditBalances();
      expect(
        outboxMocks.enqueueXeroRefundCreditNoteOperation
      ).not.toHaveBeenCalled();
    }
  });

  it("a mixed cash + account-credit refund flags only the cash remainder (#2902)", async () => {
    // 100c mirror = 60c Stripe cash (ledger row) + 40c account credit. The
    // ledger rows exist, so the provider-ledger rule wins outright and the
    // credit disposition is not even consulted; only 60c of notes are owed.
    state.paymentRefunds.push({
      paymentId: "pay_1",
      status: "succeeded",
      amountCents: 60,
    });
    state.memberCredits.push({
      sourceBookingId: "book_1",
      type: "CANCELLATION_REFUND",
      amountCents: 40,
      restoredFromBookingId: null,
    });
    await upsertXeroObjectLink({
      localModel: "Payment",
      localId: "pay_1",
      xeroObjectType: "CREDIT_NOTE",
      xeroObjectId: "cn_60",
      role: "REFUND_CREDIT_NOTE",
      metadata: { amountCents: 60, watermarkCents: 60 },
    });

    const missing = await getRefundsMissingXeroCreditNotes();
    expect(missing.count).toBe(0);

    await reconcileCreditBalances();
    expect(
      outboxMocks.enqueueXeroRefundCreditNoteOperation
    ).not.toHaveBeenCalled();
  });
});
