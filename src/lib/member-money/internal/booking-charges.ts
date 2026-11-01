import type { LedgerLineKind, LedgerSide, MemberMoneyOrigin } from "@prisma/client";
import { formatCentsPlain } from "../../utils";
import { componentKey } from "./components";
import { memberMoneyEventKeys, type MemberMoneyEventKey } from "./keys";
import {
  MemberMoneyPlanError,
  type MemberMoneyDebtor,
  type MemberMoneyEvidence,
  type MemberMoneyLegPlan,
  type MemberMoneyPlan,
  type MemberMoneySource,
} from "./plan";

/**
 * THE ONE MAP FROM LEGACY BOOKING-LEDGER LINES TO JOURNAL BATCHES (#4627,
 * Ledger M3b; the M3 plan on #4515). Pure: no reads, no writes.
 *
 * The legacy planners (`planConfirmationChargeLines`,
 * `planModificationChargeLines`, `planCancellationChargeLines`,
 * `planReviewClosureShareLines`) stay the one source of arithmetic. A door
 * writes their lines, reads them back, and this module turns exactly those
 * stored lines into a batch: nothing here prices anything.
 *
 * THE GRAIN. A component is one revenue account and one `chargeIdentity`
 * across the journal. A debit revenue leg must correct a WHOLE posted component,
 * so a promotion cannot be a debit of its own. Every night, the promotion, any
 * agreed adjustment and a cancellation's kept fee therefore fold into ONE
 * booking charge component (`bookingChargeIdentity`), whose gross is what those
 * live lines add up to: the final price, as confirmed and as each edit leaves
 * it, or what the club keeps once it is cancelled. An event that moves it
 * corrects the whole component and charges the remainder. Each change fee is a
 * component of its own (R03), keyed by its legacy posting key, so its later
 * reversal is one whole correction of it.
 *
 * A reduction the booking charge cannot absorb (an agreed give-back larger than
 * what it still carries, say after a cancellation) takes the rest from the
 * booking's live change-fee components, in key order, each corrected whole and
 * charged its remainder: the legacy ledger reduces the booking's total, and a
 * component never goes below zero. A reduction beyond every live component is
 * refused, never guessed.
 *
 * THE BRIDGE. Every legacy line with money gets one receivable leg sourced to
 * it (Dr for a line that adds to the price, Cr for one that takes away), so each
 * line has its own `MemberMoneySourceLink` and `MemberMoneySourcePosting`. A
 * component touched by exactly one line in the batch sources its revenue legs
 * to that line too; the folded component's legs otherwise name the event's own
 * source. A line of zero cents has no money to post and no leg can carry it, so
 * it is not linked (the census leaves it out the same way).
 */

/** The legacy line as a door reads it back after its legacy write, with the key of the line it reverses. */
export interface LegacyChargeLine {
  id: string;
  bookingId: string;
  lodgeId: string;
  side: LedgerSide;
  kind: LedgerLineKind;
  amountCents: number;
  quantity: number;
  unitCents: number;
  postingKey: string | null;
  reversesLineId: string | null;
  /** The posting key of the line `reversesLineId` names; null where it names none. */
  reversedPostingKey: string | null;
  bookingGuestId: string | null;
  /** The first night, as its club calendar date; null on a line that prices no night. */
  night: string | null;
}

/** The two revenue accounts a booking's charge lines post to. */
export type BookingChargeAccount = "BOOKING_REVENUE" | "FEE_REVENUE";
export interface BookingChargeComponent {
  account: BookingChargeAccount;
  chargeIdentity: string;
}

/**
 * The legacy kinds that fold into the booking's one charge component: what the
 * stay costs, how its promotion and agreed adjustments move that, and, once it
 * is cancelled, what the club keeps of it.
 */
const FOLDED_KINDS: readonly LedgerLineKind[] = ["GUEST_NIGHT", "PROMOTION", "GROUP_DISCOUNT", "AGREED_ADJUSTMENT", "CANCELLATION_FEE"];
/** The legacy kind that is a fee component of its own (R03). */
const FEE_KINDS: readonly LedgerLineKind[] = ["CHANGE_FEE"];

