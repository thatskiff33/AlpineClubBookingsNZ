/**
 * Real-PostgreSQL proof of the booking ledger's account-credit and hand-back
 * lines (#3599).
 *
 * The planner and the sync have focused unit tests; what a mock cannot show is
 * the REAL writers — `applyCreditToBooking`, the clamp, a cancellation credit,
 * the tiered restore, and a hand-back task's completion — posting through the
 * write door inside their own transactions, with `ON CONFLICT DO NOTHING` and
 * the table's constraints doing their real work. Four claims:
 *
 *  1. Credit applied, then clamped, posts one line per row, and Σ
 *     `CREDIT_APPLIED` equals `deriveBookingAppliedCreditCents` — the identity
 *     C4 (#3583) checks for `creditAppliedCents`.
 *  2. A TIERED restore posts `CREDIT_ISSUED` for exactly what was restored,
 *     anchored on the cancellation; restoring again posts nothing and the
 *     transaction still commits.
 *  3. A cancellation credit and a reduction credit each post `CREDIT_ISSUED`
 *     against their own row.
 *  4. Completing a cancelled booking's hand-back through the real resolver
 *     posts one `BANK_REFUND`, by internet banking, naming the officer — and a
 *     second completion posts nothing; a task on a CARD payment posts none.
 *
 * Ordinary Vitest runs skip the whole file. It reuses the guarded, disposable
 * loopback PostgreSQL `concurrency-lock-races.realdb.test.ts` provisions
 * (#1881), which imports this file so CI reaches it; it cleans its own
 * uniquely-namespaced fixtures.
 */
import type { PrismaClient } from "@prisma/client";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

const RUN = process.env.RUN_CONCURRENCY_RACE_TESTS === "1";
const RACE_DB_URL = process.env.CONCURRENCY_RACE_DATABASE_URL ?? "";

const MEMBER_ID = "race-3599-member";
const OFFICER_ID = "race-3599-officer";
const LODGE_ID = "race-3599-lodge";
const BOOKING_ID = "race-3599-booking";
const PAYMENT_ID = "race-3599-payment";
const TASK_ID = "race-3599-task";
const NIGHT = new Date("2026-08-01T00:00:00.000Z");
const CHECK_OUT = new Date("2026-08-02T00:00:00.000Z");

