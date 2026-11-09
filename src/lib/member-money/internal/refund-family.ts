import type { Prisma } from "@prisma/client";
import { compareOrdinal } from "@/lib/ordinal-order";
import { readMemberMoneyApplicationState } from "./application-read";
import { memberMoneyApplicationTotals, refundFamilyKey, type ApplicationObligation, type ApplicationState } from "./application-state";
import { capProblem, isMemberMoneyCapProblem, MEMBER_MONEY_CAP_PROBLEMS } from "./cap-problems";
import { eventPosted } from "./booking-journal-read";
import { debtorId, lineDebtor, ownedBy } from "./booking-receipts";
import {
  memberMoneyApplicationKeys,
  memberMoneyEventKeys,
  walkMemberMoneyChain,
  type MemberMoneyEventKey,
  type RefundObligationScope,
} from "./keys";
import {
  buildMemberMoneyBatch,
  MemberMoneyPlanError,
  type MemberMoneyApplicationPlan,
  type MemberMoneyDebtor,
  type MemberMoneyPostingContext,
  type MemberMoneySource,
} from "./plan";
import { postMemberMoneyEvent } from "./post";
import { MemberMoneyReservationRefused, writeMemberMoneyBatch, type ApplicationCheck } from "./store";

/**
 * THE REFUND FAMILY (#4516, Ledger M4c). What every refund writer shares: the R05 key a door's debt lives under,
 * the family's live tip (D4's successor posted lazily under the Payment row), and funding a refund from one
 * exact receipt. Nothing here selects a receipt or an obligation by amount or time (design section 4).
 *
 * Every function here runs inside its caller's transaction, which already holds the booking's Payment row
 * (`lockMemberMoneyPayment`): the store takes it again for any batch with applications, a no-op.
 */

type Db = Prisma.TransactionClient;
export type RefundBooking = { bookingId: string; lodgeId: string };


/**
 * The R05 key a door's refund debt lives under now: its chain's live tip (`memberMoneyChainKey`), or null when no
 * live R05 is posted for it. `next` is the key a fresh R05 for that door posts under.
 */
export async function refundObligationChain(tx: Db, scope: RefundObligationScope, id: string): Promise<{ live: MemberMoneyEventKey | null; next: MemberMoneyEventKey }> {
  const tip = await walkMemberMoneyChain(memberMoneyEventKeys.refundObligation(scope, id), async (eventKey) =>
    (await tx.memberMoneyEvent.findUnique({ where: { eventKey }, select: { journal: { select: { reversedBy: { select: { id: true } } } } } }))?.journal ?? null);
  return (await eventPosted(tx, tip)) ? { live: tip, next: tip } : { live: null, next: tip };
}

/** A family's obligations, root first; the tip is the one no successor superseded. */
export function refundFamily(state: ApplicationState, rootKey: string): { members: ApplicationObligation[]; tip: ApplicationObligation | null } {
  const members = state.obligations.filter((o) => o.kind === "REFUND" && refundFamilyKey(o.key) === rootKey);
  return { members, tip: members.find((o) => !members.some((c) => memberMoneyApplicationKeys.succeeds(c.key, o.key))) ?? null };
}

/** What a family still owes: its root face less what is paid and what open reservations hold (C3's room). */
export function refundFamilyOpenCents(state: ApplicationState, rootKey: string): number {
  const root = state.obligations.find((o) => o.key === rootKey && o.kind === "REFUND");
  const family = memberMoneyApplicationTotals(state).families.get(rootKey);
  return root ? root.faceCents - (family?.paid ?? 0) - (family?.reserved ?? 0) : 0;
}

/**
 * D4 for a refund family (#4516): its live tip for the booking's current owner. When a member merge moved the
 * owner, the tip's remaining refund-payable balance moves to a successor on the owner, posted here, under the
 * Payment row every refund writer holds, so what it carries forward cannot miss a refund committing beside it
 * (merge holds no Payment row; M4b posts CHARGE successors the same way). The pair carries no application and
 * leaves the root face alone, so C3 and C4 still count the whole family. A tip with nothing left stays where it is.
 */
export async function refundFamilyTip(tx: Db, context: MemberMoneyPostingContext, booking: RefundBooking, rootKey: string,
  owner: MemberMoneyDebtor): Promise<ApplicationObligation | null> {
  const { tip } = refundFamily(await readMemberMoneyApplicationState(tx, booking.bookingId), rootKey);
  if (!tip || ownedBy(tip, owner)) return tip;
  const lines = await tx.memberMoneyLine.findMany({ where: { obligationId: tip.id, account: "REFUND_PAYABLE" }, select: { side: true, amountCents: true } });
  const remaining = lines.reduce((sum, line) => sum + (line.side === "CREDIT" ? line.amountCents : -line.amountCents), 0);
  if (remaining <= 0) return tip;
  const from = lineDebtor(tip);
  const eventKey = memberMoneyEventKeys.successor(tip.key, debtorId(from), debtorId(owner));
  const successor = memberMoneyApplicationKeys.successor(tip.key, owner.kind, debtorId(owner));
  if (!(await eventPosted(tx, eventKey))) {
    const leg = { type: "amount" as const, account: "REFUND_PAYABLE" as const, amountCents: remaining, booking, evidence: { predecessor: tip.key } };
    await postMemberMoneyEvent(tx, context, { kind: "TRANSFER", eventKey, origin: "APP",
      source: { kind: "BOOKING", id: booking.bookingId, version: eventKey }, reason: "Member merge refund successor",
      obligations: [{ key: successor, kind: "REFUND", debtor: owner, faceCents: remaining, evidence: { predecessor: tip.key } }],
      legs: [{ ...leg, side: "DEBIT", debtor: from, obligationKey: tip.key }, { ...leg, side: "CREDIT", debtor: owner, obligationKey: successor }] });
  }
  return refundFamily(await readMemberMoneyApplicationState(tx, booking.bookingId), rootKey).tip;
}

