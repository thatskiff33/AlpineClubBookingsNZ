import type { Prisma } from "@prisma/client";
import { bookingOwnerProviderMetadata } from "../../booking-owner";
import { clubCalendarDateOf, requireInstant, startOfClubDay, type CalendarDate } from "../../club-time";
import { ORGANISER_SHARE_RECEIPT_REASON } from "../../organiser-extra-state";
import { lockMemberMoneyPayment, readMemberMoneyApplicationState } from "./application-read";
import { memberMoneyApplicationTotals, sameApplicationDebtor } from "./application-state";
import { readBookingLiveComponents } from "./booking-journal-read";
import { memberMoneyApplicationKeys, memberMoneyEventKeys } from "./keys";
import { isBookingJournalInactive, type BookingJournalContext } from "./journal-activity";
import { MemberMoneyPlanError, type MemberMoneyDebtor, type MemberMoneyPostingContext, type MemberMoneySource } from "./plan";
import { postMemberMoneyEvent, reverseMemberMoneyJournal } from "./post";
import { linkLegacyLinesToPostedBatch } from "./store";

type Db = Prisma.TransactionClient;
export interface BookingReceiptDecision {
  /** No selection means catch-up only. Never select an instrument by amount or time. */
  paymentIntentId?: string;
  transactionIds?: readonly string[];
  collect: boolean;
  /** The officer settle selected its audited CASH_RECORDED rows, including a covered addition. */
  officerCash?: true;
  effectiveAt?: Date;
  /** A provider-owned civil payment day, when it supplies no time of day. */
  effectiveDate?: CalendarDate;
}

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

export async function receiptBookingDebtor(tx: Db, bookingId: string): Promise<MemberMoneyDebtor> {
  // Payment-row-only writers must never take a Booking row lock (INV-LOCK-002).
  const booking = await tx.booking.findUniqueOrThrow({ where: { id: bookingId }, select: { memberId: true, organisationId: true } });
  const owner = bookingOwnerProviderMetadata(booking);
  return "memberId" in owner ? { kind: "MEMBER", memberId: owner.memberId } : { kind: "ORGANISATION", organisationId: owner.organisationId };
}

/** A ZERO R01 has no obligation. A named debit and unnamed equal credit open its face without charging again. */
async function chargeObligation(tx: Db, context: MemberMoneyPostingContext, booking: { bookingId: string; lodgeId: string }, debtor: MemberMoneyDebtor) {
  const rootKey = memberMoneyEventKeys.bookingCharge(booking.bookingId);
  let state = await readMemberMoneyApplicationState(tx, booking.bookingId);
  let found = state.obligations.find((o) => o.kind === "CHARGE" && o.debtorKind === debtor.kind
    && (debtor.kind === "MEMBER" ? o.memberId === debtor.memberId : o.organisationId === debtor.organisationId));
  if (found) return found;
  const faceCents = (await readBookingLiveComponents(tx, booking.bookingId)).reduce((sum, c) => sum + c.liveGrossCents, 0);
  if (faceCents <= 0) return null;
  if (state.obligations.some((o) => o.key === rootKey)) {
    // A merge moved ownership before this first collection. Its successor belongs to the new debtor.
    await postChargeSuccessors(tx, context, { bookingId: booking.bookingId, lodgeId: booking.lodgeId, debtor });
  } else {
    const eventKey = memberMoneyEventKeys.chargeOpen(booking.bookingId);
    const source = { kind: "BOOKING" as const, id: booking.bookingId, version: eventKey };
    await postMemberMoneyEvent(tx, context, { kind: "TRANSFER", eventKey, origin: "APP", source, reason: "Open a charge obligation after ZERO R01",
      obligations: [{ key: rootKey, kind: "CHARGE", debtor, faceCents, evidence: { lazy: true } }],
      legs: [
        { type: "amount", account: "MEMBER_RECEIVABLE", side: "DEBIT", amountCents: faceCents, debtor, booking, obligationKey: rootKey, evidence: { lazy: true } },
        { type: "amount", account: "MEMBER_RECEIVABLE", side: "CREDIT", amountCents: faceCents, debtor, booking, evidence: { lazy: true } },
      ] });
  }
  state = await readMemberMoneyApplicationState(tx, booking.bookingId);
  found = state.obligations.find((o) => o.kind === "CHARGE" && o.debtorKind === debtor.kind
    && (debtor.kind === "MEMBER" ? o.memberId === debtor.memberId : o.organisationId === debtor.organisationId));
  return found ?? null;
}

