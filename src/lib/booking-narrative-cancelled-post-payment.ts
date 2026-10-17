/**
 * The narrative for a booking cancelled AFTER it was paid: what was paid, and
 * what the cancellation policy did with it — refunded, added to account credit,
 * being handed back by the club, or retained.
 *
 * Moved out of `booking-narrative.ts` (#3991), which is at its size budget;
 * `buildCancelledNarrative` there is the one caller and decides when this
 * applies (a paid event exists) and which settlement event is the
 * cancellation's own. Pure, like that module: the club's bound time arrives as
 * data.
 *
 * `ownerCreditHidden` (#3991): the viewer cannot see the booking owner's account
 * credit (`canSeeOwnerCredit` on the booking page), so a cancellation settled
 * as CREDIT drops its "added to your account credit" figure and says only what
 * was retained. The figures it keeps (what was paid, what was retained) still
 * let the remainder be worked out by subtraction; it withholds the statement,
 * not the arithmetic.
 */
import { BookingEventType } from "@prisma/client";
import type { BoundClubTime } from "@/lib/club-time";
import type { ClubFormat } from "@/lib/club-format";
import type { CancellationEventSnapshot } from "@/lib/booking-events";
import type { BookingNarrative, NarrativeEvent } from "@/lib/booking-narrative";
import { formatCents } from "@/lib/utils";
import type { CardRefundState, CardShortfallTaskStatuses } from "@/lib/manual-refund-task-settlement-rules";
import { cardRefundOnItsWay } from "@/lib/booking-modified-email-copy";
import { CAPACITY_RACE_REFUND_EVENT_REASON, isCancelCardRefundEvent, isMadeBeforePaidAnotherWayEvent } from "@/lib/cancel-card-refund-event-reason";

/**
 * #4125: what the club follows up - a dead card refund, a part no refund
 * covers - appended to a clause after "; ", or the whole clause when nothing
 * else is said (`INV-SSOT`).
 */
function withClubFollowUp(clause: string, subjects: string[]): string {
  if (subjects.length === 0) return clause;
  const followUp = `the club will be in touch about ${subjects.join(" and ")}`;
  return clause ? `${clause}; ${followUp}` : followUp;
}
const STALLED_CARD_REFUND = "the card refund";

/** #4097, #4154: a part to check that the club checked and dismissed (`INV-SSOT`). */
const checkedAndClosed = (amount: string) => `the club checked the ${amount} and closed it`;

/** #4097, #4125: one card refund, by where it stands - the shortfall's card part and a whole card refund alike (`INV-SSOT`). */
function cardRefundClause(amount: string, state: CardRefundState, refundedOn: string | null): string {
  switch (state) {
    case "on-its-way":
      return cardRefundOnItsWay(amount);
    case "paid-another-way":
      return `${amount} could not go back to your card and was paid back to you another way`;
    case "stalled":
      return `${amount} is being refunded to you`;
    case "settled":
      return `${amount} was refunded to your card${refundedOn ? ` on ${refundedOn}` : ""}`;
  }
}

/**
 * #4166 (`INV-PAY-134`): a card refund a cancel's event recorded that Stripe
 * then failed (#4104), owed again on a row of its own
 * (`card_refund_failed_later_<refund>`), read by the page
 * (`readCancelledCardRefund`): its amount, and where that row stands - made
 * again (when), on its way, stalled, or paid another way (what its record paid
 * back and left unpaid).
 */
export interface FailedLaterCardRefund {
  amountCents: number;
  state: CardRefundState;
  madeAt?: Date | null;
  paidBackCents?: number;
  unpaidCents?: number;
  /**
   * False where a "Paid another way" close counted the refund as made but did
   * not date it (recorded after that close): it comes off the undated part.
   * Absent reads as dated.
   */
  dated?: boolean;
}

/** What "Paid another way" closes' records say: what was paid back, and what they left unpaid. */
type PaidAnotherWayTold = { paidBackCents: number; unpaidCents: number };

