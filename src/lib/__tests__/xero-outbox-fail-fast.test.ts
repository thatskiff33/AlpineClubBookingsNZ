import { beforeEach, describe, expect, it, vi } from "vitest";

// -----------------------------------------------------------------------------
// F4 (#1354): the outbox processor must mark an operation FAILED for EVERY
// queue type when its handler throws — not only the two membership-cancellation
// types. An operation erroring before its handler overwrote requestPayload
// previously stayed RUNNING; after an operator stale-reset the retry stack
// could not parse the queued payload shape — a permanent dead-end.
//
// #2423 review F2: fail-fast is right for an operation that was ATTEMPTED, but
// wrong for one a process-global cooldown refused BEFORE any HTTP. The critical
// subtlety these tests defend is that twelve of the fifteen queue types own a
// `catch { await failXeroSyncOperation(<this row>, error); throw }`, so by the
// time the outbox sees the refusal the row is ALREADY FAILED. The un-claim must
// therefore return a FAILED row (not only a RUNNING one) to PENDING. To exercise
// that real transition the prisma mock below is STATEFUL and the self-failing
// handler is simulated end-to-end (it writes FAILED, then throws) rather than
// mocked wholesale — a wholesale mock never runs `failXeroSyncOperation` and so
// hides exactly the state the guard has to cope with.
// -----------------------------------------------------------------------------

type StoredOperation = {
  id: string;
  localModel: string;
  localId: string | null;
  createdByMemberId?: string | null;
  requestPayload: Record<string, unknown>;
  status: string;
  startedAt: Date | null;
  completedAt: Date | null;
  lastErrorCode: string | null;
  lastErrorMessage: string | null;
};

