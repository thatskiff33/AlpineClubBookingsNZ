import type { Prisma } from "@prisma/client";
import { bookingOwnerProviderMetadata } from "../../booking-owner";
import { requireInstant, type ClubTimeZone } from "../../club-time";
import { ORGANISER_SHARE_RECEIPT_REASON } from "../../organiser-extra-state";
import { lockMemberMoneyPayment, readMemberMoneyApplicationState } from "./application-read";
import { memberMoneyApplicationTotals, netCollectOnObligation, type ApplicationObligation, type ApplicationState } from "./application-state";
import { readBookingLiveComponents } from "./booking-journal-read";
import { isBookingJournalInactive, type BookingJournalContext } from "./journal-activity";
import { memberMoneyApplicationKeys, memberMoneyEventKeys, walkMemberMoneyChain, type MemberMoneyEventKey } from "./keys";
import {
  type MemberMoneyDebtor,
  type MemberMoneyPlan,
  type MemberMoneyPostingContext,
  MemberMoneyPlanError,
} from "./plan";
import { postMemberMoneyEvent, redateMemberMoneyPostingContext, reverseMemberMoneyJournal } from "./post";

type Db = Prisma.TransactionClient;
const RECEIPT_KINDS = ["CARD_CAPTURE", "BANK_RECEIPT", "CASH_RECORDED"] as const;
type ReceiptKind = (typeof RECEIPT_KINDS)[number];

/**
 * What one receipt door decided for the lines it just wrote. Every other live
 * receipt on the booking is caught up unapplied. No focus means the whole
 * booking is catch-up.
 */
export interface PostBookingReceiptsInput {
  bookingId: string;
  zone: ClubTimeZone;
  apply: "collect" | "hold";
  focusPaymentIntentIds?: readonly string[];
  focusKinds?: readonly ReceiptKind[];
  /** The provider instant, when the caller already holds the intent. Never read here. */
  capturedAt?: Date | null;
  /** Xero's payment date, or the officer's settle instant, already in hand. */
  receiptAt?: Date | null;
  actorMemberId?: string | null;
  /** Officer mark-paid reversal: reverse journals whose settlement line no longer stands. */
  reverseRetired?: boolean;
}

const CASH_ACCOUNT = { CARD_CAPTURE: "STRIPE_CLEARING", BANK_RECEIPT: "BANK", CASH_RECORDED: "CASH" } as const;
const RULE = { CARD_CAPTURE: "R06", BANK_RECEIPT: "R07", CASH_RECORDED: "R08" } as const;
const ORIGIN = { CARD_CAPTURE: "STRIPE", BANK_RECEIPT: "XERO", CASH_RECORDED: "OFFICER" } as const;

/**
 * R06, R07 and R08 beside the legacy receipt, in the caller's transaction.
 * Cash is posted in full. A collect application is trimmed to the source line
 * and to the booking's live charge; the rest stays unapplied. A refusal is not
 * caught: it rolls the door back.
 */
export async function postBookingReceipts(
  tx: Db,
  journal: BookingJournalContext,
  input: PostBookingReceiptsInput,
): Promise<void> {
  if (isBookingJournalInactive(journal)) return;
  const chargeKey = memberMoneyEventKeys.bookingCharge(input.bookingId);
  if (!(await tx.memberMoneyEvent.findUnique({ where: { eventKey: chargeKey }, select: { id: true } }))) return;
  if (await tx.payment.count({ where: { bookingId: input.bookingId } }) !== 1) return;
  await lockMemberMoneyPayment(tx, input.bookingId);
  const booking = await tx.booking.findUnique({
    where: { id: input.bookingId },
    select: { lodgeId: true, memberId: true, organisationId: true },
  });
  if (!booking) throw new MemberMoneyPlanError([`booking ${input.bookingId} does not exist`]);
  const owner = bookingOwnerProviderMetadata(booking);
  const debtor: MemberMoneyDebtor = "memberId" in owner
    ? { kind: "MEMBER", memberId: owner.memberId }
    : { kind: "ORGANISATION", organisationId: owner.organisationId };
  if (input.reverseRetired) await reverseRetiredReceipts(tx, journal, input);
  if (debtor.kind === "MEMBER") await movePostSnapshotResidue(tx, journal, input.bookingId, booking.lodgeId, debtor.memberId);
  await postLiveReceipts(tx, journal, input, debtor, booking.lodgeId);
}

