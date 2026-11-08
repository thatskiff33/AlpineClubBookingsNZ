import type { Prisma } from "@prisma/client";
import { CAPTURE_KIND_RECEIPTS, CAPTURE_KINDS, type CaptureKind } from "../../booking-ledger-capture-kinds";
import { clubCalendarDateOf, requireInstant, startOfClubDay, type CalendarDate } from "../../club-time";
import logger from "../../logger";
import { ORGANISER_SHARE_RECEIPT_REASON } from "../../organiser-extra-state";
import { lockMemberMoneyPayment, readMemberMoneyApplicationState } from "./application-read";
import { memberMoneyApplicationTotals, type ApplicationObligation, type ApplicationState } from "./application-state";
import { bookingOwnerDebtor, eventPosted, readBookingLiveChargeCents, receivableBalances } from "./booking-journal-read";
import { memberMoneyApplicationKeys, memberMoneyEventKeys, type MemberMoneyEventKey } from "./keys";
import { isBookingJournalInactive, type BookingJournalContext } from "./journal-activity";
import { buildMemberMoneyBatch, MemberMoneyPlanError, type MemberMoneyDebtor, type MemberMoneyPostingContext, type MemberMoneySource } from "./plan";
import { postMemberMoneyEvent, reverseMemberMoneyJournal } from "./post";
import { linkLegacyLinesToPostedBatch, writeMemberMoneyBatch } from "./store";

type Db = Prisma.TransactionClient;


export interface BookingReceiptDecision {
  /** No selection means catch-up only. Never select an instrument by amount or time. */
  paymentIntentId?: string;
  /** The rows this writer wrote in this transaction, never a set re-read by reason, source or invoice. */
  transactionIds?: readonly string[];
  collect: boolean;
  /**
   * The capture's own settlement decides later (a saved-card answer recorded before the booking settles).
   * It posts unapplied either way; only such a receipt may be collected by a later call that selects it.
   */
  deferred?: true;
  effectiveAt?: Date;
  /** A provider-owned civil payment day, when it supplies no time of day. */
  effectiveDate?: CalendarDate;
}

/**
 * How a receipt was posted, kept in its evidence. A later call may collect only a DEFERRED one: a receipt a
 * catch-up posted, or one its writer decided not to collect, already existed, and today's state never
 * collects it (#4516 review).
 */
type ReceiptPostedAs = "collect" | "deferred" | "uncollected" | "catch-up";

/** Stable identities shared with the census; never amount, timing or array position. */
export function bookingReceiptEventKey(row: { id: string; stripePaymentIntentId: string | null }, line: { id: string; kind: string }) {
  if (line.kind === "CARD_CAPTURE") {
    if (!row.stripePaymentIntentId) throw new MemberMoneyPlanError(["a card receipt has no capture identity"]);
    return memberMoneyEventKeys.capture(row.stripePaymentIntentId);
  }
  return memberMoneyEventKeys.receipt(row.id, line.id);
}

/** Use the source fact's date with the zone resolved before the transaction. No settings read under locks. */
export function receiptFactContext(context: MemberMoneyPostingContext, at: Date): MemberMoneyPostingContext {
  const effectiveAt = requireInstant(at);
  return { ...context, effectiveAt, effectiveDate: clubCalendarDateOf(effectiveAt, context.zone) };
}

const debtorId = (debtor: MemberMoneyDebtor) => (debtor.kind === "MEMBER" ? debtor.memberId : debtor.organisationId);
const ownedBy = (obligation: ApplicationObligation, debtor: MemberMoneyDebtor) =>
  obligation.debtorKind === debtor.kind && (obligation.memberId ?? obligation.organisationId) === debtorId(debtor);
const succeeded = (state: ApplicationState, obligation: ApplicationObligation) =>
  state.obligations.some((o) => memberMoneyApplicationKeys.succeeds(o.key, obligation.key));
