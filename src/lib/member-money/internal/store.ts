import { randomUUID } from "node:crypto";
import type { MemberMoneyRefundReservationReleaseReason, Prisma } from "@prisma/client";
import { applicationRoleOf, sameApplicationDebtor, memberMoneyConservationProblems, memberMoneyApplicationTotals, type ApplicationState } from "./application-state";
import { lockMemberMoneyPayment, readMemberMoneyApplicationState } from "./application-read";
import { readBookingLiveComponents } from "./booking-journal-read";
import { dateOnlyInstantOf } from "../../club-time";
import { assertGlobalLockHeld } from "../../global-lock-held";
import { stableStringify } from "../../stable-digest";
import {
  completeMemberMoneyBatch,
  componentsPostedBy,
  reversalLiveProblems,
  type PostedRevenueLeg,
} from "./components";
import { isTaxedRevenue } from "./accounts";
import { MemberMoneyPlanError, type BuiltBatch, type MemberMoneyJournalToReverse } from "./plan";

/**
 * THE ONLY PRISMA WRITER OF THE MEMBER-MONEY TABLES (#4626, Ledger M3a).
 * `member-money-journal-inert-census.test.ts` holds that no other file creates
 * a journal row. It writes one built batch in the order the database's
 * immediate foreign keys need: event, journal header, source links,
 * obligations, legs, then the bridge's source postings. The deferred checks
 * run at the caller's commit, so a refused batch rolls the caller's business
 * mutation back with it; nothing here catches that.
 *
 * Run it inside the caller's transaction. Outside one, each insert would commit
 * alone and the event's deferred completeness check refuses the first.
 */

export interface MemberMoneyPosting {
  eventId: string;
  journalId: string;
  /** True when an identical batch was already posted under this event key. */
  replayed: boolean;
}

/** A key already posted with different content: a conflict, never a skip (design section 3). */
export class MemberMoneyPostingConflictError extends Error {
  constructor(readonly eventKey: string, readonly differences: readonly string[]) {
    super(`member-money event ${eventKey} was already posted differently: ${differences.join("; ")}`);
    this.name = "MemberMoneyPostingConflictError";
  }
}

type Db = Prisma.TransactionClient;
type SourceIdentity = { sourceKind: string; sourceId: string; sourceVersion: string; bookingLedgerLineId: string | null };
const identity = (source: SourceIdentity): string => stableStringify(source);

/** Obligation ids by key: those this batch creates, then earlier ones it names. */
async function resolveObligations(db: Db, batch: BuiltBatch): Promise<Map<string, string>> {
  const ids = new Map<string, string>(batch.obligations.map((obligation) => [obligation.key, randomUUID()]));
  const earlier = [...new Set([...batch.lines.flatMap((line) => line.obligationKey ?? []), ...batch.applications.map((a) => a.obligationKey)])].filter((key) => !ids.has(key));
  if (earlier.length === 0) return ids;
  const found = await db.memberMoneyObligation.findMany({
    where: { obligationKey: { in: earlier } },
    select: { id: true, obligationKey: true, debtorKind: true, memberId: true, organisationId: true },
  });
  const byKey = new Map(found.map((row) => [row.obligationKey, row]));
  const problems: string[] = [];
  for (const key of earlier) {
    const row = byKey.get(key);
    if (!row) problems.push(`obligation ${key} does not exist`);
    else ids.set(key, row.id);
  }
  for (const line of batch.lines) {
    const row = line.obligationKey ? byKey.get(line.obligationKey) : undefined;
    if (row && (row.debtorKind !== line.debtorKind || row.memberId !== line.memberId || row.organisationId !== line.organisationId)) {
      problems.push(`a ${line.account} leg names a debtor other than obligation ${row.obligationKey}'s`);
    }
  }
  if (problems.length > 0) throw new MemberMoneyPlanError(problems);
  return ids;
}

/**
 * The batch already posted under the key, compared with this one: identical
 * returns it, any difference is a conflict. `null` when the key is unposted
 * (in this transaction's snapshot), unless `required`.
 */
