/** #4913: real paid-claim rollback, retry and settlement-event consistency. */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { CLUB_FORMAT_TEST } from "./support/club-format-fixture";
import { releaseBookingJournalForTeardown } from "./support/booking-financial-history-teardown";

vi.mock("@/lib/stripe", async (importOriginal) =>
  (await import("./support/stripe-race-double")).stripeRaceDouble(await importOriginal()),
);
const RUN = process.env.RUN_CONCURRENCY_RACE_TESTS === "1";
const BOOKING_ID = "race-4913-booking";
const MEMBER_ID = "race-4913-member";
const LODGE_ID = "race-4913-lodge";
const PAYMENT_ID = "race-4913-payment";
function assertSafeRaceDbUrl(url: string): void {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error("Cancellation credit event proofs need a valid CONCURRENCY_RACE_DATABASE_URL.");
  }
  const port = Number.parseInt(parsed.port, 10);
  if (!Number.isFinite(port) || port === 5432 || port < 55442) {
    throw new Error(
      `Refusing to run cancellation credit event proofs against port ${parsed.port || "(none)"}: use a throwaway PostgreSQL on 55442+ (never 5432).`,
    );
  }
  const host = parsed.hostname.toLowerCase();
  if (!["localhost", "127.0.0.1", "::1", "[::1]"].includes(host)) {
    throw new Error("Cancellation credit event proof DB must be loopback-only.");
  }
  const databaseName = decodeURIComponent(parsed.pathname.replace(/^\//, ""));
  if (!databaseName.includes("concurrency_race_1881")) {
    throw new Error("Cancellation credit event proof DB name must contain 'concurrency_race_1881'.");
  }
}


let prisma: (typeof import("@/lib/prisma"))["prisma"];
let cancelBooking: (typeof import("@/lib/booking-cancel"))["cancelBooking"];

(RUN ? describe : describe.skip)("cancellation credit facts commit with the paid claim (#4913)", () => {
  async function clean() {
    await releaseBookingJournalForTeardown(prisma, [BOOKING_ID]);
    await prisma.bookingLedgerLine.deleteMany({ where: { bookingId: BOOKING_ID } });
    await prisma.bookingEvent.deleteMany({ where: { bookingId: BOOKING_ID } });
    await prisma.memberCredit.deleteMany({ where: { sourceBookingId: BOOKING_ID } });
    await prisma.xeroSyncOperation.deleteMany({ where: { localId: { in: [BOOKING_ID, PAYMENT_ID] } } });
    await prisma.auditLog.deleteMany({ where: { targetId: { in: [BOOKING_ID, PAYMENT_ID] } } });
    await prisma.paymentTransaction.deleteMany({ where: { paymentId: PAYMENT_ID } });
    await prisma.payment.deleteMany({ where: { id: PAYMENT_ID } });
    await prisma.booking.deleteMany({ where: { id: BOOKING_ID } });
  }
  const cancel = () => cancelBooking(BOOKING_ID, MEMBER_ID, "MEMBER", "127.0.0.1", CLUB_FORMAT_TEST, "credit");
  const events = () => prisma.bookingEvent.findMany({ where: { bookingId: BOOKING_ID, type: "CREDITED" } });
  async function assertRolledBack() {
    expect(await events()).toEqual([]);
    expect(await prisma.memberCredit.count({ where: { sourceBookingId: BOOKING_ID } })).toBe(0);
    expect(await prisma.bookingLedgerLine.count({ where: { bookingId: BOOKING_ID } })).toBe(0);
    expect(await prisma.booking.findUniqueOrThrow({ where: { id: BOOKING_ID } })).toMatchObject({ status: "PAID" });
    expect(await prisma.payment.findUniqueOrThrow({ where: { id: PAYMENT_ID } })).toMatchObject({ refundedAmountCents: 0 });
    expect(await prisma.xeroSyncOperation.count({ where: { localId: { in: [BOOKING_ID, PAYMENT_ID] } } })).toBe(0);
  }
  async function assertCommitted() {
    const credits = await prisma.memberCredit.findMany({ where: { sourceBookingId: BOOKING_ID, type: "CANCELLATION_REFUND" } });
    expect(credits).toHaveLength(1);
    expect(credits[0].amountCents).toBe(10000);
    expect(await events()).toEqual([expect.objectContaining({ amountCents: credits[0].amountCents, reason: "Cancellation refund held as account credit." })]);
  }
  beforeAll(async () => {
    assertSafeRaceDbUrl(process.env.CONCURRENCY_RACE_DATABASE_URL ?? "");
    process.env.DATABASE_URL = process.env.CONCURRENCY_RACE_DATABASE_URL;
    ({ prisma } = await import("@/lib/prisma"));
    ({ cancelBooking } = await import("@/lib/booking-cancel"));
    await clean();
    await prisma.member.create({ data: { id: MEMBER_ID, email: "race-4913@example.invalid", passwordHash: "not-real", firstName: "Credit", lastName: "Proof", ageTier: "ADULT" } });
    await prisma.lodge.create({ data: { id: LODGE_ID, name: "Credit proof", slug: "race-4913" } });
    await prisma.cancellationPolicy.create({ data: { lodgeId: LODGE_ID, daysBeforeStay: 0, refundPercentage: 50, fixedFeeCents: 0 } });
  }, 120000);
  beforeEach(async () => {
    await clean();
    await prisma.booking.create({ data: { id: BOOKING_ID, memberId: MEMBER_ID, lodgeId: LODGE_ID,
      checkIn: new Date("2026-08-01T00:00:00Z"), checkOut: new Date("2026-08-02T00:00:00Z"),
      status: "PAID", totalPriceCents: 20000, finalPriceCents: 20000 } });
    await prisma.payment.create({ data: { id: PAYMENT_ID, bookingId: BOOKING_ID, amountCents: 20000, source: "INTERNET_BANKING", status: "SUCCEEDED" } });
    await prisma.paymentTransaction.create({ data: { paymentId: PAYMENT_ID, kind: "PRIMARY", source: "INTERNET_BANKING", status: "SUCCEEDED", amountCents: 20000 } });
  });
  afterAll(async () => {
    if (!prisma) return;
    await clean();
    await prisma.cancellationPolicy.deleteMany({ where: { lodgeId: LODGE_ID } });
    await prisma.lodge.deleteMany({ where: { id: LODGE_ID } });
    await prisma.member.deleteMany({ where: { id: MEMBER_ID } });
  });
  it("commits exactly one event for the credit's amount", async () => {
    expect((await cancel()).status).toBe(200);
    await assertCommitted();
  });
  it.each(["hosting", "ledger", "cancelled-event"])("%s failure rolls back the credit and its event; retry records one", async (site) => {
    const failure = new Error(`4913: ${site} refused`);
    const spy = site === "hosting"
      ? vi.spyOn(await import("@/lib/adult-member-hosting-review"), "reconcileAdultMemberHostingReviewWithSiblings")
      : site === "ledger"
        ? vi.spyOn(await import("@/lib/booking-ledger-cancellation-sync"), "postCancellationLedgerLines")
        : vi.spyOn(await import("@/lib/paid-cancellation-event"), "writePaidCancellationEvent");
    spy.mockRejectedValueOnce(failure);
    try {
      await expect(cancel()).rejects.toBe(failure);
      await assertRolledBack();
    } finally { spy.mockRestore(); }
    expect((await cancel()).status).toBe(200);
    await assertCommitted();
  });
  it("a refused CREDITED insert aborts the claim just like a refused CANCELLED insert", async () => {
    await prisma.$executeRawUnsafe(`CREATE FUNCTION race_4913_refuse_event() RETURNS trigger AS $$ BEGIN RAISE EXCEPTION '4913: event refused'; END $$ LANGUAGE plpgsql`);
    await prisma.$executeRawUnsafe(`CREATE TRIGGER race_4913_refuse_event BEFORE INSERT ON "BookingEvent" FOR EACH ROW WHEN (NEW."bookingId" = 'race-4913-booking' AND NEW."type"::text = 'CREDITED') EXECUTE FUNCTION race_4913_refuse_event()`);
    try {
      await expect(cancel()).rejects.toThrow();
      await assertRolledBack();
    } finally {
      await prisma.$executeRawUnsafe(`DROP TRIGGER IF EXISTS race_4913_refuse_event ON "BookingEvent"`);
      await prisma.$executeRawUnsafe(`DROP FUNCTION IF EXISTS race_4913_refuse_event()`);
    }
    expect((await cancel()).status).toBe(200);
    await assertCommitted();
  });
});
