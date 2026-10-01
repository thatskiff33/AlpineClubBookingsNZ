/**
 * Real-PostgreSQL proof of an edit's and a review closure's ledger lines
 * (#3582).
 *
 * The planner and the sync have focused unit tests, and the edit doors'
 * suites pin that each door calls the sync with its own history row and
 * sides. What a mock cannot show is the posting path against the table's real
 * constraints — the CHECKs, the unique `reversesLineId`, `ON CONFLICT DO
 * NOTHING` on the key — across two edits in two transactions. Seven claims:
 *
 *  1. Two edits in turn: the second reverses the FIRST EDIT'S re-post, never the
 *     confirmation line the first already reversed, and the booking's live
 *     charge lines come to what it now holds.
 *  2. Replaying an edit's posting posts nothing and the transaction survives to
 *     commit.
 *  3. A booking not yet confirmed on the ledger posts nothing.
 *  4. A review closure's re-price posts under its history row, from the real
 *     guest rows, and its share posts no second record of the same money.
 *  5. Two sibling reviews from one parked edit, in each direction and in the
 *     dismiss-then-complete and declined-then-re-priced orders, leave the
 *     ledger billing exactly the booking's price (design §5.3).
 *  6. The constraints themselves: a same-price re-sale followed by a second
 *     edit reverses the re-post; a second reversal of one line inserts nothing
 *     and leaves the transaction usable; a replayed change-fee-only edit posts
 *     its fee once, through `ON CONFLICT` alone.
 *  7. An admin date shift, through the real `adminShiftBookingDates`, reverses
 *     every old-date line and re-posts it at the new date, netting to zero
 *     (#3741).
 *
 * Ordinary Vitest runs skip the whole file. It reuses the guarded, disposable
 * loopback PostgreSQL `concurrency-lock-races.realdb.test.ts` provisions
 * (#1881), which imports this file so CI reaches it; it cleans its own
 * uniquely-namespaced `race-3582-` fixtures.
 */
import type { PrismaClient } from "@prisma/client";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { bookingLedgerPriceCents } from "@/lib/booking-ledger-balance";
import type { ModificationPricingSide } from "@/lib/booking-modification-lines";
import type { BookingPriceRebase } from "@/lib/booking-review-price-rebase";

const RUN = process.env.RUN_CONCURRENCY_RACE_TESTS === "1";
const RACE_DB_URL = process.env.CONCURRENCY_RACE_DATABASE_URL ?? "";

const MEMBER_ID = "race-3582-member";
const LODGE_ID = "race-3582-lodge";
const BOOKING_ID = "race-3582-booking";
const UNCONFIRMED_ID = "race-3582-unconfirmed";
const G1 = "race-3582-g1";
const G2 = "race-3582-g2";
const G3 = "race-3582-g3";
const G4 = "race-3582-g4";
const D1 = new Date("2026-08-01T00:00:00.000Z");
const D2 = new Date("2026-08-02T00:00:00.000Z");
const CHECK_OUT = new Date("2026-08-03T00:00:00.000Z");

