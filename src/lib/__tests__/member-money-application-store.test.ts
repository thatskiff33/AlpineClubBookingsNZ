/** Unit witnesses for the inert M4a paths: run the real builder, store and caps.
 * The realdb suite separately proves PostgreSQL locking and deferred checks. */
import type { Prisma } from "@prisma/client";
import { describe, expect, it, vi } from "vitest";
import { memberMoneyEventKeys as keys, postMemberMoneyEvent, releaseMemberMoneyRefundReservation, type MemberMoneyPlan } from "@/lib/member-money";
import type { ApplicationState } from "@/lib/member-money/internal/application-state";
import { reserveMemberMoneyRefund, readMemberMoneyJournalToReverse } from "@/lib/member-money/internal/store";
import { memberMoneyTestContext } from "./support/member-money-fixtures";

const context = memberMoneyTestContext();
const debtor = { kind: "MEMBER", memberId: "member" } as const;
const booking = { bookingId: "booking", lodgeId: "lodge" };
const refundKey = keys.refundObligation("cancellation", booking.bookingId);
function state(): ApplicationState {
  return {
    sources: [{ id: "receipt", sourceKind: "PAYMENT", account: "MEMBER_RECEIVABLE", side: "CREDIT", amountCents: 100,
      debtorKind: "MEMBER", memberId: "member", organisationId: null, currency: "NZD", bookingId: "booking", obligationId: null, capture: "capture", reversed: false }],
    obligations: [{ id: "refund-obligation", key: refundKey, kind: "REFUND", faceCents: 100,
      debtorKind: "MEMBER", memberId: "member", organisationId: null, currency: "NZD" },
    { id: "charge-obligation", key: "charge", kind: "CHARGE", faceCents: 100,
      debtorKind: "MEMBER", memberId: "member", organisationId: null, currency: "NZD" }],
    applications: [], reservations: [],
  };
}
const application = (obligationKey: string = refundKey): MemberMoneyPlan => ({
  kind: "ZERO", eventKey: keys.refundFunding("attempt"), origin: "APP", source: { kind: "OFFICER_FACT", id: "fact", version: "1" }, reason: "attribute receipt",
  applications: [{ key: "application", source: { lineId: "receipt" }, obligationKey, amountCents: 60 }],
});
const reservationPlan = () => ({ ...booking, attemptKey: "attempt", obligationKey: refundKey, stripePaymentIntentId: "capture",
  paymentTransactionId: "transaction", amountCents: 60, fundingJournalId: "funding" });
const reservation = () => ({ id: "reservation", ...reservationPlan(), obligationId: "refund-obligation", release: null,
  obligation: { obligationKey: refundKey } });
const fundingApplication = { id: "fund", applicationKey: "fund-key", sourceLineId: "receipt", obligationId: "refund-obligation", amountCents: 60,
  reversesApplicationId: null, obligation: { obligationKey: refundKey as string, kind: "REFUND" } };