/**
 * #4145, #4166 (`INV-SSOT`): what "Paid another way" records say, appended to
 * `clauses` - the cancel's own close and its failed-later rows' together, as
 * one total each: what was paid back, and as closed by the club only what was
 * left unpaid, "remaining" after another clause.
 */
function pushPaidAnotherWayClauses(clauses: string[], { paidBackCents, unpaidCents }: PaidAnotherWayTold, money: (cents: number) => string): void {
  if (paidBackCents > 0) clauses.push(cardRefundClause(money(paidBackCents), "paid-another-way", null));
  if (unpaidCents > 0) clauses.push(checkedAndClosed(`${clauses.length > 0 ? "remaining " : ""}${money(unpaidCents)}`));
}

/**
 * What the failed-later parts say: their clauses (all but paid another way,
 * which the caller says with its own close, `pushPaidAnotherWayClauses`), what
 * paid another way, the cents they say, and whether one is stalled (the club
 * follows it up).
 */
type FailedLaterTold = { clauses: string[]; paidAnotherWay: PaidAnotherWayTold; saidCents: number; stalled: boolean };

const FAILED_LATER_ORDER: readonly CardRefundState[] = ["settled", "on-its-way", "stalled", "paid-another-way"];

/**
 * #4166: refunded parts an event says (the dated one first, then any undated),
 * less the refunds of them Stripe failed later. Each failed refund comes off
 * its own part first - the dated one, unless the reader found it undated
 * (`dated`) - then the other, and is said by its own row instead, each state
 * once; never more than the parts held.
 */
function lessFailedLater(
  parts: readonly number[],
  failedLater: readonly FailedLaterCardRefund[],
  { club, format }: { club: BoundClubTime; format: ClubFormat },
): { kept: number[]; told: FailedLaterTold } {
  const money = (amount: number) => formatCents(amount, format);
  let room = parts.reduce((sum, cents) => sum + cents, 0);
  const failed = failedLater.map((each) => {
    const amountCents = Math.min(each.amountCents, room);
    room -= amountCents;
    return { ...each, amountCents };
  });
  const kept = [...parts];
  for (const each of failed) {
    let owed = each.amountCents;
    const order = kept.map((_, index) => index);
    for (const index of each.dated === false ? order.reverse() : order) {
      const off = Math.min(kept[index] ?? 0, owed);
      kept[index] = (kept[index] ?? 0) - off;
      owed -= off;
    }
  }
  const told: FailedLaterTold = { clauses: [], paidAnotherWay: { paidBackCents: 0, unpaidCents: 0 }, saidCents: 0, stalled: false };
  for (const state of FAILED_LATER_ORDER) {
    const group = failed.filter((each) => each.state === state && each.amountCents > 0);
    const cents = group.reduce((sum, each) => sum + each.amountCents, 0);
    if (cents === 0) continue;
    if (state !== "paid-another-way") {
      const madeAt = group.map((each) => each.madeAt).filter((at): at is Date => at instanceof Date).sort((a, b) => a.getTime() - b.getTime()).pop();
      told.clauses.push(cardRefundClause(money(cents), state, state === "settled" && madeAt ? club.instantDate(madeAt) : null));
      told.saidCents += cents;
      told.stalled ||= state === "stalled";
      continue;
    }
    // A record read with no figure says the whole was paid back, as `ownCardRefundClauses` does.
    for (const each of group) {
      const paidBack = Math.min(each.paidBackCents ?? each.amountCents, each.amountCents);
      const unpaid = Math.min(each.unpaidCents ?? 0, each.amountCents - paidBack);
      told.paidAnotherWay.paidBackCents += paidBack;
      told.paidAnotherWay.unpaidCents += unpaid;
      told.saidCents += paidBack + unpaid;
    }
  }
  return { kept, told };
}

