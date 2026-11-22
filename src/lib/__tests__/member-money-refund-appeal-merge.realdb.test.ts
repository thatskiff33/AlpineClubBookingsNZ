/**
 * #4516 review F1 against real PostgreSQL: an approved refund appeal racing a member merge of the booking's owner,
 * in both orders. The appeal is the real route (`PUT /api/admin/refund-requests/[id]`) under the harness's session
 * double; the merge is the real `executeMemberMerge`. The appeal's R05 reads the owner under the booking row, so
 * its transaction takes that row right after `lock(1)`, before the Payment row and the request's claim. Taken after
 * the claim instead, the merge (owner move, then the request's member) held the booking row the appeal waited on
 * while waiting on the request the appeal held: PostgreSQL broke the cycle by aborting one of them.
 *
 * The choreography is shared with the member-merge race suites (`support/member-merge-race.ts`): every wait is
 * matched to the backend it waits on (`pg_blocking_pids`), never counted across the database (#4861).
 *
 * #5191: each door that withdraws a refund debt whole (an appeal's `release_claim`, a kept late capture, a dismissed
 * part to check) racing the same merge in both orders. The door reads the owner under the booking row, so whichever
 * commits second sees the first: merge first, the reversal lands on the duplicate and moves to the survivor by one
 * `merge-residue` transfer; door first, the merge's snapshot nets the reversal and nothing moves. The survivor ends
 * on the same balance either way, and the census reports no merged debtor.
 *
 * Ordinary Vitest runs skip the file; CI's real-PostgreSQL job runs it against the guarded loopback race database.
 */
import { randomUUID } from "node:crypto";
import { NextRequest } from "next/server";
import type { Prisma, PrismaClient } from "@prisma/client";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { cleanHistories, createHistoryBooking, historyNames, seedHistoryFixtures, settleHistoryByCard } from "./support/booking-ledger-history";
import { memberMoneyEventKeys } from "@/lib/member-money";
import { memberMoneyTestContext } from "./support/member-money-fixtures";
import { assertSafeRaceDbUrl } from "./support/race-db-url";
import { arrivingWhilePaused, clearPauses, createRaceMember, expectFulfilled, previewMerge, writerArrivingWhileMergeIsParked } from "./support/member-merge-race";
import { raceSession } from "./support/race-session-double";
import { resetStripeRaceHooks, stripeRaceHooks } from "./support/stripe-race-double";

vi.hoisted(() => {
  if (process.env.RUN_CONCURRENCY_RACE_TESTS === "1" && process.env.CONCURRENCY_RACE_DATABASE_URL) {
    process.env.DATABASE_URL = process.env.CONCURRENCY_RACE_DATABASE_URL;
  }
});

/** The shared doubles: the LAST file to register a factory wins, so every realdb file registers these same ones. */
vi.mock("@/lib/stripe", async (importOriginal) =>
  (await import("./support/stripe-race-double")).stripeRaceDouble(await importOriginal()),
);
vi.mock("@/lib/auth", async () => (await import("./support/race-session-double")).raceAuthDouble());

/** The route opens its transaction with no options: give it a budget the race, not the runner, decides (#4844 review F5). */
vi.mock("@/lib/prisma", async (importOriginal) => {
  const real = (await importOriginal()) as typeof import("@/lib/prisma");
  const { withRaceTransactionBudget } = await import("./support/race-lock-waits");
  return { ...real, prisma: withRaceTransactionBudget(real.prisma) };
});