async function replay(db: Db, batch: BuiltBatch, required: boolean): Promise<MemberMoneyPosting | null> {
  const winner = await db.memberMoneyEvent.findUnique({
    where: { eventKey: batch.event.eventKey },
    select: {
      id: true, payloadHash: true,
      journal: { select: { id: true, sources: { select: { sourceKind: true, sourceId: true, sourceVersion: true, bookingLedgerLineId: true } } } },
    },
  });
  if (!winner && !required) return null;
  if (!winner?.journal) {
    // Only a snapshot older than the winner's commit (REPEATABLE READ or
    // stricter) can miss it; the caller's retry sees it.
    throw new MemberMoneyPostingConflictError(batch.event.eventKey, ["the posted batch is not visible to this transaction's snapshot"]);
  }
  const differences: string[] = [];
  if (winner.payloadHash !== batch.event.payloadHash) differences.push("payload hash differs");
  // A later compatibility link may join a posted batch (INV-MONEY-042), so the
  // posted links must include every link this plan names, not equal them.
  const posted = new Set(winner.journal.sources.map(identity));
  for (const source of batch.sources) {
    const link = { sourceKind: source.kind, sourceId: source.id, sourceVersion: source.version, bookingLedgerLineId: source.bookingLedgerLineId };
    if (!posted.has(identity(link))) differences.push(`source ${source.kind} ${source.id}@${source.version} is not linked`);
  }
  if (differences.length > 0) throw new MemberMoneyPostingConflictError(batch.event.eventKey, differences);
  return { eventId: winner.id, journalId: winner.journal.id, replayed: true };
}

/** Every posted revenue leg of the given components. A read only. */
async function postedComponents(
  db: Db,
  components: readonly { account: PostedRevenueLeg["account"]; chargeIdentity: string }[],
): Promise<PostedRevenueLeg[]> {
  if (components.length === 0) return [];
  return db.memberMoneyLine.findMany({
    where: { OR: components.map(({ account, chargeIdentity }) => ({ account, chargeIdentity })) },
    select: { account: true, chargeIdentity: true, side: true, amountCents: true,
      grossCents: true, netCents: true, taxCents: true, taxCode: true, bookingId: true, lodgeId: true },
  });
}

/**
 * Replay first, so a retry of a correction is recognised even though its
 * component is no longer live; then every read that can refuse the plan; then
 * the first write.
 *
 * A correction, and a reversal of a journal that posted revenue components,
 * read live component state and then write, which only `lock(1)` keeps true
 * until commit (`INV-LOCK-001`). So does a fresh charge of a component that
 * already has posted legs: unlocked, it could race a reversal of that
 * component's correction and double its revenue. All three refuse unless the
 * caller's transaction holds the key; the first charge of a new identity needs
 * none. If a check refuses, the key is looked up once more: a concurrent poster
 * of this same event may have committed in between, and its batch is the answer.
 */
