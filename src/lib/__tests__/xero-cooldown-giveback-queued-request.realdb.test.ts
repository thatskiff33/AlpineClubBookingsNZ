/**
 * Real-PostgreSQL proof of #5228 (`INV-INT-025`, `INV-INT-029`): a queued Xero
 * operation that a pre-HTTP cooldown refuses AFTER its handler saved the
 * execution request on the row goes back to PENDING in a shape the next pass
 * can claim and send - it is never left PENDING and skipped on every pass.
 *
 * Before the fix the handler's execution request (`creditNotes`/`invoices`, no
 * `queueType`) stayed on the row, the outbox built the fallback claim (an
 * invoice for a member) from it, could not claim the row, and skipped it for
 * ever: the refund note, booking invoice or group invoice never reached Xero,
 * and nothing failed or alerted. The refund-note and booking-invoice cases
 * failed on `main` before the fix (commit "Reproduce #5228").
 *
 * What is driven through the app's own writers, and what is seeded:
 * - SEEDED: the booking and group histories (`booking-ledger-history`,
 *   `booking-ledger-group-history`), a card refund as the webhook records it.
 * - REAL: the card settle (which enqueues the booking invoice), the refund-note
 *   and group-invoice enqueues, the outbox worker and the real handlers
 *   (`createXeroInvoiceForBooking`, `createXeroCreditNote`,
 *   `createXeroInvoiceForGroupSettlement`), each saving its execution request
 *   before the refused call. Xero is a fake (no provider call); `callXeroApi`
 *   refuses the named create once with the breaker's own pre-HTTP
 *   `XeroTransientOutageError`, as the breaker raises it.
 *
 * Ordinary Vitest runs skip the whole file. It reuses the guarded, disposable
 * loopback PostgreSQL `concurrency-lock-races.realdb.test.ts` provisions, which
 * imports this file so CI reaches it; it owns and cleans its own `race-5228-`
 * fixtures.
 */
import type { PrismaClient } from "@prisma/client";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { cleanHistories, historyNames, postHistoryEdit, seedHistoryFixtures } from "./support/booking-ledger-history";
import { createGroupHistory, GROUP_CHILD_CENTS, groupHistory } from "./support/booking-ledger-group-history";
import { FROZEN_TEST_CLOCK_BASE_ISO } from "./helpers/clock";
import type { SuiteEnvironmentRoleDeclaration } from "./helpers/environment-role";
import { assertSafeRaceDbUrl } from "./support/race-db-url";
import {
  breakerRefusal,
  fakeXero,
  paidCardBooking,
  queueRefundNote,
  recordCardRefund,
  runOutboxRow,
  type SentDocument,
} from "./support/xero-queued-request-fixtures";

const RUN = process.env.RUN_CONCURRENCY_RACE_TESTS === "1";
const RACE_DB_URL = process.env.CONCURRENCY_RACE_DATABASE_URL ?? "";

const PREFIX = "race-5228-";
const names = historyNames(PREFIX);
const PRICE = 20_000;

let prisma: PrismaClient;

async function row(operationId: string) {
  return prisma.xeroSyncOperation.findUniqueOrThrow({
    where: { id: operationId },
    select: { status: true, queueType: true, requestPayload: true, startedAt: true, completedAt: true, lastErrorCode: true },
  });
}

let sequence = 0;
let role: SuiteEnvironmentRoleDeclaration | undefined;

