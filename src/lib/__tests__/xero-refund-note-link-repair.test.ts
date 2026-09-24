import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * #2901 operator repair (as reshaped by the adversarial fix round):
 *
 * - deactivating the local mirror of a note voided in Xero is UNCONDITIONAL —
 *   it applies even when the plan lands short of the refunded total;
 * - a link whose live Xero status was never recorded locally is NEVER
 *   reactivated (inbound reconciliation cannot stamp statuses onto inactive
 *   links, so "unknown" must be treated as "possibly voided");
 * - a payment with an in-flight outbound CREDIT_NOTE CREATE operation is
 *   refused outright (the executor prices from live coverage);
 * - apply re-sums coverage after its claims inside the transaction and rolls
 *   the payment back on divergence, isolates failures per payment, and
 *   repoints the scalar off a link it just deactivated.
 *
 * Backed by a small stateful in-memory Prisma fake (with transaction rollback
 * on throw) so the guarded updateMany claims run against real row state.
 */

interface FakeLinkRow {
  id: string;
  localModel: string;
  localId: string;
  xeroObjectType: string;
  xeroObjectId: string;
  xeroObjectNumber: string | null;
  role: string;
  active: boolean;
  metadata: Record<string, unknown> | null;
  createdAt: Date;
}

interface FakePaymentRow {
  id: string;
  bookingId: string;
  source: string;
  refundedAmountCents: number;
  xeroInvoiceId: string | null;
  xeroRefundCreditNoteId: string | null;
  createdAt: Date;
}

interface FakeOperationRow {
  id: string;
  direction: string;
  entityType: string;
  operationType: string;
  localModel: string;
  localId: string;
  xeroObjectId: string | null;
  status: string;
  replayable: boolean;
  requestPayload: unknown;
  createdAt: Date;
}

interface FakePaymentRefundRow {
  paymentId: string;
  status: string;
  amountCents: number;
}

interface FakeMemberCreditRow {
  sourceBookingId: string;
  type: string;
  amountCents: number;
  restoredFromBookingId: string | null;
}

const state = vi.hoisted(() => ({
  payments: [] as FakePaymentRow[],
  links: [] as FakeLinkRow[],
  operations: [] as FakeOperationRow[],
  // #2902 cash-evidence inputs. Empty by default: no PaymentRefund ledger rows
  // and no account-credit disposition resolves through the legacy-mirror
  // fallback to cash target === refundedAmountCents, which is exactly the
  // pre-#2902 target every #2901 scenario was written against.
  paymentRefunds: [] as FakePaymentRefundRow[],
  memberCredits: [] as FakeMemberCreditRow[],
}));