async function reverseRetiredReceipts(tx: Db, context: MemberMoneyPostingContext, input: PostBookingReceiptsInput): Promise<void> {
  const retired = await tx.bookingLedgerLine.findMany({
    where: {
      bookingId: input.bookingId, side: "SETTLEMENT", kind: { in: [...RECEIPT_KINDS] },
      reversedBy: { isNot: null },
    },
    select: { id: true },
  });
  for (const line of retired) {
    const link = await tx.memberMoneySourceLink.findUnique({
      where: { bookingLedgerLineId: line.id },
      select: { journal: { select: { id: true, reversedBy: { select: { id: true } } } } },
    });
    if (!link || link.journal.reversedBy) continue;
    await reverseMemberMoneyJournal(tx, context, {
      reversesJournalId: link.journal.id,
      origin: "OFFICER",
      source: { kind: "OFFICER_FACT", id: input.actorMemberId ?? input.bookingId, version: `receipt-reversal:${link.journal.id}` },
      reason: "The officer's receipt was reversed",
      actorMemberId: input.actorMemberId,
    });
  }
}

async function postLiveReceipts(
  tx: Db,
  context: MemberMoneyPostingContext,
  input: PostBookingReceiptsInput,
  debtor: MemberMoneyDebtor,
  lodgeId: string,
): Promise<void> {
  const lines = await tx.bookingLedgerLine.findMany({
    where: {
      bookingId: input.bookingId, side: "SETTLEMENT", kind: { in: [...RECEIPT_KINDS] },
      sign: 1, amountCents: { gt: 0 }, reversesLineId: null, reversedBy: { is: null },
      anchorKind: "PAYMENT_TRANSACTION",
    },
    orderBy: { id: "asc" },
    select: { id: true, kind: true, amountCents: true, postedAt: true, anchorId: true },
  });
  if (lines.length === 0) return;
  const transactions = await tx.paymentTransaction.findMany({
    where: { id: { in: lines.map((line) => line.anchorId) } },
    select: { id: true, reason: true, stripePaymentIntentId: true },
  });
  const byId = new Map(transactions.map((row) => [row.id, row]));
  let state = await readMemberMoneyApplicationState(tx, input.bookingId);
  for (const line of lines) {
    const transaction = byId.get(line.anchorId);
    if (!transaction || transaction.reason === ORGANISER_SHARE_RECEIPT_REASON) continue;
    const kind = line.kind as ReceiptKind;
    if (kind === "CARD_CAPTURE" && !transaction.stripePaymentIntentId) continue;
    const focus = isFocus(kind, transaction.stripePaymentIntentId, input);
    const decision = focus ? input.apply : "hold";
    const dated = receiptInstant(line.postedAt, kind, focus, input);
    state = await postOneReceipt(tx, context, input, {
      line, kind, transactionId: transaction.id, paymentIntentId: transaction.stripePaymentIntentId,
      debtor, lodgeId, decision, dated, state,
    });
  }
}

function isFocus(kind: ReceiptKind, paymentIntentId: string | null, input: PostBookingReceiptsInput): boolean {
  if (paymentIntentId && input.focusPaymentIntentIds?.includes(paymentIntentId)) return true;
  return input.focusKinds?.includes(kind) ?? false;
}

function receiptInstant(
  postedAt: Date,
  kind: ReceiptKind,
  focus: boolean,
  input: PostBookingReceiptsInput,
): { at: Date; datedBy: "provider" | "xero" | "officer" | "app-record" } {
  if (focus && kind === "CARD_CAPTURE" && input.capturedAt) return { at: input.capturedAt, datedBy: "provider" };
  if (focus && input.receiptAt) return { at: input.receiptAt, datedBy: kind === "CASH_RECORDED" ? "officer" : "xero" };
  return { at: postedAt, datedBy: "app-record" };
}

