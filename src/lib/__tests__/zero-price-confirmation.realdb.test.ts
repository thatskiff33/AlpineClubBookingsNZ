/**
 * #4738 against real PostgreSQL: a stay whose nights are priced and whose
 * promotion brings the total to $0, confirmed from a saved draft, is posted
 * as a confirmation like the same stay created in one step (#4660): its night
 * lines, the promotion line that cancels them, and the journal's R01, once.
 *
 * The door is the real `POST /api/bookings/[id]/confirm-draft`. A second
 * confirm is refused (the booking is no longer a draft) and a replay of the
 * confirmation sync under the door's locks posts nothing: the confirmation's
 * own fence. The judge is the database's deferred checks at the commit and
 * the census's `JOURNAL` comparison.
 *
 * Ordinary Vitest runs skip the file; CI's real-PostgreSQL job runs it against
 * the guarded loopback race database. It cleans its own namespaced rows.
 */
import type { PrismaClient } from "@prisma/client";
import { NextRequest } from "next/server";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { raceSession } from "@/lib/__tests__/support/race-session-double";
import { cleanHistories, createHistoryBooking, historyNames, seedHistoryFixtures } from "./support/booking-ledger-history";
import { memberMoneyTestContext } from "./support/member-money-fixtures";
import { assertSafeRaceDbUrl } from "./support/race-db-url";

/** The one shared doubles: the LAST file to register a factory wins, so every realdb file registers these same ones. */
vi.mock("@/lib/stripe", async (importOriginal) =>
  (await import("./support/stripe-race-double")).stripeRaceDouble(await importOriginal()),
);
vi.mock("@/lib/auth", async () => (await import("./support/race-session-double")).raceAuthDouble());

const RUN = process.env.RUN_CONCURRENCY_RACE_TESTS === "1";
const RACE_DB_URL = process.env.CONCURRENCY_RACE_DATABASE_URL ?? "";

const PREFIX = "race-4738-";
const names = historyNames(PREFIX);
const JOURNAL = memberMoneyTestContext();
/** Two guests, two nights each, at 50.00: what `createHistoryBooking` makes. */
const NIGHTS_CENTS = 20_000;

let prisma: PrismaClient;
let census: typeof import("@/lib/booking-ledger-projection-census-store");
let confirmation: typeof import("@/lib/booking-ledger-confirmation-sync");
let lodgeLock: typeof import("@/lib/lodge-capacity-lock");
let confirmDraftRoute: typeof import("@/app/api/bookings/[id]/confirm-draft/route");

/** The journal events a booking posted, oldest first. */
async function events(bookingId: string) {
  return prisma.memberMoneyEvent.findMany({
    where: { sourceKind: "BOOKING", sourceIdentity: bookingId },
    orderBy: [{ recordedAt: "asc" }, { eventKey: "asc" }],
    select: { eventKey: true, kind: true },
  });
}

async function confirmationLines(bookingId: string) {
  return prisma.bookingLedgerLine.findMany({
    where: { bookingId, anchorKind: "CONFIRMATION" },
    select: { kind: true, amountCents: true },
    orderBy: [{ kind: "asc" }, { amountCents: "asc" }],
  });
}

/** The census's JOURNAL identity agrees with the booking's $0 price, and no line is left unbridged. */
async function expectJournalAgrees(bookingId: string): Promise<void> {
  const row = await census.readBookingLedgerCensusRow(prisma, bookingId);
  const evaluation = census.evaluateWithJournal(row!);
  const identity = evaluation.identities.find((candidate) => candidate.identity === "JOURNAL");
  expect(identity, `${bookingId}: ${JSON.stringify(evaluation.identities)}`).toMatchObject({ status: "AGREE", columnCents: 0, ledgerCents: 0 });
  expect(evaluation.integrity.filter((finding) => finding.kind === "UNBRIDGED_CHARGE_LINE" || finding.kind === "CONFIRMED_WITHOUT_R01")).toEqual([]);
}

