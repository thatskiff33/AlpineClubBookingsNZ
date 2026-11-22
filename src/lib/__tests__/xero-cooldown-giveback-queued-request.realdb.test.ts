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
 * and nothing failed or alerted. All five cases fail against `main`'s code
 * (450b74582), each at the same check: the row is PENDING holding the
 * handler's execution request, no queue type. The refund-note and
 * booking-invoice cases were committed red first ("Reproduce #5228",
 * 560a74f389); the other three were added with the fix and run red against
 * `main`'s code in a throwaway checkout during review.
 *
 * #5368 adds two cases of another kind, which are not among those five: the
 * breaker refuses the settling payment AFTER the document's create landed.
 * Such a row is not given back. Its handler completes it PARTIAL, naming the
 * document, so no second pass can raise the document again; an officer's
 * Retry then sends the payment.
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
import { GROUP_CHILD_CENTS } from "./support/booking-ledger-group-history";
import { FROZEN_TEST_CLOCK_BASE_ISO } from "./helpers/clock";
import type { SuiteEnvironmentRoleDeclaration } from "./helpers/environment-role";
import { assertSafeRaceDbUrl } from "./support/race-db-url";
import {
  breakerRefusal,
  drainOfficerRetries,
  fakeXero,
  officerRetry,
  paidCardBooking,
  queuedGroupSettlementInvoice,
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

      const refused = await runOutboxRow(prisma, operationId, PREFIX);
      expect(refused).toMatchObject({ processed: 1, skipped: 1, failed: 0, cooldownDeferred: 1 });
      expect(sent).toEqual([]);
      const given = await row(operationId);
      expect(given).toMatchObject({ status: "PENDING", startedAt: null, completedAt: null, lastErrorCode: null });
      expect(given.requestPayload).toMatchObject(queued);

      const resent = await runOutboxRow(prisma, operationId, PREFIX);
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
      expect(await runOutboxRow(prisma, invoiceRow, PREFIX)).toMatchObject({ succeeded: 1 });
      sent.length = 0;
      await recordCardRefund(prisma, paymentId, 5_000, "a");
      const noteRow = await queueRefundNote(paymentId, 5_000);

      await refusedThenSent(noteRow, "createCreditNotes", { queueType: "REFUND_CREDIT_NOTE", refundAmountCents: 5_000 }, 5_000);
    });

    it("a booking change's credit note refused by the breaker after its handler saved the note goes back PENDING with its queued request, and the next pass sends it once", async () => {
      const { bookingId, invoiceRow } = await paidCardBooking(prisma, names, `${PREFIX}b${++sequence}`, PRICE);
      expect(await runOutboxRow(prisma, invoiceRow, PREFIX)).toMatchObject({ succeeded: 1 });
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

    // ------------------------------------- the breaker refuses a call AFTER a create that landed (#5368)
    //
    // Not a give-back. The handler keeps what Xero already holds: it catches the refused payment and completes the row
    // PARTIAL, naming the document and the refusal, so the row never returns to PENDING and a second pass has nothing
    // to send. The payment leg is then an officer's Retry, queued and drained as the button and the cron run it.

    const fullRow = (operationId: string) =>
      prisma.xeroSyncOperation.findUniqueOrThrow({ where: { id: operationId }, select: { status: true, xeroObjectId: true, responsePayload: true } });
    const links = (paymentId: string, role: string) =>
      prisma.xeroObjectLink.findMany({ where: { localModel: "Payment", localId: paymentId, role }, select: { xeroObjectId: true, metadata: true } });
    const NOTHING_TO_RUN = { found: 0, processed: 0, succeeded: 0, failed: 0, skipped: 0 };
    const BREAKER_REFUSED = expect.objectContaining({ name: "XeroTransientOutageError", preHttp: true });

    /** No further retry drain or outbox pass sends anything. */
    async function nothingMoreIsSent(operationId: string, documents: SentDocument[]) {
      expect(await drainOfficerRetries()).toMatchObject({ found: 0, succeeded: 0 });
      expect(await runOutboxRow(prisma, operationId, PREFIX)).toEqual(NOTHING_TO_RUN);
      expect(sent).toEqual(documents);
    }

    it("a refund credit note whose payment the breaker refuses after the note's create landed is not given back: the row is PARTIAL holding the note, a second pass sends nothing, and an officer's Retry pays it and closes the row - one note", async () => {
      const { bookingId, paymentId, invoiceRow } = await paidCardBooking(prisma, names, `${PREFIX}b${++sequence}`, PRICE);
      expect(await runOutboxRow(prisma, invoiceRow, PREFIX)).toMatchObject({ succeeded: 1 });
      sent.length = 0;
      await recordCardRefund(prisma, paymentId, 5_000, "a");
      const noteRow = await queueRefundNote(paymentId, 5_000);
      // A card refund settles from the Stripe account, so this note has a payment to send: the real decision, not the fixture's "unsettled".
      vi.mocked((await import("@/lib/xero-invoice-payments")).resolveRefundSettlement).mockRestore();
      refuse.set("createPayments", await breakerRefusal());
      const oneNote: SentDocument[] = [{ operation: "createCreditNotes", cents: 5_000 }];

      // The create lands, then the payment is refused. The handler returned, so the pass counts no cooldown give-back.
      const first = await runOutboxRow(prisma, noteRow, PREFIX);
      expect(first).toEqual({ found: 1, processed: 1, succeeded: 1, failed: 0, skipped: 0 });
      expect(refuse.size, "the payment call was never reached").toBe(0);
      expect(sent).toEqual(oneNote);
      const partial = await fullRow(noteRow);
      expect(partial).toMatchObject({ status: "PARTIAL", xeroObjectId: expect.any(String), responsePayload: { refundPayment: null, refundPaymentError: BREAKER_REFUSED } });
      const noteId = partial.xeroObjectId!;

      // The second pass: the row is not PENDING, so nothing is claimed and no second note is raised.
      expect(await runOutboxRow(prisma, noteRow, PREFIX)).toEqual(NOTHING_TO_RUN);
      expect(sent).toEqual(oneNote);
      expect(await fullRow(noteRow)).toEqual(partial);

      // The officer's Retry pays the note Xero holds and closes the row.
      expect(await officerRetry(noteRow, names.officerId)).toMatchObject({ succeeded: 1, failed: 0 });
      expect(await fullRow(noteRow)).toMatchObject({ status: "SUCCEEDED", xeroObjectId: noteId, responsePayload: { refundPayment: { paymentID: expect.any(String) }, refundPaymentError: null } });
      expect(sent).toEqual(oneNote);
      expect(await links(paymentId, "REFUND_CREDIT_NOTE")).toEqual([expect.objectContaining({ xeroObjectId: noteId })]);
      expect(await links(paymentId, "REFUND_PAYMENT")).toEqual([expect.objectContaining({ metadata: expect.objectContaining({ creditNoteId: noteId, amountCents: 5_000 }) })]);
      await nothingMoreIsSent(noteRow, oneNote);

      // What the journal's export manifest says of this note (#5368 item 5): one row for the one note, and a conflict by
      // design. A card payment's refund note is sized on the payment's watermark and names no one refund debt, so it
      // is COMPONENT_UNUSABLE whatever the journal holds (docs/design/member-money-ledger.md, section 7).
      expect(await prisma.memberMoneyExportManifest.findMany({ where: { bookingId, documentRole: "REFUND_NOTE" }, select: { outcome: true, reason: true, lineTotalCents: true, providerInvoiceId: true } }))
        .toEqual([{ outcome: "CONFLICT", reason: "COMPONENT_UNUSABLE", lineTotalCents: 5_000, providerInvoiceId: noteId }]);
    });

    it("a booking invoice whose payment the breaker refuses after the invoice's create landed is not given back: the row is PARTIAL holding the invoice, a second pass sends nothing, and an officer's Retry records the payment once - one invoice", async () => {
      const { paymentId, invoiceRow } = await paidCardBooking(prisma, names, `${PREFIX}b${++sequence}`, PRICE);
      refuse.set("createPayment", await breakerRefusal());
      const oneInvoice: SentDocument[] = [{ operation: "createInvoices", cents: PRICE }];

      const first = await runOutboxRow(prisma, invoiceRow, PREFIX);
      expect(first).toEqual({ found: 1, processed: 1, succeeded: 1, failed: 0, skipped: 0 });
      expect(refuse.size, "the payment call was never reached").toBe(0);
      expect(sent).toEqual(oneInvoice);
      const partial = await fullRow(invoiceRow);
      expect(partial).toMatchObject({ status: "PARTIAL", xeroObjectId: expect.any(String), responsePayload: { payment: null, paymentError: BREAKER_REFUSED, paymentSkipped: false } });
      const invoiceId = partial.xeroObjectId!;
      expect(await links(paymentId, "INVOICE_PAYMENT")).toEqual([]);

      expect(await runOutboxRow(prisma, invoiceRow, PREFIX)).toEqual(NOTHING_TO_RUN);
      expect(sent).toEqual(oneInvoice);
      expect(await fullRow(invoiceRow)).toEqual(partial);

      // The officer's Retry records the card payment against the invoice Xero holds, once, and raises no second invoice.
      expect(await officerRetry(invoiceRow, names.officerId)).toMatchObject({ succeeded: 1, failed: 0 });
      expect(await fullRow(invoiceRow)).toMatchObject({ xeroObjectId: invoiceId, responsePayload: { payment: { paymentID: expect.any(String), amount: PRICE / 100 }, paymentError: null } });
      expect(sent).toEqual(oneInvoice);
      expect(await links(paymentId, "PRIMARY_INVOICE")).toEqual([expect.objectContaining({ xeroObjectId: invoiceId })]);
      expect(await links(paymentId, "INVOICE_PAYMENT")).toEqual([expect.objectContaining({ metadata: expect.objectContaining({ invoiceId, amountCents: PRICE }) })]);
      await nothingMoreIsSent(invoiceRow, oneInvoice);
      // Deliberately not asserted: the row's status after the Retry. It closes PARTIAL, naming an invoice email that
      // was never due on a card payment; that is #5420, and it is not pinned here as correct.
    });

    it("a group settlement invoice refused by the breaker after its handler saved the invoice goes back PENDING with its queued request, and the next pass sends it once", async () => {
      const { g, groupRow, role: declared } = await queuedGroupSettlementInvoice(prisma, names, PREFIX, `g${++sequence}`);
      role = declared;

      await refusedThenSent(groupRow, "createInvoices", { queueType: "GROUP_SETTLEMENT_INVOICE", settlementId: g.settlement }, GROUP_CHILD_CENTS * 2);
    });
  },
);
