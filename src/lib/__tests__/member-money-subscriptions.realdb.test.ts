import { randomUUID } from "node:crypto";
import type { Prisma, PrismaClient } from "@prisma/client";
import { beforeAll, describe, expect, it, vi } from "vitest";
import {
  postJoiningFeeCharge,
  postMemberMergeTransfer,
  postSubscriptionCharge,
  postSubscriptionCloseReceipt,
  postSubscriptionManualReceipt,
  reverseSubscriptionChargeForCredit,
  reverseSubscriptionManualReceipt,
} from "@/lib/member-money/doors";
import { memberMoneyEventKeys } from "@/lib/member-money";
import { memberMoneyTestContext } from "./support/member-money-fixtures";
import { assertSafeRaceDbUrl } from "./support/race-db-url";

/**
 * #4519 (Ledger M7): the subscription doors against the fully migrated race
 * database — R18 with the owner's re-bill replacement (10 Nov 2026), R19, R08
 * and its reversal, the close receipt, R20, and a merge moving a subscription
 * receivable. Journal rows are append-only, so every run names its own members
 * and charges and leaves them: the database is the race harness's throwaway.
 *
 * The static imports load `@/lib/prisma`, whose client takes DATABASE_URL when
 * it is built, so point it at the race database first; `beforeAll` still
 * refuses an unsafe URL before any query is made.
 */
vi.hoisted(() => {
  if (process.env.RUN_CONCURRENCY_RACE_TESTS === "1" && process.env.CONCURRENCY_RACE_DATABASE_URL) {
    process.env.DATABASE_URL = process.env.CONCURRENCY_RACE_DATABASE_URL;
  }
});

/** The one shared double: the LAST file to register a factory wins, so every realdb file registers this same one. */
vi.mock("@/lib/stripe", async (importOriginal) =>
  (await import("./support/stripe-race-double")).stripeRaceDouble(await importOriginal()),
);

const RUN = process.env.RUN_CONCURRENCY_RACE_TESTS === "1";
const PREFIX = `race-m7-${randomUUID().slice(0, 8)}-`;
const context = memberMoneyTestContext();
const officerId = `${PREFIX}officer`;
let db: PrismaClient;
let sequence = 0;

async function member(): Promise<string> {
  const id = `${PREFIX}m${++sequence}`;
  await db.member.create({ data: { id, email: `${id}@example.invalid`, passwordHash: "not-a-real-password", firstName: "Sub", lastName: "Proof", ageTier: "ADULT" } });
  return id;
}

/** A confirmed charge row with its frozen components, as the confirm writes one. */
async function chargeRow(recipientMemberId: string, components: number[], billingBasis: "PER_MEMBER" | "NO_INVOICE" = "PER_MEMBER") {
  const id = `${PREFIX}c${++sequence}`;
  const cents = components.reduce((sum, c) => sum + c, 0);
  await db.membershipSubscriptionCharge.create({ data: {
    id, idempotencyKey: id, invoiceReference: id, seasonYear: 2026, source: "ANNUAL_BATCH", membershipTypeId: `${PREFIX}type`,
    membershipTypeKey: "adult", membershipTypeName: "Adult", billingBasis, prorationRule: "NONE", annualAmountCents: cents, chargedAmountCents: cents,
    coveredMonths: 12, decisionDate: new Date("2026-07-01"), coverageStart: new Date("2026-04-01"), coverageEnd: new Date("2027-03-31"),
    recipientMemberId, recipientName: "Sub Proof", recipientEmail: `${recipientMemberId}@example.invalid`, dueDays: 20,
    components: { create: components.map((c, index) => ({ id: `${id}-k${index}`, label: `Part ${index}`, description: "part", annualAmountCents: c,
      chargedAmountCents: c, prorated: false, xeroAccountCode: "200", sortOrder: index })) },
  } });
  return { chargeId: id, recipientMemberId, billingBasis, chargedAmountCents: cents,
    components: components.map((c, index) => ({ id: `${id}-k${index}`, label: `Part ${index}`, chargedAmountCents: c })) };
}

