import type { Prisma } from "@prisma/client";
import logger from "../../logger";
import { receiptFactContext } from "./booking-receipts";
import { eventPosted } from "./booking-journal-read";
import { memberMoneyEventKeys, type MemberMoneyEventKey } from "./keys";
import { isBookingJournalInactive, type BookingJournalContext } from "./journal-activity";
import { MemberMoneyPlanError, type MemberMoneyDebtor } from "./plan";
import { postMemberMoneyEvent, reverseMemberMoneyJournal } from "./post";
import type { MemberMoneyPosting } from "./store";
import {
  planJoiningFee,
  planSubscriptionCharge,
  planSubscriptionReceipt,
  subscriptionChargeObligationKey,
  type SubscriptionChargeFacts,
} from "./subscription-charges";

/**
 * THE SUBSCRIPTION DOORS' WAY INTO THE JOURNAL (#4519, Ledger M7). Each legacy
 * writer (subscription confirm, the entrance-fee enqueue, a manual mark-paid or
 * mark-unpaid, close as already paid, the cancellation credit note) calls one of
 * these inside its own transaction, with a context resolved before that
 * transaction opened (`resolveSubscriptionMoneyPostingContext`). Nothing here
 * catches a refusal: a refused batch rolls the business write back with it.
 *
 * WHAT POSTS. R18 posts when a charge row is created, R19 once per member; every
 * later event posts only against an R18 already in the journal, so a charge
 * confirmed before M7 is M9's to back-post and nothing here invents it. An event
 * key already posted is checked BEFORE a batch is built, since a retry carries a
 * new clock and the replay check would see a different `effectiveAt`. A club
 * whose journal is inactive (`journal-activity.ts`) posts nothing.
 *
 * LOCKS. A first charge of a fresh component identity takes no global key. The
 * two revenue reversals, a re-bill replacing a voided unpaid charge and the
 * cancellation credit, need the caller's `pg_advisory_xact_lock(1)`, which the
 * store asserts. Receipts post no revenue: they serialise on the charge row
 * (`lockChargeRow`), which `prepareMemberLevelApplications` relies on.
 */

type Db = Prisma.TransactionClient;

/** Every application to a subscription charge's obligation is written holding this row. */
async function lockChargeRow(tx: Db, chargeId: string): Promise<void> {
  const locked = await tx.$executeRaw`SELECT 1 FROM "MembershipSubscriptionCharge" WHERE "id" = ${chargeId} FOR UPDATE`;
  if (locked === 0) throw new MemberMoneyPlanError([`subscription charge ${chargeId} does not exist`]);
}

interface PostedCharge {
  journalId: string;
  kind: string;
  /** The reversal's source version, when the journal is reversed. */
  reversedAs: string | null;
}

/** A charge's R18 as posted, or null for a charge this feature never posted. */
async function postedCharge(tx: Db, chargeId: string): Promise<PostedCharge | null> {
  const event = await tx.memberMoneyEvent.findUnique({
    where: { eventKey: memberMoneyEventKeys.subscriptionCharge(chargeId) },
    select: { kind: true, journal: { select: { id: true, reversedBy: { select: { event: { select: { sourceVersion: true } } } } } } },
  });
  if (!event?.journal) return null;
  return { journalId: event.journal.id, kind: event.kind, reversedAs: event.journal.reversedBy?.event.sourceVersion ?? null };
}

/** The R18 obligation with what is still collected against it (live applications only). */
async function chargeObligation(tx: Db, chargeId: string) {
  const obligation = await tx.memberMoneyObligation.findUnique({
    where: { obligationKey: subscriptionChargeObligationKey(chargeId) },
    select: { faceCents: true, debtorKind: true, memberId: true,
      applications: { where: { reversesApplicationId: null, reversedBy: null }, select: { amountCents: true } } },
  });
  if (!obligation) return null;
  if (obligation.debtorKind !== "MEMBER" || !obligation.memberId) throw new MemberMoneyPlanError(["a subscription charge's obligation names no member"]);
  const debtor: MemberMoneyDebtor = { kind: "MEMBER", memberId: obligation.memberId };
  return { faceCents: obligation.faceCents, debtor, collectedCents: obligation.applications.reduce((sum, a) => sum + a.amountCents, 0) };
}

/** An open R18: posted, a CHARGE, not reversed, with its obligation. Anything else takes no receipt. */
async function openCharge(tx: Db, chargeId: string) {
  const posted = await postedCharge(tx, chargeId);
  if (!posted || posted.kind !== "CHARGE" || posted.reversedAs !== null) return null;
  return chargeObligation(tx, chargeId);
}