/** The debtor's live CHARGE obligation: one no successor has superseded, never a stale root. */
const chargeOf = (state: ApplicationState, debtor: MemberMoneyDebtor) =>
  state.obligations.find((o) => o.kind === "CHARGE" && ownedBy(o, debtor) && !succeeded(state, o)) ?? null;

/** The debtor a posted receivable line names; the line is immutable, so this never re-reads the booking. */
function lineDebtor(line: { debtorKind: string | null; memberId: string | null; organisationId: string | null }): MemberMoneyDebtor {
  if (line.debtorKind === "MEMBER" && line.memberId) return { kind: "MEMBER", memberId: line.memberId };
  if (line.debtorKind === "ORGANISATION" && line.organisationId) return { kind: "ORGANISATION", organisationId: line.organisationId };
  throw new MemberMoneyPlanError(["a receipt's receivable line names no debtor"]);
}

/**
 * A ZERO R01 has no obligation. A named debit and unnamed equal credit open its face without charging again.
 * `liveChargeCents` is the collection's one live-charge read, so the face it sizes is the charge it clamps to.
 */
async function chargeObligation(tx: Db, context: MemberMoneyPostingContext, booking: { bookingId: string; lodgeId: string },
  debtor: MemberMoneyDebtor, liveChargeCents: number) {
  const rootKey = memberMoneyEventKeys.bookingCharge(booking.bookingId);
  const state = await readMemberMoneyApplicationState(tx, booking.bookingId);
  const found = chargeOf(state, debtor);
  if (found) return found;
  if (state.obligations.some((o) => o.key === rootKey)) {
    // The owner moved (a member merge) before this debtor's first collection. Its successor is posted here, under
    // the Payment row every application takes, so the face it carries forward cannot miss a collection.
    await postChargeSuccessor(tx, context, booking, debtor, state, liveChargeCents);
  } else {
    const faceCents = liveChargeCents;
    if (faceCents <= 0) return null;
    const eventKey = memberMoneyEventKeys.chargeOpen(booking.bookingId);
    const source = { kind: "BOOKING" as const, id: booking.bookingId, version: eventKey };
    await postMemberMoneyEvent(tx, context, { kind: "TRANSFER", eventKey, origin: "APP", source, reason: "Open a charge obligation after ZERO R01",
      obligations: [{ key: rootKey, kind: "CHARGE", debtor, faceCents, evidence: { lazy: true } }],
      legs: [
        { type: "amount", account: "MEMBER_RECEIVABLE", side: "DEBIT", amountCents: faceCents, debtor, booking, obligationKey: rootKey, evidence: { lazy: true } },
        { type: "amount", account: "MEMBER_RECEIVABLE", side: "CREDIT", amountCents: faceCents, debtor, booking, evidence: { lazy: true } },
      ] });
  }
  return chargeOf(await readMemberMoneyApplicationState(tx, booking.bookingId), debtor);
}

/**
 * D4: immutable obligations get successors, never a new debtor written onto history. Only from a collection,
 * holding the booking's Payment row, so what it carries forward is read where no collection can race it.
 * Successors only ever chain from the one live tip, so the chain has one CHARGE obligation no successor superseded.
 * Its successor's face is what the chain still has to collect: the live charge less everything collected, never
 * the tip's own face less its own collections, since an increase (R02) opens no obligation of its own.
 */