/** Raw projection returns a fresh snapshot; every read and insert stays observable. */
function database(initial = state()) {
  const order: string[] = [];
  const insert = (table: string) => vi.fn(async (input: unknown) => { void input; order.push(table); return { count: 1 }; });
  const db = {
    $executeRaw: vi.fn<(sql: TemplateStringsArray, ...values: unknown[]) => Promise<number>>(async () => { order.push("payment-lock"); return 1; }),
    $queryRaw: vi.fn(async () => { order.push("projection"); return [{ state: structuredClone(initial) }]; }),
    memberMoneyEvent: { findUnique: vi.fn(async () => null), createMany: insert("event") },
    memberMoneyJournal: { createMany: insert("journal"), findFirst: vi.fn(async () => null), findUnique: vi.fn() },
    memberMoneySourceLink: { createMany: insert("source") },
    memberMoneyLine: { createMany: insert("line"), findMany: vi.fn(async (input: { where: { id?: unknown } }) => input.where.id
      ? [{ bookingId: "booking" }]
      : [{ account: "BOOKING_REVENUE", chargeIdentity: "nights", side: "CREDIT", amountCents: 100,
        grossCents: 100, netCents: 100, taxCents: 0, taxCode: "EXEMPT", ...booking }]) },
    memberMoneyObligation: { createMany: insert("obligation"), findMany: vi.fn(async () => initial.obligations.map((o) => ({ ...o, obligationKey: o.key }))) },
    memberMoneyApplication: { createMany: insert("application"), findMany: vi.fn(async () => [fundingApplication]) },
    memberMoneyRefundReservation: { findUnique: vi.fn(), createMany: insert("reservation") },
    memberMoneyRefundReservationRelease: { createMany: insert("release") },
    paymentTransaction: { findUnique: vi.fn(async () => ({ stripePaymentIntentId: "capture", payment: { bookingId: "booking" } })) },
    paymentRefund: { findUnique: vi.fn(async () => ({ stripePaymentIntentId: "capture", payment: { bookingId: "booking" } })) },
  };
  return { db, tx: db as unknown as Prisma.TransactionClient, order };
}
function fundedState() {
  const s = state();
  s.applications.push({ id: "fund", sourceLineId: "receipt", obligationId: "refund-obligation", amountCents: 60, reversesApplicationId: null });
  return s;
}
function reservedState() {
  const s = fundedState();
  s.reservations.push({ id: "reservation", attemptKey: "attempt", obligationId: "refund-obligation", capture: "capture", amountCents: 60 });
  return s;
}
const refund = (): MemberMoneyPlan => ({
  kind: "REFUND", eventKey: keys.refund("refund"), origin: "STRIPE", source: { kind: "REFUND", id: "refund", version: "1" }, reason: "answer reservation",
  legs: [
    { type: "amount", account: "REFUND_PAYABLE", side: "DEBIT", amountCents: 60, debtor, booking, obligationKey: refundKey, evidence: {} },
    { type: "amount", account: "STRIPE_CLEARING", side: "CREDIT", amountCents: 60, booking, evidence: {} },
  ], applications: [{ key: "pay", source: { leg: 0 }, obligationKey: refundKey, amountCents: 60, reservationAttemptKey: "attempt" }],
});