const lock1 = (tx: Prisma.TransactionClient) => tx.$executeRaw`SELECT pg_advisory_xact_lock(1)`;
const confirm = (facts: Awaited<ReturnType<typeof chargeRow>>, replacesChargeIds: string[] = [], global = false) =>
  db.$transaction(async (tx) => {
    if (global) await lock1(tx);
    return postSubscriptionCharge(tx, context, { facts, replacesChargeIds, actorMemberId: officerId });
  });

const event = (eventKey: string) => db.memberMoneyEvent.findUnique({ where: { eventKey },
  select: { kind: true, journal: { select: { id: true, reversedBy: { select: { id: true } } } } } });

/** The member's own receivable: every MEMBER_RECEIVABLE line naming no booking, debits less credits. */
async function memberBalance(memberId: string): Promise<number> {
  const lines = await db.memberMoneyLine.findMany({ where: { account: "MEMBER_RECEIVABLE", debtorKind: "MEMBER", memberId, bookingId: null },
    select: { side: true, amountCents: true } });
  return lines.reduce((sum, l) => sum + (l.side === "DEBIT" ? l.amountCents : -l.amountCents), 0);
}

/** What is collected on a charge's obligation, net of reversed applications. */
async function collected(chargeId: string): Promise<number> {
  const rows = await db.memberMoneyApplication.findMany({
    where: { obligation: { obligationKey: memberMoneyEventKeys.subscriptionCharge(chargeId) } }, select: { amountCents: true, reversesApplicationId: true } });
  return rows.reduce((sum, a) => sum + (a.reversesApplicationId ? -a.amountCents : a.amountCents), 0);
}

const markPaid = (chargeId: string, amountCents: number, paidAt: Date) =>
  db.$transaction((tx) => postSubscriptionManualReceipt(tx, context, { chargeId, amountCents, paidAt, actorMemberId: officerId }));

