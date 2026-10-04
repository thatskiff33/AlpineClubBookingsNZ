/**
 * Real-PostgreSQL proof for #3836: a card-path booking paid ENTIRELY by
 * account credit has its applied credit allocated against its full-price Xero
 * invoice by the one engine (`allocateAppliedCreditForBooking`), driven from
 * the invoice operation's replay (`createXeroInvoiceForBooking`) and from the
 * repair pass's queued operation, so Xero shows nothing owing.
 *
 * Xero is a fake provider at the client seam (`getAuthenticatedXeroClient`,
 * `callXeroApi`): it keeps each credit note's allocations, honours idempotency
 * keys, and REJECTS an allocation beyond a note's remaining credit or an
 * invoice's amount due, as Xero does. Everything else is real: the ledger, the
 * slices and their provenance, the REAL guest removal and its give-back (#3809),
 * the REAL deallocation worker, the REAL cancel, and the repair pass. The fake
 * is switched on only inside this describe; outside it every mocked export
 * delegates to the real one, so the shared harness's other suites are unchanged.
 *
 * Envelope: identical to `concurrency-lock-races.realdb.test.ts`, which imports
 * this file; the describe runs ONLY when `RUN_CONCURRENCY_RACE_TESTS=1`, against
 * a loopback database on port 55442+ named with `concurrency_race_1881`.
 *
 *   RUN_CONCURRENCY_RACE_TESTS=1 \
 *   CONCURRENCY_RACE_DATABASE_URL=postgresql://user:pass@127.0.0.1:55442/concurrency_race_1881 \
 *   pnpm exec vitest run src/lib/__tests__/credit-only-card-allocation.realdb.test.ts
 */
import type { PrismaClient } from "@prisma/client";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import { realElapsedMs } from "@/lib/__tests__/helpers/clock";
import { CLUB_FORMAT_TEST } from "./support/club-format-fixture";

const RUN = process.env.RUN_CONCURRENCY_RACE_TESTS === "1";
const RACE_DB_URL = process.env.CONCURRENCY_RACE_DATABASE_URL ?? "";

const MEMBER_ID = "race-3836-member";
const LODGE_ID = "race-3836-lodge";
const BOOKING_ID = "race-3836-booking";
const STAYING_GUEST_ID = "race-3836-guest-stays";
const LEAVING_GUEST_ID = "race-3836-guest-leaves";
const PAYMENT_ID = "race-3836-payment";
const XERO_INVOICE_ID = "race-3836-xero-invoice";
const CREDIT_NOTE_ID = "race-3836-credit-note";

const TODAY = new Date("2026-07-01T00:00:00.000Z");
const NIGHTS = [new Date("2026-08-01T00:00:00.000Z"), new Date("2026-08-02T00:00:00.000Z")];
const CHECK_IN = NIGHTS[0]!;
const CHECK_OUT = new Date("2026-08-03T00:00:00.000Z");
/** $150 stays, $50 leaves: a $200 booking paid with $200 of credit. */
const GUESTS = [
  { id: STAYING_GUEST_ID, firstName: "Staying", nightCents: 7_500 },
  { id: LEAVING_GUEST_ID, firstName: "Leaving", nightCents: 2_500 },
];
const PRICE_CENTS = 20_000;
const FULL_REFUND = { refundPercentage: 100, fixedFeeCents: 0 };
const LOCK_POLL_TIMEOUT_MS = 2_000;

