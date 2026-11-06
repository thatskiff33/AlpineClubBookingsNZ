/**
 * Real-PostgreSQL proof for #4219: when a credit note funding a booking's
 * applied credit was spent in Xero outside the app, the allocation worker brings
 * the credit ledger into line with Xero by itself - the lot is written down, the
 * booking's applied credit is released, the failed allocation is closed - and
 * writes nothing to Xero.
 *
 * Xero is a fake provider at the client seam (`getAuthenticatedXeroClient`,
 * `callXeroApi`), installed with `vi.spyOn` for this describe only and restored
 * after it, NOT with a module-level `vi.mock`: this file is imported into the
 * shared race harness, where a second `vi.mock` of the same module would replace
 * the #3836 suite's fake. It keeps each credit note's allocations (including the outside
 * spend), honours idempotency keys, and REFUSES an allocation beyond a note's
 * remaining credit with Xero's own wording. Everything else is real: the ledger,
 * the slices, the allocation engine, the lock protocol and the audit log. The
 * fake is switched on only inside this describe.
 *
 * Envelope: identical to `concurrency-lock-races.realdb.test.ts`, which imports
 * this file; the describe runs ONLY when `RUN_CONCURRENCY_RACE_TESTS=1`, against
 * a loopback database on port 55442+ named with `concurrency_race_1881`.
 *
 *   RUN_CONCURRENCY_RACE_TESTS=1 \
 *   CONCURRENCY_RACE_DATABASE_URL=postgresql://user:pass@127.0.0.1:55442/concurrency_race_1881 \
 *   pnpm exec vitest run src/lib/__tests__/credit-note-spent-outside-app.realdb.test.ts
 */
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { releaseBookingJournalForTeardown } from "./support/booking-financial-history-teardown";

import { ENVIRONMENT_ROLE_ENV_VAR } from "@/lib/environment-role-declaration";
import { realElapsedMs } from "@/lib/__tests__/helpers/clock";
import type { SuiteEnvironmentRoleDeclaration } from "./helpers/environment-role";
import { CLUB_FORMAT_TEST } from "./support/club-format-fixture";

const RUN = process.env.RUN_CONCURRENCY_RACE_TESTS === "1";
const RACE_DB_URL = process.env.CONCURRENCY_RACE_DATABASE_URL ?? "";

const MEMBER_ID = "race-4219-member";
const OTHER_MEMBER_ID = "race-4219-member-two";
const LODGE_ID = "race-4219-lodge";
const BOOKING_ID = "race-4219-booking";
const SECOND_BOOKING_ID = "race-4219-booking-two";
const GUEST_ID = "race-4219-guest";
const PAYMENT_ID = "race-4219-payment";
const SECOND_PAYMENT_ID = "race-4219-payment-two";
const XERO_INVOICE_ID = "race-4219-xero-invoice";
const SECOND_XERO_INVOICE_ID = "race-4219-xero-invoice-two";
const SPENT_NOTE_ID = "race-4219-note-spent";
const HEALTHY_NOTE_ID = "race-4219-note-healthy";
const SPENT_LOT_ID = "race-4219-lot-spent";
const HEALTHY_LOT_ID = "race-4219-lot-healthy";
const SUBSCRIPTION_INVOICE_ID = "race-4219-subscription-invoice";
const OUTSIDE_INVOICE_ID = "race-4219-outside-invoice";
const KNOWN_APP_INVOICE_ID = "race-4219-known-app-invoice";

const NIGHTS = [new Date("2026-08-01T00:00:00.000Z"), new Date("2026-08-02T00:00:00.000Z")];
const CHECK_IN = NIGHTS[0]!;
const CHECK_OUT = new Date("2026-08-03T00:00:00.000Z");
const PRICE_CENTS = 20_000;
const CREDIT_CENTS = 5_250;
/** Older than the healthy lot, which is NEWER than the converge's own rows: a release row that were a lot would be planned first (`INV-PAY-127`). */
const SPENT_LOT_AT = new Date("2026-05-01T00:00:00.000Z");
const HEALTHY_LOT_AT = new Date("2026-12-01T00:00:00.000Z");

