import { randomUUID } from "node:crypto";
import type { Prisma } from "@prisma/client";
import { dateOnlyInstantOf } from "../../club-time";
import { stableStringify } from "../../stable-digest";
import {
  completeMemberMoneyBatch,
  MemberMoneyPlanError,
  type BuiltBatch,
  type MemberMoneyJournalToReverse,
  type PostedRevenueLeg,
} from "./plan";

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
  const earlier = [...new Set(batch.lines.flatMap((line) => line.obligationKey ?? []))].filter((key) => !ids.has(key));
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

/** The posted revenue legs of every component the batch corrects. A read only. */
async function postedComponents(db: Db, draft: BuiltBatch): Promise<PostedRevenueLeg[]> {
  if (draft.corrections.length === 0) return [];
  return db.memberMoneyLine.findMany({
    where: { OR: draft.corrections.map(({ account, chargeIdentity }) => ({ account, chargeIdentity })) },
    select: { account: true, chargeIdentity: true, side: true, amountCents: true,
      grossCents: true, netCents: true, taxCents: true, taxCode: true },
  });
}

/**
 * Replay first, so a retry of a correction is recognised even though its
 * component is no longer live; then every read that can refuse the plan; then
 * the first write.
 */
export async function writeMemberMoneyBatch(db: Db, draft: BuiltBatch): Promise<MemberMoneyPosting> {
  const earlier = await replay(db, draft, false);
  if (earlier) return earlier;
  const batch = completeMemberMoneyBatch(draft, await postedComponents(db, draft));
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
      expectedApplicationCount: 0,
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
  const lineIds = batch.lines.map(() => randomUUID());
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
  const postings = batch.lines.flatMap((line, index) =>
    batch.sources[line.source]!.kind === "BOOKING_LEDGER"
      ? [{ id: randomUUID(), journalId, sourceLinkId: sourceIds[line.source]!, lineId: lineIds[index]! }]
      : []);
  if (postings.length > 0) await db.memberMoneySourcePosting.createMany({ data: postings });
  return { eventId, journalId, replayed: false };
}

/** Read a posted journal, verbatim, for an exact reversal. A read only. */
export async function readMemberMoneyJournalToReverse(db: Db, journalId: string): Promise<MemberMoneyJournalToReverse> {
  const journal = await db.memberMoneyJournal.findUnique({
    where: { id: journalId },
    select: {
      id: true, currency: true, policyVersion: true, codingVersion: true,
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
  return {
    ...journal,
    lines: journal.lines.map(({ obligation, evidence, ...line }) => ({
      ...line,
      obligationKey: obligation?.obligationKey ?? null,
      evidence: evidence as BuiltBatch["lines"][number]["evidence"],
    })),
  };
}
