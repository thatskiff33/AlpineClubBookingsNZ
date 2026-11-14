/**
 * Real-PostgreSQL proof of `INV-INT-039` (#4921): a stored Xero inbound event a
 * dead worker left PROCESSING is taken over by the automatic worker once it is
 * past the webhook lease, and applied exactly once however many workers race.
 *
 * What is driven through the app's own writers, and what is seeded:
 * - SEEDED: the dead attempt's footprint, aged 16 minutes before the frozen
 *   clock (past `WEBHOOK_PROCESSING_LEASE_MINUTES`): the event PROCESSING, its
 *   `ProcessedWebhookEvent` dedup row (source `xero`), and for the first case
 *   its RUNNING `WEBHOOK_RECONCILE` operation row.
 * - REAL: the automatic worker (`processStoredXeroInboundEvents`, no event ids)
 *   with its takeover step, the stored-event claim, the dedup claim and the
 *   inbound start (`INV-INT-038`). The event category has no handler, so no
 *   provider is reached.
 *
 * Proven:
 * - one automatic run applies the stuck event: the event PROCESSED and an
 *   operation row SUCCEEDED. A takeover that left the dedup row would mark the
 *   event PROCESSED as a duplicate with no operation row, so the row is the
 *   evidence the event was applied, not skipped;
 * - two automatic runs racing over one stuck event apply it exactly once;
 * - of two takeovers racing over one stuck event, exactly one wins, and a
 *   takeover never moves a live or finished event;
 * - an event still inside the lease is not touched.
 *
 * Ordinary Vitest runs skip the whole file. It reuses the guarded, disposable
 * loopback PostgreSQL `concurrency-lock-races.realdb.test.ts` provisions, which
 * imports this file so CI reaches it; it owns and cleans its own `race-alp642-`
 * fixtures, and refuses to run if any other inbound event the automatic worker
 * could select is present, so it never processes another suite's rows.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { CLUB_FORMAT_TEST } from "@/lib/__tests__/support/club-format-fixture";
import { assertSafeRaceDbUrl } from "@/lib/__tests__/support/race-db-url";
import { FROZEN_TEST_CLOCK_BASE_ISO } from "@/lib/__tests__/helpers/clock";

const RUN = process.env.RUN_CONCURRENCY_RACE_TESTS === "1";
const RACE_DB_URL = process.env.CONCURRENCY_RACE_DATABASE_URL ?? "";

const P = "race-alp642";
const KEY = `${P}-event`;
const NOW = new Date(FROZEN_TEST_CLOCK_BASE_ISO);
/** The dead attempt's claim: past the 15-minute webhook lease. */
const ABANDONED_AT = new Date(NOW.getTime() - 16 * 60_000);
/** A claim still in flight: inside the lease. */
const LIVE_AT = new Date(NOW.getTime() - 5 * 60_000);
const ROUNDS = 8;

let prisma: (typeof import("@/lib/prisma"))["prisma"];