/** D4: immutable obligations get successors, never a new debtor written onto history. No Payment/Booking lock in merge. */
export async function postChargeSuccessors(tx: Db, context: MemberMoneyPostingContext, input: {
  bookingId: string; lodgeId: string; debtor: MemberMoneyDebtor; fromMemberId?: string;
}): Promise<void> {
  const state = await readMemberMoneyApplicationState(tx, input.bookingId);
  for (const original of state.obligations.filter((o) => o.kind === "CHARGE"
    && (input.fromMemberId === undefined || o.memberId === input.fromMemberId))) {
    const debtorId = input.debtor.kind === "MEMBER" ? input.debtor.memberId : input.debtor.organisationId;
    if (original.debtorKind === input.debtor.kind && (original.memberId ?? original.organisationId) === debtorId) continue;
    // Only transfer a live tip, rather than minting another path from an already succeeded obligation.
    if (state.obligations.some((o) => o.key.startsWith(`${original.key}|for|`))) continue;
    const applications = new Map(state.applications.map((a) => [a.id, a]));
    const sign = (id: string): number => { const a = applications.get(id)!; return a.reversesApplicationId ? -sign(a.reversesApplicationId) : 1; };
    const collected = state.applications.filter((a) => a.obligationId === original.id)
      .reduce((sum, a) => sum + a.amountCents * sign(a.id), 0);
    const faceCents = Math.max(0, original.faceCents - collected);
    if (faceCents === 0) continue;
    const eventKey = memberMoneyEventKeys.successor(original.key, original.memberId ?? original.organisationId!, debtorId);
    if (await tx.memberMoneyEvent.findUnique({ where: { eventKey }, select: { id: true } })) continue;
    const successor = memberMoneyApplicationKeys.successor(original.key, input.debtor.kind, debtorId);
    const booking = { bookingId: input.bookingId, lodgeId: input.lodgeId };
    const leg = { type: "amount" as const, account: "MEMBER_RECEIVABLE" as const, amountCents: faceCents, debtor: input.debtor, booking, evidence: { predecessor: original.key } };
    await postMemberMoneyEvent(tx, context, { kind: "TRANSFER", eventKey, origin: "APP",
      source: { kind: "BOOKING", id: input.bookingId, version: eventKey }, reason: "Member merge charge successor",
      obligations: [{ key: successor, kind: "CHARGE", debtor: input.debtor, faceCents, evidence: { predecessor: original.key } }],
      legs: [{ ...leg, side: "DEBIT", obligationKey: successor }, { ...leg, side: "CREDIT" }] });
    state.obligations.push({ ...original, id: successor, key: successor, faceCents, debtorKind: input.debtor.kind,
      memberId: input.debtor.kind === "MEMBER" ? input.debtor.memberId : null,
      organisationId: input.debtor.kind === "ORGANISATION" ? input.debtor.organisationId : null });
  }
}

const MERGE_SNAPSHOT_VERSION = "member-money-merge-snapshot-1";

/** The same immutable line snapshot determines both the balances and the source events a merge included. */
export function memberMergeSnapshotSources(eventKey: ReturnType<typeof memberMoneyEventKeys.merge>, eventIds: readonly string[]): MemberMoneySource[] {
  return [{ kind: "PROVIDER_FACT", id: eventKey, version: MERGE_SNAPSHOT_VERSION },
    ...[...new Set(eventIds)].sort().map((id): MemberMoneySource => ({ kind: "PROVIDER_FACT", id, version: eventKey }))];
}

