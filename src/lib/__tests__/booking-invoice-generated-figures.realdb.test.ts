import type { ClubIdentitySettings, PrismaClient } from "@prisma/client";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { assertSafeRaceDbUrl } from "./support/race-db-url";

/**
 * #5066 slice 2, against real PostgreSQL: the app's generated booking invoice
 * (Xero off) reads the booking page's own figures. The review asked for a
 * real-database test of them (finding 5): the lines from the stored guests,
 * nights, promotion and recorded change fee; the account credit from the
 * ledger's BOOKING_APPLIED rows; paid from Net Collected; and the balance from
 * the one amount-owed read, so the PDF and the page's Invoice and credits card
 * (`bookingInvoiceSummary` over `loadBookingDetail` + `readBookingAmountOwed`)
 * cannot disagree. Each download writes its audit row in the database.
 */
const RUN = process.env.RUN_CONCURRENCY_RACE_TESTS === "1";
const URL = process.env.CONCURRENCY_RACE_DATABASE_URL ?? "";
const PREFIX = "race-5066-";
const MEMBER = `${PREFIX}member`;
const PAID = `${PREFIX}paid-booking`;
const REVIEW = `${PREFIX}review-booking`;
const PROMO = `${PREFIX}promo`;
const day = (iso: string) => new Date(`${iso}T00:00:00.000Z`);

let db: PrismaClient;
let previousIdentity: ClubIdentitySettings | null;
let lodgeName: string;

const session = { user: { id: MEMBER, role: "MEMBER", accessRoles: [{ role: "USER" }] } } as never;
const allowed = async () => ({ success: true, limit: 20, remaining: 19, resetAt: 0 });

async function seedGuest(bookingId: string, id: string, guest: { firstName: string; ageTier: "ADULT" | "CHILD"; nights: number[] }) {
  await db.bookingGuest.create({
    data: {
      id,
      bookingId,
      firstName: guest.firstName,
      lastName: "Fixture",
      ageTier: guest.ageTier,
      isMember: guest.ageTier === "ADULT",
      memberId: guest.ageTier === "ADULT" ? MEMBER : null,
      stayStart: day("2026-08-03"),
      stayEnd: day("2026-08-06"),
      priceCents: guest.nights.reduce((sum, cents) => sum + cents, 0),
      nights: {
        create: guest.nights.map((priceCents, index) => ({
          stayDate: day(`2026-08-0${3 + index}`),
          priceCents,
          priceSource: "SOLD",
        })),
      },
    },
  });
}