/** The R06 receipt's credit leg for a card capture, or null when the capture has no live receipt in the journal. */
export async function cardReceiptLine(tx: Db, paymentIntentId: string) {
  const event = await tx.memberMoneyEvent.findUnique({ where: { eventKey: memberMoneyEventKeys.capture(paymentIntentId) },
    select: { journal: { select: { reversedBy: { select: { id: true } }, lines: { where: { account: "MEMBER_RECEIVABLE", side: "CREDIT" },
      select: { id: true, amountCents: true, debtorKind: true, memberId: true, organisationId: true } } } } } });
  if (!event?.journal || event.journal.reversedBy) return null;
  return event.journal.lines[0] ?? null;
}

/**
 * A RESERVATION'S ATTEMPT KEY (#4516 review F4). A Stripe key's first reservation is that key, verbatim. One made
 * after every earlier reservation of the key was released without a refund answering it (an appeal re-approved
 * after `release_claim`, a re-send of a refused or superseded key) is the key's next generation, `<key>#<n>`: the
 * journal claims the debt again while Stripe is sent the key exactly as before, so a refund it made under that key
 * is replayed and never repeated. `#` is never in a Stripe key.
 */
const GENERATION_MARK = "#";
export function reservationGenerationKey(stripeKey: string, generation: number): string {
  if (stripeKey.length === 0 || stripeKey.includes(GENERATION_MARK) || !Number.isSafeInteger(generation) || generation < 1) {
    throw new MemberMoneyPlanError([`a reservation's Stripe key must be non-empty with no '${GENERATION_MARK}', and its generation a positive integer`]);
  }
  return generation === 1 ? stripeKey : `${stripeKey}${GENERATION_MARK}${generation}`;
}
/** The Stripe key a reservation was made for, whatever its generation. */
export function stripeKeyOfReservation(attemptKey: string): string {
  const mark = attemptKey.indexOf(GENERATION_MARK);
  return mark < 0 ? attemptKey : attemptKey.slice(0, mark);
}
/** Every generation of one Stripe key's reservations, as a where clause. */
export function reservationGenerationsWhere(stripeKey: string) {
  return { OR: [{ attemptKey: stripeKey }, { attemptKey: { startsWith: `${stripeKey}${GENERATION_MARK}` } }] };
}

/**
 * Whether a reservation's Stripe key is one the sender with this key prefix made (`refundSliceStripeIdempotencyKey`
 * for any of its slices, or the prefix itself for a row's one keyed request). A sender supersedes or withdraws only
 * its own keys (#4516 review F3): another sender's open reservation on the same debt is that sender's attempt in
 * flight, and C3 and C4 decide whether there is room beside it.
 */
export function isSenderStripeKey(stripeKey: string, senderKeyPrefix: string): boolean {
  return stripeKey === senderKeyPrefix || stripeKey.startsWith(`${senderKeyPrefix}_`);
}

/** A refusal for a broken cap; any other plan error is a fault, rethrown as it is. */
export function asReservationRefusal(error: unknown): unknown {
  if (error instanceof MemberMoneyPlanError && !(error instanceof MemberMoneyReservationRefused) && error.problems.some(isMemberMoneyCapProblem)) {
    return new MemberMoneyReservationRefused(error.problems);
  }
  return error;
}

const live = (state: ApplicationState, id: string) => !state.applications.some((a) => a.reversesApplicationId === id);

/**
 * Take back exactly `shortfallCents` of what the receipt line collected, so it can fund a refund (design section
 * 4, "Un-apply"): only that receipt, the one the legacy plan names, never another. Each live collection on it is
 * reversed whole, in id order (a stable order, never one by amount or time), and what was taken beyond the shortfall is collected again on the same obligation.
 * Its own event (`refundUncollect`), so it outlives any release of the funding it made room for.
 */