/** The booking's folded charge component. It names its booking, as every component identity must. */
export function bookingChargeIdentity(bookingId: string): string {
  return `booking:${bookingId}:charge`;
}

/** A component's map key, the engine's own (`componentKey`). */
export const bookingComponentKey = (component: BookingChargeComponent): string =>
  componentKey(component.account, component.chargeIdentity);

/**
 * Which journal component a legacy line's money belongs to, or null for a
 * settlement line (M4+). The single rule the door adapter and the comparison
 * census both use (`INV-SSOT-001`). A fee reversal belongs to the fee it
 * reverses, so a line without a key of its own or its target's has no
 * component this rule can name: that is refused, never guessed.
 */
export function journalComponentOfLegacyLine(
  line: Pick<LegacyChargeLine, "bookingId" | "kind" | "postingKey" | "reversedPostingKey" | "reversesLineId">,
): BookingChargeComponent | null {
  if (FOLDED_KINDS.includes(line.kind)) return { account: "BOOKING_REVENUE", chargeIdentity: bookingChargeIdentity(line.bookingId) };
  if (!FEE_KINDS.includes(line.kind)) return null;
  const identity = line.reversesLineId === null ? line.postingKey : line.reversedPostingKey;
  if (!identity) {
    throw new MemberMoneyPlanError([`a ${line.kind} line without a posting key (its own or its reversed line's) names no fee component`]);
  }
  return { account: "FEE_REVENUE", chargeIdentity: identity };
}

/** The business event a booking charge batch records. */
export type BookingChargeEvent =
  | { kind: "confirmation" }
  | { kind: "modification"; modificationId: string }
  | { kind: "cancellation" }
  | { kind: "review-close"; taskId: string; officerMemberId: string };

/**
 * A booking is cancelled once: `CANCELLED` is terminal and every cancel path
 * claims it once under `lock(1)`, as `cancellationFeeKey` relies on. Were a
 * booking ever restored and cancelled again, this would have to count them.
 */
const CANCELLATION_REVISION = 0;

/** The event key, source, origin and rule of a booking charge event, built in one place. */
export function bookingChargeEventIdentity(bookingId: string, event: BookingChargeEvent): {
  eventKey: MemberMoneyEventKey;
  source: MemberMoneySource;
  origin: MemberMoneyOrigin;
  rule: "R01" | "R02" | "R04" | "R21";
  actorMemberId: string | null;
} {
  switch (event.kind) {
    case "confirmation":
      return { eventKey: memberMoneyEventKeys.bookingCharge(bookingId), rule: "R01", origin: "APP", actorMemberId: null,
        source: { kind: "BOOKING", id: bookingId, version: "confirmation" } };
    case "modification":
      return { eventKey: memberMoneyEventKeys.modification(event.modificationId), rule: "R02", origin: "APP", actorMemberId: null,
        source: { kind: "BOOKING", id: bookingId, version: `modification:${event.modificationId}` } };
    case "cancellation":
      return { eventKey: memberMoneyEventKeys.cancellation(bookingId, CANCELLATION_REVISION), rule: "R04", origin: "APP",
        actorMemberId: null, source: { kind: "BOOKING", id: bookingId, version: `cancellation:${CANCELLATION_REVISION}` } };
    case "review-close":
      return { eventKey: memberMoneyEventKeys.reviewClose(event.taskId), rule: "R21", origin: "OFFICER",
        actorMemberId: event.officerMemberId, source: { kind: "OFFICER_FACT", id: event.taskId, version: "review-close" } };
  }
}

const REASONS = {
  R01: "Booking confirmed: its charge lines, posted as one payable obligation (R01)",
  R02: "Booking edited: its charge components re-posted as the edit priced them (R02/R03)",
  R04: "Booking cancelled: its extinguished charges reversed and what the club keeps charged (R04)",
  R21: "Booking review closed: its re-price and agreed adjustment posted (R21)",
} as const;