/** A retry of the confirmation sync, under the locks the door holds: it must post nothing. */
async function confirmAgain(bookingId: string): Promise<void> {
  await prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(1)`;
    await lodgeLock.acquireLodgeCapacityLock(tx, names.lodgeId);
    await confirmation.postStoredBookingConfirmationLedgerLines(tx, bookingId, JOURNAL);
  });
}

async function confirmDraft(bookingId: string): Promise<number> {
  raceSession.current = { user: { id: names.memberId, role: "MEMBER", accessRoles: [], canLogin: true } };
  try {
    const response = await confirmDraftRoute.POST(
      new NextRequest(`http://localhost/api/bookings/${bookingId}/confirm-draft`, { method: "POST" }),
      { params: Promise.resolve({ id: bookingId }) },
    );
    return response.status;
  } finally {
    raceSession.current = null;
  }
}

(RUN ? describe : describe.skip)("zero-price doors post their confirmation — real PostgreSQL (#4738)", { timeout: 180_000 }, () => {
  beforeAll(async () => {
    assertSafeRaceDbUrl(RACE_DB_URL, "Zero-price confirmation");
    process.env.DATABASE_URL = RACE_DB_URL;
    ({ prisma } = await import("@/lib/prisma"));
    census = await import("@/lib/booking-ledger-projection-census-store");
    confirmation = await import("@/lib/booking-ledger-confirmation-sync");
    lodgeLock = await import("@/lib/lodge-capacity-lock");
    confirmDraftRoute = await import("@/app/api/bookings/[id]/confirm-draft/route");
    await cleanup();
    await seedHistoryFixtures(prisma, PREFIX);
    await prisma.member.update({ where: { id: names.memberId }, data: { canLogin: true } });
    await prisma.lodgeSettings.create({ data: { id: names.lodgeId, lodgeId: names.lodgeId, capacity: 10 } });
  }, 120_000);

  async function cleanup() {
    await prisma.lodgeSettings.deleteMany({ where: { lodgeId: names.lodgeId } });
    await cleanHistories(prisma, PREFIX);
  }

  afterAll(async () => {
    if (!prisma) return;
    await cleanup();
  }, 120_000);

  it("a draft whose promotion takes its priced nights to $0, confirmed, posts its lines and one R01; a replay posts nothing", async () => {
    const id = `${PREFIX}draft`;
    await createHistoryBooking(prisma, names, id, { payment: null });
    await prisma.booking.update({
      where: { id },
      data: {
        status: "DRAFT",
        draftExpiresAt: new Date("2026-07-08T00:00:00.000Z"),
        promoAdjustmentCents: -NIGHTS_CENTS,
        discountCents: NIGHTS_CENTS,
        finalPriceCents: 0,
        capacityOverriddenAt: null,
        capacityOverriddenByMemberId: null,
      },
    });
    expect(await events(id)).toEqual([]);

    expect(await confirmDraft(id)).toBe(200);
    expect(await prisma.booking.findUniqueOrThrow({ where: { id }, select: { status: true } })).toEqual({ status: "PAID" });
    const lines = await confirmationLines(id);
    // Four priced nights and the promotion that cancels them: the same lines a one-step create posts.
    expect(lines.filter((line) => line.amountCents > 0)).toHaveLength(4);
    expect(lines.reduce((sum, line) => sum + line.amountCents, 0)).toBe(0);
    expect(lines.some((line) => line.amountCents === -NIGHTS_CENTS)).toBe(true);
    const posted = await events(id);
    expect(posted.map((event) => event.eventKey)).toEqual([`booking-charge:${id}`]);

    // A confirmed draft is no longer a draft: the door refuses before any write.
    expect(await confirmDraft(id)).toBe(400);
    await confirmAgain(id);
    expect(await confirmationLines(id)).toEqual(lines);
    expect(await events(id)).toEqual(posted);
    await expectJournalAgrees(id);
  });
});
