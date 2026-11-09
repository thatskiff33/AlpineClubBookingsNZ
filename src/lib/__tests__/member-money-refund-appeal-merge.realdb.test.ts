/**
 * #4516 review F1 against real PostgreSQL: an approved refund appeal racing a member merge of the booking's owner,
 * in both orders. The appeal is the real route (`PUT /api/admin/refund-requests/[id]`) under the harness's session
 * double; the merge is the real `executeMemberMerge`. The appeal's R05 reads the owner under the booking row, so
 * its transaction takes that row right after `lock(1)`, before the Payment row and the request's claim. Taken after
 * the claim instead, the merge (owner move, then the request's member) held the booking row the appeal waited on
 * while waiting on the request the appeal held: PostgreSQL broke the cycle by aborting one of them.
 *
 * Ordinary Vitest runs skip the file; CI's real-PostgreSQL job runs it against the guarded loopback race database.
 */
import { NextRequest } from "next/server";
import type { PrismaClient } from "@prisma/client";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { cleanHistories, createHistoryBooking, historyNames, seedHistoryFixtures, settleHistoryByCard } from "./support/booking-ledger-history";
import { assertSafeRaceDbUrl } from "./support/race-db-url";
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

/** A pause inside the appeal's transaction, just before its R05: a pass-through with no hook set. */
const doorHook = vi.hoisted(() => ({ beforeAppealR05: null as null | (() => Promise<void>) }));
vi.mock("@/lib/member-money/doors", async (importOriginal) => {
  const real = (await importOriginal()) as typeof import("@/lib/member-money/doors");
  return {
    ...real,
    postRefundObligation: async (...args: Parameters<typeof real.postRefundObligation>) => {
      const hook = args[2].scope === "refund-request" ? doorHook.beforeAppealR05 : null;
      if (hook) {
        doorHook.beforeAppealR05 = null;
        await hook();
      }
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

function gate() {
  let open!: () => void;
  const opened = new Promise<void>((resolve) => { open = resolve; });
  return { open, opened };
}

/** Until at least `count` backends wait on a row or advisory lock in this database. */
async function untilWaiting(count: number): Promise<void> {
  for (let attempt = 0; attempt < 400; attempt += 1) {
    const [{ waiting }] = await prisma.$queryRaw<Array<{ waiting: number }>>`
      SELECT count(*)::int AS waiting FROM pg_catalog.pg_stat_activity
      WHERE datname = current_database() AND wait_event_type = 'Lock'`;
    if (waiting >= count) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`fewer than ${count} backends ever waited on a lock`);
}

async function member(id: string, extra: Record<string, unknown> = {}) {
  await prisma.member.create({ data: { id, email: `${id}@example.invalid`, passwordHash: "not-a-real-password", firstName: "Merge", lastName: id, ageTier: "ADULT", ...extra } });
}

/** A card booking the duplicate member owns, settled on the ledger and in the journal, with a PENDING appeal. */
async function appealOnDuplicatesBooking(tag: string) {
  const loser = `${PREFIX}loser-${tag}`;
  const master = `${PREFIX}master-${tag}`;
  await member(loser);
  await member(master);
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

async function previewMerge(master: string, loser: string) {
  const merge = await import("@/lib/member-merge");
  const preview = await merge.buildMemberMergePreview({ masterId: master, loserId: loser, actorMemberId: ADMIN });
  expect(preview.blockers).toEqual([]);
  return () => merge.executeMemberMerge({ masterId: master, loserId: loser, actorMemberId: ADMIN, previewToken: preview.previewToken, confirmationText: preview.confirmationPhrase });
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
    await member(ADMIN, { role: "ADMIN", canLogin: true, accessRoles: { create: { role: "ADMIN" } } });
    resetStripeRaceHooks();
    stripeRaceHooks.refund = async (args) => ({ id: `re_${args.idempotencyKey}`.slice(0, 200), object: "refund", amount: args.amountCents, currency: "nzd",
      status: "succeeded", created: 1_782_864_000, payment_intent: args.paymentIntentId, charge: `ch_${args.paymentIntentId}`, metadata: args.metadata ?? {}, reason: args.reason });
  }, 120_000);

  afterAll(async () => {
    resetStripeRaceHooks();
    doorHook.beforeAppealR05 = null;
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
    const reached = gate();
    const release = gate();
    doorHook.beforeAppealR05 = async () => {
      reached.open();
      await release.opened;
    };
    const approving = approve(requestId);
    await reached.opened;
    let merging: Promise<unknown> = Promise.resolve();
    try {
      const execute = await previewMerge(master, loser);
      merging = execute();
      // The merge reaches the owner move and waits on the booking row the appeal holds.
      await untilWaiting(1);
    } finally {
      release.open();
    }
    const [approved, merged] = await Promise.allSettled([approving, merging]);
    expect(approved).toEqual({ status: "fulfilled", value: 200 });
    expect(merged.status, merged.status === "rejected" ? String(merged.reason) : "").toBe("fulfilled");
    expect(await appealDebtor(requestId)).toBe(loser);
    expect((await prisma.refundRequest.findUniqueOrThrow({ where: { id: requestId }, select: { memberId: true, status: true } }))).toEqual({ memberId: master, status: "APPROVED" });
    await conservationHolds(id);
  });

  it("the merge holds the booking row first; the appeal waits for it, and reads the survivor as owner", async () => {
    const { id, loser, master, requestId } = await appealOnDuplicatesBooking("merge-first");
    const held = gate();
    const release = gate();
    // The request's row, held, so the merge stops right after its owner move.
    const blocker = prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT 1 FROM "RefundRequest" WHERE "id" = ${requestId} FOR UPDATE`;
      held.open();
      await release.opened;
    }, { maxWait: 30_000, timeout: 120_000 });
    await held.opened;
    let merging: Promise<unknown> = Promise.resolve();
    let approving: Promise<number> = Promise.resolve(0);
    try {
      const execute = await previewMerge(master, loser);
      merging = execute();
      await untilWaiting(1);
      approving = approve(requestId);
      await untilWaiting(2);
    } finally {
      release.open();
    }
    await blocker;
    const [approved, merged] = await Promise.allSettled([approving, merging]);
    expect(merged.status, merged.status === "rejected" ? String(merged.reason) : "").toBe("fulfilled");
    expect(approved).toEqual({ status: "fulfilled", value: 200 });
    expect(await appealDebtor(requestId)).toBe(master);
    await conservationHolds(id);
  });
});