/** The fake Xero: notes and their allocations, the invoice, and what each provider call saw. */
const fakeXero = vi.hoisted(() => {
  type Allocation = { allocationID: string; invoiceID: string; amountCents: number };
  const state = {
    on: false,
    seq: 0,
    invoices: new Map<string, number>(),
    notes: new Map<string, { totalCents: number; allocations: Allocation[] }>(),
    seenKeys: new Map<string, unknown>(),
    providerWrites: 0,
    onProviderWrite: null as null | (() => Promise<void>),
  };
  const allocatedTo = (invoiceID: string) =>
    [...state.notes.values()].flatMap((note) => note.allocations).filter((a) => a.invoiceID === invoiceID).reduce((sum, a) => sum + a.amountCents, 0);
  const noteBody = (creditNoteID: string) => ({
    creditNotes: [{
      creditNoteID,
      allocations: (state.notes.get(creditNoteID)?.allocations ?? []).map((a) => ({ allocationID: a.allocationID, invoice: { invoiceID: a.invoiceID }, amount: a.amountCents / 100 })),
    }],
  });
  const accountingApi = {
    async createCreditNoteAllocation(_tenant: string, creditNoteID: string, body: { allocations: Array<{ invoice: { invoiceID: string }; amount: number }> }, _summarize: unknown, idempotencyKey?: string) {
      state.providerWrites += 1;
      await state.onProviderWrite?.();
      if (idempotencyKey && state.seenKeys.has(idempotencyKey)) return { body: state.seenKeys.get(idempotencyKey) };
      const note = state.notes.get(creditNoteID);
      if (!note) throw new Error(`fake Xero: no credit note ${creditNoteID}`);
      for (const { invoice, amount } of body.allocations) {
        const cents = Math.round(amount * 100);
        const remaining = note.totalCents - note.allocations.reduce((sum, a) => sum + a.amountCents, 0);
        const due = (state.invoices.get(invoice.invoiceID) ?? 0) - allocatedTo(invoice.invoiceID);
        if (cents > remaining || cents > due) throw new Error(`fake Xero: allocation of ${cents} exceeds remaining credit ${remaining} or amount due ${due}`);
        note.allocations.push({ allocationID: `race-3836-allocation-${(state.seq += 1)}`, invoiceID: invoice.invoiceID, amountCents: cents });
      }
      const response = noteBody(creditNoteID);
      if (idempotencyKey) state.seenKeys.set(idempotencyKey, response);
      return { body: response };
    },
    async getCreditNote(_tenant: string, creditNoteID: string) {
      return { body: noteBody(creditNoteID) };
    },
    async deleteCreditNoteAllocations(_tenant: string, creditNoteID: string, allocationID: string) {
      state.providerWrites += 1;
      await state.onProviderWrite?.();
      const note = state.notes.get(creditNoteID);
      if (note) note.allocations = note.allocations.filter((a) => a.allocationID !== allocationID);
      return { body: {} };
    },
  };
  return { state, allocatedTo, client: { accountingApi } };
});

vi.mock("@/lib/xero-api-client", async (importOriginal) => {
  const actual = (await importOriginal()) as typeof import("@/lib/xero-api-client");
  return {
    ...actual,
    getAuthenticatedXeroClient: ((...args: Parameters<typeof actual.getAuthenticatedXeroClient>) =>
      fakeXero.state.on
        ? Promise.resolve({ xero: fakeXero.client, tenantId: "race-3836-tenant" })
        : actual.getAuthenticatedXeroClient(...args)) as typeof actual.getAuthenticatedXeroClient,
    callXeroApi: ((fn: () => Promise<unknown>, options: Parameters<typeof actual.callXeroApi>[1]) =>
      fakeXero.state.on ? fn() : actual.callXeroApi(fn, options)) as typeof actual.callXeroApi,
  };
});
vi.mock("@/lib/xero-contact-containment-proof", async (importOriginal) => {
  const actual = (await importOriginal()) as typeof import("@/lib/xero-contact-containment-proof");
  return {
    ...actual,
    // INV-CONFIG-005's copy-installation gate reads Xero's contact; the fake has none to prove.
    requireContainedXeroContactForInvoiceOperation: ((params: Parameters<typeof actual.requireContainedXeroContactForInvoiceOperation>[0]) =>
      fakeXero.state.on ? Promise.resolve() : actual.requireContainedXeroContactForInvoiceOperation(params)) as typeof actual.requireContainedXeroContactForInvoiceOperation,
  };
});

