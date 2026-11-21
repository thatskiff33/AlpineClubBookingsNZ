/**
 * Real-PostgreSQL proof of #5228's repair for rows already stuck: the
 * read-only report lists every PENDING outbox row holding no request the
 * outbox can send, the owner's release moves exactly those rows to FAILED -
 * skipping any that changed since the report - and an officer's Retry then
 * sends the document.
 *
 * What is driven through the app's own writers, and what is seeded:
 * - SEEDED: the booking history, a card refund as the webhook records it, and
 *   the one write a give-back made before #5228 (`strandAsBeforeTheFix`): the
 *   real handler saves its execution request, then the row is put back on
 *   PENDING exactly as that give-back wrote it.
 * - REAL: the refund-note enqueue, the outbox worker, the report and release
 *   (`xero-stuck-queued-request.ts`) and its command line, and the officer's
 *   Retry - queued by `enqueueXeroSyncOperationRetry` and drained by
 *   `processQueuedXeroOperationRetries`, as the Retry button and the cron run
 *   them - against a fake Xero (no provider call).
 *
 * Ordinary Vitest runs skip the whole file. It reuses the guarded, disposable
 * loopback PostgreSQL `concurrency-lock-races.realdb.test.ts` provisions, which
 * imports this file so CI reaches it; it owns and cleans its own `race-5228s-`
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
  strandAsBeforeTheFix,
  type SentDocument,
} from "./support/xero-queued-request-fixtures";

const RUN = process.env.RUN_CONCURRENCY_RACE_TESTS === "1";
const RACE_DB_URL = process.env.CONCURRENCY_RACE_DATABASE_URL ?? "";

const PREFIX = "race-5228s-";
const names = historyNames(PREFIX);
const PRICE = 20_000;
const RELEASED_AT = new Date("2026-07-01T01:00:00.000Z");

let prisma: PrismaClient;
let stuck: typeof import("@/lib/xero-stuck-queued-request");

const ROW_FIELDS = {
  status: true, requestPayload: true, responsePayload: true, idempotencyKey: true, correlationKey: true, xeroObjectId: true,
  startedAt: true, completedAt: true, lastErrorCode: true, manuallyResolvedAt: true,
} as const;
const readRow = (id: string) => prisma.xeroSyncOperation.findUniqueOrThrow({ where: { id }, select: ROW_FIELDS });

/** Only this suite's rows: the report reads the whole table, which other suites share. */
async function reported() {
  return (await stuck.findStuckQueuedRequestRows(prisma)).filter((row) => row.localId?.startsWith(PREFIX));
}

let sequence = 0;