export async function writeMemberMoneyBatch(
  db: Db,
  draft: BuiltBatch,
  reversing?: MemberMoneyJournalToReverse,
): Promise<MemberMoneyPosting> {
  const earlier = await replay(db, draft, false);
  if (earlier) return earlier;
  const reversed = reversing ? componentsPostedBy(reversing) : [];
  const lockNeeded = draft.corrections.length > 0 || reversed.length > 0;
  if (lockNeeded) await assertGlobalLockHeld(db, "A member-money correction or revenue reversal");
  const recharged = reversing ? [] : draft.lines.flatMap(({ account, side, chargeIdentity }) =>
    side === "CREDIT" && chargeIdentity !== null && isTaxedRevenue(account) ? [{ account, chargeIdentity }] : []);
  if (!lockNeeded && recharged.length > 0 && await db.memberMoneyLine.findFirst({
    where: { OR: recharged }, select: { id: true },
  })) {
    await assertGlobalLockHeld(db, "A member-money charge of a component that already has posted legs");
  }
  let batch: BuiltBatch;
  try {
    const posted = await postedComponents(db, [...draft.corrections, ...reversed]);
    batch = completeMemberMoneyBatch(draft, posted);
    const stale = reversing ? reversalLiveProblems(reversing, posted) : [];
    if (stale.length > 0) throw new MemberMoneyPlanError(stale);
  } catch (error) {
    if (!(error instanceof MemberMoneyPlanError)) throw error;
    const winner = await replay(db, draft, false);
    if (winner) return winner;
    throw error;
  }
  const lineIds = batch.lines.map(() => randomUUID());
  const applicationIds = batch.applications.map(() => randomUUID());
  const applicationState = await prepareApplications(db, batch, lineIds, applicationIds);
  const obligationIds = await resolveObligations(db, batch);
  const eventId = randomUUID();
  // Reserve the event key first: ON CONFLICT DO NOTHING waits for a concurrent
  // poster of the same key and then skips, so exactly one batch is written.
  const reserved = await db.memberMoneyEvent.createMany({
    data: [{
      id: eventId,
      eventKey: batch.event.eventKey,
      kind: batch.event.kind,
      origin: batch.event.origin,
      sourceKind: batch.event.sourceKind,
      sourceIdentity: batch.event.sourceIdentity,
      sourceVersion: batch.event.sourceVersion,
      payloadHash: batch.event.payloadHash,
      actorMemberId: batch.event.actorMemberId,
      reason: batch.event.reason,
      effectiveAt: batch.event.effectiveAt,
      effectiveDate: dateOnlyInstantOf(batch.event.effectiveDate),
    }],
    skipDuplicates: true,
  });
  if (reserved.count === 0) return (await replay(db, batch, true))!;

  const journalId = randomUUID();
  await db.memberMoneyJournal.createMany({
    data: [{
      id: journalId,
      eventId,
      currency: batch.journal.currency,
      policyVersion: batch.journal.policyVersion,
      codingVersion: batch.journal.codingVersion,
      expectedLineCount: batch.lines.length,
      expectedObligationCount: batch.obligations.length,
      expectedApplicationCount: batch.applications.length,
      reversesJournalId: batch.journal.reversesJournalId,
    }],
  });
  const sourceIds = batch.sources.map(() => randomUUID());
  await db.memberMoneySourceLink.createMany({
    data: batch.sources.map((source, index) => ({
      id: sourceIds[index]!,
      journalId,
      sourceKind: source.kind,
      sourceId: source.id,
      sourceVersion: source.version,
      bookingLedgerLineId: source.bookingLedgerLineId,
    })),
  });
  if (batch.obligations.length > 0) {
    await db.memberMoneyObligation.createMany({
      data: batch.obligations.map((obligation) => ({
        id: obligationIds.get(obligation.key)!,
        journalId,
        obligationKey: obligation.key,
        kind: obligation.kind,
        debtorKind: obligation.debtorKind,
        memberId: obligation.memberId,
        organisationId: obligation.organisationId,
        faceCents: obligation.faceCents,
        evidence: obligation.evidence as Prisma.InputJsonValue,
      })),
    });
  }
  if (batch.lines.length > 0) {
    await db.memberMoneyLine.createMany({
      data: batch.lines.map(({ source, obligationKey, evidence, ...line }, index) => ({
        ...line,
        id: lineIds[index]!,
        journalId,
        sourceLinkId: sourceIds[source]!,
        obligationId: obligationKey === null ? null : obligationIds.get(obligationKey)!,
        evidence: evidence as Prisma.InputJsonValue,
      })),
    });
  }
  if (batch.applications.length > 0) {
    await db.memberMoneyApplication.createMany({ data: batch.applications.map((application, index) => ({
      id: applicationIds[index]!, applicationKey: application.key, journalId,
      sourceLineId: "lineId" in application.source ? application.source.lineId : lineIds[application.source.line]!,
      obligationId: obligationIds.get(application.obligationKey)!, amountCents: application.amountCents,
      reversesApplicationId: application.reversesApplicationId,
    })) });
    const answered = batch.applications.flatMap((application, index) => {
      if (!application.reservationAttemptKey) return [];
      const reservation = applicationState!.reservations.find((r) => r.attemptKey === application.reservationAttemptKey)!;
      const sourceLine = "lineId" in application.source ? null : batch.lines[application.source.line];
      if (!sourceLine) throw new MemberMoneyPlanError(["an answer must post its own refund leg"]);
      return [{ id: randomUUID(), reservationId: reservation.id, reason: "ANSWERED" as const,
        applicationId: applicationIds[index]!, stripeRefundId: batch.sources[sourceLine.source]!.id }];
    });
    if (answered.length > 0) await db.memberMoneyRefundReservationRelease.createMany({ data: answered });
  }
  const postings = batch.lines.flatMap((line, index) =>
    batch.sources[line.source]!.kind === "BOOKING_LEDGER"
      ? [{ id: randomUUID(), journalId, sourceLinkId: sourceIds[line.source]!, lineId: lineIds[index]! }]
      : []);
  if (postings.length > 0) await db.memberMoneySourcePosting.createMany({ data: postings });
  return { eventId, journalId, replayed: false };
}