describe("M4a application store", () => {
  it("locks Payment before the snapshot and inserts an external-source fund exactly", async () => {
    const { db, tx, order } = database();
    await postMemberMoneyEvent(tx, context, application());
    expect(order).toEqual(["payment-lock", "projection", "event", "journal", "source", "application"]);
    expect(db.$executeRaw.mock.calls[0]?.[0]).toEqual(expect.arrayContaining([expect.stringContaining('FROM "Payment"')]));
    expect(db.memberMoneyApplication.createMany).toHaveBeenCalledWith({ data: [expect.objectContaining({
      applicationKey: "application", sourceLineId: "receipt", obligationId: "refund-obligation", amountCents: 60, reversesApplicationId: null,
    })] });
  });

  it("posts an in-batch receipt application against the exact charge obligation", async () => {
    const { db, tx } = database();
    const plan: MemberMoneyPlan = { kind: "RECEIPT", eventKey: keys.capture("capture"), origin: "STRIPE",
      source: { kind: "PAYMENT", id: "transaction", version: "1" }, reason: "capture", legs: [
        { type: "amount", account: "STRIPE_CLEARING", side: "DEBIT", amountCents: 60, booking, evidence: {} },
        { type: "amount", account: "MEMBER_RECEIVABLE", side: "CREDIT", amountCents: 60, booking, debtor, evidence: {} },
      ], applications: [{ key: "collect", source: { leg: 1 }, obligationKey: "charge", amountCents: 60 }] };
    await postMemberMoneyEvent(tx, context, plan);
    const lines = db.memberMoneyLine.createMany.mock.calls[0][0] as { data: { id: string; account: string }[] };
    expect(db.memberMoneyApplication.createMany).toHaveBeenCalledWith({ data: [expect.objectContaining({
      sourceLineId: lines.data.find((l) => l.account === "MEMBER_RECEIVABLE")!.id, obligationId: "charge-obligation", amountCents: 60,
    })] });
    expect(db.paymentTransaction.findUnique).toHaveBeenCalledWith(expect.objectContaining({ where: { id: "transaction" } }));
  });

  it("funds a new refund obligation in its creating batch and persists its generated id", async () => {
    const { db, tx } = database();
    const key = keys.refundObligation("review", "task");
    await postMemberMoneyEvent(tx, context, { kind: "REFUND_OBLIGATION", eventKey: key, origin: "APP",
      source: { kind: "OFFICER_FACT", id: "new-refund", version: "1" }, reason: "refund owed",
      obligations: [{ key, kind: "REFUND", debtor, faceCents: 60, evidence: {} }], legs: [
        { type: "amount", account: "MEMBER_RECEIVABLE", side: "DEBIT", amountCents: 60, debtor, booking, evidence: {} },
        { type: "amount", account: "REFUND_PAYABLE", side: "CREDIT", amountCents: 60, debtor, booking, obligationKey: key, evidence: {} },
      ], applications: [{ key: "fund-new", source: { lineId: "receipt" }, obligationKey: key, amountCents: 60 }] });
    const obligations = db.memberMoneyObligation.createMany.mock.calls[0][0] as { data: { id: string; obligationKey: string }[] };
    expect(obligations.data[0].obligationKey).toBe(key);
    expect(db.memberMoneyApplication.createMany).toHaveBeenCalledWith({ data: [expect.objectContaining({
      sourceLineId: "receipt", obligationId: obligations.data[0].id, amountCents: 60,
    })] });
  });

  it.each([0, 2])("refuses when Payment lock matched %i rows, before reading the projection", async (count) => {
    const { db, tx, order } = database(); db.$executeRaw.mockResolvedValue(count);
    await expect(postMemberMoneyEvent(tx, context, application())).rejects.toThrow(/no unique Payment/);
    expect(db.$queryRaw).not.toHaveBeenCalled(); expect(order).toEqual([]);
  });

  it.each(["source", "obligation", "debtor", "currency", "reversed", "C1", "C2", "booking"])("refuses %s violations before inserts", async (problem) => {
    const s = state();
    if (problem === "source") s.sources = [];
    if (problem === "obligation") s.obligations = [];
    if (problem === "debtor") s.sources[0].memberId = "someone-else";
    if (problem === "currency") { s.sources[0].currency = "USD"; s.obligations.forEach((o) => { o.currency = "USD"; }); }
    if (problem === "reversed") s.sources[0].reversed = true;
    if (problem === "C1") s.sources[0].amountCents = 59;
    const { db, tx } = database(s);
    if (problem === "C2") db.memberMoneyLine.findMany.mockImplementation(async (input) => input.where.id ? [{ bookingId: "booking" }] : []);
    if (problem === "booking") db.memberMoneyLine.findMany.mockResolvedValue([]);
    const message = { source: /does not belong/, obligation: /does not belong/, debtor: /mismatch/, currency: /mismatch/,
      reversed: /reversed source/, C1: /C1_source_cap/, C2: /C2: collect/, booking: /exactly one booking/ }[problem];
    await expect(postMemberMoneyEvent(tx, context, application(problem === "C2" ? "charge" : refundKey))).rejects.toThrow(message);
    expect(db.memberMoneyEvent.createMany).not.toHaveBeenCalled();
    expect(db.memberMoneyApplication.createMany).not.toHaveBeenCalled();
  });

  it("answers a reservation with exact persisted application and refund identities", async () => {
    const { db, tx, order } = database(reservedState());
    await postMemberMoneyEvent(tx, context, refund());
    const inserted = db.memberMoneyApplication.createMany.mock.calls[0][0] as { data: { id: string }[] };
    expect(db.memberMoneyRefundReservationRelease.createMany).toHaveBeenCalledWith({ data: [expect.objectContaining({
      reservationId: "reservation", reason: "ANSWERED", applicationId: inserted.data[0].id, stripeRefundId: "refund",
    })] });
    expect(order.indexOf("release")).toBeGreaterThan(order.indexOf("application"));
  });

  it.each(["missing", "capture", "amount", "family", "no-key", "wrong-booking"])("refuses a refund answer with %s mismatch", async (problem) => {
    const s = reservedState();
    if (problem === "missing") s.reservations = [];
    if (problem === "capture") s.reservations[0].capture = "another-capture";
    if (problem === "amount") s.reservations[0].amountCents = 59;
    if (problem === "family") s.reservations[0].obligationId = "charge-obligation";
    const plan = refund();
    if (problem === "no-key") plan.applications = plan.applications!.map((a) => ({ ...a, reservationAttemptKey: undefined }));
    const { db, tx } = database(s);
    if (problem === "wrong-booking") db.paymentRefund.findUnique.mockResolvedValue({ stripePaymentIntentId: "capture", payment: { bookingId: "other" } });
    await expect(postMemberMoneyEvent(tx, context, plan)).rejects.toThrow();
    expect(db.memberMoneyEvent.createMany).not.toHaveBeenCalled();
  });

  it("reverses an exact external application and refuses a second reversal", async () => {
    const s = fundedState();
    const plan = application();
    plan.applications = plan.applications!.map((a) => ({ ...a, reversesApplicationId: "fund" }));
    const ok = database(s);
    await postMemberMoneyEvent(ok.tx, context, plan);
    expect(ok.db.memberMoneyApplication.createMany).toHaveBeenCalledWith({ data: [expect.objectContaining({ reversesApplicationId: "fund", amountCents: 60 })] });
    s.applications.push({ ...s.applications[0], id: "undo", reversesApplicationId: "fund" });
    const again = database(s);
    await expect(postMemberMoneyEvent(again.tx, context, plan)).rejects.toThrow(/exact unreversed/);
    expect(again.db.memberMoneyEvent.createMany).not.toHaveBeenCalled();
  });
});