/** #4097, #4145: clauses said "a, b and c", or `none` when there are none. */
function joinClauses(clauses: readonly string[], none: string): string {
  return clauses.length > 1 ? `${clauses.slice(0, -1).join(", ")} and ${clauses[clauses.length - 1]}` : (clauses[0] ?? none);
}

/**
 * #4145: the card parts of a paid-another-way refund its events date: the part
 * the close found made, which it marked (`markedCents`) - and a capacity race's
 * every row's own refund, each written by the close that made it
 * (`CAPACITY_RACE_REFUND_EVENT_REASON`), so a row the runner made beside one
 * paid another way is told too.
 */
type CardPartsMade = { datedCents: number; on: Date | null; markedCents: number };

function cardPartsMade(settlementEvents: readonly NarrativeEvent[], capacityRace: boolean): CardPartsMade {
  const sum = (events: readonly NarrativeEvent[]) => events.reduce((total, event) => total + (event.amountCents ?? 0), 0);
  const marked = settlementEvents.filter(isMadeBeforePaidAnotherWayEvent);
  const dated = capacityRace
    ? settlementEvents.filter((event) => event.type === BookingEventType.REFUNDED && event.reason === CAPACITY_RACE_REFUND_EVENT_REASON)
    : marked;
  return { datedCents: sum(dated), on: dated[dated.length - 1]?.occurredAt ?? null, markedCents: sum(marked) };
}

/**
 * #4145 (`INV-PAY-134`): what a "Paid another way" close recorded, read by the
 * page (`readCancelledCardRefund`), summed over the rows: what the officer paid
 * back and what it left unpaid for the club to close (its record,
 * `paidAnotherWayUnpaidCents`), and what the row's slices took from the refunds
 * recorded on its payment (`cardRefundMadeForOperation`, the close's own rule).
 */
export interface PaidAnotherWayClose {
  paidBackCents: number;
  unpaidCents: number;
  madeCents: number;
  /**
   * #4210 round 3 (UX 5): a card refund that failed after the close, raised for
   * the club to check (`INV-PAY-136`): still to check, and paid back another
   * way by a close of the check. Each comes first out of what the close left
   * unpaid. Absent reads as none.
   */
  checkOpenCents?: number;
  checkPaidBackCents?: number;
}

/**
 * #4145 (`INV-PAY-134`): a cancel's card refund by where its row stands, dated
 * by its own event. A row closed "Paid another way" is said in its parts, each
 * from where it is recorded: the card's dated by its events (`cardPartsMade`),
 * what the officer paid back and what the close left unpaid (its record), and
 * any card part no event dates - an up-front event a cancel wrote before #4145
 * was written whatever became of the refund - undated, from the refunds
 * themselves. A part the row's payment no longer held when it closed (capped
 * below its slices) is none of these, and is not said. Returns the clauses and
 * the cents they say.
 */