const mocks = vi.hoisted(() => {
  const rows = new Map<string, StoredOperation>();

  const matchesStatus = (
    rowStatus: string,
    where: { status?: unknown }
  ): boolean => {
    const status = where.status;
    if (status === undefined) return true;
    if (typeof status === "string") return rowStatus === status;
    if (status && typeof status === "object" && "in" in status) {
      const list = (status as { in: unknown }).in;
      return Array.isArray(list) && list.includes(rowStatus);
    }
    return false;
  };

  // One branch of an `OR` or `AND`: per column `null`, a literal (a Date by
  // instant), `{ not }`, `{ notIn }` or `{ in }`, and nested `OR`/`AND`. A NULL
  // column matches only `null`, as in SQL, where `NULL <> x` is not true.
  const matchesBranch = (row: StoredOperation, branch: Record<string, unknown>): boolean =>
    Object.entries(branch).every(([column, test]) => {
      if (column === "OR") return (test as Record<string, unknown>[]).some((b) => matchesBranch(row, b));
      if (column === "AND") return (test as Record<string, unknown>[]).every((b) => matchesBranch(row, b));
      const value = (row as unknown as Record<string, unknown>)[column];
      if (test === null) return value === null;
      if (value === null || value === undefined) return false;
      if (test instanceof Date) return value instanceof Date && value.getTime() === test.getTime();
      if (typeof test !== "object") return value === test;
      const { not, notIn, in: within } = test as { not?: unknown; notIn?: unknown[]; in?: unknown[] };
      if (within) return within.includes(value);
      if (notIn) return !notIn.includes(value);
      return value !== not;
    });

  // Stateful `updateMany` honouring the `where.id` + `where.status` predicate,
  // exactly as Postgres would: a guard that does not match the row's current
  // status touches nothing and returns `{ count: 0 }`. This is what makes the
  // regression real — the claim (status PENDING) and the un-claim (status in
  // {RUNNING, FAILED}) are evaluated against the actual row the handler left.
  const operationUpdateMany = vi.fn(
    async ({
      where,
      data,
    }: {
      where: { id: string; status?: unknown; startedAt?: Date | null; manuallyResolvedAt?: null; OR?: Record<string, unknown>[]; AND?: Record<string, unknown>[] };
      data: Partial<StoredOperation>;
    }) => {
      let count = 0;
      for (const row of rows.values()) {
        if (row.id !== where.id) continue;
        if (!matchesStatus(row.status, where)) continue;
        // #4356: honour the not-a-repair-claim `OR` as Postgres would, NULL included.
        if (where.OR && !where.OR.some((branch) => matchesBranch(row, branch))) continue;
        // #4373: and the claim fence (`startedAt`, under `AND`).
        if (where.startedAt !== undefined && !matchesBranch(row, { startedAt: where.startedAt })) continue;
        if (where.AND && !where.AND.every((branch) => matchesBranch(row, branch))) continue;
        // #3635: honour the resolved-in-Xero guard the way Postgres would.
        if (
          where.manuallyResolvedAt === null &&
          (row as { manuallyResolvedAt?: Date | null }).manuallyResolvedAt
        ) {
          continue;
        }
        Object.assign(row, data);
        count += 1;
      }
      return { count };
    }
  );

  // The handlers' own `catch` self-fails the outbox row via this shared helper
  // (xero-sync.ts): it writes FAILED + completedAt only over its own claim's row
  // - RUNNING, or the FAILED end that claim wrote; never CANCELLED - and
  // otherwise leaves the row as it is and answers null (#4356, #4373, #4673,
  // `INV-INT-029`). The mock reproduces that write against the store so the
  // outbox's un-claim runs against a genuinely-FAILED row.
  const selfFail = async (claim: { id: string; startedAt: Date | null }, _error?: unknown) => {
    const row = rows.get(claim.id);
    if (!row || !["RUNNING", "FAILED"].includes(row.status)) return null;
    // #4373/#4673: nor over a row another claim stamped, or none did.
    if (row.startedAt?.getTime() !== claim.startedAt?.getTime()) return null;
    // Nor over a repair's marked RUNNING claim.
    if (row.status === "RUNNING" && row.lastErrorCode === "REFUND_NOTE_REPAIR_RUNNING") return null;
    row.status = "FAILED";
    row.completedAt = new Date();
    return { ...row };
  };
  const failXeroSyncOperation = vi.fn(selfFail);

  /**
   * #3170 fix round (F1): the worker re-reads an operation's payload AFTER it
   * claims the row, because the scan's copy is a Xero round trip per row out of
   * date by then. Served from the same row store `operationUpdateMany` writes,
   * so this suite keeps modelling one store rather than two views of one.
   */
  const operationFindUnique = vi.fn(
    async ({ where }: { where: { id: string } }) => {
      const row = rows.get(where.id);
      return row ? { requestPayload: row.requestPayload, status: row.status } : null;
    }
  );

  return {
    rows,
    selfFail,
    operationFindMany: vi.fn(),
    operationFindUnique,
    operationUpdateMany,
    failXeroSyncOperation,
    createXeroCreditNote: vi.fn(),
    createXeroMembershipSubscriptionInvoice: vi.fn(),
    chargeFindUnique: vi.fn(),
    chargeUpdate: vi.fn(),
  };
});

vi.mock("@/lib/prisma", () => ({
  prisma: {
    xeroSyncOperation: {
      findMany: mocks.operationFindMany,
      findUnique: mocks.operationFindUnique,
      updateMany: mocks.operationUpdateMany,
    },
    membershipSubscriptionCharge: {
      findUnique: mocks.chargeFindUnique,
      update: mocks.chargeUpdate,
      // #4098: the failure handler's charge write is a status-guarded updateMany.
      updateMany: mocks.chargeUpdate,
    },
  },
}));

vi.mock("@/lib/xero-sync", async (importOriginal) => {
  const actual = (await importOriginal()) as typeof import("@/lib/xero-sync");
  return {
    ...actual,
    failXeroSyncOperation: mocks.failXeroSyncOperation,
  };
});