describe("M4a refund reservation store", () => {
  it("persists exact funded cents and replays only identical economics", async () => {
    const { db, tx, order } = database(fundedState());
    const result = await reserveMemberMoneyRefund(tx, reservationPlan());
    expect(result.replayed).toBe(false);
    expect(order).toEqual(["payment-lock", "projection", "reservation"]);
    expect(db.memberMoneyRefundReservation.createMany).toHaveBeenCalledWith({ data: [{
      id: result.id, attemptKey: "attempt", obligationId: "refund-obligation", stripePaymentIntentId: "capture",
      paymentTransactionId: "transaction", amountCents: 60, fundingJournalId: "funding",
    }] });
    db.memberMoneyRefundReservation.findUnique.mockResolvedValue(reservation());
    expect(await reserveMemberMoneyRefund(tx, reservationPlan())).toEqual({ id: "reservation", replayed: true });
    for (const change of [{ obligationKey: "other" }, { stripePaymentIntentId: "other" }, { paymentTransactionId: "other" }, { amountCents: 59 }, { fundingJournalId: "other" }]) {
      await expect(reserveMemberMoneyRefund(tx, { ...reservationPlan(), ...change })).rejects.toThrow(/payload differs/);
    }
    expect(db.memberMoneyRefundReservation.createMany).toHaveBeenCalledTimes(1);
  });

  it.each([0, -1, 1.5, Number.MAX_SAFE_INTEGER, NaN])("refuses invalid cents %s", async (amountCents) => {
    const { db, tx } = database(fundedState());
    await expect(reserveMemberMoneyRefund(tx, { ...reservationPlan(), amountCents })).rejects.toThrow(/positive integer cents/);
    expect(db.memberMoneyRefundReservation.createMany).not.toHaveBeenCalled();
  });

  it.each(["obligation", "capture", "booking", "funding", "reversed-funding", "overspend", "empty-key"])("refuses %s before reserving", async (problem) => {
    const s = problem === "overspend" ? reservedState() : fundedState();
    if (problem === "obligation") s.obligations = [];
    const { db, tx } = database(s);
    if (problem === "capture") db.paymentTransaction.findUnique.mockResolvedValue({ stripePaymentIntentId: "other", payment: { bookingId: "booking" } });
    if (problem === "booking") db.paymentTransaction.findUnique.mockResolvedValue({ stripePaymentIntentId: "capture", payment: { bookingId: "other" } });
    if (problem === "funding") db.memberMoneyApplication.findMany.mockResolvedValue([]);
    if (problem === "reversed-funding") db.memberMoneyJournal.findFirst.mockResolvedValue({ id: "reversal" } as never);
    await expect(reserveMemberMoneyRefund(tx, { ...reservationPlan(), attemptKey: problem === "empty-key" ? "" : "next-attempt" })).rejects.toThrow();
    expect(db.memberMoneyRefundReservation.createMany).not.toHaveBeenCalled();
  });

  it("appends release before reversing funding, in the supplied transaction", async () => {
    const { db, tx, order } = database(fundedState());
    db.memberMoneyRefundReservation.findUnique.mockResolvedValue(reservation());
    db.memberMoneyJournal.findUnique.mockResolvedValue({ id: "funding", currency: "NZD", policyVersion: "p", codingVersion: "c",
      lines: [], applications: [fundingApplication] });
    await releaseMemberMoneyRefundReservation(tx, context, { bookingId: "booking", reservationId: "reservation", reason: "SUPERSEDED_KEY",
      source: { kind: "OFFICER_FACT", id: "release", version: "1" } });
    expect(order.indexOf("release")).toBeLessThan(order.indexOf("event"));
    expect(db.memberMoneyRefundReservationRelease.createMany).toHaveBeenCalledWith({ data: [{ reservationId: "reservation", reason: "SUPERSEDED_KEY" }] });
    expect(db.memberMoneyApplication.createMany).toHaveBeenCalledWith({ data: [expect.objectContaining({ reversesApplicationId: "fund", amountCents: 60 })] });
  });

  it.each(["missing", "booking", "reason", "replay"])("handles %s releases without another write", async (problem) => {
    const s = fundedState(); if (problem === "booking") s.obligations = [];
    const { db, tx } = database(s);
    db.memberMoneyRefundReservation.findUnique.mockResolvedValue(problem === "missing" ? null : { ...reservation(),
      release: problem === "reason" ? { reason: "DEFINITIVE_FAILURE" } : problem === "replay" ? { reason: "SUPERSEDED_KEY" } : null });
    const pending = releaseMemberMoneyRefundReservation(tx, context, { bookingId: "booking", reservationId: "reservation", reason: "SUPERSEDED_KEY",
      source: { kind: "OFFICER_FACT", id: "release", version: "1" } });
    if (problem === "replay") await expect(pending).resolves.toBeUndefined(); else await expect(pending).rejects.toThrow();
    expect(db.memberMoneyRefundReservationRelease.createMany).not.toHaveBeenCalled();
    expect(db.memberMoneyJournal.findUnique).not.toHaveBeenCalled();
  });
});