export interface SubscriptionChargeDoor {
  facts: SubscriptionChargeFacts;
  /** The charges a post-void re-bill replaces: each covered subscription's latest released coverage's charge. */
  replacesChargeIds?: readonly string[];
  actorMemberId?: string | null;
}

/**
 * R18, from the confirm's create path only, plus the owner's replacement rule
 * (10 Nov 2026): if any replaced charge has a live collection, nothing is
 * reversed and the new charge is an explicit ZERO naming them; otherwise each
 * replaced R18 still open is reversed, once, and the new charge posts in full.
 * A replaced charge never posted (pre-M7) is neither reversed nor invented.
 */
export async function postSubscriptionCharge(tx: Db, context: BookingJournalContext, input: SubscriptionChargeDoor): Promise<MemberMoneyPosting | null> {
  if (isBookingJournalInactive(context)) return null;
  const { chargeId } = input.facts;
  if (await eventPosted(tx, memberMoneyEventKeys.subscriptionCharge(chargeId))) return null;
  const priors = [...new Set(input.replacesChargeIds ?? [])].filter((id) => id !== chargeId).sort();
  const paid: string[] = [];
  const toReverse: { chargeId: string; journalId: string }[] = [];
  for (const prior of priors) {
    const posted = await postedCharge(tx, prior);
    if (!posted || posted.kind !== "CHARGE" || posted.reversedAs !== null) continue;
    const obligation = await chargeObligation(tx, prior);
    if (obligation && obligation.collectedCents > 0) paid.push(prior);
    else toReverse.push({ chargeId: prior, journalId: posted.journalId });
  }
  if (paid.length > 0) {
    return postMemberMoneyEvent(tx, context, planSubscriptionCharge(input.facts, { actorMemberId: input.actorMemberId, replacesPaid: paid }));
  }
  for (const prior of toReverse) {
    await reverseMemberMoneyJournal(tx, context, { reversesJournalId: prior.journalId, origin: "APP", actorMemberId: input.actorMemberId ?? null,
      source: { kind: "SUBSCRIPTION", id: chargeId, version: `replaces:${prior.chargeId}` },
      reason: "Subscription re-bill replaces a voided unpaid charge" });
  }
  return postMemberMoneyEvent(tx, context, planSubscriptionCharge(input.facts, { actorMemberId: input.actorMemberId }));
}

/**
 * R19, once per member. The caller decides whether anything is owed at all: an
 * existing Xero link or no configured fee posts nothing (so M9 can adopt it, or
 * a fee configured later can still post); an exempt member posts one ZERO.
 */
export async function postJoiningFeeCharge(tx: Db, context: BookingJournalContext,
  input: { memberId: string; feeAmountCents: number; exempt: boolean; actorMemberId?: string | null }): Promise<MemberMoneyPosting | null> {
  if (isBookingJournalInactive(context)) return null;
  if (await eventPosted(tx, memberMoneyEventKeys.joiningFee(input.memberId))) return null;
  return postMemberMoneyEvent(tx, context, planJoiningFee(input));
}

async function postReceiptAgainstCharge(tx: Db, context: BookingJournalContext, input: {
  eventKey: MemberMoneyEventKey; chargeId: string; version: string; amountCents: number | "face"; at: Date; reason: string; actorMemberId?: string | null;
}): Promise<MemberMoneyPosting | null> {
  if (isBookingJournalInactive(context)) return null;
  await lockChargeRow(tx, input.chargeId);
  if (await eventPosted(tx, input.eventKey)) return null;
  const obligation = await openCharge(tx, input.chargeId);
  if (!obligation || obligation.collectedCents > 0) return null;
  const amountCents = input.amountCents === "face" ? obligation.faceCents : input.amountCents;
  if (amountCents <= 0) return null;
  if (amountCents > obligation.faceCents) {
    // The legacy write stands; the journal never collects more than the charge.
    logger.warn({ chargeId: input.chargeId, amountCents, faceCents: obligation.faceCents }, "Subscription receipt exceeds its charge: not posted (#4519)");
    return null;
  }
  return postMemberMoneyEvent(tx, receiptFactContext(context, input.at), planSubscriptionReceipt({
    eventKey: input.eventKey, chargeId: input.chargeId, version: input.version, debtor: obligation.debtor,
    obligationKey: subscriptionChargeObligationKey(input.chargeId), amountCents, reason: input.reason, actorMemberId: input.actorMemberId,
  }));
}

const receiptVersion = (paidAt: Date) => `paid:${paidAt.getTime()}`;

/**
 * R08 for a single-member manual mark-paid: cash for `amountCents`, collected
 * against the charge's open R18 obligation, dated `paidAt` (the fenced write's
 * `manuallyMarkedPaidAt`). Nothing posts when the charge has no open R18 or
 * anything is already collected.
 */