async function postOneReceipt(
  tx: Db,
  context: MemberMoneyPostingContext,
  input: PostBookingReceiptsInput,
  row: {
    line: { id: string; amountCents: number };
    kind: ReceiptKind;
    transactionId: string;
    paymentIntentId: string | null;
    debtor: MemberMoneyDebtor;
    lodgeId: string;
    decision: "collect" | "hold";
    dated: { at: Date; datedBy: "provider" | "xero" | "officer" | "app-record" };
    state: ApplicationState;
  },
): Promise<ApplicationState> {
  const base = row.kind === "CARD_CAPTURE"
    ? memberMoneyEventKeys.capture(row.paymentIntentId!)
    : memberMoneyEventKeys.receipt(row.transactionId, row.line.id);
  const tip = await walkMemberMoneyChain(base, async (eventKey) => {
    const event = await tx.memberMoneyEvent.findUnique({
      where: { eventKey },
      select: { journal: { select: { reversedBy: { select: { id: true } } } } },
    });
    if (!event?.journal) return null;
    return { reversedBy: event.journal.reversedBy };
  });
  const posted = await tx.memberMoneyLine.findFirst({
    where: { journal: { event: { eventKey: tip }, reversesJournalId: null }, account: CASH_ACCOUNT[row.kind], side: "DEBIT" },
    select: { amountCents: true },
  });
  let state = row.state;
  if (posted) {
    if (posted.amountCents !== row.line.amountCents) return state;
  } else {
    state = await ensureChargeObligation(tx, context, input, row, state);
    const obligation = row.decision === "collect" ? chargeObligation(state, input.bookingId, row.debtor) : null;
    const room = obligation ? await collectRoom(tx, input.bookingId, state) : 0;
    const applied = obligation ? Math.min(row.line.amountCents, Math.max(0, room)) : 0;
    await postMemberMoneyEvent(tx, redateMemberMoneyPostingContext(context, requireInstant(row.dated.at), input.zone), receiptPlan(input, row, tip, applied, obligation));
    state = await readMemberMoneyApplicationState(tx, input.bookingId);
    if (row.decision !== "collect" || applied > 0 || !obligation) return state;
  }
  if (row.decision !== "collect") return state;
  return postCollect(tx, context, input, row, tip, state);
}

function receiptPlan(
  input: PostBookingReceiptsInput,
  row: {
    line: { id: string; amountCents: number };
    kind: ReceiptKind;
    transactionId: string;
    paymentIntentId: string | null;
    debtor: MemberMoneyDebtor;
    lodgeId: string;
    dated: { datedBy: string };
  },
  eventKey: MemberMoneyEventKey,
  applied: number,
  obligation: ApplicationObligation | null,
): MemberMoneyPlan {
  const booking = { bookingId: input.bookingId, lodgeId: row.lodgeId };
  const evidence = { rule: RULE[row.kind], datedBy: row.dated.datedBy, settlementLineId: row.line.id };
  const sourceIdentity = row.paymentIntentId ?? row.line.id;
  return {
    kind: "RECEIPT",
    eventKey,
    origin: ORIGIN[row.kind],
    source: { kind: "PAYMENT", id: row.transactionId, version: row.line.id },
    reason: "Booking receipt",
    actorMemberId: row.kind === "CASH_RECORDED" ? input.actorMemberId : null,
    legs: [
      { type: "amount", account: CASH_ACCOUNT[row.kind], side: "DEBIT", amountCents: row.line.amountCents,
        source: { kind: "BOOKING_LEDGER", id: row.line.id, version: row.line.id }, booking, evidence },
      { type: "amount", account: "MEMBER_RECEIVABLE", side: "CREDIT", amountCents: row.line.amountCents, debtor: row.debtor, booking, evidence },
    ],
    ...(applied > 0 && obligation ? { applications: [{
      key: memberMoneyApplicationKeys.application(eventKey, sourceIdentity, obligation.key),
      source: { leg: 1 }, obligationKey: obligation.key, amountCents: applied,
    }] } : {}),
  };
}

