/**
 * Real-PostgreSQL proof for the booking ledger's idempotency (#3595,
 * `INV-MONEY-033`).
 *
 * Two claims a mock cannot make, because both are about PostgreSQL itself:
 *
 *  1. A repeated `postingKey` is SKIPPED, not refused — and the transaction it
 *     happens in survives to run its next statement and commit. Without
 *     `skipDuplicates` the same repeat is refused and the whole transaction is
 *     lost, which is the #3590 lesson; the contrast case pins that too, so the
 *     suite fails if the door ever stops skipping.
 *  2. The per-booking confirmation fence sees a confirmation line with NO key —
 *     a line #3580 posted before keys existed — so a later settle is fenced by
 *     it, not just by keyed lines.
 *
 * Every row is written through the production write door and read through the
 * production fence; nothing is re-implemented here.
 *
 * Ordinary Vitest runs skip the whole file. It reuses the guarded, disposable
 * loopback PostgreSQL that `concurrency-lock-races.realdb.test.ts` provisions
 * (#1881), which imports this file so hosted CI reaches it, and it cleans its
 * own uniquely-namespaced fixtures.
 */
import type { PrismaClient } from "@prisma/client";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

const RUN = process.env.RUN_CONCURRENCY_RACE_TESTS === "1";
const RACE_DB_URL = process.env.CONCURRENCY_RACE_DATABASE_URL ?? "";

const MEMBER_ID = "race-3595-member";
const LODGE_ID = "race-3595-lodge";
const BOOKING_ID = "race-3595-booking";
const NIGHT = new Date("2026-08-01T00:00:00.000Z");
const CHECK_OUT = new Date("2026-08-02T00:00:00.000Z");