/** Standalone fail-closed copy: importing this file must not register another suite. */
export function assertSafeModificationLedgerRaceDbUrl(url: string): void {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error("Modification-ledger proofs need a valid CONCURRENCY_RACE_DATABASE_URL.");
  }
  const port = Number.parseInt(parsed.port, 10);
  if (!Number.isFinite(port) || port === 5432 || port < 55442) {
    throw new Error(
      `Refusing to run modification-ledger proofs against port ${parsed.port || "(none)"}: use a throwaway PostgreSQL on 55442+ (never 5432).`,
    );
  }
  const host = parsed.hostname.toLowerCase();
  if (!["localhost", "127.0.0.1", "::1", "[::1]"].includes(host)) {
    throw new Error("Modification-ledger proof DB must be loopback-only.");
  }
  const databaseName = decodeURIComponent(parsed.pathname.replace(/^\//, ""));
  if (!databaseName.includes("concurrency_race_1881")) {
    throw new Error("Modification-ledger proof DB name must contain 'concurrency_race_1881'.");
  }
}

let prisma: PrismaClient;
let sync: typeof import("@/lib/booking-ledger-modification-sync");
let confirmation: typeof import("@/lib/booking-ledger-confirmation-posting");
let write: typeof import("@/lib/booking-ledger-write");

type Night = [Date, number];

function guestSide(id: string, nights: Night[]): ModificationPricingSide["guests"][number] {
  return {
    guestKey: id,
    ageTier: "ADULT",
    isMember: true,
    rateMembershipTypeId: null,
    name: `Ledger ${id}`,
    nights: nights.map(([stayDate, priceCents]) => ({ stayDate, priceCents, priceSource: "SOLD" as const })),
  };
}

async function lines(bookingId = BOOKING_ID) {
  return prisma.bookingLedgerLine.findMany({
    where: { bookingId },
    orderBy: [{ postedAt: "asc" }, { id: "asc" }],
    select: {
      id: true,
      kind: true,
      side: true,
      amountCents: true,
      postingKey: true,
      anchorKind: true,
      anchorId: true,
      reversesLineId: true,
      bookingGuestId: true,
    },
  });
}

async function liveChargeCents(): Promise<number> {
  const all = await lines();
  const reversed = new Set(all.flatMap((line) => (line.reversesLineId ? [line.reversesLineId] : [])));
  return all
    .filter((line) => line.side === "CHARGE" && line.reversesLineId === null && !reversed.has(line.id))
    .reduce((sum, line) => sum + line.amountCents, 0);
}

async function historyRow(type: string, priceDiffCents: number): Promise<string> {
  const row = await prisma.bookingModification.create({
    data: { bookingId: BOOKING_ID, memberId: MEMBER_ID, modificationType: type, previousData: {}, newData: {}, priceDiffCents, changeFeeCents: 0 },
    select: { id: true },
  });
  return row.id;
}

async function clean(): Promise<void> {
  for (const id of [BOOKING_ID, UNCONFIRMED_ID]) {
    await prisma.bookingLedgerLine.deleteMany({ where: { bookingId: id } });
    await prisma.bookingModification.deleteMany({ where: { bookingId: id } });
    await prisma.bookingGuest.deleteMany({ where: { bookingId: id } });
    // The #3741 shift case moves the booking itself; put it back.
    await prisma.booking.updateMany({ where: { id }, data: { checkIn: D1, checkOut: CHECK_OUT } });
  }
}

async function seedGuests(bookingId: string, guestIds: string[]): Promise<void> {
  for (const id of guestIds) {
    await prisma.bookingGuest.create({
      data: {
        id,
        bookingId,
        firstName: "Ledger",
        lastName: id,
        ageTier: "ADULT",
        isMember: true,
        stayStart: D1,
        stayEnd: CHECK_OUT,
        priceCents: 10_000,
        nights: {
          create: [
            { stayDate: D1, priceCents: 5_000, priceSource: "SOLD" },
            { stayDate: D2, priceCents: 5_000, priceSource: "SOLD" },
          ],
        },
      },
    });
  }
}

/** The settle's own confirmation posting, from the real guest rows. */
async function confirmOnLedger(): Promise<void> {
  const guests = await prisma.bookingGuest.findMany({
    where: { bookingId: BOOKING_ID },
    select: {
      id: true,
      firstName: true,
      lastName: true,
      ageTier: true,
      rateMembershipTypeId: true,
      nights: { select: { stayDate: true, priceCents: true } },
    },
  });
  const plan = confirmation.planConfirmationChargeLines({
    id: BOOKING_ID,
    lodgeId: LODGE_ID,
    totalPriceCents: 20_000,
    promoAdjustmentCents: 0,
    guests,
  });
  await prisma.$transaction((tx) => write.postBookingLedgerLines(tx, plan.postings));
}

/** One edit's posting, in its own transaction under `lock(1)`, as every door runs it. */
async function postEdit(
  bookingModificationId: string,
  before: ModificationPricingSide,
  after: ModificationPricingSide,
  priceDiffCents: number,
  bookingId = BOOKING_ID,
  changeFeeCents = 0,
) {
  await prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(1)`;
    await sync.postModificationLedgerLines({
      store: tx,
      bookingId,
      lodgeId: LODGE_ID,
      bookingModification: { id: bookingModificationId, priceDiffCents, changeFeeCents },
      sides: { before, after },
      site: "race-3582",
    });
    // The transaction is still usable after the posting — a refused statement
    // would have aborted it.
    await tx.booking.findUniqueOrThrow({ where: { id: bookingId }, select: { id: true } });
  });
}

function rebaseOf(previousFinal: number, newFinal: number): BookingPriceRebase {
  return {
    previousTotalPriceCents: previousFinal,
    previousDiscountCents: 0,
    previousPromoAdjustmentCents: 0,
    previousFinalPriceCents: previousFinal,
    newTotalPriceCents: newFinal,
    newDiscountCents: 0,
    newPromoAdjustmentCents: 0,
    newFinalPriceCents: newFinal,
    promoRemoved: false,
  };
}

type Share = { direction: "REFUND_TO_MEMBER" | "CHARGE_TO_MEMBER"; amountCents: number };

/**
 * One review closure, as the completion runs it: under `lock(1)`, with a
 * `PRICE_REBASE` history row only where the re-base changed the booking.
 */
async function closeReview(task: string, rebase: BookingPriceRebase | null, settlement: Share | null): Promise<void> {
  const moved = rebase !== null && rebase.newFinalPriceCents !== rebase.previousFinalPriceCents;
  const rebaseHistoryId = moved ? await historyRow("PRICE_REBASE", 0) : null;
  await prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(1)`;
    await sync.postReviewClosureLedgerLines({
      store: tx,
      bookingId: BOOKING_ID,
      lodgeId: LODGE_ID,
      manualRefundTaskId: task,
      rebase,
      rebaseHistoryId,
      settlement,
      note: `share ${task}`,
      officerMemberId: MEMBER_ID,
    });
  });
}