async function postChargeSuccessor(tx: Db, context: MemberMoneyPostingContext, booking: { bookingId: string; lodgeId: string },
  debtor: MemberMoneyDebtor, state: ApplicationState, liveChargeCents: number): Promise<void> {
  const original = state.obligations.find((o) => o.kind === "CHARGE" && !ownedBy(o, debtor) && !succeeded(state, o));
  const faceCents = liveChargeCents - memberMoneyApplicationTotals(state).collected;
  if (!original || faceCents <= 0) return;
  const eventKey = memberMoneyEventKeys.successor(original.key, original.memberId ?? original.organisationId!, debtorId(debtor));
  if (await eventPosted(tx, eventKey)) return;
  const successor = memberMoneyApplicationKeys.successor(original.key, debtor.kind, debtorId(debtor));
  const leg = { type: "amount" as const, account: "MEMBER_RECEIVABLE" as const, amountCents: faceCents, debtor, booking, evidence: { predecessor: original.key } };
  await postMemberMoneyEvent(tx, context, { kind: "TRANSFER", eventKey, origin: "APP",
    source: { kind: "BOOKING", id: booking.bookingId, version: eventKey }, reason: "Member merge charge successor",
    obligations: [{ key: successor, kind: "CHARGE", debtor, faceCents, evidence: { predecessor: original.key } }],
    legs: [{ ...leg, side: "DEBIT", obligationKey: successor }, { ...leg, side: "CREDIT" }] });
}

const MERGE_SNAPSHOT_VERSION = "member-money-merge-snapshot-1";

/** The same immutable line snapshot determines both the balances and the source events a merge included. */
export function memberMergeSnapshotSources(eventKey: ReturnType<typeof memberMoneyEventKeys.merge>, eventIds: readonly string[]): MemberMoneySource[] {
  return [{ kind: "PROVIDER_FACT", id: eventKey, version: MERGE_SNAPSHOT_VERSION },
    ...[...new Set(eventIds)].sort().map((id): MemberMoneySource => ({ kind: "PROVIDER_FACT", id, version: eventKey }))];
}

/** Receivable balances a booking still carries on members other than its owner: the census class and the hook's residue test. */
export async function readMergedDebtorBalances(tx: Db, bookingId: string, ownerMemberId: string | null): Promise<Map<string, number>> {
  const rows = await tx.memberMoneyLine.findMany({ where: { bookingId, account: "MEMBER_RECEIVABLE", debtorKind: "MEMBER", memberId: { not: ownerMemberId } },
    select: { memberId: true, side: true, amountCents: true } });
  return receivableBalances(rows, (row) => row.memberId);
}

/** A merged-away member's one merge: whom it merged into, and the events its line snapshot included. */
async function mergeOf(tx: Db, memberId: string) {
  // A member merges away once. This also finds the first merge when the survivor later merges again.
  const merge = await tx.memberMoneyEvent.findFirst({ where: { sourceKind: "OFFICER_FACT", sourceIdentity: memberId, sourceVersion: { startsWith: "merge:" } },
    select: { eventKey: true, sourceVersion: true, journal: { select: { sources: { select: { sourceId: true, sourceVersion: true } } } } } });
  const sources = merge?.journal?.sources ?? [];
  if (!merge || !sources.some((s) => s.sourceId === merge.eventKey && s.sourceVersion === MERGE_SNAPSHOT_VERSION)) return null;
  return { eventKey: merge.eventKey, to: merge.sourceVersion.slice("merge:".length),
    netted: (eventId: string) => sources.some((s) => s.sourceId === eventId && s.sourceVersion === merge.eventKey) };
}

/**
 * Carry an exact event's stray balance on a merged-away member along the merge chain to the owner: each hop to
 * the member that one merged into, unless that member's own merge snapshot already netted it. Never a balance
 * attributed by timing or amount. It only ever moves onward along the chain to the owner; an intermediate hop
 * can be a member that itself merged away.
 */
