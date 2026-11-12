/**
 * Real-PostgreSQL round trip through the Xero test transport (#4908): the
 * app's own Xero session is served by `XeroFake` (`setXeroClientForTests`), so
 * the production invoice push and the production inbound reconciliation run
 * unmocked against one stateful Xero.
 *
 * A bank-transfer booking's invoice is raised by `createXeroInvoiceForBooking`,
 * the member pays part of it in Xero, then the rest, and `reconcileXeroInvoice`
 * reads each state back. The stored payment, booking and ledger are asserted at
 * each step, and a repeat sync must leave every row as it was.
 *
 * Ordinary Vitest runs skip the whole file. It needs the guarded, disposable
 * loopback PostgreSQL the race harness uses, and owns its `race-4908-xero-`
 * fixtures.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { assertSafeRaceDbUrl } from "@/lib/__tests__/support/race-db-url";
import { releaseBookingJournalForTeardown } from "@/lib/__tests__/support/booking-financial-history-teardown";
import { CLUB_FORMAT_TEST } from "@/lib/__tests__/support/club-format-fixture";
import { declareEnvironmentRoleForSuite, type SuiteEnvironmentRoleDeclaration } from "@/lib/__tests__/helpers/environment-role";
import { ENVIRONMENT_ROLE_ENV_VAR } from "@/lib/environment-role-declaration";
import { XeroFake } from "./xero-fake";
import { xeroTransport } from "./xero-transport";

const RUN = process.env.RUN_CONCURRENCY_RACE_TESTS === "1";
const RACE_DB_URL = process.env.CONCURRENCY_RACE_DATABASE_URL ?? "";

const P = "race-4908-xero";
const MEMBER_ID = `${P}-member`;
const LODGE_ID = `${P}-lodge`;
const BOOKING_ID = `${P}-booking`;
const GUEST_ID = `${P}-guest`;
const PAYMENT_ID = `${P}-payment`;
const CHECK_IN = new Date("2026-09-10T00:00:00.000Z");
const NIGHT_2 = new Date("2026-09-11T00:00:00.000Z");
const CHECK_OUT = new Date("2026-09-12T00:00:00.000Z");
const NIGHT_CENTS = 4_000;
const PRICE_CENTS = 2 * NIGHT_CENTS;

let prisma: (typeof import("@/lib/prisma"))["prisma"];
let xeroClient: typeof import("@/lib/xero-api-client");
let invoices: typeof import("@/lib/xero-booking-invoices");
let inbound: typeof import("@/lib/xero-inbound/invoice");
let role: SuiteEnvironmentRoleDeclaration | undefined;

(RUN ? describe : describe.skip)("Xero invoice push and inbound sync served by XeroFake - real PostgreSQL (#4908)", { timeout: 60_000 }, () => {
  let fake: XeroFake;

  async function clean() {
    await prisma.xeroSyncOperation.deleteMany({ where: { localId: { in: [BOOKING_ID, PAYMENT_ID, MEMBER_ID] } } });
    await prisma.xeroObjectLink.deleteMany({ where: { localId: { in: [BOOKING_ID, PAYMENT_ID, MEMBER_ID] } } });
    await prisma.auditLog.deleteMany({ where: { OR: [{ targetId: { in: [BOOKING_ID, PAYMENT_ID] } }, { memberId: MEMBER_ID }, { subjectMemberId: MEMBER_ID }] } });
    await prisma.bookingEvent.deleteMany({ where: { bookingId: BOOKING_ID } });
    await releaseBookingJournalForTeardown(prisma, [BOOKING_ID]);
    await prisma.bookingLedgerLine.deleteMany({ where: { bookingId: BOOKING_ID } });
    await prisma.paymentTransaction.deleteMany({ where: { paymentId: PAYMENT_ID } });
    await prisma.payment.deleteMany({ where: { id: PAYMENT_ID } });
    await prisma.bookingGuestNight.deleteMany({ where: { bookingGuest: { bookingId: BOOKING_ID } } });
    await prisma.bookingGuest.deleteMany({ where: { bookingId: BOOKING_ID } });
    await prisma.memberCredit.deleteMany({ where: { memberId: MEMBER_ID } });
    await prisma.booking.deleteMany({ where: { id: BOOKING_ID } });
  }

  beforeAll(async () => {
    assertSafeRaceDbUrl(RACE_DB_URL, "Xero transport round trip");
    process.env.DATABASE_URL = RACE_DB_URL;
    role = declareEnvironmentRoleForSuite("non-production");
    ({ prisma } = await import("@/lib/prisma"));
    xeroClient = await import("@/lib/xero-api-client");
    invoices = await import("@/lib/xero-booking-invoices");
    inbound = await import("@/lib/xero-inbound/invoice");
    await clean();
    await prisma.member.deleteMany({ where: { id: MEMBER_ID } });
    await prisma.lodgeSettings.deleteMany({ where: { lodgeId: LODGE_ID } });
    await prisma.lodge.deleteMany({ where: { id: LODGE_ID } });
    await prisma.member.create({
      data: { id: MEMBER_ID, email: `${MEMBER_ID}@example.invalid`, passwordHash: "not-a-real-password", firstName: "Round", lastName: "Trip", ageTier: "ADULT" },
    });
    await prisma.lodge.create({ data: { id: LODGE_ID, name: "Race 4908 Xero Lodge", slug: P } });
    await prisma.lodgeSettings.create({ data: { id: LODGE_ID, lodgeId: LODGE_ID, capacity: 10 } });
  });

  beforeEach(async () => {
    await clean();
    fake = new XeroFake(`${P}-`);
    xeroClient.setXeroClientForTests(xeroTransport(fake));
    await prisma.booking.create({
      data: { id: BOOKING_ID, memberId: MEMBER_ID, lodgeId: LODGE_ID, checkIn: CHECK_IN, checkOut: CHECK_OUT, status: "PAYMENT_PENDING", totalPriceCents: PRICE_CENTS, finalPriceCents: PRICE_CENTS },
    });
    await prisma.bookingGuest.create({
      data: {
        id: GUEST_ID, bookingId: BOOKING_ID, memberId: MEMBER_ID, firstName: "Round", lastName: "Trip", ageTier: "ADULT", isMember: true,
        stayStart: CHECK_IN, stayEnd: CHECK_OUT, priceCents: PRICE_CENTS,
        nights: { create: [{ stayDate: CHECK_IN, priceCents: NIGHT_CENTS, priceSource: "SOLD" }, { stayDate: NIGHT_2, priceCents: NIGHT_CENTS, priceSource: "SOLD" }] },
      },
    });
    await prisma.payment.create({ data: { id: PAYMENT_ID, bookingId: BOOKING_ID, amountCents: PRICE_CENTS, source: "INTERNET_BANKING", status: "PENDING" } });
  });

  afterAll(async () => {
    try {
      if (!prisma) return;
      await clean();
      await prisma.member.deleteMany({ where: { id: MEMBER_ID } });
      await prisma.lodgeSettings.deleteMany({ where: { lodgeId: LODGE_ID } });
      await prisma.lodge.deleteMany({ where: { id: LODGE_ID } });
    } finally {
      xeroClient?.resetXeroClientForTests();
      role?.restore();
    }
  });

  /** Every stored money fact this round trip can move, in a stable order. */
  const moneyState = async () => ({
    booking: await prisma.booking.findUniqueOrThrow({ where: { id: BOOKING_ID }, select: { status: true } }),
    payment: await prisma.payment.findUniqueOrThrow({
      where: { id: PAYMENT_ID },
      select: {
        status: true, xeroInvoiceId: true, refundedAmountCents: true,
        transactions: { select: { id: true, kind: true, amountCents: true, status: true }, orderBy: { id: "asc" } },
      },
    }),
    ledger: await prisma.bookingLedgerLine.findMany({
      where: { bookingId: BOOKING_ID },
      select: { id: true, kind: true, amountCents: true, postingKey: true },
      orderBy: { postingKey: "asc" },
    }),
    credits: await prisma.memberCredit.count({ where: { memberId: MEMBER_ID } }),
    // Each Xero payment the sync saw, at the amount Xero holds (in dollars, as stored).
    paymentLinks: (await prisma.xeroObjectLink.findMany({
      where: { localId: PAYMENT_ID, role: "INVOICE_PAYMENT" },
      select: { xeroObjectId: true, metadata: true },
      orderBy: { xeroObjectId: "asc" },
    })).map((link) => ({ id: link.xeroObjectId, amount: (link.metadata as { amount?: unknown } | null)?.amount })),
    events: await prisma.bookingEvent.findMany({ where: { bookingId: BOOKING_ID }, select: { id: true, type: true }, orderBy: { id: "asc" } }),
  });
  const sync = (invoiceId: string) => inbound.reconcileXeroInvoice(invoiceId, CLUB_FORMAT_TEST, { skipSubscriptionRefresh: true });

  it("pushes the booking invoice into the fake, holds on a part payment, settles once on the rest", async () => {
    const invoiceId = await invoices.createXeroInvoiceForBooking(BOOKING_ID);
    if (!invoiceId) throw new Error("the production push raised no invoice");

    // The production write is visible in the fake, at the booking's price.
    const pushed = fake.snapshot();
    expect(pushed.contacts).toHaveLength(1);
    expect(pushed.invoices).toEqual([
      expect.objectContaining({ invoiceID: invoiceId, contactID: pushed.contacts[0].contactID, totalCents: PRICE_CENTS, status: "AUTHORISED" }),
    ]);
    expect(await prisma.payment.findUniqueOrThrow({ where: { id: PAYMENT_ID }, select: { xeroInvoiceId: true } })).toEqual({ xeroInvoiceId: invoiceId });

    // A second push finds the linked invoice; Xero holds still one.
    expect(await invoices.createXeroInvoiceForBooking(BOOKING_ID)).toBe(invoiceId);
    expect(fake.snapshot().invoices).toHaveLength(1);

    // Part payment: the invoice stays open, so nothing settles.
    fake.payInvoice("bank-receipt-1", invoiceId, 5_000);
    await sync(invoiceId);
    expect(await moneyState()).toMatchObject({
      booking: { status: "PAYMENT_PENDING" },
      payment: { status: "PENDING", xeroInvoiceId: invoiceId, transactions: [] },
      ledger: [],
      credits: 0,
      paymentLinks: [{ amount: 50 }],
    });

    // The rest arrives: Xero reports PAID and the app settles the full price once.
    fake.payInvoice("bank-receipt-2", invoiceId, 3_000);
    await sync(invoiceId);
    const settled = await moneyState();
    expect(settled).toMatchObject({
      booking: { status: "PAID" },
      payment: { status: "SUCCEEDED", refundedAmountCents: 0, transactions: [{ kind: "PRIMARY", amountCents: PRICE_CENTS, status: "SUCCEEDED" }] },
      // The cash once, and each sold night once, as the confirmation posts them.
      ledger: [
        { kind: "BANK_RECEIPT", amountCents: PRICE_CENTS },
        { kind: "GUEST_NIGHT", amountCents: NIGHT_CENTS, postingKey: `confirmation:${BOOKING_ID}:night:${GUEST_ID}:2026-09-10` },
        { kind: "GUEST_NIGHT", amountCents: NIGHT_CENTS, postingKey: `confirmation:${BOOKING_ID}:night:${GUEST_ID}:2026-09-11` },
      ],
      credits: 0,
      paymentLinks: [{ amount: 50 }, { amount: 30 }],
    });

    // A repeat sync of the same Xero state posts nothing and moves nothing.
    await sync(invoiceId);
    expect(await moneyState()).toEqual(settled);
    expect(fake.snapshot().payments.map((p) => p.amountCents)).toEqual([5_000, 3_000]);
  });
});

// The role declared above is put back, so no later suite inherits it.
(RUN ? describe : describe.skip)("#4908: the Xero round trip puts the environment role back", () => {
  it("leaves APP_ENVIRONMENT_ROLE as it found it", () => {
    expect(role, "the suite declared its environment role").toBeDefined();
    expect(process.env[ENVIRONMENT_ROLE_ENV_VAR]).toBe(role!.before);
  });
});