(RUN ? describe : describe.skip)(
  "a queued Xero operation a pre-HTTP cooldown refuses goes back to PENDING claimable - real PostgreSQL (#5228)",
  { timeout: 180_000 },
  () => {
    beforeAll(async () => {
      assertSafeRaceDbUrl(RACE_DB_URL, "Cooldown give-back keeps the queued request (#5228)");
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
      role?.restore();
      role = undefined;
      vi.restoreAllMocks();
      vi.setSystemTime(new Date(FROZEN_TEST_CLOCK_BASE_ISO));
      // Each case's rows, so a row one case left stuck is never the next case's oldest.
      await prisma.xeroObjectLink.deleteMany({ where: { localId: { startsWith: PREFIX } } });
      await prisma.xeroSyncOperation.deleteMany({ where: { localId: { startsWith: PREFIX } } });
    });

    afterAll(async () => {
      if (prisma) await cleanHistories(prisma, PREFIX);
    }, 120_000);

    /** The refused pass gives the row back with its queued request; the next pass sends it once. */
    async function refusedThenSent(operationId: string, call: SentDocument["operation"], queued: Record<string, unknown>, cents: number) {
      refuse.set(call, await breakerRefusal());

      const refused = await runOutboxRow(prisma, operationId);
      expect(refused).toMatchObject({ processed: 1, skipped: 1, failed: 0, cooldownDeferred: 1 });
      expect(sent).toEqual([]);
      const given = await row(operationId);
      expect(given).toMatchObject({ status: "PENDING", startedAt: null, completedAt: null, lastErrorCode: null });
      expect(given.requestPayload).toMatchObject(queued);

      const resent = await runOutboxRow(prisma, operationId);
      expect(resent).toMatchObject({ processed: 1, succeeded: 1, skipped: 0, failed: 0 });
      expect(sent).toEqual([{ operation: call, cents }]);
      expect((await row(operationId)).status).toBe("SUCCEEDED");
    }

    it("REPRO: a booking invoice refused by the breaker after its handler saved the invoice goes back PENDING with its queued request, and the next pass sends it once", async () => {
      const { bookingId, invoiceRow } = await paidCardBooking(prisma, names, `${PREFIX}b${++sequence}`, PRICE);
      await refusedThenSent(invoiceRow, "createInvoices", { queueType: "BOOKING_INVOICE", bookingId }, PRICE);
    });

    it("REPRO: a refund credit note refused by the breaker after its handler saved the note goes back PENDING with its queued request, and the next pass sends it once", async () => {
      const { paymentId, invoiceRow } = await paidCardBooking(prisma, names, `${PREFIX}b${++sequence}`, PRICE);
      expect(await runOutboxRow(prisma, invoiceRow)).toMatchObject({ succeeded: 1 });
      sent.length = 0;
      await recordCardRefund(prisma, paymentId, 5_000, "a");
      const noteRow = await queueRefundNote(paymentId, 5_000);

      await refusedThenSent(noteRow, "createCreditNotes", { queueType: "REFUND_CREDIT_NOTE", refundAmountCents: 5_000 }, 5_000);
    });

    it("a booking change's credit note refused by the breaker after its handler saved the note goes back PENDING with its queued request, and the next pass sends it once", async () => {
      const { bookingId, invoiceRow } = await paidCardBooking(prisma, names, `${PREFIX}b${++sequence}`, PRICE);
      expect(await runOutboxRow(prisma, invoiceRow)).toMatchObject({ succeeded: 1 });
      sent.length = 0;
      const modificationId = `${bookingId}-edit`;
      await postHistoryEdit(prisma, names, bookingId, modificationId, { removeGuestId: `${bookingId}-g2`, changeFeeCents: 0 });
      const { enqueueXeroModificationCreditNoteOperation } = await import("@/lib/xero-operation-outbox");
      const noteRow = (await enqueueXeroModificationCreditNoteOperation({ bookingId, refundAmountCents: 10_000, bookingModificationId: modificationId })).queueOperationId!;
      expect(noteRow).toEqual(expect.any(String));

      await refusedThenSent(noteRow, "createCreditNotes", { queueType: "MODIFICATION_CREDIT_NOTE", bookingId, refundAmountCents: 10_000 }, 10_000);
    });

    it("a joining fee invoice refused by the breaker after its handler saved the invoice goes back PENDING with its queued request, and the next pass sends it once", async () => {
      const { enqueueXeroEntranceFeeInvoiceOperation } = await import("@/lib/xero-operation-outbox");
      const feeRow = (await enqueueXeroEntranceFeeInvoiceOperation(names.memberId, { amountCents: 7_500 })).queueOperationId!;
      expect(feeRow).toEqual(expect.any(String));

      await refusedThenSent(feeRow, "createInvoices", { queueType: "ENTRANCE_FEE_INVOICE", feeAmountCents: 7_500 }, 7_500);
    });

    it("a group settlement invoice refused by the breaker after its handler saved the invoice goes back PENDING with its queued request, and the next pass sends it once", async () => {
      const g = groupHistory(PREFIX, `g${++sequence}`, "INTERNET_BANKING", 2);
      await createGroupHistory(prisma, names, g);
      // Not yet invoiced: the combined invoice is what the row raises.
      await prisma.groupBookingSettlement.update({ where: { id: g.settlement }, data: { xeroInvoiceId: null } });
      // The group invoice's email is gated on a declared environment; a copy, here.
      const { declareEnvironmentRoleForSuite } = await import("./helpers/environment-role");
      role = declareEnvironmentRoleForSuite("non-production");
      const allow = { kind: "allow", clearance: {} } as never;
      const invoiceEmail = await import("@/lib/xero-invoice-email");
      vi.spyOn(invoiceEmail, "resolveXeroInvoiceEmailPolicy").mockResolvedValue(allow);
      vi.spyOn(invoiceEmail, "reassertXeroInvoiceEmailPolicy").mockResolvedValue(allow);
      vi.spyOn(invoiceEmail, "sendXeroInvoiceEmail").mockResolvedValue({ body: { emailed: true } } as never);
      const { enqueueXeroGroupSettlementInvoiceOperation } = await import("@/lib/xero-group-settlement-invoice-outbox");
      const groupRow = (await enqueueXeroGroupSettlementInvoiceOperation(g.settlement, { newAttempt: false })).queueOperationId!;
      expect(groupRow).toEqual(expect.any(String));

      await refusedThenSent(groupRow, "createInvoices", { queueType: "GROUP_SETTLEMENT_INVOICE", settlementId: g.settlement }, GROUP_CHILD_CENTS * 2);
    });
  },
);