/**
 * #4628 (`INV-MONEY-042`): link legacy lines to a batch already posted, without
 * posting another. Source links (and their leg postings) are the one thing the
 * database lets join a sealed batch: no line, obligation or application can.
 * Each line gets a `BOOKING_LEDGER` source link in that journal and, where the
 * journal carries money, a posting naming `receivableLegId`, a leg of that same
 * journal (the database refuses a link to a nonzero journal without one, and a
 * leg of another journal). A line already linked is refused by its unique key,
 * which aborts the caller's transaction: callers link only unbridged lines,
 * under `lock(1)`.
 */
export async function linkLegacyLinesToPostedBatch(
  db: Db,
  input: { journalId: string; receivableLegId: string | null; lines: readonly { id: string; version: string }[] },
): Promise<number> {
  if (input.lines.length === 0) return 0;
  const links = input.lines.map((line) => ({ id: randomUUID(), line }));
  await db.memberMoneySourceLink.createMany({
    data: links.map(({ id, line }) => ({
      id,
      journalId: input.journalId,
      sourceKind: "BOOKING_LEDGER" as const,
      sourceId: line.id,
      sourceVersion: line.version,
      bookingLedgerLineId: line.id,
    })),
  });
  if (input.receivableLegId !== null) {
    await db.memberMoneySourcePosting.createMany({
      data: links.map(({ id }) => ({ id: randomUUID(), journalId: input.journalId, sourceLinkId: id, lineId: input.receivableLegId! })),
    });
  }
  return links.length;
}

/** Read a posted journal, verbatim, for an exact reversal. A read only. */
export async function readMemberMoneyJournalToReverse(db: Db, journalId: string): Promise<MemberMoneyJournalToReverse> {
  const journal = await db.memberMoneyJournal.findUnique({
    where: { id: journalId },
    select: {
      id: true, currency: true, policyVersion: true, codingVersion: true,
      applications: { select: { id: true, applicationKey: true, sourceLineId: true, amountCents: true, reversesApplicationId: true,
        obligation: { select: { obligationKey: true } } } },
      lines: {
        orderBy: { id: "asc" },
        select: {
          id: true, account: true, side: true, amountCents: true, debtorKind: true, memberId: true, organisationId: true,
          bookingId: true, lodgeId: true, creditLotId: true, chargeIdentity: true, refundIdentity: true,
          grossCents: true, netCents: true, taxCents: true, taxCode: true, evidence: true,
          obligation: { select: { obligationKey: true } },
        },
      },
    },
  });
  if (!journal) throw new MemberMoneyPlanError([`journal ${journalId} does not exist`]);
  const sourceIds = journal.lines.filter((l) => l.account === "MEMBER_RECEIVABLE" && l.side === "CREDIT").map((l) => l.id);
  if (sourceIds.length) {
    const bookingIds = [...new Set(journal.lines.flatMap((l) => l.bookingId ?? []))].sort();
    for (const bookingId of bookingIds) await lockMemberMoneyPayment(db, bookingId);
    const live = await db.memberMoneyApplication.findMany({
      where: { sourceLineId: { in: sourceIds }, reversedBy: null, reversesApplicationId: null },
      select: { id: true, applicationKey: true, sourceLineId: true, amountCents: true, reversesApplicationId: true,
        obligation: { select: { obligationKey: true, kind: true } } },
    });
    if (live.some((a) => a.obligation.kind === "REFUND")) throw new MemberMoneyPlanError(["a receipt cannot be reversed while a fund application draws on it"]);
    for (const application of live) if (!journal.applications.some((a) => a.id === application.id)) journal.applications.push(application);
  }
  return {
    ...journal,
    applications: journal.applications.map(({ id, applicationKey, sourceLineId, obligation, amountCents, reversesApplicationId }) => ({
      id, key: applicationKey, source: { lineId: sourceLineId }, obligationKey: obligation.obligationKey, amountCents, reversesApplicationId,
    })),
    lines: journal.lines.map(({ obligation, evidence, ...line }) => ({
      ...line,
      obligationKey: obligation?.obligationKey ?? null,
      evidence: evidence as BuiltBatch["lines"][number]["evidence"],
    })),
  };
}

async function sourceCapture(db: Db, kind: string, id: string, bookingId: string): Promise<string | null> {
  if (kind !== "PAYMENT" && kind !== "REFUND") return null;
  const source = kind === "PAYMENT"
    ? await db.paymentTransaction.findUnique({ where: { id }, select: { stripePaymentIntentId: true, payment: { select: { bookingId: true } } } })
    : await db.paymentRefund.findUnique({ where: { stripeRefundId: id }, select: { stripePaymentIntentId: true, payment: { select: { bookingId: true } } } });
  if (!source || source.payment.bookingId !== bookingId) throw new MemberMoneyPlanError(["application cash source must belong to its booking"]);
  return source.stripePaymentIntentId;
}

