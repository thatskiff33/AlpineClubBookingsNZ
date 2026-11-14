/**
 * Real-PostgreSQL proof of the paid-booking import engine (#5005 child A;
 * `INV-PAY-155`, `INV-CAP-040`), through the real planner, the real writer and
 * the real settlement body — never a faked settle or a hand-inserted row.
 *
 *  1. Happy path: a mixed party is one PAID booking at the imported price, with
 *     EVEN_SPLIT nights, a manual payment naming the batch and Booking Ref, a
 *     beyond-family member guest written as an officer assignment, and the
 *     booking ledger and journal agreeing (both census identities clean).
 *  2. A free stay imports through the zero-price confirmation path.
 *  3. Side effects: no email, no Xero operation, no recovery row, no override.
 *  4. Idempotency: the same file twice, and two concurrent confirms, write each
 *     booking once; a Booking Ref imported once cannot be imported again.
 *  5. Capacity: a booking that does not fit after the earlier rows, an
 *     exclusive whole-lodge hold, and two files racing for the last beds.
 *  6. Person-night: against an existing booking and within one file.
 *  7. Rule-breaking rows (hosting, children with no adult) and a part-paid row
 *     are refused, write nothing, and appear in the refused totals.
 *  8. A stale digest writes nothing.
 *  9. Cancel then "Mark paid back" leaves both records agreeing.
 * 10. An upward and a downward officer edit work as on a cash booking, send
 *     Xero nothing for a booking with no invoice, and leave the records agreeing.
 * 11. A member merge moves an imported booking to the surviving member.
 *
 * Ordinary Vitest runs skip the file; CI's real-PostgreSQL job runs it against
 * the guarded loopback race database. It cleans its own `race-5005-` rows.
 */
import type { Prisma, PrismaClient } from "@prisma/client";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { declareEnvironmentRoleForSuite, type SuiteEnvironmentRoleDeclaration } from "./helpers/environment-role";
import { resetStripeRaceHooks, stripeRaceHooks } from "./support/stripe-race-double";
import { releaseBookingJournalForTeardown } from "./support/booking-financial-history-teardown";
import { CLUB_FORMAT_TEST } from "./support/club-format-fixture";
import { arrivingWhilePaused, pauseIn, previewMerge } from "./support/member-merge-race";
import { assertSafeRaceDbUrl } from "./support/race-db-url";

vi.mock("@/lib/stripe", async (importOriginal) =>
  (await import("./support/stripe-race-double")).stripeRaceDouble(await importOriginal()),
);

const RUN = process.env.RUN_CONCURRENCY_RACE_TESTS === "1";
const RACE_DB_URL = process.env.CONCURRENCY_RACE_DATABASE_URL ?? "";

const PREFIX = "race-5005-";
const LODGE = `${PREFIX}lodge`;
const LODGE_SLUG = "race-5005";
const OFFICER = `${PREFIX}officer`;
const OWNER = `${PREFIX}owner`;
const FRIEND = `${PREFIX}friend`;
const OTHER = `${PREFIX}other`;
const LOSER = `${PREFIX}loser`;
const POLICY = `${PREFIX}hosting`;
const SEASON = `${PREFIX}season`;
/** The season's non-member rate, which an edit prices an added guest at. */
const RATE = 5_000;
const CAPACITY = 4;
/** The frozen test day (`TESTING.md`): stays after it are in the future. */
const TODAY = new Date("2026-07-01T00:00:00.000Z");
const FORMAT = { locale: CLUB_FORMAT_TEST.locale };

const PEOPLE = {
  owner: { id: OWNER, email: "owner@race-5005.invalid", first: "Ann", last: "Owner" },
  friend: { id: FRIEND, email: "friend@race-5005.invalid", first: "Bea", last: "Friend" },
  other: { id: OTHER, email: "other@race-5005.invalid", first: "Cal", last: "Other" },
} as const;
type Person = (typeof PEOPLE)[keyof typeof PEOPLE];

const HEADER =
  "Booking Ref,Lodge,Owner Email,Owner First Name,Owner Last Name,Guest Type,Guest Email,Guest First Name,Guest Last Name,Age Group,Check In,Check Out,Amount Paid";

type Line = {
  ref: string;
  owner?: Person;
  member?: Person;
  nonMember?: { first: string; age: string };
  checkIn?: string;
  checkOut?: string;
  amount?: string;
  extra?: string[];
};

function line({ ref, owner = PEOPLE.owner, member, nonMember, checkIn = "2026-08-10", checkOut = "2026-08-12", amount = "", extra = [] }: Line) {
  const guest = member
    ? ["Member", member.email, member.first, member.last, ""]
    : ["Non-member", "", nonMember?.first ?? "Guest", "Visitor", nonMember?.age ?? "Adult"];
  return [ref, LODGE_SLUG, owner.email, owner.first, owner.last, ...guest, checkIn, checkOut, amount, ...extra].join(",");
}

let prisma: PrismaClient;
let parse: typeof import("@/lib/booking-import/parse");
let planner: typeof import("@/lib/booking-import/plan");
let writer: typeof import("@/lib/booking-import/write");
let census: typeof import("@/lib/booking-ledger-projection-census-store");
let editService: typeof import("@/lib/booking-batch-modification-service");
const stripeCall = vi.fn(async () => { throw new Error("An import must never call Stripe"); });
let environmentRole: SuiteEnvironmentRoleDeclaration;
let restoreXeroQueue: (() => void) | undefined;
/** The edit's after-commit Xero work, awaited so "sent nothing" is read after it ran. */
const pendingXeroWork: Promise<unknown>[] = [];

function parsed(lines: string[], header = HEADER) {
  const result = parse.parseBookingImportCsv([header, ...lines].join("\n"));
  if (!result.ok) throw new Error(result.error);
  return result.bookings;
}

async function plan(lines: string[], header?: string) {
  const bookings = parsed(lines, header);
  return { bookings, plan: await planner.planBookingImport(prisma, { lodgeId: LODGE, bookings, today: TODAY, format: FORMAT }) };
}

/** Plan, then confirm with the digest the preview showed, as the route will. */
async function importFile(lines: string[], header?: string) {
  const { bookings, plan: preview } = await plan(lines, header);
  const result = await writer.confirmBookingImport({ lodgeId: LODGE, bookings, digest: preview.digest, officerMemberId: OFFICER, today: TODAY, format: FORMAT });
  return { preview, result, bookings };
}