function ownCardRefundClauses(
  cents: number,
  state: CardRefundState,
  { cardEvent, made, close, failedLater }: { cardEvent: NarrativeEvent | undefined; made: CardPartsMade; close: PaidAnotherWayClose | undefined; failedLater: readonly FailedLaterCardRefund[] },
  { club, format }: { club: BoundClubTime; format: ClubFormat },
): { clauses: string[]; saidCents: number; stalled: boolean } {
  const money = (amount: number) => formatCents(amount, format);
  if (state !== "paid-another-way") {
    // #4166: only a refund made can have failed later; one still owed is said as a whole.
    const { kept: [keptCents = 0], told } = lessFailedLater([cents], state === "settled" ? failedLater : [], { club, format });
    const clauses = keptCents > 0 ? [cardRefundClause(money(keptCents), state, cardEvent ? club.instantDate(cardEvent.occurredAt) : null)] : [];
    clauses.push(...told.clauses);
    pushPaidAnotherWayClauses(clauses, told.paidAnotherWay, money);
    return { clauses, saidCents: keptCents + told.saidCents, stalled: told.stalled };
  }
  const datedCents = Math.min(made.datedCents, cents);
  // A caller that read no record (an older page) says the rest was paid back, as before.
  const paidBack = Math.min(close?.paidBackCents ?? cents - datedCents, cents - datedCents);
  const unpaid = Math.min(close?.unpaidCents ?? 0, cents - datedCents - paidBack);
  const undatedMade = Math.min(Math.max(0, (close?.madeCents ?? 0) - made.markedCents), cents - datedCents - paidBack - unpaid);
  // #4166: a card part that failed later is said by its own row (the reader counts it in `madeCents`).
  const { kept: [keptDated = 0, keptUndated = 0], told } = lessFailedLater([datedCents, undatedMade], failedLater, { club, format });
  const clauses = keptDated > 0 && made.on ? [cardRefundClause(money(keptDated), "settled", club.instantDate(made.on))] : [];
  if (keptUndated > 0) clauses.push(cardRefundClause(money(keptUndated), "settled", null));
  clauses.push(...told.clauses);
  // #4210 round 3 (UX 5): what was raised to check comes first out of what the close left unpaid.
  const checkOpen = close?.checkOpenCents ?? 0;
  const checkPaidBack = close?.checkPaidBackCents ?? 0;
  const reopened = Math.min(unpaid, checkOpen + checkPaidBack);
  // The cancel's own close and its failed-later rows paid another way, said together.
  pushPaidAnotherWayClauses(
    clauses,
    { paidBackCents: paidBack + checkPaidBack + told.paidAnotherWay.paidBackCents, unpaidCents: unpaid - reopened + told.paidAnotherWay.unpaidCents },
    money,
  );
  // Within what the close left unpaid it is "the remaining" part; beyond it (a resolved or uncertain check) part of the refund.
  if (checkOpen > 0) {
    clauses.push(checkOpen <= unpaid && clauses.length > 0 ? `the club will be in touch about the remaining ${money(checkOpen)}` : `the club will be in touch about ${money(checkOpen)} of the refund`);
  }
  const beyond = Math.max(0, checkOpen + checkPaidBack - reopened);
  return { clauses, saidCents: keptDated + keptUndated + told.saidCents + paidBack + unpaid + beyond, stalled: told.stalled };
}

/**
 * #4097 (`INV-PAY-129`): a card cancel whose card refund plan carried less than
 * the refund due. Frozen on the CANCELLED event (`cardShortfall`): the card's
 * part and the two parts beside it. Each of those is a task whose status the
 * page reads live, so the sentence follows it: still owed, refunded by bank
 * transfer, or checked and closed by the club.
 */
function cardShortfallClause(
  parts: { cardCents: number; bankCents: number; checkCents: number },
  statuses: CardShortfallTaskStatuses,
  { cardEvent, made, close, failedLater, retainedAmountCents, club, format }: {
    cardEvent: NarrativeEvent | undefined; made: CardPartsMade; close: PaidAnotherWayClose | undefined; failedLater: readonly FailedLaterCardRefund[];
    retainedAmountCents: number; club: BoundClubTime; format: ClubFormat;
  },
): string {
  const money = (cents: number) => formatCents(cents, format);
  const clauses: string[] = [];
  let failedLaterStalled = false;
  if (parts.cardCents > 0) {
    // The card part as its own refund stands, as the cancellation email says it.
    const card = ownCardRefundClauses(parts.cardCents, statuses.card ?? "settled", { cardEvent, made, close, failedLater }, { club, format });
    clauses.push(...card.clauses);
    failedLaterStalled = card.stalled;
  }
  if (parts.bankCents > 0) {
    const status = statuses.bank ?? "OPEN";
    clauses.push(
      status === "COMPLETED"
        ? `${money(parts.bankCents)} was refunded to you by bank transfer`
        : status === "DISMISSED"
          ? `the club has recorded the ${money(parts.bankCents)} as settled`
          : `${money(parts.bankCents)} is being refunded to you by bank transfer`,
    );
  }
  if (parts.checkCents > 0) {
    const status = statuses.check ?? "OPEN";
    // Nothing went to the card or by bank: it is the whole refund, not "the remaining" one.
    const remaining = parts.cardCents > 0 || parts.bankCents > 0 ? "remaining " : "";
    clauses.push(
      status === "COMPLETED"
        ? `${money(parts.checkCents)} was refunded to you by bank transfer`
        : status === "DISMISSED"
          ? checkedAndClosed(`${remaining}${money(parts.checkCents)}`)
          : `the club will be in touch about the ${remaining}${money(parts.checkCents)}${remaining ? "" : " refund"}`,
    );
  }
  if (retainedAmountCents > 0) clauses.push(`${money(retainedAmountCents)} was retained`);
  const joined = joinClauses(clauses, "no refund was due");
  // #4125: a dead card part is the club's to follow up.
  // #4166: so is a part of it that failed later and is stalled on its own row.
  return withClubFollowUp(joined, (parts.cardCents > 0 && statuses.card === "stalled") || failedLaterStalled ? [STALLED_CARD_REFUND] : []);
}