/** Transfer only an exact event omitted from the merge's snapshot, never a balance attributed by timing or amount. */
async function moveReceiptResidue(tx: Db, context: MemberMoneyPostingContext, booking: { bookingId: string; lodgeId: string }, eventKey: ReturnType<typeof memberMoneyEventKeys.capture>) {
  const debtor = await receiptBookingDebtor(tx, booking.bookingId);
  if (debtor.kind !== "MEMBER") return;
  const event = await tx.memberMoneyEvent.findUniqueOrThrow({ where: { eventKey }, select: { id: true, journal: { select: { lines: {
    where: { account: "MEMBER_RECEIVABLE", debtorKind: "MEMBER", bookingId: booking.bookingId, memberId: { not: debtor.memberId } },
    select: { memberId: true, side: true, amountCents: true },
  } } } } });
  const balances = new Map<string, number>();
  for (const line of event.journal!.lines) if (line.memberId) balances.set(line.memberId,
    (balances.get(line.memberId) ?? 0) + (line.side === "DEBIT" ? 1 : -1) * line.amountCents);
  for (const [from, cents] of balances) {
    if (cents === 0) continue;
    // A member merges away once. This also finds the first merge when the survivor later merges again.
    const merge = await tx.memberMoneyEvent.findFirst({ where: { sourceKind: "OFFICER_FACT", sourceIdentity: from, sourceVersion: { startsWith: "merge:" } },
      select: { eventKey: true, journal: { select: { sources: { select: { sourceKind: true, sourceId: true, sourceVersion: true } } } } } });
    const sources = merge?.journal?.sources ?? [];
    if (!sources.some((s) => s.sourceId === merge!.eventKey && s.sourceVersion === MERGE_SNAPSHOT_VERSION)) continue;
    if (sources.some((s) => s.sourceId === event.id && s.sourceVersion === merge!.eventKey)) continue;
    const key = memberMoneyEventKeys.mergeResidue(from, debtor.memberId, eventKey);
    if (await tx.memberMoneyEvent.findUnique({ where: { eventKey: key }, select: { id: true } })) continue;
    const leg = { type: "amount" as const, account: "MEMBER_RECEIVABLE" as const, amountCents: Math.abs(cents), booking, evidence: { strayEventKey: eventKey } };
    await postMemberMoneyEvent(tx, context, { kind: "TRANSFER", eventKey: key, origin: "APP",
      source: { kind: "BOOKING", id: booking.bookingId, version: key }, reason: "Move merged-debtor residue",
      legs: [{ ...leg, side: cents > 0 ? "CREDIT" : "DEBIT", debtor: { kind: "MEMBER", memberId: from } },
        { ...leg, side: cents > 0 ? "DEBIT" : "CREDIT", debtor }] });
  }
}