function importedId(result: Awaited<ReturnType<typeof importFile>>["result"], ref: string): string {
  if (result.outcome !== "completed") throw new Error(`confirm was ${result.outcome}`);
  const row = result.rows.find((entry) => entry.bookingRef === ref);
  if (row?.outcome !== "IMPORTED") throw new Error(`${ref} was not imported: ${JSON.stringify(row)}`);
  return row.bookingId;
}

/**
 * Both money records against the booking's columns: every identity agrees or
 * is fully explained by a named class (a by-hand refund, say), none disagrees
 * or lacks coverage, and there is no integrity finding.
 */
async function expectCensusClean(bookingId: string) {
  const row = await census.readBookingLedgerCensusRow(prisma, bookingId);
  const evaluation = census.evaluateWithJournal(row!);
  const failing = evaluation.identities.filter((identity) => identity.status === "DISAGREE" || identity.status === "COVERAGE");
  expect(failing, `${bookingId}: ${JSON.stringify(failing)}`).toEqual([]);
  expect(evaluation.integrity).toEqual([]);
  return evaluation;
}

/** Beds held per night at the lodge, through the capacity engine itself. */
async function heldBeds(checkIn: string, checkOut: string) {
  const { checkCapacityForGuestRanges } = await import("@/lib/capacity");
  const result = await checkCapacityForGuestRanges(LODGE, new Date(`${checkIn}T00:00:00.000Z`), new Date(`${checkOut}T00:00:00.000Z`), [], undefined, prisma);
  return result.nightDetails.map((night) => night.occupiedBeds);
}

async function lodgeBookingIds(): Promise<string[]> {
  return (await prisma.booking.findMany({ where: { lodgeId: LODGE }, select: { id: true } })).map((row) => row.id);
}

async function clean() {
  await prisma.hutLeaderAssignment.deleteMany({ where: { lodgeId: LODGE } });
  const ids = await lodgeBookingIds();
  const batchIds = (await prisma.bookingImportBatch.findMany({ where: { lodgeId: LODGE }, select: { id: true } })).map((batch) => batch.id);
  const where = { bookingId: { in: ids } };
  const paymentIds = (await prisma.payment.findMany({ where, select: { id: true } })).map((row) => row.id);
  await prisma.bookingImportRow.deleteMany({ where: { lodgeId: LODGE } });
  await prisma.bookingImportBatch.deleteMany({ where: { lodgeId: LODGE } });
  await releaseBookingJournalForTeardown(prisma, ids);
  await prisma.bookingLedgerLine.deleteMany({ where: { ...where, reversesLineId: { not: null } } });
  await prisma.bookingLedgerLine.deleteMany({ where });
  await prisma.xeroSyncOperation.deleteMany({ where: { localId: { in: [...ids, ...paymentIds] } } });
  await prisma.bedAllocation.deleteMany({ where });
  await prisma.xeroSyncOperation.deleteMany({ where: { localModel: "BookingModification", localId: { in: (await prisma.bookingModification.findMany({ where, select: { id: true } })).map((row) => row.id) } } });
  await prisma.memberCredit.deleteMany({ where: { memberId: { in: [OWNER, FRIEND, OTHER, OFFICER, LOSER] } } });
  await prisma.manualRefundTask.deleteMany({ where });
  await prisma.refundRequest.deleteMany({ where });
  await prisma.paymentRecoveryOperation.deleteMany({ where });
  await prisma.bookingEvent.deleteMany({ where });
  await prisma.emailLog.deleteMany({ where: { OR: [where, { to: { in: Object.values(PEOPLE).map((person) => person.email) } }] } });
  await prisma.auditLog.deleteMany({ where: { targetId: { in: [...ids, ...batchIds] } } });
  await prisma.bookingModification.deleteMany({ where });
  await prisma.paymentRefund.deleteMany({ where: { paymentId: { in: paymentIds } } });
  await prisma.paymentTransaction.deleteMany({ where: { paymentId: { in: paymentIds } } });
  await prisma.payment.deleteMany({ where });
  await prisma.bookingGuest.deleteMany({ where });
  await prisma.booking.deleteMany({ where: { id: { in: ids } } });
}

/** A paid booking the app already holds, made by the importer itself on another Booking Ref. */
async function existingBooking(ref: string, guests: Line[]) {
  return importedId((await importFile(guests.map((guest) => line({ ...guest, ref })))).result, ref);
}