describe("M4a receipt reversal projection", () => {
  it("includes later collect applications once, but refuses live refund funding", async () => {
    const { db, tx, order } = database();
    const collect = { ...fundingApplication, obligation: { obligationKey: "charge", kind: "CHARGE" } };
    db.memberMoneyJournal.findUnique.mockResolvedValue({ id: "receipt-journal", currency: "NZD", policyVersion: "p", codingVersion: "c",
      applications: [], lines: [{ id: "receipt", account: "MEMBER_RECEIVABLE", side: "CREDIT", bookingId: "booking", obligation: null, evidence: {} }] });
    db.memberMoneyApplication.findMany.mockResolvedValue([collect]);
    const original = await readMemberMoneyJournalToReverse(tx, "receipt-journal");
    expect(original.applications).toEqual([{ id: "fund", key: "fund-key", source: { lineId: "receipt" }, obligationKey: "charge", amountCents: 60, reversesApplicationId: null }]);
    expect(order).toEqual(["payment-lock"]);
    expect((await readMemberMoneyJournalToReverse(tx, "receipt-journal")).applications).toHaveLength(1);
    db.memberMoneyApplication.findMany.mockResolvedValue([fundingApplication]);
    await expect(readMemberMoneyJournalToReverse(tx, "receipt-journal")).rejects.toThrow(/fund application/);
  });
});