const fakePrisma = vi.hoisted(() => {
  const matchesLinkWhere = (
    row: FakeLinkRow,
    where: Record<string, unknown>
  ): boolean => {
    if (where.localModel !== undefined && row.localModel !== where.localModel) return false;
    if (where.localId !== undefined && row.localId !== where.localId) return false;
    if (where.xeroObjectType !== undefined && row.xeroObjectType !== where.xeroObjectType) return false;
    if (where.role !== undefined && row.role !== where.role) return false;
    if (typeof where.active === "boolean" && row.active !== where.active) return false;
    const idFilter = where.id as { in?: string[] } | undefined;
    if (idFilter?.in && !idFilter.in.includes(row.id)) return false;
    return true;
  };

  const client = {
    payment: {
      findMany: async (args: {
        where: {
          source?: string;
          refundedAmountCents?: { gt: number };
          xeroInvoiceId?: { not: null };
          id?: { in: string[] };
        };
      }) =>
        state.payments
          .filter((row) => {
            if (args.where.source && row.source !== args.where.source) return false;
            if (
              args.where.refundedAmountCents &&
              !(row.refundedAmountCents > args.where.refundedAmountCents.gt)
            ) {
              return false;
            }
            if (args.where.xeroInvoiceId && row.xeroInvoiceId === null) return false;
            if (args.where.id?.in && !args.where.id.in.includes(row.id)) return false;
            return true;
          })
          .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime())
          .map((row) => ({
            id: row.id,
            bookingId: row.bookingId,
            refundedAmountCents: row.refundedAmountCents,
          })),
      findUnique: async (args: { where: { id: string } }) => {
        const row = state.payments.find((payment) => payment.id === args.where.id);
        if (!row) return null;
        return {
          id: row.id,
          bookingId: row.bookingId,
          source: row.source,
          refundedAmountCents: row.refundedAmountCents,
          xeroRefundCreditNoteId: row.xeroRefundCreditNoteId,
        };
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
      findMany: async (args: {
        where: Record<string, unknown>;
        orderBy?: unknown;
        take?: number;
      }) => {
        let rows = state.links.filter((row) => matchesLinkWhere(row, args.where));
        if (args.orderBy) {
          // The scalar-repoint query orders createdAt desc, id desc.
          rows = [...rows].sort(
            (a, b) =>
              b.createdAt.getTime() - a.createdAt.getTime() ||
              b.id.localeCompare(a.id)
          );
        }
        if (typeof args.take === "number") {
          rows = rows.slice(0, args.take);
        }
        return rows.map((row) => ({
          id: row.id,
          xeroObjectId: row.xeroObjectId,
          xeroObjectNumber: row.xeroObjectNumber,
          active: row.active,
          metadata: row.metadata,
          createdAt: row.createdAt,
        }));
      },
      updateMany: async (args: {
        where: Record<string, unknown>;
        data: { active: boolean };
      }) => {
        const rows = state.links.filter((row) => matchesLinkWhere(row, args.where));
        for (const row of rows) {
          row.active = args.data.active;
        }
        return { count: rows.length };
      },
    },
    paymentRefund: {
      // Mirrors resolveStripeCashRefundEvidence's groupBy(["status"]) shape.
      groupBy: async (args: {
        by: string[];
        where: { paymentId: string };
      }) => {
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
    },
    memberCredit: {
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
    xeroSyncOperation: {
      findFirst: async (args: {
        where: {
          localId?: string;
          xeroObjectId?: string;
          status?: { in: string[] };
          entityType?: string;
          operationType?: string;
          direction?: string;
          OR?: Array<{
            operationType?: string;
            status?: { in: string[] };
            replayable?: boolean;
          }>;
        };
      }) => {
        const matchesBranch = (
          row: FakeOperationRow,
          branch: {
            operationType?: string;
            status?: { in: string[] };
            replayable?: boolean;
          }
        ) => {
          if (branch.operationType !== undefined && row.operationType !== branch.operationType) return false;
          if (branch.status?.in && !branch.status.in.includes(row.status)) return false;
          if (branch.replayable !== undefined && row.replayable !== branch.replayable) return false;
          return true;
        };
        const matches = state.operations
          .filter((row) => {
            if (args.where.localId !== undefined && row.localId !== args.where.localId) return false;
            if (args.where.xeroObjectId !== undefined && row.xeroObjectId !== args.where.xeroObjectId) return false;
            if (args.where.entityType !== undefined && row.entityType !== args.where.entityType) return false;
            if (args.where.operationType !== undefined && row.operationType !== args.where.operationType) return false;
            if (args.where.direction !== undefined && row.direction !== args.where.direction) return false;
            if (args.where.status?.in && !args.where.status.in.includes(row.status)) return false;
            if (args.where.OR && !args.where.OR.some((branch) => matchesBranch(row, branch))) return false;
            return true;
          })
          .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
        const row = matches[0];
        return row ? { id: row.id, requestPayload: row.requestPayload } : null;
      },
    },
    $transaction: async <T>(fn: (tx: unknown) => Promise<T>) => {
      // Rollback fidelity: snapshot mutable state and restore it on throw, so
      // the in-transaction guards genuinely undo their claims in these tests.
      const paymentsSnapshot = state.payments.map((row) => ({ ...row }));
      const linksSnapshot = state.links.map((row) => ({
        ...row,
        metadata: row.metadata ? { ...row.metadata } : row.metadata,
      }));
      try {
        return await fn(client);
      } catch (error) {
        state.payments = paymentsSnapshot;
        state.links = linksSnapshot;
        throw error;
      }
    },
  };
  return client;
});

vi.mock("@/lib/prisma", () => ({ prisma: fakePrisma }));
vi.mock("@/lib/logger", () => ({
  default: { error: vi.fn(), info: vi.fn(), warn: vi.fn(), debug: vi.fn() },
}));

import {
  applyStripeRefundNoteLinkRepairs,
  findStripeRefundNoteLinkRepairs,
  formatStripeRefundNoteLinkRepairReport,
} from "@/lib/xero-refund-note-link-repair";
import { CLUB_FORMAT_TEST } from "./support/club-format-fixture";

let nextId = 0;
function makeLink(overrides: Partial<FakeLinkRow>): FakeLinkRow {
  nextId += 1;
  return {
    id: `link_${nextId}`,
    localModel: "Payment",
    localId: "pay_1",
    xeroObjectType: "CREDIT_NOTE",
    xeroObjectId: `cn_${nextId}`,
    xeroObjectNumber: null,
    role: "REFUND_CREDIT_NOTE",
    active: false,
    metadata: null,
    createdAt: new Date(`2026-05-0${Math.min(9, nextId)}T00:00:00Z`),
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  nextId = 0;
  state.payments = [
    {
      id: "pay_1",
      bookingId: "book_1",
      source: "STRIPE",
      refundedAmountCents: 100,
      xeroInvoiceId: "inv_1",
      xeroRefundCreditNoteId: null,
      createdAt: new Date("2026-05-01T00:00:00Z"),
    },
  ];
  state.links = [];
  state.operations = [];
  state.paymentRefunds = [];
  state.memberCredits = [];
});

describe("findStripeRefundNoteLinkRepairs", () => {
  it("plans reactivation of the wrongly deactivated per-delta links, oldest first, to exactly the refunded total", async () => {
    state.links = [
      makeLink({
        id: "link_90",
        xeroObjectId: "cn_90",
        active: false,
        metadata: { amountCents: 90, status: "AUTHORISED" },
        createdAt: new Date("2026-05-01T00:00:00Z"),
      }),
      makeLink({
        id: "link_10",
        xeroObjectId: "cn_10",
        active: true,
        metadata: { amountCents: 10 },
        createdAt: new Date("2026-05-02T00:00:00Z"),
      }),
    ];

    const report = await findStripeRefundNoteLinkRepairs(CLUB_FORMAT_TEST);

    expect(report.scannedPayments).toBe(1);
    expect(report.plans).toHaveLength(1);
    const plan = report.plans[0];
    expect(plan).toMatchObject({
      paymentId: "pay_1",
      refundedAmountCents: 100,
      coverageTargetCents: 100,
      activeCoveredCents: 10,
      plannedCoveredCents: 100,
      repairable: true,
      manualReviewReason: null,
      blockedByPendingOperation: false,
      reactivateLinkIds: ["link_90"],
      deactivateLinkIds: [],
    });
  });

  it("recovers a legacy link's amount from the persisted create-operation payload once its status is recorded", async () => {
    state.links = [
      makeLink({
        id: "link_legacy_90",
        xeroObjectId: "cn_legacy",
        active: false,
        // Pre-#1162 links carried no amountCents; the status recorder merged
        // the live status in, and the amount comes from the create payload.
        metadata: { status: "AUTHORISED" },
      }),
      makeLink({
        id: "link_10",
        xeroObjectId: "cn_10",
        active: true,
        metadata: { amountCents: 10 },
      }),
    ];
    state.operations = [
      {
        id: "op_1",
        direction: "OUTBOUND",
        entityType: "CREDIT_NOTE",
        operationType: "CREATE",
        localModel: "Payment",
        localId: "pay_1",
        xeroObjectId: "cn_legacy",
        status: "SUCCEEDED",
        replayable: true,
        requestPayload: { allocation: { amount: 0.9 } }, // dollars
        createdAt: new Date("2026-05-01T00:00:00Z"),
      },
    ];

    const report = await findStripeRefundNoteLinkRepairs(CLUB_FORMAT_TEST);

    const plan = report.plans[0];
    expect(plan?.repairable).toBe(true);
    expect(plan?.reactivateLinkIds).toEqual(["link_legacy_90"]);
    const legacy = plan?.links.find((link) => link.linkId === "link_legacy_90");
    expect(legacy?.amountCents).toBe(90);
  });

  it("never reactivates a link whose live Xero status was never recorded, and says so per link", async () => {
    state.links = [
      makeLink({
        id: "link_unknown_90",
        xeroObjectId: "cn_unknown",
        active: false,
        // Amount recorded, status never recorded: inbound reconciliation
        // cannot stamp statuses onto inactive links, so this note could be
        // voided in Xero and must be refused until --record-statuses runs.
        metadata: { amountCents: 90 },
        createdAt: new Date("2026-05-01T00:00:00Z"),
      }),
      makeLink({
        id: "link_10",
        xeroObjectId: "cn_10",
        active: true,
        metadata: { amountCents: 10 },
        createdAt: new Date("2026-05-02T00:00:00Z"),
      }),
    ];

    const report = await findStripeRefundNoteLinkRepairs(CLUB_FORMAT_TEST);

    const plan = report.plans[0];
    expect(plan?.repairable).toBe(false);
    expect(plan?.reactivateLinkIds).toEqual([]);
    const unknown = plan?.links.find((link) => link.linkId === "link_unknown_90");
    expect(unknown?.plannedAction).toBe("leave-inactive");
    expect(unknown?.reason).toContain("--record-statuses");
    // The unknown status renders visibly, never as if it were fine.
    const text = formatStripeRefundNoteLinkRepairReport(report);
    expect(text).toContain("status unknown");
  });

  it("never reactivates voided, amount-less, or over-covering links, and reports the shortfall honestly", async () => {
    state.links = [
      makeLink({
        id: "link_voided",
        xeroObjectId: "cn_voided",
        active: false,
        metadata: { amountCents: 90, status: "VOIDED" },
        createdAt: new Date("2026-05-01T00:00:00Z"),
      }),
      makeLink({
        id: "link_no_amount",
        xeroObjectId: "cn_mystery",
        active: false,
        metadata: { status: "AUTHORISED" },
        createdAt: new Date("2026-05-02T00:00:00Z"),
      }),
      makeLink({
        id: "link_too_big",
        xeroObjectId: "cn_big",
        active: false,
        metadata: { amountCents: 95, status: "AUTHORISED" },
        createdAt: new Date("2026-05-03T00:00:00Z"),
      }),
      makeLink({
        id: "link_10",
        xeroObjectId: "cn_10",
        active: true,
        metadata: { amountCents: 10 },
        createdAt: new Date("2026-05-04T00:00:00Z"),
      }),
    ];

    const report = await findStripeRefundNoteLinkRepairs(CLUB_FORMAT_TEST);

    const plan = report.plans[0];
    expect(plan?.repairable).toBe(false);
    expect(plan?.reactivateLinkIds).toEqual([]);
    // The shortfall message must NOT tell the operator to void more notes —
    // that was the pre-fix defect. It points at status recording / self-heal.
    expect(plan?.manualReviewReason).toContain(
      "short of the provider-backed cash refund target"
    );
    expect(plan?.manualReviewReason).not.toContain("void");
    expect(
      plan?.links.find((link) => link.linkId === "link_voided")?.plannedAction
    ).toBe("leave-inactive");
    expect(
      plan?.links.find((link) => link.linkId === "link_no_amount")?.plannedAction
    ).toBe("leave-inactive");
    expect(
      plan?.links.find((link) => link.linkId === "link_too_big")?.plannedAction
    ).toBe("leave-inactive");
  });

  it("plans deactivation of an active voided-note mirror INDEPENDENTLY of whether the gap can be refilled", async () => {
    // The case that used to be refused: the voided note leaves a shortfall
    // and no inactive sibling fills it. Deactivation must still apply — the
    // phantom coverage is what suppresses the self-heal.
    state.links = [
      makeLink({
        id: "link_90_voided",
        xeroObjectId: "cn_90_voided",
        active: true,
        metadata: { amountCents: 90, status: "VOIDED" },
        createdAt: new Date("2026-05-01T00:00:00Z"),
      }),
      makeLink({
        id: "link_10",
        xeroObjectId: "cn_10",
        active: true,
        metadata: { amountCents: 10 },
        createdAt: new Date("2026-05-02T00:00:00Z"),
      }),
    ];

    const report = await findStripeRefundNoteLinkRepairs(CLUB_FORMAT_TEST);

    const plan = report.plans[0];
    expect(plan).toMatchObject({
      repairable: true,
      deactivateLinkIds: ["link_90_voided"],
      reactivateLinkIds: [],
      plannedCoveredCents: 10,
    });
    expect(plan?.manualReviewReason).toContain("self-heal");
  });

  it("plans deactivation of a voided mirror and replaces its coverage from a recorded inactive sibling", async () => {
    state.links = [
      makeLink({
        id: "link_90_good",
        xeroObjectId: "cn_90_good",
        active: false,
        metadata: { amountCents: 90, status: "AUTHORISED" },
        createdAt: new Date("2026-05-01T00:00:00Z"),
      }),
      makeLink({
        id: "link_90_voided",
        xeroObjectId: "cn_90_voided",
        active: true,
        metadata: { amountCents: 90, status: "VOIDED" },
        createdAt: new Date("2026-05-02T00:00:00Z"),
      }),
      makeLink({
        id: "link_10",
        xeroObjectId: "cn_10",
        active: true,
        metadata: { amountCents: 10 },
        createdAt: new Date("2026-05-03T00:00:00Z"),
      }),
    ];

    const report = await findStripeRefundNoteLinkRepairs(CLUB_FORMAT_TEST);

    const plan = report.plans[0];
    expect(plan).toMatchObject({
      repairable: true,
      deactivateLinkIds: ["link_90_voided"],
      reactivateLinkIds: ["link_90_good"],
      plannedCoveredCents: 100,
      manualReviewReason: null,
    });
  });

  it("refuses the whole payment while a refund credit-note operation is queued or running", async () => {
    state.links = [
      makeLink({
        id: "link_90",
        xeroObjectId: "cn_90",
        active: false,
        metadata: { amountCents: 90, status: "AUTHORISED" },
      }),
      makeLink({
        id: "link_10",
        xeroObjectId: "cn_10",
        active: true,
        metadata: { amountCents: 10 },
      }),
    ];
    state.operations = [
      {
        id: "op_pending",
        direction: "OUTBOUND",
        entityType: "CREDIT_NOTE",
        operationType: "CREATE",
        localModel: "Payment",
        localId: "pay_1",
        xeroObjectId: null,
        status: "PENDING",
        replayable: true,
        requestPayload: { refundAmountCents: 90 },
        createdAt: new Date("2026-05-05T00:00:00Z"),
      },
    ];

    const report = await findStripeRefundNoteLinkRepairs(CLUB_FORMAT_TEST);

    const plan = report.plans[0];
    expect(plan?.blockedByPendingOperation).toBe(true);
    expect(plan?.repairable).toBe(false);
    expect(plan?.reactivateLinkIds).toEqual([]);
    expect(plan?.deactivateLinkIds).toEqual([]);
    expect(plan?.manualReviewReason).toContain("op_pending");
    expect(plan?.manualReviewReason).toContain("could still execute");

    const apply = await applyStripeRefundNoteLinkRepairs(CLUB_FORMAT_TEST);
    expect(apply.appliedPayments).toBe(0);
    expect(state.links.find((link) => link.id === "link_90")?.active).toBe(false);
  });

  it("refuses the whole payment while a REQUEUE of a credit-note operation is queued for the retry drain (#2901 verify round)", async () => {
    state.links = [
      makeLink({
        id: "link_90",
        xeroObjectId: "cn_90",
        active: false,
        metadata: { amountCents: 90, status: "AUTHORISED" },
      }),
      makeLink({
        id: "link_10",
        xeroObjectId: "cn_10",
        active: true,
        metadata: { amountCents: 10 },
      }),
    ];
    state.operations = [
      // The original CREATE ended SUCCEEDED long ago — on its own it never
      // blocks (pinned by the legacy-payload test above).
      {
        id: "op_done",
        direction: "OUTBOUND",
        entityType: "CREDIT_NOTE",
        operationType: "CREATE",
        localModel: "Payment",
        localId: "pay_1",
        xeroObjectId: "cn_10",
        status: "SUCCEEDED",
        replayable: true,
        requestPayload: { allocation: { amount: 0.1 } },
        createdAt: new Date("2026-05-02T00:00:00Z"),
      },
      // ...but an admin queued a background retry: the drain will execute the
      // original via retryXeroSyncOperation -> createXeroCreditNote while
      // neither row is a PENDING/RUNNING CREATE. operationType REQUEUE with
      // the original's entityType/localModel/localId, exactly as
      // queueXeroOperationRetry writes it (xero-operation-queue.ts).
      {
        id: "op_requeue",
        direction: "OUTBOUND",
        entityType: "CREDIT_NOTE",
        operationType: "REQUEUE",
        localModel: "Payment",
        localId: "pay_1",
        xeroObjectId: null,
        status: "PENDING",
        // Requeue rows are created replayable:false (xero-operation-queue.ts)
        // and must STILL block — the replayable filter is scoped to the
        // FAILED/PARTIAL CREATE branch, never the whole predicate.
        replayable: false,
        requestPayload: { originalOperationId: "op_failed_elsewhere" },
        createdAt: new Date("2026-05-05T00:00:00Z"),
      },
    ];

    const report = await findStripeRefundNoteLinkRepairs(CLUB_FORMAT_TEST);

    const plan = report.plans[0];
    expect(plan?.blockedByPendingOperation).toBe(true);
    expect(plan?.repairable).toBe(false);
    expect(plan?.reactivateLinkIds).toEqual([]);
    expect(plan?.manualReviewReason).toContain("op_requeue");

    const apply = await applyStripeRefundNoteLinkRepairs(CLUB_FORMAT_TEST);
    expect(apply.appliedPayments).toBe(0);
    expect(state.links.find((link) => link.id === "link_90")?.active).toBe(false);
  });

  it("refuses the whole payment while a FAILED or PARTIAL credit-note CREATE could still be retried (#2901 verify round)", async () => {
    state.payments.push({
      id: "pay_2",
      bookingId: "book_2",
      source: "STRIPE",
      refundedAmountCents: 100,
      xeroInvoiceId: "inv_2",
      xeroRefundCreditNoteId: null,
      createdAt: new Date("2026-05-01T00:00:00Z"),
    });
    state.links = [
      makeLink({
        id: "link_90",
        xeroObjectId: "cn_90",
        active: false,
        metadata: { amountCents: 90, status: "AUTHORISED" },
      }),
      makeLink({
        id: "link_10",
        xeroObjectId: "cn_10",
        active: true,
        metadata: { amountCents: 10 },
      }),
      makeLink({
        id: "link_2_90",
        localId: "pay_2",
        xeroObjectId: "cn_2_90",
        active: false,
        metadata: { amountCents: 90, status: "AUTHORISED" },
      }),
      makeLink({
        id: "link_2_10",
        localId: "pay_2",
        xeroObjectId: "cn_2_10",
        active: true,
        metadata: { amountCents: 10 },
      }),
    ];
    state.operations = [
      // The manual retry executes createXeroCreditNote with NO claim-first
      // status flip (xero-operation-retry.ts credit-note branch), so the row
      // reads FAILED throughout its provider call; it is also exactly what
      // the requeue screen accepts. Both must block.
      {
        id: "op_failed",
        direction: "OUTBOUND",
        entityType: "CREDIT_NOTE",
        operationType: "CREATE",
        localModel: "Payment",
        localId: "pay_1",
        xeroObjectId: null,
        status: "FAILED",
        replayable: true,
        requestPayload: { refundAmountCents: 90 },
        createdAt: new Date("2026-05-05T00:00:00Z"),
      },
      {
        id: "op_partial",
        direction: "OUTBOUND",
        entityType: "CREDIT_NOTE",
        operationType: "CREATE",
        localModel: "Payment",
        localId: "pay_2",
        xeroObjectId: null,
        status: "PARTIAL",
        replayable: true,
        requestPayload: { refundAmountCents: 90 },
        createdAt: new Date("2026-05-05T00:00:00Z"),
      },
    ];

    const report = await findStripeRefundNoteLinkRepairs(CLUB_FORMAT_TEST);

    expect(report.plans).toHaveLength(2);
    for (const [paymentId, operationId] of [
      ["pay_1", "op_failed"],
      ["pay_2", "op_partial"],
    ] as const) {
      const plan = report.plans.find((entry) => entry.paymentId === paymentId);
      expect(plan?.blockedByPendingOperation).toBe(true);
      expect(plan?.repairable).toBe(false);
      expect(plan?.reactivateLinkIds).toEqual([]);
      expect(plan?.manualReviewReason).toContain(operationId);
    }

    const apply = await applyStripeRefundNoteLinkRepairs(CLUB_FORMAT_TEST);
    expect(apply.appliedPayments).toBe(0);
    expect(state.links.find((link) => link.id === "link_90")?.active).toBe(false);
    expect(state.links.find((link) => link.id === "link_2_90")?.active).toBe(false);
  });

  it("does not block on a FAILED credit-note CREATE an operator marked non-replayable (#2901 verify round)", async () => {
    // The trap this pins: delta 1's note SUCCEEDED but its link was damaged
    // by the pre-fix cleanup (exactly what this tool repairs), while delta
    // 2's CREATE FAILED and the operator marked it non-replayable. A
    // non-replayable row is terminally dead — getXeroOperationRetryMeta
    // refuses it before anything else, and no operator action ever moves it
    // out of FAILED — so blocking on it would fence this payment's repair
    // forever.
    state.links = [
      makeLink({
        id: "link_90",
        xeroObjectId: "cn_90",
        active: false,
        metadata: { amountCents: 90, status: "AUTHORISED" },
      }),
      makeLink({
        id: "link_10",
        xeroObjectId: "cn_10",
        active: true,
        metadata: { amountCents: 10 },
      }),
    ];
    state.operations = [
      {
        id: "op_dead",
        direction: "OUTBOUND",
        entityType: "CREDIT_NOTE",
        operationType: "CREATE",
        localModel: "Payment",
        localId: "pay_1",
        xeroObjectId: null,
        status: "FAILED",
        replayable: false,
        requestPayload: { refundAmountCents: 90 },
        createdAt: new Date("2026-05-05T00:00:00Z"),
      },
    ];

    const report = await findStripeRefundNoteLinkRepairs(CLUB_FORMAT_TEST);

    const plan = report.plans[0];
    expect(plan?.blockedByPendingOperation).toBe(false);
    expect(plan?.repairable).toBe(true);
    expect(plan?.reactivateLinkIds).toEqual(["link_90"]);

    const apply = await applyStripeRefundNoteLinkRepairs(CLUB_FORMAT_TEST);
    expect(apply.appliedPayments).toBe(1);
    expect(state.links.find((link) => link.id === "link_90")?.active).toBe(true);
  });

  it("does not report healthy payments, non-Stripe payments, never-invoiced payments, or unrelated links", async () => {
    state.payments.push(
      {
        id: "pay_ib",
        bookingId: "book_ib",
        source: "INTERNET_BANKING",
        refundedAmountCents: 100,
        xeroInvoiceId: "inv_ib",
        xeroRefundCreditNoteId: null,
        createdAt: new Date("2026-05-01T00:00:00Z"),
      },
      {
        // A Stripe payment never invoiced in Xero expects no credit note —
        // scanning it produced unbounded manual-review noise (#2901 review).
        id: "pay_no_invoice",
        bookingId: "book_no_invoice",
        source: "STRIPE",
        refundedAmountCents: 100,
        xeroInvoiceId: null,
        xeroRefundCreditNoteId: null,
        createdAt: new Date("2026-05-01T00:00:00Z"),
      }
    );
    state.links = [
      makeLink({
        id: "link_100",
        xeroObjectId: "cn_100",
        active: true,
        metadata: { amountCents: 100 },
      }),
      // Unrelated roles/types on the same payment must never enter a plan.
      makeLink({
        id: "link_account_credit",
        xeroObjectId: "cn_acct",
        role: "ACCOUNT_CREDIT_NOTE",
        active: false,
        metadata: { amountCents: 40 },
      }),
      makeLink({
        id: "link_invoice",
        xeroObjectId: "inv_1",
        xeroObjectType: "INVOICE",
        role: "PRIMARY_INVOICE",
        active: false,
      }),
      // A damaged link on the non-Stripe payment is out of scope here.
      makeLink({
        id: "link_ib",
        localId: "pay_ib",
        xeroObjectId: "cn_ib",
        active: false,
        metadata: { amountCents: 100, status: "AUTHORISED" },
      }),
    ];

    const report = await findStripeRefundNoteLinkRepairs(CLUB_FORMAT_TEST);

    expect(report.scannedPayments).toBe(1);
    expect(report.plans).toEqual([]);
  });
});

describe("applyStripeRefundNoteLinkRepairs", () => {
  it("applies the repairable plan with guarded claims and is idempotent on a second run", async () => {
    state.links = [
      makeLink({
        id: "link_90",
        xeroObjectId: "cn_90",
        active: false,
        metadata: { amountCents: 90, status: "AUTHORISED" },
        createdAt: new Date("2026-05-01T00:00:00Z"),
      }),
      makeLink({
        id: "link_90_voided",
        xeroObjectId: "cn_90_voided",
        active: true,
        metadata: { amountCents: 90, status: "VOIDED" },
        createdAt: new Date("2026-05-02T00:00:00Z"),
      }),
      makeLink({
        id: "link_10",
        xeroObjectId: "cn_10",
        active: true,
        metadata: { amountCents: 10 },
        createdAt: new Date("2026-05-03T00:00:00Z"),
      }),
    ];

    const first = await applyStripeRefundNoteLinkRepairs(CLUB_FORMAT_TEST);

    expect(first.appliedPayments).toBe(1);
    expect(first.reactivatedLinks).toBe(1);
    expect(first.deactivatedLinks).toBe(1);
    expect(first.skippedPayments).toEqual([]);
    expect(state.links.find((link) => link.id === "link_90")?.active).toBe(true);
    expect(state.links.find((link) => link.id === "link_90_voided")?.active).toBe(false);
    expect(state.links.find((link) => link.id === "link_10")?.active).toBe(true);

    const second = await applyStripeRefundNoteLinkRepairs(CLUB_FORMAT_TEST);

    expect(second.report.plans).toEqual([]);
    expect(second.appliedPayments).toBe(0);
    expect(second.reactivatedLinks).toBe(0);
    expect(second.deactivatedLinks).toBe(0);
  });

  it("applies a deactivate-only plan on a shortfall, leaving the self-heal to reissue the remainder", async () => {
    state.links = [
      makeLink({
        id: "link_90_voided",
        xeroObjectId: "cn_90_voided",
        active: true,
        metadata: { amountCents: 90, status: "VOIDED" },
        createdAt: new Date("2026-05-01T00:00:00Z"),
      }),
      makeLink({
        id: "link_10",
        xeroObjectId: "cn_10",
        active: true,
        metadata: { amountCents: 10 },
        createdAt: new Date("2026-05-02T00:00:00Z"),
      }),
    ];

    const result = await applyStripeRefundNoteLinkRepairs(CLUB_FORMAT_TEST);

    expect(result.appliedPayments).toBe(1);
    expect(result.deactivatedLinks).toBe(1);
    expect(result.reactivatedLinks).toBe(0);
    expect(state.links.find((link) => link.id === "link_90_voided")?.active).toBe(false);
    // Coverage is now honestly 10 of 100; the daily self-heal detector
    // (`getRefundsMissingXeroCreditNotes`) owns the remainder from here.
  });

  it("repoints the payment scalar off a link it just deactivated", async () => {
    state.payments[0]!.xeroRefundCreditNoteId = "cn_90_voided";
    state.links = [
      makeLink({
        id: "link_10",
        xeroObjectId: "cn_10",
        active: true,
        metadata: { amountCents: 10 },
        createdAt: new Date("2026-05-01T00:00:00Z"),
      }),
      makeLink({
        id: "link_90_voided",
        xeroObjectId: "cn_90_voided",
        active: true,
        metadata: { amountCents: 90, status: "VOIDED" },
        createdAt: new Date("2026-05-02T00:00:00Z"),
      }),
    ];

    const result = await applyStripeRefundNoteLinkRepairs(CLUB_FORMAT_TEST);

    expect(result.appliedPayments).toBe(1);
    // The scalar now names the newest remaining ACTIVE note, so the report's
    // "missing active link for the scalar-pointed note" class cannot become
    // permanent drift, and inbound cannot resolve the voided note through the
    // scalar and reactivate it.
    expect(state.payments[0]!.xeroRefundCreditNoteId).toBe("cn_10");
  });

  it("clears the scalar when deactivation leaves no active note", async () => {
    state.payments[0]!.xeroRefundCreditNoteId = "cn_90_voided";
    state.links = [
      makeLink({
        id: "link_90_voided",
        xeroObjectId: "cn_90_voided",
        active: true,
        metadata: { amountCents: 90, status: "VOIDED" },
      }),
    ];

    const result = await applyStripeRefundNoteLinkRepairs(CLUB_FORMAT_TEST);

    expect(result.appliedPayments).toBe(1);
    expect(state.payments[0]!.xeroRefundCreditNoteId).toBeNull();
  });

  it("skips a payment whose link state changed between the dry-run plan and the transaction snapshot", async () => {
    state.links = [
      makeLink({
        id: "link_90",
        xeroObjectId: "cn_90",
        active: false,
        metadata: { amountCents: 90, status: "AUTHORISED" },
        createdAt: new Date("2026-05-01T00:00:00Z"),
      }),
      makeLink({
        id: "link_10",
        xeroObjectId: "cn_10",
        active: true,
        metadata: { amountCents: 10 },
        createdAt: new Date("2026-05-02T00:00:00Z"),
      }),
    ];

    // Concurrent writer flips link_90 active after the dry-run read: simulate
    // by intercepting the in-transaction payment re-read.
    const originalFindUnique = fakePrisma.payment.findUnique;
    const findUniqueSpy = vi
      .spyOn(fakePrisma.payment, "findUnique")
      .mockImplementation(async (args) => {
        const link = state.links.find((row) => row.id === "link_90");
        if (link) {
          link.active = true;
        }
        return originalFindUnique(args);
      });

    const result = await applyStripeRefundNoteLinkRepairs(CLUB_FORMAT_TEST);

    findUniqueSpy.mockRestore();
    expect(result.appliedPayments).toBe(0);
    expect(result.skippedPayments).toHaveLength(1);
    expect(result.skippedPayments[0]?.paymentId).toBe("pay_1");
    // The concurrent activation of link_90 completed the coverage itself, so
    // the fresh in-transaction plan has nothing to do and the apply declines.
    expect(state.links.filter((row) => row.active)).toHaveLength(2);
  });

  it("rolls the payment back when a link committed by a concurrent writer breaks the coverage promise, and still processes the rest of the run", async () => {
    state.payments.push({
      id: "pay_2",
      bookingId: "book_2",
      source: "STRIPE",
      refundedAmountCents: 50,
      xeroInvoiceId: "inv_2",
      xeroRefundCreditNoteId: null,
      createdAt: new Date("2026-05-02T00:00:00Z"),
    });
    state.links = [
      makeLink({
        id: "link_90",
        xeroObjectId: "cn_90",
        active: false,
        metadata: { amountCents: 90, status: "AUTHORISED" },
        createdAt: new Date("2026-05-01T00:00:00Z"),
      }),
      makeLink({
        id: "link_10",
        xeroObjectId: "cn_10",
        active: true,
        metadata: { amountCents: 10 },
        createdAt: new Date("2026-05-02T00:00:00Z"),
      }),
      makeLink({
        id: "link_p2_50",
        localId: "pay_2",
        xeroObjectId: "cn_p2_50",
        active: false,
        metadata: { amountCents: 50, status: "AUTHORISED" },
        createdAt: new Date("2026-05-03T00:00:00Z"),
      }),
    ];

    // Simulate the outbox executor committing a NEW active 90c note for pay_1
    // between the in-transaction re-plan and the claims: hook the claim
    // updateMany to inject the row the executor would have written.
    const originalUpdateMany = fakePrisma.xeroObjectLink.updateMany;
    let injected = false;
    const updateManySpy = vi
      .spyOn(fakePrisma.xeroObjectLink, "updateMany")
      .mockImplementation(async (args) => {
        const result = await originalUpdateMany(args);
        if (!injected) {
          injected = true;
          state.links.push(
            makeLink({
              id: "link_executor_new",
              xeroObjectId: "cn_executor_new",
              active: true,
              metadata: { amountCents: 90, watermarkCents: 100 },
              createdAt: new Date("2026-05-09T00:00:00Z"),
            })
          );
        }
        return result;
      });

    const result = await applyStripeRefundNoteLinkRepairs(CLUB_FORMAT_TEST);

    updateManySpy.mockRestore();
    // pay_1 rolled back: the post-claim re-sum found 190 !== 100.
    const pay1Skip = result.skippedPayments.find(
      (skip) => skip.paymentId === "pay_1"
    );
    expect(pay1Skip?.reason).toContain("Coverage verification");
    // The rollback undid the claim: link_90 is inactive again.
    expect(state.links.find((link) => link.id === "link_90")?.active).toBe(false);
    // Per-payment isolation: pay_2 still applied cleanly.
    expect(result.appliedPayments).toBe(1);
    expect(state.links.find((link) => link.id === "link_p2_50")?.active).toBe(true);
  });

  it("reports over-covered payments for manual review and applies nothing", async () => {
    state.links = [
      makeLink({
        id: "link_90_a",
        xeroObjectId: "cn_90_a",
        active: true,
        metadata: { amountCents: 90 },
      }),
      makeLink({
        id: "link_90_b",
        xeroObjectId: "cn_90_b",
        active: true,
        metadata: { amountCents: 90 },
      }),
      makeLink({
        id: "link_10",
        xeroObjectId: "cn_10",
        active: true,
        metadata: { amountCents: 10 },
      }),
    ];

    const result = await applyStripeRefundNoteLinkRepairs(CLUB_FORMAT_TEST);

    expect(result.appliedPayments).toBe(0);
    expect(result.skippedPayments).toHaveLength(1);
    expect(result.skippedPayments[0]?.reason).toContain(
      "void the surplus duplicates THERE"
    );
    expect(state.links.every((row) => row.active)).toBe(true);
  });
});

describe("formatStripeRefundNoteLinkRepairReport", () => {
  it("renders a per-payment, per-link plain-text plan with visible statuses", async () => {
    state.links = [
      makeLink({
        id: "link_90",
        xeroObjectId: "cn_90",
        xeroObjectNumber: "CN-0090",
        active: false,
        metadata: { amountCents: 90, status: "AUTHORISED" },
      }),
      makeLink({
        id: "link_10",
        xeroObjectId: "cn_10",
        active: true,
        metadata: { amountCents: 10 },
      }),
    ];

    const report = await findStripeRefundNoteLinkRepairs(CLUB_FORMAT_TEST);
    const text = formatStripeRefundNoteLinkRepairReport(report);

    expect(text).toContain("1 need repair or review");
    expect(text).toContain("Payment pay_1 (booking book_1)");
    expect(text).toContain("REPAIRABLE");
    expect(text).toContain("[reactivate] note CN-0090 (inactive, AUTHORISED, 0.90)");
    // A never-recorded status renders as "status unknown", never as fine.
    expect(text).toContain("[keep-active] note cn_10 (active, status unknown, 0.10)");
    // #2902: the operator sees both figures and which rule produced the target.
    expect(text).toContain(
      "refunded mirror 1.00, cash refund-note target 1.00 (legacy-mirror)"
    );
  });
});

describe("#2902 cash-evidence coverage target", () => {
  it("reports an account-credit-only cancellation's active note as the fictitious-document manual review, never as valid coverage", async () => {
    // The defect shape: the whole 341.00 mirror is an account-credit
    // disposition (no PaymentRefund rows), yet a fictitious refund note is
    // active. The cash target is 0, so the note is pure over-coverage —
    // reported for the operator to void in Xero, with nothing automatic.
    state.payments[0].refundedAmountCents = 34100;
    state.memberCredits = [
      {
        sourceBookingId: "book_1",
        type: "CANCELLATION_REFUND",
        amountCents: 34100,
        restoredFromBookingId: null,
      },
    ];
    state.links = [
      makeLink({
        id: "link_fict",
        xeroObjectId: "cn_fict",
        active: true,
        metadata: { amountCents: 34100, status: "AUTHORISED" },
      }),
    ];

    const report = await findStripeRefundNoteLinkRepairs(CLUB_FORMAT_TEST);

    expect(report.plans).toHaveLength(1);
    const plan = report.plans[0];
    expect(plan).toMatchObject({
      paymentId: "pay_1",
      refundedAmountCents: 34100,
      coverageTargetCents: 0,
      cashEvidenceSource: "legacy-mirror",
      activeCoveredCents: 34100,
      plannedCoveredCents: 34100,
      repairable: false,
      reactivateLinkIds: [],
      deactivateLinkIds: [],
    });
    expect(plan.manualReviewReason).toContain("account-credit disposition");
    expect(plan.manualReviewReason).toContain("fictitious");

    // Nothing is applied for it either.
    const result = await applyStripeRefundNoteLinkRepairs(CLUB_FORMAT_TEST);
    expect(result.appliedPayments).toBe(0);
    expect(
      state.links.find((link) => link.id === "link_fict")?.active
    ).toBe(true);
  });

  it("deactivates the fictitious note's mirror once the operator voids it in Xero and the void is recorded", async () => {
    state.payments[0].refundedAmountCents = 34100;
    state.memberCredits = [
      {
        sourceBookingId: "book_1",
        type: "CANCELLATION_REFUND",
        amountCents: 34100,
        restoredFromBookingId: null,
      },
    ];
    state.links = [
      makeLink({
        id: "link_fict",
        xeroObjectId: "cn_fict",
        active: true,
        metadata: { amountCents: 34100, status: "VOIDED" },
      }),
    ];

    const result = await applyStripeRefundNoteLinkRepairs(CLUB_FORMAT_TEST, {
      paymentIds: ["pay_1"],
    });

    expect(result.appliedPayments).toBe(1);
    expect(result.deactivatedLinks).toBe(1);
    expect(
      state.links.find((link) => link.id === "link_fict")?.active
    ).toBe(false);
  });

  it("reactivates only up to the provider-ledger cash target on a mixed cash + credit payment", async () => {
    // 100c mirror; the ledger proves 60c of Stripe cash. Both per-delta notes
    // (60c cash note and a 40c fictitious one) were deactivated by the
    // pre-#2901 cleanup. Only the 60c note may come back — reactivating both
    // would land on the mirror, not the cash target.
    state.paymentRefunds = [
      { paymentId: "pay_1", status: "succeeded", amountCents: 60 },
    ];
    state.payments[0].refundedAmountCents = 100;
    state.links = [
      makeLink({
        id: "link_60",
        xeroObjectId: "cn_60",
        active: false,
        metadata: { amountCents: 60, status: "AUTHORISED" },
        createdAt: new Date("2026-05-01T00:00:00Z"),
      }),
      makeLink({
        id: "link_40",
        xeroObjectId: "cn_40",
        active: false,
        metadata: { amountCents: 40, status: "AUTHORISED" },
        createdAt: new Date("2026-05-02T00:00:00Z"),
      }),
    ];

    const report = await findStripeRefundNoteLinkRepairs(CLUB_FORMAT_TEST);

    expect(report.plans).toHaveLength(1);
    const plan = report.plans[0];
    expect(plan).toMatchObject({
      coverageTargetCents: 60,
      cashEvidenceSource: "provider-ledger",
      plannedCoveredCents: 60,
      repairable: true,
      reactivateLinkIds: ["link_60"],
    });
    expect(
      plan.links.find((link) => link.linkId === "link_40")?.plannedAction
    ).toBe("leave-inactive");
    expect(
      plan.links.find((link) => link.linkId === "link_40")?.reason
    ).toContain("provider-backed cash refund target");
  });
});