/**
 * #4125: the capacity race's payment, as the paid fact the narrative opens
 * with. That settle cancels instead of recording MEMBER_PAID, so without this
 * the page would say no payment had been taken. The CANCELLED snapshot froze
 * what was paid, and the payment completed as the booking was cancelled.
 */
export function capacityRacePaidEvent(cancelEvent: NarrativeEvent | undefined): NarrativeEvent | undefined {
  const snapshot = asCancellationSnapshot(cancelEvent?.snapshot);
  if (!cancelEvent || snapshot?.cancelledBecause !== "capacity_race" || !(snapshot.paidAmountCents > 0)) return undefined;
  return { type: BookingEventType.MEMBER_PAID, occurredAt: cancelEvent.occurredAt, amountCents: snapshot.paidAmountCents, reason: null, snapshot: null };
}

function asCancellationSnapshot(
  value: unknown
): CancellationEventSnapshot | null {
  if (value && typeof value === "object") {
    return value as CancellationEventSnapshot;
  }
  return null;
}

export function buildCancelledPostPaymentNarrative(
  paidEvent: NarrativeEvent,
  cancelEvent: NarrativeEvent | undefined,
  /** The cancellation's settlement events, oldest first; the first is its settlement clause. */
  settlementEvents: readonly NarrativeEvent[],
  club: BoundClubTime, format: ClubFormat,
  ownerCreditHidden: boolean,
  cardShortfallStatuses: CardShortfallTaskStatuses = {},
  cardRefundState?: CardRefundState,
  cardRefundClose?: PaidAnotherWayClose,
  cardRefundPlanCents?: number,
  /** #4166: the cancel's card refunds an event recorded that Stripe failed later, each by its own row. */
  cardRefundFailedLater: readonly FailedLaterCardRefund[] = [],
): BookingNarrative {
  const snapshot = asCancellationSnapshot(cancelEvent?.snapshot);
  // #4125: no policy decided a capacity-race refund, and the club may pay part
  // of it later (a second REFUNDED event): it reads as everything refunded so
  // far, dated by the latest refund - never more than was paid (a REFUNDED
  // written twice across a deploy, by a pre-#4125 inline close and the runner).
  const capacityRace = snapshot?.cancelledBecause === "capacity_race";
  // #4145: a member's card cancel is settled by its own card refund event,
  // written only once the refund is made - never by an event that came after
  // the cancel for something else (an edit review's credit or refund).
  const ownCard = !capacityRace && snapshot?.refundMethod === "card";
  const settlementEvent = capacityRace
    ? settlementEvents[settlementEvents.length - 1]
    : ownCard ? settlementEvents.find(isCancelCardRefundEvent) : settlementEvents[0];
  const paidAmountCents = paidEvent.amountCents ?? snapshot?.paidAmountCents ?? 0;
  const settledAmountCents = capacityRace && settlementEvent
    ? Math.min(settlementEvents.reduce((sum, event) => sum + (event.amountCents ?? 0), 0), paidAmountCents)
    : settlementEvent?.amountCents ?? snapshot?.settledAmountCents ?? 0;
  const retainedAmountCents =
    snapshot?.retainedAmountCents ??
    Math.max(paidAmountCents - settledAmountCents, 0);

  const paidOn = club.instantDate(paidEvent.occurredAt);
  const cancelOn = cancelEvent
    ? club.instantDate(cancelEvent.occurredAt)
    : paidOn;
  // #4125: a capacity-race cancel was the system's, not the member's.
  const opening =
    capacityRace
      ? `This booking was cancelled on ${cancelOn}, after you paid ${formatCents(paidAmountCents, format)} on ${paidOn}, because the dates filled up while your payment was going through.`
      : `You cancelled this booking on ${cancelOn} after paying ${formatCents(paidAmountCents, format)} on ${paidOn}.`;

  let settlementClause: string;
  const followUps: string[] = [];
  // #4145: what reached the card, and what a "Paid another way" close recorded.
  const paidAnotherWay = { made: cardPartsMade(settlementEvents, capacityRace), close: cardRefundClose, failedLater: cardRefundFailedLater };
  // What the clause below accounts for, refunded or paid back: a capacity race follows up the rest.
  let accountedCents = settledAmountCents;
  if (snapshot?.cardShortfall) {
    // #4145: the card part's own event - a hand-back completion can land before the runner's refund.
    settlementClause = cardShortfallClause(snapshot.cardShortfall, cardShortfallStatuses, { cardEvent: settlementEvent, ...paidAnotherWay, retainedAmountCents, club, format });
  } else if (
    snapshot?.refundMethod === "card" &&
    settledAmountCents > 0 &&
    // #4145: the row says where a card refund with no event of its own stands -
    // where a member cancel's stands while its row is still open (an up-front
    // event written before #4145 says neither), and a row paid another way,
    // whose event covers only the part the card took first.
    (!settlementEvent || (cardRefundState !== undefined && cardRefundState !== "settled" && (ownCard || cardRefundState === "paid-another-way")))
  ) {
    // #4125, #4145: still being sent (the default when the caller read none),
    // dead, paid another way (said apart from any part the card took), or made
    // on a row closed with no event - by the runner before #4125 for a capacity
    // race, or a member cancel whose event write failed before #4145. Never
    // "no refund was due", and never "refunded" before it is.
    //
    // Only the member's own card: a joiner's booking the organiser paid for
    // by card (`paidByOrganiserCard`) is refunded to the ORGANISER's card, and
    // never reaches here - its settle writes MEMBER_PAID with no amount
    // (`group-settlement.ts`), so the paid-amount gate above
    // (`buildCancelledNarrative`'s `paidEvent`) sends it to the pre-payment
    // narrative. `booking-narrative.test.ts` pins that.
    const state = cardRefundState ?? "on-its-way";
    const snapshotDueCents = ownCard || state === "paid-another-way" ? snapshot.settledAmountCents : settledAmountCents;
    // #4145: a capacity race's snapshot froze the full charge before #4125; its rows' plans are its most.
    const dueCents = capacityRace && cardRefundPlanCents !== undefined ? Math.min(snapshotDueCents, cardRefundPlanCents) : snapshotDueCents;
    const { clauses, saidCents, stalled } = ownCardRefundClauses(dueCents, state, { cardEvent: ownCard ? settlementEvent : undefined, ...paidAnotherWay }, { club, format });
    // #4145: a capacity race follows up what the clauses do not say - the snapshot's
    // due was the full charge before #4125, and a capped close leaves a part unsaid.
    accountedCents = saidCents;
    if (retainedAmountCents > 0) clauses.push(`${formatCents(retainedAmountCents, format)} was retained`);
    settlementClause = joinClauses(clauses, "");
    if (state === "stalled" || stalled) followUps.push(STALLED_CARD_REFUND);
  } else if (
    settledAmountCents > 0 &&
    settlementEvent?.type === BookingEventType.CREDITED &&
    ownerCreditHidden
  ) {
    // #3991: the credit is the owner's; say only what the club kept.
    settlementClause =
      retainedAmountCents > 0
        ? `${formatCents(retainedAmountCents, format)} was retained`
        : "nothing was retained";
  } else if (settledAmountCents > 0 && settlementEvent) {
    const settledOn = club.instantDate(settlementEvent.occurredAt);
    const credited = settlementEvent.type === BookingEventType.CREDITED;
    const verb = credited ? "added to your account credit" : "refunded";
    // #4166 (`INV-PAY-134`): a refund the event recorded that Stripe failed later is said by its own row.
    const { kept: [keptCents = 0], told } = lessFailedLater([settledAmountCents], credited ? [] : cardRefundFailedLater, { club, format });
    const clauses = keptCents > 0 ? [`${formatCents(keptCents, format)} was ${verb} on ${settledOn}`, ...told.clauses] : told.clauses;
    pushPaidAnotherWayClauses(clauses, told.paidAnotherWay, (cents) => formatCents(cents, format));
    if (retainedAmountCents > 0) clauses.push(`${formatCents(retainedAmountCents, format)} was retained`);
    settlementClause = joinClauses(clauses, "");
    accountedCents = keptCents + told.saidCents;
    if (told.stalled) followUps.push(STALLED_CARD_REFUND);
  } else if (snapshot?.refundMethod === "manual" && settledAmountCents > 0) {
    // B5 (#2262): a cash / off-Xero settlement is handed back by a person, so
    // there is no settlement event YET — one is written when the club marks the
    // hand-back complete. Saying "no refund was due" here would be a lie about
    // the member's money.
    settlementClause =
      retainedAmountCents > 0
        ? `${formatCents(settledAmountCents, format)} is being refunded to you by the club directly (you paid in cash or by bank transfer, so there is no card payment to reverse) and ${formatCents(retainedAmountCents, format)} was retained`
        : `${formatCents(settledAmountCents, format)} is being refunded to you by the club directly — you paid in cash or by bank transfer, so there is no card payment to reverse`;
  } else if (capacityRace) {
    // #4125: an empty plan refunded nothing by card - never "no refund was
    // due"; the whole charge is the club's to follow up, below.
    settlementClause = "";
  } else {
    settlementClause = `no refund was due and the full ${formatCents(retainedAmountCents, format)} was retained`;
  }
  // #4125: a capacity race refunds what the payment ledger showed refundable,
  // which can be less than the charge; the snapshot keeps nothing back, so the
  // rest is neither refunded nor retained - say so, never "no further payment".
  // #4154: its task to check, once dismissed, says the club closed it; paid
  // back, it is a REFUNDED event, counted above.
  const unaccountedCents = capacityRace ? paidAmountCents - accountedCents - retainedAmountCents : 0;
  const rest = `${accountedCents > 0 ? "remaining " : ""}${formatCents(unaccountedCents, format)}`;
  if (unaccountedCents > 0 && cardShortfallStatuses.check === "DISMISSED") settlementClause = [settlementClause, checkedAndClosed(rest)].filter(Boolean).join(" and ");
  else if (unaccountedCents > 0) followUps.push(`the ${rest}`);
  settlementClause = withClubFollowUp(settlementClause, followUps);

  return {
    state: "cancelled_post_payment",
    headline: "Booking cancelled",
    // #4125: no policy decided a capacity-race refund - the whole charge goes back.
    message: `${opening} ${capacityRace ? settlementClause.charAt(0).toUpperCase() + settlementClause.slice(1) : `Under the cancellation policy in effect at the time, ${settlementClause}`}. No further payment is required.`,
    nextStep:
      "If you'd like to stay another time, you can book again from the bookings page whenever you're ready.",
  };
}