const lineSource = (line: LegacyChargeLine): MemberMoneySource => ({
  kind: "BOOKING_LEDGER",
  id: line.id,
  version: line.postingKey ?? line.id,
});

function lineEvidence(line: LegacyChargeLine): MemberMoneyEvidence {
  return {
    legacyKind: line.kind,
    postingKey: line.postingKey,
    quantity: line.quantity,
    unitCents: line.unitCents,
    bookingGuestId: line.bookingGuestId,
    night: line.night,
    reversesLineId: line.reversesLineId,
  };
}

export interface BookingChargePlanInput {
  bookingId: string;
  lodgeId: string;
  event: BookingChargeEvent;
  /** The booking's owner, re-read under its row lock: the receivable's debtor. */
  debtor: MemberMoneyDebtor;
  /** This event's stored legacy lines, not yet bridged. Lines of zero cents are left out here. */
  lines: readonly LegacyChargeLine[];
  /** Every live charge component the booking's journal carries now, read under `lock(1)`. */
  liveComponents: ReadonlyArray<BookingChargeComponent & { liveGrossCents: number }>;
}

/**
 * The batch one booking charge event posts, or null when its lines carry no
 * money. R01 opens the booking's one CHARGE obligation, face the receivable it
 * posts; later events move the receivable by booking and name no obligation,
 * because attributing a movement to an obligation is M4's application work.
 */
export function planBookingChargeEvent(input: BookingChargePlanInput): MemberMoneyPlan | null {
  const lines = input.lines.filter((line) => line.amountCents !== 0);
  if (lines.length === 0) return null;
  const identity = bookingChargeEventIdentity(input.bookingId, input.event);
  const booking = { bookingId: input.bookingId, lodgeId: input.lodgeId };
  const problems: string[] = [];
  for (const line of lines) {
    if (line.bookingId !== input.bookingId || line.lodgeId !== input.lodgeId) {
      problems.push(`legacy line ${line.id} belongs to another booking or lodge`);
    }
  }

  const receivableCents = lines.reduce((sum, line) => sum + line.amountCents, 0);
  const obligationKey = identity.rule === "R01" && receivableCents > 0 ? identity.eventKey : undefined;
  const legs: MemberMoneyLegPlan[] = lines.map((line) => ({
    type: "amount",
    account: "MEMBER_RECEIVABLE",
    side: line.amountCents > 0 ? "DEBIT" : "CREDIT",
    amountCents: Math.abs(line.amountCents),
    debtor: input.debtor,
    booking,
    source: lineSource(line),
    ...(obligationKey ? { obligationKey } : {}),
    evidence: lineEvidence(line),
  }));

  // Each component's live gross, and where this event's lines leave it.
  type Moved = { component: BookingChargeComponent; live: number; after: number; lines: LegacyChargeLine[] };
  const moved = new Map<string, Moved>();
  for (const component of input.liveComponents) {
    moved.set(bookingComponentKey(component), { component, live: component.liveGrossCents, after: component.liveGrossCents, lines: [] });
  }
  for (const line of lines) {
    const component = journalComponentOfLegacyLine(line);
    if (!component) {
      problems.push(`legacy line ${line.id} is a ${line.side} ${line.kind} line, not a charge`);
      continue;
    }
    const key = bookingComponentKey(component);
    const entry = moved.get(key) ?? { component, live: 0, after: 0, lines: [] };
    entry.after += line.amountCents;
    entry.lines.push(line);
    moved.set(key, entry);
  }
  const charge = moved.get(bookingComponentKey({ account: "BOOKING_REVENUE", chargeIdentity: bookingChargeIdentity(input.bookingId) }));
  if (charge && charge.after < 0) {
    let shortfall = -charge.after;
    charge.after = 0;
    const fees = [...moved.values()].filter((entry) => entry.component.account === "FEE_REVENUE")
      .sort((a, b) => a.component.chargeIdentity.localeCompare(b.component.chargeIdentity));
    for (const fee of fees) {
      const take = Math.min(shortfall, Math.max(0, fee.after));
      fee.after -= take;
      shortfall -= take;
    }
    if (shortfall > 0) {
      problems.push(`the booking's charges would carry ${formatCentsPlain(-shortfall)}: its legacy lines take away more than they hold`);
    }
  }
  for (const { component, live, after, lines: touching } of moved.values()) {
    if (after < 0) {
      problems.push(`component ${component.chargeIdentity} would carry ${formatCentsPlain(after)}: its legacy lines take away more than it holds`);
      continue;
    }
    if (after === live) continue;
    const source = touching.length === 1 ? lineSource(touching[0]!) : undefined;
    const shared = { account: component.account, booking, chargeIdentity: component.chargeIdentity,
      ...(source ? { source } : {}) } as const;
    // A correction takes the whole live component; what remains is charged afresh.
    if (live > 0) {
      legs.push({ type: "revenue", ...shared, side: "DEBIT", grossCents: live, evidence: { rule: identity.rule, correction: true } });
    }
    if (after > 0) {
      legs.push({ type: "revenue", ...shared, side: "CREDIT", grossCents: after, evidence: { rule: identity.rule } });
    }
  }
  if (problems.length > 0) throw new MemberMoneyPlanError(problems);

  return {
    kind: identity.rule === "R01" ? "CHARGE" : "ADJUSTMENT",
    eventKey: identity.eventKey,
    origin: identity.origin,
    source: identity.source,
    additionalSources: lines.map(lineSource),
    reason: REASONS[identity.rule],
    actorMemberId: identity.actorMemberId,
    obligations: obligationKey
      ? [{ key: obligationKey, kind: "CHARGE", debtor: input.debtor, faceCents: receivableCents,
        evidence: { rule: "R01", bookingId: input.bookingId } }]
      : [],
    legs,
  };
}

