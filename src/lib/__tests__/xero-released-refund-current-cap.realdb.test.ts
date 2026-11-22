/**
 * Real-PostgreSQL proof that a refund credit note released from the stuck
 * state (#5228) and then retried by an officer is sized on the payment as it
 * stands at the Retry, never on the amount its old request names
 * (`INV-PAY-101`, `createXeroCreditNote`'s execution-time cap).
 *
 * The row sat PENDING for as long as nobody noticed, so the payment can have
 * moved on: another note may now cover some or all of the refund. The release
 * keeps the stored request; Retry reads its amount and watermark but bills only
 * what the ledger still shows uncovered - less when coverage grew, nothing when
 * it is all covered - and an unchanged payment gets the one note it was owed,
 * once. The key is not promised to match the old attempt's when the cover
 * changed: a changed cover is a new intent.
 *
 * What is driven through the app's own writers, and what is seeded:
 * - SEEDED: the booking history, a $50 card refund as the webhook records it,
 *   the pre-#5228 give-back's one write (`strandAsBeforeTheFix`), and the
 *   cover that grew meanwhile: an active refund-note link recorded on the
 *   payment, as a note an officer raised by hand and resolved is recorded.
 * - REAL: the refund-note enqueue and handler, the release, and the officer's
 *   Retry queued and drained as the button and the cron run it, against a fake
 *   Xero (no provider call).
 *
 * Ordinary Vitest runs skip the whole file. It reuses the guarded, disposable
 * loopback PostgreSQL `concurrency-lock-races.realdb.test.ts` provisions, which
 * imports this file so CI reaches it; it owns and cleans its own `race-5228c-`
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

const PREFIX = "race-5228c-";
const names = historyNames(PREFIX);
const PRICE = 20_000;
const REFUND = 5_000;

let prisma: PrismaClient;
let sequence = 0;

(RUN ? describe : describe.skip)(
  "a released refund note's Retry bills what the payment still shows uncovered - real PostgreSQL (#5228)",
  { timeout: 180_000 },
  () => {
    beforeAll(async () => {
      assertSafeRaceDbUrl(RACE_DB_URL, "Released refund note's current cap (#5228)");
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

    /** A $50 refund's note, stuck before #5228, then released by the owner. */
    async function releasedRefundNote() {
      const { paymentId, invoiceRow } = await paidCardBooking(prisma, names, `${PREFIX}b${++sequence}`, PRICE);
      expect(await runOutboxRow(prisma, invoiceRow, PREFIX)).toMatchObject({ succeeded: 1 });
      await recordCardRefund(prisma, paymentId, REFUND, "a");
      const noteRow = await queueRefundNote(paymentId, REFUND);
      await strandAsBeforeTheFix(prisma, noteRow, refuse, "createCreditNotes", PREFIX);
      const { findStuckQueuedRequestRows, releaseStuckQueuedRequestRows } = await import("@/lib/xero-stuck-queued-request");
      const report = (await findStuckQueuedRequestRows(prisma)).filter((row) => row.id === noteRow);
      expect(await releaseStuckQueuedRequestRows(prisma, report, new Date())).toMatchObject({ released: [noteRow] });
      sent.length = 0;
      return { paymentId, noteRow };
    }

    /** A note already covering `cents` of the payment's refunds, recorded on it while the row sat stuck. */
    async function coverRecordedMeanwhile(paymentId: string, cents: number) {
      await prisma.xeroObjectLink.create({
        data: {
          localModel: "Payment", localId: paymentId, xeroObjectType: "CREDIT_NOTE", xeroObjectId: `${paymentId}-hand-note`,
          xeroObjectNumber: "CN-HAND", role: "REFUND_CREDIT_NOTE", active: true,
          metadata: { status: "AUTHORISED", amountCents: cents },
        },
      });
    }

    /** The officer's Retry, queued and drained as the button and the cron run it. */
    async function officerRetry(noteRow: string) {
      const { enqueueXeroSyncOperationRetry, processQueuedXeroOperationRetries } = await import("@/lib/xero-operation-queue");
      await enqueueXeroSyncOperationRetry(noteRow, { createdByMemberId: names.officerId });
      return processQueuedXeroOperationRetries({ limit: 5 }, CLUB_FORMAT_TEST);
    }

    it("MUTATION: cover that grew to $30 meanwhile leaves $20 to bill, and Retry sends only that", async () => {
      const { paymentId, noteRow } = await releasedRefundNote();
      await coverRecordedMeanwhile(paymentId, 3_000);

      expect(await officerRetry(noteRow)).toMatchObject({ succeeded: 1, failed: 0 });
      expect(sent).toEqual([{ operation: "createCreditNotes", cents: 2_000 }]);
    });

    it("MUTATION: cover that grew to the whole $50 meanwhile leaves nothing to bill, and Retry creates no note", async () => {
      const { paymentId, noteRow } = await releasedRefundNote();
      await coverRecordedMeanwhile(paymentId, REFUND);

      expect(await officerRetry(noteRow)).toMatchObject({ failed: 0 });
      expect(sent).toEqual([]);
    });

    it("control: an unchanged payment gets its one $50 note, and a second Retry sends nothing more", async () => {
      const { noteRow } = await releasedRefundNote();

      expect(await officerRetry(noteRow)).toMatchObject({ succeeded: 1, failed: 0 });
      expect(sent).toEqual([{ operation: "createCreditNotes", cents: REFUND }]);

      const { enqueueXeroSyncOperationRetry } = await import("@/lib/xero-operation-queue");
      // The original row is now settled by the Retry's note, so it is not queued again, or sends nothing if it is.
      await enqueueXeroSyncOperationRetry(noteRow, { createdByMemberId: names.officerId }).catch(() => undefined);
      const { processQueuedXeroOperationRetries } = await import("@/lib/xero-operation-queue");
      await processQueuedXeroOperationRetries({ limit: 5 }, CLUB_FORMAT_TEST);
      expect(sent).toHaveLength(1);
    });
  },
);
