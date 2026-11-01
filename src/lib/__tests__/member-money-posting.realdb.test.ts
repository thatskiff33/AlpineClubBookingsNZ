/**
 * Ledger M3a (#4626): the posting command against real PostgreSQL, as the
 * INSERT/SELECT-only application role. The database's deferred checks are the
 * judge: a batch "commits" only if `member_money_batch_errors` finds nothing at
 * COMMIT, and the operator verifier then reports no finding. Ordinary Vitest
 * runs skip the file; CI's real-PostgreSQL job runs it in a scratch database of
 * its own on the guarded race server.
 */
import type { Prisma, PrismaClient } from "@prisma/client";
import { GlobalLockNotHeldError } from "@/lib/global-lock-held";
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  MemberMoneyPlanError,
  MemberMoneyPostingConflictError,
  memberMoneyEventKeys,
  postMemberMoneyEvent,
  reverseMemberMoneyJournal,
  verifyMemberMoneyJournal,
  type MemberMoneyPlan,
} from "@/lib/member-money";
import {
  bookingChargePlan,
  createMemberMoneyScratchDatabase,
  memberMoneyTestContext,
  type MemberMoneyScratchDatabase,
} from "./support/member-money-fixtures";

const RUN = process.env.RUN_CONCURRENCY_RACE_TESTS === "1";
const RACE_DB_URL = process.env.CONCURRENCY_RACE_DATABASE_URL ?? "";

const MEMBER = { kind: "MEMBER", memberId: "member-4626" } as const;
const LODGE = "lodge-4626";
const BOOKING = { bookingId: "booking-4626", lodgeId: LODGE };
const context = memberMoneyTestContext();

let scratch: MemberMoneyScratchDatabase;
let appPrisma: PrismaClient;
let app: Client;
let sequence = 0;
/** A fresh event key per case; a review-close key is just a well-formed one here. */
const key = (label: string) => memberMoneyEventKeys.reviewClose(`t4626-${label}-${++sequence}`);

/** The verifier as the operator command runs it: its own read-only snapshot, as the application role. */
async function verified() {
  await app.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
  try { return await verifyMemberMoneyJournal(app, scratch.roles.app); } finally { await app.query("ROLLBACK"); }
}

const post = (plan: MemberMoneyPlan, ctx = context) =>
  appPrisma.$transaction((tx) => postMemberMoneyEvent(tx, ctx, plan));