async function carryResidue(tx: Db, context: MemberMoneyPostingContext, booking: { bookingId: string; lodgeId: string },
  owner: string, start: { holder: string; eventKey: MemberMoneyEventKey; eventId: string; cents: number }) {
  let { holder, eventKey, eventId } = start;
  const { cents } = start;
  while (holder !== owner) {
    const merge = await mergeOf(tx, holder);
    if (!merge || merge.netted(eventId)) return;
    const key = memberMoneyEventKeys.mergeResidue(holder, merge.to, eventKey);
    if (!await eventPosted(tx, key)) {
      const leg = { type: "amount" as const, account: "MEMBER_RECEIVABLE" as const, amountCents: Math.abs(cents), booking, evidence: { strayEventKey: eventKey } };
      await postMemberMoneyEvent(tx, context, { kind: "TRANSFER", eventKey: key, origin: "APP",
        source: { kind: "BOOKING", id: booking.bookingId, version: key }, reason: "Move merged-debtor residue",
        legs: [{ ...leg, side: cents > 0 ? "CREDIT" : "DEBIT", debtor: { kind: "MEMBER", memberId: holder } },
          { ...leg, side: cents > 0 ? "DEBIT" : "CREDIT", debtor: { kind: "MEMBER", memberId: merge.to } }] });
    }
    eventId = (await tx.memberMoneyEvent.findUniqueOrThrow({ where: { eventKey: key }, select: { id: true } })).id;
    eventKey = key;
    holder = merge.to;
  }
}

/** Transfer only an exact event omitted from the merge's snapshot, never a balance attributed by timing or amount. */
async function moveReceiptResidue(tx: Db, context: MemberMoneyPostingContext, booking: { bookingId: string; lodgeId: string },
  debtor: MemberMoneyDebtor, eventKey: MemberMoneyEventKey) {
  if (debtor.kind !== "MEMBER") return;
  const event = await tx.memberMoneyEvent.findUniqueOrThrow({ where: { eventKey }, select: { id: true, journal: { select: { lines: {
    where: { account: "MEMBER_RECEIVABLE", debtorKind: "MEMBER", bookingId: booking.bookingId, memberId: { not: debtor.memberId } },
    select: { memberId: true, side: true, amountCents: true },
  } } } } });
  for (const [from, cents] of receivableBalances(event.journal!.lines, (line) => line.memberId)) {
    if (cents !== 0) await carryResidue(tx, context, booking, debtor.memberId, { holder: from, eventKey, eventId: event.id, cents });
  }
}

/**
 * The credit line a collection by the owner applies for a receipt: the receipt's own when the owner posted it;
 * otherwise where the merge chain carried its credit to the owner. A residue move carried it as an exact line;
 * a merge whose snapshot netted it moved it inside the survivor's balance, so the owner gets a zero-net stand-in
 * for it, once. Null only when no merge moved the receipt's debtor to the owner.
 */
async function ownerCreditFor(tx: Db, context: MemberMoneyPostingContext, booking: { bookingId: string; lodgeId: string }, owner: MemberMoneyDebtor,
  receipt: { eventKey: MemberMoneyEventKey; eventId: string; line: { id: string; amountCents: number; debtorKind: string | null; memberId: string | null; organisationId: string | null } },
  unappliedCents: number): Promise<{ id: string; amountCents: number } | null> {
  let holder = lineDebtor(receipt.line);
  let credit = { id: receipt.line.id, amountCents: receipt.line.amountCents };
  let { eventKey, eventId } = receipt;
  for (;;) {
    if (holder.kind === owner.kind && debtorId(holder) === debtorId(owner)) return credit;
    if (holder.kind !== "MEMBER" || owner.kind !== "MEMBER") return null;
    const merge = await mergeOf(tx, holder.memberId);
    if (!merge) return null;
    if (merge.netted(eventId)) {
      const key = memberMoneyEventKeys.mergeFollow(receipt.eventKey, owner.memberId);
      if (!await eventPosted(tx, key)) {
        const leg = { type: "amount" as const, account: "MEMBER_RECEIVABLE" as const, amountCents: unappliedCents, debtor: owner, booking,
          evidence: { followsEvent: eventKey, nettedBy: merge.eventKey } };
        await postMemberMoneyEvent(tx, context, { kind: "TRANSFER", eventKey: key, origin: "APP",
          source: { kind: "BOOKING", id: booking.bookingId, version: key }, reason: "Receipt carried by a member merge",
          legs: [{ ...leg, side: "DEBIT" }, { ...leg, side: "CREDIT" }] });
      }
      const line = await tx.memberMoneyLine.findFirstOrThrow({ where: { journal: { event: { eventKey: key } }, account: "MEMBER_RECEIVABLE", side: "CREDIT" },
        select: { id: true, amountCents: true } });
      return line;
    }
    const key = memberMoneyEventKeys.mergeResidue(holder.memberId, merge.to, eventKey);
    const residue = await tx.memberMoneyEvent.findUnique({ where: { eventKey: key }, select: { id: true, journal: { select: { lines: {
      where: { account: "MEMBER_RECEIVABLE", side: "CREDIT", debtorKind: "MEMBER", memberId: merge.to }, select: { id: true, amountCents: true } } } } } });
    const line = residue?.journal?.lines[0];
    if (!residue || !line) return null;
    holder = { kind: "MEMBER", memberId: merge.to };
    credit = line;
    eventKey = key;
    eventId = residue.id;
  }
}