vi.mock("@/lib/xero-credit-notes", () => ({
  createXeroCreditNote: mocks.createXeroCreditNote,
  createUnappliedXeroCreditNote: vi.fn(),
  createXeroCreditNoteForModification: vi.fn(),
}));

vi.mock("@/lib/xero-subscription-invoices", () => ({
  createXeroMembershipSubscriptionInvoice:
    mocks.createXeroMembershipSubscriptionInvoice,
}));

vi.mock("@/lib/logger", () => ({
  default: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));

import {
  XeroDailyLimitError,
  XeroTransientOutageError,
} from "@/lib/xero-api-client";
import { XeroContactEnvironmentUnknownError } from "@/lib/xero-environment-write-gate";
import { processQueuedXeroOutboxOperations } from "@/lib/xero-operation-outbox";
import { NOT_A_XERO_REPAIR_CLAIM } from "@/lib/xero-operation-outcome-guard";

/** Seed one PENDING row into both the store and the initial scan result. */
function seedOperation(row: Partial<StoredOperation> & { id: string }) {
  const stored: StoredOperation = {
    localModel: "Payment",
    localId: "pay_1",
    createdByMemberId: null,
    requestPayload: {},
    status: "PENDING",
    startedAt: null,
    completedAt: null,
    lastErrorCode: null,
    lastErrorMessage: null,
    ...row,
  };
  mocks.rows.set(stored.id, stored);
  mocks.operationFindMany.mockResolvedValue([
    {
      id: stored.id,
      localModel: stored.localModel,
      localId: stored.localId,
      createdByMemberId: stored.createdByMemberId,
      requestPayload: stored.requestPayload,
    },
  ]);
}

/** One queued refund-credit-note row (a SELF-FAILING queue type). */
/** #4373: the claim the dispatch stamped on the row, which the handler's own catch fails under. */
function dispatchClaim(id: string) {
  return { id, startedAt: mocks.rows.get(id)!.startedAt };
}

function queueOneRefundOperation() {
  seedOperation({
    id: "op_refund_1",
    localModel: "Payment",
    localId: "pay_1",
    requestPayload: {
      queueType: "REFUND_CREDIT_NOTE",
      refundAmountCents: 3000,
      watermarkCents: 8000,
    },
  });
}

/** One queued subscription-invoice row (a NON-self-failing queue type). */
function queueOneSubscriptionOperation() {
  seedOperation({
    id: "op_sub_1",
    localModel: "MembershipSubscriptionCharge",
    localId: "charge_1",
    requestPayload: {
      queueType: "MEMBERSHIP_SUBSCRIPTION_INVOICE",
    },
  });
}

describe("outbox processor fail-fast for all queue types (#1354)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.rows.clear();
    mocks.failXeroSyncOperation.mockImplementation(mocks.selfFail);
    mocks.chargeFindUnique.mockResolvedValue(null);
  });

  it("marks a refund-credit-note operation FAILED when its handler throws before the payload overwrite", async () => {
    queueOneRefundOperation();
    // Token refresh / contact resolution / account mapping failures all
    // surface as a thrown error from the handler, BEFORE requestPayload is
    // overwritten with the Xero request shape.
    mocks.createXeroCreditNote.mockRejectedValue(
      new Error("Xero token refresh failed")
    );

    const result = await processQueuedXeroOutboxOperations({ limit: 1 });

    expect(result).toMatchObject({ found: 1, failed: 1, succeeded: 0 });
    // Pre-#1354 this operation stayed RUNNING (only the two
    // membership-cancellation types were failed); now it is replayable.
    expect(mocks.failXeroSyncOperation).toHaveBeenCalledWith(
      expect.objectContaining({ id: "op_refund_1" }),
      expect.objectContaining({ message: "Xero token refresh failed" }),
      undefined,
      { keepCancelled: true }
    );
    expect(mocks.rows.get("op_refund_1")?.status).toBe("FAILED");
  });

  // #2423 review F2. A process-global cooldown refused this operation before any
  // HTTP, so nothing was sent and the row must go back to PENDING for the next
  // cron rather than being condemned FAILED (which nothing auto-recovers).
  //
  // The two representative cases cover the two handler shapes:
  //  - REFUND_CREDIT_NOTE self-fails (writes FAILED) before rethrowing — the
  //    twelve-type majority, and the case a `status: "RUNNING"`-only un-claim
  //    silently no-ops on;
  //  - MEMBERSHIP_SUBSCRIPTION_INVOICE does NOT self-fail — the row is still
  //    RUNNING when the outbox sees the refusal.
  // Both must end PENDING with completedAt cleared and be counted `skipped`.
  describe("un-attempted refusal returns the row to PENDING", () => {
    it("REFUND_CREDIT_NOTE (self-failing handler): un-FAILs the row the handler condemned", async () => {
      queueOneRefundOperation();
      // Reproduce the real handler catch (xero-credit-notes.ts:469-472): write
      // FAILED via the shared helper, THEN rethrow the pre-HTTP refusal.
      mocks.createXeroCreditNote.mockImplementation(async () => {
        const refusal = new XeroTransientOutageError(120, true);
        await mocks.failXeroSyncOperation(dispatchClaim("op_refund_1"), refusal);
        throw refusal;
      });

      // Guard the premise: the handler really did leave the row FAILED.
      // (Asserted after the run below via call order; here we just run it.)
      const result = await processQueuedXeroOutboxOperations({ limit: 1 });

      expect(result).toMatchObject({
        found: 1,
        processed: 1,
        succeeded: 0,
        failed: 0,
        skipped: 1,
        cooldownDeferred: 1,
      });
      // The handler self-failed once; the outbox must NOT fail it again.
      expect(mocks.failXeroSyncOperation).toHaveBeenCalledTimes(1);

      // The row the handler left FAILED is now back to PENDING, un-started and
      // with completedAt cleared — indistinguishable from never-picked-up.
      const row = mocks.rows.get("op_refund_1");
      expect(row?.status).toBe("PENDING");
      expect(row?.startedAt).toBeNull();
      expect(row?.completedAt).toBeNull();

      // The un-claim widened its guard to match the FAILED row the handler left.
      expect(mocks.operationUpdateMany).toHaveBeenLastCalledWith({
        where: {
          id: "op_refund_1",
          // #4373/#4687: RUNNING or self-failed FAILED, only under this dispatch's own claim.
          AND: [{ status: { in: ["RUNNING", "FAILED"] }, startedAt: expect.any(Date) }],
          manuallyResolvedAt: null,
          ...NOT_A_XERO_REPAIR_CLAIM,
        },
        data: {
          status: "PENDING",
          startedAt: null,
          completedAt: null,
          lastErrorCode: null,
          lastErrorMessage: null,
        },
      });
    });

    // #4356 (`INV-INT-029`): a FAILED refund-note repair claimed the row the
    // handler condemned before the hand-back ran; the claim is the repair's.
    it("MUTATION: never returns a repair's marked claim to PENDING", async () => {
      queueOneRefundOperation();
      const repairClaimedAt = new Date("2026-07-01T00:00:00.000Z");
      mocks.createXeroCreditNote.mockImplementation(async () => {
        const refusal = new XeroTransientOutageError(120, true);
        await mocks.failXeroSyncOperation(dispatchClaim("op_refund_1"), refusal);
        Object.assign(mocks.rows.get("op_refund_1")!, {
          status: "RUNNING",
          startedAt: repairClaimedAt,
          completedAt: null,
          lastErrorCode: "REFUND_NOTE_REPAIR_RUNNING",
        });
        throw refusal;
      });

      await processQueuedXeroOutboxOperations({ limit: 1 });

      expect(mocks.rows.get("op_refund_1")).toMatchObject({
        status: "RUNNING",
        startedAt: repairClaimedAt,
        lastErrorCode: "REFUND_NOTE_REPAIR_RUNNING",
      });
    });

    // #4373: a retry claimed the row the handler condemned (a new `startedAt`)
    // before the hand-back ran; that claim is the retry's, not this dispatch's.
    it("MUTATION: never returns a later claim's RUNNING row to PENDING, nor fails it", async () => {
      queueOneRefundOperation();
      const retryClaimedAt = new Date("2026-07-01T00:05:00.000Z");
      mocks.createXeroCreditNote.mockImplementation(async () => {
        const refusal = new XeroTransientOutageError(120, true);
        await mocks.failXeroSyncOperation(dispatchClaim("op_refund_1"), refusal);
        Object.assign(mocks.rows.get("op_refund_1")!, { status: "RUNNING", startedAt: retryClaimedAt, completedAt: null });
        throw refusal;
      });

      await processQueuedXeroOutboxOperations({ limit: 1 });

      expect(mocks.rows.get("op_refund_1")).toMatchObject({ status: "RUNNING", startedAt: retryClaimedAt, completedAt: null });
    });

    it("leaves FAILED a row an officer resolved in Xero in the same instant (#3635)", async () => {
      queueOneRefundOperation();
      mocks.createXeroCreditNote.mockImplementation(async () => {
        const refusal = new XeroTransientOutageError(120, true);
        await mocks.failXeroSyncOperation(dispatchClaim("op_refund_1"), refusal);
        // The officer resolves the FAILED row before the hand-back runs.
        Object.assign(mocks.rows.get("op_refund_1")!, {
          manuallyResolvedAt: new Date("2026-06-30T00:00:00.000Z"),
        });
        throw refusal;
      });

      await processQueuedXeroOutboxOperations({ limit: 1 });

      expect(mocks.rows.get("op_refund_1")?.status).toBe("FAILED");
    });

    // #4356 review F5: a caller sharing this row recorded its success while
    // this run's handler was refused, so the handler's self-fail was kept off
    // it. The un-claim then matches nothing, and that is not a failure.
    it("MUTATION: a row another caller completed is left as it is, counted skipped, not failed", async () => {
      const logger = (await import("@/lib/logger")).default;
      queueOneRefundOperation();
      mocks.createXeroCreditNote.mockImplementation(async () => {
        const refusal = new XeroTransientOutageError(120, true);
        Object.assign(mocks.rows.get("op_refund_1")!, { status: "SUCCEEDED", completedAt: new Date() });
        await mocks.failXeroSyncOperation(dispatchClaim("op_refund_1"), refusal);
        throw refusal;
      });

      const result = await processQueuedXeroOutboxOperations({ limit: 1 });

      expect(result).toMatchObject({ found: 1, processed: 1, succeeded: 0, failed: 0, skipped: 1 });
      expect(mocks.rows.get("op_refund_1")?.status).toBe("SUCCEEDED");
      expect(mocks.failXeroSyncOperation).toHaveBeenCalledTimes(1);
      expect(logger.warn).not.toHaveBeenCalledWith(expect.anything(), expect.stringContaining("failing it"));
      expect(logger.error).not.toHaveBeenCalled();
    });

    it("MEMBERSHIP_SUBSCRIPTION_INVOICE (non-self-failing handler): returns the RUNNING row", async () => {
      queueOneSubscriptionOperation();
      mocks.createXeroMembershipSubscriptionInvoice.mockRejectedValue(
        new XeroDailyLimitError(86_400, true)
      );

      const result = await processQueuedXeroOutboxOperations({ limit: 1 });

      expect(result).toMatchObject({
        found: 1,
        processed: 1,
        succeeded: 0,
        failed: 0,
        skipped: 1,
        cooldownDeferred: 1,
      });
      expect(mocks.failXeroSyncOperation).not.toHaveBeenCalled();
      // The subscription-charge exposure below the cooldown branch must NOT run
      // for an un-attempted operation — the charge is left as the enqueue set it.
      expect(mocks.chargeUpdate).not.toHaveBeenCalled();

      const row = mocks.rows.get("op_sub_1");
      expect(row?.status).toBe("PENDING");
      expect(row?.startedAt).toBeNull();
      expect(row?.completedAt).toBeNull();
    });
  });

  // #3036: the environment-role gate inside `callXeroApi` refuses a Xero
  // MUTATION while nothing has declared whether this installation is the club's
  // live site or a copy. Its refusal is pre-HTTP by construction — the gate sits
  // ahead of `withXeroRetry` and ahead of the usage meter — so it belongs in
  // exactly the same class as a cooldown refusal, and without it a whole
  // in-flight cron batch was condemned to hand requeues. The sharpest trigger is
  // a declared-PRODUCTION site: one failed `environmentSafetySettings.findUnique`
  // during a blue/green overlap resolves UNKNOWN for an instant.
  it("returns an environment-role refusal to PENDING: it never reached Xero", async () => {
    queueOneRefundOperation();
    mocks.createXeroCreditNote.mockImplementation(async () => {
      const refusal = new XeroContactEnvironmentUnknownError(
        "Nothing was written to Xero: this application cannot tell whether it is the club's live site or a copy of it.",
      );
      // The refusal must carry the marker the predicate verifies, not merely a
      // recognised name — that is what keeps "never attempted" a property rather
      // than a naming convention.
      expect(refusal.preHttp).toBe(true);
      await mocks.failXeroSyncOperation(dispatchClaim("op_refund_1"), refusal);
      throw refusal;
    });

    const result = await processQueuedXeroOutboxOperations({ limit: 1 });

    expect(result).toMatchObject({
      found: 1,
      processed: 1,
      succeeded: 0,
      failed: 0,
      skipped: 1,
      cooldownDeferred: 1,
    });
    const row = mocks.rows.get("op_refund_1");
    expect(row?.status).toBe("PENDING");
    expect(row?.startedAt).toBeNull();
    expect(row?.completedAt).toBeNull();
  });

  it("still FAILS an environment-role-shaped error that does not carry the marker", async () => {
    // The name alone must not be enough. A hand-built error wearing the class
    // name but no `preHttp` cannot prove nothing was sent, so it keeps the
    // replayable FAILED path — the same boundary the day-limit cases below pin.
    queueOneRefundOperation();
    mocks.createXeroCreditNote.mockImplementation(async () => {
      const err = Object.assign(new Error("looks like a refusal"), {
        name: "XeroContactEnvironmentUnknownError",
      });
      await mocks.failXeroSyncOperation(dispatchClaim("op_refund_1"), err);
      throw err;
    });

    const result = await processQueuedXeroOutboxOperations({ limit: 1 });

    expect(result).toMatchObject({ found: 1, failed: 1, skipped: 0 });
    expect(mocks.rows.get("op_refund_1")?.status).toBe("FAILED");
  });

  // The boundary: only genuinely pre-HTTP refusals change class. A 429 that Xero
  // itself returned (or any other error escaping the handler) was a real
  // attempt, so it keeps the replayable FAILED path exactly as before. This also
  // pins the marker: a cooldown-named error WITHOUT `preHttp: true` (which is
  // what withXeroRetry mints from a Xero-returned day-429) is NOT a refusal.
  it("still fails an operation that Xero itself rejected (raw 429)", async () => {
    queueOneRefundOperation();
    mocks.createXeroCreditNote.mockImplementation(async () => {
      const err = Object.assign(new Error("Xero rate limit hit"), {
        response: { statusCode: 429 },
      });
      await mocks.failXeroSyncOperation(dispatchClaim("op_refund_1"), err);
      throw err;
    });

    const result = await processQueuedXeroOutboxOperations({ limit: 1 });

    expect(result).toMatchObject({ found: 1, failed: 1, skipped: 0 });
    expect(mocks.rows.get("op_refund_1")?.status).toBe("FAILED");
  });

  it("still fails a post-HTTP day-limit error (XeroDailyLimitError with preHttp: false)", async () => {
    queueOneRefundOperation();
    // This is the exact instance withXeroRetry mints from a real HTTP 429 that
    // Xero returned carrying `x-rate-limit-problem: day` (#2423 F2): same class
    // NAME as the pre-HTTP gate, but `preHttp` is false because the call was
    // attempted. It must NOT be resurrected to PENDING.
    mocks.createXeroCreditNote.mockImplementation(async () => {
      const err = new XeroDailyLimitError(86_400, false);
      await mocks.failXeroSyncOperation(dispatchClaim("op_refund_1"), err);
      throw err;
    });

    const result = await processQueuedXeroOutboxOperations({ limit: 1 });

    expect(result).toMatchObject({ found: 1, failed: 1, skipped: 0 });
    expect(mocks.rows.get("op_refund_1")?.status).toBe("FAILED");
  });
});