(RUN ? describe : describe.skip)(
  "Xero outbox rows stuck without a queued request are listed, released for an officer and retried - real PostgreSQL (#5228)",
  { timeout: 180_000 },
  () => {
    beforeAll(async () => {
      assertSafeRaceDbUrl(RACE_DB_URL, "Stuck queued-request report and release (#5228)");
      process.env.DATABASE_URL = RACE_DB_URL;
      ({ prisma } = await import("@/lib/prisma"));
      stuck = await import("@/lib/xero-stuck-queued-request");
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

    /** A paid booking whose $50 refund note a pre-#5228 give-back left stuck. */
    async function stuckRefundNote() {
      const { paymentId, invoiceRow } = await paidCardBooking(prisma, names, `${PREFIX}b${++sequence}`, PRICE);
      expect(await runOutboxRow(prisma, invoiceRow, PREFIX)).toMatchObject({ succeeded: 1 });
      await recordCardRefund(prisma, paymentId, 5_000, "a");
      const noteRow = await queueRefundNote(paymentId, 5_000);
      await strandAsBeforeTheFix(prisma, noteRow, refuse, "createCreditNotes", PREFIX);
      sent.length = 0;
      return { paymentId, invoiceRow, noteRow };
    }

    it("the outbox never scans a stuck row and counts it; the report lists it and nothing else, and changes nothing", async () => {
      const { paymentId, invoiceRow, noteRow } = await stuckRefundNote();
      const before = await readRow(noteRow);

      expect(await runOutboxRow(prisma, noteRow, PREFIX)).toEqual({ found: 0, processed: 0, succeeded: 0, failed: 0, skipped: 0, unclaimableRequest: 1 });
      expect(sent).toEqual([]);

      // Not listed: the SUCCEEDED invoice row (its execution request is history), a
      // stuck-shaped row an officer resolved, and one a run holds.
      const resolved = await prisma.xeroSyncOperation.create({
        data: {
          direction: "OUTBOUND", entityType: "CREDIT_NOTE", operationType: "CREATE", localModel: "Payment", localId: paymentId, status: "PENDING",
          queueType: "REFUND_CREDIT_NOTE", requestPayload: before.requestPayload!, manuallyResolvedAt: new Date("2026-06-30T00:00:00.000Z"),
        },
      });
      const running = await prisma.xeroSyncOperation.create({
        data: {
          direction: "OUTBOUND", entityType: "CREDIT_NOTE", operationType: "CREATE", localModel: "Payment", localId: paymentId, status: "RUNNING",
          startedAt: new Date(), queueType: "REFUND_CREDIT_NOTE", requestPayload: before.requestPayload!,
        },
      });
      expect(await reported()).toEqual([
        { id: noteRow, queueType: "REFUND_CREDIT_NOTE", localModel: "Payment", localId: paymentId, createdAt: expect.any(Date) },
      ]);
      expect((await reported()).map((row) => row.id)).not.toContain(invoiceRow);
      expect(await readRow(noteRow)).toEqual(before);
      expect(await readRow(resolved.id)).toMatchObject({ status: "PENDING" });
      expect(await readRow(running.id)).toMatchObject({ status: "RUNNING" });
    });

    it("MUTATION: stuck rows queued ahead never hold up the work behind them, even for a single-row kick", async () => {
      const { paymentId, invoiceRow } = await paidCardBooking(prisma, names, `${PREFIX}b${++sequence}`, PRICE);
      // Eleven rows a give-back left stuck, older than anything else queued: more than a default batch of ten.
      const stuckRows = await Promise.all(Array.from({ length: 11 }, (_, index) => prisma.xeroSyncOperation.create({
        data: {
          direction: "OUTBOUND", entityType: "CREDIT_NOTE", operationType: "CREATE", localModel: "Payment", localId: paymentId, status: "PENDING",
          queueType: "REFUND_CREDIT_NOTE", requestPayload: { creditNotes: [{ total: 1 }], allocation: { invoiceId: "inv-x", amount: 1 } },
          createdAt: new Date(Date.UTC(2000, 0, 1, 0, 0, index)),
        },
      })));

      expect(await runOutboxRow(prisma, invoiceRow, PREFIX)).toEqual({ found: 1, processed: 1, succeeded: 1, failed: 0, skipped: 0, unclaimableRequest: 11 });
      expect(sent).toEqual([{ operation: "createInvoices", cents: PRICE }]);
      expect(await prisma.xeroSyncOperation.count({ where: { id: { in: stuckRows.map((row) => row.id) }, status: "PENDING", startedAt: null } })).toBe(11);
    });

    it("release moves exactly the reported row to FAILED and keeps everything else on it; a second release changes nothing; an officer's Retry sends the note once", async () => {
      const { noteRow } = await stuckRefundNote();
      const before = await readRow(noteRow);
      const report = await reported();

      expect(await stuck.releaseStuckQueuedRequestRows(prisma, report, RELEASED_AT)).toEqual({ released: [noteRow], skipped: [] });
      const released = await readRow(noteRow);
      expect(released).toEqual({
        ...before,
        status: "FAILED",
        completedAt: RELEASED_AT,
        lastErrorCode: "QUEUED_REQUEST_RELEASED",
      });
      expect(sent).toEqual([]);
      expect(await reported()).toEqual([]);

      // Repeat: the row is no longer PENDING, so it is skipped and left as it is.
      expect(await stuck.releaseStuckQueuedRequestRows(prisma, report, RELEASED_AT)).toEqual({
        released: [],
        skipped: [{ id: noteRow, why: expect.stringContaining("no longer") }],
      });
      expect(await readRow(noteRow)).toEqual(released);

      // The officer's Retry, queued and drained as the button and the cron run it.
      const { enqueueXeroSyncOperationRetry, processQueuedXeroOperationRetries } = await import("@/lib/xero-operation-queue");
      await enqueueXeroSyncOperationRetry(noteRow, { createdByMemberId: names.officerId });
      expect(await processQueuedXeroOperationRetries({ limit: 5 }, CLUB_FORMAT_TEST)).toMatchObject({ succeeded: 1, failed: 0 });
      expect(sent).toEqual([{ operation: "createCreditNotes", cents: 5_000 }]);
      // And a second drain, or the outbox, sends nothing more.
      expect(await processQueuedXeroOperationRetries({ limit: 5 }, CLUB_FORMAT_TEST)).toMatchObject({ succeeded: 0 });
      expect(sent).toHaveLength(1);
    });

    it("MUTATION: release skips, and leaves exactly as it is, a reported row that a run claimed, that was resolved, or whose request changed since the report", async () => {
      const claimed = await stuckRefundNote();
      const resolved = await stuckRefundNote();
      const rewritten = await stuckRefundNote();
      const report = await reported();
      expect(report.map((row) => row.id).sort()).toEqual([claimed.noteRow, resolved.noteRow, rewritten.noteRow].sort());

      // Each change lands between the report and the release.
      await prisma.xeroSyncOperation.update({ where: { id: claimed.noteRow }, data: { status: "RUNNING", startedAt: new Date() } });
      await prisma.xeroSyncOperation.update({ where: { id: resolved.noteRow }, data: { manuallyResolvedAt: new Date() } });
      const queued = { queueType: "REFUND_CREDIT_NOTE", refundAmountCents: 5_000 };
      await prisma.xeroSyncOperation.update({ where: { id: rewritten.noteRow }, data: { requestPayload: queued } });
      const after = await Promise.all([claimed.noteRow, resolved.noteRow, rewritten.noteRow].map(readRow));

      const release = await stuck.releaseStuckQueuedRequestRows(prisma, report, RELEASED_AT);
      expect(release.released).toEqual([]);
      expect(release.skipped.map((skip) => skip.id).sort()).toEqual([claimed.noteRow, resolved.noteRow, rewritten.noteRow].sort());
      expect(await Promise.all([claimed.noteRow, resolved.noteRow, rewritten.noteRow].map(readRow))).toEqual(after);
    });

    it("the command line reports without changing anything, and --release releases what it listed", async () => {
      const { noteRow } = await stuckRefundNote();
      const out: string[] = [];
      const io = { db: prisma, now: () => RELEASED_AT, out: (text: string) => void out.push(text), err: (text: string) => void out.push(`ERR ${text}`) };

      expect(await stuck.runStuckQueuedRequestReportCli([], io)).toBe(0);
      expect(out.join("\n")).toContain(noteRow);
      expect((await readRow(noteRow)).status).toBe("PENDING");

      expect(await stuck.runStuckQueuedRequestReportCli(["--relase"], io)).toBe(1);
      expect((await readRow(noteRow)).status).toBe("PENDING");

      out.length = 0;
      expect(await stuck.runStuckQueuedRequestReportCli(["--release"], io)).toBe(0);
      expect(out.join("\n")).toMatch(/Released \d+ row\(s\) to FAILED/);
      expect((await readRow(noteRow)).status).toBe("FAILED");
    });
  },
);
