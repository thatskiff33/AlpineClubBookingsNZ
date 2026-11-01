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
import { ENVIRONMENT_ROLE_ENV_VAR } from "@/lib/environment-role-declaration";
import type { SuiteEnvironmentRoleDeclaration } from "./helpers/environment-role";
import { CLUB_FORMAT_TEST } from "./support/club-format-fixture";
import { memberMoneyTestContext } from "./support/member-money-fixtures";
import { currentXeroClaim } from "@/lib/__tests__/helpers/xero-claim";

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
/** The earlier cancellation's credit: the lot whose floating note the engine allocates. */
const ORIGINAL_LOT_ID = "race-3836-lot-original";

const TODAY = new Date("2026-07-01T00:00:00.000Z");
/**
 * #4013: when the earlier cancellation's credit was written. It is stated, not
 * left to the frozen clock: every row the cancel writes is stamped TODAY, so a
 * lot the fixture also stamped TODAY tied with them, and which one the engine
 * used first was PostgreSQL's choice (`INV-PAY-127`).
 */
const EARLIER_CANCELLATION_AT = new Date("2026-06-01T00:00:00.000Z");
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
const FIFTY_LESS_TWENTY = { refundPercentage: 50, fixedFeeCents: 2_000 };
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
    refuseNextAllocation: false,
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
      if (state.refuseNextAllocation) {
        state.refuseNextAllocation = false;
        throw new Error("fake Xero: the allocation request failed");
      }
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

/**
 * #4013: the harness says what installation it is, as a deployment must
 * (`INV-CONFIG-003`): a disposable copy, so `non-production`, one of the only
 * two values the declaration accepts. It is declared for this describe alone and
 * put back after it, and the describe that follows fails if it was not, so no
 * suite the shared harness runs later inherits it. Unset until declared.
 */
