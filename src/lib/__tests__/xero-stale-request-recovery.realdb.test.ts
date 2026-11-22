/**
 * Real-PostgreSQL proof for #5228's other way out of RUNNING: a worker that
 * dies after its handler saved the execution request never leaves the row on
 * PENDING. The stale reset (`writeStaleRunningXeroOperationReset`) moves it to
 * FAILED - or a stuck PARTIAL repair back to PARTIAL - keeping its request,
 * response and Xero ids, and an officer's Retry then finishes it from what the
 * row holds: the note that was never made is made once, and a note already
 * made and recorded is not made again.
 *
 * What is driven through the app's own writers, and what is seeded:
 * - SEEDED: the booking history, a card refund as the webhook records it, and
 *   the crash: the row put back to RUNNING, claimed long ago, as a worker that
 *   died after its last write leaves it (the one hand-written step).
 * - REAL: the refund-note enqueue and handler (which save the execution
 *   request, and in the second case raise and record the note), the stale
 *   reset, and the officer's Retry queued and drained as the button and the
 *   cron run it, against a fake Xero (no provider call).
 *
 * Ordinary Vitest runs skip the whole file. It reuses the guarded, disposable
 * loopback PostgreSQL `concurrency-lock-races.realdb.test.ts` provisions, which
 * imports this file so CI reaches it; it owns and cleans its own `race-5228r-`
 * fixtures.
 */
import type { PrismaClient } from "@prisma/client";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { cleanHistories, historyNames, seedHistoryFixtures } from "./support/booking-ledger-history";
import { CLUB_FORMAT_TEST } from "./support/club-format-fixture";
import { FROZEN_TEST_CLOCK_BASE_ISO } from "./helpers/clock";
import { assertSafeRaceDbUrl } from "./support/race-db-url";
import {
  fakeXero,
  paidCardBooking,
  queueRefundNote,
  recordCardRefund,
  runOutboxRow,
  type SentDocument,
} from "./support/xero-queued-request-fixtures";

const RUN = process.env.RUN_CONCURRENCY_RACE_TESTS === "1";
const RACE_DB_URL = process.env.CONCURRENCY_RACE_DATABASE_URL ?? "";

const PREFIX = "race-5228r-";
const names = historyNames(PREFIX);
const PRICE = 20_000;
const REFUND = 5_000;
const DIED_AT = new Date("2026-06-30T23:00:00.000Z");

let prisma: PrismaClient;
let sequence = 0;

const ROW_FIELDS = { status: true, requestPayload: true, responsePayload: true, xeroObjectId: true, idempotencyKey: true, correlationKey: true, lastErrorCode: true } as const;
const readRow = (id: string) => prisma.xeroSyncOperation.findUniqueOrThrow({ where: { id }, select: ROW_FIELDS });

