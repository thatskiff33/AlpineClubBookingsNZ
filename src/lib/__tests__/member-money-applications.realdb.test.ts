import type { PrismaClient } from "@prisma/client";
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { MemberMoneyReservationRefused, memberMoneyEventKeys as keys, postMemberMoneyEvent, reverseMemberMoneyJournal, reserveMemberMoneyRefund, releaseMemberMoneyRefundReservation, verifyMemberMoneyJournal, type MemberMoneyPlan } from "@/lib/member-money";
import { readMemberMoneyApplicationState } from "@/lib/member-money/internal/application-read";
import { bookingChargePlan, createMemberMoneyScratchDatabase, memberMoneyTestContext, type MemberMoneyScratchDatabase } from "./support/member-money-fixtures";

const RUN = process.env.RUN_CONCURRENCY_RACE_TESTS === "1";
const context = memberMoneyTestContext();
const debtor = { kind: "MEMBER", memberId: "m4691" } as const;
const booking = { bookingId: "b4691", lodgeId: "l4691" };
const obligationKey = keys.refundObligation("cancellation", booking.bookingId);
let scratch: MemberMoneyScratchDatabase;
let prisma: PrismaClient;
let app: Client;
let serial = 0;
const source = () => ({ kind: "OFFICER_FACT" as const, id: `fact-${++serial}`, version: "1" });
const post = (plan: MemberMoneyPlan) => prisma.$transaction((tx) => postMemberMoneyEvent(tx, context, plan));
const apply = (event: string, lineId: string, obligation: string, amountCents: number): MemberMoneyPlan => ({
  kind: "ZERO", eventKey: keys.refundFunding(event), origin: "APP", source: source(), reason: "exact attribution",
  applications: [{ key: `${event}:apply`, source: { lineId }, obligationKey: obligation, amountCents }],
});
let receiptLine: string;
let receiptJournal: string;
let fundingJournal: string;
let reservationId: string;
const reserve = (attemptKey = "attempt:one", amountCents = 60) => prisma.$transaction((tx) => reserveMemberMoneyRefund(tx, {
  bookingId: booking.bookingId, attemptKey, obligationKey, stripePaymentIntentId: "capture4691", paymentTransactionId: "transaction4691", amountCents, fundingJournalId: fundingJournal,
}));

