/**
 * Real-PostgreSQL proof of `INV-INT-038` (the #4921 prerequisite): an inbound
 * webhook reconcile whose process died leaves its `WEBHOOK_RECONCILE` row
 * RUNNING, and a later attempt for the same event recovers it under a fresh
 * claim - never sharing the abandoned claim - while the active-correlation-key
 * index keeps one row live.
 *
 * What is driven through the app's own writers, and what is seeded:
 * - SEEDED: the abandoned attempt's RUNNING row, claimed 16 minutes before the
 *   frozen clock (past `STALE_RUNNING_XERO_OPERATION_MINUTES`); for the replay,
 *   its event left PROCESSING with its dedup row, aged the same way.
 * - REAL: the officer's Replay (`replayStoredXeroInboundEvent`) through the
 *   stored-event worker, whose event category has no handler, so no provider
 *   is reached; the inbound start (`startInboundReconcileOperation`); the
 *   officer's Mark failed (`markStaleRunningXeroOperationFailed`); and both
 *   outcome writers (`completeXeroSyncOperation`, `failXeroSyncOperation`)
 *   under `outcomeWriteGuard`.
 *
 * Proven:
 * - a replay recovers the abandoned row: one row, SUCCEEDED under a fresh
 *   claim, its attempt counted, the event PROCESSED;
 * - two attempts racing to take one abandoned row over: exactly one wins,
 *   the other fails as in flight, and the row carries the winner's claim;
 * - a takeover racing an officer's Mark failed: exactly one of them changes
 *   the abandoned claim, and at most one row stays live for the key;
 * - the abandoned attempt's late success and late failure are refused while
 *   the new claim runs, and its late failure is refused after the new claim
 *   succeeds;
 * - a live attempt's row is never taken over.
 *
 * Ordinary Vitest runs skip the whole file. It reuses the guarded, disposable
 * loopback PostgreSQL `concurrency-lock-races.realdb.test.ts` provisions, which
 * imports this file so CI reaches it; it owns and cleans its own `race-alp546-`
 * fixtures.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { CLUB_FORMAT_TEST } from "@/lib/__tests__/support/club-format-fixture";
import { assertSafeRaceDbUrl } from "@/lib/__tests__/support/race-db-url";
import { FROZEN_TEST_CLOCK_BASE_ISO } from "@/lib/__tests__/helpers/clock";

const RUN = process.env.RUN_CONCURRENCY_RACE_TESTS === "1";
const RACE_DB_URL = process.env.CONCURRENCY_RACE_DATABASE_URL ?? "";

const P = "race-alp546";
const KEY = `${P}-event`;
const NOW = new Date(FROZEN_TEST_CLOCK_BASE_ISO);
/** The abandoned claim: past the 15-minute stale threshold. */
const ABANDONED_AT = new Date(NOW.getTime() - 16 * 60_000);
/** A claim still in flight: inside the threshold. */
const LIVE_AT = new Date(NOW.getTime() - 5 * 60_000);
const ROUNDS = 8;

let prisma: (typeof import("@/lib/prisma"))["prisma"];