/** The fake Xero: each note's total and allocations, and what the app tried. */
const fakeXero = vi.hoisted(() => {
  const XERO_REFUSAL_TEXT =
    "Credit Note cannot be allocated as the allocation amount is greater than the amount remaining on the Credit Note";
  type Allocation = { allocationID: string; invoiceID: string; amountCents: number; isDeleted?: boolean };
  const state = {
    on: false,
    seq: 0,
    notes: new Map<string, { totalCents: number; allocations: Allocation[]; payments: Array<{ paymentID: string; amountCents: number }> }>(),
    seenKeys: new Map<string, unknown>(),
    acceptedAllocations: 0,
    refusedAllocations: 0,
    deallocations: 0,
  };
  const remainingCents = (noteId: string) => {
    const note = state.notes.get(noteId);
    return note ? note.totalCents - note.allocations.filter((a) => !a.isDeleted).reduce((sum, a) => sum + a.amountCents, 0) - note.payments.reduce((sum, p) => sum + p.amountCents, 0) : 0;
  };
  const noteBody = (creditNoteID: string) => {
    const note = state.notes.get(creditNoteID);
    const remaining = remainingCents(creditNoteID);
    return {
      creditNotes: [
        {
          creditNoteID,
          status: remaining > 0 ? "AUTHORISED" : "PAID",
          total: (note?.totalCents ?? 0) / 100,
          remainingCredit: remaining / 100,
          payments: (note?.payments ?? []).map((p) => ({ paymentID: p.paymentID, amount: p.amountCents / 100 })),
          allocations: (note?.allocations ?? []).map((a) => ({
            allocationID: a.allocationID,
            invoice: { invoiceID: a.invoiceID },
            amount: a.amountCents / 100,
            isDeleted: a.isDeleted ?? false,
          })),
        },
      ],
    };
  };
  const accountingApi = {
    async createCreditNoteAllocation(
      _tenant: string,
      creditNoteID: string,
      body: { allocations: Array<{ invoice: { invoiceID: string }; amount: number }> },
      _summarize: unknown,
      idempotencyKey?: string,
    ) {
      if (idempotencyKey && state.seenKeys.has(idempotencyKey)) return { body: state.seenKeys.get(idempotencyKey) };
      const note = state.notes.get(creditNoteID);
      if (!note) throw new Error(`fake Xero: no credit note ${creditNoteID}`);
      for (const { invoice, amount } of body.allocations) {
        const cents = Math.round(amount * 100);
        if (cents > remainingCents(creditNoteID)) {
          state.refusedAllocations += 1;
          throw new Error(XERO_REFUSAL_TEXT);
        }
        note.allocations.push({ allocationID: `race-4219-allocation-${(state.seq += 1)}`, invoiceID: invoice.invoiceID, amountCents: cents });
        state.acceptedAllocations += 1;
      }
      const response = noteBody(creditNoteID);
      if (idempotencyKey) state.seenKeys.set(idempotencyKey, response);
      return { body: response };
    },
    async getCreditNote(_tenant: string, creditNoteID: string) {
      return { body: noteBody(creditNoteID) };
    },
    async deleteCreditNoteAllocations() {
      state.deallocations += 1;
      return { body: {} };
    },
  };
  return { state, remainingCents, client: { accountingApi } };
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
let ledgerState: typeof import("@/lib/xero-applied-credit-ledger-state");
let harnessRole: SuiteEnvironmentRoleDeclaration | undefined;
let installedSpies: Array<{ mockRestore: () => void }> = [];
let lockHolderClient: import("@prisma/client").PrismaClient;
let observerClient: import("@prisma/client").PrismaClient;

(RUN ? describe : describe.skip)(
  "#4219: a credit note spent in Xero outside the app converges the credit ledger - real PostgreSQL",
  { timeout: 60_000 },
  () => {
    const bookingIds = [BOOKING_ID, SECOND_BOOKING_ID];
    const paymentIds = [PAYMENT_ID, SECOND_PAYMENT_ID];

    async function deleteFixtures() {
      const slices = await prisma.memberCreditNoteAllocation.findMany({ where: { appliedToBookingId: { in: bookingIds } }, select: { id: true } });
      const localIds = [...paymentIds, ...bookingIds, ...slices.map((slice) => slice.id)];
      await prisma.xeroSyncOperation.deleteMany({ where: { localId: { in: localIds } } });
      for (const bookingId of bookingIds) {
        // The allocation attempts' own rows name their slice, which the converge deletes: find them by booking.
        await prisma.xeroSyncOperation.deleteMany({ where: { requestPayload: { path: ["appliedCreditContext", "bookingId"], equals: bookingId } } });
      }
      await prisma.xeroObjectLink.deleteMany({ where: { xeroObjectId: { in: [KNOWN_APP_INVOICE_ID, SUBSCRIPTION_INVOICE_ID] } } });
      await prisma.xeroObjectLink.deleteMany({ where: { localId: { in: localIds } } });
      await prisma.memberCreditNoteAllocation.deleteMany({ where: { appliedToBookingId: { in: bookingIds } } });
      await prisma.memberCreditNoteAllocation.deleteMany({ where: { memberCredit: { memberId: MEMBER_ID } } });
      // #4627: the doors post journal batches bridged to these lines; release them first.
      await releaseBookingJournalForTeardown(prisma, bookingIds);
      await prisma.bookingLedgerLine.deleteMany({ where: { bookingId: { in: bookingIds } } });
      await prisma.memberCredit.deleteMany({ where: { memberId: MEMBER_ID } });
      await prisma.bookingEvent.deleteMany({ where: { bookingId: { in: bookingIds } } });
      await prisma.auditLog.deleteMany({ where: { OR: [{ memberId: MEMBER_ID }, { actorMemberId: MEMBER_ID }, { targetId: { in: bookingIds } }] } });
      await prisma.payment.deleteMany({ where: { bookingId: { in: bookingIds } } });
      await prisma.bookingGuestNight.deleteMany({ where: { bookingGuest: { bookingId: { in: bookingIds } } } });
      await prisma.bookingGuest.deleteMany({ where: { bookingId: { in: bookingIds } } });
      await prisma.booking.deleteMany({ where: { id: { in: bookingIds } } });
      await prisma.lodge.deleteMany({ where: { id: LODGE_ID } });
      await prisma.member.deleteMany({ where: { id: { in: [MEMBER_ID, OTHER_MEMBER_ID] } } });
    }

    async function createBooking(bookingId: string, paymentId: string, invoiceId: string, creditCents: number) {
      await prisma.booking.create({
        data: { id: bookingId, memberId: MEMBER_ID, lodgeId: LODGE_ID, checkIn: CHECK_IN, checkOut: CHECK_OUT, status: "PAID", totalPriceCents: PRICE_CENTS, finalPriceCents: PRICE_CENTS },
      });
      const guestId = bookingId === BOOKING_ID ? GUEST_ID : `${GUEST_ID}-two`;
      await prisma.bookingGuest.create({
        data: { id: guestId, bookingId, firstName: "Credit", lastName: "Guest", ageTier: "ADULT", stayStart: CHECK_IN, stayEnd: CHECK_OUT, priceCents: PRICE_CENTS },
      });
      await prisma.bookingGuestNight.createMany({
        data: NIGHTS.map((stayDate) => ({ bookingGuestId: guestId, stayDate, priceCents: PRICE_CENTS / 2, priceSource: "SOLD" as const })),
      });
      for (const [index, night] of NIGHTS.entries()) {
        await prisma.bookingLedgerLine.create({ data: {
          bookingId, side: "CHARGE", kind: "GUEST_NIGHT", sign: 1, quantity: 1, unitCents: PRICE_CENTS / 2, amountCents: PRICE_CENTS / 2,
          bookingGuestId: guestId, nightStart: night, nightEndExclusive: NIGHTS[index + 1] ?? CHECK_OUT, ageTier: "ADULT",
          guestNames: ["Credit Guest"], anchorKind: "CONFIRMATION", anchorId: bookingId, narration: "race 4219 confirmation",
          lodgeId: LODGE_ID, postingKey: `race-4219-confirm-${bookingId}-${index}`,
        } });
      }
      await prisma.payment.create({
        data: { id: paymentId, bookingId, amountCents: PRICE_CENTS - creditCents, status: "SUCCEEDED", creditAppliedCents: creditCents, source: "STRIPE", xeroInvoiceId: invoiceId },
      });
      await prisma.paymentTransaction.create({
        data: { paymentId, kind: "PRIMARY", source: "STRIPE", stripePaymentIntentId: `race-4219-pi-${bookingId}`, amountCents: PRICE_CENTS - creditCents, status: "SUCCEEDED" },
      });
    }

    /**
     * The shape #4219 is about: a $52.50 cancellation credit (an older lot, its
     * note in Xero) that the app applied to a booking, whose note was meanwhile
     * used in Xero outside the app - an allocation to some other invoice of
     * `outsideSpentCents`. A second, healthy $52.50 lot and booking let the
     * tests prove the written-down lot is not planned again.
     */
    async function seed({ outsideSpentCents = CREDIT_CENTS, outsidePaymentCents = 0, knownInvoiceSpentCents = 0 }: { outsideSpentCents?: number; outsidePaymentCents?: number; knownInvoiceSpentCents?: number } = {}) {
      await deleteFixtures();
      await prisma.member.create({
        data: { id: MEMBER_ID, email: "race-4219@example.invalid", passwordHash: "x", firstName: "Credit", lastName: "Payer", role: "USER", ageTier: "ADULT" },
      });
      await prisma.lodge.create({ data: { id: LODGE_ID, name: "Race 4219 Lodge", slug: "race-4219" } });
      await prisma.memberCredit.create({
        data: { id: SPENT_LOT_ID, memberId: MEMBER_ID, amountCents: CREDIT_CENTS, type: "CANCELLATION_REFUND", description: "race 4219 spent lot", xeroCreditNoteId: SPENT_NOTE_ID, createdAt: SPENT_LOT_AT },
      });
      await createBooking(BOOKING_ID, PAYMENT_ID, XERO_INVOICE_ID, CREDIT_CENTS);
      await prisma.$transaction((tx) => credit.applyCreditToBooking(MEMBER_ID, CREDIT_CENTS, BOOKING_ID, tx, CLUB_FORMAT_TEST));

      fakeXero.state.on = true;
      fakeXero.state.seq = 0;
      fakeXero.state.acceptedAllocations = 0;
      fakeXero.state.refusedAllocations = 0;
      fakeXero.state.deallocations = 0;
      fakeXero.state.seenKeys.clear();
      fakeXero.state.notes = new Map([
        [SPENT_NOTE_ID, {
          totalCents: CREDIT_CENTS,
          allocations: [
            ...(outsideSpentCents > 0 ? [{ allocationID: "race-4219-outside", invoiceID: OUTSIDE_INVOICE_ID, amountCents: outsideSpentCents }] : []),
            ...(knownInvoiceSpentCents > 0 ? [{ allocationID: "race-4219-known", invoiceID: KNOWN_APP_INVOICE_ID, amountCents: knownInvoiceSpentCents }] : []),
          ],
          payments: outsidePaymentCents > 0 ? [{ paymentID: "race-4219-outside-payment", amountCents: outsidePaymentCents }] : [],
        }],
        [HEALTHY_NOTE_ID, { totalCents: CREDIT_CENTS, allocations: [], payments: [] }],
      ]);
      // An invoice the app tracks (another of the member's bookings'), so an allocation to it is the app's own.
      await prisma.xeroObjectLink.create({
        data: { localModel: "Payment", localId: "race-4219-other-payment", xeroObjectType: "INVOICE", xeroObjectId: KNOWN_APP_INVOICE_ID, role: "PRIMARY_INVOICE", active: true },
      });
      expect(await credit.getMemberCreditBalance(MEMBER_ID)).toBe(0);
    }

    /** A second booking with its own $52.50 of credit, planned after the first converges. */
    async function addHealthyLotAndSecondBooking() {
      await prisma.memberCredit.create({
        data: { id: HEALTHY_LOT_ID, memberId: MEMBER_ID, amountCents: CREDIT_CENTS, type: "CANCELLATION_REFUND", description: "race 4219 healthy lot", xeroCreditNoteId: HEALTHY_NOTE_ID, createdAt: HEALTHY_LOT_AT },
      });
      await createBooking(SECOND_BOOKING_ID, SECOND_PAYMENT_ID, SECOND_XERO_INVOICE_ID, CREDIT_CENTS);
      await prisma.$transaction((tx) => credit.applyCreditToBooking(MEMBER_ID, CREDIT_CENTS, SECOND_BOOKING_ID, tx, CLUB_FORMAT_TEST));
    }

    async function runEngine(bookingId = BOOKING_ID) {
      const { allocateAppliedCreditForBooking } = await import("@/lib/xero-applied-credit-allocation");
      await allocateAppliedCreditForBooking(bookingId);
    }
    const balance = () => credit.getMemberCreditBalance(MEMBER_ID);
    const applied = (bookingId = BOOKING_ID) => credit.deriveBookingAppliedCreditCents(bookingId);
    const slices = (bookingId = BOOKING_ID) => prisma.memberCreditNoteAllocation.findMany({ where: { appliedToBookingId: bookingId } });
    const writeDowns = () => prisma.memberCredit.findMany({ where: { memberId: MEMBER_ID, type: "ADMIN_ADJUSTMENT", amountCents: { lt: 0 } } });
    const convergedAudits = () => prisma.auditLog.count({ where: { action: "xero.credit_note.spent_outside_app_converged", targetId: BOOKING_ID } });

    beforeAll(async () => {
      assertSafeRaceDbUrl(RACE_DB_URL);
      process.env.DATABASE_URL = RACE_DB_URL;
      ({ prisma } = await import("@/lib/prisma"));
      const { declareEnvironmentRoleForSuite } = await import("./helpers/environment-role");
      harnessRole = declareEnvironmentRoleForSuite("non-production");
      credit = await import("@/lib/member-credit");
      ledgerState = await import("@/lib/xero-applied-credit-ledger-state");
      // The fake Xero client, for this describe only; each spy delegates to the real
      // function whenever the fake is switched off.
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
      lockHolderClient = separate("race-4219-lock-holder");
      observerClient = separate("race-4219-observer");
      await Promise.all([lockHolderClient.$connect(), observerClient.$connect()]);
      const xeroApi = await import("@/lib/xero-api-client");
      const realGetClient = xeroApi.getAuthenticatedXeroClient;
      const realCall = xeroApi.callXeroApi;
      installedSpies = [
        vi.spyOn(xeroApi, "getAuthenticatedXeroClient").mockImplementation(((...args: Parameters<typeof realGetClient>) =>
          fakeXero.state.on
            ? Promise.resolve({ xero: fakeXero.client, tenantId: "race-4219-tenant" })
            : realGetClient(...args)) as typeof realGetClient),
        vi.spyOn(xeroApi, "callXeroApi").mockImplementation(((fn: () => Promise<unknown>, options: Parameters<typeof realCall>[1]) =>
          fakeXero.state.on ? fn() : realCall(fn, options)) as typeof realCall),
      ];
    }, 60_000);

    afterEach(() => {
      fakeXero.state.on = false;
    });

    afterAll(async () => {
      fakeXero.state.on = false;
      for (const spy of installedSpies) spy.mockRestore();
      installedSpies = [];
      await Promise.all([lockHolderClient, observerClient].map((client) => (client ? client.$disconnect().catch(() => {}) : Promise.resolve())));
      try {
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

    it("the allocation worker converges a fully spent note: ledger and Xero agree, nothing is written to Xero, the failure is closed, and a second run does nothing", async () => {
      await seed();

      await runEngine();

      // Xero was refused once and given nothing; the offset stands as the treasurer left it.
      expect(fakeXero.state.refusedAllocations).toBe(1);
      expect(fakeXero.state.acceptedAllocations).toBe(0);
      expect(fakeXero.state.deallocations).toBe(0);
      expect(fakeXero.remainingCents(SPENT_NOTE_ID)).toBe(0);
      // The member's credit is the same (nothing moved); the booking no longer counts the credit as applied.
      expect(await balance()).toBe(0);
      expect(await applied()).toBe(0);
      expect(await ledgerState.unallocatedAppliedCents(BOOKING_ID)).toBe(0);
      expect((await prisma.payment.findUniqueOrThrow({ where: { id: PAYMENT_ID } })).creditAppliedCents).toBe(0);
      expect(await slices()).toHaveLength(0);
      const down = await writeDowns();
      expect(down.map((row) => [row.amountCents, row.xeroCreditNoteId])).toEqual([[-CREDIT_CENTS, SPENT_NOTE_ID]]);
      // The failed allocation left the Active list through the resolution fields; one audit row.
      const failed = await prisma.xeroSyncOperation.findMany({
        where: { entityType: "ALLOCATION", status: "FAILED", requestPayload: { path: ["appliedCreditContext", "bookingId"], equals: BOOKING_ID } },
      });
      expect(failed.length).toBeGreaterThan(0);
      expect(failed.every((operation) => operation.manuallyResolvedAt !== null)).toBe(true);
      expect(failed.every((operation) => operation.replayable === false)).toBe(true);
      expect(failed.every((operation) => operation.lastErrorCode === "CREDIT_NOTE_SPENT_OUTSIDE_APP")).toBe(true);
      expect(await convergedAudits()).toBe(1);
      const audit = await prisma.auditLog.findFirstOrThrow({ where: { action: "xero.credit_note.spent_outside_app_converged", targetId: BOOKING_ID } });
      // The system did this: the member is its subject, never its actor.
      expect(audit.subjectMemberId).toBe(MEMBER_ID);
      expect(audit.actorMemberId).toBeNull();
      expect(audit.category).toBe("xero");

      // Repeating it changes nothing.
      const rowsBefore = await prisma.memberCredit.count({ where: { memberId: MEMBER_ID } });
      await runEngine();
      expect(await prisma.memberCredit.count({ where: { memberId: MEMBER_ID } })).toBe(rowsBefore);
      expect(await convergedAudits()).toBe(1);
      expect(fakeXero.state.refusedAllocations).toBe(1);
    });

    it("a written-down lot is not planned again: the next booking's credit comes from the healthy lot", async () => {
      await seed();
      await runEngine();
      await addHealthyLotAndSecondBooking();

      await runEngine(SECOND_BOOKING_ID);

      expect(fakeXero.state.refusedAllocations).toBe(1);
      expect(fakeXero.state.acceptedAllocations).toBe(1);
      expect(fakeXero.remainingCents(HEALTHY_NOTE_ID)).toBe(0);
      expect((await slices(SECOND_BOOKING_ID)).map((slice) => [slice.memberCreditId, slice.amountCents])).toEqual([[HEALTHY_LOT_ID, CREDIT_CENTS]]);
      expect(await ledgerState.unallocatedAppliedCents(SECOND_BOOKING_ID)).toBe(0);
    });

    it("a partly spent note keeps the rest: the missing part is converged and the remainder allocates", async () => {
      await seed({ outsideSpentCents: 2_000 });

      await runEngine();

      expect(fakeXero.state.acceptedAllocations).toBe(1);
      expect(fakeXero.remainingCents(SPENT_NOTE_ID)).toBe(0);
      expect((await writeDowns()).map((row) => row.amountCents)).toEqual([-2_000]);
      expect(await applied()).toBe(CREDIT_CENTS - 2_000);
      expect((await slices()).map((slice) => slice.amountCents)).toEqual([CREDIT_CENTS - 2_000]);
      expect(await ledgerState.unallocatedAppliedCents(BOOKING_ID)).toBe(0);
      expect(await balance()).toBe(0);
    });

    it("two concurrent runs write one set of rows", async () => {
      await seed();

      const settled = await Promise.allSettled([runEngine(), runEngine()]);

      // Neither run fails: the one that lost the race finds nothing left to allocate.
      // Asserted with the reason (#4338), so a rejection names its cause.
      expect(settled.map((run) => (run.status === "rejected" ? `rejected: ${String(run.reason)}` : run.status))).toEqual(["fulfilled", "fulfilled"]);
      expect(await writeDowns()).toHaveLength(1);
      expect(await prisma.memberCredit.count({ where: { appliedToBookingId: BOOKING_ID, type: "BOOKING_APPLIED", amountCents: { gt: 0 } } })).toBe(1);
      expect(await convergedAudits()).toBe(1);
      expect(await applied()).toBe(0);
      expect(await balance()).toBe(0);
    });

    const ACTIVE_STATUSES = ["PENDING", "RUNNING", "WAITING_PAYMENT"] as const;
    const RACE_POLL_LIMIT_MS = 10_000;
    /** Above the poll's limit, so a held loser fails the poll's assertion rather than the test's clock. */
    const LOST_START_TEST_TIMEOUT_MS = 30_000;
    const describeRun = (run: PromiseSettledResult<unknown>) => (run.status === "rejected" ? `rejected: ${String(run.reason)}` : run.status);
    const bookingOperations = () =>
      prisma.xeroSyncOperation.findMany({ where: { requestPayload: { path: ["appliedCreditContext", "bookingId"], equals: BOOKING_ID } }, orderBy: { attemptCount: "asc" } });

    /** Poll on a separate connection until `check` holds, or fail naming `what`. */
    async function waitUntil(what: string, check: () => Promise<boolean>) {
      const startedAt = process.hrtime.bigint();
      let held = await check();
      while (!held && realElapsedMs(startedAt) < RACE_POLL_LIMIT_MS) {
        await new Promise((resolve) => setTimeout(resolve, 10));
        held = await check();
      }
      expect(held, what).toBe(true);
    }
    const noActiveRow = (correlationKey: string) => async () =>
      (await observerClient.xeroSyncOperation.count({ where: { correlationKey, status: { in: [...ACTIVE_STATUSES] } } })) === 0;

    /**
     * #4338, forced: two engine runs, where the loser's operation insert meets the
     * winner's RUNNING row. The winner pauses inside its Xero call; the loser's
     * lookup of the active row releases it and is then held by `holdLoserLookup`.
     */
    async function raceWithLostStart(holdLoserLookup: (correlationKey: string) => Promise<void>) {
      const api = fakeXero.client.accountingApi;
      const realAllocate = api.createCreditNoteAllocation;
      const realFindFirst = prisma.xeroSyncOperation.findFirst.bind(prisma.xeroSyncOperation);
      const winnerInXero = deferred();
      const releaseWinner = deferred();
      let allocateCalls = 0;
      let lostStarts = 0;
      api.createCreditNoteAllocation = async (...args: Parameters<typeof realAllocate>) => {
        allocateCalls += 1;
        if (allocateCalls === 1) {
          winnerInXero.resolve();
          await releaseWinner.promise;
        }
        return realAllocate(...args);
      };
      const findFirst = vi.spyOn(prisma.xeroSyncOperation, "findFirst").mockImplementation((async (args: Parameters<typeof realFindFirst>[0]) => {
        const where = args?.where as { correlationKey?: unknown; status?: { in?: unknown } } | undefined;
        if (typeof where?.correlationKey === "string" && Array.isArray(where.status?.in) && lostStarts === 0) {
          lostStarts += 1;
          releaseWinner.resolve();
          await holdLoserLookup(where.correlationKey);
        }
        return realFindFirst(args);
      }) as unknown as typeof prisma.xeroSyncOperation.findFirst);
      try {
        const winner = runEngine();
        await winnerInXero.promise;
        const loser = runEngine();
        const settled = await Promise.allSettled([winner, loser]);
        expect(lostStarts, "the loser's insert lost to the winner's running row").toBe(1);
        return { settled, allocateCalls };
      } finally {
        api.createCreditNoteAllocation = realAllocate;
        releaseWinner.resolve();
        findFirst.mockRestore();
      }
    }

    it("FORCES the lost start: the loser's operation insert meets the winner's running row, which fails before the loser looks for it, and neither run fails (#4338)", async () => {
      await seed();

      const { settled } = await raceWithLostStart((correlationKey) =>
        waitUntil("the winner's row finished before the loser's lookup", noActiveRow(correlationKey)),
      );

      expect(settled.map(describeRun)).toEqual(["fulfilled", "fulfilled"]);
      expect(await writeDowns()).toHaveLength(1);
      expect(await convergedAudits()).toBe(1);
      expect(await applied()).toBe(0);
      expect(await balance()).toBe(0);
      // The loser started its own attempt rather than failing; none is left active or open.
      const operations = await bookingOperations();
      expect(operations.map((operation) => [operation.attemptCount, operation.status])).toEqual([[1, "FAILED"], [2, "FAILED"]]);
      expect(operations.every((operation) => operation.manuallyResolvedAt !== null)).toBe(true);
    }, LOST_START_TEST_TIMEOUT_MS);

    it("closes the loser's own failed allocation when the winner converged before that attempt failed (#4338)", async () => {
      await seed();

      // Held until the winner has converged and closed the slice's failed rows, so the
      // loser's attempt fails afterwards and its converge finds the work already done.
      const { settled } = await raceWithLostStart(async (correlationKey) => {
        await waitUntil("the winner's row finished before the loser's lookup", noActiveRow(correlationKey));
        await waitUntil("the winner converged before the loser's attempt", async () =>
          (await observerClient.auditLog.count({ where: { action: "xero.credit_note.spent_outside_app_converged", targetId: BOOKING_ID } })) > 0,
        );
      });

      expect(settled.map(describeRun)).toEqual(["fulfilled", "fulfilled"]);
      expect(await writeDowns()).toHaveLength(1);
      expect(await convergedAudits()).toBe(1);
      const operations = await bookingOperations();
      expect(operations.map((operation) => [operation.attemptCount, operation.status])).toEqual([[1, "FAILED"], [2, "FAILED"]]);
      // Both off the Active list and out of the repeated-failure count, not only the winner's.
      expect(operations.map((operation) => [operation.attemptCount, operation.manuallyResolvedAt !== null, operation.replayable])).toEqual([
        [1, true, false],
        [2, true, false],
      ]);
      // The loser's close is audited once, naming its own row.
      const closeAudits = await prisma.auditLog.findMany({ where: { action: "xero.credit_note.spent_outside_app_attempt_closed", targetId: BOOKING_ID } });
      expect(closeAudits.map((audit) => [audit.category, (audit.metadata as { operationId?: string }).operationId])).toEqual([["xero", operations[1].id]]);
    }, LOST_START_TEST_TIMEOUT_MS);

    it("leaves the caller's failed row FAILED when nothing shows a converge ran for this booking and note (#4338)", async () => {
      await seed();
      // A slice smaller than the refused amount reads as "already shrunk", but no converge wrote it.
      await prisma.memberCreditNoteAllocation.create({
        data: { memberCreditId: SPENT_LOT_ID, xeroCreditNoteId: SPENT_NOTE_ID, appliedToBookingId: BOOKING_ID, amountCents: 1_000 },
      });
      // Half the evidence only: a marked release for the booking, with no write-down for the note beside it.
      await prisma.memberCredit.create({
        data: { memberId: MEMBER_ID, amountCents: 1_000, type: "BOOKING_APPLIED", description: "race 4338 release without a write-down", appliedToBookingId: BOOKING_ID, outsideSpendConvergedAt: new Date("2026-07-01T00:00:00.000Z") },
      });
      const failed = await prisma.xeroSyncOperation.create({
        data: { direction: "OUTBOUND", entityType: "ALLOCATION", operationType: "CREATE", localModel: "MemberCreditNoteAllocation", localId: "race-4338-no-evidence", status: "FAILED",
          // Found by booking, so the fixtures sweep removes it.
          requestPayload: { appliedCreditContext: { bookingId: BOOKING_ID } } },
      });
      const { convergeCreditNoteSpentOutsideApp } = await import("@/lib/xero-applied-credit-spent-outside-app");

      const result = await convergeCreditNoteSpentOutsideApp({
        bookingId: BOOKING_ID, creditNoteId: SPENT_NOTE_ID, requestedCents: CREDIT_CENTS,
        xeroAllocations: [{ invoiceId: OUTSIDE_INVOICE_ID, cents: CREDIT_CENTS }], xeroPayments: [], noteTotalCents: CREDIT_CENTS, remainingCents: 0,
        failedOperationId: failed.id,
      });

      expect(result).toEqual({ converged: false, reason: "already-converged" });
      const after = await prisma.xeroSyncOperation.findUniqueOrThrow({ where: { id: failed.id } });
      expect([after.status, after.manuallyResolvedAt, after.replayable]).toEqual(["FAILED", null, true]);
      expect(await prisma.auditLog.count({ where: { action: "xero.credit_note.spent_outside_app_attempt_closed" } })).toBe(0);
      expect(await writeDowns()).toHaveLength(0);
    });

    it("keeps main's error when the winner SUCCEEDED before the loser looked: no second row and no second Xero call (#4338)", async () => {
      // A healthy note: the winner's allocation goes through.
      await seed({ outsideSpentCents: 0 });
      const { isPrismaUniqueConstraintError } = await import("@/lib/prisma-errors");

      const { settled, allocateCalls } = await raceWithLostStart((correlationKey) =>
        waitUntil("the winner's row finished before the loser's lookup", noActiveRow(correlationKey)),
      );

      expect(settled[0].status, describeRun(settled[0])).toBe("fulfilled");
      expect(settled[1].status).toBe("rejected");
      expect(isPrismaUniqueConstraintError((settled[1] as PromiseRejectedResult).reason), describeRun(settled[1])).toBe(true);
      expect(allocateCalls).toBe(1);
      expect(fakeXero.state.acceptedAllocations).toBe(1);
      expect((await bookingOperations()).map((operation) => [operation.attemptCount, operation.status])).toEqual([[1, "SUCCEEDED"]]);
      expect(await ledgerState.unallocatedAppliedCents(BOOKING_ID)).toBe(0);
      expect(await writeDowns()).toHaveLength(0);
    }, LOST_START_TEST_TIMEOUT_MS);

    it("on a caller's transaction a lost start rethrows the unique violation, not the aborted transaction's error; the root client passed as `store` finds the winner (#4338)", async () => {
      await seed();
      const { startXeroSyncOperation } = await import("@/lib/xero-sync");
      const { isPrismaUniqueConstraintError } = await import("@/lib/prisma-errors");
      const input = {
        direction: "OUTBOUND",
        entityType: "CREDIT_NOTE",
        operationType: "CREATE",
        localModel: "Payment",
        localId: PAYMENT_ID,
        status: "PENDING",
        correlationKey: "race-4338-lost-start-on-a-transaction",
      } as const;
      const winner = await startXeroSyncOperation(input);

      const onTransaction = await prisma
        .$transaction((tx) => startXeroSyncOperation({ ...input, store: tx }))
        .then(() => null, (error: unknown) => error);

      expect(isPrismaUniqueConstraintError(onTransaction), String(onTransaction)).toBe(true);
      expect((await startXeroSyncOperation({ ...input, store: prisma })).id).toBe(winner.id);
      expect(await prisma.xeroSyncOperation.count({ where: { correlationKey: input.correlationKey } })).toBe(1);
    });

    it("counts only what the app has no record of: an allocation to an invoice the app tracks is the app's own and converges nothing", async () => {
      // Xero spent the whole note on an invoice the app tracks (another booking's). The
      // inbound sync mirrors that; this routine must not write the credit down as well.
      await seed({ outsideSpentCents: 0, knownInvoiceSpentCents: CREDIT_CENTS });
      const original = fakeXero.state.refusedAllocations;

      await runEngine().catch(() => undefined);

      expect(fakeXero.state.refusedAllocations).toBeGreaterThan(original);
      expect(await writeDowns()).toHaveLength(0);
      expect(await applied()).toBe(CREDIT_CENTS);
      expect(await balance()).toBe(0);
    });

    it("counts a payment against the note that the app did not make as an outside spend", async () => {
      await seed({ outsideSpentCents: 0, outsidePaymentCents: CREDIT_CENTS });

      await runEngine();

      expect((await writeDowns()).map((row) => row.amountCents)).toEqual([-CREDIT_CENTS]);
      expect(await applied()).toBe(0);
      expect(await balance()).toBe(0);
    });

    it("the release is never a spendable lot: credit the member gets later is used from its own note, not minted", async () => {
      await seed();
      await runEngine();
      await addHealthyLotAndSecondBooking();

      await runEngine(SECOND_BOOKING_ID);

      // The healthy lot is NEWER than the converge's rows, so a release row that were a lot would be planned first.
      expect(fakeXero.state.acceptedAllocations).toBe(1);
      expect(fakeXero.remainingCents(HEALTHY_NOTE_ID)).toBe(0);
      expect(await prisma.xeroObjectLink.count({ where: { localModel: "Payment", localId: SECOND_PAYMENT_ID, role: "APPLIED_CREDIT_REMAINDER_NOTE" } })).toBe(0);
      const rows = await prisma.memberCredit.findMany({ where: { memberId: MEMBER_ID, outsideSpendConvergedAt: { not: null } }, orderBy: { amountCents: "asc" } });
      expect(rows.map((row) => [row.type, row.amountCents])).toEqual([["ADMIN_ADJUSTMENT", -CREDIT_CENTS], ["BOOKING_APPLIED", CREDIT_CENTS]]);
    });

    it("an unstamped release row is not a spendable lot either: a later booking's credit comes from its own note", async () => {
      // Converge only (no replan), so the release row is still unstamped and could not be
      // mistaken for a stamped lot of the spent note.
      await seed({ outsideSpentCents: 2_000 });
      await prisma.memberCreditNoteAllocation.create({
        data: { memberCreditId: SPENT_LOT_ID, xeroCreditNoteId: SPENT_NOTE_ID, appliedToBookingId: BOOKING_ID, amountCents: CREDIT_CENTS },
      });
      const { convergeCreditNoteSpentOutsideApp } = await import("@/lib/xero-applied-credit-spent-outside-app");
      const result = await convergeCreditNoteSpentOutsideApp({
        bookingId: BOOKING_ID, creditNoteId: SPENT_NOTE_ID, requestedCents: CREDIT_CENTS,
        xeroAllocations: [{ invoiceId: OUTSIDE_INVOICE_ID, cents: 2_000 }], xeroPayments: [], noteTotalCents: CREDIT_CENTS, remainingCents: CREDIT_CENTS - 2_000,
      });
      expect(result).toMatchObject({ converged: true, writtenDownCents: 2_000 });
      expect(await prisma.memberCredit.count({ where: { appliedToBookingId: BOOKING_ID, type: "BOOKING_APPLIED", amountCents: { gt: 0 }, xeroCreditNoteId: null } })).toBe(1);
      await addHealthyLotAndSecondBooking();

      await runEngine(SECOND_BOOKING_ID);

      expect(fakeXero.state.acceptedAllocations).toBe(1);
      expect(fakeXero.remainingCents(HEALTHY_NOTE_ID)).toBe(0);
      expect((await slices(SECOND_BOOKING_ID)).map((slice) => slice.memberCreditId)).toEqual([HEALTHY_LOT_ID]);
    });

    it("a later application to the converged booking is not netted by the release", async () => {
      await seed();
      await runEngine();
      expect(await ledgerState.unallocatedAppliedCents(BOOKING_ID)).toBe(0);
      expect(await prisma.memberCredit.count({ where: { appliedToBookingId: BOOKING_ID, type: "BOOKING_APPLIED", xeroCreditNoteId: null } })).toBe(0);
    });

    it("two concurrent runs on a partly spent note: neither fails, the remainder is allocated once", async () => {
      await seed({ outsideSpentCents: 2_000 });

      const settled = await Promise.allSettled([runEngine(), runEngine()]);

      expect(settled.map((run) => (run.status === "rejected" ? `rejected: ${String(run.reason)}` : run.status))).toEqual(["fulfilled", "fulfilled"]);
      expect(await writeDowns()).toHaveLength(1);
      expect(fakeXero.state.acceptedAllocations).toBe(1);
      expect(fakeXero.remainingCents(SPENT_NOTE_ID)).toBe(0);
    });

    it("leaves a cancelled booking with captured money to its cancel", async () => {
      await seed();
      await prisma.memberCreditNoteAllocation.create({
        data: { memberCreditId: SPENT_LOT_ID, xeroCreditNoteId: SPENT_NOTE_ID, appliedToBookingId: BOOKING_ID, amountCents: CREDIT_CENTS },
      });
      await prisma.booking.update({ where: { id: BOOKING_ID }, data: { status: "CANCELLED" } });
      const { convergeCreditNoteSpentOutsideApp } = await import("@/lib/xero-applied-credit-spent-outside-app");

      const result = await convergeCreditNoteSpentOutsideApp({
        bookingId: BOOKING_ID, creditNoteId: SPENT_NOTE_ID, requestedCents: CREDIT_CENTS,
        xeroAllocations: [{ invoiceId: OUTSIDE_INVOICE_ID, cents: CREDIT_CENTS }], xeroPayments: [], noteTotalCents: CREDIT_CENTS, remainingCents: 0,
      });

      expect(result).toEqual({ converged: false, reason: "cancelled" });
      expect(await writeDowns()).toHaveLength(0);
    });

    it("counts an offset against an invoice that is not a booking's (such as a subscription invoice) as an outside spend", async () => {
      await seed({ outsideSpentCents: 0, knownInvoiceSpentCents: 0 });
      fakeXero.state.notes.get(SPENT_NOTE_ID)!.allocations.push({ allocationID: "race-4219-subscription", invoiceID: SUBSCRIPTION_INVOICE_ID, amountCents: CREDIT_CENTS });
      await prisma.xeroObjectLink.create({
        data: { localModel: "MembershipSubscriptionCharge", localId: "race-4219-charge", xeroObjectType: "INVOICE", xeroObjectId: SUBSCRIPTION_INVOICE_ID, role: "PRIMARY_INVOICE", active: true },
      });

      await runEngine();

      expect((await writeDowns()).map((row) => row.amountCents)).toEqual([-CREDIT_CENTS]);
      expect(await applied()).toBe(0);
    });

    it("ignores an allocation Xero lists as deleted, which holds no credit", async () => {
      await seed({ outsideSpentCents: 2_000 });
      fakeXero.state.notes.get(SPENT_NOTE_ID)!.allocations.push({ allocationID: "race-4219-removed", invoiceID: OUTSIDE_INVOICE_ID, amountCents: 3_000, isDeleted: true });

      await runEngine();

      // Only the live 2000 was spent: it is written down, and the remaining 3250 is allocated.
      expect((await writeDowns()).map((row) => row.amountCents)).toEqual([-2_000]);
      expect(fakeXero.state.acceptedAllocations).toBe(1);
    });

    it("writes nothing when Xero's list does not add up to what the note has lost", async () => {
      await seed();
      const { convergeCreditNoteSpentOutsideApp } = await import("@/lib/xero-applied-credit-spent-outside-app");
      await prisma.memberCreditNoteAllocation.create({
        data: { memberCreditId: SPENT_LOT_ID, xeroCreditNoteId: SPENT_NOTE_ID, appliedToBookingId: BOOKING_ID, amountCents: CREDIT_CENTS },
      });

      // The note lost 5250 but the list explains only 3000 of it.
      const result = await convergeCreditNoteSpentOutsideApp({
        bookingId: BOOKING_ID, creditNoteId: SPENT_NOTE_ID, requestedCents: CREDIT_CENTS,
        xeroAllocations: [{ invoiceId: OUTSIDE_INVOICE_ID, cents: 3_000 }], xeroPayments: [], noteTotalCents: CREDIT_CENTS, remainingCents: 0,
      });

      expect(result).toEqual({ converged: false, reason: "unexplained-spend" });
      expect(await writeDowns()).toHaveLength(0);
    });

    it("takes the global lock before it decides, and refuses if the booking's owner changed while it waited", async () => {
      await seed();
      await prisma.memberCreditNoteAllocation.create({
        data: { memberCreditId: SPENT_LOT_ID, xeroCreditNoteId: SPENT_NOTE_ID, appliedToBookingId: BOOKING_ID, amountCents: CREDIT_CENTS },
      });
      await prisma.member.create({
        data: { id: OTHER_MEMBER_ID, email: "race-4219-two@example.invalid", passwordHash: "x", firstName: "Other", lastName: "Payer", role: "USER", ageTier: "ADULT" },
      });
      const { convergeCreditNoteSpentOutsideApp } = await import("@/lib/xero-applied-credit-spent-outside-app");
      let holderPid = 0;
      const holding = deferred();
      const release = deferred();
      // A writer holding the global key (a cancel, a capture), which also moves the booking to another member.
      const held = lockHolderClient.$transaction(async (tx) => {
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(1)`;
        holderPid = (await tx.$queryRaw<Array<{ pid: number }>>`SELECT pg_backend_pid() AS pid`)[0]!.pid;
        holding.resolve();
        await release.promise;
        await tx.booking.update({ where: { id: BOOKING_ID }, data: { memberId: OTHER_MEMBER_ID } });
      }, { timeout: 30_000, maxWait: 10_000 });
      await holding.promise;

      const converging = convergeCreditNoteSpentOutsideApp({
        bookingId: BOOKING_ID, creditNoteId: SPENT_NOTE_ID, requestedCents: CREDIT_CENTS,
        xeroAllocations: [{ invoiceId: OUTSIDE_INVOICE_ID, cents: CREDIT_CENTS }], xeroPayments: [], noteTotalCents: CREDIT_CENTS, remainingCents: 0,
      });
      // It queues behind the global key: proof it takes the key at all.
      const startedAt = process.hrtime.bigint();
      let blocked = false;
      while (realElapsedMs(startedAt) < 5_000 && !blocked) {
        const rows = await observerClient.$queryRaw<Array<{ count: number }>>`
          SELECT COUNT(*)::int AS "count" FROM pg_stat_activity
          WHERE datname = current_database() AND ${holderPid}::int = ANY(pg_blocking_pids(pid))
        `;
        blocked = (rows[0]?.count ?? 0) >= 1;
        if (!blocked) await new Promise((resolve) => setTimeout(resolve, 10));
      }
      expect(blocked, "the converge queues behind the global key").toBe(true);
      release.resolve();
      await held;

      expect(await converging).toEqual({ converged: false, reason: "owner-changed" });
      expect(await writeDowns()).toHaveLength(0);
      await prisma.booking.update({ where: { id: BOOKING_ID }, data: { memberId: MEMBER_ID } });
    });

    it("refuses a credit note shared by several credits", async () => {
      await seed();
      await prisma.memberCreditNoteAllocation.create({
        data: { memberCreditId: SPENT_LOT_ID, xeroCreditNoteId: SPENT_NOTE_ID, appliedToBookingId: BOOKING_ID, amountCents: CREDIT_CENTS },
      });
      await prisma.memberCredit.create({
        data: { memberId: MEMBER_ID, amountCents: 1_000, type: "CANCELLATION_REFUND", description: "race 4219 second credit on the same note", xeroCreditNoteId: SPENT_NOTE_ID },
      });
      const { convergeCreditNoteSpentOutsideApp } = await import("@/lib/xero-applied-credit-spent-outside-app");

      const result = await convergeCreditNoteSpentOutsideApp({
        bookingId: BOOKING_ID, creditNoteId: SPENT_NOTE_ID, requestedCents: CREDIT_CENTS,
        xeroAllocations: [{ invoiceId: OUTSIDE_INVOICE_ID, cents: CREDIT_CENTS }], xeroPayments: [], noteTotalCents: CREDIT_CENTS, remainingCents: 0,
      });

      expect(result).toEqual({ converged: false, reason: "shared-credit-note" });
      expect(await writeDowns()).toHaveLength(0);
    });

    it("refuses a booking with unallocated credit and no slice for the note", async () => {
      await seed();
      const { convergeCreditNoteSpentOutsideApp } = await import("@/lib/xero-applied-credit-spent-outside-app");

      const result = await convergeCreditNoteSpentOutsideApp({
        bookingId: BOOKING_ID, creditNoteId: SPENT_NOTE_ID, requestedCents: CREDIT_CENTS,
        xeroAllocations: [{ invoiceId: OUTSIDE_INVOICE_ID, cents: CREDIT_CENTS }], xeroPayments: [], noteTotalCents: CREDIT_CENTS, remainingCents: 0,
      });

      expect(result).toEqual({ converged: false, reason: "no-single-slice" });
      expect(await writeDowns()).toHaveLength(0);
    });

    it("converges nothing when Xero shows the note has its credit (the offset was reversed)", async () => {
      await seed({ outsideSpentCents: 0 });
      await prisma.memberCreditNoteAllocation.create({
        data: { memberCreditId: SPENT_LOT_ID, xeroCreditNoteId: SPENT_NOTE_ID, appliedToBookingId: BOOKING_ID, amountCents: CREDIT_CENTS },
      });
      const { convergeCreditNoteSpentOutsideApp } = await import("@/lib/xero-applied-credit-spent-outside-app");

      const result = await convergeCreditNoteSpentOutsideApp({ bookingId: BOOKING_ID, creditNoteId: SPENT_NOTE_ID, requestedCents: CREDIT_CENTS, xeroAllocations: [], xeroPayments: [], noteTotalCents: CREDIT_CENTS, remainingCents: CREDIT_CENTS });

      expect(result).toEqual({ converged: false, reason: "nothing-missing" });
      expect(await writeDowns()).toHaveLength(0);
      expect(await applied()).toBe(CREDIT_CENTS);
      expect(await slices()).toHaveLength(1);
    });

    it("writes nothing when the slice is already held by Xero", async () => {
      await seed();
      const slice = await prisma.memberCreditNoteAllocation.create({
        data: { memberCreditId: SPENT_LOT_ID, xeroCreditNoteId: SPENT_NOTE_ID, appliedToBookingId: BOOKING_ID, amountCents: CREDIT_CENTS },
      });
      await prisma.xeroObjectLink.create({
        data: {
          localModel: "MemberCreditNoteAllocation", localId: slice.id, xeroObjectType: "ALLOCATION", xeroObjectId: "race-4219-held",
          role: "APPLIED_CREDIT_ALLOCATION", active: true,
        },
      });
      const { convergeCreditNoteSpentOutsideApp } = await import("@/lib/xero-applied-credit-spent-outside-app");

      const result = await convergeCreditNoteSpentOutsideApp({ bookingId: BOOKING_ID, creditNoteId: SPENT_NOTE_ID, requestedCents: CREDIT_CENTS, xeroAllocations: [{ invoiceId: OUTSIDE_INVOICE_ID, cents: CREDIT_CENTS }], xeroPayments: [], noteTotalCents: CREDIT_CENTS, remainingCents: 0 });

      expect(result).toEqual({ converged: false, reason: "slice-already-in-xero" });
      expect(await writeDowns()).toHaveLength(0);
      expect(await applied()).toBe(CREDIT_CENTS);
    });

    it("waits behind an unfinished deallocation of the booking's applied credit and writes nothing", async () => {
      await seed();
      await prisma.memberCreditNoteAllocation.create({
        data: { memberCreditId: SPENT_LOT_ID, xeroCreditNoteId: SPENT_NOTE_ID, appliedToBookingId: BOOKING_ID, amountCents: CREDIT_CENTS },
      });
      await prisma.xeroSyncOperation.create({
        data: {
          direction: "OUTBOUND", entityType: "ALLOCATION", operationType: "UPDATE", localModel: "Payment", localId: PAYMENT_ID, status: "FAILED",
          queueType: "APPLIED_CREDIT_DEALLOCATION", idempotencyKey: "race-4219-deallocation", correlationKey: "race-4219-deallocation",
          requestPayload: { queueType: "APPLIED_CREDIT_DEALLOCATION", bookingId: BOOKING_ID },
        },
      });
      const { convergeCreditNoteSpentOutsideApp } = await import("@/lib/xero-applied-credit-spent-outside-app");

      await expect(
        convergeCreditNoteSpentOutsideApp({ bookingId: BOOKING_ID, creditNoteId: SPENT_NOTE_ID, requestedCents: CREDIT_CENTS, xeroAllocations: [{ invoiceId: OUTSIDE_INVOICE_ID, cents: CREDIT_CENTS }], xeroPayments: [], noteTotalCents: CREDIT_CENTS, remainingCents: 0 }),
      ).rejects.toThrow(/deallocation/i);

      expect(await writeDowns()).toHaveLength(0);
      expect(await applied()).toBe(CREDIT_CENTS);
      expect(await slices()).toHaveLength(1);
    });

    it("leaves a cancelled booking to its cancel", async () => {
      await seed();
      await prisma.memberCreditNoteAllocation.create({
        data: { memberCreditId: SPENT_LOT_ID, xeroCreditNoteId: SPENT_NOTE_ID, appliedToBookingId: BOOKING_ID, amountCents: CREDIT_CENTS },
      });
      await prisma.payment.update({ where: { id: PAYMENT_ID }, data: { status: "PENDING", amountCents: 0 } });
      await prisma.paymentTransaction.deleteMany({ where: { paymentId: PAYMENT_ID } });
      await prisma.booking.update({ where: { id: BOOKING_ID }, data: { status: "CANCELLED" } });
      const { convergeCreditNoteSpentOutsideApp } = await import("@/lib/xero-applied-credit-spent-outside-app");

      const result = await convergeCreditNoteSpentOutsideApp({ bookingId: BOOKING_ID, creditNoteId: SPENT_NOTE_ID, requestedCents: CREDIT_CENTS, xeroAllocations: [{ invoiceId: OUTSIDE_INVOICE_ID, cents: CREDIT_CENTS }], xeroPayments: [], noteTotalCents: CREDIT_CENTS, remainingCents: 0 });

      expect(result).toEqual({ converged: false, reason: "cancelled" });
      expect(await writeDowns()).toHaveLength(0);
    });
  },
);

// The role declared above is put back, so no later suite inherits it.
(RUN ? describe : describe.skip)("#4219: the harness puts the environment role back", () => {
  it("leaves APP_ENVIRONMENT_ROLE as it found it", () => {
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