// #2147 / #4098: when a subscription invoice attempt fails, the handler exposes
// the error on the charge by sending it back to QUEUED / EMAIL_FAILED. A charge
// that needs no invoice — VOIDED, or NOT_REQUIRED because an officer closed it
// as already paid — must never come back as retryable work.
describe("a failed subscription invoice never reopens a charge that needs no invoice (#4098)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.rows.clear();
    mocks.failXeroSyncOperation.mockImplementation(mocks.selfFail);
    mocks.chargeUpdate.mockResolvedValue({ count: 1 });
    mocks.createXeroMembershipSubscriptionInvoice.mockRejectedValue(new Error("Xero is down"));
  });

  it.each(["NOT_REQUIRED", "VOIDED"])("leaves a %s charge as it is", async (status) => {
    queueOneSubscriptionOperation();
    mocks.chargeFindUnique.mockResolvedValue({ status, billingBasis: "PER_MEMBER", xeroInvoiceId: null });

    await processQueuedXeroOutboxOperations({ limit: 1 });

    expect(mocks.chargeUpdate).not.toHaveBeenCalled();
    expect(mocks.rows.get("op_sub_1")?.status).toBe("FAILED");
  });

  it("control: exposes the error on a live charge, guarded so a close landing after the read still stands", async () => {
    queueOneSubscriptionOperation();
    mocks.chargeFindUnique.mockResolvedValue({ status: "PROCESSING", billingBasis: "PER_MEMBER", xeroInvoiceId: null });

    await processQueuedXeroOutboxOperations({ limit: 1 });

    expect(mocks.chargeUpdate).toHaveBeenCalledWith({
      where: { id: "charge_1", status: { notIn: ["NOT_REQUIRED", "VOIDED"] } },
      data: expect.objectContaining({ status: "QUEUED", lastErrorCode: "XERO_FAILED", lastErrorMessage: "Xero is down" }),
    });
  });
});

