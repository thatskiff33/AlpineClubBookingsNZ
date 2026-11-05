/**
 * Real-PostgreSQL proof that the PARTIAL modification credit-note repair claims
 * its row before it reads, writes or calls Xero, and closes it (#4259).
 *
 * Xero Operations Retry on a PARTIAL modification credit note allocates the
 * planned invoices the create could not. It used to do that with no claim, so
 * an officer's resolve or mark non-replayable landing after its read was
 * ignored and two retries both reached Xero, and it never completed the row,
 * which stayed PARTIAL after a good repair. It now runs inside the PARTIAL-only
 * claim (`runWithClaimedOriginal`), a status-guarded `UPDATE`, like the #4256
 * repairs. This file runs it against the migrated schema, with the officer's
 * write landing WHILE the retry waits on its claim:
 *
 *   - a resolve, or a mark non-replayable, committed between the retry's read
 *     and its claim makes the claim lose: no Xero call, the row untouched;
 *   - two retries of one row at once make one allocation and close the row once;
 *   - a refused allocation gives the row back PARTIAL with its payload, and the
 *     next retry closes it SUCCEEDED;
 *   - a repair that died mid-claim comes back PARTIAL through Mark failed.
 *
 * Xero itself is faked (no provider call). Ordinary Vitest runs skip the whole
 * file. It reuses the guarded, disposable loopback PostgreSQL
 * `concurrency-lock-races.realdb.test.ts` provisions (#1881), which imports
 * this file so CI reaches it; it owns and cleans its own `race-4259-` fixtures.
 *
 * To run directly against a throwaway scratch database:
 *   RUN_CONCURRENCY_RACE_TESTS=1 \
 *   CONCURRENCY_RACE_DATABASE_URL=postgresql://user:pass@127.0.0.1:55442/concurrency_race_1881 \
 *   pnpm exec vitest run src/lib/__tests__/xero-modification-note-repair-claim.realdb.test.ts
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { CLUB_FORMAT_TEST } from "./support/club-format-fixture";
import { realElapsedMs } from "./helpers/clock";

const RUN = process.env.RUN_CONCURRENCY_RACE_TESTS === "1";
const RACE_DB_URL = process.env.CONCURRENCY_RACE_DATABASE_URL ?? "";
const RACE_TEST_TIMEOUT_MS = 30_000;

const MODIFICATION_ID = "race-4259-modification";
const OPERATION_ID = "race-4259-op-partial";
const CREDIT_NOTE_ID = "race-4259-credit-note";
const INVOICE_ID = "race-4259-invoice";
// Built, not quoted: a quoted `*Key` literal reads to gitleaks as a secret.
const NOTE_KEY = ["race-4259", "note", "key"].join("-");

/** Standalone fail-closed copy: importing this file must not register another suite. */
export function assertSafeModificationNoteRepairRaceDbUrl(url: string): void {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error("Modification note repair claim proofs need a valid CONCURRENCY_RACE_DATABASE_URL.");
  }
  const port = Number.parseInt(parsed.port, 10);
  if (!Number.isFinite(port) || port === 5432 || port < 55442) {
    throw new Error(
      `Refusing to run modification note repair claim proofs against port ${parsed.port || "(none)"}: use a throwaway PostgreSQL on 55442+ (never 5432).`,
    );
  }
  const host = parsed.hostname.toLowerCase();
  if (!["localhost", "127.0.0.1", "::1", "[::1]"].includes(host)) {
    throw new Error("Modification note repair claim proof DB must be loopback-only.");
  }
  const databaseName = decodeURIComponent(parsed.pathname.replace(/^\//, ""));
  if (!databaseName.includes("concurrency_race_1881")) {
    throw new Error("Modification note repair claim proof DB name must contain 'concurrency_race_1881'.");
  }
}

describe("modification note repair claim race DB safety guard (#4259)", () => {
  it("accepts only a dedicated loopback scratch database", () => {
    expect(() =>
      assertSafeModificationNoteRepairRaceDbUrl("postgresql://u:p@127.0.0.1:55442/concurrency_race_1881"),
    ).not.toThrow();
  });

  it.each([
    "postgresql://u:p@db.example.org:55442/concurrency_race_1881",
    "postgresql://u:p@127.0.0.1:5432/concurrency_race_1881",
    "postgresql://u:p@127.0.0.1:55442/app",
    "not-a-url",
  ])("rejects unsafe target %s", (url) => {
    expect(() => assertSafeModificationNoteRepairRaceDbUrl(url)).toThrow();
  });
});

let prisma: (typeof import("@/lib/prisma"))["prisma"];
let retry: typeof import("@/lib/xero-operation-retry");

(RUN ? describe : describe.skip)(
  "a PARTIAL modification credit-note repair claims its row and closes it - real PostgreSQL (#4259)",
  { timeout: RACE_TEST_TIMEOUT_MS },
  () => {
    const createCreditNoteAllocation = vi.fn();

    async function clearFixtures() {
      await prisma.xeroSyncOperation.deleteMany({ where: { localId: MODIFICATION_ID } });
      await prisma.xeroObjectLink.deleteMany({ where: { localId: MODIFICATION_ID } });
    }

    /** A booking edit's note Xero raised, whose allocation to the invoice then failed. */
    const partialPayload = {
      creditNote: { creditNotes: [{ creditNoteID: CREDIT_NOTE_ID }] },
      allocationError: { message: "Xero 503 on the allocation" },
    };

    async function seedPartial() {
      await prisma.xeroSyncOperation.create({
        data: {
          id: OPERATION_ID,
          direction: "OUTBOUND",
          entityType: "CREDIT_NOTE",
          operationType: "CREATE",
          localModel: "BookingModification",
          localId: MODIFICATION_ID,
          status: "PARTIAL",
          idempotencyKey: NOTE_KEY,
          correlationKey: NOTE_KEY,
          requestPayload: { invoiceId: INVOICE_ID, refundAmountCents: 2500 },
          responsePayload: partialPayload,
          xeroObjectType: "CREDIT_NOTE",
          xeroObjectId: CREDIT_NOTE_ID,
          xeroObjectNumber: "CN-4259",
          completedAt: new Date(),
        },
      });
    }

    const readRow = () => prisma.xeroSyncOperation.findUniqueOrThrow({ where: { id: OPERATION_ID } });
    const allocationRows = () =>
      prisma.xeroSyncOperation.count({ where: { localId: MODIFICATION_ID, entityType: "ALLOCATION" } });
    const allocationLinks = () =>
      prisma.xeroObjectLink.count({
        where: { localId: MODIFICATION_ID, xeroObjectType: "ALLOCATION", role: "MODIFICATION_CREDIT_NOTE_ALLOCATION", active: true },
      });

    /**
     * Hold the row's lock while the retries read it, wait until every one of
     * their claims is blocked on that lock, then commit `officerWrite` - the
     * officer's mark landing between the retries' read and their claims. With
     * no write it is a barrier: the claims race only once all have read.
     */
    async function landWhileClaimsWait<T>(
      officerWrite: ((tx: Parameters<Parameters<typeof prisma.$transaction>[0]>[0]) => Promise<unknown>) | null,
      runRetries: Array<() => Promise<T>>,
    ): Promise<Array<PromiseSettledResult<T>>> {
      let retried!: Promise<Array<PromiseSettledResult<T>>>;
      await prisma.$transaction(
        async (tx) => {
          await tx.$queryRaw`SELECT id FROM "XeroSyncOperation" WHERE id = ${OPERATION_ID} FOR UPDATE`;
          retried = Promise.allSettled(runRetries.map((run) => run()));
          const started = process.hrtime.bigint();
          for (;;) {
            const waiting = await prisma.$queryRaw<Array<{ n: bigint }>>`
              SELECT count(*)::bigint AS n FROM pg_stat_activity
              WHERE datname = current_database() AND wait_event_type = 'Lock'
                AND query ILIKE '%UPDATE%XeroSyncOperation%'`;
            if (Number(waiting[0]?.n ?? 0) >= runRetries.length) break;
            if (realElapsedMs(started) > 10_000) throw new Error("The retries never reached their claims.");
            await new Promise((resolve) => setTimeout(resolve, 20));
          }
          if (officerWrite) await officerWrite(tx);
        },
        { timeout: 20_000 },
      );
      return retried;
    }

    const landWhileClaimWaits = async <T,>(
      officerWrite: Parameters<typeof landWhileClaimsWait<T>>[0],
      runRetry: () => Promise<T>,
    ) => (await landWhileClaimsWait(officerWrite, [runRetry]))[0]!;

    beforeAll(async () => {
      assertSafeModificationNoteRepairRaceDbUrl(RACE_DB_URL);
      process.env.DATABASE_URL = RACE_DB_URL;
      ({ prisma } = await import("@/lib/prisma"));
      retry = await import("@/lib/xero-operation-retry");
      await clearFixtures();
    });

    beforeEach(async () => {
      await clearFixtures();
      createCreditNoteAllocation.mockReset();
      createCreditNoteAllocation.mockImplementation(async () => ({
        body: { allocations: [{ amount: 25, invoice: { invoiceID: INVOICE_ID } }] },
      }));
      const apiClient = await import("@/lib/xero-api-client");
      vi.spyOn(apiClient, "getAuthenticatedXeroClient").mockResolvedValue({
        xero: { accountingApi: { createCreditNoteAllocation } },
        tenantId: "tenant-4259",
      } as never);
      vi.spyOn(apiClient, "callXeroApi").mockImplementation(((call: () => unknown) => call()) as never);
    });

    afterEach(() => {
      vi.restoreAllMocks();
    });

    afterAll(async () => {
      if (prisma) await clearFixtures();
    });

    it("a resolve committed while the repair waits on its claim wins: no Xero call, the row left resolved and PARTIAL", async () => {
      await seedPartial();
      const resolvedAt = new Date("2026-06-30T00:00:00.000Z");

      const outcome = await landWhileClaimWaits(
        (tx) => tx.xeroSyncOperation.update({ where: { id: OPERATION_ID }, data: { manuallyResolvedAt: resolvedAt } }),
        () => retry.retryXeroSyncOperation(OPERATION_ID, CLUB_FORMAT_TEST),
      );

      expect(outcome.status).toBe("rejected");
      expect((outcome as PromiseRejectedResult).reason).toBeInstanceOf(retry.XeroOperationResolvedInXeroError);
      expect(createCreditNoteAllocation).not.toHaveBeenCalled();
      expect(await allocationRows()).toBe(0);
      const row = await readRow();
      expect(row).toMatchObject({ status: "PARTIAL", manuallyResolvedAt: resolvedAt });
      expect(row.responsePayload).toEqual(partialPayload);
    });

    it("a mark non-replayable committed while the repair waits on its claim wins too", async () => {
      await seedPartial();

      const outcome = await landWhileClaimWaits(
        (tx) => tx.xeroSyncOperation.update({ where: { id: OPERATION_ID }, data: { replayable: false } }),
        () => retry.retryXeroSyncOperation(OPERATION_ID, CLUB_FORMAT_TEST),
      );

      expect(outcome.status).toBe("rejected");
      expect((outcome as PromiseRejectedResult).reason).toMatchObject({
        status: 409,
        message: "This operation is not marked replayable.",
      });
      expect(createCreditNoteAllocation).not.toHaveBeenCalled();
      expect(await readRow()).toMatchObject({ status: "PARTIAL", replayable: false });
    });

    it("two retries of one row at once make one allocation and close the row once, SUCCEEDED", async () => {
      await seedPartial();

      // A barrier, so both have read the row before either claims.
      const outcomes = await landWhileClaimsWait(null, [
        () => retry.retryXeroSyncOperation(OPERATION_ID, CLUB_FORMAT_TEST),
        () => retry.retryXeroSyncOperation(OPERATION_ID, CLUB_FORMAT_TEST),
      ]);

      expect(outcomes.filter((outcome) => outcome.status === "fulfilled")).toEqual([
        { status: "fulfilled", value: { message: "Repaired Xero modification credit note allocation." } },
      ]);
      const refused = outcomes.filter(
        (outcome): outcome is PromiseRejectedResult => outcome.status === "rejected",
      );
      expect(refused).toHaveLength(1);
      expect(refused[0].reason).toMatchObject({ status: 409, message: expect.stringContaining("already claimed") });
      expect(createCreditNoteAllocation).toHaveBeenCalledTimes(1);
      expect(createCreditNoteAllocation.mock.calls[0][1]).toBe(CREDIT_NOTE_ID);
      expect(createCreditNoteAllocation.mock.calls[0][2].allocations[0]).toMatchObject({
        invoice: { invoiceID: INVOICE_ID },
        amount: 25,
      });
      expect(await allocationRows()).toBe(1);
      expect(await allocationLinks()).toBe(1);
      const row = await readRow();
      expect(row).toMatchObject({
        status: "SUCCEEDED",
        lastErrorCode: null,
        lastErrorMessage: null,
        xeroObjectType: "CREDIT_NOTE",
        xeroObjectId: CREDIT_NOTE_ID,
        xeroObjectNumber: "CN-4259",
      });
      expect(row.responsePayload).toEqual({
        ...partialPayload,
        allocationError: null,
        repairedAllocations: [{ invoiceId: INVOICE_ID, amountCents: 2500 }],
      });
    });

    it("a refused allocation gives the row back PARTIAL with its payload, and the next retry closes it", async () => {
      await seedPartial();
      createCreditNoteAllocation.mockRejectedValueOnce(new Error("Xero 503 again"));

      await expect(retry.retryXeroSyncOperation(OPERATION_ID, CLUB_FORMAT_TEST)).rejects.toThrow("Xero 503 again");
      const givenBack = await readRow();
      expect(givenBack).toMatchObject({ status: "PARTIAL", lastErrorMessage: "Xero 503 again" });
      expect(givenBack.responsePayload).toEqual(partialPayload);
      expect(retry.getXeroOperationRetryMeta(givenBack)).toEqual({ supported: true, reason: null });
      expect(await allocationLinks()).toBe(0);

      await expect(retry.retryXeroSyncOperation(OPERATION_ID, CLUB_FORMAT_TEST)).resolves.toEqual({
        message: "Repaired Xero modification credit note allocation.",
      });
      expect(createCreditNoteAllocation).toHaveBeenCalledTimes(2);
      expect(await allocationLinks()).toBe(1);
      expect(await readRow()).toMatchObject({ status: "SUCCEEDED", lastErrorCode: null });
    });

    it("a row repaired before #4259 - its allocation already linked, still PARTIAL - closes on one retry with no Xero call", async () => {
      await seedPartial();
      await prisma.xeroObjectLink.create({
        data: {
          localModel: "BookingModification",
          localId: MODIFICATION_ID,
          xeroObjectType: "ALLOCATION",
          xeroObjectId: `${CREDIT_NOTE_ID}:${INVOICE_ID}:2500`,
          role: "MODIFICATION_CREDIT_NOTE_ALLOCATION",
          active: true,
          metadata: { creditNoteId: CREDIT_NOTE_ID, invoiceId: INVOICE_ID, amountCents: 2500 },
        },
      });

      await expect(retry.retryXeroSyncOperation(OPERATION_ID, CLUB_FORMAT_TEST)).resolves.toEqual({
        message: "Repaired Xero modification credit note allocation.",
      });
      expect(createCreditNoteAllocation).not.toHaveBeenCalled();
      const row = await readRow();
      expect(row.status).toBe("SUCCEEDED");
      expect(row.responsePayload).toMatchObject({ allocationError: null, repairedAllocations: [] });
    });

    it("MUTATION: a repair that died mid-claim comes back PARTIAL through Mark failed, and the retry closes it", async () => {
      await seedPartial();
      const apiClient = await import("@/lib/xero-api-client");
      vi.mocked(apiClient.getAuthenticatedXeroClient).mockImplementationOnce(() => new Promise(() => {}));
      void retry.retryXeroSyncOperation(OPERATION_ID, CLUB_FORMAT_TEST).catch(() => {});

      const started = process.hrtime.bigint();
      for (;;) {
        const row = await readRow();
        if (row.status === "RUNNING") {
          expect(row.lastErrorCode).toBe("PARTIAL_REPAIR_RUNNING");
          break;
        }
        if (realElapsedMs(started) > 10_000) throw new Error("The repair never claimed the row.");
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      // The process "dies" here: nothing completes the claim, and 20 minutes pass.
      await prisma.xeroSyncOperation.update({
        where: { id: OPERATION_ID },
        data: { startedAt: new Date(Date.now() - 20 * 60_000) },
      });
      const stale = await import("@/lib/xero-stale-operations");
      expect(await stale.markStaleRunningXeroOperationFailed(OPERATION_ID, async () => {})).toMatchObject({
        outcome: "marked",
        returnedTo: "PARTIAL",
      });
      const recovered = await readRow();
      expect(recovered).toMatchObject({ status: "PARTIAL", lastErrorCode: "ORPHANED_STALE_RUNNING" });
      expect(recovered.responsePayload).toEqual(partialPayload);

      await expect(retry.retryXeroSyncOperation(OPERATION_ID, CLUB_FORMAT_TEST)).resolves.toEqual({
        message: "Repaired Xero modification credit note allocation.",
      });
      expect(createCreditNoteAllocation).toHaveBeenCalledTimes(1);
      expect(await readRow()).toMatchObject({ status: "SUCCEEDED", lastErrorCode: null });
    });
  },
);