let harnessRole: SuiteEnvironmentRoleDeclaration | undefined;

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
    async function creditOnlyCardBooking({ cardCents = 0, source = "STRIPE" as "STRIPE" | "INTERNET_BANKING", originalLotAt = EARLIER_CANCELLATION_AT } = {}) {
      const creditCents = PRICE_CENTS - cardCents;
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
      // The $0 row the credit-covered settle writes (booking-create.ts); with
      // cardCents, a card-and-credit capture, or with INTERNET_BANKING a bank
      // transfer received, whose credit #1620's own operation allocates.
      const bank = source === "INTERNET_BANKING";
      await prisma.payment.create({
        data: {
          id: PAYMENT_ID, bookingId: BOOKING_ID, amountCents: cardCents, status: "SUCCEEDED", creditAppliedCents: creditCents, source, xeroInvoiceId: XERO_INVOICE_ID,
        },
      });
      if (cardCents > 0) {
        await prisma.paymentTransaction.create({
          data: bank
            ? { paymentId: PAYMENT_ID, kind: "PRIMARY", source: "INTERNET_BANKING", reference: "race-3836-ref", amountCents: cardCents, status: "SUCCEEDED" }
            : { paymentId: PAYMENT_ID, kind: "PRIMARY", source: "STRIPE", stripePaymentIntentId: "race-3836-pi", amountCents: cardCents, status: "SUCCEEDED" },
        });
      }
      // An EARLIER cancellation's credit, so it is older than anything the
      // test's own cancel writes (#4013).
      await prisma.memberCredit.create({
        data: {
          id: ORIGINAL_LOT_ID, memberId: MEMBER_ID, amountCents: creditCents, type: "CANCELLATION_REFUND", description: "race 3836 earlier cancellation",
          xeroCreditNoteId: CREDIT_NOTE_ID, createdAt: originalLotAt,
        },
      });
      await prisma.$transaction((tx) => credit.applyCreditToBooking(MEMBER_ID, creditCents, BOOKING_ID, tx, CLUB_FORMAT_TEST));

      fakeXero.state.on = true;
      fakeXero.state.seq = 0;
      fakeXero.state.providerWrites = 0;
      fakeXero.state.onProviderWrite = null;
      fakeXero.state.seenKeys.clear();
      fakeXero.state.invoices = new Map([[XERO_INVOICE_ID, PRICE_CENTS]]);
      fakeXero.state.refuseNextAllocation = false;
      fakeXero.state.notes = new Map([[CREDIT_NOTE_ID, { totalCents: creditCents, allocations: [] }]]);
      expect(await credit.getMemberCreditBalance(MEMBER_ID)).toBe(0);
      if (cardCents === 0) expect(await owed()).toBe(0);
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

    /**
     * #4013: the remainder mint's first step past its own link check is the
     * member's Xero contact, and nothing else in the engine asks for one. This
     * turns that step into a refusal naming the path, so a run that reaches
     * `mintAppliedCreditRemainderNote` fails saying so - not in the contact
     * guard's environment check, which is where H1 used to fail. Read the
     * spy's call count BEFORE restoring it in a `finally`: `mockRestore()`
     * clears `mock.calls`, so an assertion after it could never fail.
     */
    async function refuseRemainderMint() {
      const contacts = await import("@/lib/xero-contacts");
      return vi.spyOn(contacts, "findOrCreateXeroContact").mockRejectedValue(
        new Error("#4013: the allocation engine entered the remainder-note path (mintAppliedCreditRemainderNote)"),
      );
    }
    /** Any trace of a remainder note for the payment: its link or its sync operation. */
    async function remainderNoteRecords() {
      const [links, operations] = await Promise.all([
        prisma.xeroObjectLink.count({ where: { localModel: "Payment", localId: PAYMENT_ID, role: "APPLIED_CREDIT_REMAINDER_NOTE" } }),
        prisma.xeroSyncOperation.count({ where: { localModel: "Payment", localId: PAYMENT_ID, idempotencyKey: { contains: "applied-credit-remainder-note" } } }),
      ]);
      return links + operations;
    }

    async function raiseReplay() {
      const { createXeroInvoiceForBooking } = await import("@/lib/xero-booking-invoices");
      await expect(createXeroInvoiceForBooking(BOOKING_ID)).resolves.toBe(XERO_INVOICE_ID);
    }

    async function removeLeavingGuest(settlementMethod?: "card" | "credit") {
      const { removeBookingGuestInTransaction } = await import("@/lib/booking-guest-removal-service");
      const result = await prisma.$transaction(
        (tx) => removeBookingGuestInTransaction({
          tx, bookingId: BOOKING_ID, guestId: LEAVING_GUEST_ID, actorMemberId: MEMBER_ID, actorRole: "ADMIN", today: TODAY, format: CLUB_FORMAT_TEST, journal: memberMoneyTestContext(),
          ...(settlementMethod ? { settlementMethod } : {}),
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
      await deallocateExcessAppliedCreditForBooking(BOOKING_ID, { syncOperation: await currentXeroClaim(prisma, operation.id) });
      return Number(operation.correlationKey?.split(":").at(-2));
    }

    async function cancel(refundMethod: "card" | "credit" = "card") {
      const { cancelBooking } = await import("@/lib/booking-cancel");
      const result = await cancelBooking(BOOKING_ID, MEMBER_ID, "ADMIN", "127.0.0.1", CLUB_FORMAT_TEST, refundMethod);
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
      // Imported here, not at the top: it reaches `@/lib/prisma`, which must
      // first see the race database's URL.
      const { declareEnvironmentRoleForSuite } = await import("./helpers/environment-role");
      harnessRole = declareEnvironmentRoleForSuite("non-production");
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
      try {
        await Promise.all([lockHolderClient, observerClient].map((client) => (client ? client.$disconnect().catch(() => {}) : Promise.resolve())));
        if (typeof prisma !== "undefined") {
          try {
            await deleteFixtures();
          } finally {
            await prisma.$disconnect().catch(() => {});
          }
        }
      } finally {
        harnessRole?.restore();
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
      await allocateAppliedCreditForBooking(BOOKING_ID, { syncOperation: await currentXeroClaim(prisma, queued[0]!.id) });

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

    const mirror = async () => (await prisma.payment.findUniqueOrThrow({ where: { id: PAYMENT_ID }, select: { creditAppliedCents: true } })).creditAppliedCents;
    async function inboundSync(amountCents: number) {
      const { repairAccountCreditAllocationBusinessState } = await import("@/lib/xero-inbound/credit-note-repairs");
      await repairAccountCreditAllocationBusinessState(CREDIT_NOTE_ID, [{ invoiceId: XERO_INVOICE_ID, amountCents }]);
    }
    /** The booking's invoice operation, as the outbox left it after a raise. */
    async function invoiceOperation(status: "PARTIAL" | "FAILED" | "RUNNING") {
      return prisma.xeroSyncOperation.create({
        data: {
          direction: "OUTBOUND", entityType: "INVOICE", operationType: "CREATE", localModel: "Payment", localId: PAYMENT_ID, status, replayable: true,
          queueType: "BOOKING_INVOICE", requestPayload: { queueType: "BOOKING_INVOICE", bookingId: BOOKING_ID }, xeroObjectType: "INVOICE", xeroObjectId: XERO_INVOICE_ID,
        },
        select: { id: true },
      });
    }
    async function replayInvoiceOperation(operationId: string) {
      await prisma.xeroSyncOperation.update({ where: { id: operationId }, data: { status: "RUNNING" } });
      const { createXeroInvoiceForBooking } = await import("@/lib/xero-booking-invoices");
      await createXeroInvoiceForBooking(BOOKING_ID, { syncOperation: await currentXeroClaim(prisma, operationId) });
    }
    const sweepActions = async () => (await repairReport()).passes[0]!.bookings.flatMap((booking) => booking.actions);
    const clearingNoteQueued = async () => (await sweepActions()).some((action) => action.key === `queue:cancelled-open-invoice:${BOOKING_ID}`);

    it("C1: the inbound credit-note sync keeps a credit-only card payment's applied credit at $200, not its $0 card amount, and the cancel then restores the $200", async () => {
      await creditOnlyCardBooking();
      await raiseReplay();

      await inboundSync(PRICE_CENTS);
      expect(await mirror()).toBe(PRICE_CENTS);

      await cancel();
      expect(await credit.getMemberCreditBalance(MEMBER_ID)).toBe(PRICE_CENTS);
    });

    it("C1: a card-and-credit payment ($50 card, $150 credit) is not clipped to its card amount, and the cancel (to account credit) returns all $200", async () => {
      await creditOnlyCardBooking({ cardCents: 5_000 });
      await raiseReplay();
      expect(allocatedCents()).toBe(15_000);

      await inboundSync(15_000);
      expect(await mirror()).toBe(15_000);

      await cancel("credit");
      expect(await credit.getMemberCreditBalance(MEMBER_ID)).toBe(PRICE_CENTS);
    });

    /**
     * M-1: a booking reduced BEFORE #3809 (price lowered, no give-back
     * recorded) keeps all its credit at a cancel (owner decision, 4 Oct 2026).
     * The inbound sync must not change that: the cancel after a sync returns
     * exactly what the same cancel returns with no sync.
     */
    async function preReleaseReducedCancel({ cardCents, reducedToCents, rule, sync }: { cardCents: number; reducedToCents: number; rule: typeof FULL_REFUND; sync: boolean }) {
      await creditOnlyCardBooking({ cardCents });
      await raiseReplay();
      await prisma.booking.update({ where: { id: BOOKING_ID }, data: { totalPriceCents: reducedToCents, finalPriceCents: reducedToCents } });
      if (sync) await inboundSync(PRICE_CENTS - cardCents);
      await prisma.cancellationPolicy.updateMany({ where: { lodgeId: LODGE_ID }, data: rule });
      await cancel("credit");
      return credit.getMemberCreditBalance(MEMBER_ID);
    }

    it.each([
      { shape: "credit-only reduced to $150, 100%", cardCents: 0, reducedToCents: 15_000, rule: FULL_REFUND, expectedCents: 20_000 },
      { shape: "credit-only reduced to $150, 50% less $20", cardCents: 0, reducedToCents: 15_000, rule: FIFTY_LESS_TWENTY, expectedCents: 8_000 },
      { shape: "$50 card + $150 credit reduced to $100, 100%", cardCents: 5_000, reducedToCents: 10_000, rule: FULL_REFUND, expectedCents: 20_000 },
      { shape: "$50 card + $150 credit reduced to $100, 50% less $20", cardCents: 5_000, reducedToCents: 10_000, rule: FIFTY_LESS_TWENTY, expectedCents: null },
    ])("M-1: a booking reduced before #3809 ($shape) is never short after the inbound sync - the cancel returns what it returns unsynced", async ({ cardCents, reducedToCents, rule, expectedCents }) => {
      const unsynced = await preReleaseReducedCancel({ cardCents, reducedToCents, rule, sync: false });
      const synced = await preReleaseReducedCancel({ cardCents, reducedToCents, rule, sync: true });
      expect(synced).toBe(unsynced);
      if (expectedCents !== null) expect(synced).toBe(expectedCents);
      expect(await mirror()).toBe(PRICE_CENTS - cardCents);
    });

    it("L-1: $50 card + $150 credit with a mirror the old sync clipped to $50, a #3809 reduction that refunds the card whole, then the cancel at 100%: the $150 of credit comes back, not $50 - and the preview says so", async () => {
      await creditOnlyCardBooking({ cardCents: 5_000 });
      await raiseReplay();
      await prisma.payment.update({ where: { id: PAYMENT_ID }, data: { creditAppliedCents: 5_000 } });
      const removed = await removeLeavingGuest("card");
      expect(removed.refundAmountCents).toBe(5_000);
      // The route's Stripe refund, landed: the card is refunded whole.
      await prisma.payment.update({ where: { id: PAYMENT_ID }, data: { refundedAmountCents: 5_000, status: "REFUNDED" } });
      await prisma.paymentTransaction.updateMany({ where: { paymentId: PAYMENT_ID }, data: { refundedAmountCents: 5_000, status: "REFUNDED" } });
      const { refundedPaymentCreditRestore } = await import("@/lib/cancel-refunded-payment-credit");
      const booking = await prisma.booking.findUniqueOrThrow({ where: { id: BOOKING_ID }, include: { payment: true } });
      const previewed = await refundedPaymentCreditRestore(prisma, { bookingId: BOOKING_ID, booking: { ...booking, payment: booking.payment! }, openNonCancellationHandBackCents: 0, todayAtClub: "2026-07-01" as never });
      expect(previewed?.creditToRestoreCents).toBe(15_000);

      await cancel();
      expect(await credit.getMemberCreditBalance(MEMBER_ID)).toBe(15_000);
    });

    it("#3836 with #3827 (`INV-PAY-117`): $50 card + $150 credit, the mirror clipped to $50, and $20 an earlier edit promised back by hand - the cancel refunds $30 and restores $150, the figures the preview quotes", async () => {
      await creditOnlyCardBooking({ cardCents: 5_000 });
      await raiseReplay();
      await prisma.payment.update({ where: { id: PAYMENT_ID }, data: { creditAppliedCents: 5_000 } });
      const { EDIT_REFUND_HAND_BACK_KEY_PREFIX } = await import("@/lib/manual-refund-task-settlement-rules");
      await prisma.manualRefundTask.create({
        data: {
          bookingId: BOOKING_ID, paymentId: PAYMENT_ID, amountCents: 2_000, raisedAmountCents: 2_000, kind: "CANCELLED_BOOKING_HAND_BACK",
          occurrenceKey: `${EDIT_REFUND_HAND_BACK_KEY_PREFIX}race-3836`, reason: "race 3836 open edit refund hand-back",
        },
      });

      // The route's quote for this exact shape is pinned in
      // `cancel-preview/__tests__/clipped-mirror-open-hand-back.test.ts`; the route
      // is not called here because stubbing `@/lib/auth` would replace the session
      // mock a sibling suite of this shared harness registers for the same path.
      const { cancelBooking } = await import("@/lib/booking-cancel");
      const result = await cancelBooking(BOOKING_ID, MEMBER_ID, "ADMIN", "127.0.0.1", CLUB_FORMAT_TEST, "credit");
      expect(result.status).toBe(200);
      const cancelled = (result as { data: { refundAmountCents: number; creditRestoredCents?: number } }).data;
      // $50 less the $20 promised back is the $30 refundable; the ledger's $150, not the clipped $50, is tiered.
      expect(cancelled.refundAmountCents).toBe(3_000);
      expect(cancelled.creditRestoredCents).toBe(15_000);
      // The $30 card slice to account credit and the $150 restored; the $20 stays the treasurer's to send.
      expect(await credit.getMemberCreditBalance(MEMBER_ID)).toBe(18_000);
      expect(await prisma.manualRefundTask.count({ where: { bookingId: BOOKING_ID, status: "OPEN", amountCents: 2_000 } })).toBe(1);
    });

    it.each([
      { shape: "credit-only, zeroed", cardCents: 0, clippedCents: 0 },
      { shape: "card-and-credit, clipped to the card", cardCents: 5_000, clippedCents: 5_000 },
    ])("C1: a mirror the old sync already wrote ($shape) is tiered from the ledger, so the cancel still returns all $200", async ({ cardCents, clippedCents }) => {
      await creditOnlyCardBooking({ cardCents });
      await raiseReplay();
      await prisma.payment.update({ where: { id: PAYMENT_ID }, data: { creditAppliedCents: clippedCents } });

      await cancel("credit");
      expect(await credit.getMemberCreditBalance(MEMBER_ID)).toBe(PRICE_CENTS);
    });

    it("H1 probe 4: a pre-#3836 invoice whose operation failed after its raise, then cancelled - the sweep waits for the operation, its replay allocates nothing, and only then is the invoice cleared, once", async () => {
      await creditOnlyCardBooking();
      const operation = await invoiceOperation("FAILED");
      await cancel();

      const waiting = await sweepActions();
      expect(waiting.map((action) => action.key)).toContain(`retry:${operation.id}`);
      expect(await clearingNoteQueued()).toBe(false);

      await replayInvoiceOperation(operation.id);
      expect(allocatedCents()).toBe(0);
      expect(await prisma.memberCreditNoteAllocation.count({ where: { appliedToBookingId: BOOKING_ID } })).toBe(0);

      await repairReport(true);
      expect(await queuedInvoiceNotesCents()).toBe(PRICE_CENTS);
      expect(PRICE_CENTS - (await queuedInvoiceNotesCents()) - allocatedCents(), "the invoice credited exactly once").toBe(0);
      // The member's note was never consumed: it is the restored credit, so Xero and the app agree.
      expect(xeroCreditCents()).toBe(await credit.getMemberCreditBalance(MEMBER_ID));
    });

    it("H1 probe 5: the sweep queues the allocation, the booking is cancelled, and the allocation then finds the cancel settled it - the clearing note alone credits the invoice", async () => {
      await creditOnlyCardBooking();
      await repairReport(true);
      const queued = await prisma.xeroSyncOperation.findFirstOrThrow({ where: { localModel: "Payment", localId: PAYMENT_ID, queueType: "APPLIED_CREDIT_ALLOCATION" }, select: { id: true } });
      await cancel();

      expect(await clearingNoteQueued()).toBe(false);
      await prisma.xeroSyncOperation.update({ where: { id: queued.id }, data: { status: "RUNNING" } });
      const { allocateAppliedCreditForBooking } = await import("@/lib/xero-applied-credit-allocation");
      await allocateAppliedCreditForBooking(BOOKING_ID, { syncOperation: await currentXeroClaim(prisma, queued.id) });
      expect(allocatedCents()).toBe(0);

      await repairReport(true);
      expect(PRICE_CENTS - (await queuedInvoiceNotesCents()) - allocatedCents(), "the invoice credited exactly once").toBe(0);
      expect(await queuedInvoiceNotesCents()).toBe(PRICE_CENTS);
      expect(xeroCreditCents()).toBe(await credit.getMemberCreditBalance(MEMBER_ID));
    });

    it("H1 orphan slice: a slice committed before Xero failed is finished after the cancel (the cancel counted it), so no clearing note is needed and the member's note is not left floating", async () => {
      await creditOnlyCardBooking();
      const operation = await invoiceOperation("RUNNING");
      fakeXero.state.refuseNextAllocation = true;
      await expect(replayInvoiceOperation(operation.id)).rejects.toThrow(/fake Xero/);
      await prisma.xeroSyncOperation.update({ where: { id: operation.id }, data: { status: "FAILED" } });
      expect(await prisma.memberCreditNoteAllocation.count({ where: { appliedToBookingId: BOOKING_ID } })).toBe(1);

      await cancel();
      expect(await clearingNoteQueued()).toBe(false);
      await replayInvoiceOperation(operation.id);

      expect(allocatedCents()).toBe(PRICE_CENTS);
      expect(await clearingNoteQueued()).toBe(false);
      expect(PRICE_CENTS - (await queuedInvoiceNotesCents()) - allocatedCents(), "the invoice credited exactly once").toBe(0);
      expect(xeroCreditCents() + (await notelessRestoredCents()), "the member's Xero credit + the noteless restore (#2717) = the app's").toBe(
        await credit.getMemberCreditBalance(MEMBER_ID),
      );
    });

    it("H1, captured money: a bank-transfer booking ($150 paid, $50 credit) cancelled before #1620's allocation ran keeps the allocation - its cancel clears nothing, so the invoice is not left owing the credit", async () => {
      await creditOnlyCardBooking({ cardCents: 15_000, source: "INTERNET_BANKING" });
      const { enqueueXeroAppliedCreditAllocationOperation } = await import("@/lib/xero-operation-outbox");
      const queued = await enqueueXeroAppliedCreditAllocationOperation(BOOKING_ID);
      await cancel("credit");
      expect(await clearingNoteQueued()).toBe(false);

      // #4013: the member now holds three positive lots - the earlier noted
      // $50, the cancel's noteless $50 restore and its $150 of cash turned to
      // credit. The earlier lot is the oldest, so the $50 applied is its note,
      // allocated, and the engine never reaches the remainder mint (which this
      // fake cannot serve).
      const remainderMint = await refuseRemainderMint();
      await prisma.xeroSyncOperation.update({ where: { id: queued.queueOperationId! }, data: { status: "RUNNING" } });
      const { allocateAppliedCreditForBooking } = await import("@/lib/xero-applied-credit-allocation");
      let remainderMintCalls = -1;
      try {
        await allocateAppliedCreditForBooking(BOOKING_ID, { syncOperation: await currentXeroClaim(prisma, queued.queueOperationId!) });
      } finally {
        remainderMintCalls = remainderMint.mock.calls.length;
        remainderMint.mockRestore();
      }
      expect(remainderMintCalls, "the remainder-note path (mintAppliedCreditRemainderNote) was not entered").toBe(0);
      expect(await remainderNoteRecords(), "no remainder note was minted or attempted").toBe(0);
      const slices = await prisma.memberCreditNoteAllocation.findMany({ where: { appliedToBookingId: BOOKING_ID }, select: { memberCreditId: true, xeroCreditNoteId: true, amountCents: true } });
      expect(slices).toEqual([{ memberCreditId: ORIGINAL_LOT_ID, xeroCreditNoteId: CREDIT_NOTE_ID, amountCents: 5_000 }]);

      // $150 of cash and the $50 note pay the $200 invoice: nothing owing, nothing over.
      expect(allocatedCents()).toBe(5_000);
      expect(PRICE_CENTS - 15_000 - allocatedCents()).toBe(0);
    });

    const TIED_NOTE_ID = "race-3836-credit-note-tied";
    /**
     * #4013: the fixture, plus a second noted $200 lot stamped with the same
     * instant as the fixture's and written after it. Either lot could fund the
     * $200 alone, so which one a slice draws from is the use order and nothing
     * else.
     */
    async function creditOnlyCardBookingWithTiedLot(tiedLotId: string) {
      await creditOnlyCardBooking({ originalLotAt: TODAY });
      await prisma.memberCredit.create({
        data: { id: tiedLotId, memberId: MEMBER_ID, amountCents: PRICE_CENTS, type: "CANCELLATION_REFUND", description: "race 3836 tied cancellation", xeroCreditNoteId: TIED_NOTE_ID, createdAt: TODAY },
      });
      fakeXero.state.notes.set(TIED_NOTE_ID, { totalCents: PRICE_CENTS, allocations: [] });
    }
    const committedSlices = () =>
      prisma.memberCreditNoteAllocation.findMany({ where: { appliedToBookingId: BOOKING_ID }, select: { memberCreditId: true, xeroCreditNoteId: true, amountCents: true } });

    it.each([
      { shape: "the lower id written second", tiedLotId: "race-3836-lot-0-tied", usedLotId: "race-3836-lot-0-tied" },
      { shape: "the lower id written first", tiedLotId: "race-3836-lot-z-tied", usedLotId: ORIGINAL_LOT_ID },
    ])("#4013 (`INV-PAY-127`): of two noted lots stamped with the same instant, the engine uses the lower id first, $shape", async ({ tiedLotId, usedLotId }) => {
      await creditOnlyCardBookingWithTiedLot(tiedLotId);

      await raiseReplay();

      const slices = await prisma.memberCreditNoteAllocation.findMany({ where: { appliedToBookingId: BOOKING_ID }, select: { memberCreditId: true, amountCents: true } });
      expect(slices).toEqual([{ memberCreditId: usedLotId, amountCents: PRICE_CENTS }]);
      expect(allocatedCents()).toBe(PRICE_CENTS);
    });

    it("#4013 (`INV-PAY-127`): a retry after Xero refused the first allocation re-plans onto the slice it committed - one slice, allocated once", async () => {
      await creditOnlyCardBookingWithTiedLot("race-3836-lot-0-tied");
      const { allocateAppliedCreditForBooking } = await import("@/lib/xero-applied-credit-allocation");
      fakeXero.state.refuseNextAllocation = true;
      await expect(allocateAppliedCreditForBooking(BOOKING_ID)).rejects.toThrow(/fake Xero/);
      const committed = [{ memberCreditId: "race-3836-lot-0-tied", xeroCreditNoteId: TIED_NOTE_ID, amountCents: PRICE_CENTS }];
      expect(await committedSlices()).toEqual(committed);

      await allocateAppliedCreditForBooking(BOOKING_ID);

      expect(await committedSlices(), "the retry kept the committed slice and added none").toEqual(committed);
      expect(fakeXero.state.notes.get(TIED_NOTE_ID)!.allocations).toHaveLength(1);
      expect(allocatedCents()).toBe(PRICE_CENTS);
    });

    it("#4013 (`INV-PAY-127`): a slice committed under another order (before the tie-break, across a deploy) is refused, never re-planned beside: nothing is written and Xero is not called", async () => {
      await creditOnlyCardBookingWithTiedLot("race-3836-lot-0-tied");
      // What `createdAt`-only code could have committed when the database
      // returned the fixture's lot first; Xero then refused, and the retry runs
      // under CREDIT_LOT_USE_ORDER, which picks the lower id.
      const committed = [{ memberCreditId: ORIGINAL_LOT_ID, xeroCreditNoteId: CREDIT_NOTE_ID, amountCents: PRICE_CENTS }];
      await prisma.memberCreditNoteAllocation.create({ data: { ...committed[0]!, appliedToBookingId: BOOKING_ID } });
      const { allocateAppliedCreditForBooking } = await import("@/lib/xero-applied-credit-allocation");

      await expect(allocateAppliedCreditForBooking(BOOKING_ID)).rejects.toThrow(/would not keep the slice\(s\) already committed.*INV-PAY-127/);

      expect(await committedSlices(), "no second slice beside the committed one").toEqual(committed);
      expect(fakeXero.state.providerWrites, "Xero was not called").toBe(0);
      expect(allocatedCents()).toBe(0);
      const { unallocatedAppliedCents } = await import("@/lib/xero-applied-credit-ledger-state");
      expect(await unallocatedAppliedCents(BOOKING_ID), "nothing was stamped").toBe(PRICE_CENTS);
    });

    it("FORCES the lock order and keeps the provider outside it: the engine queues on the member's credit-ledger key holding no row lock, and no ledger key is held during a Xero write", async () => {
      await creditOnlyCardBooking();
      const heldDuringWrites: number[] = [];
      fakeXero.state.onProviderWrite = async () => {
        const rows = await observerClient.$queryRaw<Array<{ count: number }>>`
          SELECT COUNT(*)::int AS "count" FROM pg_locks l JOIN pg_database d ON d.oid = l.database
          WHERE l.locktype = 'advisory' AND l.granted AND d.datname = current_database() AND l.objsubid = 2
            AND l.classid = ((hashtext('member-credit-ledger')::bigint + 4294967296) % 4294967296)::oid
            AND l.objid = ((hashtext(${MEMBER_ID})::bigint + 4294967296) % 4294967296)::oid
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

// #4013: runs after the describe above has finished, its `afterAll` included,
// so a declaration that outlived it fails here rather than silently arming
// whichever suite the shared harness runs next.
(RUN ? describe : describe.skip)("#4013: the #3836 harness puts the environment role back", () => {
  it("leaves APP_ENVIRONMENT_ROLE as it found it, so no later suite inherits the harness's declaration", () => {
    expect(harnessRole, "the harness declared its environment role").toBeDefined();
    expect(process.env[ENVIRONMENT_ROLE_ENV_VAR]).toBe(harnessRole!.before);
  });
});

function deferred<T = void>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}