/** All cap refusals precede the first write. Cash legs are never resized or inferred here. */
async function prepareApplications(db: Db, batch: BuiltBatch, lineIds: string[], applicationIds: string[]): Promise<ApplicationState | null> {
  if (batch.applications.length === 0) return null;
  const externalIds = batch.applications.flatMap((a) => "lineId" in a.source ? [a.source.lineId] : []);
  const external = externalIds.length ? await db.memberMoneyLine.findMany({ where: { id: { in: externalIds } }, select: { bookingId: true } }) : [];
  const bookingIds = [...new Set([...batch.lines.map((l) => l.bookingId), ...external.map((l) => l.bookingId)].filter((id): id is string => id !== null))];
  if (bookingIds.length !== 1) throw new MemberMoneyPlanError(["M4 applications require exactly one booking"]);
  const bookingId = bookingIds[0]!;
  await lockMemberMoneyPayment(db, bookingId);
  const state = await readMemberMoneyApplicationState(db, bookingId);
  const originalState = structuredClone(state);
  for (const obligation of batch.obligations) state.obligations.push({
    id: obligation.key, key: obligation.key, kind: obligation.kind, faceCents: obligation.faceCents,
    debtorKind: obligation.debtorKind, memberId: obligation.memberId, organisationId: obligation.organisationId, currency: batch.journal.currency,
  });
  for (const [index, line] of batch.lines.entries()) {
    const source = batch.sources[line.source]!;
    state.sources.push({ ...line, sourceKind: source.kind, id: lineIds[index]!, currency: batch.journal.currency, reversed: false,
      obligationId: state.obligations.find((o) => o.key === line.obligationKey)?.id ?? null,
      capture: await sourceCapture(db, source.kind, source.id, bookingId) });
  }
  const problems: string[] = [];
  const consumed = new Set<string>();
  for (const [index, application] of batch.applications.entries()) {
    const sourceId = "lineId" in application.source ? application.source.lineId : lineIds[application.source.line]!;
    const source = state.sources.find((s) => s.id === sourceId);
    const obligation = state.obligations.find((o) => o.key === application.obligationKey);
    if (!source || !obligation) { problems.push("application source or obligation does not belong to the booking"); continue; }
    const role = applicationRoleOf(source, obligation);
    if (!role || !sameApplicationDebtor(source, obligation) || source.currency !== batch.journal.currency) problems.push("application shape, currency or debtor mismatch");
    if (source.reversed && !application.reversesApplicationId) problems.push("cannot apply a reversed source");
    if (application.reversesApplicationId) {
      const original = state.applications.find((a) => a.id === application.reversesApplicationId);
      if (!original || original.sourceLineId !== source.id || original.obligationId !== obligation.id || original.amountCents !== application.amountCents
        || state.applications.some((a) => a.reversesApplicationId === original.id)) problems.push("application reversal is not an exact unreversed application");
    }
    if (application.reservationAttemptKey) {
      const reservation = state.reservations.find((r) => r.attemptKey === application.reservationAttemptKey);
      if (!reservation || consumed.has(reservation.id) || role !== "pay" || source.capture !== reservation.capture || application.amountCents !== reservation.amountCents
        || obligation.key.split("|for|")[0] !== state.obligations.find((o) => o.id === reservation.obligationId)?.key.split("|for|")[0]
        || !("line" in application.source) || batch.sources[batch.lines[application.source.line]!.source]!.kind !== "REFUND") {
        problems.push("a refund answer must match its exact open reservation");
      } else consumed.add(reservation.id);
    } else if (role === "pay" && source.sourceKind === "REFUND" && !application.reversesApplicationId) problems.push("a card refund application requires its reservation");
    state.applications.push({ id: applicationIds[index]!, sourceLineId: source.id, obligationId: obligation.id, amountCents: application.amountCents,
      reversesApplicationId: application.reversesApplicationId });
  }
  state.reservations = state.reservations.filter((r) => !consumed.has(r.id));
  problems.push(...memberMoneyConservationProblems(state).map((p) => `${p.problem}: ${p.identity}`));
  const before = memberMoneyApplicationTotals(originalState).collected;
  const after = memberMoneyApplicationTotals(state).collected;
  const liveCharge = (await readBookingLiveComponents(db, bookingId)).reduce((sum, c) => sum + c.liveGrossCents, 0);
  if (after > before && after > liveCharge) problems.push("C2: collect exceeds the booking's live charge");
  if (problems.length) throw new MemberMoneyPlanError(problems);
  return originalState;
}