/** Standalone fail-closed copy: importing this file must not register another suite. */
export function assertSafeCreditSyncRaceDbUrl(url: string): void {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error("Credit-sync proofs need a valid CONCURRENCY_RACE_DATABASE_URL.");
  }
  const port = Number.parseInt(parsed.port, 10);
  if (!Number.isFinite(port) || port === 5432 || port < 55442) {
    throw new Error(
      `Refusing to run credit-sync proofs against port ${parsed.port || "(none)"}: use a throwaway PostgreSQL on 55442+ (never 5432).`,
    );
  }
  const host = parsed.hostname.toLowerCase();
  if (!["localhost", "127.0.0.1", "::1", "[::1]"].includes(host)) {
    throw new Error("Credit-sync proof DB must be loopback-only.");
  }
  const databaseName = decodeURIComponent(parsed.pathname.replace(/^\//, ""));
  if (!databaseName.includes("concurrency_race_1881")) {
    throw new Error("Credit-sync proof DB name must contain 'concurrency_race_1881'.");
  }
}

let prisma: PrismaClient;
let credit: typeof import("@/lib/member-credit");
let resolveManualRefundTask: typeof import("@/lib/manual-refund-task-resolution")["resolveManualRefundTask"];

async function lines() {
  return prisma.bookingLedgerLine.findMany({
    where: { bookingId: BOOKING_ID },
    orderBy: { postedAt: "asc" },
    select: {
      kind: true,
      sign: true,
      amountCents: true,
      postingKey: true,
      anchorKind: true,
      anchorId: true,
      reversesLineId: true,
      postedByMemberId: true,
      settlementMethod: true,
    },
  });
}

async function sumOf(kind: "CREDIT_APPLIED" | "CREDIT_ISSUED"): Promise<number> {
  const rows = await prisma.bookingLedgerLine.findMany({ where: { bookingId: BOOKING_ID, kind }, select: { amountCents: true } });
  return rows.reduce((sum, row) => sum + row.amountCents, 0);
}

async function clean(): Promise<void> {
  await prisma.bookingLedgerLine.deleteMany({ where: { bookingId: BOOKING_ID } });
  await prisma.manualRefundTask.deleteMany({ where: { bookingId: BOOKING_ID } });
  await prisma.bookingEvent.deleteMany({ where: { bookingId: BOOKING_ID } });
  await prisma.memberCredit.deleteMany({ where: { sourceBookingId: BOOKING_ID } });
  await prisma.bookingModification.deleteMany({ where: { bookingId: BOOKING_ID } });
  await prisma.memberCredit.deleteMany({ where: { memberId: MEMBER_ID } });
  await prisma.paymentTransaction.deleteMany({ where: { paymentId: PAYMENT_ID } });
  await prisma.payment.deleteMany({ where: { id: PAYMENT_ID } });
}

(RUN ? describe : describe.skip)(
  "the booking ledger's account-credit and hand-back lines, from the real writers (#3599)",
  () => {
    beforeAll(async () => {
      assertSafeCreditSyncRaceDbUrl(RACE_DB_URL);
      process.env.DATABASE_URL = RACE_DB_URL;
      ({ prisma } = await import("@/lib/prisma"));
      credit = await import("@/lib/member-credit");
      ({ resolveManualRefundTask } = await import("@/lib/manual-refund-task-resolution"));

      await clean();
      await prisma.booking.deleteMany({ where: { id: BOOKING_ID } });
      await prisma.lodge.deleteMany({ where: { id: LODGE_ID } });
      await prisma.member.deleteMany({ where: { id: { in: [MEMBER_ID, OFFICER_ID] } } });
      for (const id of [MEMBER_ID, OFFICER_ID]) {
        await prisma.member.create({
          data: {
            id,
            email: `${id}@example.invalid`,
            passwordHash: "not-a-real-password",
            firstName: "Credit",
            lastName: "Proof",
            ageTier: "ADULT",
          },
        });
      }
      await prisma.lodge.create({ data: { id: LODGE_ID, name: "Race 3599 Lodge", slug: "race-3599" } });
      await prisma.booking.create({
        data: {
          id: BOOKING_ID,
          memberId: MEMBER_ID,
          lodgeId: LODGE_ID,
          checkIn: NIGHT,
          checkOut: CHECK_OUT,
          status: "CONFIRMED",
          totalPriceCents: 10_000,
          finalPriceCents: 10_000,
        },
      });
    });

    beforeEach(async () => {
      await clean();
      // A balance to spend. An admin adjustment names no booking, so it posts
      // nothing — which the first case also shows.
      await prisma.memberCredit.create({
        data: { memberId: MEMBER_ID, amountCents: 20_000, type: "ADMIN_ADJUSTMENT", description: "race 3599 opening balance" },
      });
    });

    afterAll(async () => {
      if (!prisma) return;
      await clean();
      await prisma.booking.deleteMany({ where: { id: BOOKING_ID } });
      await prisma.lodge.deleteMany({ where: { id: LODGE_ID } });
      await prisma.member.deleteMany({ where: { id: { in: [MEMBER_ID, OFFICER_ID] } } });
    });

    it("posts credit applied and a clamp give-back one line per row, summing to what the booking holds applied", async () => {
      await prisma.$transaction((tx) => credit.applyCreditToBooking(MEMBER_ID, 8_000, BOOKING_ID, tx));
      await prisma.$transaction((tx) =>
        credit.clampAppliedCreditToBookingPrice({ memberId: MEMBER_ID, bookingId: BOOKING_ID, newFinalPriceCents: 6_000 }, tx),
      );
      const posted = await lines();
      expect(posted.map((l) => [l.kind, l.amountCents, l.settlementMethod, l.anchorKind])).toEqual([
        ["CREDIT_APPLIED", 8_000, "ACCOUNT_CREDIT", "MEMBER_CREDIT"],
        ["CREDIT_APPLIED", -2_000, "ACCOUNT_CREDIT", "MEMBER_CREDIT"],
      ]);
      expect(await sumOf("CREDIT_APPLIED")).toBe(await credit.deriveBookingAppliedCreditCents(BOOKING_ID));
    });

    it("posts a TIERED restore for exactly what was restored, anchored on the cancellation — and a second restore posts nothing and still commits", async () => {
      await prisma.$transaction((tx) => credit.applyCreditToBooking(MEMBER_ID, 8_000, BOOKING_ID, tx));
      // The cancel path's tier restores part of it (#1164).
      const first = await prisma.$transaction((tx) => credit.restoreCreditFromBooking(MEMBER_ID, BOOKING_ID, tx, 6_000));
      expect(first).toBe(6_000);
      const second = await prisma.$transaction(async (tx) => {
        const restored = await credit.restoreCreditFromBooking(MEMBER_ID, BOOKING_ID, tx, 6_000);
        // The transaction is still usable after the skipped row and the skipped line.
        await tx.booking.findUniqueOrThrow({ where: { id: BOOKING_ID }, select: { id: true } });
        return restored;
      });
      expect(second).toBe(0);

      const posted = await lines();
      expect(posted).toHaveLength(2);
      expect(posted[1]).toMatchObject({ kind: "CREDIT_ISSUED", sign: -1, amountCents: -6_000, anchorKind: "CANCELLATION", anchorId: BOOKING_ID, reversesLineId: null });
      // The applied figure is untouched — which is why a restore is not a reversal.
      expect(await sumOf("CREDIT_APPLIED")).toBe(8_000);
    });

    it("posts a cancellation credit against its own row", async () => {
      await credit.createCancellationCredit(MEMBER_ID, 4_500, BOOKING_ID);
      const [row] = await prisma.memberCredit.findMany({ where: { sourceBookingId: BOOKING_ID }, select: { id: true } });
      expect(await lines()).toEqual([
        expect.objectContaining({ kind: "CREDIT_ISSUED", amountCents: -4_500, anchorKind: "MEMBER_CREDIT", anchorId: row?.id, postingKey: `credit:${row?.id}` }),
      ]);
    });

    it("posts a reduction credit against its own row", async () => {
      await prisma.bookingModification.create({
        data: { id: "race-3599-mod", bookingId: BOOKING_ID, memberId: OFFICER_ID, modificationType: "GUEST_REMOVE", previousData: {}, newData: {} },
      });
      await prisma.$transaction((tx) =>
        credit.createBookingModificationCredit(MEMBER_ID, 1_250, BOOKING_ID, "race-3599-mod", undefined, tx),
      );
      const [row] = await prisma.memberCredit.findMany({ where: { sourceBookingModificationId: "race-3599-mod" }, select: { id: true } });
      expect(await lines()).toEqual([
        expect.objectContaining({ kind: "CREDIT_ISSUED", amountCents: -1_250, anchorKind: "MEMBER_CREDIT", anchorId: row?.id }),
      ]);
    });

    it("posts NO hand-back for a task on a card payment — that money goes back on the card, as a card refund", async () => {
      await prisma.payment.create({
        data: { id: PAYMENT_ID, bookingId: BOOKING_ID, amountCents: 10_000, source: "STRIPE", status: "SUCCEEDED" },
      });
      await prisma.paymentTransaction.create({
        data: { id: "race-3599-txn", paymentId: PAYMENT_ID, kind: "PRIMARY", source: "STRIPE", amountCents: 10_000, status: "SUCCEEDED" },
      });
      await prisma.manualRefundTask.create({
        data: { id: TASK_ID, bookingId: BOOKING_ID, paymentId: PAYMENT_ID, amountCents: 2_000, raisedAmountCents: 2_000, kind: "DELETED_BOOKING_LATE_CAPTURE", reason: "race 3599 late capture" },
      });
      await resolveManualRefundTask({
        taskId: TASK_ID,
        resolution: "completed",
        note: null,
        actingMemberId: OFFICER_ID,
        confirmedAmountCents: null,
        direction: "REFUND_TO_MEMBER",
        recordedNightPrices: null,
      });
      expect((await lines()).filter((l) => l.kind === "BANK_REFUND")).toEqual([]);
    });

    it("posts a completed hand-back through the REAL resolver as one BANK_REFUND by internet banking, naming the officer", async () => {
      await prisma.payment.create({
        data: { id: PAYMENT_ID, bookingId: BOOKING_ID, amountCents: 10_000, source: "INTERNET_BANKING", status: "SUCCEEDED" },
      });
      await prisma.paymentTransaction.create({
        data: { id: "race-3599-txn", paymentId: PAYMENT_ID, kind: "PRIMARY", source: "INTERNET_BANKING", amountCents: 10_000, status: "SUCCEEDED" },
      });
      await prisma.manualRefundTask.create({
        data: {
          id: TASK_ID,
          bookingId: BOOKING_ID,
          paymentId: PAYMENT_ID,
          amountCents: 3_500,
          raisedAmountCents: 3_500,
          kind: "CANCELLED_BOOKING_HAND_BACK",
          reason: "race 3599 hand-back",
        },
      });
      await resolveManualRefundTask({
        taskId: TASK_ID,
        resolution: "completed",
        note: null,
        actingMemberId: OFFICER_ID,
        confirmedAmountCents: null,
        direction: "REFUND_TO_MEMBER",
        recordedNightPrices: null,
      });

      // A second completion is refused (the task is closed) and posts nothing.
      await expect(
        resolveManualRefundTask({
          taskId: TASK_ID,
          resolution: "completed",
          note: null,
          actingMemberId: OFFICER_ID,
          confirmedAmountCents: null,
          direction: "REFUND_TO_MEMBER",
          recordedNightPrices: null,
        }),
      ).rejects.toThrow();

      const handBack = (await lines()).filter((l) => l.kind === "BANK_REFUND");
      expect(handBack).toEqual([
        expect.objectContaining({
          sign: -1,
          amountCents: -3_500,
          settlementMethod: "INTERNET_BANKING",
          anchorKind: "REVIEW_TASK",
          anchorId: TASK_ID,
          postedByMemberId: OFFICER_ID,
          postingKey: `handback:${TASK_ID}`,
        }),
      ]);
    });
  },
);