(RUN ? describe : describe.skip)("M7 subscription and joining-fee doors on synthetic PostgreSQL", () => {
  beforeAll(async () => {
    const url = process.env.CONCURRENCY_RACE_DATABASE_URL ?? "";
    assertSafeRaceDbUrl(url, "M7 subscriptions");
    process.env.DATABASE_URL = url;
    ({ prisma: db } = await import("@/lib/prisma"));
    await db.member.create({ data: { id: officerId, email: `${officerId}@example.invalid`, passwordHash: "not-a-real-password",
      firstName: "Officer", lastName: "Proof", ageTier: "ADULT", role: "ADMIN" } });
  }, 60_000);

  it("R18 posts one obligation for the recipient and one revenue leg per component, once", async () => {
    const facts = await chargeRow(await member(), [15_000, 2_500]);
    expect(await confirm(facts)).not.toBeNull();
    const obligation = await db.memberMoneyObligation.findUniqueOrThrow({ where: { obligationKey: memberMoneyEventKeys.subscriptionCharge(facts.chargeId) } });
    expect(obligation).toMatchObject({ kind: "CHARGE", faceCents: 17_500, debtorKind: "MEMBER", memberId: facts.recipientMemberId });
    const revenue = await db.memberMoneyLine.findMany({ where: { journalId: obligation.journalId, account: "SUBSCRIPTION_REVENUE" }, select: { grossCents: true } });
    expect(revenue.map((l) => l.grossCents).sort()).toEqual([15_000, 2_500].sort());
    expect(await memberBalance(facts.recipientMemberId)).toBe(17_500);
    expect(await confirm(facts)).toBeNull();
    expect(await memberBalance(facts.recipientMemberId)).toBe(17_500);
  });

  it("a NO_INVOICE charge is a ZERO under the same key", async () => {
    const facts = await chargeRow(await member(), [0], "NO_INVOICE");
    await confirm(facts);
    expect((await event(memberMoneyEventKeys.subscriptionCharge(facts.chargeId)))?.kind).toBe("ZERO");
  });

  it("a re-bill of a voided unpaid charge reverses it under lock(1) and the member owes the new amount once", async () => {
    const memberId = await member();
    const old = await chargeRow(memberId, [15_000]);
    await confirm(old);
    const rebill = await chargeRow(memberId, [12_000]);
    await expect(confirm(rebill, [old.chargeId])).rejects.toThrow(/global advisory key 1/);
    expect(await confirm(rebill, [old.chargeId], true)).not.toBeNull();
    expect((await event(memberMoneyEventKeys.subscriptionCharge(old.chargeId)))?.journal?.reversedBy).not.toBeNull();
    expect((await event(memberMoneyEventKeys.subscriptionCharge(rebill.chargeId)))?.kind).toBe("CHARGE");
    expect(await memberBalance(memberId)).toBe(12_000);
  });

  it("a re-bill whose prior charge holds a receipt posts ZERO and leaves the old debt and its cash", async () => {
    const memberId = await member();
    const old = await chargeRow(memberId, [15_000]);
    await confirm(old);
    await markPaid(old.chargeId, 15_000, new Date("2026-06-20T01:00:00Z"));
    const rebill = await chargeRow(memberId, [15_000]);
    await confirm(rebill, [old.chargeId], true);
    expect((await event(memberMoneyEventKeys.subscriptionCharge(rebill.chargeId)))?.kind).toBe("ZERO");
    expect((await event(memberMoneyEventKeys.subscriptionCharge(old.chargeId)))?.journal?.reversedBy).toBeNull();
    expect(await collected(old.chargeId)).toBe(15_000);
    expect(await memberBalance(memberId)).toBe(0);
  });

  it("a re-bill replacing a charge never posted (pre-M7) neither reverses nor invents it", async () => {
    const memberId = await member();
    const old = await chargeRow(memberId, [15_000]);
    const rebill = await chargeRow(memberId, [9_000]);
    await confirm(rebill, [old.chargeId]);
    expect(await event(memberMoneyEventKeys.subscriptionCharge(old.chargeId))).toBeNull();
    expect(await memberBalance(memberId)).toBe(9_000);
  });

  it("R19 posts once at the frozen cents; an exempt member is one ZERO", async () => {
    const memberId = await member();
    const post = (feeAmountCents: number, exempt = false, id = memberId) =>
      db.$transaction((tx) => postJoiningFeeCharge(tx, context, { memberId: id, feeAmountCents, exempt }));
    expect(await post(5_000)).not.toBeNull();
    expect(await post(7_000)).toBeNull();
    expect(await memberBalance(memberId)).toBe(5_000);
    expect(await db.memberMoneyLine.count({ where: { account: "JOINING_FEE_REVENUE", journal: { event: { eventKey: memberMoneyEventKeys.joiningFee(memberId) } } } })).toBe(1);
    const exempt = await member();
    await post(0, true, exempt);
    expect(await post(5_000, false, exempt)).toBeNull();
    expect((await event(memberMoneyEventKeys.joiningFee(exempt)))?.kind).toBe("ZERO");
    expect(await memberBalance(exempt)).toBe(0);
  });

  it("R08 collects cash against the charge; mark-unpaid reverses it and posts no charge", async () => {
    const facts = await chargeRow(await member(), [15_000]);
    await confirm(facts);
    const paidAt = new Date("2026-06-21T02:00:00Z");
    expect(await markPaid(facts.chargeId, 15_000, paidAt)).not.toBeNull();
    expect(await markPaid(facts.chargeId, 15_000, paidAt)).toBeNull();
    expect(await collected(facts.chargeId)).toBe(15_000);
    expect(await memberBalance(facts.recipientMemberId)).toBe(0);
    const cash = await db.memberMoneyLine.findFirstOrThrow({ where: { account: "CASH", journal: { event: { eventKey: memberMoneyEventKeys.subscriptionReceipt(facts.chargeId, paidAt.getTime()) } } } });
    expect(cash).toMatchObject({ side: "DEBIT", amountCents: 15_000 });
    // A close after mark-paid already collected it posts nothing.
    expect(await db.$transaction((tx) => postSubscriptionCloseReceipt(tx, context, { chargeId: facts.chargeId, closedAt: paidAt }))).toBeNull();
    expect(await db.$transaction((tx) => reverseSubscriptionManualReceipt(tx, context, { chargeId: facts.chargeId, paidAt }))).not.toBeNull();
    expect(await collected(facts.chargeId)).toBe(0);
    expect(await memberBalance(facts.recipientMemberId)).toBe(15_000);
    expect(await db.$transaction((tx) => reverseSubscriptionManualReceipt(tx, context, { chargeId: facts.chargeId, paidAt }))).toBeNull();
  });

  it("no receipt posts against a charge without an open R18, or for more than its face", async () => {
    const unposted = await chargeRow(await member(), [15_000]);
    expect(await markPaid(unposted.chargeId, 15_000, new Date("2026-06-22T00:00:00Z"))).toBeNull();
    const posted = await chargeRow(await member(), [15_000]);
    await confirm(posted);
    expect(await markPaid(posted.chargeId, 15_001, new Date("2026-06-22T00:00:00Z"))).toBeNull();
    expect(await collected(posted.chargeId)).toBe(0);
  });

  it("close as already paid posts one receipt for the face", async () => {
    const facts = await chargeRow(await member(), [10_000, 5_000]);
    await confirm(facts);
    const close = () => db.$transaction((tx) => postSubscriptionCloseReceipt(tx, context, { chargeId: facts.chargeId, closedAt: new Date("2026-06-23T00:00:00Z") }));
    expect(await close()).not.toBeNull();
    expect(await close()).toBeNull();
    expect(await collected(facts.chargeId)).toBe(15_000);
  });

  it("R20 reverses an unpaid charge only for the last member at the exact cents, once", async () => {
    const facts = await chargeRow(await member(), [15_000]);
    await confirm(facts);
    const credit = (creditedCents: number, leaverIsLastLiveMember = true, creditNoteId = "cn-1") => db.$transaction(async (tx) => {
      await lock1(tx);
      return reverseSubscriptionChargeForCredit(tx, context, { chargeId: facts.chargeId, creditNoteId, creditedCents, leaverIsLastLiveMember });
    });
    expect(await credit(14_000)).toEqual({ outcome: "mismatch", creditedCents: 14_000, chargedCents: 15_000 });
    expect(await credit(15_000, false)).toMatchObject({ outcome: "mismatch" });
    expect(await credit(15_000)).toEqual({ outcome: "posted", creditedCents: 15_000, chargedCents: 15_000 });
    expect(await memberBalance(facts.recipientMemberId)).toBe(0);
    expect(await credit(15_000)).toMatchObject({ outcome: "posted" });
    expect(await credit(15_000, true, "cn-2")).toMatchObject({ outcome: "nothing-to-reverse" });
    expect(await memberBalance(facts.recipientMemberId)).toBe(0);
  });

  it("R20 reverses nothing on a paid charge or one never posted", async () => {
    const paid = await chargeRow(await member(), [15_000]);
    await confirm(paid);
    await markPaid(paid.chargeId, 15_000, new Date("2026-06-24T00:00:00Z"));
    const unposted = await chargeRow(await member(), [15_000]);
    const credit = (chargeId: string) => db.$transaction(async (tx) => {
      await lock1(tx);
      return reverseSubscriptionChargeForCredit(tx, context, { chargeId, creditNoteId: "cn", creditedCents: 15_000, leaverIsLastLiveMember: true });
    });
    expect(await credit(paid.chargeId)).toMatchObject({ outcome: "mismatch" });
    expect(await credit(unposted.chargeId)).toEqual({ outcome: "nothing-to-reverse", creditedCents: 15_000, chargedCents: null });
  });

  it("a member merge moves a subscription receivable to the survivor", async () => {
    const [from, to] = [await member(), await member()];
    const facts = await chargeRow(from, [15_000]);
    await confirm(facts);
    await db.$transaction((tx) => postMemberMergeTransfer(tx, context, { fromMemberId: from, toMemberId: to, actorMemberId: officerId }));
    expect(await memberBalance(from)).toBe(0);
    expect(await memberBalance(to)).toBe(15_000);
  });
});