export class MemberMoneyReservationRefused extends MemberMoneyPlanError {
  constructor(problems: readonly string[]) { super(problems); this.name = "MemberMoneyReservationRefused"; }
}

export interface MemberMoneyReservationPlan {
  bookingId: string;
  attemptKey: string;
  obligationKey: string;
  stripePaymentIntentId: string;
  paymentTransactionId: string;
  amountCents: number;
  fundingJournalId: string;
}

/** Inert M4a primitive: the caller posts funding in this transaction before reserving. */
export async function reserveMemberMoneyRefund(db: Db, plan: MemberMoneyReservationPlan): Promise<{ id: string; replayed: boolean }> {
  await lockMemberMoneyPayment(db, plan.bookingId);
  const prior = await db.memberMoneyRefundReservation.findUnique({ where: { attemptKey: plan.attemptKey }, include: { obligation: true } });
  if (prior) {
    if (prior.obligation.obligationKey !== plan.obligationKey || prior.stripePaymentIntentId !== plan.stripePaymentIntentId
      || prior.paymentTransactionId !== plan.paymentTransactionId || prior.amountCents !== plan.amountCents || prior.fundingJournalId !== plan.fundingJournalId) {
      throw new MemberMoneyPostingConflictError(plan.attemptKey, ["reservation payload differs"]);
    }
    return { id: prior.id, replayed: true };
  }
  if (!Number.isSafeInteger(plan.amountCents) || plan.amountCents <= 0 || plan.amountCents > 2147483647 || !plan.attemptKey) {
    throw new MemberMoneyReservationRefused(["reservation requires its verbatim attempt key and positive integer cents"]);
  }
  const state = await readMemberMoneyApplicationState(db, plan.bookingId);
  const obligation = state.obligations.find((o) => o.key === plan.obligationKey && o.kind === "REFUND");
  const transaction = await db.paymentTransaction.findUnique({ where: { id: plan.paymentTransactionId }, select: { stripePaymentIntentId: true, payment: { select: { bookingId: true } } } });
  if (!obligation || transaction?.stripePaymentIntentId !== plan.stripePaymentIntentId || transaction.payment.bookingId !== plan.bookingId) {
    throw new MemberMoneyReservationRefused(["reservation obligation and capture must belong to the booking"]);
  }
  const funding = await db.memberMoneyApplication.findMany({ where: { journalId: plan.fundingJournalId }, select: { sourceLineId: true, obligationId: true, amountCents: true, reversesApplicationId: true } });
  const exactFunding = funding.filter((a) => a.obligationId === obligation.id && a.reversesApplicationId === null
    && state.sources.some((s) => s.id === a.sourceLineId && s.capture === plan.stripePaymentIntentId && applicationRoleOf(s, obligation) === "fund"))
    .reduce((sum, a) => sum + a.amountCents, 0);
  if (exactFunding !== plan.amountCents || await db.memberMoneyJournal.findFirst({ where: { reversesJournalId: plan.fundingJournalId }, select: { id: true } })) {
    throw new MemberMoneyReservationRefused(["reservation must name its exact live funding batch"]);
  }
  const id = randomUUID();
  state.reservations.push({ id, attemptKey: plan.attemptKey, obligationId: obligation.id, capture: plan.stripePaymentIntentId, amountCents: plan.amountCents });
  const problems = memberMoneyConservationProblems(state);
  if (problems.length) throw new MemberMoneyReservationRefused(problems.map((p) => `${p.problem}: ${p.identity}`));
  await db.memberMoneyRefundReservation.createMany({ data: [{ id, attemptKey: plan.attemptKey, obligationId: obligation.id,
    stripePaymentIntentId: plan.stripePaymentIntentId, paymentTransactionId: plan.paymentTransactionId, amountCents: plan.amountCents, fundingJournalId: plan.fundingJournalId }] });
  return { id, replayed: false };
}

export async function appendMemberMoneyReservationRelease(db: Db, reservationId: string, reason: Exclude<MemberMoneyRefundReservationReleaseReason, "ANSWERED">): Promise<void> {
  await db.memberMoneyRefundReservationRelease.createMany({ data: [{ reservationId, reason }] });
}