function assertSafeRaceDbUrl(url: string): void {
  const parsed = new URL(url);
  const port = Number.parseInt(parsed.port, 10);
  if (!Number.isFinite(port) || port === 5432 || port < 55442) throw new Error(`Refusing port ${parsed.port || "(none)"}: use a throwaway Postgres on 55442+.`);
  if (!["localhost", "127.0.0.1", "::1", "[::1]"].includes(parsed.hostname.toLowerCase())) throw new Error("The race DB must be loopback-only.");
  if (!decodeURIComponent(parsed.pathname).includes("concurrency_race_1881")) throw new Error("The race DB name must carry 'concurrency_race_1881'.");
}

let prisma: (typeof import("@/lib/prisma"))["prisma"];
let credit: typeof import("@/lib/member-credit");
let ledger: typeof import("@/lib/booking-ledger-balance");
let lockHolderClient: PrismaClient;
let observerClient: PrismaClient;

(RUN ? describe : describe.skip)(
  "#3836: a card-path booking paid entirely by credit has its credit allocated against its invoice - real PostgreSQL",
  { timeout: 60_000 },
  () => {
    async function deleteFixtures() {
      const modifications = await prisma.bookingModification.findMany({ where: { bookingId: BOOKING_ID }, select: { id: true } });
      const slices = await prisma.memberCreditNoteAllocation.findMany({ where: { appliedToBookingId: BOOKING_ID }, select: { id: true } });
      const localIds = [PAYMENT_ID, BOOKING_ID, ...modifications.map((row) => row.id), ...slices.map((slice) => slice.id)];
      await prisma.xeroSyncOperation.deleteMany({ where: { localId: { in: localIds } } });
      await prisma.xeroObjectLink.deleteMany({ where: { localId: { in: localIds } } });
      await prisma.memberCreditNoteAllocation.deleteMany({ where: { appliedToBookingId: BOOKING_ID } });
      await prisma.bookingLedgerLine.deleteMany({ where: { bookingId: BOOKING_ID } });
      await prisma.memberCredit.deleteMany({ where: { memberId: MEMBER_ID } });
      await prisma.bookingEvent.deleteMany({ where: { bookingId: BOOKING_ID } });
      await prisma.auditLog.deleteMany({ where: { OR: [{ memberId: MEMBER_ID }, { actorMemberId: MEMBER_ID }, { targetId: BOOKING_ID }] } });
      await prisma.paymentRecoveryOperation.deleteMany({ where: { bookingId: BOOKING_ID } });
      await prisma.manualRefundTask.deleteMany({ where: { bookingId: BOOKING_ID } });
      await prisma.bookingModification.deleteMany({ where: { bookingId: BOOKING_ID } });
      await prisma.payment.deleteMany({ where: { bookingId: BOOKING_ID } });
      await prisma.bookingGuestNight.deleteMany({ where: { bookingGuest: { bookingId: BOOKING_ID } } });
      await prisma.bookingGuest.deleteMany({ where: { bookingId: BOOKING_ID } });
      await prisma.booking.deleteMany({ where: { id: BOOKING_ID } });
      await prisma.cancellationPolicy.deleteMany({ where: { lodgeId: LODGE_ID } });
      await prisma.lodge.deleteMany({ where: { id: LODGE_ID } });
      await prisma.member.deleteMany({ where: { id: MEMBER_ID } });
    }

    /**
     * The shape #3836 is about, as booking creation leaves it: a $200 PAID card
     * booking confirmed at $0 by $200 of credit (a cancellation's floating note
     * in Xero), its full-price invoice raised, its credit not yet allocated.
     */
    async function creditOnlyCardBooking() {
      await deleteFixtures();
      await prisma.member.create({
        data: { id: MEMBER_ID, email: "race-3836@example.invalid", passwordHash: "x", firstName: "Credit", lastName: "Payer", role: "USER", ageTier: "ADULT" },
      });
      await prisma.lodge.create({ data: { id: LODGE_ID, name: "Race 3836 Lodge", slug: "race-3836" } });
      await prisma.cancellationPolicy.create({ data: { lodgeId: LODGE_ID, daysBeforeStay: 0, ...FULL_REFUND } });
      await prisma.booking.create({
        data: { id: BOOKING_ID, memberId: MEMBER_ID, lodgeId: LODGE_ID, checkIn: CHECK_IN, checkOut: CHECK_OUT, status: "PAID", totalPriceCents: PRICE_CENTS, finalPriceCents: PRICE_CENTS },
      });
      for (const guest of GUESTS) {
        await prisma.bookingGuest.create({
          data: { id: guest.id, bookingId: BOOKING_ID, firstName: guest.firstName, lastName: "Guest", ageTier: "ADULT", stayStart: CHECK_IN, stayEnd: CHECK_OUT, priceCents: guest.nightCents * 2 },
        });
        await prisma.bookingGuestNight.createMany({
          data: NIGHTS.map((stayDate) => ({ bookingGuestId: guest.id, stayDate, priceCents: guest.nightCents, priceSource: "SOLD" as const })),
        });
        for (const [index, night] of NIGHTS.entries()) {
          await prisma.bookingLedgerLine.create({ data: {
            bookingId: BOOKING_ID, side: "CHARGE", kind: "GUEST_NIGHT", sign: 1, quantity: 1, unitCents: guest.nightCents, amountCents: guest.nightCents,
            bookingGuestId: guest.id, nightStart: night, nightEndExclusive: NIGHTS[index + 1] ?? CHECK_OUT, ageTier: "ADULT",
            guestNames: [`${guest.firstName} Guest`], anchorKind: "CONFIRMATION", anchorId: BOOKING_ID, narration: "race 3836 confirmation",
            lodgeId: LODGE_ID, postingKey: `race-3836-confirm-${guest.id}-${index}`,
          } });
        }
      }
      // The $0 row the credit-covered settle writes (booking-create.ts).
      await prisma.payment.create({
        data: { id: PAYMENT_ID, bookingId: BOOKING_ID, amountCents: 0, status: "SUCCEEDED", creditAppliedCents: PRICE_CENTS, source: "STRIPE", xeroInvoiceId: XERO_INVOICE_ID },
      });
      await prisma.memberCredit.create({
        data: { memberId: MEMBER_ID, amountCents: PRICE_CENTS, type: "CANCELLATION_REFUND", description: "race 3836 earlier cancellation", xeroCreditNoteId: CREDIT_NOTE_ID },
      });
      await prisma.$transaction((tx) => credit.applyCreditToBooking(MEMBER_ID, PRICE_CENTS, BOOKING_ID, tx, CLUB_FORMAT_TEST));

      fakeXero.state.on = true;
      fakeXero.state.seq = 0;
      fakeXero.state.providerWrites = 0;
      fakeXero.state.onProviderWrite = null;
      fakeXero.state.seenKeys.clear();
      fakeXero.state.invoices = new Map([[XERO_INVOICE_ID, PRICE_CENTS]]);
      fakeXero.state.notes = new Map([[CREDIT_NOTE_ID, { totalCents: PRICE_CENTS, allocations: [] }]]);
      expect(await credit.getMemberCreditBalance(MEMBER_ID)).toBe(0);
      expect(await owed()).toBe(0);
    }

    const owed = async () => ledger.bookingLedgerBalance(await prisma.bookingLedgerLine.findMany({ where: { bookingId: BOOKING_ID } })).owedCents;
    const allocatedCents = () => fakeXero.allocatedTo(XERO_INVOICE_ID);
    const allocationCount = () => fakeXero.state.notes.get(CREDIT_NOTE_ID)!.allocations.length;
    /** The member's Xero credit: what their notes still hold unallocated. */
    const xeroCreditCents = () =>
      [...fakeXero.state.notes.values()].reduce((sum, note) => sum + note.totalCents - note.allocations.reduce((s, a) => s + a.amountCents, 0), 0);
    /** Notes the app queued against the invoice (the give-back's), which the fake does not raise. */
    async function queuedInvoiceNotesCents() {
      const operations = await prisma.xeroSyncOperation.findMany({
        where: { entityType: "CREDIT_NOTE", OR: [{ localId: BOOKING_ID }, { localModel: "BookingModification" }, { localId: PAYMENT_ID }] },
        select: { requestPayload: true, localModel: true, localId: true },
      });
      const modificationIds = new Set((await prisma.bookingModification.findMany({ where: { bookingId: BOOKING_ID }, select: { id: true } })).map((row) => row.id));
      return operations
        .filter((operation) => operation.localModel !== "BookingModification" || modificationIds.has(operation.localId ?? ""))
        .reduce((sum, operation) => sum + ((operation.requestPayload as { refundAmountCents?: number }).refundAmountCents ?? 0), 0);
    }
    /** Credit the cancel restored without a Xero note: #2717's rule, minted only when spent. */
    async function notelessRestoredCents() {
      const rows = await prisma.memberCredit.aggregate({ where: { memberId: MEMBER_ID, restoredFromBookingId: BOOKING_ID, xeroCreditNoteId: null }, _sum: { amountCents: true } });
      return rows._sum.amountCents ?? 0;
    }

    async function raiseReplay() {
      const { createXeroInvoiceForBooking } = await import("@/lib/xero-booking-invoices");
      await expect(createXeroInvoiceForBooking(BOOKING_ID)).resolves.toBe(XERO_INVOICE_ID);
    }

    async function removeLeavingGuest() {
      const { removeBookingGuestInTransaction } = await import("@/lib/booking-guest-removal-service");
      const result = await prisma.$transaction(
        (tx) => removeBookingGuestInTransaction({
          tx, bookingId: BOOKING_ID, guestId: LEAVING_GUEST_ID, actorMemberId: MEMBER_ID, actorRole: "ADMIN", today: TODAY, format: CLUB_FORMAT_TEST,
        }),
        { maxWait: 10_000, timeout: 20_000 },
      );
      const { guestRemovalXeroSettlement, queueGuestRemovalXeroSettlement } = await import("@/lib/booking-guest-removal-xero");
      await queueGuestRemovalXeroSettlement(guestRemovalXeroSettlement(result), { createdByMemberId: MEMBER_ID, additionalPaymentIntentId: null });
      return result;
    }

    /** The REAL deallocation worker on the operation the give-back queued. */
    async function runDeallocation() {
      const operation = await prisma.xeroSyncOperation.findFirstOrThrow({
        where: { localModel: "Payment", localId: PAYMENT_ID, queueType: "APPLIED_CREDIT_DEALLOCATION" },
        select: { id: true, correlationKey: true },
      });
      await prisma.xeroSyncOperation.update({ where: { id: operation.id }, data: { status: "RUNNING" } });
      const { deallocateExcessAppliedCreditForBooking } = await import("@/lib/xero-applied-credit-deallocation");
      await deallocateExcessAppliedCreditForBooking(BOOKING_ID, { syncOperationId: operation.id });
      return Number(operation.correlationKey?.split(":").at(-2));
    }

    async function cancel() {
      const { cancelBooking } = await import("@/lib/booking-cancel");
      const result = await cancelBooking(BOOKING_ID, MEMBER_ID, "ADMIN", "127.0.0.1", CLUB_FORMAT_TEST, "card");
      expect(result.status).toBe(200);
    }

    async function repairReport(apply = false) {
      const { runBookingXeroRepair } = await import("@/lib/xero-booking-repair");
      return runBookingXeroRepair(CLUB_FORMAT_TEST, {
        scope: { bookingId: BOOKING_ID },
        apply,
        dependencies: { isXeroConnected: async () => false, processQueuedXeroOutboxOperations: async () => ({ processed: 0 }) as never },
      });
    }
    const repairCodes = async () => (await repairReport()).passes[0]!.bookings.flatMap((booking) => booking.findings.map((finding) => finding.code));

    beforeAll(async () => {
      assertSafeRaceDbUrl(RACE_DB_URL);
      process.env.DATABASE_URL = RACE_DB_URL;
      ({ prisma } = await import("@/lib/prisma"));
      credit = await import("@/lib/member-credit");
      ledger = await import("@/lib/booking-ledger-balance");
      const [{ PrismaClient: SeparatePrismaClient }, { createPrismaPgAdapter }] = await Promise.all([
        import("@prisma/client"),
        import("@/lib/prisma-adapter"),
      ]);
      const separate = (applicationName: string) => {
        const url = new URL(RACE_DB_URL);
        url.searchParams.set("connection_limit", "1");
        url.searchParams.set("application_name", applicationName);
        return new SeparatePrismaClient({ adapter: createPrismaPgAdapter(url.toString()) });
      };
      lockHolderClient = separate("race-3836-lock-holder");
      observerClient = separate("race-3836-observer");
      await Promise.all([lockHolderClient.$connect(), observerClient.$connect()]);
    }, 60_000);

    afterEach(() => {
      fakeXero.state.on = false;
    });

    afterAll(async () => {
      fakeXero.state.on = false;
      await Promise.all([lockHolderClient, observerClient].map((client) => (client ? client.$disconnect().catch(() => {}) : Promise.resolve())));
      if (typeof prisma !== "undefined") {
        try {
          await deleteFixtures();
        } finally {
          await prisma.$disconnect().catch(() => {});
        }
      }
    });

    it("the invoice operation's replay allocates the $200 of credit: Xero's amount due is $0, the member's Xero credit is the app's, and a retry, a second engine run and the repair pass allocate nothing more", async () => {
      await creditOnlyCardBooking();

      await raiseReplay();

      expect(allocatedCents()).toBe(PRICE_CENTS);
      expect(PRICE_CENTS - (await queuedInvoiceNotesCents()), "(i) the invoice net of its notes = the price").toBe(PRICE_CENTS);
      expect(PRICE_CENTS - allocatedCents(), "(ii) Xero's amount due = the app's owed, $0").toBe(await owed());
      expect(xeroCreditCents(), "(iii) the member's Xero credit = the app's").toBe(await credit.getMemberCreditBalance(MEMBER_ID));
      // One working slice with its provenance, and the ledger stamped: the engine's idempotency.
      const slices = await prisma.memberCreditNoteAllocation.findMany({ where: { appliedToBookingId: BOOKING_ID }, select: { id: true, amountCents: true } });
      expect(slices.map((slice) => slice.amountCents)).toEqual([PRICE_CENTS]);
      expect(await prisma.xeroObjectLink.count({ where: { localModel: "MemberCreditNoteAllocation", localId: slices[0]!.id, active: true } })).toBe(1);
      expect(await prisma.memberCredit.count({ where: { appliedToBookingId: BOOKING_ID, type: "BOOKING_APPLIED", xeroCreditNoteId: null } })).toBe(0);

      await raiseReplay();
      const { allocateAppliedCreditForBooking } = await import("@/lib/xero-applied-credit-allocation");
      await allocateAppliedCreditForBooking(BOOKING_ID);
      expect(await repairCodes()).not.toContain("UNALLOCATED_APPLIED_CREDIT");
      expect(allocationCount()).toBe(1);
      expect(allocatedCents()).toBe(PRICE_CENTS);
    });

    it("an invoice raised before #3836 is found by the repair pass, whose queued operation allocates it once; a second sweep finds nothing", async () => {
      await creditOnlyCardBooking();
      expect(await repairCodes()).toContain("UNALLOCATED_APPLIED_CREDIT");

      const applied = await repairReport(true);
      expect(applied.passes[0]!.bookings[0]!.actions.find((action) => action.type === "QUEUE_APPLIED_CREDIT_ALLOCATION")?.status).toBe("queued");
      const queued = await prisma.xeroSyncOperation.findMany({ where: { localModel: "Payment", localId: PAYMENT_ID, queueType: "APPLIED_CREDIT_ALLOCATION" }, select: { id: true } });
      expect(queued).toHaveLength(1);
      // A sweep re-run while it waits queues no second one.
      await repairReport(true);
      expect(await prisma.xeroSyncOperation.count({ where: { localModel: "Payment", localId: PAYMENT_ID, queueType: "APPLIED_CREDIT_ALLOCATION" } })).toBe(1);

      // The outbox worker's handler, as it dispatches the queued row.
      await prisma.xeroSyncOperation.update({ where: { id: queued[0]!.id }, data: { status: "RUNNING" } });
      const { allocateAppliedCreditForBooking } = await import("@/lib/xero-applied-credit-allocation");
      await allocateAppliedCreditForBooking(BOOKING_ID, { syncOperationId: queued[0]!.id });

      expect(PRICE_CENTS - allocatedCents()).toBe(await owed());
      expect(xeroCreditCents()).toBe(await credit.getMemberCreditBalance(MEMBER_ID));
      expect(await repairCodes()).not.toContain("UNALLOCATED_APPLIED_CREDIT");
      await raiseReplay();
      expect(allocationCount()).toBe(1);
    });

    it("then reduced (#3809): the $50 given back is deallocated by the REAL worker, and Xero agrees with the app on what is due and on the member's credit", async () => {
      await creditOnlyCardBooking();
      await raiseReplay();

      const removed = await removeLeavingGuest();
      expect(removed.priceDiffCents).toBe(-5_000);
      expect(await credit.getMemberCreditBalance(MEMBER_ID)).toBe(5_000);

      // Before #3836 a card booking had no allocation to release; now it does.
      const target = await runDeallocation();
      expect(target).toBe(15_000);
      expect(allocatedCents()).toBe(15_000);
      const noteCents = await queuedInvoiceNotesCents();
      expect(noteCents).toBe(5_000);
      expect(PRICE_CENTS - noteCents, "(i) the invoice net of its notes = the price").toBe(15_000);
      expect(PRICE_CENTS - noteCents - allocatedCents(), "(ii) Xero's amount due = the app's owed, $0").toBe(await owed());
      expect(xeroCreditCents(), "(iii) the member's Xero credit = the app's, $50").toBe(await credit.getMemberCreditBalance(MEMBER_ID));
      // The worker re-recorded the slice's provenance at its new figure: nothing left for the engine or the repair pass.
      await raiseReplay();
      expect(allocatedCents()).toBe(15_000);
      expect(await repairCodes()).not.toContain("UNALLOCATED_APPLIED_CREDIT");
    });

    it.each([
      { shape: "unreduced", reduce: false, priceCents: PRICE_CENTS, noteCents: 0, appCreditCents: PRICE_CENTS },
      { shape: "after the #3809 reduction", reduce: true, priceCents: 15_000, noteCents: 5_000, appCreditCents: PRICE_CENTS },
    ])("then cancelled at 100%, $shape: no clearing note, Xero owes nothing, and the cancel's restore is the noteless credit #2717 holds off Xero until spent", async ({ reduce, priceCents, noteCents, appCreditCents }) => {
      await creditOnlyCardBooking();
      await raiseReplay();
      if (reduce) {
        await removeLeavingGuest();
        await runDeallocation();
      }

      await cancel();

      // The invoice is already closed by the allocation (and the give-back's note), so no clearing note.
      expect(await queuedInvoiceNotesCents()).toBe(noteCents);
      expect(PRICE_CENTS - noteCents - allocatedCents(), "(ii) Xero's amount due = the app's owed, $0").toBe(await owed());
      expect(allocatedCents()).toBe(priceCents);
      expect(await credit.getMemberCreditBalance(MEMBER_ID)).toBe(appCreditCents);
      expect(xeroCreditCents() + (await notelessRestoredCents()), "(iii) the member's Xero credit + the noteless restore = the app's").toBe(appCreditCents);
      const codes = await repairCodes();
      expect(codes).not.toContain("UNALLOCATED_APPLIED_CREDIT");
      expect(codes).not.toContain("CANCELLED_BOOKING_OPEN_INVOICE");
    });

    it("an invoice raised before #3836 and then cancelled is left to the cancelled-open-invoice arm's clearing note, never allocated beside it", async () => {
      await creditOnlyCardBooking();

      await cancel();

      const codes = await repairCodes();
      expect(codes).toContain("CANCELLED_BOOKING_OPEN_INVOICE");
      expect(codes).not.toContain("UNALLOCATED_APPLIED_CREDIT");
      // With that note: Xero owes nothing, and the floating note is the member's restored credit.
      expect(PRICE_CENTS - PRICE_CENTS - allocatedCents()).toBe(await owed());
      expect(xeroCreditCents()).toBe(await credit.getMemberCreditBalance(MEMBER_ID));
    });

    it("FORCES the lock order and keeps the provider outside it: the engine queues on the member's credit-ledger key holding no row lock, and no ledger key is held during a Xero write", async () => {
      await creditOnlyCardBooking();
      const heldDuringWrites: number[] = [];
      fakeXero.state.onProviderWrite = async () => {
        const rows = await observerClient.$queryRaw<Array<{ count: number }>>`
          SELECT COUNT(*)::int AS "count" FROM pg_locks l JOIN pg_database d ON d.oid = l.database
          WHERE l.locktype = 'advisory' AND l.granted AND d.datname = current_database()
        `;
        heldDuringWrites.push(rows[0]?.count ?? -1);
      };
      const release = deferred();
      const holderPid = deferred<number>();
      const holder = lockHolderClient.$transaction(async (tx) => {
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext('member-credit-ledger'), hashtext(${MEMBER_ID}))`;
        const rows = await tx.$queryRaw<Array<{ pid: number }>>`SELECT pg_backend_pid() AS pid`;
        holderPid.resolve(rows[0]!.pid);
        await release.promise;
      }, { timeout: 20_000 });

      // The key is held BEFORE the engine starts, so its first transaction queues on it.
      const pid = await holderPid.promise;
      const { allocateAppliedCreditForBooking } = await import("@/lib/xero-applied-credit-allocation");
      const allocation = allocateAppliedCreditForBooking(BOOKING_ID);
      await waitForBlockedBy(pid);

      expect(fakeXero.state.providerWrites).toBe(0);
      await expect(observerClient.$transaction(async (tx) => {
        await tx.$queryRaw`SELECT id FROM "Payment" WHERE id = ${PAYMENT_ID} FOR UPDATE NOWAIT`;
        await tx.$queryRaw`SELECT id FROM "MemberCredit" WHERE "memberId" = ${MEMBER_ID} FOR UPDATE NOWAIT`;
      })).resolves.toBeUndefined();

      release.resolve();
      await holder;
      await allocation;
      expect(allocatedCents()).toBe(PRICE_CENTS);
      expect(heldDuringWrites).toEqual([0]);
    });

    async function waitForBlockedBy(blockerPid: number) {
      const startedAt = process.hrtime.bigint();
      while (realElapsedMs(startedAt) < LOCK_POLL_TIMEOUT_MS) {
        const rows = await observerClient.$queryRaw<Array<{ count: number }>>`
          SELECT COUNT(*)::int AS "count" FROM pg_stat_activity
          WHERE datname = current_database() AND ${blockerPid}::int = ANY(pg_blocking_pids(pid))
        `;
        if ((rows[0]?.count ?? 0) >= 1) return;
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      throw new Error(`Timed out waiting for the allocation to queue behind the member-credit key held by pid ${blockerPid}.`);
    }
  },
);

function deferred<T = void>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}