async function postCollect(
  tx: Db,
  context: MemberMoneyPostingContext,
  input: PostBookingReceiptsInput,
  row: {
    line: { id: string; amountCents: number };
    transactionId: string;
    paymentIntentId: string | null;
    debtor: MemberMoneyDebtor;
    dated: { at: Date };
  },
  receiptKey: MemberMoneyEventKey,
  state: ApplicationState,
): Promise<ApplicationState> {
  const collectKey = memberMoneyEventKeys.collect(receiptKey);
  if (await tx.memberMoneyEvent.findUnique({ where: { eventKey: collectKey }, select: { id: true } })) return state;
  const obligation = chargeObligation(state, input.bookingId, row.debtor);
  if (!obligation) return state;
  const credit = await tx.memberMoneyLine.findFirst({
    where: {
      account: "MEMBER_RECEIVABLE", side: "CREDIT", bookingId: input.bookingId, reversedBy: { is: null },
      journal: { event: { eventKey: receiptKey }, reversesJournalId: null },
    },
    select: { id: true, amountCents: true },
  });
  if (!credit) return state;
  const already = memberMoneyApplicationTotals(state).sources.get(credit.id) ?? 0;
  const amount = Math.min(credit.amountCents - already, await collectRoom(tx, input.bookingId, state));
  if (amount <= 0) return state;
  const sourceIdentity = row.paymentIntentId ?? row.line.id;
  await postMemberMoneyEvent(tx, redateMemberMoneyPostingContext(context, requireInstant(row.dated.at), input.zone), {
    kind: "ZERO",
    eventKey: collectKey,
    origin: "APP",
    source: { kind: "PAYMENT", id: row.transactionId, version: `collect:${row.line.id}` },
    reason: "Collect a receipt already posted",
    applications: [{
      key: memberMoneyApplicationKeys.application(collectKey, sourceIdentity, obligation.key),
      source: { lineId: credit.id }, obligationKey: obligation.key, amountCents: amount,
    }],
  });
  return readMemberMoneyApplicationState(tx, input.bookingId);
}

async function ensureChargeObligation(
  tx: Db,
  context: MemberMoneyPostingContext,
  input: PostBookingReceiptsInput,
  row: { debtor: MemberMoneyDebtor; lodgeId: string; decision: "collect" | "hold"; dated: { at: Date } },
  state: ApplicationState,
): Promise<ApplicationState> {
  if (row.decision !== "collect" || anyCharge(state, input.bookingId)) return state;
  const openKey = memberMoneyEventKeys.chargeOpen(input.bookingId);
  if (await tx.memberMoneyEvent.findUnique({ where: { eventKey: openKey }, select: { id: true } })) return state;
  const face = (await readBookingLiveComponents(tx, input.bookingId)).reduce((sum, component) => sum + component.liveGrossCents, 0);
  if (face <= 0) return state;
  const obligationKey = memberMoneyEventKeys.bookingCharge(input.bookingId);
  const booking = { bookingId: input.bookingId, lodgeId: row.lodgeId };
  const evidence = { rule: "R01", opened: "lazy" };
  await postMemberMoneyEvent(tx, redateMemberMoneyPostingContext(context, requireInstant(row.dated.at), input.zone), {
    kind: "ADJUSTMENT",
    eventKey: openKey,
    origin: "APP",
    source: { kind: "BOOKING", id: input.bookingId, version: "charge-open" },
    reason: "Open the booking's charge obligation at the first receipt that collects",
    obligations: [{ key: obligationKey, kind: "CHARGE", debtor: row.debtor, faceCents: face, evidence }],
    legs: [
      { type: "amount", account: "MEMBER_RECEIVABLE", side: "DEBIT", amountCents: face, debtor: row.debtor, obligationKey, booking, evidence },
      { type: "amount", account: "MEMBER_RECEIVABLE", side: "CREDIT", amountCents: face, debtor: row.debtor, booking, evidence },
    ],
  });
  return readMemberMoneyApplicationState(tx, input.bookingId);
}

async function collectRoom(tx: Db, bookingId: string, state: ApplicationState): Promise<number> {
  const live = (await readBookingLiveComponents(tx, bookingId)).reduce((sum, component) => sum + component.liveGrossCents, 0);
  return Math.max(0, live - memberMoneyApplicationTotals(state).collected);
}

function chargePrefix(bookingId: string): string {
  return memberMoneyEventKeys.bookingCharge(bookingId);
}

function anyCharge(state: ApplicationState, bookingId: string): boolean {
  const prefix = chargePrefix(bookingId);
  return state.obligations.some((obligation) => obligation.kind === "CHARGE" && (obligation.key === prefix || obligation.key.startsWith(`${prefix}|`)));
}