(RUN ? describe : describe.skip)(
  "a worker that died after saving its execution request is reset, never left PENDING, and Retry finishes it - real PostgreSQL (#5228)",
  { timeout: 180_000 },
  () => {
    beforeAll(async () => {
      assertSafeRaceDbUrl(RACE_DB_URL, "Stale reset after an execution request (#5228)");
      process.env.DATABASE_URL = RACE_DB_URL;
      ({ prisma } = await import("@/lib/prisma"));
      await cleanHistories(prisma, PREFIX);
      await seedHistoryFixtures(prisma, PREFIX);
    }, 120_000);

    const sent: SentDocument[] = [];
    const refuse = new Map<string, () => Error>();
    beforeEach(async () => {
      vi.setSystemTime(new Date(FROZEN_TEST_CLOCK_BASE_ISO));
      sent.length = 0;
      refuse.clear();
      await fakeXero(PREFIX, sent, refuse);
    });

    afterEach(async () => {
      vi.restoreAllMocks();
      vi.setSystemTime(new Date(FROZEN_TEST_CLOCK_BASE_ISO));
      await prisma.xeroObjectLink.deleteMany({ where: { localId: { startsWith: PREFIX } } });
      await prisma.xeroSyncOperation.deleteMany({ where: { OR: [{ localId: { startsWith: PREFIX } }, { correlationKey: { contains: PREFIX } }] } });
    });

    afterAll(async () => {
      if (prisma) await cleanHistories(prisma, PREFIX);
    }, 120_000);

    /** A paid booking with a $50 card refund and its queued note. */
    async function queuedRefundNote() {
      const { paymentId, invoiceRow } = await paidCardBooking(prisma, names, `${PREFIX}b${++sequence}`, PRICE);
      expect(await runOutboxRow(prisma, invoiceRow, PREFIX)).toMatchObject({ succeeded: 1 });
      await recordCardRefund(prisma, paymentId, REFUND, "a");
      const noteRow = await queueRefundNote(paymentId, REFUND);
      sent.length = 0;
      return { paymentId, noteRow };
    }

    /** The worker died after its last write: RUNNING, claimed long ago, never completed. */
    async function workerDied(operationId: string, lastErrorCode: string | null = null) {
      await prisma.xeroSyncOperation.update({ where: { id: operationId }, data: { status: "RUNNING", startedAt: DIED_AT, completedAt: null, lastErrorCode, lastErrorMessage: null } });
    }

    /** The bulk stale reset, past the stale threshold. */
    async function staleReset(operationId: string) {
      const { STALE_RUNNING_XERO_OPERATION_MINUTES, writeStaleRunningXeroOperationReset } = await import("@/lib/xero-stale-operations");
      const now = new Date(DIED_AT.getTime() + (STALE_RUNNING_XERO_OPERATION_MINUTES + 5) * 60_000);
      return writeStaleRunningXeroOperationReset({ id: operationId, status: "RUNNING", startedAt: { lt: new Date(now.getTime() - STALE_RUNNING_XERO_OPERATION_MINUTES * 60_000) } }, now, "Reset: the worker stopped", prisma);
    }

    async function officerRetry(operationId: string) {
      const { enqueueXeroSyncOperationRetry, processQueuedXeroOperationRetries } = await import("@/lib/xero-operation-queue");
      await enqueueXeroSyncOperationRetry(operationId, { createdByMemberId: names.officerId });
      return processQueuedXeroOperationRetries({ limit: 5 }, CLUB_FORMAT_TEST);
    }

    it("died before the call: reset to FAILED with its execution request kept, never PENDING; Retry raises the note once", async () => {
      const { noteRow } = await queuedRefundNote();
      // The handler saves its execution request, then its call fails; the row is then as a dead worker leaves it.
      refuse.set("createCreditNotes", () => new Error("the worker stopped here"));
      await runOutboxRow(prisma, noteRow, PREFIX);
      await workerDied(noteRow);
      const died = await readRow(noteRow);
      expect(died.requestPayload).toHaveProperty("creditNotes");

      expect(await staleReset(noteRow)).toEqual({ failed: 1, partial: 0 });
      expect(await readRow(noteRow)).toEqual({ ...died, status: "FAILED", lastErrorCode: "ORPHANED_STALE_RUNNING" });

      expect(await officerRetry(noteRow)).toMatchObject({ succeeded: 1, failed: 0 });
      expect(sent).toEqual([{ operation: "createCreditNotes", cents: REFUND }]);
    });

    it("died after the note was made and recorded: reset to FAILED keeping the note's id; Retry makes no second note", async () => {
      const { noteRow } = await queuedRefundNote();
      expect(await runOutboxRow(prisma, noteRow, PREFIX)).toMatchObject({ succeeded: 1 });
      expect(sent).toEqual([{ operation: "createCreditNotes", cents: REFUND }]);
      await workerDied(noteRow);
      const died = await readRow(noteRow);
      expect(died.xeroObjectId).toEqual(expect.any(String));

      expect(await staleReset(noteRow)).toEqual({ failed: 1, partial: 0 });
      expect(await readRow(noteRow)).toEqual({ ...died, status: "FAILED", lastErrorCode: "ORPHANED_STALE_RUNNING" });

      await officerRetry(noteRow);
      expect(sent).toHaveLength(1);
    });

    it("a stuck PARTIAL repair goes back to PARTIAL with its request, response and note kept", async () => {
      const { noteRow } = await queuedRefundNote();
      expect(await runOutboxRow(prisma, noteRow, PREFIX)).toMatchObject({ succeeded: 1 });
      const { XERO_PARTIAL_REPAIR_RUNNING_CODE } = await import("@/lib/xero-stale-operations");
      await workerDied(noteRow, XERO_PARTIAL_REPAIR_RUNNING_CODE);
      const died = await readRow(noteRow);

      expect(await staleReset(noteRow)).toEqual({ failed: 0, partial: 1 });
      expect(await readRow(noteRow)).toEqual({ ...died, status: "PARTIAL", lastErrorCode: "ORPHANED_STALE_RUNNING" });
    });
  },
);