/** What the ledger bills: charges plus live agreed adjustments. */
async function billedCents(): Promise<number> {
  return bookingLedgerPriceCents(await lines());
}

const BOTH = { guests: [guestSide(G1, [[D1, 5_000], [D2, 5_000]]), guestSide(G2, [[D1, 5_000], [D2, 5_000]])], promoAdjustmentCents: 0 };
const REPRICED = { guests: [guestSide(G1, [[D1, 5_000], [D2, 6_000]]), guestSide(G2, [[D1, 5_000], [D2, 5_000]])], promoAdjustmentCents: 0 };
const G2_ONLY = { guests: [guestSide(G2, [[D1, 5_000], [D2, 5_000]])], promoAdjustmentCents: 0 };

(RUN ? describe : describe.skip)(
  "an edit's and a review closure's booking-ledger lines, against PostgreSQL (#3582)",
  () => {
    beforeAll(async () => {
      assertSafeModificationLedgerRaceDbUrl(RACE_DB_URL);
      process.env.DATABASE_URL = RACE_DB_URL;
      ({ prisma } = await import("@/lib/prisma"));
      sync = await import("@/lib/booking-ledger-modification-sync");
      confirmation = await import("@/lib/booking-ledger-confirmation-posting");
      write = await import("@/lib/booking-ledger-write");

      await clean();
      await prisma.booking.deleteMany({ where: { id: { in: [BOOKING_ID, UNCONFIRMED_ID] } } });
      await prisma.lodge.deleteMany({ where: { id: LODGE_ID } });
      await prisma.member.deleteMany({ where: { id: MEMBER_ID } });
      await prisma.member.create({
        data: { id: MEMBER_ID, email: `${MEMBER_ID}@example.invalid`, passwordHash: "not-a-real-password", firstName: "Ledger", lastName: "Proof", ageTier: "ADULT" },
      });
      await prisma.lodge.create({ data: { id: LODGE_ID, name: "Race 3582 Lodge", slug: "race-3582" } });
      for (const id of [BOOKING_ID, UNCONFIRMED_ID]) {
        await prisma.booking.create({
          data: { id, memberId: MEMBER_ID, lodgeId: LODGE_ID, checkIn: D1, checkOut: CHECK_OUT, status: "CONFIRMED", totalPriceCents: 20_000, finalPriceCents: 20_000 },
        });
      }
    });

    beforeEach(async () => {
      await clean();
      await seedGuests(BOOKING_ID, [G1, G2]);
      await confirmOnLedger();
    });

    afterAll(async () => {
      if (!prisma) return;
      await clean();
      await prisma.booking.deleteMany({ where: { id: { in: [BOOKING_ID, UNCONFIRMED_ID] } } });
      await prisma.lodge.deleteMany({ where: { id: LODGE_ID } });
      await prisma.member.deleteMany({ where: { id: MEMBER_ID } });
    });

    it("TWO EDITS: the second reverses the first edit's re-post, never a line already reversed", async () => {
      const edit1 = await historyRow("BATCH_MODIFY", 1_000);
      await postEdit(edit1, BOTH, REPRICED, 1_000);
      const reposted = (await lines()).find((line) => line.anchorId === edit1 && line.reversesLineId === null);
      expect(reposted).toMatchObject({ kind: "GUEST_NIGHT", amountCents: 6_000, bookingGuestId: G1 });

      const edit2 = await historyRow("GUEST_REMOVE", -11_000);
      await prisma.bookingGuest.delete({ where: { id: G1 } });
      await postEdit(edit2, REPRICED, G2_ONLY, -11_000);

      const all = await lines();
      const edit2Reversals = all.filter((line) => line.anchorId === edit2);
      expect(edit2Reversals.map((line) => line.amountCents).sort((a, b) => a - b)).toEqual([-6_000, -5_000]);
      expect(edit2Reversals.map((line) => line.reversesLineId)).toContain(reposted!.id);
      // The database agrees: no line is reversed twice.
      const targets = all.flatMap((line) => (line.reversesLineId ? [line.reversesLineId] : []));
      expect(new Set(targets).size).toBe(targets.length);
      expect(await liveChargeCents()).toBe(10_000);
    });

    it("a replayed posting posts nothing and the transaction still commits", async () => {
      const edit = await historyRow("GUEST_REMOVE", -10_000);
      await prisma.bookingGuest.delete({ where: { id: G1 } });
      await postEdit(edit, BOTH, G2_ONLY, -10_000);
      const once = await lines();
      // The same edit again finds the lines it would reverse already reversed,
      // so it plans nothing that sums — and the write door would skip its keys
      // regardless. Either way: nothing new, and a usable transaction.
      await postEdit(edit, BOTH, G2_ONLY, -10_000);
      expect(await lines()).toEqual(once);
      expect(await liveChargeCents()).toBe(10_000);
    });

    it("posts nothing for a booking not yet confirmed on the ledger", async () => {
      await seedGuests(UNCONFIRMED_ID, ["race-3582-u1"]);
      const row = await prisma.bookingModification.create({
        data: { bookingId: UNCONFIRMED_ID, memberId: MEMBER_ID, modificationType: "GUEST_ADD", previousData: {}, newData: {}, priceDiffCents: 5_000, changeFeeCents: 0 },
        select: { id: true },
      });
      await postEdit(
        row.id,
        { guests: [], promoAdjustmentCents: 0 },
        { guests: [guestSide("race-3582-u1", [[D1, 5_000]])], promoAdjustmentCents: 0 },
        5_000,
        UNCONFIRMED_ID,
      );
      expect(await lines(UNCONFIRMED_ID)).toEqual([]);
    });

    it("a closure's re-price posts under its history row from the real guest rows, and the share posts no second record", async () => {
      // A parked removal took G1's rows away and posted nothing; the review
      // closes, re-pricing the booking from $200 to $100.
      await prisma.bookingGuest.delete({ where: { id: G1 } });
      const rebaseRow = await historyRow("PRICE_REBASE", 0);
      await prisma.$transaction(async (tx) => {
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(1)`;
        await sync.postReviewClosureLedgerLines({
          store: tx,
          bookingId: BOOKING_ID,
          lodgeId: LODGE_ID,
          manualRefundTaskId: "race-3582-task",
          rebase: {
            previousTotalPriceCents: 20_000,
            previousDiscountCents: 0,
            previousPromoAdjustmentCents: 0,
            previousFinalPriceCents: 20_000,
            newTotalPriceCents: 10_000,
            newDiscountCents: 0,
            newPromoAdjustmentCents: 0,
            newFinalPriceCents: 10_000,
            promoRemoved: false,
          },
          rebaseHistoryId: rebaseRow,
          settlement: { direction: "REFUND_TO_MEMBER", amountCents: 10_000 },
          note: "Agreed on the phone",
          officerMemberId: MEMBER_ID,
        });
      });
      const posted = (await lines()).filter((line) => line.anchorKind !== "CONFIRMATION");
      expect(posted.map((line) => [line.kind, line.amountCents, line.anchorKind, line.anchorId])).toEqual([
        ["GUEST_NIGHT", -5_000, "MODIFICATION", rebaseRow],
        ["GUEST_NIGHT", -5_000, "MODIFICATION", rebaseRow],
      ]);
      expect(await liveChargeCents()).toBe(10_000);
    });

    it("an admin date shift through the REAL door re-dates every night, netting to zero, and a later edit reverses the shifted line (#3741)", async () => {
      const { adminShiftBookingDates } = await import("@/lib/booking-date-modification-service");
      await adminShiftBookingDates({
        bookingId: BOOKING_ID,
        actor: { id: MEMBER_ID, role: "ADMIN" },
        input: { checkIn: "2026-08-08", checkOut: "2026-08-10", confirmOverCapacity: true, notifyMember: false },
        ipAddress: "127.0.0.1",
      });
      const shift = await prisma.bookingModification.findFirstOrThrow({
        where: { bookingId: BOOKING_ID, modificationType: "ADMIN_DATE_SHIFT" },
        select: { id: true },
      });
      const shiftLines = await prisma.bookingLedgerLine.findMany({
        where: { bookingId: BOOKING_ID, anchorId: shift.id },
        select: { amountCents: true, nightStart: true, reversesLineId: true },
      });
      const day = (line: { nightStart: Date | null }) => line.nightStart!.toISOString().slice(0, 10);
      expect(shiftLines.filter((line) => line.reversesLineId !== null).map(day).sort()).toEqual([
        "2026-08-01", "2026-08-01", "2026-08-02", "2026-08-02",
      ]);
      expect(shiftLines.filter((line) => line.reversesLineId === null).map(day).sort()).toEqual([
        "2026-08-08", "2026-08-08", "2026-08-09", "2026-08-09",
      ]);
      expect(shiftLines.reduce((sum, line) => sum + line.amountCents, 0)).toBe(0);
      expect(await liveChargeCents()).toBe(20_000);

      // A later edit on the shifted nights finds the shift's lines live.
      const shifted = (id: string) => guestSide(id, [[new Date("2026-08-08T00:00:00.000Z"), 5_000], [new Date("2026-08-09T00:00:00.000Z"), 5_000]]);
      const removal = await historyRow("GUEST_REMOVE", -10_000);
      await prisma.bookingGuest.delete({ where: { id: G1 } });
      await postEdit(removal, { guests: [shifted(G1), shifted(G2)], promoAdjustmentCents: 0 }, { guests: [shifted(G2)], promoAdjustmentCents: 0 }, -10_000);
      expect((await lines()).filter((line) => line.anchorId === removal)).toHaveLength(2);
      expect(await liveChargeCents()).toBe(10_000);
      // The real door's module graph is imported inside this case, and on a cold
      // Windows run that alone took ~5s against the 5s default (measured).
    }, 60_000);

    describe("two sibling reviews from one parked edit (#3740 review F1)", () => {
      const refund: Share = { direction: "REFUND_TO_MEMBER", amountCents: 10_000 };
      const charge: Share = { direction: "CHARGE_TO_MEMBER", amountCents: 10_000 };
      const adjustments = async () => (await lines()).filter((line) => line.kind === "AGREED_ADJUSTMENT");

      /** G1, G2 and G3 confirmed at $100 each; a parked edit then removes G2 and G3. */
      async function parkedRemovalOfTwo(): Promise<void> {
        await clean();
        await seedGuests(BOOKING_ID, [G1, G2, G3]);
        await confirmOnLedger();
        await prisma.bookingGuest.deleteMany({ where: { id: { in: [G2, G3] } } });
      }

      it("REFUND: the first closure's re-price carries both removals, the second posts nothing, and the ledger bills the booking's price", async () => {
        await parkedRemovalOfTwo();
        await closeReview("race-3582-tB", rebaseOf(30_000, 10_000), refund);
        await closeReview("race-3582-tC", rebaseOf(10_000, 10_000), refund);
        expect(await adjustments()).toEqual([]);
        expect(await billedCents()).toBe(10_000);
      });

      it("REFUND, dismiss then complete: the dismissal's re-price stands and the completion adds nothing", async () => {
        await parkedRemovalOfTwo();
        await closeReview("race-3582-tB", rebaseOf(30_000, 10_000), null);
        await closeReview("race-3582-tC", rebaseOf(10_000, 10_000), refund);
        expect(await adjustments()).toEqual([]);
        expect(await billedCents()).toBe(10_000);
      });

      it("REFUND, declined then re-priced: the stand-in is reversed by its line id when the re-price carries it", async () => {
        await parkedRemovalOfTwo();
        await closeReview("race-3582-tB", null, refund);
        const [standIn] = await adjustments();
        expect(standIn).toMatchObject({ amountCents: -10_000, reversesLineId: null });
        expect(await billedCents()).toBe(30_000 - 10_000);
        await closeReview("race-3582-tC", rebaseOf(30_000, 10_000), refund);
        expect((await adjustments()).map((line) => [line.amountCents, line.reversesLineId])).toEqual([
          [-10_000, null],
          [10_000, standIn!.id],
        ]);
        expect(await billedCents()).toBe(10_000);
      });

      it("REFUND, declined then re-priced on a drifted PROMOTION: the re-price still reverses the stand-in (#3740 delta L1)", async () => {
        await parkedRemovalOfTwo();
        // A $10 promotion line the booking's own figures no longer carry.
        await prisma.$transaction((tx) =>
          write.postBookingLedgerLines(tx, [
            {
              bookingId: BOOKING_ID,
              lodgeId: LODGE_ID,
              side: "CHARGE",
              kind: "PROMOTION",
              sign: -1,
              quantity: 1,
              unitCents: 1_000,
              anchorKind: "CONFIRMATION",
              anchorId: BOOKING_ID,
              narration: "Promotion applied",
              postingKey: `confirmation:${BOOKING_ID}:promotion`,
            },
          ]),
        );
        await closeReview("race-3582-tB", null, refund);
        const [standIn] = await adjustments();
        await closeReview("race-3582-tC", rebaseOf(30_000, 10_000), refund);
        expect((await adjustments()).map((line) => [line.amountCents, line.reversesLineId])).toEqual([
          [-10_000, null],
          [10_000, standIn!.id],
        ]);
        // Off the booking's price by the drift alone, never by a second count.
        expect(await billedCents()).toBe(10_000 - 1_000);
      });

      it("CHARGE: the first closure's re-price carries both additions, the second posts nothing", async () => {
        // G1 and G2 confirmed at $200; a parked edit adds G3 and G4.
        await seedGuests(BOOKING_ID, [G3, G4]);
        await closeReview("race-3582-tB", rebaseOf(20_000, 40_000), charge);
        await closeReview("race-3582-tC", rebaseOf(40_000, 40_000), charge);
        expect(await adjustments()).toEqual([]);
        expect(await billedCents()).toBe(40_000);
      });
    });

    describe("the unique constraints themselves (#3740 review F3)", () => {
      it("a same-price category change, then a second edit: the second reverses the FIRST EDIT'S re-post, never the stale confirmation line", async () => {
        // Edit 1 re-sells G1's nights as a non-member at the SAME price: the
        // confirmation lines are reversed and re-posted at $50. A planner that
        // later targeted the stale confirmation line would have its reversal
        // skipped (that line is already reversed) while its replacement posts.
        const nonMember = (nights: Night[]) => ({ ...guestSide(G1, nights), isMember: false });
        const g2 = guestSide(G2, [[D1, 5_000], [D2, 5_000]]);
        const recategorised = { guests: [nonMember([[D1, 5_000], [D2, 5_000]]), g2], promoAdjustmentCents: 0 };
        const edit1 = await historyRow("BATCH_MODIFY", 0);
        await postEdit(edit1, BOTH, recategorised, 0);
        const reposted = (await lines()).find(
          (line) => line.anchorId === edit1 && line.reversesLineId === null && line.postingKey?.endsWith("2026-08-02"),
        );
        expect(reposted).toMatchObject({ kind: "GUEST_NIGHT", amountCents: 5_000, bookingGuestId: G1 });

        const edit2 = await historyRow("BATCH_MODIFY", 1_000);
        await postEdit(edit2, recategorised, { guests: [nonMember([[D1, 5_000], [D2, 6_000]]), g2], promoAdjustmentCents: 0 }, 1_000);

        const edit2Lines = (await lines()).filter((line) => line.anchorId === edit2);
        expect(edit2Lines.map((line) => [line.amountCents, line.reversesLineId]).sort((a, b) => Number(a[0]) - Number(b[0]))).toEqual([
          [-5_000, reposted!.id],
          [6_000, null],
        ]);
        expect(await liveChargeCents()).toBe(21_000);
      });

      it("a direct write of a reversal of an already-reversed line inserts nothing, and the transaction stays usable", async () => {
        const edit = await historyRow("GUEST_REMOVE", -10_000);
        await prisma.bookingGuest.delete({ where: { id: G1 } });
        await postEdit(edit, BOTH, G2_ONLY, -10_000);
        const reversedLine = (await lines()).find((line) => line.anchorKind === "CONFIRMATION" && line.bookingGuestId === G1);
        expect((await lines()).some((line) => line.reversesLineId === reversedLine!.id)).toBe(true);
        const before = await lines();

        await prisma.$transaction(async (tx) => {
          const rows = write.buildBookingLedgerRows([
            {
              bookingId: BOOKING_ID,
              lodgeId: LODGE_ID,
              side: "CHARGE",
              kind: "GUEST_NIGHT",
              sign: -1,
              quantity: 1,
              unitCents: 5_000,
              anchorKind: "MODIFICATION",
              anchorId: edit,
              bookingGuestId: G1,
              nightStart: D1,
              nightEndExclusive: D2,
              narration: "Reversed twice",
              reversesLineId: reversedLine!.id,
              // A key of its own, so the only thing that can refuse it is the
              // unique `reversesLineId`.
              postingKey: "race-3582-second-reversal",
            },
          ]);
          expect(await write.writeBookingLedgerRows(tx, rows)).toBe(0);
          await tx.booking.findUniqueOrThrow({ where: { id: BOOKING_ID }, select: { id: true } });
        });
        expect(await lines()).toEqual(before);
      });

      it("a replayed change-fee-only edit posts its fee once: the replay's plan is identical, and ON CONFLICT skips it", async () => {
        const edit = await historyRow("DATE_CHANGE", 0);
        await postEdit(edit, BOTH, BOTH, 0, BOOKING_ID, 1_500);
        await postEdit(edit, BOTH, BOTH, 0, BOOKING_ID, 1_500);
        const fees = (await lines()).filter((line) => line.kind === "CHANGE_FEE");
        expect(fees.map((line) => [line.amountCents, line.postingKey])).toEqual([[1_500, `modification:${edit}:change-fee`]]);
      });
    });
  },
);