/** R06/R07/R08, beside the writer's own mutation. No caught refusal, provider call, inferred collection or new advisory key. */
export async function postBookingReceipts(tx: Db, context: BookingJournalContext, input: {
  paymentId: string; decision?: BookingReceiptDecision;
}): Promise<number> {
  if (isBookingJournalInactive(context)) return 0;
  const owner = await tx.payment.findUnique({ where: { id: input.paymentId }, select: { bookingId: true } });
  if (!owner || !await tx.memberMoneyEvent.findUnique({ where: { eventKey: memberMoneyEventKeys.bookingCharge(owner.bookingId) }, select: { id: true } })) return 0;
  await lockMemberMoneyPayment(tx, owner.bookingId);
  const payment = await tx.payment.findUniqueOrThrow({ where: { id: input.paymentId },
    include: { booking: { select: { lodgeId: true } }, transactions: true } });
  const booking = { bookingId: owner.bookingId, lodgeId: payment.booking.lodgeId };
  const debtor = await receiptBookingDebtor(tx, owner.bookingId);
  const lines = await tx.bookingLedgerLine.findMany({ where: { bookingId: owner.bookingId, side: "SETTLEMENT",
    kind: { in: ["CARD_CAPTURE", "BANK_RECEIPT", "CASH_RECORDED"] } }, orderBy: [{ postedAt: "asc" }, { id: "asc" }] });
  let posted = 0;
  for (const line of lines.filter((l) => l.reversesLineId === null)) {
    const row = payment.transactions.find((t) => t.id === line.anchorId);
    if (!row || row.reason === ORGANISER_SHARE_RECEIPT_REASON || line.amountCents <= 0) continue;
    const card = line.kind === "CARD_CAPTURE";
    const eventKey = bookingReceiptEventKey(row, line);
    const selected = input.decision?.officerCash === true && line.kind === "CASH_RECORDED"
      || input.decision?.paymentIntentId === row.stripePaymentIntentId && row.stripePaymentIntentId !== null
      || input.decision?.transactionIds?.includes(row.id) === true;
    const original = await tx.memberMoneyEvent.findUnique({ where: { eventKey }, select: { journal: { select: { id: true } } } });
    const at = selected && input.decision?.effectiveDate ? new Date(startOfClubDay(input.decision.effectiveDate, context.zone))
      : selected && input.decision?.effectiveAt ? input.decision.effectiveAt : line.postedAt;
    const factContext = receiptFactContext(context, at);
    const source = { kind: "PAYMENT" as const, id: row.id, version: line.postingKey ?? line.id };
    if (!original) {
      // Full cash always posts, even if there is no charge or the charge is already collected.
      const evidence = { transactionId: row.id, settlementLineId: line.id, datedBy: selected && input.decision?.effectiveDate ? "source-date" : selected && input.decision?.effectiveAt ? "source" : "app-record" };
      const result = await postMemberMoneyEvent(tx, factContext, { kind: "RECEIPT", eventKey,
        origin: card ? "STRIPE" : line.kind === "CASH_RECORDED" ? "OFFICER" : "XERO", source, reason: "Booking receipt",
        legs: [
          { type: "amount", account: card ? "STRIPE_CLEARING" : line.kind === "CASH_RECORDED" ? "CASH" : "BANK", side: "DEBIT", amountCents: line.amountCents, booking, evidence },
          { type: "amount", account: "MEMBER_RECEIVABLE", side: "CREDIT", amountCents: line.amountCents, debtor, booking, evidence },
        ] });
      const credit = await tx.memberMoneyLine.findFirstOrThrow({ where: { journalId: result.journalId, account: "MEMBER_RECEIVABLE", side: "CREDIT" }, select: { id: true } });
      await linkLegacyLinesToPostedBatch(tx, { journalId: result.journalId, receivableLegId: credit.id, lines: [{ id: line.id, version: line.postingKey ?? line.id }] });
      posted++;
    }
    await moveReceiptResidue(tx, factContext, booking, eventKey);
    const receipt = await tx.memberMoneyEvent.findUniqueOrThrow({ where: { eventKey }, select: { journal: { select: { id: true, reversedBy: { select: { id: true } } } } } });
    const reversedLine = lines.find((l) => l.reversesLineId === line.id);
    if (reversedLine) {
      if (!receipt.journal!.reversedBy) {
        const reversal = await reverseMemberMoneyJournal(tx, receiptFactContext(context, reversedLine.postedAt), {
          reversesJournalId: receipt.journal!.id, origin: "OFFICER", source: { kind: "PAYMENT", id: row.id, version: reversedLine.id }, reason: "Reverse officer receipt" });
        const debit = await tx.memberMoneyLine.findFirstOrThrow({ where: { journalId: reversal.journalId, account: "MEMBER_RECEIVABLE", side: "DEBIT" }, select: { id: true } });
        await linkLegacyLinesToPostedBatch(tx, { journalId: reversal.journalId, receivableLegId: debit.id, lines: [{ id: reversedLine.id, version: reversedLine.postingKey ?? reversedLine.id }] });
        posted++;
      }
      await moveReceiptResidue(tx, receiptFactContext(context, reversedLine.postedAt), booking, memberMoneyEventKeys.reversal(receipt.journal!.id));
      continue;
    }
    if (!selected || !input.decision?.collect || receipt.journal!.reversedBy) continue;
    const collectKey = memberMoneyEventKeys.collect(eventKey);
    if (await tx.memberMoneyEvent.findUnique({ where: { eventKey: collectKey }, select: { id: true } })) continue;
    const obligation = await chargeObligation(tx, factContext, booking, await receiptBookingDebtor(tx, booking.bookingId));
    if (!obligation) continue;
    const state = await readMemberMoneyApplicationState(tx, booking.bookingId);
    const totals = memberMoneyApplicationTotals(state);
    const liveCharge = (await readBookingLiveComponents(tx, booking.bookingId)).reduce((sum, c) => sum + c.liveGrossCents, 0);
    const sourceLine = await tx.memberMoneyLine.findFirstOrThrow({ where: { journalId: receipt.journal!.id, account: "MEMBER_RECEIVABLE", side: "CREDIT" } });
    const applicationSource = state.sources.find((s) => s.id === sourceLine.id)!;
    // A receipt racing merge keeps its original debtor. D4 must move it explicitly, never mutate history.
    if (!sameApplicationDebtor(applicationSource, obligation)) continue;
    const amountCents = Math.min(sourceLine.amountCents - (totals.sources.get(sourceLine.id) ?? 0), liveCharge - totals.collected);
    if (amountCents <= 0) continue;
    await postMemberMoneyEvent(tx, factContext, { kind: "ZERO", eventKey: collectKey, origin: "APP", source: { ...source, version: collectKey },
      reason: "Apply the receipt the settlement selected", applications: [{ key: memberMoneyApplicationKeys.application(collectKey, row.id, obligation.key),
        source: { lineId: sourceLine.id }, obligationKey: obligation.key, amountCents }] });
    posted++;
  }
  return posted;
}