/** A pause inside the appeal's transaction, just before its R05 (slot "beforeAppealR05"): a pass-through unless a case arms it. */
vi.mock("@/lib/member-money/doors", async (importOriginal) => {
  const real = (await importOriginal()) as typeof import("@/lib/member-money/doors");
  const { pauseIn } = await import("./support/member-merge-race");
  return {
    ...real,
    postRefundObligation: async (...args: Parameters<typeof real.postRefundObligation>) => {
      if (args[2].scope === "refund-request") await pauseIn("beforeAppealR05", args[0]);
      return real.postRefundObligation(...args);
    },
    // #5191: the dismissal's withdrawal, after the completion has taken lock(1), the booking row and its claim.
    withdrawRefundObligation: async (...args: Parameters<typeof real.withdrawRefundObligation>) => {
      await pauseIn(`beforeWithdraw:${args[2].bookingId}`, args[0]);
      return real.withdrawRefundObligation(...args);
    },
  };
});

const RUN = process.env.RUN_CONCURRENCY_RACE_TESTS === "1";
const PREFIX = "race-4516-appeal-merge-";
const names = historyNames(PREFIX);
const ADMIN = `${PREFIX}admin`;
const PRICE = 20_000;
let prisma: PrismaClient;

/**
 * A merge pair's member ids, fresh each run. A merge's journal event is keyed by its members, not a booking, so it
 * outlives the booking cleanup; fixed ids would meet the last run's merge on the same database and replay it.
 */
const MERGE_MEMBERS = `${PREFIX}${randomUUID().slice(0, 8)}-`;
async function mergePairFor(tag: string) {
  const loser = `${MERGE_MEMBERS}loser-${tag}`;
  const master = `${MERGE_MEMBERS}master-${tag}`;
  await createRaceMember(prisma, loser);
  await createRaceMember(prisma, master);
  return { loser, master };
}

/** A card booking the duplicate member owns, settled on the ledger and in the journal, with a PENDING appeal. */
async function appealOnDuplicatesBooking(tag: string) {
  const { loser, master } = await mergePairFor(tag);
  const id = `${PREFIX}b-${tag}`;
  await createHistoryBooking(prisma, { ...names, memberId: loser }, id, { payment: { amountCents: PRICE, source: "STRIPE", intent: `pi_${id}` } });
  await settleHistoryByCard(id, PRICE);
  const requestId = `${id}-appeal`;
  await prisma.refundRequest.create({ data: { id: requestId, bookingId: id, memberId: loser, reason: "race 4516 appeal", requestedAmountCents: 1_000 } });
  return { id, loser, master, requestId };
}

/** The officer approves it through the real route; resolves to the response status, or rejects as the route did. */
async function approve(requestId: string): Promise<number> {
  const email = await import("@/lib/email");
  const spy = vi.spyOn(email, "sendEmail").mockResolvedValue(undefined as never);
  raceSession.current = { user: { id: ADMIN, role: "ADMIN" } };
  try {
    const { PUT } = await import("@/app/api/admin/refund-requests/[id]/route");
    const response = await PUT(new NextRequest(`http://localhost/api/admin/refund-requests/${requestId}`, {
      method: "PUT", headers: { "content-type": "application/json" },
      body: JSON.stringify({ status: "APPROVED", approvedAmountCents: 1_000, notifyMember: false }),
    }), { params: Promise.resolve({ id: requestId }) });
    return response.status;
  } finally {
    raceSession.current = null;
    spy.mockRestore();
  }
}

async function appealDebtor(requestId: string) {
  const obligation = await prisma.memberMoneyObligation.findUnique({ where: { obligationKey: `refund-obligation|refund-request|${requestId}` }, select: { memberId: true } });
  return obligation?.memberId ?? null;
}

async function conservationHolds(bookingId: string) {
  const { readMemberMoneyApplicationState } = await import("@/lib/member-money/internal/application-read");
  const { memberMoneyConservationProblems } = await import("@/lib/member-money/internal/application-state");
  const state = await prisma.$transaction((tx) => readMemberMoneyApplicationState(tx, bookingId));
  expect(memberMoneyConservationProblems(state)).toEqual([]);
}

