/**
 * Real-PostgreSQL proof of #4215 (`INV-PAY-118`, `INV-ADDPAY-041`): on a
 * bank-transfer payment, the inbound Xero repair that rebuilds the refunded
 * total from the payment's notes keeps the cash a refund request paid back.
 *
 * The request is paid back through the REAL task completion, which moves the
 * refunded total and queues the request's own note
 * (`REFUND_REQUEST_CREDIT_NOTE`). The cancellation's canonical note is then
 * reconciled inbound with Xero faked. Before #4215 the rebuild read only the
 * canonical, account-credit and modification notes, so the request's cash fell
 * out of the total and the payment read as holding money it had paid back.
 *
 * Ordinary Vitest runs skip the whole file. It reuses the guarded, disposable
 * loopback PostgreSQL `concurrency-lock-races.realdb.test.ts` provisions, which
 * imports this file so CI reaches it; it owns and cleans its own `race-4215-`
 * fixtures.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { releaseBookingJournalForTeardown } from "./support/booking-financial-history-teardown";
import { CLUB_FORMAT_TEST } from "@/lib/__tests__/support/club-format-fixture";

const RUN = process.env.RUN_CONCURRENCY_RACE_TESTS === "1";
const RACE_DB_URL = process.env.CONCURRENCY_RACE_DATABASE_URL ?? "";

const MEMBER_ID = "race-4215-member";
const OFFICER_ID = "race-4215-officer";
const LODGE_ID = "race-4215-lodge";
const BOOKING_ID = "race-4215-booking";
const PAYMENT_ID = "race-4215-payment";
const TASK_ID = "race-4215-task";
const REQUEST_ID = "race-4215-request";
const CANONICAL_NOTE = "cn-race-4215-canonical";
const REQUEST_NOTE = "cn-race-4215-request";
const INVOICE_ID = "inv-race-4215";
const REQUEST_KEY = `payment:${PAYMENT_ID}:refund-request-credit-note:${REQUEST_ID}:v1`;

/** Standalone fail-closed copy: importing this file must not register another suite. */
export function assertSafeRequestCashRepairRaceDbUrl(url: string): void {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error("Refund-request cash repair proofs need a valid CONCURRENCY_RACE_DATABASE_URL.");
  }
  const port = Number.parseInt(parsed.port, 10);
  if (!Number.isFinite(port) || port === 5432 || port < 55442) {
    throw new Error(
      `Refusing to run refund-request cash repair proofs against port ${parsed.port || "(none)"}: use a throwaway PostgreSQL on 55442+ (never 5432).`,
    );
  }
  if (!["localhost", "127.0.0.1", "::1", "[::1]"].includes(parsed.hostname.toLowerCase())) {
    throw new Error("Refund-request cash repair proof DB must be loopback-only.");
  }
  if (!decodeURIComponent(parsed.pathname.replace(/^\//, "")).includes("concurrency_race_1881")) {
    throw new Error("Refund-request cash repair proof DB name must contain 'concurrency_race_1881'.");
  }
}

let prisma: (typeof import("@/lib/prisma"))["prisma"];

(RUN ? describe : describe.skip)(
  "the inbound repair of a bank-transfer payment's canonical refund note keeps a refund request's paid-back cash - real PostgreSQL (#4215)",
  { timeout: 60_000 },
  () => {
    async function clearRun() {
      // #4627: the doors post journal batches bridged to these lines; release them first.
      await releaseBookingJournalForTeardown(prisma, [BOOKING_ID]);
      await prisma.bookingLedgerLine.deleteMany({ where: { bookingId: BOOKING_ID } });
      await prisma.bookingEvent.deleteMany({ where: { bookingId: BOOKING_ID } });
      await prisma.manualRefundTask.deleteMany({ where: { bookingId: BOOKING_ID } });
      await prisma.xeroSyncOperation.deleteMany({ where: { localModel: "Payment", localId: PAYMENT_ID } });
      await prisma.xeroObjectLink.deleteMany({ where: { localId: PAYMENT_ID } });
      await prisma.paymentTransaction.deleteMany({ where: { paymentId: PAYMENT_ID } });
      await prisma.payment.deleteMany({ where: { id: PAYMENT_ID } });
    }

    async function deleteFixtures() {
      await clearRun();
      await prisma.booking.deleteMany({ where: { id: BOOKING_ID } });
      await prisma.lodge.deleteMany({ where: { id: LODGE_ID } });
      await prisma.member.deleteMany({ where: { id: { in: [MEMBER_ID, OFFICER_ID] } } });
    }

    beforeAll(async () => {
      assertSafeRequestCashRepairRaceDbUrl(RACE_DB_URL);
      process.env.DATABASE_URL = RACE_DB_URL;
      ({ prisma } = await import("@/lib/prisma"));
      await deleteFixtures();
      for (const id of [MEMBER_ID, OFFICER_ID]) {
        await prisma.member.create({
          data: { id, email: `${id}@example.invalid`, passwordHash: "not-a-real-password", firstName: "Request", lastName: "Cash", ageTier: "ADULT" },
        });
      }
      await prisma.lodge.create({ data: { id: LODGE_ID, name: "Race 4215 Lodge", slug: "race-4215" } });
      // A refund request exists only on a cancelled booking.
      await prisma.booking.create({
        data: {
          id: BOOKING_ID, memberId: MEMBER_ID, lodgeId: LODGE_ID, status: "CANCELLED", totalPriceCents: 20_000, finalPriceCents: 20_000,
          checkIn: new Date("2026-08-01T00:00:00.000Z"), checkOut: new Date("2026-08-03T00:00:00.000Z"),
        },
      });
    }, 60_000);

    beforeEach(async () => {
      await clearRun();
    });

    /**
     * A $200 bank transfer whose cancellation refunded `cancelRefundCents`
     * (under the payment's one canonical note when `invoiced`), and an
     * approved refund request's $50 hand-back, then paid back through the
     * REAL completion. Without an invoice the completion queues no request
     * note: there is nothing for it to credit (#4231 money lens F1).
     */
    async function seed({ invoiced, cancelRefundCents = 10_000 }: { invoiced: boolean; cancelRefundCents?: number }) {
      await prisma.payment.create({
        data: {
          id: PAYMENT_ID, bookingId: BOOKING_ID, amountCents: 20_000, source: "INTERNET_BANKING", status: "PARTIALLY_REFUNDED",
          refundedAmountCents: cancelRefundCents,
          ...(invoiced ? { xeroInvoiceId: INVOICE_ID, xeroRefundCreditNoteId: CANONICAL_NOTE } : {}),
        },
      });
      await prisma.paymentTransaction.create({
        data: {
          id: "race-4215-txn", paymentId: PAYMENT_ID, kind: "PRIMARY", source: "INTERNET_BANKING", amountCents: 20_000,
          refundedAmountCents: cancelRefundCents, status: "PARTIALLY_REFUNDED",
        },
      });
      if (invoiced) {
        await prisma.xeroObjectLink.create({
          data: {
            localModel: "Payment", localId: PAYMENT_ID, xeroObjectType: "CREDIT_NOTE", xeroObjectId: CANONICAL_NOTE, xeroObjectNumber: "CN-4215",
            role: "REFUND_CREDIT_NOTE", active: true, metadata: { amountCents: cancelRefundCents, status: "PAID" },
          },
        });
      }
      await prisma.manualRefundTask.create({
        data: {
          id: TASK_ID, bookingId: BOOKING_ID, paymentId: PAYMENT_ID, amountCents: 5_000, raisedAmountCents: 5_000,
          kind: "CANCELLED_BOOKING_HAND_BACK", occurrenceKey: `refund-request-hand-back:${REQUEST_ID}`, reason: "race 4215 approved refund request",
        },
      });

      const { resolveManualRefundTask } = await import("@/lib/manual-refund-task-resolution");
      await resolveManualRefundTask(
        {
          taskId: TASK_ID, resolution: "completed", note: null, actingMemberId: OFFICER_ID,
          confirmedAmountCents: null, direction: "REFUND_TO_MEMBER", recordedNightPrices: null,
        },
        CLUB_FORMAT_TEST,
      );
      // The completion moved the refunded total, and queued the request's own note only against an invoice.
      expect(await paymentState()).toEqual({ refundedAmountCents: cancelRefundCents + 5_000, status: "PARTIALLY_REFUNDED" });
      const queued = await prisma.xeroSyncOperation.findMany({
        where: { localModel: "Payment", localId: PAYMENT_ID, entityType: "CREDIT_NOTE" },
        select: { requestPayload: true },
      });
      expect(queued.map((row) => (row.requestPayload as Record<string, unknown>).refundRequestId)).toEqual(invoiced ? [REQUEST_ID] : []);
    }
    const seedInvoiced = () => seed({ invoiced: true });

    afterAll(async () => {
      if (!prisma) return;
      await deleteFixtures();
    }, 60_000);

    async function paymentState() {
      return prisma.payment.findUniqueOrThrow({ where: { id: PAYMENT_ID }, select: { refundedAmountCents: true, status: true } });
    }

    /** The outbox raised the request's note: its link, as the completion writes it. */
    async function linkRequestNote(status: string) {
      await prisma.xeroObjectLink.create({
        data: {
          localModel: "Payment", localId: PAYMENT_ID, xeroObjectType: "CREDIT_NOTE", xeroObjectId: REQUEST_NOTE, xeroObjectNumber: "CN-4215-R",
          role: "REFUND_REQUEST_CREDIT_NOTE", active: true, metadata: { amountCents: 5_000, refundRequestId: REQUEST_ID, status },
        },
      });
    }

    /** The inbound reconcile of `note`, read from a fake Xero (no provider call). */
    async function reconcileFromXero(note: Record<string, unknown>) {
      const { reconcileXeroCreditNote } = await import("@/lib/xero-inbound/credit-note");
      const xero = { accountingApi: { getCreditNote: async () => ({ body: { creditNotes: [note] } }) } };
      const apiClient = await import("@/lib/xero-api-client");
      const spies = [
        vi.spyOn(apiClient, "getAuthenticatedXeroClient").mockResolvedValue({ xero, tenantId: "tenant-4215" } as never),
        vi.spyOn(apiClient, "callXeroApi").mockImplementation(((call: () => unknown) => call()) as never),
      ];
      try {
        return await reconcileXeroCreditNote(String(note.creditNoteID));
      } finally {
        for (const spy of spies) spy.mockRestore();
      }
    }

    /** The refund-ledger divergence alerts raised while `run` executes (#1353, #4162 floors). */
    async function watchDivergenceAlerts(run: () => Promise<unknown>): Promise<string[]> {
      const alerting = await import("@/lib/xero-error-alert");
      const spy = vi.spyOn(alerting, "notifyXeroSyncError").mockResolvedValue(undefined as never);
      try {
        await run();
        return spy.mock.calls
          .map(([input]) => (input as { errorType: string; operation: string }))
          .filter((input) => input.errorType === "refund-ledger-divergence")
          .map((input) => input.operation);
      } finally {
        spy.mockRestore();
      }
    }

    const canonicalNote = (status: string) => ({
      creditNoteID: CANONICAL_NOTE, creditNoteNumber: "CN-4215", status,
      total: 100, appliedAmount: 0, remainingCredit: 0, allocations: [], payments: [],
    });

    it("a canonical-note reconcile keeps the request's $50 beside the note's $100, and only a paid-back request counts", async () => {
      await seedInvoiced();
      await linkRequestNote("PAID");
      // A second request still awaiting payment, and a third dismissed: no cash moved for either.
      for (const [suffix, status] of [["open", "OPEN"], ["dismissed", "DISMISSED"]] as const) {
        await prisma.manualRefundTask.create({
          data: {
            id: `${TASK_ID}-${suffix}`, bookingId: BOOKING_ID, paymentId: PAYMENT_ID, amountCents: 2_000, raisedAmountCents: 2_000, status,
            kind: "CANCELLED_BOOKING_HAND_BACK", occurrenceKey: `refund-request-hand-back:${REQUEST_ID}-${suffix}`, reason: "race 4215 other request",
            ...(status === "DISMISSED" ? { note: "race 4215 dismissed", completedAt: new Date("2026-06-01T00:00:00.000Z"), completedByMemberId: OFFICER_ID } : {}),
          },
        });
      }

      let result!: Awaited<ReturnType<typeof reconcileFromXero>>;
      const alerts = await watchDivergenceAlerts(async () => {
        result = await reconcileFromXero(canonicalNote("PAID"));
      });

      // Before #4215: { refundedAmountCents: 10_000 } - the request's cash dropped out. Since
      // #4162's floor keeps the detail, the drop shows as a false divergence alert instead.
      expect(result.matchedRefundedPayments).toBe(1);
      expect(await paymentState()).toEqual({ refundedAmountCents: 15_000, status: "PARTIALLY_REFUNDED" });
      expect(alerts).toEqual([]);
      // A redelivery moves nothing.
      await reconcileFromXero(canonicalNote("PAID"));
      expect(await paymentState()).toEqual({ refundedAmountCents: 15_000, status: "PARTIALLY_REFUNDED" });
    });

    it("keeps it while the request's note is still queued, and after Xero voids it (#4195: a request's void moves no refunded total)", async () => {
      await seedInvoiced();
      await reconcileFromXero(canonicalNote("PAID"));
      expect(await paymentState()).toEqual({ refundedAmountCents: 15_000, status: "PARTIALLY_REFUNDED" });

      await linkRequestNote("PAID");
      await reconcileFromXero({
        creditNoteID: REQUEST_NOTE, creditNoteNumber: "CN-4215-R", status: "VOIDED",
        total: 50, appliedAmount: 0, remainingCredit: 0, allocations: [], payments: [],
      });
      await reconcileFromXero(canonicalNote("PAID"));
      expect(await paymentState()).toEqual({ refundedAmountCents: 15_000, status: "PARTIALLY_REFUNDED" });
    });

    it("the canonical note voided: the recount keeps the payment's detail for the nightly follow-up (#4162), and keeps the request's $50 out of the void", async () => {
      await seedInvoiced();
      await linkRequestNote("PAID");

      const alerts = await watchDivergenceAlerts(() => reconcileFromXero(canonicalNote("VOIDED")));

      // #4162 (`INV-ADDPAY-021`): the void is the nightly follow-up's to carry through the
      // detail, the ledger line and the total together; the recount only keeps the detail,
      // and, a void awaiting that follow-up being expected, alerts nothing.
      expect(await paymentState()).toEqual({ refundedAmountCents: 15_000, status: "PARTIALLY_REFUNDED" });
      expect(alerts).toEqual([]);
    });

    it("a payment an earlier release recounted too low is put right by a replay of its canonical note (#4231 deploy note)", async () => {
      await seedInvoiced();
      // The previous release's recount dropped the request's $50; its charge rows kept it.
      await prisma.payment.update({ where: { id: PAYMENT_ID }, data: { refundedAmountCents: 10_000 } });

      await reconcileFromXero(canonicalNote("PAID"));

      // The #4162 floor never raises a total already below its detail: only the request's own term does.
      expect(await paymentState()).toEqual({ refundedAmountCents: 15_000, status: "PARTIALLY_REFUNDED" });
    });
    /**
     * The booking repair tool's dry run: what it would queue for the
     * cancellation's refund note, whether it asks a person, and (#4231) what it
     * would queue as a request's own note.
     */
    async function repairToolOnRefundNote() {
      const { runBookingXeroRepair } = await import("@/lib/xero-booking-repair");
      const booking = (await runBookingXeroRepair(CLUB_FORMAT_TEST, { scope: { bookingId: BOOKING_ID } })).passes[0]!.bookings[0]!;
      const amounts = (type: string) =>
        booking.actions.filter((action) => action.type === type).map((action) => (action.payload as { refundAmountCents: number }).refundAmountCents);
      return {
        queued: amounts("QUEUE_REFUND_CREDIT_NOTE"),
        review: booking.findings.some((finding) => /missing Xero refund note amount cannot be derived/.test(finding.summary)),
        requestNotes: amounts("QUEUE_REFUND_REQUEST_CREDIT_NOTE"),
      };
    }

    /** The request's own note rows: amount asked for, per row. */
    async function requestNoteRows() {
      const rows = await prisma.xeroSyncOperation.findMany({
        where: { localModel: "Payment", localId: PAYMENT_ID, entityType: "CREDIT_NOTE", operationType: "CREATE" },
        select: { correlationKey: true, requestPayload: true },
      });
      return rows.map((row) => ({ key: row.correlationKey, cents: (row.requestPayload as Record<string, unknown>).refundAmountCents }));
    }

    it("a request paid back before the booking had an invoice: the repair tool never puts its $50 in the cancellation's note, and the recount never counts it twice (#4231)", async () => {
      await seed({ invoiced: false });
      // The invoice reaches Xero afterwards; the cancellation's $100 has no note yet.
      await prisma.payment.update({ where: { id: PAYMENT_ID }, data: { xeroInvoiceId: INVOICE_ID } });

      // Before the fix: { queued: [15_000], review: false } - a cancellation note holding the request's $50.
      // #4231: and the request's own $50 note, which nothing else would raise.
      expect(await repairToolOnRefundNote()).toEqual({ queued: [], review: true, requestNotes: [5_000] });

      // An officer raises the cancellation's $100 note by hand; its reconcile keeps $150, never $200.
      await prisma.payment.update({ where: { id: PAYMENT_ID }, data: { xeroRefundCreditNoteId: CANONICAL_NOTE } });
      await reconcileFromXero(canonicalNote("PAID"));
      expect(await paymentState()).toEqual({ refundedAmountCents: 15_000, status: "PARTIALLY_REFUNDED" });
    });

    it("a request alone, paid back before the invoice: the repair tool asks for no cancellation note at all", async () => {
      await seed({ invoiced: false, cancelRefundCents: 0 });
      await prisma.payment.update({ where: { id: PAYMENT_ID }, data: { xeroInvoiceId: INVOICE_ID } });

      // Before the fix: { queued: [5_000], ... } - the request's own cash as the cancellation's note.
      // #4231: the request's $50 goes on its own note instead.
      expect(await repairToolOnRefundNote()).toEqual({ queued: [], review: false, requestNotes: [5_000] });

      // Lens F1/F2: --apply alone raises nothing - an officer checks Xero, then confirms the action by its key.
      const { runBookingXeroRepair } = await import("@/lib/xero-booking-repair");
      await runBookingXeroRepair(CLUB_FORMAT_TEST, { scope: { bookingId: BOOKING_ID }, apply: true });
      expect(await requestNoteRows()).toEqual([]);
      const confirm = { scope: { bookingId: BOOKING_ID }, apply: true, applyActionKeys: [`queue:refund-request-credit-note:${PAYMENT_ID}:${REQUEST_ID}`] };
      await runBookingXeroRepair(CLUB_FORMAT_TEST, confirm);
      expect(await requestNoteRows()).toEqual([{ key: REQUEST_KEY, cents: 5_000 }]);
      // A row now exists, whatever becomes of it, so the tool never asks again.
      expect(await repairToolOnRefundNote()).toEqual({ queued: [], review: false, requestNotes: [] });
      await runBookingXeroRepair(CLUB_FORMAT_TEST, confirm);
      expect(await requestNoteRows()).toEqual([{ key: REQUEST_KEY, cents: 5_000 }]);
    });

    it("MUTATION (gate: link role): an account-credit note's link and another request's own note link are no cancellation note - the request's note is still offered", async () => {
      await seed({ invoiced: false });
      await prisma.payment.update({ where: { id: PAYMENT_ID }, data: { xeroInvoiceId: INVOICE_ID } });
      for (const [id, role, metadata] of [
        ["cn-race-4215-account", "ACCOUNT_CREDIT_NOTE", { amountCents: 2_000 }],
        ["cn-race-4215-other-request", "REFUND_REQUEST_CREDIT_NOTE", { amountCents: 2_000, refundRequestId: `${REQUEST_ID}-other` }],
      ] as const) {
        await prisma.xeroObjectLink.create({
          data: { localModel: "Payment", localId: PAYMENT_ID, xeroObjectType: "CREDIT_NOTE", xeroObjectId: id, role, active: true, metadata },
        });
      }

      // The real loader's one read is by role: neither link makes a cancellation note.
      expect(await repairToolOnRefundNote()).toEqual({ queued: [], review: true, requestNotes: [5_000] });
    });

    it("MUTATION (gate: link, active or not): a cancellation note whose link was deactivated still sends the request to a person", async () => {
      await seed({ invoiced: false });
      await prisma.payment.update({ where: { id: PAYMENT_ID }, data: { xeroInvoiceId: INVOICE_ID } });
      // No pointer and no create row: only a link the normaliser or a void turned off.
      await prisma.xeroObjectLink.create({
        data: {
          localModel: "Payment", localId: PAYMENT_ID, xeroObjectType: "CREDIT_NOTE", xeroObjectId: CANONICAL_NOTE, xeroObjectNumber: "CN-4215",
          role: "REFUND_CREDIT_NOTE", active: false, metadata: { amountCents: 10_000 },
        },
      });

      const { runBookingXeroRepair } = await import("@/lib/xero-booking-repair");
      const booking = (await runBookingXeroRepair(CLUB_FORMAT_TEST, { scope: { bookingId: BOOKING_ID } })).passes[0]!.bookings[0]!;
      expect(booking.actions.filter((action) => action.type === "QUEUE_REFUND_REQUEST_CREDIT_NOTE")).toEqual([]);
      expect(booking.findings).toContainEqual(
        expect.objectContaining({ code: "REFUND_REQUEST_NOTE_NOT_QUEUED", severity: "manual_review", details: expect.objectContaining({ refundRequestId: REQUEST_ID, refundAmountCents: 5_000 }) }),
      );
    });

    it("MUTATION (lens F1): a cancellation note an earlier release sized with the request's cash gets a person - the request's note is never offered beside it", async () => {
      await seed({ invoiced: false });
      // The invoice reached Xero, then the old tool raised one $150 note: $100 of cancellation and the request's $50.
      await prisma.payment.update({ where: { id: PAYMENT_ID }, data: { xeroInvoiceId: INVOICE_ID, xeroRefundCreditNoteId: CANONICAL_NOTE } });
      await prisma.xeroObjectLink.create({
        data: {
          localModel: "Payment", localId: PAYMENT_ID, xeroObjectType: "CREDIT_NOTE", xeroObjectId: CANONICAL_NOTE, xeroObjectNumber: "CN-4215",
          role: "REFUND_CREDIT_NOTE", active: true, metadata: { amountCents: 15_000, status: "PAID" },
        },
      });

      const { runBookingXeroRepair } = await import("@/lib/xero-booking-repair");
      const booking = (await runBookingXeroRepair(CLUB_FORMAT_TEST, { scope: { bookingId: BOOKING_ID } })).passes[0]!.bookings[0]!;
      expect(booking.actions.filter((action) => action.type === "QUEUE_REFUND_REQUEST_CREDIT_NOTE")).toEqual([]);
      expect(booking.findings).toContainEqual(
        expect.objectContaining({ code: "REFUND_REQUEST_NOTE_NOT_QUEUED", severity: "manual_review", summary: expect.stringContaining("may already include the request's") }),
      );
      // Even an officer's confirmation of the key raises nothing: no such action exists.
      await runBookingXeroRepair(CLUB_FORMAT_TEST, { scope: { bookingId: BOOKING_ID }, apply: true, applyActionKeys: [`queue:refund-request-credit-note:${PAYMENT_ID}:${REQUEST_ID}`] });
      expect(await requestNoteRows()).toEqual([]);
    });

    it("a request whose own note was raised and then voided in Xero is never re-raised by the repair tool (#4195, #4214)", async () => {
      await seedInvoiced();
      await linkRequestNote("VOIDED");
      await prisma.xeroObjectLink.updateMany({ where: { localId: PAYMENT_ID, role: "REFUND_REQUEST_CREDIT_NOTE" }, data: { active: false } });
      // The completion's queued row stands for the raise.
      expect((await repairToolOnRefundNote()).requestNotes).toEqual([]);
    });
  },
);