function receiptPostedAs(evidence: Prisma.JsonValue): ReceiptPostedAs | null {
  const value = evidence !== null && typeof evidence === "object" && !Array.isArray(evidence) ? evidence.postedAs : null;
  return value === "collect" || value === "deferred" || value === "uncollected" || value === "catch-up" ? value : null;
}

/**
 * R06/R07/R08, beside the writer's own mutation. No caught refusal, provider call, inferred collection or new
 * advisory key. The owner is read once, with the Payment row held: every receipt this call posts names that
 * debtor, and every collection lands on that owner's live obligation, the tip of the charge chain. A receipt
 * a merged-away member's writer deferred is applied there through the credit the merge chain carried to the
 * owner. A collection is capped by its credit's room and the live charge less what was collected, never by its
 * obligation's face: faces are not a running balance, because a price increase opens no obligation.
 * Reversing a receipt first reverses its collection, through whichever credit that applied.
 */
export async function postBookingReceipts(tx: Db, context: BookingJournalContext, input: {
  paymentId: string; decision?: BookingReceiptDecision;
}): Promise<number> {
  if (isBookingJournalInactive(context)) return 0;
  const owner = await tx.payment.findUnique({ where: { id: input.paymentId }, select: { bookingId: true } });
  if (!owner || !await eventPosted(tx, memberMoneyEventKeys.bookingCharge(owner.bookingId))) return 0;
  await lockMemberMoneyPayment(tx, owner.bookingId);
  // Payment-row-only writers must never take a Booking row lock (INV-LOCK-002): the owner is a plain read.
  const payment = await tx.payment.findUniqueOrThrow({ where: { id: input.paymentId },
    include: { booking: { select: { lodgeId: true, memberId: true, organisationId: true } }, transactions: true } });
  const booking = { bookingId: owner.bookingId, lodgeId: payment.booking.lodgeId };
  const debtor = bookingOwnerDebtor(payment.booking);
  const decision = input.decision;
  const lines = await tx.bookingLedgerLine.findMany({ where: { bookingId: owner.bookingId, side: "SETTLEMENT", kind: { in: [...CAPTURE_KINDS] } },
    orderBy: [{ postedAt: "asc" }, { id: "asc" }] });
  const receipts = lines.flatMap((line) => {
    const row = line.reversesLineId === null ? payment.transactions.find((t) => t.id === line.anchorId) : undefined;
    if (!row || row.reason === ORGANISER_SHARE_RECEIPT_REASON || line.amountCents <= 0) return [];
    const selected = decision !== undefined && (decision.paymentIntentId !== undefined && decision.paymentIntentId === row.stripePaymentIntentId
      || decision.transactionIds?.includes(row.id) === true);
    return [{ line, row, kind: line.kind as CaptureKind, selected, reversal: lines.find((l) => l.reversesLineId === line.id) ?? null }];
  });
  // Nothing selected, every receipt and reversal already bridged, and no merged-debtor residue: no further reads
  // under the caller's locks (this hook runs beside every capture, often holding `lock(1)`).
  if (!receipts.some((r) => r.selected)) {
    const ids = receipts.flatMap((r) => (r.reversal ? [r.line.id, r.reversal.id] : [r.line.id]));
    const bridged = await tx.memberMoneySourceLink.count({ where: { bookingLedgerLineId: { in: ids } } });
    if (bridged === ids.length && (debtor.kind !== "MEMBER"
      || [...(await readMergedDebtorBalances(tx, owner.bookingId, debtor.memberId)).values()].every((cents) => cents === 0))) return 0;
  }
  let posted = 0;
  for (const { line, row, kind, selected, reversal } of receipts) {
    const eventKey = bookingReceiptEventKey(row, line);
    const at = selected && decision?.effectiveDate ? new Date(startOfClubDay(decision.effectiveDate, context.zone))
      : selected && decision?.effectiveAt ? decision.effectiveAt : line.postedAt;
    const factContext = receiptFactContext(context, at);
    const source = { kind: "PAYMENT" as const, id: row.id, version: line.postingKey ?? line.id };
    const postedNow = !await eventPosted(tx, eventKey);
    if (postedNow) {
      // Full cash always posts, even if there is no charge or the charge is already collected.
      const postedAs: ReceiptPostedAs = !selected ? "catch-up" : decision!.collect ? "collect" : decision!.deferred ? "deferred" : "uncollected";
      const evidence = { transactionId: row.id, settlementLineId: line.id, postedAs,
        datedBy: selected && decision?.effectiveDate ? "source-date" : selected && decision?.effectiveAt ? "source" : "app-record" };
      const result = await postMemberMoneyEvent(tx, factContext, { kind: "RECEIPT", eventKey, origin: CAPTURE_KIND_RECEIPTS[kind].origin, source, reason: "Booking receipt",
        legs: [
          { type: "amount", account: CAPTURE_KIND_RECEIPTS[kind].cash, side: "DEBIT", amountCents: line.amountCents, booking, evidence },
          { type: "amount", account: "MEMBER_RECEIVABLE", side: "CREDIT", amountCents: line.amountCents, debtor, booking, evidence },
        ] });
      const credit = await tx.memberMoneyLine.findFirstOrThrow({ where: { journalId: result.journalId, account: "MEMBER_RECEIVABLE", side: "CREDIT" }, select: { id: true } });
      await linkLegacyLinesToPostedBatch(tx, { journalId: result.journalId, receivableLegId: credit.id, lines: [{ id: line.id, version: line.postingKey ?? line.id }] });
      posted++;
    }
    await moveReceiptResidue(tx, factContext, booking, debtor, eventKey);
    const receipt = await tx.memberMoneyEvent.findUniqueOrThrow({ where: { eventKey }, select: { journal: { select: { id: true, eventId: true, reversedBy: { select: { id: true } } } } } });
    if (reversal) {
      if (!receipt.journal!.reversedBy) {
        // Its collection first, whichever credit that applied (its own line, a residue move's or a stand-in's), so no
        // collection outlives the cash it applied; the receipt's own reversal then finds none left to copy.
        const collection = await tx.memberMoneyEvent.findUnique({ where: { eventKey: memberMoneyEventKeys.collect(eventKey) },
          select: { journal: { select: { id: true, reversedBy: { select: { id: true } } } } } });
        if (collection?.journal && !collection.journal.reversedBy) {
          await reverseMemberMoneyJournal(tx, receiptFactContext(context, reversal.postedAt), { reversesJournalId: collection.journal.id, origin: "OFFICER",
            source: { kind: "PAYMENT", id: row.id, version: memberMoneyEventKeys.reversal(collection.journal.id) }, reason: "Reverse an officer receipt's collection" });
          posted++;
        }
        const reversed = await reverseMemberMoneyJournal(tx, receiptFactContext(context, reversal.postedAt), {
          reversesJournalId: receipt.journal!.id, origin: "OFFICER", source: { kind: "PAYMENT", id: row.id, version: reversal.id }, reason: "Reverse officer receipt" });
        const debit = await tx.memberMoneyLine.findFirstOrThrow({ where: { journalId: reversed.journalId, account: "MEMBER_RECEIVABLE", side: "DEBIT" }, select: { id: true } });
        await linkLegacyLinesToPostedBatch(tx, { journalId: reversed.journalId, receivableLegId: debit.id, lines: [{ id: reversal.id, version: reversal.postingKey ?? reversal.id }] });
        posted++;
      }
      await moveReceiptResidue(tx, receiptFactContext(context, reversal.postedAt), booking, debtor, memberMoneyEventKeys.reversal(receipt.journal!.id));
      continue;
    }
    if (!selected || !decision!.collect || receipt.journal!.reversedBy) continue;
    const collectKey = memberMoneyEventKeys.collect(eventKey);
    if (await eventPosted(tx, collectKey)) continue;
    const sourceLine = await tx.memberMoneyLine.findFirstOrThrow({ where: { journalId: receipt.journal!.id, account: "MEMBER_RECEIVABLE", side: "CREDIT" } });
    // Only this writer's own receipt: posted now, or deferred by its writer to this decision. Never a catch-up's.
    if (!postedNow && receiptPostedAs(sourceLine.evidence) !== "deferred") continue;
    // One live-charge read sizes any successor, clamps the amount and is the read C2 checks it against (`ApplicationCheck`).
    const liveChargeCents = await readBookingLiveChargeCents(tx, booking.bookingId);
    // The live tip of the booking's charge chain is the owner's obligation (a successor is only ever posted for the
    // owner this call read), so a receipt its writer deferred before a merge is collected there, never onto a
    // superseded obligation, through the credit the merge chain carried to the owner.
    const obligation = await chargeObligation(tx, factContext, booking, debtor, liveChargeCents);
    if (!obligation) continue;
    const totals = memberMoneyApplicationTotals(await readMemberMoneyApplicationState(tx, booking.bookingId));
    const unapplied = sourceLine.amountCents - (totals.sources.get(sourceLine.id) ?? 0);
    // What this receipt can still collect, known before any stand-in is posted: none is posted to collect nothing.
    const collectable = Math.min(unapplied, liveChargeCents - totals.collected);
    if (collectable <= 0) continue;
    const credit = await ownerCreditFor(tx, factContext, booking, debtor,
      { eventKey, eventId: receipt.journal!.eventId, line: sourceLine }, unapplied);
    if (!credit) {
      // An owner change no merge made (none does today): the census reports the receipt unapplied on an open charge.
      logger.warn({ bookingId: booking.bookingId, receiptEventKey: eventKey }, "A deferred receipt's debtor no longer owns the booking and no merge carried it: left unapplied (#4516)");
      continue;
    }
    // A stand-in posted just now has no application yet, so the totals read above still give its room.
    const amountCents = Math.min(collectable, credit.amountCents - (totals.sources.get(credit.id) ?? 0));
    if (amountCents <= 0) continue;
    await writeMemberMoneyBatch(tx, buildMemberMoneyBatch(factContext, { kind: "ZERO", eventKey: collectKey, origin: "APP", source: { ...source, version: collectKey },
      reason: "Apply the receipt the settlement selected", applications: [{ key: memberMoneyApplicationKeys.application(collectKey, row.id, obligation.key),
        source: { lineId: credit.id }, obligationKey: obligation.key, amountCents }] }), undefined, { liveChargeCents });
    posted++;
  }
  return posted;
}
