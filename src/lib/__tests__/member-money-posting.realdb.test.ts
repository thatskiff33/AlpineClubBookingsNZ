/**
 * Ledger M3a (#4626): the posting command against real PostgreSQL, as the
 * INSERT/SELECT-only application role. The database's deferred checks are the
 * judge: a batch "commits" only if `member_money_batch_errors` finds nothing at
 * COMMIT, and the operator verifier then reports no finding. Ordinary Vitest
 * runs skip the file; CI's real-PostgreSQL job runs it in a scratch database of
 * its own on the guarded race server.
 */
import type { Prisma, PrismaClient } from "@prisma/client";
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
const key = (label: string) => `test-4626:${label}:${++sequence}`;

/** The verifier as the operator command runs it: its own read-only snapshot, as the application role. */
async function verified() {
  await app.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
  try { return await verifyMemberMoneyJournal(app, scratch.roles.app); } finally { await app.query("ROLLBACK"); }
}

const post = (plan: MemberMoneyPlan, ctx = context) =>
  appPrisma.$transaction((tx) => postMemberMoneyEvent(tx, ctx, plan));

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
      { account: "MEMBER_RECEIVABLE", side: "DEBIT", amount: 11500, gross: null, net: null, tax: null, code: null, charge: expect.any(String) },
      { account: "BOOKING_REVENUE", side: "CREDIT", amount: 10000, gross: 11500, net: 10000, tax: 1500, code: "GST_INCLUSIVE_1500BP", charge: expect.any(String) },
      { account: "GST_PAYABLE", side: "CREDIT", amount: 1500, gross: null, net: null, tax: null, code: null, charge: expect.any(String) },
    ]);
    const bridged = await app.query(`SELECT count(*)::int AS n FROM "MemberMoneySourcePosting" p
      JOIN "MemberMoneySourceLink" s ON s.id = p."sourceLinkId" WHERE s."bookingLedgerLineId" = $1`, [legacy]);
    expect(bridged.rows).toEqual([{ n: 2 }]);
    expect(await verified()).toEqual({ findings: [], grantCheck: "checked" });
  });

  it("commits an ADJUSTMENT mirroring a component at its frozen split, against the earlier obligation", async () => {
    const charge = bookingChargePlan({ eventKey: key("charge"), debtor: MEMBER, grossCents: 23000, chargeIdentity: "nights:2026-07-02" });
    await post(charge);
    // R02 style: reverse one component of 11500 at the cents it was posted with.
    const posted = await post({
      kind: "ADJUSTMENT", eventKey: key("modification"), origin: "APP", reason: "test reduction",
      source: { kind: "BOOKING", id: "modification-4626", version: "1" },
      legs: [
        { type: "revenue", account: "BOOKING_REVENUE", side: "DEBIT", grossCents: 11500, chargeIdentity: "nights:2026-07-02",
          frozenTax: { grossCents: 11500, netCents: 10000, taxCents: 1500, taxCode: "GST_INCLUSIVE_1500BP" }, evidence: { reverses: "nights:2026-07-02" } },
        { type: "amount", account: "MEMBER_RECEIVABLE", side: "CREDIT", amountCents: 11500, debtor: MEMBER,
          obligationKey: charge.obligations![0]!.key, chargeIdentity: "nights:2026-07-02", evidence: {} },
      ],
    });
    expect((await legs(posted.journalId)).map(({ account, side, amount }) => [account, side, amount])).toEqual([
      ["MEMBER_RECEIVABLE", "CREDIT", 11500], ["BOOKING_REVENUE", "DEBIT", 10000], ["GST_PAYABLE", "DEBIT", 1500],
    ]);
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
    expect(await counts()).toEqual(before);
  });

  it("refuses a changed payload under a posted key, and rolls back", async () => {
    const plan = bookingChargePlan({ eventKey: key("conflict"), debtor: MEMBER, grossCents: 4600 });
    await post(plan);
    const before = await counts();
    const changed = bookingChargePlan({ eventKey: plan.eventKey, debtor: MEMBER, grossCents: 4700 });
    await expect(post(changed)).rejects.toBeInstanceOf(MemberMoneyPostingConflictError);
    await expect(post({ ...plan, reason: "a different reason" })).rejects.toMatchObject({
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

  it("commits an exact REVERSAL of a whole batch, replays it, and the database refuses a second", async () => {
    const original = await post(bookingChargePlan({ eventKey: key("reversed"), debtor: MEMBER, grossCents: 11500, booking: BOOKING }));
    const plan = { reversesJournalId: original.journalId, origin: "OFFICER" as const, reason: "posted in error",
      source: { kind: "OFFICER_FACT" as const, id: `correction-${original.journalId}`, version: "1" } };
    const reversal = await appPrisma.$transaction((tx) => reverseMemberMoneyJournal(tx, context, plan));
    const swapped = (await legs(original.journalId)).map((leg) => ({ ...leg, side: leg.side === "DEBIT" ? "CREDIT" : "DEBIT" }));
    expect(await legs(reversal.journalId)).toEqual(expect.arrayContaining(swapped));
    expect(await verified()).toEqual({ findings: [], grantCheck: "checked" });
    const again = await appPrisma.$transaction((tx) => reverseMemberMoneyJournal(tx, context, plan));
    expect(again).toEqual({ ...reversal, replayed: true });
    await expect(appPrisma.$transaction((tx) => reverseMemberMoneyJournal(tx, context, { ...plan, eventKey: key("second-reversal"),
      source: { ...plan.source, version: "2" } }))).rejects.toMatchObject({ code: "P2002" });
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