(RUN ? describe : describe.skip)("M4a application engine with INSERT/SELECT role", () => {
  beforeAll(async () => {
    scratch = await createMemberMoneyScratchDatabase(process.env.CONCURRENCY_RACE_DATABASE_URL ?? "", "member money M4a");
    await scratch.owner.query(`INSERT INTO "Lodge" VALUES ($1);`, [booking.lodgeId]);
    await scratch.owner.query(`INSERT INTO "Booking" VALUES ($1,$2)`, [booking.bookingId, booking.lodgeId]);
    await scratch.owner.query(`INSERT INTO "Payment" VALUES ('payment4691',$1)`, [booking.bookingId]);
    await scratch.owner.query(`INSERT INTO "PaymentTransaction" VALUES ('transaction4691','payment4691','capture4691')`);
    const { PrismaClient: Prisma } = await import("@prisma/client");
    const { createPrismaPgAdapter } = await import("@/lib/prisma-adapter");
    prisma = new Prisma({ adapter: createPrismaPgAdapter(scratch.appUrl) });
    app = new Client({ connectionString: scratch.appUrl }); await app.connect();
    await post(bookingChargePlan({ eventKey: keys.bookingCharge(booking.bookingId), debtor, grossCents: 100, booking }));
    await post({ kind: "REFUND_OBLIGATION", eventKey: obligationKey, origin: "APP", source: source(), reason: "refund owed",
      obligations: [{ key: obligationKey, kind: "REFUND", debtor, faceCents: 100, evidence: {} }], legs: [
        { type: "amount", account: "MEMBER_RECEIVABLE", side: "DEBIT", amountCents: 100, debtor, booking, evidence: {} },
        { type: "amount", account: "REFUND_PAYABLE", side: "CREDIT", amountCents: 100, debtor, obligationKey, booking, evidence: {} },
      ] });
    const receipt = await post({ kind: "RECEIPT", eventKey: keys.capture("capture4691"), origin: "STRIPE", source: { kind: "PAYMENT", id: "transaction4691", version: "1" }, reason: "captured", legs: [
      { type: "amount", account: "STRIPE_CLEARING", side: "DEBIT", amountCents: 100, booking, evidence: {} },
      { type: "amount", account: "MEMBER_RECEIVABLE", side: "CREDIT", amountCents: 100, debtor, booking, evidence: {} },
    ] });
    receiptJournal = receipt.journalId;
    receiptLine = (await prisma.memberMoneyLine.findFirstOrThrow({ where: { journalId: receipt.journalId, account: "MEMBER_RECEIVABLE" }, select: { id: true } })).id;
  });
  afterAll(async () => { await prisma?.$disconnect(); await app?.end(); await scratch?.drop(); });

  it("serializes two distinct application events on Payment before checking C1", async () => {
    await app.query("BEGIN");
    await app.query('SELECT 1 FROM "Payment" WHERE "bookingId"=$1 FOR NO KEY UPDATE', [booking.bookingId]);
    const pending = post(apply("fund-one", receiptLine, obligationKey, 60));
    try {
      await expect.poll(async () => Number((await scratch.owner.query(`SELECT count(*) AS waiting FROM pg_stat_activity
        WHERE datname = current_database() AND wait_event_type = 'Lock' AND query LIKE '%FOR NO KEY UPDATE%'`)).rows[0].waiting), { timeout: 2000 }).toBeGreaterThan(0);
    } finally { await app.query("ROLLBACK"); }
    const first = await pending; fundingJournal = first.journalId;
    await expect(post(apply("fund-too-much", receiptLine, obligationKey, 41))).rejects.toThrow(/C1/);
    expect((await prisma.memberMoneyApplication.findMany()).length).toBe(1);
  });
  it("reserves once, rejects mismatched replays and rejects instrument over-spend", async () => {
    const first = await reserve(); reservationId = first.id;
    expect(await reserve()).toEqual({ id: first.id, replayed: true });
    await expect(reserve("attempt:one", 59)).rejects.toThrow(/payload differs/);
    const overSpend = await reserve("attempt:two").then(() => null, (error: unknown) => error);
    expect(overSpend).toBeInstanceOf(MemberMoneyReservationRefused);
    expect((overSpend as Error).message).toMatch(/C3|C4/);
    await expect(prisma.$transaction((tx) => reverseMemberMoneyJournal(tx, context, { reversesJournalId: receiptJournal, origin: "APP", source: source(), reason: "cannot reverse funded receipt" }))).rejects.toThrow(/fund application/);
    await expect(prisma.$transaction((tx) => reverseMemberMoneyJournal(tx, context, { reversesJournalId: fundingJournal, origin: "APP", source: source(), reason: "funding still reserved" }))).rejects.toThrow(/C4/);
    const funding = await prisma.memberMoneyJournal.findUniqueOrThrow({ where: { id: fundingJournal }, include: { event: true, applications: true } });
    const application = funding.applications[0]!;
    await app.query("BEGIN");
    try {
      await app.query(`INSERT INTO "MemberMoneyEvent" (id,"eventKey",kind,origin,"sourceKind","sourceIdentity","sourceVersion","payloadHash",reason,"effectiveAt","effectiveDate")
        VALUES ('reverse-funding-event','reversal:funding-open','REVERSAL','APP','OFFICER_FACT','reverse-funding-fact','1',repeat('b',64),'direct reversal',$1,$2)`,
        [funding.event.effectiveAt, funding.event.effectiveDate]);
      await app.query(`INSERT INTO "MemberMoneyJournal" (id,"eventId",currency,"policyVersion","codingVersion","expectedLineCount","expectedObligationCount","expectedApplicationCount","reversesJournalId")
        VALUES ('reverse-funding-journal','reverse-funding-event',$1,$2,$3,0,0,1,$4)`,
        [funding.currency, funding.policyVersion, funding.codingVersion, fundingJournal]);
      await app.query(`INSERT INTO "MemberMoneySourceLink" (id,"journalId","sourceKind","sourceId","sourceVersion")
        VALUES ('reverse-funding-source','reverse-funding-journal','OFFICER_FACT','reverse-funding-fact','1')`);
      await app.query(`INSERT INTO "MemberMoneyApplication" (id,"applicationKey","journalId","sourceLineId","obligationId","amountCents","reversesApplicationId")
        VALUES ('reverse-funding-application','reversal:funding-open','reverse-funding-journal',$1,$2,$3,$4)`,
        [application.sourceLineId, application.obligationId, application.amountCents, application.id]);
      await expect(app.query("COMMIT")).rejects.toThrow(/open_reservation_without_funding/);
    } finally { await app.query("ROLLBACK"); }
  });
  it("releases and reverses its funding atomically, allowing a new exact attempt", async () => {
    await prisma.$transaction((tx) => releaseMemberMoneyRefundReservation(tx, context, { bookingId: booking.bookingId, reservationId, reason: "SUPERSEDED_KEY", source: source() }));
    const state = await prisma.$transaction((tx) => readMemberMoneyApplicationState(tx, booking.bookingId));
    expect(state.reservations).toEqual([]);
    fundingJournal = (await post(apply("fund-new", receiptLine, obligationKey, 60))).journalId;
    reservationId = (await reserve("attempt:new")).id;
  });
  it("answers a reservation atomically and copies the pay application on reversal", async () => {
    await scratch.owner.query(`INSERT INTO "PaymentRefund" VALUES ('refund-row','refund4691','capture4691','payment4691')`);
    const plan: MemberMoneyPlan = { kind: "REFUND", eventKey: keys.refund("refund4691"), origin: "STRIPE", source: { kind: "REFUND", id: "refund4691", version: "1" }, reason: "refund accepted", legs: [
      { type: "amount", account: "REFUND_PAYABLE", side: "DEBIT", amountCents: 60, debtor, obligationKey, booking, evidence: {} },
      { type: "amount", account: "STRIPE_CLEARING", side: "CREDIT", amountCents: 60, booking, evidence: {} },
    ], applications: [{ key: "refund4691:pay", source: { leg: 0 }, obligationKey, amountCents: 60, reservationAttemptKey: "attempt:new" }] };
    const paid = await post(plan);
    expect((await prisma.memberMoneyRefundReservationRelease.findUniqueOrThrow({ where: { reservationId } })).reason).toBe("ANSWERED");
    await prisma.$transaction((tx) => reverseMemberMoneyJournal(tx, context, { reversesJournalId: paid.journalId, origin: "APP", source: source(), reason: "failed later" }));
    const state = await prisma.$transaction((tx) => readMemberMoneyApplicationState(tx, booking.bookingId));
    expect(state.applications.filter((a) => a.reversesApplicationId !== null)).toHaveLength(2);
  });
  it("retains cash unapplied and refuses collect beyond the live charge (C2)", async () => {
    const cash = await post({ kind: "RECEIPT", eventKey: keys.receipt("cash", "line"), origin: "OFFICER", source: source(), reason: "cash", legs: [
      { type: "amount", account: "CASH", side: "DEBIT", amountCents: 200, booking, evidence: {} },
      { type: "amount", account: "MEMBER_RECEIVABLE", side: "CREDIT", amountCents: 200, debtor, booking, evidence: {} },
    ] });
    const line = await prisma.memberMoneyLine.findFirstOrThrow({ where: { journalId: cash.journalId, account: "MEMBER_RECEIVABLE" } });
    await expect(post(apply("collect-too-much", line.id, `${keys.bookingCharge(booking.bookingId)}:obligation`, 101))).rejects.toThrow(/C2/);
    await post(apply("collect-open", line.id, `${keys.bookingCharge(booking.bookingId)}:obligation`, 100));
  });
  it("the database refuses a direct-SQL source over-application in a fresh complete batch", async () => {
    const obligation = await prisma.memberMoneyObligation.findUniqueOrThrow({ where: { obligationKey } });
    await app.query("BEGIN");
    try {
      await app.query(`INSERT INTO "MemberMoneyEvent" (id,"eventKey",kind,origin,"sourceKind","sourceIdentity","sourceVersion","payloadHash",reason,"effectiveAt","effectiveDate")
        VALUES ('raw-event','raw-over','ZERO','APP','OFFICER_FACT','raw','1',repeat('a',64),'probe','2026-07-01T00:00:00Z','2026-07-01')`);
      await app.query(`INSERT INTO "MemberMoneyJournal" (id,"eventId",currency,"policyVersion","codingVersion","expectedLineCount","expectedObligationCount","expectedApplicationCount")
        VALUES ('raw-journal','raw-event','NZD','p','c',0,0,1)`);
      await app.query(`INSERT INTO "MemberMoneySourceLink" (id,"journalId","sourceKind","sourceId","sourceVersion") VALUES ('raw-source','raw-journal','OFFICER_FACT','raw','1')`);
      await app.query(`INSERT INTO "MemberMoneyApplication" (id,"applicationKey","journalId","sourceLineId","obligationId","amountCents") VALUES ('raw-application','raw-over','raw-journal',$1,$2,41)`, [receiptLine, obligation.id]);
      await expect(app.query("COMMIT")).rejects.toThrow(/application_source_cap/);
    } finally { await app.query("ROLLBACK"); }
  });
  it("verifies population-wide conservation and exact database definitions", async () => {
    await app.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
    try { expect(await verifyMemberMoneyJournal(app, scratch.roles.app)).toEqual({ findings: [], grantCheck: "checked" }); }
    finally { await app.query("ROLLBACK"); }
  });
  it("database backstops reject sealed-batch extensions and immutable-row mutation", async () => {
    await expect(app.query(`UPDATE "MemberMoneyRefundReservation" SET "amountCents"=1`)).rejects.toThrow();
    await app.query("BEGIN");
    try {
      const journal = (await app.query(`SELECT "journalId", "obligationId" FROM "MemberMoneyApplication" WHERE "sourceLineId"=$1 LIMIT 1`, [receiptLine])).rows[0];
      await expect(app.query(`INSERT INTO "MemberMoneyApplication" (id,"applicationKey","journalId","sourceLineId","obligationId","amountCents") VALUES ('late','late',$1,$2,$3,1)`, [journal.journalId, receiptLine, journal.obligationId])).rejects.toThrow(/sealed/);
    } finally { await app.query("ROLLBACK"); }
  });
});
