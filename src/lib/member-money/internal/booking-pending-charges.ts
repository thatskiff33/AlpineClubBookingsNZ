import type { LedgerLineKind } from "@prisma/client";
import { formatCentsPlain } from "../../utils";
import {
  BOOKING_CHARGE_REASONS,
  bookingChargeEventIdentity,
  bookingComponentKey,
  componentMovementLegs,
  journalComponentOfLegacyLine,
  type BookingChargeComponent,
  type ComponentMove,
} from "./booking-charges";
import { MemberMoneyPlanError, type MemberMoneyDebtor, type MemberMoneyLegPlan, type MemberMoneyPlan } from "./plan";

/**
 * A BANK-TRANSFER BOOKING'S CHARGE BEFORE SETTLEMENT (#4628, Ledger M3c; the
 * M3 plan on #4515). Pure: no reads, no writes.
 *
 * An internet-banking booking is issued a payable invoice before any money
 * arrives, but the legacy ledger posts its charge lines only at confirmation
 * (`INV-MONEY-032`/`033`). So at the binding moment (internet-banking create,
 * switch to internet banking, school pay-on-account) no legacy line exists yet.
 *
 * THE ONE SOURCE OF ARITHMETIC. The door's legacy side plans, without writing,
 * the lines its confirmation would post for the booking as it stands now
 * (`planConfirmationPostings`: `planConfirmationChargeLines` and the fees added
 * to the amount owed), and, for a cancellation, what the cancellation planner
 * leaves of them. Those planned lines are the STANDING charge. Each maps to its
 * component by the one rule (`journalComponentOfLegacyLine`), so the components
 * here are the ones the confirmation's real lines will map to. Nothing is
 * re-priced: a later confirmation planned from the same stored rows posts lines
 * that add up, component by component, to what the journal already carries.
 *
 * A RESTATEMENT, NOT A DELTA. Every event moves each component from what the
 * journal carries live to what the standing lines add up to: the binding R01
 * charges them (live is zero), an edit before settlement re-states them (R02),
 * a cancellation leaves what the club keeps (R04). A writer that moved the price
 * without posting is therefore absorbed by the next event, never compounded.
 */

/** A charge line the booking's confirmation would post now: planned, not written. */
export interface StandingChargeLine {
  kind: LedgerLineKind;
  amountCents: number;
  postingKey: string | null;
  reversesLineId: string | null;
  /** The posting key of the planned line `reversesLineId` names; null where it names none. */
  reversedPostingKey: string | null;
}

/** The events a booking whose charge is pending (binding R01, no legacy confirmation yet) posts. */
export type PendingChargeEvent =
  | { kind: "binding" }
  | { kind: "modification"; modificationId: string }
  | { kind: "cancellation" }
  | { kind: "restatement" };

export interface PendingChargePlanInput {
  bookingId: string;
  lodgeId: string;
  event: PendingChargeEvent;
  /** The booking's owner, re-read under its row lock: the receivable's debtor. */
  debtor: MemberMoneyDebtor;
  /** The charge lines that stand for the booking after this event, planned by the legacy planners. */
  standing: readonly StandingChargeLine[];
  /** Every live charge component the booking's journal carries now, read under `lock(1)`. */
  liveComponents: ReadonlyArray<BookingChargeComponent & { liveGrossCents: number }>;
}

/** What the standing lines add up to, per component (`journalComponentOfLegacyLine`, `INV-SSOT-001`). */
export function standingComponentTargets(
  bookingId: string,
  standing: readonly StandingChargeLine[],
): Map<string, { component: BookingChargeComponent; grossCents: number }> {
  const targets = new Map<string, { component: BookingChargeComponent; grossCents: number }>();
  const problems: string[] = [];
  for (const line of standing) {
    if (line.amountCents === 0) continue;
    const component = journalComponentOfLegacyLine({ bookingId, ...line });
    if (!component) {
      problems.push(`a standing ${line.kind} line is not a charge`);
      continue;
    }
    const key = bookingComponentKey(component);
    const entry = targets.get(key) ?? { component, grossCents: 0 };
    entry.grossCents += line.amountCents;
    targets.set(key, entry);
  }
  for (const { component, grossCents } of targets.values()) {
    if (grossCents < 0) {
      problems.push(`component ${component.chargeIdentity} would stand at ${formatCentsPlain(grossCents)}: its planned lines take away more than they hold`);
    }
  }
  if (problems.length > 0) throw new MemberMoneyPlanError(problems);
  return targets;
}

/**
 * The batch a pending booking's event posts, or null when it moves nothing.
 * The binding R01 opens the booking's CHARGE obligation with one receivable leg
 * for its whole face, or is an explicit ZERO event when nothing is yet owed; a
 * later event moves the receivable by booking, naming no obligation, as M3b's
 * later events do. Every leg names the event's own source: there is no legacy
 * line to bridge yet (the confirmation links them later, `INV-MONEY-042`).
 */
export function planPendingBookingCharge(input: PendingChargePlanInput): MemberMoneyPlan | null {
  const identity = bookingChargeEventIdentity(input.bookingId, input.event);
  const targets = standingComponentTargets(input.bookingId, input.standing);
  const moves = new Map<string, ComponentMove>();
  for (const component of input.liveComponents) {
    moves.set(bookingComponentKey(component), { component, live: component.liveGrossCents, after: 0 });
  }
  for (const [key, { component, grossCents }] of targets) {
    moves.set(key, { component, live: moves.get(key)?.live ?? 0, after: grossCents });
  }
  const booking = { bookingId: input.bookingId, lodgeId: input.lodgeId };
  const revenue = componentMovementLegs(booking, identity.rule, [...moves.values()]);
  const receivableCents = [...moves.values()].reduce((sum, move) => sum + move.after - move.live, 0);
  const binding = input.event.kind === "binding";

  if (revenue.length === 0) {
    if (!binding) return null;
    return { kind: "ZERO", eventKey: identity.eventKey, origin: identity.origin, source: identity.source,
      reason: `${BOOKING_CHARGE_REASONS.binding}, with nothing yet to charge`, actorMemberId: identity.actorMemberId };
  }
  const obligationKey = binding && receivableCents > 0 ? identity.eventKey : undefined;
  const legs: MemberMoneyLegPlan[] = [...revenue];
  if (receivableCents !== 0) {
    legs.unshift({
      type: "amount",
      account: "MEMBER_RECEIVABLE",
      side: receivableCents > 0 ? "DEBIT" : "CREDIT",
      amountCents: Math.abs(receivableCents),
      debtor: input.debtor,
      booking,
      ...(obligationKey ? { obligationKey } : {}),
      evidence: { rule: identity.rule, pending: true },
    });
  }
  return {
    kind: binding ? "CHARGE" : "ADJUSTMENT",
    eventKey: identity.eventKey,
    origin: identity.origin,
    source: identity.source,
    reason: BOOKING_CHARGE_REASONS[input.event.kind],
    actorMemberId: identity.actorMemberId,
    obligations: obligationKey
      ? [{ key: obligationKey, kind: "CHARGE", debtor: input.debtor, faceCents: receivableCents,
        evidence: { rule: "R01", bookingId: input.bookingId, pending: true } }]
      : [],
    legs,
  };
}
