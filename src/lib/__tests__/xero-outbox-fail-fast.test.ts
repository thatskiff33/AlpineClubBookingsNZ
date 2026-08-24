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
      where: { id: string; status?: unknown };
      data: Partial<StoredOperation>;
    }) => {
      let count = 0;
      for (const row of rows.values()) {
        if (row.id !== where.id) continue;
        if (!matchesStatus(row.status, where)) continue;
        Object.assign(row, data);
        count += 1;
      }
      return { count };
    }
  );

  // The handlers' own `catch` self-fails the outbox row via this shared helper
  // (xero-sync.ts): it writes FAILED + completedAt with no status guard. The
  // mock reproduces that write against the store so the outbox's un-claim runs
  // against a genuinely-FAILED row.
  const failXeroSyncOperation = vi.fn(
    async (operationId: string, _error?: unknown) => {
      const row = rows.get(operationId);
      if (row) {
        row.status = "FAILED";
        row.completedAt = new Date();
      }
    }
  );

  return {
    rows,
    operationFindMany: vi.fn(),
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
      updateMany: mocks.operationUpdateMany,
    },
    membershipSubscriptionCharge: {
      findUnique: mocks.chargeFindUnique,
      update: mocks.chargeUpdate,
    },
  },
}));

vi.mock("@/lib/xero-sync", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/xero-sync")>();
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
      chargeId: "charge_1",
    },
  });
}

describe("outbox processor fail-fast for all queue types (#1354)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.rows.clear();
    mocks.failXeroSyncOperation.mockImplementation(
      async (operationId: string, _error?: unknown) => {
        const row = mocks.rows.get(operationId);
        if (row) {
          row.status = "FAILED";
          row.completedAt = new Date();
        }
      }
    );
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
      "op_refund_1",
      expect.objectContaining({ message: "Xero token refresh failed" })
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
        await mocks.failXeroSyncOperation("op_refund_1", refusal);
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
        where: { id: "op_refund_1", status: { in: ["RUNNING", "FAILED"] } },
        data: {
          status: "PENDING",
          startedAt: null,
          completedAt: null,
          lastErrorCode: null,
          lastErrorMessage: null,
        },
      });
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
      await mocks.failXeroSyncOperation("op_refund_1", refusal);
      throw refusal;
    });

    const result = await processQueuedXeroOutboxOperations({ limit: 1 });

    expect(result).toMatchObject({
      found: 1,
      processed: 1,
      succeeded: 0,
      failed: 0,
      skipped: 1,
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
      await mocks.failXeroSyncOperation("op_refund_1", err);
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
      await mocks.failXeroSyncOperation("op_refund_1", err);
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
      await mocks.failXeroSyncOperation("op_refund_1", err);
      throw err;
    });

    const result = await processQueuedXeroOutboxOperations({ limit: 1 });

    expect(result).toMatchObject({ found: 1, failed: 1, skipped: 0 });
    expect(mocks.rows.get("op_refund_1")?.status).toBe("FAILED");
  });
});