function chargeObligation(state: ApplicationState, bookingId: string, debtor: MemberMoneyDebtor): ApplicationObligation | null {
  const prefix = chargePrefix(bookingId);
  const owned = state.obligations.filter((obligation) => obligation.kind === "CHARGE"
    && (obligation.key === prefix || obligation.key.startsWith(`${prefix}|`))
    && sameDebtor(obligation, debtor));
  owned.sort((left, right) => right.key.split("|for|").length - left.key.split("|for|").length);
  return owned[0] ?? null;
}

function sameDebtor(obligation: ApplicationObligation, debtor: MemberMoneyDebtor): boolean {
  return debtor.kind === "MEMBER"
    ? obligation.debtorKind === "MEMBER" && obligation.memberId === debtor.memberId
    : obligation.debtorKind === "ORGANISATION" && obligation.organisationId === debtor.organisationId;
}

/**
 * A merge records the events it saw. Money that landed on the merged-away
 * member after that snapshot moves here, on the next receipt, and only that
 * money. An older merge with no snapshot is left alone.
 */
async function movePostSnapshotResidue(
  tx: Db,
  context: MemberMoneyPostingContext,
  bookingId: string,
  lodgeId: string,
  ownerMemberId: string,
): Promise<void> {
  const legs = await tx.memberMoneyLine.findMany({
    where: { bookingId, account: "MEMBER_RECEIVABLE", debtorKind: "MEMBER", memberId: { not: ownerMemberId } },
    select: { memberId: true, side: true, amountCents: true, journal: { select: { event: { select: { eventKey: true } } } } },
  });
  const nets = new Map<string, { from: string; eventKey: string; cents: number }>();
  for (const leg of legs) {
    if (!leg.memberId) continue;
    const eventKey = leg.journal.event.eventKey;
    const id = `${leg.memberId}\u0000${eventKey}`;
    const entry = nets.get(id) ?? { from: leg.memberId, eventKey, cents: 0 };
    entry.cents += (leg.side === "DEBIT" ? 1 : -1) * leg.amountCents;
    nets.set(id, entry);
  }
  for (const entry of nets.values()) {
    if (entry.cents === 0 || isMovementEvent(entry.eventKey, entry.from, ownerMemberId)) continue;
    const mergeKey = memberMoneyEventKeys.merge(entry.from, ownerMemberId);
    const merge = await tx.memberMoneyEvent.findUnique({
      where: { eventKey: mergeKey },
      select: { journal: { select: { id: true, sourceLinks: { select: { sourceVersion: true } } } } },
    });
    const versions = merge?.journal.sourceLinks.map((link) => link.sourceVersion) ?? [];
    if (!versions.some((version) => version.startsWith("snapshot:"))) continue;
    const seen = new Set(versions.filter((version) => version.startsWith("snapshot:")).map((version) => version.slice("snapshot:".length)).filter((key) => key.length > 0));
    if (seen.has(entry.eventKey)) continue;
    const residueKey = memberMoneyEventKeys.mergeResidue(entry.from, ownerMemberId, entry.eventKey as MemberMoneyEventKey);
    if (await tx.memberMoneyEvent.findUnique({ where: { eventKey: residueKey }, select: { id: true } })) continue;
    const amount = Math.abs(entry.cents);
    const owed = entry.cents > 0;
    const from: MemberMoneyDebtor = { kind: "MEMBER", memberId: entry.from };
    const to: MemberMoneyDebtor = { kind: "MEMBER", memberId: ownerMemberId };
    const booking = { bookingId, lodgeId };
    const evidence = { rule: "D4", residue: entry.eventKey };
    await postMemberMoneyEvent(tx, context, {
      kind: "ADJUSTMENT",
      eventKey: residueKey,
      origin: "APP",
      source: { kind: "OFFICER_FACT", id: entry.from, version: `residue:${entry.eventKey}` },
      reason: "Receivable posted to a merged-away member after the merge snapshot",
      legs: [
        { type: "amount", account: "MEMBER_RECEIVABLE", side: owed ? "CREDIT" : "DEBIT", amountCents: amount, debtor: from, booking, evidence },
        { type: "amount", account: "MEMBER_RECEIVABLE", side: owed ? "DEBIT" : "CREDIT", amountCents: amount, debtor: to, booking, evidence },
      ],
    });
  }
}

function isMovementEvent(eventKey: string, from: string, to: string): boolean {
  return eventKey === `merge:${from}:${to}` || eventKey.startsWith(`merge-residue:${from}:${to}|`) || eventKey.startsWith("successor|");
}