/** One booking's receivable a merged-away member still carries, signed (Dr positive). */
export interface MemberReceivableBalance {
  bookingId: string | null;
  lodgeId: string | null;
  cents: number;
}

/**
 * D4: the explicit transfer of every open receivable balance the merged-away
 * member carries to the survivor, booking by booking, or null when none is
 * open. It posts no revenue, so it needs no `lock(1)`.
 */
export function planMemberMergeTransfer(input: {
  fromMemberId: string;
  toMemberId: string;
  actorMemberId: string;
  balances: readonly MemberReceivableBalance[];
}): MemberMoneyPlan | null {
  const open = input.balances.filter((balance) => balance.cents !== 0);
  if (open.length === 0) return null;
  const from: MemberMoneyDebtor = { kind: "MEMBER", memberId: input.fromMemberId };
  const to: MemberMoneyDebtor = { kind: "MEMBER", memberId: input.toMemberId };
  const legs = open.flatMap((balance): MemberMoneyLegPlan[] => {
    const booking = balance.bookingId && balance.lodgeId ? { bookingId: balance.bookingId, lodgeId: balance.lodgeId } : undefined;
    const amountCents = Math.abs(balance.cents);
    const evidence = { rule: "D4", bookingId: balance.bookingId };
    const owed = balance.cents > 0;
    return [
      { type: "amount", account: "MEMBER_RECEIVABLE", side: owed ? "CREDIT" : "DEBIT", amountCents, debtor: from, booking, evidence },
      { type: "amount", account: "MEMBER_RECEIVABLE", side: owed ? "DEBIT" : "CREDIT", amountCents, debtor: to, booking, evidence },
    ];
  });
  return {
    kind: "ADJUSTMENT",
    eventKey: memberMoneyEventKeys.merge(input.fromMemberId, input.toMemberId),
    origin: "OFFICER",
    source: { kind: "OFFICER_FACT", id: input.fromMemberId, version: `merge:${input.toMemberId}` },
    reason: "Duplicate member merged: open receivable balances transferred to the surviving member (D4)",
    actorMemberId: input.actorMemberId,
    legs,
  };
}