(RUN ? describe : describe.skip)(
  "an abandoned inbound Xero reconcile operation is recovered under a fresh claim - real PostgreSQL (INV-INT-038)",
  { timeout: 60_000 },
  () => {
    async function clear() {
      await prisma.xeroSyncOperation.deleteMany({ where: { correlationKey: { startsWith: P } } });
      await prisma.processedWebhookEvent.deleteMany({ where: { eventId: { startsWith: P }, source: "xero" } });
      await prisma.xeroInboundEvent.deleteMany({ where: { correlationKey: { startsWith: P } } });
    }

    beforeAll(async () => {
      assertSafeRaceDbUrl(RACE_DB_URL, "Abandoned inbound Xero reconcile operation (INV-INT-038)");
      process.env.DATABASE_URL = RACE_DB_URL;
      ({ prisma } = await import("@/lib/prisma"));
      await clear();
    }, 60_000);

    beforeEach(async () => {
      const format = await import("@/lib/club-format-server");
      vi.spyOn(format, "clubFormatValues").mockResolvedValue(CLUB_FORMAT_TEST);
      // A failure's repeated-failure alert reaches no officer from this test.
      const hardening = await import("@/lib/xero-hardening");
      vi.spyOn(hardening, "maybeNotifyXeroRepeatedFailure").mockResolvedValue(undefined as never);
    });

    afterEach(async () => {
      vi.restoreAllMocks();
      vi.setSystemTime(NOW);
      await clear();
    });

    afterAll(async () => {
      if (prisma) await clear();
    }, 60_000);

    /** The row a dead attempt left: RUNNING under its claim, nothing reaps it. */
    function abandonedRow(correlationKey: string, startedAt = ABANDONED_AT) {
      return prisma.xeroSyncOperation.create({
        data: {
          direction: "INBOUND", entityType: "WIDGET", operationType: "WEBHOOK_RECONCILE", status: "RUNNING",
          correlationKey, replayable: true, requestPayload: { resourceId: `${P}-resource` }, startedAt,
        },
      });
    }

    const rows = (correlationKey: string) =>
      prisma.xeroSyncOperation.findMany({ where: { correlationKey }, orderBy: { createdAt: "asc" } });

    async function start(correlationKey: string) {
      const { startInboundReconcileOperation } = await import("@/lib/xero-inbound/reconcile-operation");
      return startInboundReconcileOperation({ entityType: "WIDGET", correlationKey, requestPayload: { resourceId: `${P}-resource` } });
    }

    it("a replay of the stuck event recovers the abandoned row under a fresh claim", async () => {
      const abandoned = await abandonedRow(KEY);
      const event = await prisma.xeroInboundEvent.create({
        data: { eventCategory: "WIDGET", eventType: "UPDATE", resourceId: `${P}-resource`, correlationKey: KEY, payload: {}, status: "PROCESSING" },
      });
      await prisma.processedWebhookEvent.create({ data: { eventId: KEY, source: "xero", eventType: "WIDGET.UPDATE" } });
      await prisma.$executeRaw`UPDATE "XeroInboundEvent" SET "updatedAt" = ${ABANDONED_AT} WHERE "id" = ${event.id}`;

      const { replayStoredXeroInboundEvent } = await import("@/lib/xero-inbound/event-processing");
      const replayed = await replayStoredXeroInboundEvent(event.id);

      expect(replayed.result).toMatchObject({ processed: 1, succeeded: 1, failed: 0 });
      expect(replayed.event.status).toBe("PROCESSED");
      const [row, ...others] = await rows(KEY);
      expect(others).toEqual([]);
      expect(row).toMatchObject({ id: abandoned.id, status: "SUCCEEDED", attemptCount: 2, lastErrorCode: null, startedAt: NOW });
    });

    it("of two attempts racing to take one abandoned row over, exactly one wins", async () => {
      const { XeroInboundReconcileInFlightError } = await import("@/lib/xero-inbound/reconcile-operation");
      for (let round = 0; round < ROUNDS; round += 1) {
        const key = `${KEY}-takeover-${round}`;
        const abandoned = await abandonedRow(key);

        const settled = await Promise.allSettled([start(key), start(key)]);

        const won = settled.filter((result) => result.status === "fulfilled");
        const lost = settled.filter((result) => result.status === "rejected");
        expect(won).toHaveLength(1);
        expect(lost).toHaveLength(1);
        expect((lost[0] as PromiseRejectedResult).reason).toBeInstanceOf(XeroInboundReconcileInFlightError);
        const claim = (won[0] as PromiseFulfilledResult<Awaited<ReturnType<typeof start>>>).value;
        const [row, ...others] = await rows(key);
        expect(others).toEqual([]);
        expect(row).toMatchObject({ id: abandoned.id, status: "RUNNING", attemptCount: 2, startedAt: claim.startedAt });
        expect(claim.startedAt).not.toEqual(ABANDONED_AT);
      }
    });

    it("a takeover racing an officer's Mark failed: one of them changes the abandoned claim, one row stays live", async () => {
      const { markStaleRunningXeroOperationFailed } = await import("@/lib/xero-stale-operations");
      for (let round = 0; round < ROUNDS; round += 1) {
        const key = `${KEY}-mark-${round}`;
        const abandoned = await abandonedRow(key);

        const [claim, marked] = await Promise.all([start(key), markStaleRunningXeroOperationFailed(abandoned.id, async () => undefined)]);

        const all = await rows(key);
        expect(all.filter((row) => row.status === "RUNNING")).toHaveLength(1);
        if (marked.outcome === "marked") {
          // The officer ended the abandoned claim first; this attempt inserted its own row.
          expect(all.find((row) => row.id === abandoned.id)).toMatchObject({ status: "FAILED", startedAt: ABANDONED_AT });
          expect(claim.id).not.toBe(abandoned.id);
        } else {
          // The takeover won; the mark found the claim it read gone.
          expect(marked).toEqual({ outcome: "not-stale", status: "RUNNING" });
          expect(all).toHaveLength(1);
          expect(claim).toMatchObject({ id: abandoned.id, startedAt: NOW });
        }
      }
    });

    it("refuses the abandoned attempt's late success and late failure; the new claim's outcome stands", async () => {
      const { completeXeroSyncOperation, failXeroSyncOperation } = await import("@/lib/xero-sync");
      const abandoned = await abandonedRow(KEY);
      const abandonedClaim = { id: abandoned.id, startedAt: ABANDONED_AT };

      const claim = await start(KEY);
      expect(claim).toMatchObject({ id: abandoned.id, startedAt: NOW });

      // While the new claim runs: neither of the dead attempt's outcomes lands.
      await expect(completeXeroSyncOperation(abandonedClaim, { responsePayload: { from: "abandoned" } })).resolves.toBeNull();
      await expect(failXeroSyncOperation(abandonedClaim, new Error("abandoned attempt failed late"))).resolves.toBeNull();
      expect(await prisma.xeroSyncOperation.findUniqueOrThrow({ where: { id: abandoned.id } })).toMatchObject({ status: "RUNNING", startedAt: NOW });

      // The new claim's own success lands, and a late failure after it is still refused.
      await expect(completeXeroSyncOperation(claim, { responsePayload: { from: "recovery" } })).resolves.toMatchObject({ status: "SUCCEEDED" });
      await expect(failXeroSyncOperation(abandonedClaim, new Error("abandoned attempt failed later still"))).resolves.toBeNull();
      expect(await prisma.xeroSyncOperation.findUniqueOrThrow({ where: { id: abandoned.id } })).toMatchObject({
        status: "SUCCEEDED", startedAt: NOW, responsePayload: { from: "recovery" },
      });
    });

    it("never takes over a live attempt's row", async () => {
      const { XeroInboundReconcileInFlightError } = await import("@/lib/xero-inbound/reconcile-operation");
      const live = await abandonedRow(KEY, LIVE_AT);

      await expect(start(KEY)).rejects.toBeInstanceOf(XeroInboundReconcileInFlightError);
      expect(await rows(KEY)).toEqual([expect.objectContaining({ id: live.id, status: "RUNNING", attemptCount: 1, startedAt: LIVE_AT })]);
    });
  },
);