async function uncollect(tx: Db, context: MemberMoneyPostingContext, state: ApplicationState, input: {
  receiptLineId: string; shortfallCents: number; fundingKey: MemberMoneyEventKey; source: MemberMoneySource;
}): Promise<void> {
  const eventKey = memberMoneyEventKeys.refundUncollect(input.fundingKey);
  if (await eventPosted(tx, eventKey)) return;
  const charges = new Set(state.obligations.filter((o) => o.kind === "CHARGE").map((o) => o.id));
  const collections = state.applications
    .filter((a) => a.sourceLineId === input.receiptLineId && a.reversesApplicationId === null && charges.has(a.obligationId) && live(state, a.id))
    .sort((a, b) => compareOrdinal(a.id, b.id));
  const applications: MemberMoneyApplicationPlan[] = [];
  let taken = 0;
  let lastObligation: ApplicationObligation | undefined;
  for (const application of collections) {
    if (taken >= input.shortfallCents) break;
    lastObligation = state.obligations.find((o) => o.id === application.obligationId)!;
    applications.push({ key: memberMoneyApplicationKeys.application(eventKey, application.id, lastObligation.key), source: { lineId: input.receiptLineId },
      obligationKey: lastObligation.key, amountCents: application.amountCents, reversesApplicationId: application.id });
    taken += application.amountCents;
  }
  if (taken < input.shortfallCents) {
    throw new MemberMoneyReservationRefused([capProblem(MEMBER_MONEY_CAP_PROBLEMS.C1, `receipt line ${input.receiptLineId} cannot hold the refund it would fund`)]);
  }
  if (taken > input.shortfallCents) {
    applications.push({ key: memberMoneyApplicationKeys.application(eventKey, input.receiptLineId, lastObligation!.key), source: { lineId: input.receiptLineId },
      obligationKey: lastObligation!.key, amountCents: taken - input.shortfallCents });
  }
  await writeMemberMoneyBatch(tx, buildMemberMoneyBatch(context, { kind: "ZERO", eventKey, origin: "APP",
    source: { ...input.source, version: eventKey }, reason: "Take back a receipt's collection for the refund it funds", applications }));
}

/**
 * Fund a refund family's tip from one receipt line, under the key the caller names (`refundFunding` of the
 * reservation's attempt key, or a close's own). The receipt's room comes first; any shortfall is taken back from
 * that receipt's own collection (`uncollect`). `trim`: fund only what the receipt can hold (a close's cash is never
 * refused, design section 4); otherwise a receipt that cannot hold it is a `MemberMoneyReservationRefused`.
 * Returns the funding journal and what it funded; a replay returns the batch already posted.
 */
export async function fundRefundFromReceipt(tx: Db, context: MemberMoneyPostingContext, input: {
  bookingId: string; receiptLineId: string; obligationKey: string; amountCents: number; fundingKey: MemberMoneyEventKey;
  source: MemberMoneySource; trim?: boolean; reason: string;
}): Promise<{ journalId: string; fundedCents: number } | null> {
  const prior = await tx.memberMoneyEvent.findUnique({ where: { eventKey: input.fundingKey }, select: { journal: { select: { id: true, applications: { select: { amountCents: true } } } } } });
  if (prior?.journal) return { journalId: prior.journal.id, fundedCents: prior.journal.applications.reduce((n, a) => n + a.amountCents, 0) };
  const state = await readMemberMoneyApplicationState(tx, input.bookingId);
  const receipt = state.sources.find((s) => s.id === input.receiptLineId);
  if (!receipt) throw new MemberMoneyPlanError([`receipt line ${input.receiptLineId} is not on booking ${input.bookingId}`]);
  const applied = memberMoneyApplicationTotals(state).sources.get(receipt.id) ?? 0;
  const room = Math.max(0, receipt.amountCents - applied);
  const charges = new Set(state.obligations.filter((o) => o.kind === "CHARGE").map((o) => o.id));
  const collected = state.applications.filter((a) => a.sourceLineId === receipt.id && a.reversesApplicationId === null && charges.has(a.obligationId) && live(state, a.id))
    .reduce((n, a) => n + a.amountCents, 0);
  const fundedCents = input.trim ? Math.min(input.amountCents, room + collected) : input.amountCents;
  if (fundedCents <= 0) return null;
  try {
    if (fundedCents > room) await uncollect(tx, context, state, { receiptLineId: receipt.id, shortfallCents: fundedCents - room, fundingKey: input.fundingKey, source: input.source });
    const posted = await writeMemberMoneyBatch(tx, buildMemberMoneyBatch(context, { kind: "ZERO", eventKey: input.fundingKey, origin: "APP",
      source: { ...input.source, version: input.fundingKey }, reason: input.reason,
      applications: [{ key: memberMoneyApplicationKeys.application(input.fundingKey, receipt.id, input.obligationKey), source: { lineId: receipt.id },
        obligationKey: input.obligationKey, amountCents: fundedCents }] }));
    return { journalId: posted.journalId, fundedCents };
  } catch (error) {
    throw asReservationRefusal(error);
  }
}

/** Write a batch whose collect is sized against a live charge the same batch changes (a close-out's retained charge). */
export async function writeWithLiveCharge(tx: Db, context: MemberMoneyPostingContext, plan: Parameters<typeof buildMemberMoneyBatch>[1], check: ApplicationCheck) {
  return writeMemberMoneyBatch(tx, buildMemberMoneyBatch(context, plan), undefined, check);
}