(RUN ? describe : describe.skip)("generated booking invoice figures in PostgreSQL (#5066)", () => {
  let download: typeof import("@/app/(authenticated)/bookings/[id]/_lib/booking-invoice-download");
  let dependencies: NonNullable<Parameters<typeof download.prepareBookingInvoiceDownload>[4]>;

  beforeAll(async () => {
    assertSafeRaceDbUrl(URL, "Generated booking invoice figures");
    process.env.DATABASE_URL = URL;
    ({ prisma: db } = await import("@/lib/prisma"));
    download = await import("@/app/(authenticated)/bookings/[id]/_lib/booking-invoice-download");
    const { loadBookingDetail } = await import("@/app/(authenticated)/bookings/[id]/_lib/load-booking-detail");
    const { renderGeneratedBookingInvoice } = await import("@/app/(authenticated)/bookings/[id]/_lib/booking-invoice-generated");
    const { getClubIdentity } = await import("@/lib/club-identity-settings");
    const neverXero = async () => {
      throw new Error("a Xero-off club's download must not reach Xero");
    };
    // The real readers and writer; only the module flag is pinned to Xero off,
    // and every Xero door throws so reaching one fails the test.
    dependencies = {
      loadBooking: loadBookingDetail,
      modules: async () => ({ xeroIntegration: false }),
      offer: download.resolveBookingInvoiceOffer,
      xeroConnected: neverXero,
      clubShortName: async () => (await getClubIdentity()).shortName,
      fetchXeroInvoicePdf: neverXero,
      fetchXeroCreditNotePdf: neverXero,
      renderGenerated: renderGeneratedBookingInvoice,
    } as never;

    previousIdentity = await db.clubIdentitySettings.findUnique({ where: { id: "default" } });
    await db.clubIdentitySettings.upsert({
      where: { id: "default" },
      create: { id: "default", legalName: "Race Fixture Club Incorporated", postalAddress: "PO Box 5066\nOhakune 4625" },
      update: { legalName: "Race Fixture Club Incorporated", postalAddress: "PO Box 5066\nOhakune 4625" },
    });
    await db.member.create({
      data: { id: MEMBER, firstName: "Aroha", lastName: "Fixture", email: "invoice-5066@example.invalid", passwordHash: "not-a-password" },
    });
    await db.promoCode.create({ data: { id: PROMO, code: "RACE5066", type: "FIXED_AMOUNT" } });

    // A paid booking: 3 nights for an adult (one dearer night) and a child,
    // a promotion, a recorded change fee, account credit and a card payment.
    await db.booking.create({
      data: {
        id: PAID,
        memberId: MEMBER,
        status: "CONFIRMED",
        checkIn: day("2026-08-03"),
        checkOut: day("2026-08-06"),
        totalPriceCents: 47_000,
        promoAdjustmentCents: -2_000,
        discountCents: 2_000,
        finalPriceCents: 45_000,
      },
    });
    await seedGuest(PAID, `${PREFIX}paid-adult`, { firstName: "Aroha", ageTier: "ADULT", nights: [10_000, 10_000, 12_000] });
    await seedGuest(PAID, `${PREFIX}paid-child`, { firstName: "Mere", ageTier: "CHILD", nights: [5_000, 5_000, 5_000] });
    await db.promoRedemption.create({
      data: { bookingId: PAID, promoCodeId: PROMO, memberId: MEMBER, discountCents: 2_000, priceAdjustmentCents: -2_000 },
    });
    await db.payment.create({
      data: { bookingId: PAID, amountCents: 42_500, changeFeeCents: 2_500, status: "SUCCEEDED", source: "STRIPE" },
    });
    await db.memberCredit.create({
      data: { memberId: MEMBER, amountCents: -5_000, type: "BOOKING_APPLIED", description: "Fixture credit applied", appliedToBookingId: PAID },
    });

    // A booking awaiting review, nothing paid.
    await db.booking.create({
      data: {
        id: REVIEW,
        memberId: MEMBER,
        status: "AWAITING_REVIEW",
        checkIn: day("2026-08-03"),
        checkOut: day("2026-08-06"),
        totalPriceCents: 30_000,
        finalPriceCents: 30_000,
      },
    });
    await seedGuest(REVIEW, `${PREFIX}review-adult`, { firstName: "Tama", ageTier: "ADULT", nights: [10_000, 10_000, 10_000] });

    lodgeName = (await db.booking.findUniqueOrThrow({ where: { id: PAID }, select: { lodge: { select: { name: true } } } })).lodge.name;
  }, 60_000);

  afterAll(async () => {
    if (!db) return;
    await db.auditLog.deleteMany({ where: { entityId: { in: [PAID, REVIEW] } } });
    await db.memberCredit.deleteMany({ where: { memberId: MEMBER } });
    await db.promoRedemption.deleteMany({ where: { bookingId: { in: [PAID, REVIEW] } } });
    await db.payment.deleteMany({ where: { bookingId: { in: [PAID, REVIEW] } } });
    await db.bookingGuest.deleteMany({ where: { bookingId: { in: [PAID, REVIEW] } } });
    await db.booking.deleteMany({ where: { id: { in: [PAID, REVIEW] } } });
    await db.promoCode.deleteMany({ where: { id: PROMO } });
    await db.member.deleteMany({ where: { id: MEMBER } });
    if (previousIdentity) await db.clubIdentitySettings.update({ where: { id: "default" }, data: previousIdentity });
    else await db.clubIdentitySettings.deleteMany({ where: { id: "default" } });
  });

  it("prints the stored lines and the card's own figures, and audits the issued document", async () => {
    const { loadBookingDetail } = await import("@/app/(authenticated)/bookings/[id]/_lib/load-booking-detail");
    const { readBookingAmountOwed } = await import("@/lib/booking-amount-owed");
    const { bookingInvoiceSummary } = await import("@/lib/booking-invoice-summary");
    const { renderGeneratedBookingInvoice } = await import("@/app/(authenticated)/bookings/[id]/_lib/booking-invoice-generated");

    // What the booking page's Invoice and credits card is handed.
    const booking = (await loadBookingDetail(PAID))!;
    const card = bookingInvoiceSummary(booking, await readBookingAmountOwed(booking));
    expect(card).toEqual({
      totalCents: 45_000,
      changeFeeCents: 2_500,
      creditAppliedCents: 5_000,
      paidCents: 42_500,
      keptCents: 0,
      balanceCents: 0,
      balanceWhen: "NOW",
    });

    const generated = await renderGeneratedBookingInvoice(booking, { notYetApproved: false });
    expect(generated.data.lines).toEqual([
      expect.objectContaining({ kind: "GUEST", guest: "Aroha Fixture", nights: 2, ratePerNightCents: 10_000, amountCents: 20_000 }),
      expect.objectContaining({ kind: "GUEST", guest: "Aroha Fixture", nights: 1, ratePerNightCents: 12_000, amountCents: 12_000 }),
      expect.objectContaining({ kind: "GUEST", guest: "Mere Fixture", nights: 3, ratePerNightCents: 5_000, amountCents: 15_000 }),
      { kind: "PROMO", description: "Promo adjustment - RACE5066", amountCents: -2_000 },
      { kind: "FEE", description: "Late notice booking change fee", amountCents: 2_500 },
    ]);
    expect(generated.data.lines.reduce((sum, line) => sum + line.amountCents, 0)).toBe(47_500);
    expect(generated.data.totalCents).toBe(card.totalCents + card.changeFeeCents);
    const rowCents = Object.fromEntries(generated.data.accountRows.map((row) => [row.label, row.cents]));
    expect(rowCents).toEqual({
      "Account credit applied": card.creditAppliedCents,
      "Paid, less refunds and credits returned": card.paidCents,
      "Still to pay": card.balanceCents,
    });
    expect(generated.data.supplier).toEqual({ name: "Race Fixture Club Incorporated", addressLines: ["PO Box 5066", "Ohakune 4625"] });
    expect(generated.data.placeOfStay).toBe(lodgeName);

    const result = await download.prepareBookingInvoiceDownload(PAID, session, { kind: "INVOICE" }, { ipAddress: null, chargeBookingLimit: allowed }, dependencies);
    expect(result.kind).toBe("PDF");
    if (result.kind !== "PDF") return;
    const content = result.body.toString("latin1");
    for (const text of ["(Invoice)", "Race Fixture Club Incorporated", "PO Box 5066", `Place of stay: ${lodgeName}`, "Promo adjustment - RACE5066"]) {
      expect(content).toContain(text);
    }
    expect(content).not.toMatch(/GST/i);

    const audits = await db.auditLog.findMany({ where: { entityId: PAID, action: "booking.invoice.downloaded" } });
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({ category: "booking", actorMemberId: MEMBER, subjectMemberId: MEMBER, outcome: "success" });
    expect(audits[0]!.metadata).toMatchObject({
      bookingId: PAID,
      source: "GENERATED",
      notYetApproved: false,
      totalCents: 47_500,
      balanceCents: 0,
      onBehalf: false,
    });
  });

  it("marks a booking awaiting review Not yet approved, with what falls due once reviewed", async () => {
    const result = await download.prepareBookingInvoiceDownload(REVIEW, session, { kind: "INVOICE" }, { ipAddress: null, chargeBookingLimit: allowed }, dependencies);
    expect(result.kind).toBe("PDF");
    if (result.kind !== "PDF") return;
    const content = result.body.toString("latin1");
    expect(content).toContain("NOT YET APPROVED");
    expect(content).toContain("Due once reviewed");
    const [audit] = await db.auditLog.findMany({ where: { entityId: REVIEW, action: "booking.invoice.downloaded" } });
    expect(audit!.metadata).toMatchObject({ source: "GENERATED", notYetApproved: true, totalCents: 30_000, balanceCents: 30_000 });
  });

  it("offers no generated document once the Xero module is on, and none on a cancelled booking", async () => {
    const xeroOn = { ...dependencies, modules: async () => ({ xeroIntegration: true }) } as typeof dependencies;
    expect(
      await download.prepareBookingInvoiceDownload(PAID, session, { kind: "INVOICE" }, { ipAddress: null, chargeBookingLimit: allowed }, xeroOn),
    ).toEqual({ kind: "NOT_FOUND" });
    await db.booking.update({ where: { id: REVIEW }, data: { status: "CANCELLED" } });
    expect(
      await download.prepareBookingInvoiceDownload(REVIEW, session, { kind: "INVOICE" }, { ipAddress: null, chargeBookingLimit: allowed }, dependencies),
    ).toEqual({ kind: "NOT_FOUND" });
    // Neither refusal wrote an audit row.
    expect(await db.auditLog.count({ where: { entityId: { in: [PAID, REVIEW] }, action: "booking.invoice.downloaded" } })).toBe(2);
  });
});