export async function postSubscriptionManualReceipt(tx: Db, context: BookingJournalContext,
  input: { chargeId: string; amountCents: number; paidAt: Date; actorMemberId?: string | null }): Promise<MemberMoneyPosting | null> {
  return postReceiptAgainstCharge(tx, context, { ...input, eventKey: memberMoneyEventKeys.subscriptionReceipt(input.chargeId, input.paidAt.getTime()),
    version: receiptVersion(input.paidAt), at: input.paidAt, reason: "Subscription marked paid" });
}

/**
 * Mark-unpaid: reverse the receipt posted for `paidAt` (the `manuallyMarkedPaidAt`
 * read before it is cleared); the reversal takes its collection back with it. No
 * such receipt reverses nothing, and no charge is posted.
 */
export async function reverseSubscriptionManualReceipt(tx: Db, context: BookingJournalContext,
  input: { chargeId: string; paidAt: Date; actorMemberId?: string | null }): Promise<MemberMoneyPosting | null> {
  if (isBookingJournalInactive(context)) return null;
  await lockChargeRow(tx, input.chargeId);
  const event = await tx.memberMoneyEvent.findUnique({
    where: { eventKey: memberMoneyEventKeys.subscriptionReceipt(input.chargeId, input.paidAt.getTime()) },
    select: { journal: { select: { id: true, reversedBy: { select: { id: true } } } } },
  });
  if (!event?.journal || event.journal.reversedBy) return null;
  return reverseMemberMoneyJournal(tx, context, { reversesJournalId: event.journal.id, origin: "OFFICER", actorMemberId: input.actorMemberId ?? null,
    source: { kind: "SUBSCRIPTION", id: input.chargeId, version: `unpaid:${input.paidAt.getTime()}` }, reason: "Subscription marked unpaid" });
}

/** Close as already paid: one receipt for the charge's face, only while its R18 is open and nothing is collected. */
export async function postSubscriptionCloseReceipt(tx: Db, context: BookingJournalContext,
  input: { chargeId: string; closedAt: Date; actorMemberId?: string | null }): Promise<MemberMoneyPosting | null> {
  return postReceiptAgainstCharge(tx, context, { chargeId: input.chargeId, actorMemberId: input.actorMemberId, amountCents: "face", at: input.closedAt,
    eventKey: memberMoneyEventKeys.subscriptionCloseReceipt(input.chargeId), version: "close-receipt", reason: "Subscription closed as already paid" });
}

export type SubscriptionCreditOutcome =
  | { outcome: "posted" | "mismatch"; creditedCents: number; chargedCents: number }
  | { outcome: "nothing-to-reverse" | "journal-inactive"; creditedCents: number; chargedCents: null };

/**
 * R20: a cancellation credit note for the whole of an unpaid charge reverses its
 * R18, once, under the caller's `lock(1)`. Only when the leaver is the last live
 * member the charge covers, nothing is collected, and the credit equals the
 * charge; otherwise `mismatch`, and nothing posts. A charge with no open R18
 * (pre-M7, a ZERO, or reversed by a re-bill) is `nothing-to-reverse`; this credit
 * note's own earlier reversal is `posted` again.
 */
export async function reverseSubscriptionChargeForCredit(tx: Db, context: BookingJournalContext, input: {
  chargeId: string; creditNoteId: string; creditedCents: number; leaverIsLastLiveMember: boolean; actorMemberId?: string | null;
}): Promise<SubscriptionCreditOutcome> {
  const none = (outcome: "nothing-to-reverse" | "journal-inactive") => ({ outcome, creditedCents: input.creditedCents, chargedCents: null });
  if (isBookingJournalInactive(context)) return none("journal-inactive");
  await lockChargeRow(tx, input.chargeId);
  const version = `credit:${input.creditNoteId}`;
  const posted = await postedCharge(tx, input.chargeId);
  if (!posted || posted.kind !== "CHARGE") return none("nothing-to-reverse");
  const obligation = await chargeObligation(tx, input.chargeId);
  if (!obligation) return none("nothing-to-reverse");
  const figures = { creditedCents: input.creditedCents, chargedCents: obligation.faceCents };
  if (posted.reversedAs !== null) return posted.reversedAs === version ? { outcome: "posted", ...figures } : none("nothing-to-reverse");
  if (!input.leaverIsLastLiveMember || obligation.collectedCents > 0 || input.creditedCents !== obligation.faceCents) {
    return { outcome: "mismatch", ...figures };
  }
  await reverseMemberMoneyJournal(tx, context, { reversesJournalId: posted.journalId, origin: "APP", actorMemberId: input.actorMemberId ?? null,
    source: { kind: "SUBSCRIPTION", id: input.chargeId, version }, reason: "Membership cancellation credit note" });
  return { outcome: "posted", ...figures };
}
