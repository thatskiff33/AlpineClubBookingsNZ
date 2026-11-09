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
 * Ordinary Vitest runs skip the file; CI's real-PostgreSQL job runs it against the guarded loopback race database.
 */
import { NextRequest } from "next/server";
import type { PrismaClient } from "@prisma/client";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { cleanHistories, createHistoryBooking, historyNames, seedHistoryFixtures, settleHistoryByCard } from "./support/booking-ledger-history";
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
  };
});

const RUN = process.env.RUN_CONCURRENCY_RACE_TESTS === "1";
const PREFIX = "race-4516-appeal-merge-";
const names = historyNames(PREFIX);
const ADMIN = `${PREFIX}admin`;
const PRICE = 20_000;
let prisma: PrismaClient;

/** A card booking the duplicate member owns, settled on the ledger and in the journal, with a PENDING appeal. */
async function appealOnDuplicatesBooking(tag: string) {
  const loser = `${PREFIX}loser-${tag}`;
  const master = `${PREFIX}master-${tag}`;
  await createRaceMember(prisma, loser);
  await createRaceMember(prisma, master);
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
