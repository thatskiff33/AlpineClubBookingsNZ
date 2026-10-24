/**
 * Real-PostgreSQL proof for #4270: a credit note spent, changed or un-spent in Xero
 * is mirrored into the credit ledger from what Xero shows, with no booking asking
 * first. It writes only the credit ledger, only the FREE part of a lot, restores a
 * reversed spend (never more than was written down), takes the member's credit
 * lock and not the global one, and agrees with #4219's converge in either order.
 *
 * Xero is a fake provider at the client seam, installed with `vi.spyOn` for this
 * describe only (see `credit-note-spent-outside-app.realdb.test.ts`, whose
 * envelope this file shares): the mirror itself takes its evidence as an argument,
 * so only the webhook path and the sweep need the fake.
 *
 *   RUN_CONCURRENCY_RACE_TESTS=1 \
 *   CONCURRENCY_RACE_DATABASE_URL=postgresql://user:pass@127.0.0.1:55442/concurrency_race_1881 \
 *   pnpm exec vitest run src/lib/__tests__/credit-note-outside-spend-mirror.realdb.test.ts
 */
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import { ENVIRONMENT_ROLE_ENV_VAR } from "@/lib/environment-role-declaration";
import { realElapsedMs } from "@/lib/__tests__/helpers/clock";
import type { SuiteEnvironmentRoleDeclaration } from "./helpers/environment-role";
import { CLUB_FORMAT_TEST } from "./support/club-format-fixture";
import type { CreditNoteMirrorEvidence } from "@/lib/xero-credit-note-mirror";

const RUN = process.env.RUN_CONCURRENCY_RACE_TESTS === "1";
const RACE_DB_URL = process.env.CONCURRENCY_RACE_DATABASE_URL ?? "";

const MEMBER_ID = "race-4270-member";
const LODGE_ID = "race-4270-lodge";
const BOOKING_ID = "race-4270-booking";
const GUEST_ID = "race-4270-guest";
const PAYMENT_ID = "race-4270-payment";
const NOTE_ID = "race-4270-note";
const SECOND_NOTE_ID = "race-4270-note-two";
const LOT_ID = "race-4270-lot";
const SECOND_LOT_ID = "race-4270-lot-two";
const OUTSIDE_INVOICE_ID = "race-4270-outside-invoice";
const KNOWN_INVOICE_ID = "race-4270-known-invoice";
const KNOWN_PAYMENT_ID = "race-4270-known-xero-payment";

const NIGHTS = [new Date("2026-08-01T00:00:00.000Z"), new Date("2026-08-02T00:00:00.000Z")];
const CHECK_IN = NIGHTS[0]!;
const CHECK_OUT = new Date("2026-08-03T00:00:00.000Z");
const PRICE_CENTS = 20_000;
const LOT_CENTS = 5_250;
/** The mirror's clock: the frozen test day, so a note "changed ten minutes ago" is settled and one changed a minute ago is not. */
const NOW = new Date("2026-07-01T00:00:00.000Z");
const SETTLED_AT = new Date(NOW.getTime() - 10 * 60 * 1000);
const FRESH_AT = new Date(NOW.getTime() - 60 * 1000);