/** As a door that corrects or reverses revenue posts: holding the global key (INV-LOCK-001). */
async function underGlobalLock<T>(run: (tx: Prisma.TransactionClient) => Promise<T>): Promise<T> {
  return appPrisma.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(1)`;
    return run(tx);
  });
}
const postLocked = (plan: MemberMoneyPlan, ctx = context) => underGlobalLock((tx) => postMemberMoneyEvent(tx, ctx, plan));

async function counts() {
  const { rows } = await app.query(`SELECT
    (SELECT count(*) FROM "MemberMoneyEvent")::int AS events,
    (SELECT count(*) FROM "MemberMoneyLine")::int AS lines,
    (SELECT count(*) FROM "MemberMoneyObligation")::int AS obligations,
    (SELECT count(*) FROM "MemberMoneySourceLink")::int AS sources`);
  return rows[0] as { events: number; lines: number; obligations: number; sources: number };
}

async function legs(journalId: string) {
  return (await app.query(`SELECT account, side, "amountCents" AS amount, "grossCents" AS gross, "netCents" AS net,
      "taxCents" AS tax, "taxCode" AS code, "chargeIdentity" AS charge
    FROM "MemberMoneyLine" WHERE "journalId" = $1 ORDER BY account, side`, [journalId])).rows;
}

/** A transaction client that fails the test if the command touches it at all. */
const untouchable = new Proxy({}, {
  get(_target, property) { throw new Error(`the command reached the database (${String(property)})`); },
}) as Prisma.TransactionClient;

(RUN ? describe : describe.skip)("member-money posting command against real PostgreSQL (#4626)", () => {
  beforeAll(async () => {
    scratch = await createMemberMoneyScratchDatabase(RACE_DB_URL, "member money posting");
    await scratch.owner.query(`INSERT INTO "Lodge" VALUES ($1)`, [LODGE]);
    await scratch.owner.query(`INSERT INTO "Booking" VALUES ($1, $2)`, [BOOKING.bookingId, LODGE]);
    const { PrismaClient: Prisma } = await import("@prisma/client");
    const { createPrismaPgAdapter } = await import("@/lib/prisma-adapter");
    appPrisma = new Prisma({ adapter: createPrismaPgAdapter(scratch.appUrl) });
    app = new Client({ connectionString: scratch.appUrl });
    await app.connect();
  }, 30_000);

  afterAll(async () => {
    await appPrisma?.$disconnect();
    await app?.end();
    await scratch?.drop();
  });

  it("commits a taxed CHARGE with a bridged legacy line, and it verifies", async () => {
    const legacy = "legacy-line-4626";
    await scratch.owner.query(`INSERT INTO "BookingLedgerLine" VALUES ($1)`, [legacy]);
    const posted = await post(bookingChargePlan({
      eventKey: memberMoneyEventKeys.bookingCharge(BOOKING.bookingId), debtor: MEMBER, grossCents: 11500,
      booking: BOOKING, additionalSources: [{ kind: "BOOKING_LEDGER", id: legacy, version: "1" }],
    }));
    expect(posted.replayed).toBe(false);
    expect(await legs(posted.journalId)).toEqual([
      { account: "MEMBER_RECEIVABLE", side: "DEBIT", amount: 11500, gross: null, net: null, tax: null, code: null, charge: null },
      { account: "BOOKING_REVENUE", side: "CREDIT", amount: 10000, gross: 11500, net: 10000, tax: 1500, code: "GST_INCLUSIVE_1500BP", charge: expect.any(String) },
      { account: "GST_PAYABLE", side: "CREDIT", amount: 1500, gross: null, net: null, tax: null, code: null, charge: expect.any(String) },
    ]);
    const bridged = await app.query(`SELECT count(*)::int AS n FROM "MemberMoneySourcePosting" p
      JOIN "MemberMoneySourceLink" s ON s.id = p."sourceLinkId" WHERE s."bookingLedgerLineId" = $1`, [legacy]);
    expect(bridged.rows).toEqual([{ n: 2 }]);
    expect(await verified()).toEqual({ findings: [], grantCheck: "checked" });
  });

  it("commits an ADJUSTMENT correcting a whole component at its posted split, whatever today's rate", async () => {
    const charge = bookingChargePlan({ eventKey: key("charge"), debtor: MEMBER, grossCents: 23000,
      components: [{ chargeIdentity: `nights:${sequence}:a`, grossCents: 11500 }, { chargeIdentity: `nights:${sequence}:b`, grossCents: 11500 }] });
    const component = charge.legs[1]!.chargeIdentity!;
    await post(charge);
    const reduction = (grossCents: number, chargeIdentity = component): MemberMoneyPlan => ({
      kind: "ADJUSTMENT", eventKey: key("modification"), origin: "APP", reason: "test reduction",
      source: { kind: "BOOKING", id: `modification-${sequence}`, version: "1" },
      legs: [
        { type: "revenue", account: "BOOKING_REVENUE", side: "DEBIT", grossCents, chargeIdentity, evidence: { reverses: chargeIdentity } },
        { type: "amount", account: "MEMBER_RECEIVABLE", side: "CREDIT", amountCents: grossCents, debtor: MEMBER,
          obligationKey: charge.obligations![0]!.key, chargeIdentity, evidence: {} },
      ],
    });
    const before = await counts();
    // A part of a component, and a component never posted, are refused before any write.
    await expect(postLocked(reduction(5000))).rejects.toMatchObject({ name: "MemberMoneyPlanError",
      problems: [expect.stringMatching(/takes a whole component/)] });
    await expect(postLocked(reduction(11500, "nights:never-posted"))).rejects.toMatchObject({ name: "MemberMoneyPlanError",
      problems: [expect.stringMatching(/no posted BOOKING_REVENUE leg/)] });
    // A correction reads live state then writes: without the caller's lock(1) it is refused (INV-LOCK-001).
    const plan = reduction(11500);
    const at1250 = memberMoneyTestContext({ taxSettings: { taxRateBasisPoints: 1250 } });
    await expect(post(plan, at1250)).rejects.toBeInstanceOf(GlobalLockNotHeldError);
    expect(await counts()).toEqual(before);
    // The club's rate has since changed; the correction still repeats 10000 + 1500.
    const posted = await postLocked(plan, at1250);
    expect((await legs(posted.journalId)).map(({ account, side, amount, gross, tax, code }) => [account, side, amount, gross, tax, code])).toEqual([
      ["MEMBER_RECEIVABLE", "CREDIT", 11500, null, null, null],
      ["BOOKING_REVENUE", "DEBIT", 10000, 11500, 1500, "GST_INCLUSIVE_1500BP"],
      ["GST_PAYABLE", "DEBIT", 1500, null, null, null],
    ]);
    expect(await verified()).toEqual({ findings: [], grantCheck: "checked" });
    // A retry replays, although the component it corrected is no longer live.
    expect(await postLocked(plan, at1250)).toEqual({ ...posted, replayed: true });
    // An exact reversal of the charge would now drive the corrected component negative: refused.
    const chargeJournal = await app.query(`SELECT "journalId" AS id FROM "MemberMoneyLine" WHERE "chargeIdentity" = $1 AND side = 'CREDIT'`, [component]);
    await expect(underGlobalLock((tx) => reverseMemberMoneyJournal(tx, context, { reversesJournalId: chargeJournal.rows[0].id,
      origin: "OFFICER", reason: "posted in error", source: { kind: "OFFICER_FACT", id: `undo-${sequence}`, version: "1" } })))
      .rejects.toMatchObject({ name: "MemberMoneyPlanError", problems: [expect.stringMatching(new RegExp(`${component} has changed since`))] });
  });

  it("posts what needs no fresh split when the tax setting starts after the date, and refuses what does", async () => {
    const later = memberMoneyTestContext({ taxSettings: { effectiveFrom: "2027-04-01" as never } });
    await post({ kind: "ZERO", eventKey: key("zero-untaxed"), origin: "APP", reason: "no-invoice outcome",
      source: { kind: "SUBSCRIPTION", id: `subscription-${sequence}`, version: "1" } }, later);
    const receipt = await post({ kind: "ADJUSTMENT", eventKey: key("receipt"), origin: "OFFICER", reason: "cash received",
      source: { kind: "OFFICER_FACT", id: `receipt-${sequence}`, version: "1" }, legs: [
        { type: "amount", account: "CASH", side: "DEBIT", amountCents: 2000, evidence: {} },
        { type: "amount", account: "MEMBER_RECEIVABLE", side: "CREDIT", amountCents: 2000, debtor: MEMBER, evidence: {} },
      ] }, later);
    expect(await legs(receipt.journalId)).toHaveLength(2);
    await expect(post(bookingChargePlan({ eventKey: key("charge-untaxed"), debtor: MEMBER, grossCents: 4600 }), later))
      .rejects.toBeInstanceOf(MemberMoneyPlanError);
    expect(await verified()).toEqual({ findings: [], grantCheck: "checked" });
  });

  it("commits an explicit ZERO event with no legs", async () => {
    const posted = await post({ kind: "ZERO", eventKey: key("zero"), origin: "APP", reason: "no-invoice outcome",
      source: { kind: "SUBSCRIPTION", id: "subscription-4626", version: "1" } });
    expect(await legs(posted.journalId)).toEqual([]);
    expect(await verified()).toEqual({ findings: [], grantCheck: "checked" });
  });

  it("posts revenue with no tax fields and no GST leg for a club that is not GST-registered", async () => {
    const posted = await post(
      bookingChargePlan({ eventKey: key("unregistered"), debtor: MEMBER, grossCents: 11500 }),
      memberMoneyTestContext({ taxSettings: { gstRegistered: false } }),
    );
    expect((await legs(posted.journalId)).map(({ account, amount, tax, code }) => [account, amount, tax, code])).toEqual([
      ["MEMBER_RECEIVABLE", 11500, null, null], ["BOOKING_REVENUE", 11500, null, null],
    ]);
    expect(await verified()).toEqual({ findings: [], grantCheck: "checked" });
  });

  it("returns the posted batch on an identical replay and writes nothing", async () => {
    const plan = bookingChargePlan({ eventKey: key("replay"), debtor: MEMBER, grossCents: 4600 });
    const first = await post(plan);
    const before = await counts();
    // The same facts walked in another order are the same event.
    const second = await post({ ...plan, legs: [...plan.legs].reverse() });
    expect(second).toEqual({ ...first, replayed: true });
    // Reason and actor are provenance, not economics: a retry that words them differently replays.
    expect(await post({ ...plan, reason: "retried by the recovery runner", actorMemberId: "officer-4626" }))
      .toEqual({ ...first, replayed: true });
    expect(await counts()).toEqual(before);
  });

  it("refuses a changed payload under a posted key, and rolls back", async () => {
    const plan = bookingChargePlan({ eventKey: key("conflict"), debtor: MEMBER, grossCents: 4600 });
    await post(plan);
    const before = await counts();
    const changed = bookingChargePlan({ eventKey: plan.eventKey, debtor: MEMBER, grossCents: 4700 });
    await expect(post(changed)).rejects.toMatchObject({
      name: "MemberMoneyPostingConflictError", differences: ["payload hash differs"],
    });
    expect(await counts()).toEqual(before);
  });

  it("refuses an unbalanced or ill-shaped plan before touching the database", async () => {
    const before = await counts();
    const unbalanced: MemberMoneyPlan = {
      kind: "CHARGE", eventKey: key("unbalanced"), origin: "APP", reason: "test",
      source: { kind: "BOOKING", id: "booking-unbalanced", version: "1" },
      legs: [
        { type: "amount", account: "MEMBER_RECEIVABLE", side: "DEBIT", amountCents: 100, debtor: MEMBER, evidence: {} },
        { type: "amount", account: "BANK", side: "CREDIT", amountCents: 99, evidence: {} },
      ],
    };
    const oneLeg: MemberMoneyPlan = { ...unbalanced, legs: [unbalanced.legs[0]!] };
    const noDebtor: MemberMoneyPlan = { ...unbalanced, legs: [
      { type: "amount", account: "MEMBER_RECEIVABLE", side: "DEBIT", amountCents: 100, evidence: {} },
      { type: "amount", account: "BANK", side: "CREDIT", amountCents: 100, evidence: {} },
    ] };
    for (const plan of [unbalanced, oneLeg, noDebtor]) {
      await expect(postMemberMoneyEvent(untouchable, context, plan)).rejects.toBeInstanceOf(MemberMoneyPlanError);
      await expect(post(plan)).rejects.toBeInstanceOf(MemberMoneyPlanError);
    }
    expect(await counts()).toEqual(before);
  });

  it("commits an exact REVERSAL of a whole batch; a retry replays and a different reversal conflicts", async () => {
    const original = await post(bookingChargePlan({ eventKey: key("reversed"), debtor: MEMBER, grossCents: 11500, booking: BOOKING }));
    const plan = { reversesJournalId: original.journalId, origin: "OFFICER" as const, reason: "posted in error",
      source: { kind: "OFFICER_FACT" as const, id: `correction-${original.journalId}`, version: "1" } };
    const reverse = (p: typeof plan) => underGlobalLock((tx) => reverseMemberMoneyJournal(tx, context, p));
    // It reads that the charge's components are unchanged, then copies them: lock(1) is required.
    await expect(appPrisma.$transaction((tx) => reverseMemberMoneyJournal(tx, context, plan))).rejects.toBeInstanceOf(GlobalLockNotHeldError);
    const reversal = await reverse(plan);
    const swapped = (await legs(original.journalId)).map((leg) => ({ ...leg, side: leg.side === "DEBIT" ? "CREDIT" : "DEBIT" }));
    expect(await legs(reversal.journalId)).toEqual(expect.arrayContaining(swapped));
    expect(await verified()).toEqual({ findings: [], grantCheck: "checked" });
    expect(await reverse({ ...plan, reason: "retry" })).toEqual({ ...reversal, replayed: true });
    // The key is the journal's, so a second, different reversal meets a typed conflict, never a raw P2002.
    await expect(reverse({ ...plan, source: { ...plan.source, version: "2" } })).rejects.toBeInstanceOf(MemberMoneyPostingConflictError);
  });

  it("lets exactly one of two concurrent posters of one key write; the other replays it", async () => {
    const plan = bookingChargePlan({ eventKey: key("concurrent"), debtor: MEMBER, grossCents: 4600 });
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    let firstPosted!: () => void;
    const posted = new Promise<void>((resolve) => { firstPosted = resolve; });
    const first = appPrisma.$transaction(async (tx) => {
      const result = await postMemberMoneyEvent(tx, context, plan);
      firstPosted();
      await gate;
      return result;
    }, { timeout: 20_000 });
    await posted;
    const second = appPrisma.$transaction((tx) => postMemberMoneyEvent(tx, context, plan), { timeout: 20_000 });
    // Wait until the second poster is blocked on the first's uncommitted key.
    let blocked = false;
    for (let attempt = 0; attempt < 100 && !blocked; attempt++) {
      const { rows } = await scratch.owner.query(`SELECT count(*)::int AS n FROM pg_stat_activity
        WHERE datname = current_database() AND wait_event_type = 'Lock'`);
      blocked = rows[0].n > 0;
      if (!blocked) await new Promise((resolve) => setTimeout(resolve, 50));
    }
    release();
    expect(blocked, "the second poster waited on the first's uncommitted key").toBe(true);
    const [won, replayed] = await Promise.all([first, second]);
    expect(won.replayed).toBe(false);
    expect(replayed).toEqual({ ...won, replayed: true });
    expect(await verified()).toEqual({ findings: [], grantCheck: "checked" });
  });
});