(RUN ? describe : describe.skip)(
  "a stale PROCESSING Xero inbound event is taken over and applied exactly once - real PostgreSQL (INV-INT-039)",
  { timeout: 60_000 },
  () => {
    async function clear() {
      await prisma.xeroSyncOperation.deleteMany({ where: { correlationKey: { startsWith: P } } });
      await prisma.processedWebhookEvent.deleteMany({ where: { eventId: { startsWith: P }, source: "xero" } });
      await prisma.xeroInboundEvent.deleteMany({ where: { correlationKey: { startsWith: P } } });
    }

    beforeAll(async () => {
      assertSafeRaceDbUrl(RACE_DB_URL, "Stale PROCESSING Xero inbound event takeover (INV-INT-039)");
      process.env.DATABASE_URL = RACE_DB_URL;
      ({ prisma } = await import("@/lib/prisma"));
      await clear();
    }, 60_000);

    beforeEach(async () => {
      // The automatic worker selects every eligible row, so another suite's
      // leftover would be processed here: refuse rather than touch it.
      const foreign = await prisma.xeroInboundEvent.count({
        where: { correlationKey: { not: { startsWith: P } }, status: { in: ["RECEIVED", "FAILED", "PROCESSING"] } },
      });
      expect(foreign).toBe(0);
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

    /** The event a dead worker left: PROCESSING, its dedup row written, aged. */
    async function stuckEvent(correlationKey: string, claimedAt = ABANDONED_AT) {
      const event = await prisma.xeroInboundEvent.create({
        data: { eventCategory: "WIDGET", eventType: "UPDATE", resourceId: `${P}-resource`, correlationKey, payload: {}, status: "PROCESSING" },
      });
      await prisma.processedWebhookEvent.create({ data: { eventId: correlationKey, source: "xero", eventType: "WIDGET.UPDATE" } });
      await prisma.$executeRaw`UPDATE "XeroInboundEvent" SET "updatedAt" = ${claimedAt} WHERE "id" = ${event.id}`;
      return event;
    }

    async function runWorker() {
      const { processStoredXeroInboundEvents } = await import("@/lib/xero-inbound/event-processing");
      return processStoredXeroInboundEvents({ limit: 10 });
    }

    const operations = (correlationKey: string) =>
      prisma.xeroSyncOperation.findMany({ where: { correlationKey }, orderBy: { createdAt: "asc" } });

    it("one automatic run applies the stuck event and recovers its abandoned operation row", async () => {
      const event = await stuckEvent(KEY);
      const abandoned = await prisma.xeroSyncOperation.create({
        data: {
          direction: "INBOUND", entityType: "WIDGET", operationType: "WEBHOOK_RECONCILE", status: "RUNNING",
          correlationKey: KEY, replayable: true, requestPayload: { resourceId: `${P}-resource` }, startedAt: ABANDONED_AT,
        },
      });

      const result = await runWorker();

      expect(result).toMatchObject({ found: 1, processed: 1, succeeded: 1, failed: 0, skipped: 0 });
      expect(await prisma.xeroInboundEvent.findUniqueOrThrow({ where: { id: event.id } })).toMatchObject({ status: "PROCESSED" });
      const [row, ...others] = await operations(KEY);
      expect(others).toEqual([]);
      expect(row).toMatchObject({ id: abandoned.id, status: "SUCCEEDED", attemptCount: 2, startedAt: NOW });
    });

    it("of two automatic runs racing over one stuck event, it is applied exactly once", async () => {
      for (let round = 0; round < ROUNDS; round += 1) {
        const key = `${KEY}-race-${round}`;
        const event = await stuckEvent(key);

        const results = await Promise.all([runWorker(), runWorker()]);

        expect(results.reduce((sum, result) => sum + result.succeeded, 0)).toBe(1);
        expect(results.reduce((sum, result) => sum + result.failed, 0)).toBe(0);
        expect(await prisma.xeroInboundEvent.findUniqueOrThrow({ where: { id: event.id } })).toMatchObject({ status: "PROCESSED" });
        expect(await operations(key)).toEqual([expect.objectContaining({ status: "SUCCEEDED", attemptCount: 1 })]);
        await clear();
      }
    });

    it("of two takeovers racing over one stuck event (a worker and a Replay), exactly one wins and the row is RECEIVED once", async () => {
      const { takeOverStaleProcessingXeroInboundEvent } = await import("@/lib/xero-inbound/stale-event-takeover");
      for (let round = 0; round < ROUNDS; round += 1) {
        const key = `${KEY}-takeover-${round}`;
        const event = await stuckEvent(key);
        const target = { id: event.id, correlationKey: key };

        const won = await Promise.all([
          takeOverStaleProcessingXeroInboundEvent(target, NOW),
          takeOverStaleProcessingXeroInboundEvent(target, NOW),
        ]);

        expect(won.filter(Boolean)).toHaveLength(1);
        expect(await prisma.xeroInboundEvent.findUniqueOrThrow({ where: { id: event.id } })).toMatchObject({ status: "RECEIVED" });
        expect(await prisma.processedWebhookEvent.count({ where: { eventId: key, source: "xero" } })).toBe(0);
        await clear();
      }
    });

    it("a takeover never resets a live or reclaimed event, nor clears its dedup row", async () => {
      const { takeOverStaleProcessingXeroInboundEvent } = await import("@/lib/xero-inbound/stale-event-takeover");
      const live = await stuckEvent(KEY, LIVE_AT);
      const done = await stuckEvent(`${KEY}-done`);
      await prisma.$executeRaw`UPDATE "XeroInboundEvent" SET "status" = 'PROCESSED' WHERE "id" = ${done.id}`;

      await expect(takeOverStaleProcessingXeroInboundEvent({ id: live.id, correlationKey: KEY }, NOW)).resolves.toBe(false);
      await expect(takeOverStaleProcessingXeroInboundEvent({ id: done.id, correlationKey: `${KEY}-done` }, NOW)).resolves.toBe(false);

      expect(await prisma.xeroInboundEvent.findUniqueOrThrow({ where: { id: live.id } })).toMatchObject({ status: "PROCESSING" });
      expect(await prisma.xeroInboundEvent.findUniqueOrThrow({ where: { id: done.id } })).toMatchObject({ status: "PROCESSED" });
      expect(await prisma.processedWebhookEvent.count({ where: { eventId: { in: [KEY, `${KEY}-done`] }, source: "xero" } })).toBe(2);
    });

    it("leaves an event still inside the lease alone", async () => {
      const event = await stuckEvent(KEY, LIVE_AT);

      const result = await runWorker();

      expect(result).toMatchObject({ found: 0, processed: 0, skipped: 0 });
      expect(await prisma.xeroInboundEvent.findUniqueOrThrow({ where: { id: event.id } })).toMatchObject({
        status: "PROCESSING", updatedAt: LIVE_AT,
      });
      expect(await prisma.processedWebhookEvent.count({ where: { eventId: KEY, source: "xero" } })).toBe(1);
      expect(await operations(KEY)).toEqual([]);
    });
  },
);
