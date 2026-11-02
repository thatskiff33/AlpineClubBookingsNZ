/**
 * The store's order of checks (#4626, Ledger M3a), with a fake transaction.
 * What PostgreSQL accepts is `member-money-posting.realdb.test.ts`; this pins
 * the one interleaving a real database cannot schedule on demand: a same-key
 * poster committing between the store's replay lookup and its live-component
 * read.
 */
import type { Prisma } from "@prisma/client";
import { describe, expect, it } from "vitest";
import { memberMoneyEventKeys, MemberMoneyPlanError, type MemberMoneyPlan } from "@/lib/member-money";
import { GlobalLockNotHeldError } from "@/lib/global-lock-held";
import { buildMemberMoneyBatch } from "@/lib/member-money/internal/plan";
import { writeMemberMoneyBatch } from "@/lib/member-money/internal/store";
import { bookingChargePlan, memberMoneyTestContext } from "./support/member-money-fixtures";

const MEMBER = { kind: "MEMBER", memberId: "member-1" } as const;
const correction: MemberMoneyPlan = {
  kind: "ADJUSTMENT", eventKey: memberMoneyEventKeys.modification("m1"), origin: "APP", reason: "reduction",
  source: { kind: "BOOKING", id: "m1", version: "1" },
  legs: [
    { type: "revenue", account: "BOOKING_REVENUE", side: "DEBIT", grossCents: 11500, chargeIdentity: "nights:1", evidence: {} },
    { type: "amount", account: "MEMBER_RECEIVABLE", side: "CREDIT", amountCents: 11500, debtor: MEMBER, evidence: {} },
  ],
};
const draft = buildMemberMoneyBatch(memberMoneyTestContext(), correction);
const leg = (side: "CREDIT" | "DEBIT") => ({ account: "BOOKING_REVENUE", chargeIdentity: "nights:1", side, amountCents: 10000,
  grossCents: 11500, netCents: 10000, taxCents: 1500, taxCode: "GST_INCLUSIVE_1500BP", bookingId: null, lodgeId: null });

/** A transaction whose event lookups answer in turn, holding lock(1) unless told otherwise. */
function fakeTx(lookups: unknown[], { lockHeld = true, componentHasLegs = true } = {}) {
  const writes: string[] = [];
  const write = (table: string) => ({ createMany: async () => { writes.push(table); return { count: 1 }; } });
  const tx = {
    $queryRaw: async () => [{ held: lockHeld }],
    memberMoneyEvent: {
      findUnique: async () => lookups.shift() ?? null,
      createMany: async () => { writes.push("event"); return { count: 1 }; },
    },
    // The component was corrected by the same-key poster that just committed.
    memberMoneyLine: {
      findMany: async () => [leg("CREDIT"), leg("DEBIT")],
      findFirst: async () => (componentHasLegs ? { id: "earlier-leg" } : null),
      ...write("line"),
    },
    memberMoneyObligation: { findMany: async () => [], ...write("obligation") },
    memberMoneyJournal: write("journal"),
    memberMoneySourceLink: write("source"),
    memberMoneySourcePosting: write("posting"),
  };
  return { tx: tx as unknown as Prisma.TransactionClient, writes };
}

describe("writeMemberMoneyBatch", () => {
  it("returns a same-key batch that committed between its replay lookup and its live read", async () => {
    const winner = { id: "event-1", payloadHash: draft.event.payloadHash,
      journal: { id: "journal-1", sources: [{ sourceKind: "BOOKING", sourceId: "m1", sourceVersion: "1", bookingLedgerLineId: null }] } };
    const { tx, writes } = fakeTx([null, winner]);
    await expect(writeMemberMoneyBatch(tx, draft)).resolves.toEqual({ eventId: "event-1", journalId: "journal-1", replayed: true });
    expect(writes).toEqual([]);
  });

  it("rethrows the refusal when no same-key batch appeared", async () => {
    const { tx, writes } = fakeTx([null, null]);
    await expect(writeMemberMoneyBatch(tx, draft)).rejects.toBeInstanceOf(MemberMoneyPlanError);
    expect(writes).toEqual([]);
  });

  it("refuses a charge of a component that already has posted legs without lock(1), and posts a first charge without it", async () => {
    const charge = buildMemberMoneyBatch(memberMoneyTestContext(), bookingChargePlan({
      eventKey: memberMoneyEventKeys.bookingCharge("b1"), debtor: MEMBER, grossCents: 11500,
      components: [{ chargeIdentity: "nights:1", grossCents: 11500 }] }));
    const again = fakeTx([null], { lockHeld: false, componentHasLegs: true });
    await expect(writeMemberMoneyBatch(again.tx, charge)).rejects.toBeInstanceOf(GlobalLockNotHeldError);
    expect(again.writes).toEqual([]);
    const first = fakeTx([null], { lockHeld: false, componentHasLegs: false });
    await expect(writeMemberMoneyBatch(first.tx, charge)).resolves.toMatchObject({ replayed: false });
    expect(first.writes).toEqual(["event", "journal", "source", "obligation", "line"]);
  });

  it("refuses a correction when the caller does not hold lock(1), before reading or writing", async () => {
    const { tx, writes } = fakeTx([null], { lockHeld: false });
    await expect(writeMemberMoneyBatch(tx, draft)).rejects.toBeInstanceOf(GlobalLockNotHeldError);
    expect(writes).toEqual([]);
  });
});