/** Standalone fail-closed copy: importing this file must not register another suite. */
export function assertSafeLedgerKeyRaceDbUrl(url: string): void {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error("Ledger posting-key proofs need a valid CONCURRENCY_RACE_DATABASE_URL.");
  }
  const port = Number.parseInt(parsed.port, 10);
  if (!Number.isFinite(port) || port === 5432 || port < 55442) {
    throw new Error(
      `Refusing to run ledger posting-key proofs against port ${parsed.port || "(none)"}: use a throwaway PostgreSQL on 55442+ (never 5432).`,
    );
  }
  const host = parsed.hostname.toLowerCase();
  if (!["localhost", "127.0.0.1", "::1", "[::1]"].includes(host)) {
    throw new Error("Ledger posting-key proof DB must be loopback-only.");
  }
  const databaseName = decodeURIComponent(parsed.pathname.replace(/^\//, ""));
  if (!databaseName.includes("concurrency_race_1881")) {
    throw new Error("Ledger posting-key proof DB name must contain 'concurrency_race_1881'.");
  }
}

let prisma: PrismaClient;
let writeBookingLedgerRows: typeof import("@/lib/booking-ledger-write")["writeBookingLedgerRows"];
let buildBookingLedgerRows: typeof import("@/lib/booking-ledger-write")["buildBookingLedgerRows"];
let bookingHasConfirmationLines: typeof import("@/lib/booking-ledger-read")["bookingHasConfirmationLines"];

function changeFee(postingKey: string) {
  return {
    bookingId: BOOKING_ID,
    lodgeId: LODGE_ID,
    side: "CHARGE" as const,
    kind: "CHANGE_FEE" as const,
    sign: 1 as const,
    quantity: 1,
    unitCents: 500,
    anchorKind: "CONFIRMATION" as const,
    anchorId: BOOKING_ID,
    narration: "posting-key proof",
    postingKey,
  };
}

async function clearLedger(): Promise<void> {
  await prisma.bookingLedgerLine.deleteMany({ where: { bookingId: BOOKING_ID } });
}

(RUN ? describe : describe.skip)(
  "the booking ledger is idempotent in PostgreSQL itself (#3595, INV-MONEY-033)",
  () => {
    beforeAll(async () => {
      assertSafeLedgerKeyRaceDbUrl(RACE_DB_URL);
      process.env.DATABASE_URL = RACE_DB_URL;
      ({ prisma } = await import("@/lib/prisma"));
      ({ writeBookingLedgerRows, buildBookingLedgerRows } = await import("@/lib/booking-ledger-write"));
      ({ bookingHasConfirmationLines } = await import("@/lib/booking-ledger-read"));

      await prisma.bookingLedgerLine.deleteMany({ where: { bookingId: BOOKING_ID } });
      await prisma.booking.deleteMany({ where: { id: BOOKING_ID } });
      await prisma.lodge.deleteMany({ where: { id: LODGE_ID } });
      await prisma.member.deleteMany({ where: { id: MEMBER_ID } });
      await prisma.member.create({
        data: {
          id: MEMBER_ID,
          email: "race-3595@example.invalid",
          passwordHash: "not-a-real-password",
          firstName: "Ledger",
          lastName: "Proof",
          ageTier: "ADULT",
        },
      });
      await prisma.lodge.create({ data: { id: LODGE_ID, name: "Race 3595 Lodge", slug: "race-3595" } });
      await prisma.booking.create({
        data: {
          id: BOOKING_ID,
          memberId: MEMBER_ID,
          lodgeId: LODGE_ID,
          checkIn: NIGHT,
          checkOut: CHECK_OUT,
          status: "CONFIRMED",
          totalPriceCents: 500,
          finalPriceCents: 500,
        },
      });
    });

    beforeEach(clearLedger);

    afterAll(async () => {
      if (!prisma) return;
      await clearLedger();
      await prisma.booking.deleteMany({ where: { id: BOOKING_ID } });
      await prisma.lodge.deleteMany({ where: { id: LODGE_ID } });
      await prisma.member.deleteMany({ where: { id: MEMBER_ID } });
    });

    it("skips a repeated key rather than refusing it, and the transaction survives to commit", async () => {
      const outcome = await prisma.$transaction(async (tx) => {
        const first = await writeBookingLedgerRows(tx, buildBookingLedgerRows([changeFee("k-3595")]));
        const second = await writeBookingLedgerRows(tx, buildBookingLedgerRows([changeFee("k-3595")]));
        // The statement AFTER the repeat. Had the repeat aborted the
        // transaction (25P02), this would throw and nothing would commit.
        const visible = await tx.bookingLedgerLine.count({ where: { postingKey: "k-3595" } });
        return { first, second, visible };
      });
      expect(outcome).toEqual({ first: 1, second: 0, visible: 1 });
      expect(await prisma.bookingLedgerLine.count({ where: { postingKey: "k-3595" } })).toBe(1);
    });

    it("CONTRAST: the same repeat without the door's skip is refused and loses the whole transaction", async () => {
      // Pins why `skipDuplicates` is load-bearing: this is the #3590 lesson in
      // a real database, and it fails loudly if PostgreSQL ever stops behaving
      // this way, rather than leaving the first case green for the wrong reason.
      const rows = buildBookingLedgerRows([changeFee("k-3595-contrast")]);
      await expect(
        prisma.$transaction(async (tx) => {
          await tx.bookingLedgerLine.createMany({ data: rows });
          await tx.bookingLedgerLine.createMany({ data: rows });
        }),
      ).rejects.toMatchObject({ code: "P2002" });
      expect(await prisma.bookingLedgerLine.count({ where: { postingKey: "k-3595-contrast" } })).toBe(0);
    });

    it("the confirmation fence sees a line with NO key, so a line posted before keys existed still fences", async () => {
      expect(await bookingHasConfirmationLines(prisma, BOOKING_ID)).toBe(false);
      // A #3580-era line: no postingKey at all, which the column allows and
      // which a per-night key could never collide with.
      await prisma.bookingLedgerLine.create({
        data: { ...buildBookingLedgerRows([changeFee("placeholder")])[0], postingKey: null },
      });
      expect(await bookingHasConfirmationLines(prisma, BOOKING_ID)).toBe(true);
    });
  },
);