(RUN ? describe : describe.skip)("the paid-booking import engine (#5005 child A)", () => {
  beforeAll(async () => {
    assertSafeRaceDbUrl(RACE_DB_URL, "Booking import");
    environmentRole = declareEnvironmentRoleForSuite("non-production");
    process.env.DATABASE_URL = RACE_DB_URL;
    ({ prisma } = await import("@/lib/prisma"));
    parse = await import("@/lib/booking-import/parse");
    planner = await import("@/lib/booking-import/plan");
    writer = await import("@/lib/booking-import/write");
    census = await import("@/lib/booking-ledger-projection-census-store");
    editService = await import("@/lib/booking-batch-modification-service");
    const xeroQueue = await import("@/lib/xero-booking-edit-settlement");
    const queue = xeroQueue.queueXeroBookingEditSettlement;
    const spy = vi.spyOn(xeroQueue, "queueXeroBookingEditSettlement").mockImplementation((input) => {
      const pending = queue(input);
      pendingXeroWork.push(pending);
      return pending;
    });
    restoreXeroQueue = () => spy.mockRestore();

    await clean();
    await prisma.membershipTypeSeasonRate.deleteMany({ where: { seasonId: SEASON } });
    await prisma.season.deleteMany({ where: { id: SEASON } });
    await prisma.adultMemberHostingPolicy.deleteMany({ where: { id: POLICY } });
    await prisma.lodgeSettings.deleteMany({ where: { lodgeId: LODGE } });
    await prisma.cancellationPolicy.deleteMany({ where: { lodgeId: LODGE } });
    await prisma.lodge.deleteMany({ where: { id: LODGE } });
    await prisma.memberAccessRole.deleteMany({ where: { memberId: OFFICER } });
    await prisma.member.deleteMany({ where: { id: { in: [OFFICER, OWNER, FRIEND, OTHER, LOSER] } } });

    await prisma.member.create({
      data: { id: OFFICER, email: "officer@race-5005.invalid", passwordHash: "not-a-real-password", firstName: "Oli", lastName: "Officer", ageTier: "ADULT", role: "ADMIN", canLogin: true },
    });
    // A Full Admin, as a member merge requires.
    await prisma.memberAccessRole.create({ data: { memberId: OFFICER, role: "ADMIN" } });
    for (const person of Object.values(PEOPLE)) {
      await prisma.member.create({
        data: { id: person.id, email: person.email, passwordHash: "not-a-real-password", firstName: person.first, lastName: person.last, ageTier: "ADULT" },
      });
    }
    await prisma.lodge.create({ data: { id: LODGE, name: "Import 5005 Lodge", slug: LODGE_SLUG } });
    await prisma.lodgeSettings.create({ data: { id: LODGE, lodgeId: LODGE, capacity: CAPACITY } });
    await prisma.cancellationPolicy.create({ data: { lodgeId: LODGE, daysBeforeStay: 0, refundPercentage: 50, fixedFeeCents: 0 } });
    const nonMember = await prisma.membershipType.findUniqueOrThrow({ where: { key: "NON_MEMBER" } });
    await prisma.season.create({
      data: {
        id: SEASON,
        name: "Import 5005 season",
        type: "WINTER",
        startDate: new Date("2026-06-01T00:00:00.000Z"),
        endDate: new Date("2026-09-30T00:00:00.000Z"),
        active: true,
        lodgeId: LODGE,
        membershipTypeRates: {
          create: [
            { membershipTypeId: nonMember.id, ageTier: "ADULT", pricePerNightCents: RATE },
            { membershipTypeId: nonMember.id, ageTier: null, pricePerNightCents: RATE },
          ],
        },
      },
    });
  }, 120_000);

  beforeEach(async () => {
    await clean();
    await prisma.membershipTypeSeasonRate.updateMany({ where: { seasonId: SEASON, membershipType: { key: "NON_MEMBER" } }, data: { pricePerNightCents: RATE } });
    stripeCall.mockClear();
    stripeRaceHooks.create = stripeCall;
    stripeRaceHooks.refund = stripeCall;
    stripeRaceHooks.customer = stripeCall;
    stripeRaceHooks.charge = stripeCall;
    await prisma.adultMemberHostingPolicy.deleteMany({ where: { id: POLICY } });
  }, 120_000);

  afterAll(async () => {
    resetStripeRaceHooks();
    environmentRole?.restore();
    restoreXeroQueue?.();
    if (!prisma) return;
    await clean();
    await prisma.membershipTypeSeasonRate.deleteMany({ where: { seasonId: SEASON } });
    await prisma.season.deleteMany({ where: { id: SEASON } });
    await prisma.adultMemberHostingPolicy.deleteMany({ where: { id: POLICY } });
    await prisma.lodgeSettings.deleteMany({ where: { lodgeId: LODGE } });
    await prisma.cancellationPolicy.deleteMany({ where: { lodgeId: LODGE } });
    await prisma.lodge.deleteMany({ where: { id: LODGE } });
    await prisma.memberAccessRole.deleteMany({ where: { memberId: OFFICER } });
    await prisma.member.deleteMany({ where: { id: { in: [OFFICER, OWNER, FRIEND, OTHER, LOSER] } } });
  }, 120_000);

  it("imports a mixed party as one PAID booking at the imported price, both records agreeing", async () => {
    const { preview, result } = await importFile([
      line({ ref: "B1", member: PEOPLE.owner, amount: "300.00" }),
      line({ ref: "B1", member: PEOPLE.friend }),
      line({ ref: "B1", nonMember: { first: "Vic", age: "Adult" } }),
    ]);
    expect(preview.rows).toMatchObject([{ bookingRef: "B1", outcome: "IMPORT", refusals: [], amountCents: 30_000, guestCount: 3, guestNightCount: 6 }]);
    expect(preview.importTotals).toEqual({ bookings: 1, guests: 3, guestNights: 6, amountCents: 30_000 });
    expect(preview.nights).toEqual([
      { night: "2026-08-10", capacity: CAPACITY, heldBeds: 0, projectedBeds: 3, importBeds: 3, refusedBeds: 0, wholeLodgeHeld: false },
      { night: "2026-08-11", capacity: CAPACITY, heldBeds: 0, projectedBeds: 3, importBeds: 3, refusedBeds: 0, wholeLodgeHeld: false },
    ]);
    const bookingId = importedId(result, "B1");

    const booking = await prisma.booking.findUniqueOrThrow({
      where: { id: bookingId },
      include: { guests: { include: { nights: true }, orderBy: { firstName: "asc" } }, payment: true },
    });
    expect(booking).toMatchObject({ status: "PAID", memberId: OWNER, totalPriceCents: 30_000, finalPriceCents: 30_000, hasNonMembers: true, capacityOverriddenAt: null, createdById: OFFICER });
    expect(booking.guests.map((guest) => guest.priceCents).reduce((a, b) => a + b, 0)).toBe(30_000);
    for (const guest of booking.guests) {
      expect(guest.nights).toHaveLength(2);
      expect(guest.nights.every((night) => night.priceSource === "EVEN_SPLIT")).toBe(true);
      expect(guest.nights.reduce((sum, night) => sum + (night.priceCents ?? 0), 0)).toBe(guest.priceCents);
    }
    // INV-GUEST-005 / -011: the friend is outside the owner's family, so an officer assignment.
    const friend = booking.guests.find((guest) => guest.memberId === FRIEND)!;
    expect(friend).toMatchObject({ consentStatus: "CONFIRMED", consentRespondedByMemberId: OFFICER, consentRequestedAt: null });
    expect(booking.guests.find((guest) => guest.memberId === OWNER)!.consentStatus).toBeNull();

    expect(booking.payment).toMatchObject({ status: "SUCCEEDED", amountCents: 30_000, manuallyMarkedPaidByMemberId: OFFICER, stripePaymentIntentId: null });
    expect(booking.payment!.manuallyMarkedPaidAt).not.toBeNull();
    const batch = await prisma.bookingImportBatch.findFirstOrThrow({ where: { lodgeId: LODGE } });
    expect(booking.payment!.manualPaymentNote ?? "").toContain(`batch ${batch.id}, Booking Ref B1`);
    expect(batch).toMatchObject({ status: "COMPLETED", digest: preview.digest, confirmedByMemberId: OFFICER, bookingCount: 1, guestCount: 3, guestNightCount: 6, amountCents: 30_000 });
    expect(await prisma.bookingImportRow.findMany({ where: { batchId: batch.id }, select: { status: true, bookingId: true } })).toEqual([{ status: "IMPORTED", bookingId }]);

    const cash = await prisma.bookingLedgerLine.findMany({ where: { bookingId, side: "SETTLEMENT" }, select: { kind: true, amountCents: true } });
    expect(cash).toEqual([{ kind: "CASH_RECORDED", amountCents: 30_000 }]);
    expect(await prisma.memberMoneyLine.count({ where: { bookingId } })).toBeGreaterThan(0);
    const evaluation = await expectCensusClean(bookingId);
    expect(evaluation.identities.filter((identity) => identity.status === "CLASSIFIED")).toEqual([]);
    expect(evaluation.identities.find((identity) => identity.identity === "PRICE")).toMatchObject({ status: "AGREE", columnCents: 30_000 });
    expect(await heldBeds("2026-08-10", "2026-08-12")).toEqual([3, 3]);

    // No email, no Xero operation, no recovery row, no Stripe call.
    expect(stripeCall).not.toHaveBeenCalled();
    expect(await prisma.emailLog.count({ where: { OR: [{ bookingId }, { to: { in: [PEOPLE.owner.email, PEOPLE.friend.email] } }] } })).toBe(0);
    const paymentIds = [booking.payment!.id];
    expect(await prisma.xeroSyncOperation.count({ where: { localId: { in: [bookingId, ...paymentIds] } } })).toBe(0);
    expect(await prisma.paymentRecoveryOperation.count({ where: { bookingId } })).toBe(0);
    expect(await prisma.paymentTransaction.count({ where: { paymentId: { in: paymentIds }, stripePaymentIntentId: { not: null } } })).toBe(0);
    expect(await prisma.bookingEvent.findMany({ where: { bookingId }, select: { type: true }, orderBy: { createdAt: "asc" } })).toEqual([{ type: "CREATED" }, { type: "MEMBER_PAID" }]);
  }, 120_000);

  it("sends nothing with Xero connected and the integration enabled", async () => {
    const moduleBefore = await prisma.clubModuleSettings.findUnique({ where: { id: "default" } });
    const connectionBefore = await prisma.xeroConnection.findUnique({ where: { id: "default" } });
    await prisma.clubModuleSettings.upsert({ where: { id: "default" }, create: { id: "default", xeroIntegration: true }, update: { xeroIntegration: true } });
    await prisma.xeroConnection.upsert({ where: { id: "default" }, create: { id: "default", tenantId: "race-5005-fake-tenant", expiresAt: new Date("2027-01-01T00:00:00.000Z") }, update: { tenantId: "race-5005-fake-tenant", expiresAt: new Date("2027-01-01T00:00:00.000Z") } });
    try {
      const bookingId = importedId((await importFile([line({ ref: "XERO", member: PEOPLE.owner, amount: "80" })])).result, "XERO");
      const payment = await prisma.payment.findUniqueOrThrow({ where: { bookingId } });
      expect(stripeCall).not.toHaveBeenCalled();
      expect(await prisma.emailLog.count({ where: { bookingId } })).toBe(0);
      expect(await prisma.xeroSyncOperation.count({ where: { localId: { in: [bookingId, payment.id] } } })).toBe(0);
      expect(await prisma.paymentRecoveryOperation.count({ where: { bookingId } })).toBe(0);
      const { enqueueXeroBookingInvoiceOperation } = await import("@/lib/xero-operation-outbox");
      await enqueueXeroBookingInvoiceOperation(bookingId, { invoiceEmailDelivery: null });
      expect(await prisma.xeroSyncOperation.count({ where: { localId: bookingId } })).toBe(0);
      const freeId = importedId((await importFile([line({ ref: "XERO-FREE", member: PEOPLE.friend, owner: PEOPLE.friend, amount: "0", checkIn: "2026-09-01", checkOut: "2026-09-02" })])).result, "XERO-FREE");
      await enqueueXeroBookingInvoiceOperation(freeId, { invoiceEmailDelivery: null });
      const { createXeroInvoiceForBooking } = await import("@/lib/xero-booking-invoices");
      expect(await createXeroInvoiceForBooking(freeId)).toBeNull();
      expect(await prisma.xeroSyncOperation.count({ where: { localId: freeId } })).toBe(0);
      await expectCensusClean(bookingId);
    } finally {
      if (moduleBefore) await prisma.clubModuleSettings.update({ where: { id: "default" }, data: { xeroIntegration: moduleBefore.xeroIntegration } });
      else await prisma.clubModuleSettings.delete({ where: { id: "default" } });
      if (connectionBefore) await prisma.xeroConnection.update({ where: { id: "default" }, data: connectionBefore });
      else await prisma.xeroConnection.delete({ where: { id: "default" } });
    }
  }, 120_000);

  it("imports a free stay through the zero-price confirmation path", async () => {
    const { result } = await importFile([line({ ref: "F1", member: PEOPLE.owner, amount: "0.00" })]);
    const bookingId = importedId(result, "F1");
    const booking = await prisma.booking.findUniqueOrThrow({ where: { id: bookingId }, include: { payment: true } });
    expect(booking).toMatchObject({ status: "PAID", totalPriceCents: 0 });
    expect(booking.payment).toMatchObject({ status: "SUCCEEDED", amountCents: 0, manuallyMarkedPaidAt: null });
    expect(await prisma.bookingLedgerLine.count({ where: { bookingId, side: "SETTLEMENT" } })).toBe(0);
    await expectCensusClean(bookingId);
    expect(await heldBeds("2026-08-10", "2026-08-12")).toEqual([1, 1]);
  }, 120_000);

  it("writes each booking once: the same file twice, two confirms at once, and a Ref imported before", async () => {
    const lines = [line({ ref: "I1", member: PEOPLE.owner, amount: "100" }), line({ ref: "I2", owner: PEOPLE.friend, member: PEOPLE.friend, amount: "50" })];
    const { bookings, plan: preview } = await plan(lines);
    const confirm = () => writer.confirmBookingImport({ lodgeId: LODGE, bookings, digest: preview.digest, officerMemberId: OFFICER, today: TODAY, format: FORMAT });
    const [first, second] = await Promise.all([confirm(), confirm()]);
    expect(first.outcome).toBe("completed");
    expect(second.outcome).toBe("completed");
    expect(await prisma.booking.count({ where: { lodgeId: LODGE } })).toBe(2);
    expect(await prisma.bookingImportBatch.count({ where: { lodgeId: LODGE } })).toBe(1);

    // The same content again resumes the same batch; its preview is unchanged.
    const again = await planner.planBookingImport(prisma, { lodgeId: LODGE, bookings, today: TODAY, format: FORMAT, batchId: first.outcome === "completed" ? first.batchId : null });
    expect(again.digest).toBe(preview.digest);
    expect(again.rows.every((row) => row.alreadyImported)).toBe(true);
    expect((await confirm()).outcome).toBe("completed");
    expect(await prisma.booking.count({ where: { lodgeId: LODGE } })).toBe(2);

    // A different file naming an imported Booking Ref is refused for it.
    const { plan: other } = await plan([line({ ref: "I1", member: PEOPLE.other, owner: PEOPLE.other, checkIn: "2026-09-01", checkOut: "2026-09-02", amount: "10" })]);
    expect(other.rows[0]).toMatchObject({ outcome: "REFUSED", refusals: [{ code: "ALREADY_IMPORTED" }] });
  }, 120_000);

  it("refuses a booking that does not fit after the earlier rows, and names who fitted", async () => {
    const { preview, result } = await importFile([
      line({ ref: "C1", member: PEOPLE.owner, amount: "30" }),
      line({ ref: "C1", nonMember: { first: "Vic", age: "Adult" } }),
      line({ ref: "C1", nonMember: { first: "Wyn", age: "Adult" } }),
      line({ ref: "C2", owner: PEOPLE.friend, member: PEOPLE.friend, amount: "20" }),
      line({ ref: "C2", owner: PEOPLE.friend, nonMember: { first: "Xan", age: "Adult" } }),
    ]);
    expect(preview.rows.map((row) => row.outcome)).toEqual(["IMPORT", "REFUSED"]);
    expect(preview.rows[1]!.refusals).toEqual([
      expect.objectContaining({ code: "OVER_CAPACITY", message: expect.stringMatching(/would have 5 people in a 4-bed lodge$/) }),
      expect.objectContaining({ code: "OVER_CAPACITY" }),
    ]);
    expect(preview.overFullNights).toEqual([
      { night: "2026-08-10", fitted: ["C1"], refused: ["C2"] },
      { night: "2026-08-11", fitted: ["C1"], refused: ["C2"] },
    ]);
    expect(preview.refusedByCode).toEqual({ OVER_CAPACITY: { bookings: 1, guests: 2, guestNights: 4, amountCents: 2_000 } });
    expect(preview.nights[0]).toMatchObject({ importBeds: 3, refusedBeds: 2 });
    importedId(result, "C1");
    expect(await prisma.bookingImportRow.findFirst({ where: { lodgeId: LODGE, bookingRef: "C2" }, select: { status: true, refusalCode: true } })).toEqual({ status: "REFUSED", refusalCode: "OVER_CAPACITY" });
    expect(await heldBeds("2026-08-10", "2026-08-12")).toEqual([3, 3]);
  }, 120_000);

  it("counts a custodian staying as a guest once across file order and a resumed preview", async () => {
    await prisma.hutLeaderAssignment.create({ data: { memberId: OWNER, lodgeId: LODGE, isCustodian: true, startDate: new Date("2026-08-10T00:00:00.000Z"), endDate: new Date("2026-08-11T00:00:00.000Z") } });
    const { bookings, plan: preview } = await plan([
      line({ ref: "CU1", member: PEOPLE.owner, amount: "10" }),
      line({ ref: "CU2", owner: PEOPLE.friend, member: PEOPLE.friend, amount: "30" }),
      line({ ref: "CU2", owner: PEOPLE.friend, nonMember: { first: "Vic", age: "Adult" } }),
      line({ ref: "CU2", owner: PEOPLE.friend, nonMember: { first: "Wyn", age: "Adult" } }),
    ]);
    expect(preview.rows.map((row) => row.outcome)).toEqual(["IMPORT", "IMPORT"]);
    expect(preview.nights.map((night) => night.projectedBeds)).toEqual([4, 4]);
    const result = await writer.confirmBookingImport({ lodgeId: LODGE, bookings, digest: preview.digest, officerMemberId: OFFICER, today: TODAY, format: FORMAT });
    expect(result.outcome).toBe("completed");
    if (result.outcome !== "completed") return;
    expect(result.rows.map((row) => row.outcome)).toEqual(["IMPORTED", "IMPORTED"]);
    const resumed = await planner.planBookingImport(prisma, { lodgeId: LODGE, bookings, today: TODAY, format: FORMAT, batchId: result.batchId });
    expect(resumed.digest).toBe(preview.digest);
    expect(await heldBeds("2026-08-10", "2026-08-12")).toEqual([4, 4]);
  }, 120_000);

  it("refuses a night under an exclusive whole-lodge hold", async () => {
    const holdId = await existingBooking("H0", [{ ref: "H0", member: PEOPLE.other, owner: PEOPLE.other, checkIn: "2026-08-11", checkOut: "2026-08-12", amount: "10" }]);
    await prisma.booking.update({ where: { id: holdId }, data: { wholeLodgeHold: true } });
    const { plan: preview } = await plan([line({ ref: "H1", member: PEOPLE.owner, amount: "10" })]);
    expect(preview.rows[0]!.refusals).toEqual([expect.objectContaining({ code: "WHOLE_LODGE_HOLD" })]);
    expect(preview.nights.map((night) => night.wholeLodgeHeld)).toEqual([false, true]);
  }, 120_000);

  it("never overbooks when two files race for the last beds", async () => {
    await existingBooking("R0", [{ ref: "R0", member: PEOPLE.other, owner: PEOPLE.other, amount: "10" }]);
    const x = await plan([line({ ref: "X1", member: PEOPLE.owner, amount: "20" }), line({ ref: "X1", nonMember: { first: "Vic", age: "Adult" } })]);
    const y = await plan([line({ ref: "Y1", owner: PEOPLE.friend, member: PEOPLE.friend, amount: "20" }), line({ ref: "Y1", owner: PEOPLE.friend, nonMember: { first: "Xan", age: "Adult" } })]);
    expect([x.plan.rows[0]!.outcome, y.plan.rows[0]!.outcome]).toEqual(["IMPORT", "IMPORT"]);
    const results = await Promise.all([x, y].map(({ bookings, plan: preview }) =>
      writer.confirmBookingImport({ lodgeId: LODGE, bookings, digest: preview.digest, officerMemberId: OFFICER, today: TODAY, format: FORMAT })));
    const imported = results.filter((result) => result.outcome === "completed" && result.rows[0]!.outcome === "IMPORTED");
    expect(imported).toHaveLength(1);
    expect(await heldBeds("2026-08-10", "2026-08-12")).toEqual([3, 3]);
  }, 120_000);

  it.each([true, false])("races a normal member booking for the last beds (import first: %s)", async (importFirst) => {
    await existingBooking("NORMAL0", [{ ref: "NORMAL0", member: PEOPLE.friend, owner: PEOPLE.friend, amount: "10" }]);
    const fullMember = await prisma.membershipType.findUniqueOrThrow({ where: { key: "FULL" } });
    await prisma.membershipTypeSeasonRate.create({ data: { seasonId: SEASON, membershipTypeId: fullMember.id, ageTier: "ADULT", pricePerNightCents: 0 } });
    await prisma.membershipTypeSeasonRate.updateMany({ where: { seasonId: SEASON }, data: { pricePerNightCents: 0 } });
    const candidate = await plan([line({ ref: "NORMAL1", member: PEOPLE.owner, amount: "20" }), line({ ref: "NORMAL1", nonMember: { first: "Vic", age: "Adult" } })]);
    const importCandidate = () => writer.confirmBookingImport({ lodgeId: LODGE, bookings: candidate.bookings, digest: candidate.plan.digest, officerMemberId: OFFICER, today: TODAY, format: FORMAT });
    const { createConfirmedBooking } = await import("@/lib/booking-create");
    const { bookingGuestDietarySeeding } = await import("@/lib/member-dietary-booking-writes");
    const { requireCalendarDate } = await import("@/lib/club-time");
    const { resolveBookingMoneyPostingContext } = await import("@/lib/member-money/doors");
    const journal = await resolveBookingMoneyPostingContext();
    const normal = () => createConfirmedBooking({
      lodgeId: LODGE, effectiveMemberId: OTHER, sessionUserId: OTHER, isOnBehalf: false,
      checkIn: new Date("2026-08-10T00:00:00.000Z"), checkOut: new Date("2026-08-12T00:00:00.000Z"),
      guests: [
        { firstName: PEOPLE.other.first, lastName: PEOPLE.other.last, isMember: true, memberId: OTHER, ageTier: "ADULT" },
        { firstName: "Wyn", lastName: "Visitor", isMember: false, ageTier: "ADULT" },
      ],
      status: "PAYMENT_PENDING", shouldBePending: false, holdDays: 7, notifyMember: false,
      subscriptionLockoutMode: "NO_BLOCK", guestDietarySeeding: bookingGuestDietarySeeding(false),
      todayAtClub: requireCalendarDate("2026-07-01"), journal, format: CLUB_FORMAT_TEST,
    });
    const capacity = await import("@/lib/capacity");
    const acquire = capacity.acquireLodgeCapacityLock;
    const spy = vi.spyOn(capacity, "acquireLodgeCapacityLock").mockImplementation(async (tx, id) => {
      await acquire(tx, id);
      if (id === LODGE) await pauseIn("import-normal-capacity", tx);
    });
    try {
      const { held, arrived } = await arrivingWhilePaused(prisma, "import-normal-capacity", importFirst ? importCandidate : normal, importFirst ? normal : importCandidate);
      expect(held.status, JSON.stringify(held)).toBe("fulfilled");
      expect(arrived.status, JSON.stringify(arrived)).toBe("fulfilled");
      if (held.status !== "fulfilled" || arrived.status !== "fulfilled") return;
      const imported = (importFirst ? held.value : arrived.value) as Awaited<ReturnType<typeof importCandidate>>;
      const member = (importFirst ? arrived.value : held.value) as Awaited<ReturnType<typeof normal>>;
      if (importFirst) {
        expect(imported.outcome).toBe("completed");
        expect(member.type).toBe("capacityExceeded");
      } else {
        expect(member.type).toBe("created");
        expect(imported).toMatchObject({ outcome: "completed", rows: [{ outcome: "REFUSED" }] });
      }
      expect(await heldBeds("2026-08-10", "2026-08-12")).toEqual([3, 3]);
      expect(await prisma.booking.count({ where: { lodgeId: LODGE } })).toBe(2);
    } finally {
      spy.mockRestore();
      await prisma.membershipTypeSeasonRate.deleteMany({ where: { seasonId: SEASON, membershipTypeId: fullMember.id } });
    }
  }, 120_000);

  it("refuses a member already booked that night, in the app or earlier in the file", async () => {
    await existingBooking("P0", [{ ref: "P0", member: PEOPLE.owner, checkIn: "2026-08-11", checkOut: "2026-08-13", amount: "10" }]);
    const { plan: preview } = await plan([
      line({ ref: "P1", member: PEOPLE.owner, amount: "10" }),
      line({ ref: "P2", owner: PEOPLE.friend, member: PEOPLE.friend, amount: "10" }),
      line({ ref: "P3", owner: PEOPLE.friend, member: PEOPLE.friend, checkIn: "2026-08-11", checkOut: "2026-08-12", amount: "10" }),
    ]);
    expect(preview.rows.map((row) => [row.outcome, row.refusals.map((refusal) => refusal.code)])).toEqual([
      ["REFUSED", ["PERSON_NIGHT"]],
      ["IMPORT", []],
      ["REFUSED", ["PERSON_NIGHT"]],
    ]);
    expect(preview.rows[2]!.refusals[0]!.message).toMatch(/^The member on line 4 is also on Booking Ref P2 in this file on /);
    // A refusal names a line, never the person or the other booking's owner (INV-CAP-015).
    expect(preview.rows[0]!.refusals[0]!.message).not.toMatch(/Ann|Owner|race-5005/);
  }, 120_000);

  it("rechecks member eligibility after preview and continues with the other bookings", async () => {
    const candidate = await plan([
      line({ ref: "CHANGED", member: PEOPLE.owner, amount: "20" }),
      line({ ref: "UNCHANGED", owner: PEOPLE.friend, member: PEOPLE.friend, amount: "20" }),
    ]);
    expect(candidate.plan.rows.map((row) => row.outcome)).toEqual(["IMPORT", "IMPORT"]);

    const capacity = await import("@/lib/capacity");
    const acquire = capacity.acquireLodgeCapacityLock;
    let changed = false;
    const spy = vi.spyOn(capacity, "acquireLodgeCapacityLock").mockImplementation(async (tx, id) => {
      await acquire(tx, id);
      if (id === LODGE && !changed) {
        changed = true;
        // The confirm pre-check has finished. Change its member snapshot at
        // the lock boundary, before the writer's authoritative re-read.
        // The lock takes a narrow client type; the writer passes its full transaction.
        await (tx as Prisma.TransactionClient).member.update({ where: { id: OWNER }, data: { active: false } });
      }
    });
    try {
      const result = await writer.confirmBookingImport({
        lodgeId: LODGE, bookings: candidate.bookings, digest: candidate.plan.digest,
        officerMemberId: OFFICER, today: TODAY, format: FORMAT,
      });
      expect(result).toMatchObject({ outcome: "completed", rows: [
        { bookingRef: "CHANGED", outcome: "REFUSED", refusals: expect.arrayContaining([expect.objectContaining({ code: "MEMBER" })]) },
        { bookingRef: "UNCHANGED", outcome: "IMPORTED" },
      ] });
      expect(await prisma.booking.count({ where: { lodgeId: LODGE, memberId: OWNER } })).toBe(0);
      await expectCensusClean(importedId(result, "UNCHANGED"));
    } finally {
      spy.mockRestore();
    }
  }, 120_000);

  it("refuses rule-breaking and part-paid rows, writes nothing for them, and counts them by rule", async () => {
    await prisma.adultMemberHostingPolicy.create({
      data: { id: POLICY, lodgeId: LODGE, scopeKey: LODGE, mode: "ENFORCED", capacityMode: "NO_HOLD", hostScopeSameBooking: true, hostScopeSameBookingOwner: false },
    });
    const header = `${HEADER},Balance Owing,Balance Due Date`;
    const { preview, result } = await importFile([
      `${line({ ref: "N1", nonMember: { first: "Vic", age: "Adult" }, amount: "10" })},,`,
      `${line({ ref: "N2", nonMember: { first: "Kid", age: "Child" }, amount: "10" })},,`,
      `${line({ ref: "N3", member: PEOPLE.owner, amount: "10" })},40.00,2026-08-01`,
      `${line({ ref: "N4", owner: PEOPLE.friend, member: PEOPLE.friend, amount: "10" })},,`,
    ], header);
    expect(preview.rows.map((row) => [row.bookingRef, row.outcome, row.refusals.map((refusal) => refusal.code)])).toEqual([
      ["N1", "REFUSED", ["HOSTING"]],
      ["N2", "REFUSED", ["HOSTING", "SUPERVISION"]],
      ["N3", "REFUSED", ["PART_PAID"]],
      ["N4", "IMPORT", []],
    ]);
    expect(preview.rows[0]!.refusals[0]!.message).toMatch(/enter this booking through Book on Behalf$/);
    expect(preview.refusedTotals).toEqual({ bookings: 3, guests: 3, guestNights: 6, amountCents: 3_000 });
    expect(Object.keys(preview.refusedByCode).sort()).toEqual(["HOSTING", "PART_PAID"]);
    expect(preview.importTotals.bookings + preview.refusedTotals.bookings).toBe(4);
    importedId(result, "N4");
    expect(await prisma.booking.count({ where: { lodgeId: LODGE } })).toBe(1);
    expect(await prisma.bookingImportRow.count({ where: { lodgeId: LODGE, status: "REFUSED" } })).toBe(3);
  }, 120_000);

  it("keeps refused sold beds visible, and a preview writes no booking or money rows", async () => {
    const snapshot = async () => Promise.all([
      prisma.booking.count(), prisma.payment.count(), prisma.bookingImportBatch.count(),
      prisma.bookingImportRow.count(), prisma.bookingLedgerLine.count(), prisma.memberMoneyLine.count(),
      prisma.emailLog.count(), prisma.xeroSyncOperation.count(),
    ]);
    const before = await snapshot();
    const { plan: preview } = await plan([
      `${line({ ref: "D1", member: PEOPLE.owner, amount: "10" })},50,2026-08-01`,
      `${line({ ref: "D2", owner: PEOPLE.friend, member: PEOPLE.friend, amount: "20" })},,`,
    ], `${HEADER},Balance Owing,Balance Due Date`);
    expect(await snapshot()).toEqual(before);
    expect(preview.nights.map((night) => night.refusedBeds)).toEqual([1, 1]);
    expect(preview.importTotals).toMatchObject({ bookings: 1, amountCents: 2_000 });
    expect(preview.refusedTotals).toMatchObject({ bookings: 1, amountCents: 1_000 });
  }, 120_000);

  it.each(["reference", "person-night", "capacity"] as const)(
    "rechecks %s after the fresh preview and refuses without a partial booking", async (kind) => {
      const candidate = await plan([line({ ref: "L1", member: PEOPLE.owner, amount: "10" })]);
      const original = planner.planBookingImport;
      const spy = vi.spyOn(planner, "planBookingImport").mockImplementationOnce(async (...args) => {
        const preview = await original(...args);
        const samePerson = kind === "person-night";
        const ref = kind === "reference" ? "L1" : "L0";
        const opponent = samePerson ? PEOPLE.owner : PEOPLE.other;
        const lines = [line({ ref, owner: opponent, member: opponent, amount: "10" })];
        if (kind === "capacity") {
          for (const first of ["Vic", "Wyn", "Xan"]) lines.push(line({ ref, owner: opponent, nonMember: { first, age: "Adult" } }));
        }
        importedId((await importFile(lines)).result, ref);
        return preview;
      });
      try {
        const result = await writer.confirmBookingImport({ lodgeId: LODGE, bookings: candidate.bookings, digest: candidate.plan.digest, officerMemberId: OFFICER, today: TODAY, format: FORMAT });
        expect(result.outcome).toBe("completed");
        if (result.outcome !== "completed") return;
        expect(result.rows[0]).toMatchObject({ outcome: "REFUSED", refusals: expect.arrayContaining([expect.objectContaining({
          code: kind === "reference" ? "ALREADY_IMPORTED" : kind === "person-night" ? "PERSON_NIGHT" : "OVER_CAPACITY",
        })]) });
        expect(await prisma.booking.count({ where: { lodgeId: LODGE } })).toBe(1);
        expect(await heldBeds("2026-08-10", "2026-08-12")).toEqual(kind === "capacity" ? [4, 4] : [1, 1]);
      } finally { spy.mockRestore(); }
    }, 120_000,
  );

  it("refuses changed people at the same amount when given an earlier file's digest", async () => {
    const original = await plan([line({ ref: "T1", member: PEOPLE.owner, amount: "10" })]);
    const changed = parsed([line({ ref: "T1", owner: PEOPLE.friend, member: PEOPLE.friend, amount: "10" })]);
    const result = await writer.confirmBookingImport({ lodgeId: LODGE, bookings: changed, digest: original.plan.digest, officerMemberId: OFFICER, today: TODAY, format: FORMAT });
    expect(result.outcome).toBe("stale");
    expect(await lodgeBookingIds()).toEqual([]);
    expect(await prisma.bookingImportBatch.count({ where: { lodgeId: LODGE } })).toBe(0);
  }, 120_000);

  it("writes nothing when the confirmed digest is stale", async () => {
    const bookings = parsed([line({ ref: "S1", member: PEOPLE.owner, amount: "10" })]);
    const result = await writer.confirmBookingImport({ lodgeId: LODGE, bookings, digest: "not-the-preview", officerMemberId: OFFICER, today: TODAY, format: FORMAT });
    expect(result.outcome).toBe("stale");
    expect(await prisma.booking.count({ where: { lodgeId: LODGE } })).toBe(0);
    expect(await prisma.bookingImportBatch.count({ where: { lodgeId: LODGE } })).toBe(0);
  }, 120_000);

  it("cancels to a by-hand refund task, and Mark paid back leaves both records agreeing", async () => {
    const bookingId = importedId((await importFile([line({ ref: "K1", member: PEOPLE.owner, amount: "200" })])).result, "K1");
    const { cancelBooking } = await import("@/lib/booking-cancel");
    expect((await cancelBooking(bookingId, OFFICER, "ADMIN", "127.0.0.1", CLUB_FORMAT_TEST)).status).toBe(200);
    const task = await prisma.manualRefundTask.findFirstOrThrow({ where: { bookingId }, select: { id: true, status: true, amountCents: true } });
    expect(task).toMatchObject({ status: "OPEN", amountCents: 10_000 });
    expect(await prisma.xeroSyncOperation.count({ where: { localId: bookingId } })).toBe(0);
    await expectCensusClean(bookingId);

    const { resolveManualRefundTask } = await import("@/lib/manual-refund-task-resolution");
    await resolveManualRefundTask(
      { taskId: task.id, resolution: "completed", note: "Paid back by bank transfer", actingMemberId: OFFICER, confirmedAmountCents: 10_000, direction: null, recordedNightPrices: null },
      CLUB_FORMAT_TEST,
    );
    expect(await prisma.manualRefundTask.findUniqueOrThrow({ where: { id: task.id }, select: { status: true } })).toEqual({ status: "COMPLETED" });
    // The paid-back hand-back is the census's named class for a by-hand refund, as for any manual payment.
    const after = await expectCensusClean(bookingId);
    expect(after.identities.filter((identity) => identity.status === "CLASSIFIED").flatMap((identity) => identity.explainedBy.map((part) => part.name))).toEqual(["REFUND_MIRROR_HAND_BACK"]);
  }, 120_000);

  it("an upward then a downward officer edit work as on a cash booking and send Xero nothing", async () => {
    const bookingId = importedId((await importFile([
      line({ ref: "E1", member: PEOPLE.owner, amount: "120" }),
      line({ ref: "E1", nonMember: { first: "Vic", age: "Adult" } }),
    ])).result, "E1");
    const edit = async (input: Record<string, unknown>) => {
      const { clubTime } = await import("@/lib/club-time/server");
      const result = await editService.modifyBookingBatch({
        bookingId,
        actor: { id: OFFICER, role: "ADMIN" },
        input: input as never,
        ipAddress: "127.0.0.1",
        todayAtClub: (await clubTime()).today(),
        format: CLUB_FORMAT_TEST,
        waiveChangeFee: true,
      });
      while (pendingXeroWork.length > 0) await Promise.allSettled(pendingXeroWork.splice(0));
      return result;
    };
    const xeroOperations = async () => {
      const modificationIds = (await prisma.bookingModification.findMany({ where: { bookingId }, select: { id: true } })).map((row) => row.id);
      const paymentIds = (await prisma.payment.findMany({ where: { bookingId }, select: { id: true } })).map((row) => row.id);
      return prisma.xeroSyncOperation.count({ where: { localId: { in: [bookingId, ...modificationIds, ...paymentIds] } } });
    };

    // Upward: a third guest for both nights, priced at the season's rate.
    await edit({ addGuests: [{ firstName: "Late", lastName: "Friend", ageTier: "ADULT", isMember: false }] });
    expect(await prisma.booking.findUniqueOrThrow({ where: { id: bookingId }, select: { finalPriceCents: true } })).toEqual({ finalPriceCents: 12_000 + 2 * RATE });
    expect(await prisma.bookingModification.findMany({ where: { bookingId }, select: { priceDiffCents: true } })).toEqual([{ priceDiffCents: 2 * RATE }]);
    expect(await xeroOperations()).toBe(0);
    await expectCensusClean(bookingId);

    // Downward: the imported non-member leaves; their imported share comes off.
    const vic = await prisma.bookingGuest.findFirstOrThrow({ where: { bookingId, firstName: "Vic" }, select: { id: true, priceCents: true } });
    expect(vic.priceCents).toBe(6_000);
    // A cash booking's reduction goes back by hand ("card" is the refund tier, not a card).
    await edit({ removeGuestIds: [vic.id], settlementMethod: "card" });
    expect(await prisma.booking.findUniqueOrThrow({ where: { id: bookingId }, select: { finalPriceCents: true } })).toEqual({ finalPriceCents: 12_000 + 2 * RATE - 6_000 });
    expect(await prisma.manualRefundTask.findMany({ where: { bookingId }, select: { status: true, amountCents: true } })).toEqual([{ status: "OPEN", amountCents: 3_000 }]);
    expect(await xeroOperations()).toBe(0);
    await expectCensusClean(bookingId);
  }, 120_000);

  it("a member merge moves an imported booking to the surviving member, the records still agreeing", async () => {
    await prisma.member.create({
      data: { id: LOSER, email: "loser@race-5005.invalid", passwordHash: "not-a-real-password", firstName: "Lou", lastName: "Duplicate", ageTier: "ADULT" },
    });
    const loser = { id: LOSER, email: "loser@race-5005.invalid", first: "Lou", last: "Duplicate" } as unknown as Person;
    const bookingId = importedId((await importFile([line({ ref: "M1", owner: loser, member: loser, amount: "80" })])).result, "M1");
    await (await previewMerge(OTHER, LOSER, OFFICER))();

    const booking = await prisma.booking.findUniqueOrThrow({ where: { id: bookingId }, include: { guests: true, payment: true } });
    expect(booking).toMatchObject({ memberId: OTHER, status: "PAID", finalPriceCents: 8_000 });
    expect(booking.guests.map((guest) => guest.memberId)).toEqual([OTHER]);
    expect(booking.payment).toMatchObject({ status: "SUCCEEDED", amountCents: 8_000 });
    expect(await prisma.member.findUnique({ where: { id: LOSER } })).toBeNull();
    // The import row keeps pointing at the booking: it names no member.
    expect(await prisma.bookingImportRow.findFirstOrThrow({ where: { lodgeId: LODGE, bookingRef: "M1" }, select: { status: true, bookingId: true } })).toEqual({ status: "IMPORTED", bookingId });
    await expectCensusClean(bookingId);
  }, 120_000);
});