(RUN ? describe : describe.skip)("an approved appeal racing a member merge of its booking's owner (#4516 review F1)", { timeout: 180_000 }, () => {
  beforeAll(async () => {
    const url = process.env.CONCURRENCY_RACE_DATABASE_URL ?? "";
    assertSafeRaceDbUrl(url, "M4c appeal merge race");
    process.env.DATABASE_URL = url;
    ({ prisma } = await import("@/lib/prisma"));
    await cleanup();
    await seedHistoryFixtures(prisma, PREFIX);
    await createRaceMember(prisma, ADMIN, { role: "ADMIN", canLogin: true, accessRoles: { create: { role: "ADMIN" } } });
    resetStripeRaceHooks();
    stripeRaceHooks.refund = async (args) => ({ id: `re_${args.idempotencyKey}`.slice(0, 200), object: "refund", amount: args.amountCents, currency: "nzd",
      status: "succeeded", created: 1_782_864_000, payment_intent: args.paymentIntentId, charge: `ch_${args.paymentIntentId}`, metadata: args.metadata ?? {}, reason: args.reason });
  }, 120_000);

  afterAll(async () => {
    resetStripeRaceHooks();
    clearPauses();
    if (prisma) await cleanup();
  }, 120_000);

  async function cleanup() {
    await cleanHistories(prisma, PREFIX);
    const members = { startsWith: PREFIX };
    await prisma.auditLog.deleteMany({ where: { OR: [{ memberId: members }, { actorMemberId: members }, { targetId: members }] } });
    await prisma.memberAccessRole.deleteMany({ where: { memberId: members } });
    await prisma.member.deleteMany({ where: { id: members } });
  }

  describe("a refund debt withdrawn whole racing the merge (#5191)", () => {
    const context = memberMoneyTestContext();
    const receivable = async (bookingId: string, memberId: string) => (await prisma.memberMoneyLine.findMany({
      where: { bookingId, account: "MEMBER_RECEIVABLE", debtorKind: "MEMBER", memberId }, select: { side: true, amountCents: true } }))
      .reduce((sum, l) => sum + (l.side === "DEBIT" ? l.amountCents : -l.amountCents), 0);
    const residues = (bookingId: string) => prisma.memberMoneyEvent.count({ where: { eventKey: { startsWith: "merge-residue:" }, sourceIdentity: bookingId } });
    async function mergedDebtorFindings(bookingId: string) {
      const { readBookingReceiptCensus } = await import("@/lib/member-money");
      return (await prisma.$transaction((tx) => readBookingReceiptCensus(tx, `${bookingId}-payment`))).filter((f) => f.kind === "MERGED_DEBTOR_BALANCE");
    }
    /** lock(1), then the booking row: the order every one of these doors opens with. A case may pause it there. */
    async function openDoor(tx: Prisma.TransactionClient, bookingId: string) {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(1)`;
      const { lockBookingRowForOwnerRead } = await import("@/lib/booking-row-lock");
      await lockBookingRowForOwnerRead(tx, bookingId);
      const { pauseIn } = await import("./support/member-merge-race");
      await pauseIn(`door:${bookingId}`, tx);
    }

    interface Door {
      /** What the door's reversal takes off the owner's receivable. */
      cents: number;
      /** The door's own transaction, or its real entry. Resolves truthy when it withdrew. */
      run: () => Promise<unknown>;
      /** Where a door-first case pauses it, holding the booking row. */
      slot: string;
      /** Replays the door's journal step; never a second residue move. */
      replay: () => Promise<unknown>;
    }

    /** A card booking the duplicate owns, settled; a PENDING request of the duplicate's parks a merge right after its owner move. */
    async function settled(tag: string) {
      const { loser, master } = await mergePairFor(tag);
      const id = `${PREFIX}b-${tag}`;
      await createHistoryBooking(prisma, { ...names, memberId: loser }, id, { payment: { amountCents: PRICE, source: "STRIPE", intent: `pi_${id}` } });
      await settleHistoryByCard(id, PRICE);
      const requestId = `${id}-request`;
      await prisma.refundRequest.create({ data: { id: requestId, bookingId: id, memberId: loser, reason: "race 5191", requestedAmountCents: 500 } });
      return { id, loser, master, requestId };
    }

    /** A kept late capture, as `prepareLateCaptureDecision` runs it: lock(1), the booking row, then the keep (which takes the Payment row). */
    async function keep(id: string): Promise<Door> {
      const { syncBookingLedgerSettlements } = await import("@/lib/booking-ledger-settlement-sync");
      const { closeKeptCaptureReturn, postBookingReceipts, reserveCardRefundSlice } = await import("@/lib/member-money/doors");
      const { recordStripeRefundsAgainstTransaction } = await import("@/lib/payment-transactions");
      const { buildLateCaptureRefundStripeKeyPrefix, refundSliceStripeIdempotencyKey } = await import("@/lib/payment-recovery-keys");
      const intent = `${id}-late`;
      const late = await prisma.paymentTransaction.create({ data: { paymentId: `${id}-payment`, source: "STRIPE", kind: "ADDITIONAL", status: "SUCCEEDED", amountCents: 3_000, stripePaymentIntentId: intent } });
      await prisma.$transaction((tx) => syncBookingLedgerSettlements({ paymentId: `${id}-payment`, store: tx }));
      await prisma.$transaction((tx) => postBookingReceipts(tx, context, { paymentId: `${id}-payment`, decision: { paymentIntentId: intent, collect: false } }));
      const prefix = buildLateCaptureRefundStripeKeyPrefix(id, intent);
      const key = refundSliceStripeIdempotencyKey(prefix, { paymentTransactionId: late.id, amountCents: 3_000 });
      await prisma.$transaction((tx) => reserveCardRefundSlice(tx, context, { paymentId: `${id}-payment`, obligation: { scope: "capture-return", id: intent, ensureFaceCents: 3_000 },
        attemptKey: key, senderKeyPrefix: prefix, paymentTransactionId: late.id, amountCents: 3_000, planAttemptKeys: [key] }));
      await recordStripeRefundsAgainstTransaction({ paymentId: `${id}-payment`, paymentTransactionId: late.id, journal: context, attemptKeys: new Map([[`re_${id}`, key]]),
        refunds: [{ id: `re_${id}`, amount: 3_000, currency: "nzd", status: "failed", created: 1_782_864_000, payment_intent: intent, metadata: { refundSliceKey: key } }] });
      const step = (tx: Prisma.TransactionClient) => closeKeptCaptureReturn(tx, context, { bookingId: id, paymentIntentId: intent, actorMemberId: ADMIN });
      return { cents: 3_000, slot: `door:${id}`, run: () => prisma.$transaction(async (tx) => { await openDoor(tx, id); return step(tx); }),
        replay: () => prisma.$transaction(async (tx) => { await openDoor(tx, id); return step(tx); }) };
    }

    /** A card shortfall's part to check, dismissed through the real `resolveManualRefundTask`. */
    async function dismiss(id: string): Promise<Door> {
      const { raiseCancelCardShortfallHandBack } = await import("@/lib/cancel-card-refund-shortfall");
      const { CLUB_FORMAT_TEST } = await import("./support/club-format-fixture");
      const shortfall = await prisma.$transaction(async (tx) => {
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(1)`;
        await tx.booking.update({ where: { id }, data: { status: "CANCELLED" } });
        return raiseCancelCardShortfallHandBack(tx, { bookingId: id, paymentId: `${id}-payment`, refundAmountCents: PRICE, plannedCardRefundCents: 0, format: CLUB_FORMAT_TEST, journal: context, actorMemberId: ADMIN });
      });
      const check = shortfall!.check!;
      const resolution = await import("@/lib/manual-refund-task-resolution");
      const { withdrawRefundObligation } = await import("@/lib/member-money/doors");
      return { cents: check.cents, slot: `beforeWithdraw:${id}`,
        run: () => resolution.resolveManualRefundTask({ taskId: check.taskId, resolution: "dismissed", note: "Member has it", actingMemberId: ADMIN, recordedNightPrices: null }, CLUB_FORMAT_TEST),
        replay: () => prisma.$transaction(async (tx) => {
          await openDoor(tx, id);
          return withdrawRefundObligation(tx, context, { bookingId: id, scope: "hand-back", id: check.taskId, actorMemberId: ADMIN, reason: "replay", senderKeyPrefix: `hand-back-dismiss:${check.taskId}`,
            part: { eventKey: memberMoneyEventKeys.handBackRestWithdrawn(check.taskId), amountCents: "open", debtorRead: "booking-row" } });
        }) };
    }

    /**
     * An approved appeal released as `release_claim` runs it: lock(1), the booking row, the request's claim back to PENDING,
     * its OPEN hand-back deleted, then both its debts withdrawn. Both are concessions, so neither leaves a receivable to move.
     */
    async function release(id: string, requestId: string): Promise<Door> {
      const { postHandBackObligation, postRefundObligation, withdrawRefundObligation } = await import("@/lib/member-money/doors");
      const taskId = `${requestId}-task`;
      await prisma.refundRequest.update({ where: { id: requestId }, data: { status: "APPROVED", approvedAmountCents: 500, reviewedBy: ADMIN, reviewedAt: new Date() } });
      await prisma.$transaction(async (tx) => {
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(1)`;
        await postRefundObligation(tx, context, { bookingId: id, scope: "refund-request", id: requestId, amountCents: 300, origin: "OFFICER", actorMemberId: ADMIN, debtorRead: "booking-row", concession: true });
        await postHandBackObligation(tx, context, { bookingId: id, taskId, amountCents: 200, origin: "OFFICER", actorMemberId: ADMIN, debtorRead: "booking-row", concession: true });
      });
      const withdraw = async (tx: Prisma.TransactionClient) => [
        await withdrawRefundObligation(tx, context, { bookingId: id, scope: "refund-request", id: requestId, actorMemberId: ADMIN, reason: "release_claim", senderKeyPrefix: `refund_request_refund_${requestId}` }),
        await withdrawRefundObligation(tx, context, { bookingId: id, scope: "hand-back", id: taskId, actorMemberId: ADMIN, reason: "release_claim", senderKeyPrefix: `refund_request_refund_${requestId}` }),
      ];
      return { cents: 0, slot: `door:${id}`,
        run: () => prisma.$transaction(async (tx) => {
          await openDoor(tx, id);
          const released = await tx.refundRequest.updateMany({ where: { id: requestId, status: "APPROVED" }, data: { status: "PENDING", approvedAmountCents: null, reviewedBy: null, reviewedAt: null } });
          expect(released.count).toBe(1);
          return withdraw(tx);
        }),
        replay: () => prisma.$transaction(async (tx) => { await openDoor(tx, id); return withdraw(tx); }) };
    }

    /** Every debt the door withdraws is reversed: the R05s of its booking carry a reversal each. */
    async function withdrew(bookingId: string) {
      const r05s = await prisma.memberMoneyEvent.findMany({ where: { sourceIdentity: bookingId, eventKey: { startsWith: "refund-obligation|" } }, select: { journal: { select: { reversedBy: { select: { id: true } } } } } });
      return r05s.length > 0 && r05s.every((e) => e.journal?.reversedBy != null);
    }

    const doors = {
      "the keep": async (f: Awaited<ReturnType<typeof settled>>) => keep(f.id),
      "a part to check's dismissal": async (f: Awaited<ReturnType<typeof settled>>) => dismiss(f.id),
      "an appeal's release_claim": async (f: Awaited<ReturnType<typeof settled>>) => release(f.id, f.requestId),
    } as const;

    for (const [name, make] of Object.entries(doors)) {
      const tag = name.replace(/[^a-z]+/gi, "-").toLowerCase();

      it(`${name}, merge first: the reversal follows the owner to the survivor, by one residue move when it leaves a receivable on the duplicate`, async () => {
        const fixture = await settled(`5191-merge-first-${tag}`);
        const door = await make(fixture);
        const before = await receivable(fixture.id, fixture.loser);
        const execute = await previewMerge(fixture.master, fixture.loser, ADMIN);
        // Parked on the request's row, the merge holds the booking row from its owner move; the door queues behind it.
        const { merged, written } = await writerArrivingWhileMergeIsParked(
          prisma, (tx) => tx.$executeRaw`SELECT 1 FROM "RefundRequest" WHERE "id" = ${fixture.requestId} FOR UPDATE`, execute, door.run,
        );
        expectFulfilled(merged);
        expectFulfilled(written);
        expect(await withdrew(fixture.id)).toBe(true);
        expect(await receivable(fixture.id, fixture.loser)).toBe(0);
        expect(await receivable(fixture.id, fixture.master)).toBe(before - door.cents);
        // MUTATION: reading the owner plainly before the booking row, or deleting the residue move, leaves the reversal here.
        expect(await residues(fixture.id)).toBe(door.cents === 0 ? 0 : 1);
        await door.replay();
        expect(await residues(fixture.id)).toBe(door.cents === 0 ? 0 : 1);
        expect(await mergedDebtorFindings(fixture.id)).toEqual([]);
        await conservationHolds(fixture.id);
      });

      it(`${name}, door first: the merge waits on the booking row and its snapshot nets the reversal, so nothing moves`, async () => {
        const fixture = await settled(`5191-door-first-${tag}`);
        const door = await make(fixture);
        const before = await receivable(fixture.id, fixture.loser);
        const { held, arrived } = await arrivingWhilePaused(prisma, door.slot, door.run, async () => (await previewMerge(fixture.master, fixture.loser, ADMIN))());
        expectFulfilled(held);
        expectFulfilled(arrived);
        expect(await withdrew(fixture.id)).toBe(true);
        expect(await receivable(fixture.id, fixture.loser)).toBe(0);
        expect(await receivable(fixture.id, fixture.master)).toBe(before - door.cents);
        expect(await residues(fixture.id)).toBe(0);
        expect(await mergedDebtorFindings(fixture.id)).toEqual([]);
        await conservationHolds(fixture.id);
      });
    }
  });

  it("MUTATION: the appeal holds the booking row first; the merge waits for it, and both commit", async () => {
    const { id, loser, master, requestId } = await appealOnDuplicatesBooking("appeal-first");
    // The merge reaches the owner move and waits on the booking row the appeal holds.
    const { held: approved, arrived: merged } = await arrivingWhilePaused(
      prisma, "beforeAppealR05", () => approve(requestId), async () => (await previewMerge(master, loser, ADMIN))(),
    );
    expect(approved).toEqual({ status: "fulfilled", value: 200 });
    expectFulfilled(merged);
    expect(await appealDebtor(requestId)).toBe(loser);
    expect((await prisma.refundRequest.findUniqueOrThrow({ where: { id: requestId }, select: { memberId: true, status: true } }))).toEqual({ memberId: master, status: "APPROVED" });
    await conservationHolds(id);
  });

  it("the merge holds the booking row first; the appeal waits for it, and reads the survivor as owner", async () => {
    const { id, loser, master, requestId } = await appealOnDuplicatesBooking("merge-first");
    const execute = await previewMerge(master, loser, ADMIN);
    // The request's row, held, so the merge stops right after its owner move; the appeal queues behind the merge.
    const { merged, written: approved } = await writerArrivingWhileMergeIsParked(
      prisma, (tx) => tx.$executeRaw`SELECT 1 FROM "RefundRequest" WHERE "id" = ${requestId} FOR UPDATE`, execute, () => approve(requestId),
    );
    expectFulfilled(merged);
    expect(approved).toEqual({ status: "fulfilled", value: 200 });
    expect(await appealDebtor(requestId)).toBe(master);
    await conservationHolds(id);
  });
});