/** Only the credit-note read the webhook path and the sweep make. */
const fakeXero = vi.hoisted(() => {
  const state = {
    on: false,
    notes: new Map<string, { totalCents: number; allocations: Array<{ invoiceID: string; amountCents: number }>; payments: Array<{ paymentID: string; amountCents: number }>; updatedAt: Date; status?: string }>(),
    reads: [] as string[],
    failReads: false,
  };
  const body = (creditNoteID: string) => {
    const note = state.notes.get(creditNoteID);
    if (!note) return { creditNotes: [] };
    const spent = note.allocations.reduce((sum, a) => sum + a.amountCents, 0) + note.payments.reduce((sum, p) => sum + p.amountCents, 0);
    return {
      creditNotes: [
        {
          creditNoteID,
          status: note.status ?? (note.totalCents - spent > 0 ? "AUTHORISED" : "PAID"),
          total: note.totalCents / 100,
          remainingCredit: (note.totalCents - spent) / 100,
          updatedDateUTC: note.updatedAt,
          payments: note.payments.map((p) => ({ paymentID: p.paymentID, amount: p.amountCents / 100 })),
          allocations: note.allocations.map((a, index) => ({ allocationID: `${creditNoteID}-${index}`, invoice: { invoiceID: a.invoiceID }, amount: a.amountCents / 100 })),
        },
      ],
    };
  };
  const accountingApi = {
    async getCreditNote(_tenant: string, creditNoteID: string) {
      state.reads.push(creditNoteID);
      if (state.failReads) throw new Error("fake Xero: unavailable");
      return { body: body(creditNoteID) };
    },
  };
  return { state, body, client: { accountingApi } };
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
let mirrorModule: typeof import("@/lib/xero-credit-note-mirror");
let harnessRole: SuiteEnvironmentRoleDeclaration | undefined;
let installedSpies: Array<{ mockRestore: () => void }> = [];
/** Spies one test installs; put back after it, never the harness's own fake Xero. */
let testSpies: Array<{ mockRestore: () => void }> = [];
const spy = <T extends { mockRestore: () => void }>(installed: T): T => {
  testSpies.push(installed);
  return installed;
};
let lockHolderClient: import("@prisma/client").PrismaClient;
let observerClient: import("@prisma/client").PrismaClient;

(RUN ? describe : describe.skip)(
  "#4270: a credit note spent or un-spent in Xero is mirrored into the credit ledger - real PostgreSQL",
  { timeout: 60_000 },
  () => {
    async function deleteFixtures() {
      const slices = await prisma.memberCreditNoteAllocation.findMany({ where: { memberCredit: { memberId: MEMBER_ID } }, select: { id: true } });
      const localIds = [PAYMENT_ID, BOOKING_ID, ...slices.map((slice) => slice.id)];
      await prisma.xeroSyncOperation.deleteMany({ where: { localId: { in: localIds } } });
      await prisma.xeroSyncCursor.deleteMany({ where: { resourceType: "CREDIT_NOTE_OUTSIDE_SPEND_MIRROR" } });
      await prisma.cronJobRun.deleteMany({ where: { jobName: "xero-credit-note-outside-spend-mirror" } });
      await prisma.xeroObjectLink.deleteMany({ where: { xeroObjectId: { in: [KNOWN_INVOICE_ID, KNOWN_PAYMENT_ID, NOTE_ID, SECOND_NOTE_ID] } } });
      await prisma.xeroObjectLink.deleteMany({ where: { localId: { in: localIds } } });
      await prisma.memberCreditNoteAllocation.deleteMany({ where: { memberCredit: { memberId: MEMBER_ID } } });
      await prisma.bookingLedgerLine.deleteMany({ where: { bookingId: BOOKING_ID } });
      await prisma.memberCredit.deleteMany({ where: { memberId: MEMBER_ID } });
      await prisma.bookingEvent.deleteMany({ where: { bookingId: BOOKING_ID } });
      await prisma.auditLog.deleteMany({ where: { OR: [{ memberId: MEMBER_ID }, { subjectMemberId: MEMBER_ID }, { targetId: { in: [BOOKING_ID, LOT_ID, SECOND_LOT_ID] } }] } });
      await prisma.payment.deleteMany({ where: { bookingId: BOOKING_ID } });
      await prisma.bookingGuestNight.deleteMany({ where: { bookingGuest: { bookingId: BOOKING_ID } } });
      await prisma.bookingGuest.deleteMany({ where: { bookingId: BOOKING_ID } });
      await prisma.booking.deleteMany({ where: { id: BOOKING_ID } });
      await prisma.lodge.deleteMany({ where: { id: LODGE_ID } });
      await prisma.member.deleteMany({ where: { id: MEMBER_ID } });
    }

    async function createBooking(creditCents: number) {
      await prisma.booking.create({
        data: { id: BOOKING_ID, memberId: MEMBER_ID, lodgeId: LODGE_ID, checkIn: CHECK_IN, checkOut: CHECK_OUT, status: "PAID", totalPriceCents: PRICE_CENTS, finalPriceCents: PRICE_CENTS },
      });
      await prisma.bookingGuest.create({
        data: { id: GUEST_ID, bookingId: BOOKING_ID, firstName: "Credit", lastName: "Guest", ageTier: "ADULT", stayStart: CHECK_IN, stayEnd: CHECK_OUT, priceCents: PRICE_CENTS },
      });
      await prisma.bookingGuestNight.createMany({
        data: NIGHTS.map((stayDate) => ({ bookingGuestId: GUEST_ID, stayDate, priceCents: PRICE_CENTS / 2, priceSource: "SOLD" as const })),
      });
      for (const [index, night] of NIGHTS.entries()) {
        await prisma.bookingLedgerLine.create({ data: {
          bookingId: BOOKING_ID, side: "CHARGE", kind: "GUEST_NIGHT", sign: 1, quantity: 1, unitCents: PRICE_CENTS / 2, amountCents: PRICE_CENTS / 2,
          bookingGuestId: GUEST_ID, nightStart: night, nightEndExclusive: NIGHTS[index + 1] ?? CHECK_OUT, ageTier: "ADULT",
          guestNames: ["Credit Guest"], anchorKind: "CONFIRMATION", anchorId: BOOKING_ID, narration: "race 4270 confirmation",
          lodgeId: LODGE_ID, postingKey: `race-4270-confirm-${index}`,
        } });
      }
      await prisma.payment.create({
        data: { id: PAYMENT_ID, bookingId: BOOKING_ID, amountCents: PRICE_CENTS - creditCents, status: "SUCCEEDED", creditAppliedCents: creditCents, source: "STRIPE", xeroInvoiceId: "race-4270-xero-invoice" },
      });
      await prisma.paymentTransaction.create({
        data: { paymentId: PAYMENT_ID, kind: "PRIMARY", source: "STRIPE", stripePaymentIntentId: "race-4270-pi", amountCents: PRICE_CENTS - creditCents, status: "SUCCEEDED" },
      });
    }

    /** A member with one $52.50 cancellation-credit lot funded by a Xero note, nothing drawn from it. */
    async function seed() {
      await deleteFixtures();
      await prisma.member.create({
        data: { id: MEMBER_ID, email: "race-4270@example.invalid", passwordHash: "x", firstName: "Credit", lastName: "Payer", role: "USER", ageTier: "ADULT" },
      });
      await prisma.lodge.create({ data: { id: LODGE_ID, name: "Race 4270 Lodge", slug: "race-4270" } });
      await prisma.memberCredit.create({
        data: { id: LOT_ID, memberId: MEMBER_ID, amountCents: LOT_CENTS, type: "CANCELLATION_REFUND", description: "race 4270 lot", xeroCreditNoteId: NOTE_ID, createdAt: new Date("2026-05-01T00:00:00.000Z") },
      });
      fakeXero.state.notes = new Map();
      fakeXero.state.reads = [];
      fakeXero.state.failReads = false;
    }

    /** Xero's read of the note, with `spentCents` allocated to an invoice the app has no record of. */
    function evidence(overrides: Partial<CreditNoteMirrorEvidence> & { spentCents?: number } = {}): CreditNoteMirrorEvidence {
      const { spentCents = LOT_CENTS, ...rest } = overrides;
      return {
        creditNoteId: NOTE_ID,
        status: spentCents >= LOT_CENTS ? "PAID" : "AUTHORISED",
        totalCents: LOT_CENTS,
        remainingCents: LOT_CENTS - spentCents,
        allocations: spentCents > 0 ? [{ invoiceId: OUTSIDE_INVOICE_ID, cents: spentCents }] : [],
        payments: [],
        updatedAt: SETTLED_AT,
        ...rest,
      };
    }

    const mirror = (e: CreditNoteMirrorEvidence) => mirrorModule.mirrorCreditNoteOutsideSpend(e, { now: NOW });
    const balance = () => credit.getMemberCreditBalance(MEMBER_ID);
    const marked = () => prisma.memberCredit.findMany({ where: { memberId: MEMBER_ID, outsideSpendConvergedAt: { not: null }, type: "ADMIN_ADJUSTMENT" }, orderBy: { createdAt: "asc" } });
    const netWrittenDown = async () => 0 - (await marked()).reduce((sum, row) => sum + row.amountCents, 0);
    const audits = (action: string) => prisma.auditLog.findMany({ where: { action, subjectMemberId: MEMBER_ID } });
    const allAudits = () => prisma.auditLog.count({ where: { action: { in: ["xero.credit_note.outside_spend_mirrored", "xero.credit_note.outside_spend_restored"] }, subjectMemberId: MEMBER_ID } });
    const noRows = async () => expect(await marked()).toHaveLength(0);

    /** A booking holding `sliceCents` of the lot: applied credit with its slice, as the allocation engine leaves it before Xero. */
    async function drawFromLot(sliceCents: number) {
      await createBooking(sliceCents);
      await prisma.$transaction((tx) => credit.applyCreditToBooking(MEMBER_ID, sliceCents, BOOKING_ID, tx, CLUB_FORMAT_TEST));
      await prisma.memberCreditNoteAllocation.create({
        data: { memberCreditId: LOT_ID, xeroCreditNoteId: NOTE_ID, appliedToBookingId: BOOKING_ID, amountCents: sliceCents },
      });
    }

    beforeAll(async () => {
      assertSafeRaceDbUrl(RACE_DB_URL);
      process.env.DATABASE_URL = RACE_DB_URL;
      ({ prisma } = await import("@/lib/prisma"));
      const { declareEnvironmentRoleForSuite } = await import("./helpers/environment-role");
      harnessRole = declareEnvironmentRoleForSuite("non-production");
      credit = await import("@/lib/member-credit");
      mirrorModule = await import("@/lib/xero-credit-note-mirror");
      const [{ PrismaClient: SeparatePrismaClient }, { createPrismaPgAdapter }] = await Promise.all([import("@prisma/client"), import("@/lib/prisma-adapter")]);
      const separate = (applicationName: string) => {
        const url = new URL(RACE_DB_URL);
        url.searchParams.set("connection_limit", "1");
        url.searchParams.set("application_name", applicationName);
        return new SeparatePrismaClient({ adapter: createPrismaPgAdapter(url.toString()) });
      };
      lockHolderClient = separate("race-4270-lock-holder");
      observerClient = separate("race-4270-observer");
      await Promise.all([lockHolderClient.$connect(), observerClient.$connect()]);
      const xeroApi = await import("@/lib/xero-api-client");
      const realGetClient = xeroApi.getAuthenticatedXeroClient;
      const realCall = xeroApi.callXeroApi;
      installedSpies = [
        vi.spyOn(xeroApi, "getAuthenticatedXeroClient").mockImplementation(((...args: Parameters<typeof realGetClient>) =>
          fakeXero.state.on ? Promise.resolve({ xero: fakeXero.client, tenantId: "race-4270-tenant" }) : realGetClient(...args)) as typeof realGetClient),
        vi.spyOn(xeroApi, "callXeroApi").mockImplementation(((fn: () => Promise<unknown>, options: Parameters<typeof realCall>[1]) =>
          fakeXero.state.on ? fn() : realCall(fn, options)) as typeof realCall),
      ];
    }, 60_000);

    afterEach(() => {
      fakeXero.state.on = false;
      for (const installed of testSpies) installed.mockRestore();
      testSpies = [];
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

    describe("writing down", () => {
      it("writes down a lot whose note was fully spent in Xero, once, and a replay writes nothing", async () => {
        await seed();

        const result = await mirror(evidence());

        expect(result).toEqual({ acted: true, action: "written-down", cents: LOT_CENTS, leftForAllocationCents: 0 });
        expect(await balance()).toBe(0);
        const [row, ...others] = await marked();
        expect(others).toHaveLength(0);
        expect(row).toMatchObject({ amountCents: -LOT_CENTS, type: "ADMIN_ADJUSTMENT", xeroCreditNoteId: NOTE_ID, memberId: MEMBER_ID });
        const [audit, ...moreAudits] = await audits("xero.credit_note.outside_spend_mirrored");
        expect(moreAudits).toHaveLength(0);
        // The system did this: the member is its subject, never its actor.
        expect(audit).toMatchObject({ subjectMemberId: MEMBER_ID, actorMemberId: null, category: "xero", severity: "important", outcome: "success" });
        expect(audit!.metadata).toMatchObject({ creditNoteId: NOTE_ID, writtenDownCents: LOT_CENTS, outsideSpendCents: LOT_CENTS, leftForAllocationCents: 0 });

        expect(await mirror(evidence())).toMatchObject({ acted: false, reason: "nothing-to-do" });
        expect(await marked()).toHaveLength(1);
        expect(await allAudits()).toBe(1);
      });

      it("mirrors a change in steps by the net: more spent later writes only the difference", async () => {
        await seed();

        await mirror(evidence({ spentCents: 2_000 }));
        expect(await netWrittenDown()).toBe(2_000);
        await mirror(evidence({ spentCents: 3_000 }));

        expect(await netWrittenDown()).toBe(3_000);
        expect(await balance()).toBe(LOT_CENTS - 3_000);
        expect(await allAudits()).toBe(2);
      });

      it("counts only what the app has no record of: an allocation to a booking invoice and a payment the app made are its own", async () => {
        await seed();
        await prisma.xeroObjectLink.create({
          data: { localModel: "Payment", localId: "race-4270-other-payment", xeroObjectType: "INVOICE", xeroObjectId: KNOWN_INVOICE_ID, role: "PRIMARY_INVOICE", active: true },
        });
        await prisma.xeroObjectLink.create({
          data: { localModel: "Payment", localId: "race-4270-other-payment", xeroObjectType: "PAYMENT", xeroObjectId: KNOWN_PAYMENT_ID, role: "REFUND_PAYMENT", active: true },
        });

        const result = await mirror(
          evidence({
            allocations: [{ invoiceId: KNOWN_INVOICE_ID, cents: 2_000 }],
            payments: [{ paymentId: KNOWN_PAYMENT_ID, cents: 1_000 }],
            remainingCents: LOT_CENTS - 3_000,
            status: "AUTHORISED",
          }),
        );

        expect(result).toMatchObject({ acted: false, reason: "nothing-to-do" });
        await noRows();

        // The same amounts with no record of them are an outside spend.
        const outside = await mirror(
          evidence({ allocations: [{ invoiceId: OUTSIDE_INVOICE_ID, cents: 2_000 }], payments: [{ paymentId: "race-4270-unknown-payment", cents: 1_000 }], remainingCents: LOT_CENTS - 3_000, status: "AUTHORISED" }),
        );
        expect(outside).toMatchObject({ acted: true, action: "written-down", cents: 3_000 });
      });

      it("counts an offset against an invoice that is not a booking's as an outside spend", async () => {
        await seed();
        await prisma.xeroObjectLink.create({
          data: { localModel: "MembershipSubscription", localId: "race-4270-subscription", xeroObjectType: "INVOICE", xeroObjectId: KNOWN_INVOICE_ID, role: "PRIMARY_INVOICE", active: true },
        });

        const result = await mirror(evidence({ allocations: [{ invoiceId: KNOWN_INVOICE_ID, cents: LOT_CENTS }] }));

        expect(result).toMatchObject({ acted: true, cents: LOT_CENTS });
      });

      it("never writes down more than the lot holds", async () => {
        await seed();

        // Xero lists more spent outside than the lot: the lot is the bound.
        const result = await mirror(evidence({ totalCents: 9_000, remainingCents: 0, allocations: [{ invoiceId: OUTSIDE_INVOICE_ID, cents: 9_000 }], status: "PAID" }));

        expect(result).toMatchObject({ acted: true, cents: LOT_CENTS });
        expect(await balance()).toBe(0);
      });

      it("writes only the free part of a lot a booking has drawn from, and says what it left", async () => {
        await seed();
        await drawFromLot(2_000);

        const result = await mirror(evidence());

        expect(result).toEqual({ acted: true, action: "written-down", cents: 3_250, leftForAllocationCents: 2_000 });
        const [audit] = await audits("xero.credit_note.outside_spend_mirrored");
        expect(audit!.metadata).toMatchObject({ writtenDownCents: 3_250, leftForAllocationCents: 2_000 });
        // The booking's slice is untouched: releasing it is the converge's, when Xero refuses it.
        expect(await prisma.memberCreditNoteAllocation.count({ where: { appliedToBookingId: BOOKING_ID } })).toBe(1);
        expect(await credit.deriveBookingAppliedCreditCents(BOOKING_ID)).toBe(2_000);
        expect(await balance()).toBe(0);
      });

      it("bounds the write-down by this lot's own free part, even when the member holds other credit", async () => {
        await seed();
        await prisma.memberCredit.create({
          data: { id: SECOND_LOT_ID, memberId: MEMBER_ID, amountCents: 1_000, type: "CANCELLATION_REFUND", description: "race 4270 other credit", xeroCreditNoteId: SECOND_NOTE_ID },
        });
        await drawFromLot(2_000);
        // The balance (4250) covers more than this lot's free part (3250): the lot is the bound.
        expect(await balance()).toBe(LOT_CENTS + 1_000 - 2_000);

        const result = await mirror(evidence());

        expect(result).toEqual({ acted: true, action: "written-down", cents: 3_250, leftForAllocationCents: 2_000 });
        expect(await balance()).toBe(1_000);
      });

      it("never takes the member's balance below zero: credit applied to a booking but not yet planned is left alone", async () => {
        await seed();
        await createBooking(LOT_CENTS);
        // Applied to the booking and not yet planned onto a lot (no slice): the lot looks free but is spoken for.
        await prisma.$transaction((tx) => credit.applyCreditToBooking(MEMBER_ID, LOT_CENTS, BOOKING_ID, tx, CLUB_FORMAT_TEST));

        const result = await mirror(evidence());

        expect(result).toEqual({ acted: false, reason: "none-free", leftForAllocationCents: LOT_CENTS });
        await noRows();
        expect(await balance()).toBe(0);
      });
    });

    describe("agreeing with the converge, in either order", () => {
      it("mirror first, then the converge: the two together write down exactly what Xero shows spent", async () => {
        await seed();
        await drawFromLot(2_000);
        const { convergeCreditNoteSpentOutsideApp } = await import("@/lib/xero-applied-credit-spent-outside-app");

        await mirror(evidence());
        const converged = await convergeCreditNoteSpentOutsideApp({
          bookingId: BOOKING_ID, creditNoteId: NOTE_ID, requestedCents: 2_000,
          xeroAllocations: [{ invoiceId: OUTSIDE_INVOICE_ID, cents: LOT_CENTS }], xeroPayments: [], noteTotalCents: LOT_CENTS, remainingCents: 0,
        });

        expect(converged).toMatchObject({ converged: true, writtenDownCents: 2_000 });
        expect(await netWrittenDown()).toBe(LOT_CENTS);
        expect(await balance()).toBe(0);
        expect(await credit.deriveBookingAppliedCreditCents(BOOKING_ID)).toBe(0);
        // A later mirror has nothing left to do.
        expect(await mirror(evidence())).toMatchObject({ acted: false, reason: "nothing-to-do" });
      });

      it("converge first, then the mirror: the same total", async () => {
        await seed();
        await drawFromLot(2_000);
        const { convergeCreditNoteSpentOutsideApp } = await import("@/lib/xero-applied-credit-spent-outside-app");

        await convergeCreditNoteSpentOutsideApp({
          bookingId: BOOKING_ID, creditNoteId: NOTE_ID, requestedCents: 2_000,
          xeroAllocations: [{ invoiceId: OUTSIDE_INVOICE_ID, cents: LOT_CENTS }], xeroPayments: [], noteTotalCents: LOT_CENTS, remainingCents: 0,
        });
        const result = await mirror(evidence());

        expect(result).toMatchObject({ acted: true, action: "written-down", cents: 3_250 });
        expect(await netWrittenDown()).toBe(LOT_CENTS);
        expect(await balance()).toBe(0);
      });

      it("a mirror and a converge running at once write the total once", async () => {
        await seed();
        await drawFromLot(2_000);
        const { convergeCreditNoteSpentOutsideApp } = await import("@/lib/xero-applied-credit-spent-outside-app");

        await Promise.all([
          mirror(evidence()),
          convergeCreditNoteSpentOutsideApp({
            bookingId: BOOKING_ID, creditNoteId: NOTE_ID, requestedCents: 2_000,
            xeroAllocations: [{ invoiceId: OUTSIDE_INVOICE_ID, cents: LOT_CENTS }], xeroPayments: [], noteTotalCents: LOT_CENTS, remainingCents: 0,
          }),
        ]);

        expect(await netWrittenDown()).toBe(LOT_CENTS);
        expect(await balance()).toBe(0);
        expect(await credit.deriveBookingAppliedCreditCents(BOOKING_ID)).toBe(0);
      });

      it("two mirrors at once write the total once", async () => {
        await seed();

        const results = await Promise.all([mirror(evidence()), mirror(evidence())]);

        expect(results.filter((r) => r.acted)).toHaveLength(1);
        expect(await marked()).toHaveLength(1);
        expect(await netWrittenDown()).toBe(LOT_CENTS);
        expect(await allAudits()).toBe(1);
      });
    });

    describe("restoring", () => {
      it("gives the lot back when Xero shows the spend undone, as a row that is never a lot, and a replay does nothing", async () => {
        await seed();
        await mirror(evidence());
        expect(await balance()).toBe(0);

        const restored = await mirror(evidence({ spentCents: 0, status: "AUTHORISED" }));

        expect(restored).toEqual({ acted: true, action: "restored", cents: LOT_CENTS, leftForAllocationCents: 0 });
        expect(await balance()).toBe(LOT_CENTS);
        expect(await netWrittenDown()).toBe(0);
        const [audit] = await audits("xero.credit_note.outside_spend_restored");
        expect(audit).toMatchObject({ subjectMemberId: MEMBER_ID, actorMemberId: null, category: "xero", severity: "important" });
        expect(audit!.metadata).toMatchObject({ restoredCents: LOT_CENTS, writtenDownBeforeCents: LOT_CENTS });
        // The restore row is not a lot: the only funding lot for the note is the original, so nothing is minted for it.
        const { findFundingLotsForNote } = await import("@/lib/xero-applied-credit-slice-lookup");
        expect(await findFundingLotsForNote(prisma, MEMBER_ID, NOTE_ID)).toEqual([{ id: LOT_ID, amountCents: LOT_CENTS }]);
        expect(await mirror(evidence({ spentCents: 0, status: "AUTHORISED" }))).toMatchObject({ acted: false, reason: "nothing-to-do" });
        expect(await allAudits()).toBe(2);
      });

      it("restores part when only part is undone, and never more than was written down", async () => {
        await seed();
        await mirror(evidence());

        const partly = await mirror(evidence({ spentCents: 2_000 }));

        expect(partly).toMatchObject({ acted: true, action: "restored", cents: 3_250 });
        expect(await netWrittenDown()).toBe(2_000);
        // Xero shows nothing spent at all: the rest comes back, and that is the whole write-down.
        await mirror(evidence({ spentCents: 0, status: "AUTHORISED" }));
        expect(await netWrittenDown()).toBe(0);
        expect(await balance()).toBe(LOT_CENTS);
      });

      it("names the bookings the converge released for the note", async () => {
        await seed();
        await drawFromLot(2_000);
        const { convergeCreditNoteSpentOutsideApp } = await import("@/lib/xero-applied-credit-spent-outside-app");
        await convergeCreditNoteSpentOutsideApp({
          bookingId: BOOKING_ID, creditNoteId: NOTE_ID, requestedCents: 2_000,
          xeroAllocations: [{ invoiceId: OUTSIDE_INVOICE_ID, cents: 2_000 }], xeroPayments: [], noteTotalCents: LOT_CENTS, remainingCents: LOT_CENTS - 2_000,
        });

        await mirror(evidence({ spentCents: 0, status: "AUTHORISED" }));

        const [audit] = await audits("xero.credit_note.outside_spend_restored");
        expect(audit!.metadata).toMatchObject({ restoredCents: 2_000, releasedBookingIds: [BOOKING_ID] });
        // The lot is back; the booking's released credit is not re-applied (the member owes it).
        expect(await credit.deriveBookingAppliedCreditCents(BOOKING_ID)).toBe(0);
      });
    });

    describe("failing closed", () => {
      it("does nothing for a note that funds no lot, and reads nothing else", async () => {
        await seed();

        expect(await mirror(evidence({ creditNoteId: "race-4270-unrelated-note" }))).toEqual({ acted: false, reason: "no-funding-lot" });
        await noRows();
      });

      it("leaves a note that funds more than one lot alone", async () => {
        await seed();
        await prisma.memberCredit.create({
          data: { id: SECOND_LOT_ID, memberId: MEMBER_ID, amountCents: 1_000, type: "ADMIN_ADJUSTMENT", description: "race 4270 second lot", xeroCreditNoteId: NOTE_ID },
        });

        expect(await mirror(evidence())).toEqual({ acted: false, reason: "shared-credit-note" });
        await noRows();
      });

      it("writes nothing for a voided or deleted note, and tells an officer through the error log", async () => {
        await seed();
        const logger = (await import("@/lib/logger")).default;
        const error = spy(vi.spyOn(logger, "error").mockImplementation(() => undefined));

        expect(await mirror(evidence({ status: "VOIDED" }))).toEqual({ acted: false, reason: "note-not-active" });
        expect(await mirror(evidence({ status: "DELETED" }))).toEqual({ acted: false, reason: "note-not-active" });
        expect(await mirror(evidence({ status: null }))).toEqual({ acted: false, reason: "note-not-active" });

        expect(error).toHaveBeenCalledTimes(2);
        await noRows();
      });

      it("writes nothing when Xero's list does not add up to what the note has lost", async () => {
        await seed();

        // The note lost 5250 but the list explains 3000.
        expect(await mirror(evidence({ allocations: [{ invoiceId: OUTSIDE_INVOICE_ID, cents: 3_000 }], remainingCents: 0 }))).toEqual({ acted: false, reason: "unexplained-spend" });
        // An amount that could not be read.
        expect(await mirror(evidence({ totalCents: null }))).toEqual({ acted: false, reason: "unexplained-spend" });
        expect(await mirror(evidence({ remainingCents: null }))).toEqual({ acted: false, reason: "unexplained-spend" });
        await noRows();
      });

      it("defers a note changed less than two minutes ago and leaves a recheck, then acts once it has settled", async () => {
        await seed();

        const early = await mirror(evidence({ updatedAt: FRESH_AT }));

        expect(early).toEqual({ acted: false, reason: "unsettled" });
        await noRows();
        const recheck = await prisma.xeroSyncCursor.findFirstOrThrow({ where: { resourceType: "CREDIT_NOTE_OUTSIDE_SPEND_MIRROR", scope: `RECHECK:${NOTE_ID}` } });
        expect(recheck.cursorDateTime!.getTime()).toBe(FRESH_AT.getTime() + mirrorModule.CREDIT_NOTE_MIRROR_SETTLE_MS);

        const later = await mirrorModule.mirrorCreditNoteOutsideSpend(evidence({ updatedAt: FRESH_AT }), { now: new Date(NOW.getTime() + 2 * 60 * 1000) });
        expect(later).toMatchObject({ acted: true, action: "written-down" });
        // Acting clears the recheck.
        expect(await prisma.xeroSyncCursor.count({ where: { resourceType: "CREDIT_NOTE_OUTSIDE_SPEND_MIRROR", scope: `RECHECK:${NOTE_ID}` } })).toBe(0);
      });

      it("defers a note whose change time is missing", async () => {
        await seed();

        expect(await mirror(evidence({ updatedAt: null }))).toEqual({ acted: false, reason: "unsettled" });
        await noRows();
      });

      it("waits behind an allocation of this credit in flight in Xero", async () => {
        await seed();
        await drawFromLot(2_000);
        await prisma.xeroSyncOperation.create({
          data: {
            direction: "OUTBOUND", entityType: "ALLOCATION", operationType: "CREATE", localModel: "Payment", localId: PAYMENT_ID, status: "RUNNING",
            queueType: "APPLIED_CREDIT_ALLOCATION", idempotencyKey: "race-4270-allocation", correlationKey: "race-4270-allocation",
            requestPayload: { queueType: "APPLIED_CREDIT_ALLOCATION", bookingId: BOOKING_ID },
          },
        });

        expect(await mirror(evidence())).toEqual({ acted: false, reason: "in-flight-operation" });
        await noRows();
      });

      it("waits behind a deallocation that has not converged, including one that failed", async () => {
        await seed();
        await drawFromLot(2_000);
        await prisma.xeroSyncOperation.create({
          data: {
            direction: "OUTBOUND", entityType: "ALLOCATION", operationType: "UPDATE", localModel: "Payment", localId: PAYMENT_ID, status: "FAILED",
            queueType: "APPLIED_CREDIT_DEALLOCATION", idempotencyKey: "race-4270-deallocation", correlationKey: "race-4270-deallocation",
            requestPayload: { queueType: "APPLIED_CREDIT_DEALLOCATION", bookingId: BOOKING_ID },
          },
        });

        expect(await mirror(evidence())).toEqual({ acted: false, reason: "in-flight-operation" });
        await noRows();
      });
    });

    describe("the kill switch", () => {
      const KEY = { resourceType: "CREDIT_NOTE_OUTSIDE_SPEND_MIRROR", scope: "WRITES" };

      it("unset means writes are on", async () => {
        await seed();
        expect(await mirrorModule.creditNoteMirrorWritesDisabled()).toBe(false);
      });

      it("a row turns writes off with no deploy: it computes and reports what it would have written, and writes nothing", async () => {
        await seed();
        await prisma.xeroSyncCursor.create({ data: { ...KEY, metadata: { writesDisabled: true } } });
        const logger = (await import("@/lib/logger")).default;
        const warn = spy(vi.spyOn(logger, "warn").mockImplementation(() => undefined));

        const result = await mirror(evidence());

        expect(result).toEqual({ acted: false, reason: "writes-disabled", wouldWriteCents: LOT_CENTS, leftForAllocationCents: 0 });
        await noRows();
        expect(await allAudits()).toBe(0);
        expect(warn).toHaveBeenCalledWith(expect.objectContaining({ creditNoteId: NOTE_ID, wouldWriteCents: LOT_CENTS }), expect.stringContaining("switched off"));

        // Switching it back on, with no restart, writes on the next note.
        await prisma.xeroSyncCursor.delete({ where: { resourceType_scope: KEY } });
        expect(await mirror(evidence())).toMatchObject({ acted: true, cents: LOT_CENTS });
      });

      it("a row that cannot be read as 'on' fails toward writing nothing; only an explicit false turns writes back on", async () => {
        await seed();
        await prisma.xeroSyncCursor.create({ data: { ...KEY, metadata: { unexpected: true } } });
        expect(await mirror(evidence())).toMatchObject({ acted: false, reason: "writes-disabled" });

        await prisma.xeroSyncCursor.update({ where: { resourceType_scope: KEY }, data: { metadata: { writesDisabled: false } } });
        expect(await mirror(evidence())).toMatchObject({ acted: true });
      });

      it("while off, a reversed spend reports the restore it would make", async () => {
        await seed();
        await mirror(evidence());
        await prisma.xeroSyncCursor.create({ data: { ...KEY, metadata: { writesDisabled: true } } });

        expect(await mirror(evidence({ spentCents: 0, status: "AUTHORISED" }))).toEqual({ acted: false, reason: "writes-disabled", wouldRestoreCents: LOT_CENTS, leftForAllocationCents: 0 });
        expect(await netWrittenDown()).toBe(LOT_CENTS);
      });
    });

    describe("locks", () => {
      async function waitUntilBlockedBy(holderPid: number) {
        const startedAt = process.hrtime.bigint();
        while (realElapsedMs(startedAt) < 5_000) {
          const rows = await observerClient.$queryRaw<Array<{ count: number }>>`
            SELECT COUNT(*)::int AS "count" FROM pg_stat_activity
            WHERE datname = current_database() AND ${holderPid}::int = ANY(pg_blocking_pids(pid))
          `;
          if ((rows[0]?.count ?? 0) >= 1) return true;
          await new Promise((resolve) => setTimeout(resolve, 10));
        }
        return false;
      }

      it("takes the member's credit-ledger lock, and decides from what it re-reads once it has it", async () => {
        await seed();
        let holderPid = 0;
        const holding = deferred();
        const release = deferred();
        // A credit writer holding the member's key that spends the whole lot before the mirror gets in.
        const held = lockHolderClient.$transaction(async (tx) => {
          await credit.lockMemberCreditLedger(MEMBER_ID, tx);
          holderPid = (await tx.$queryRaw<Array<{ pid: number }>>`SELECT pg_backend_pid() AS pid`)[0]!.pid;
          holding.resolve();
          await release.promise;
          await tx.memberCredit.create({ data: { memberId: MEMBER_ID, amountCents: -LOT_CENTS, type: "ADMIN_ADJUSTMENT", description: "race 4270 member spends it" } });
        }, { timeout: 30_000, maxWait: 10_000 });
        await holding.promise;

        const mirroring = mirror(evidence());
        expect(await waitUntilBlockedBy(holderPid), "the mirror queues behind the member's key").toBe(true);
        release.resolve();
        await held;

        // The balance it reads under the lock is the one after the other writer: nothing left to write down.
        expect(await mirroring).toEqual({ acted: false, reason: "none-free", leftForAllocationCents: LOT_CENTS });
        await noRows();
      });

      it("does not take the global key: it runs while another writer holds it", async () => {
        await seed();
        const holding = deferred();
        const release = deferred();
        const held = lockHolderClient.$transaction(async (tx) => {
          await tx.$executeRaw`SELECT pg_advisory_xact_lock(1)`;
          holding.resolve();
          await release.promise;
        }, { timeout: 30_000, maxWait: 10_000 });
        await holding.promise;

        const result = await Promise.race([
          mirror(evidence()),
          new Promise<"blocked">((resolve) => setTimeout(() => resolve("blocked"), 5_000)),
        ]);
        release.resolve();
        await held;

        expect(result).toMatchObject({ acted: true, action: "written-down" });
      });
    });

    describe("the webhook path", () => {
      function setNote(overrides: { allocations?: Array<{ invoiceID: string; amountCents: number }>; updatedAt?: Date } = {}) {
        fakeXero.state.on = true;
        fakeXero.state.notes.set(NOTE_ID, {
          totalCents: LOT_CENTS,
          allocations: overrides.allocations ?? [{ invoiceID: OUTSIDE_INVOICE_ID, amountCents: LOT_CENTS }],
          payments: [],
          updatedAt: overrides.updatedAt ?? SETTLED_AT,
        });
      }

      it("mirrors from the note the event handler already read, with no second read of Xero", async () => {
        await seed();
        setNote();
        const { reconcileXeroCreditNote } = await import("@/lib/xero-inbound/credit-note");

        const result = await reconcileXeroCreditNote(NOTE_ID);

        expect(result).toMatchObject({ handled: true, kind: "CREDIT_NOTE", resourceId: NOTE_ID });
        expect(fakeXero.state.reads).toEqual([NOTE_ID]);
        expect(await netWrittenDown()).toBe(LOT_CENTS);
        expect(await allAudits()).toBe(1);
      });

      it("runs after the links the event writes: a payment this very event links as the app's own is not an outside spend", async () => {
        await seed();
        // The note is a payment's refund note, and Xero lists a payment against it that the app has not linked yet:
        // this event's link writes record it, so a mirror that ran before them would read it as someone else's.
        await createBooking(0);
        await prisma.payment.update({ where: { id: PAYMENT_ID }, data: { xeroRefundCreditNoteId: NOTE_ID } });
        fakeXero.state.on = true;
        fakeXero.state.notes.set(NOTE_ID, {
          totalCents: LOT_CENTS,
          allocations: [],
          payments: [{ paymentID: KNOWN_PAYMENT_ID, amountCents: LOT_CENTS }],
          updatedAt: SETTLED_AT,
        });
        const { reconcileXeroCreditNote } = await import("@/lib/xero-inbound/credit-note");

        await reconcileXeroCreditNote(NOTE_ID);

        expect(await prisma.xeroObjectLink.count({ where: { xeroObjectType: "PAYMENT", xeroObjectId: KNOWN_PAYMENT_ID, localId: PAYMENT_ID } })).toBeGreaterThan(0);
        await noRows();
        expect(await allAudits()).toBe(0);
      });

      it("never fails the event when the mirror throws: the links are already written", async () => {
        await seed();
        setNote();
        spy(vi.spyOn(mirrorModule, "mirrorCreditNoteOutsideSpend").mockRejectedValue(new Error("boom")));
        const logger = (await import("@/lib/logger")).default;
        const error = spy(vi.spyOn(logger, "error").mockImplementation(() => undefined));
        const { reconcileXeroCreditNote } = await import("@/lib/xero-inbound/credit-note");

        await expect(reconcileXeroCreditNote(NOTE_ID)).resolves.toMatchObject({ handled: true });

        expect(error).toHaveBeenCalledWith(expect.objectContaining({ creditNoteId: NOTE_ID }), expect.stringContaining("sweep will try again"));
        await noRows();
      });

      it("a note changed a moment ago is deferred, and the sweep's recheck picks it up once it has settled", async () => {
        await seed();
        setNote({ updatedAt: FRESH_AT });
        const { reconcileXeroCreditNote } = await import("@/lib/xero-inbound/credit-note");
        await reconcileXeroCreditNote(NOTE_ID);
        await noRows();

        const { runCreditNoteMirrorSweep } = await import("@/lib/xero-credit-note-mirror-sweep");
        const early = await runCreditNoteMirrorSweep({ now: NOW, minPassIntervalMs: 0, noteLimit: 0 });
        expect(early.read).toBe(0);

        const later = new Date(NOW.getTime() + 3 * 60 * 1000);
        fakeXero.state.reads = [];
        const sweep = await runCreditNoteMirrorSweep({ now: later, minPassIntervalMs: 1 });
        expect(sweep.writtenDown).toBe(1);
        expect(await netWrittenDown()).toBe(LOT_CENTS);
        expect(await prisma.xeroSyncCursor.count({ where: { resourceType: "CREDIT_NOTE_OUTSIDE_SPEND_MIRROR", scope: { startsWith: "RECHECK:" } } })).toBe(0);
      });
    });

    describe("the backstop sweep", () => {
      async function addSecondNote() {
        await prisma.memberCredit.create({
          data: { id: SECOND_LOT_ID, memberId: MEMBER_ID, amountCents: 1_000, type: "CANCELLATION_REFUND", description: "race 4270 second lot", xeroCreditNoteId: SECOND_NOTE_ID, createdAt: new Date("2026-06-01T00:00:00.000Z") },
        });
      }

      it("finds notes the ledger still treats as spendable, mirrors them, and leaves a fully drawn lot alone", async () => {
        const { runCreditNoteMirrorSweep } = await import("@/lib/xero-credit-note-mirror-sweep");
        await seed();
        await addSecondNote();
        fakeXero.state.on = true;
        fakeXero.state.notes.set(NOTE_ID, { totalCents: LOT_CENTS, allocations: [{ invoiceID: OUTSIDE_INVOICE_ID, amountCents: LOT_CENTS }], payments: [], updatedAt: SETTLED_AT });
        // The second note's lot is wholly drawn by a booking: nothing in it is free, so it is not read.
        await createBooking(1_000);
        await prisma.memberCreditNoteAllocation.create({ data: { memberCreditId: SECOND_LOT_ID, xeroCreditNoteId: SECOND_NOTE_ID, appliedToBookingId: BOOKING_ID, amountCents: 1_000 } });

        const result = await runCreditNoteMirrorSweep({ now: NOW });

        expect(fakeXero.state.reads).toEqual([NOTE_ID]);
        expect(result).toMatchObject({ read: 1, writtenDown: 1, restored: 0, readFailures: 0, completePass: true });
        expect(await netWrittenDown()).toBe(LOT_CENTS);
      });

      it("revisits a written-down note so a spend Xero later reverses is restored", async () => {
        const { runCreditNoteMirrorSweep } = await import("@/lib/xero-credit-note-mirror-sweep");
        await seed();
        fakeXero.state.on = true;
        fakeXero.state.notes.set(NOTE_ID, { totalCents: LOT_CENTS, allocations: [{ invoiceID: OUTSIDE_INVOICE_ID, amountCents: LOT_CENTS }], payments: [], updatedAt: SETTLED_AT });
        await runCreditNoteMirrorSweep({ now: NOW });
        expect(await balance()).toBe(0);

        fakeXero.state.notes.set(NOTE_ID, { totalCents: LOT_CENTS, allocations: [], payments: [], updatedAt: SETTLED_AT });
        const result = await runCreditNoteMirrorSweep({ now: NOW });

        expect(result).toMatchObject({ read: 1, writtenDown: 0, restored: 1 });
        expect(await balance()).toBe(LOT_CENTS);
      });

      it("is throttled once a complete pass has run, but still takes deferred rechecks", async () => {
        const { runCreditNoteMirrorSweep } = await import("@/lib/xero-credit-note-mirror-sweep");
        await seed();
        fakeXero.state.on = true;
        fakeXero.state.notes.set(NOTE_ID, { totalCents: LOT_CENTS, allocations: [], payments: [], updatedAt: SETTLED_AT });
        await prisma.cronJobRun.create({
          data: { jobName: "xero-credit-note-outside-spend-mirror", status: "SUCCESS", startedAt: new Date(NOW.getTime() - 60 * 1000), completedAt: NOW, resultSummary: { completePass: true } },
        });

        const throttled = await runCreditNoteMirrorSweep({ now: NOW });

        expect(throttled).toMatchObject({ skipped: true, read: 0 });
        expect(fakeXero.state.reads).toEqual([]);

        await prisma.xeroSyncCursor.create({ data: { resourceType: "CREDIT_NOTE_OUTSIDE_SPEND_MIRROR", scope: `RECHECK:${NOTE_ID}`, cursorDateTime: new Date(NOW.getTime() - 1_000) } });
        const withRecheck = await runCreditNoteMirrorSweep({ now: NOW });
        expect(fakeXero.state.reads).toEqual([NOTE_ID]);
        // A recheck-only run is not a complete pass of its own, so it never extends the throttle.
        expect(withRecheck.completePass).toBe(false);
        expect(await prisma.xeroSyncCursor.count({ where: { resourceType: "CREDIT_NOTE_OUTSIDE_SPEND_MIRROR", scope: { startsWith: "RECHECK:" } } })).toBe(0);
      });

      it("walks a large ledger across runs from a stored cursor", async () => {
        const { runCreditNoteMirrorSweep } = await import("@/lib/xero-credit-note-mirror-sweep");
        await seed();
        await addSecondNote();
        fakeXero.state.on = true;
        for (const [noteId, total] of [[NOTE_ID, LOT_CENTS], [SECOND_NOTE_ID, 1_000]] as const) {
          fakeXero.state.notes.set(noteId, { totalCents: total, allocations: [], payments: [], updatedAt: SETTLED_AT });
        }

        const first = await runCreditNoteMirrorSweep({ now: NOW, noteLimit: 1 });
        const second = await runCreditNoteMirrorSweep({ now: NOW, noteLimit: 1 });

        expect(first).toMatchObject({ read: 1, completePass: false });
        expect(second).toMatchObject({ read: 1, completePass: true });
        expect(fakeXero.state.reads.slice().sort()).toEqual([NOTE_ID, SECOND_NOTE_ID].sort());
      });

      it("a note whose mirror fails is logged and keeps its place; the rest of the run carries on", async () => {
        const { runCreditNoteMirrorSweep } = await import("@/lib/xero-credit-note-mirror-sweep");
        await seed();
        await addSecondNote();
        fakeXero.state.on = true;
        for (const [noteId, total] of [[NOTE_ID, LOT_CENTS], [SECOND_NOTE_ID, 1_000]] as const) {
          fakeXero.state.notes.set(noteId, { totalCents: total, allocations: [{ invoiceID: OUTSIDE_INVOICE_ID, amountCents: total }], payments: [], updatedAt: SETTLED_AT });
        }
        const logger = (await import("@/lib/logger")).default;
        const error = spy(vi.spyOn(logger, "error").mockImplementation(() => undefined));

        const result = await runCreditNoteMirrorSweep({
          now: NOW,
          mirror: (e) => (e.creditNoteId === NOTE_ID ? Promise.reject(new Error("lock wait timed out")) : mirrorModule.mirrorCreditNoteOutsideSpend(e, { now: NOW })),
        });

        expect(result).toMatchObject({ read: 2, writtenDown: 1, mirrorFailures: 1, completePass: false });
        expect(error).toHaveBeenCalledWith(expect.objectContaining({ creditNoteId: NOTE_ID }), expect.stringContaining("could not mirror"));
        // The note that did not fail was written down; the other waits for the next run.
        expect(await netWrittenDown()).toBe(1_000);
      });

      it("stops after three failed reads in a row and does not call the pass complete", async () => {
        const { runCreditNoteMirrorSweep } = await import("@/lib/xero-credit-note-mirror-sweep");
        await seed();
        fakeXero.state.on = true;
        fakeXero.state.failReads = true;
        for (let i = 0; i < 4; i += 1) {
          await prisma.xeroSyncCursor.create({ data: { resourceType: "CREDIT_NOTE_OUTSIDE_SPEND_MIRROR", scope: `RECHECK:race-4270-gone-${i}`, cursorDateTime: new Date(NOW.getTime() - 1_000) } });
        }

        const result = await runCreditNoteMirrorSweep({ now: NOW });

        expect(result.readFailures).toBe(3);
        expect(result.completePass).toBe(false);
        expect(fakeXero.state.reads).toHaveLength(3);
        // Unread notes keep their recheck for the next run.
        expect(await prisma.xeroSyncCursor.count({ where: { resourceType: "CREDIT_NOTE_OUTSIDE_SPEND_MIRROR", scope: { startsWith: "RECHECK:" } } })).toBe(4);
        await noRows();
      });
    });
  },
);

// The role declared above is put back, so no later suite inherits it.
(RUN ? describe : describe.skip)("#4270: the harness puts the environment role back", () => {
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