// #4673 (`INV-INT-029`): a run stalls, Reset stale running fails its row, an
// officer's Retry queues the same row again (PENDING, no claim), and only then
// does the stalled handler throw. Its failure lost its claim: the row stays
// queued, and the outbox counts nothing failed and exposes no error.
describe("a stalled run's late failure after an officer's in-place Retry (#4673)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.rows.clear();
    mocks.failXeroSyncOperation.mockImplementation(mocks.selfFail);
    mocks.chargeUpdate.mockResolvedValue({ count: 1 });
    mocks.chargeFindUnique.mockResolvedValue({ status: "PROCESSING", billingBasis: "PER_MEMBER", xeroInvoiceId: null });
  });

  /** Reset stale running, then Retry's `requeueOutboxRowForRetry`, while the handler is still out. */
  function resetThenRequeued(id: string) {
    Object.assign(mocks.rows.get(id)!, { status: "PENDING", startedAt: null, completedAt: null, lastErrorCode: null, lastErrorMessage: null });
  }

  it("MUTATION: a self-failing handler's late failure leaves the queued row PENDING: counted skipped, not failed, warned", async () => {
    const logger = (await import("@/lib/logger")).default;
    queueOneRefundOperation();
    mocks.createXeroCreditNote.mockImplementation(async () => {
      const claim = dispatchClaim("op_refund_1");
      resetThenRequeued("op_refund_1");
      const failure = new Error("Xero 500");
      await mocks.failXeroSyncOperation(claim, failure);
      throw failure;
    });

    const result = await processQueuedXeroOutboxOperations({ limit: 1 });

    expect(result).toMatchObject({ found: 1, processed: 1, succeeded: 0, failed: 0, skipped: 1 });
    expect(mocks.rows.get("op_refund_1")).toMatchObject({ status: "PENDING", startedAt: null, lastErrorMessage: null });
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ queueOperationId: "op_refund_1" }),
      expect.stringContaining("no longer this run's"),
    );
    expect(logger.error).not.toHaveBeenCalledWith(expect.anything(), "Failed queued Xero outbox operation");
  });

  it("MUTATION: a non-self-failing handler's late failure exposes no error on its charge", async () => {
    queueOneSubscriptionOperation();
    mocks.createXeroMembershipSubscriptionInvoice.mockImplementation(async () => {
      resetThenRequeued("op_sub_1");
      throw new Error("Xero is down");
    });

    const result = await processQueuedXeroOutboxOperations({ limit: 1 });

    expect(result).toMatchObject({ failed: 0, skipped: 1 });
    expect(mocks.rows.get("op_sub_1")?.status).toBe("PENDING");
    expect(mocks.chargeUpdate).not.toHaveBeenCalled();
  });

  // PR #4687 review: S1 stalls, Reset fails it, Retry queues it, S2 reaches Xero and
  // fails (FAILED under S2), then S1's handler meets a pre-HTTP cooldown. The
  // give-back to PENDING is S1's own claim's only: S2's failure and error stand.
  it("MUTATION: a stalled run's cooldown refusal never gives back a FAILED row a later claim ended", async () => {
    const laterClaimAt = new Date("2026-07-01T00:40:00.000Z");
    queueOneRefundOperation();
    mocks.createXeroCreditNote.mockImplementation(async () => {
      const claim = dispatchClaim("op_refund_1");
      Object.assign(mocks.rows.get("op_refund_1")!, {
        status: "FAILED", startedAt: laterClaimAt, completedAt: laterClaimAt, lastErrorMessage: "Xero 400: the later run's own failure",
      });
      const refusal = new XeroTransientOutageError(120, true);
      await mocks.failXeroSyncOperation(claim, refusal);
      throw refusal;
    });

    const result = await processQueuedXeroOutboxOperations({ limit: 1 });

    expect(result).toMatchObject({ failed: 0, skipped: 1 });
    expect(result.cooldownDeferred).toBeUndefined();
    expect(mocks.rows.get("op_refund_1")).toMatchObject({
      status: "FAILED", startedAt: laterClaimAt, completedAt: laterClaimAt, lastErrorMessage: "Xero 400: the later run's own failure",
    });
  });

  it("control: the same failure on its own RUNNING claim is recorded, counted failed and exposed", async () => {
    queueOneSubscriptionOperation();
    mocks.createXeroMembershipSubscriptionInvoice.mockRejectedValue(new Error("Xero is down"));

    const result = await processQueuedXeroOutboxOperations({ limit: 1 });

    expect(result).toMatchObject({ failed: 1, skipped: 0 });
    expect(mocks.rows.get("op_sub_1")?.status).toBe("FAILED");
    expect(mocks.chargeUpdate).toHaveBeenCalledTimes(1);
  });
});
