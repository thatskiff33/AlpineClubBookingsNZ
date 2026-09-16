import { createAuditLog } from "@/lib/audit";
import { sendAdminPaymentFailureAlert } from "@/lib/email";
import logger from "@/lib/logger";
import { UNAPPLIED_CREDIT_ELECTION_AUDIT_ACTION } from "@/lib/booking-credit-election";
import { getMemberCreditBalance } from "@/lib/member-credit";
import { formatCents } from "@/lib/utils";

/**
 * Reporting for a stored credit election (#2265) that a settlement had to CLEAR
 * because it could no longer be honoured (#2319 doors 1 and 2; #2262 door 3,
 * the manual cash / off-Xero mark-paid).
 *
 * Deliberately a module of its own, and deliberately not part of
 * `booking-credit-election.ts`. That module is pure database work — a guarded
 * claim, a ledger write, some integer arithmetic — and its test suite drives it
 * against an in-memory ledger with nothing mocked. Pulling an SES send and an
 * audit write in there would make every one of those cases carry provider mocks
 * for a code path they do not exercise. Here instead, imported by the
 * settlement writers that can clear an election.
 *
 * Why report at all. A cleared column is invisible. Without this, a member who
 * chose to spend $80 of account credit and then paid the full price would have
 * no way to tell which of two very different things had happened: their credit
 * was spent (and the club owes them a smaller bill) or their credit was never
 * touched (and they still hold all of it). It is the second — the balance is
 * never debited by a clear — and the honest thing is to say so where they will
 * see it, on their own booking's history, rather than leave them to work it out
 * from a balance figure.
 *
 * The figures are CLAMPED to the member's live balance. The election records
 * what the member asked for when they made the booking, which can be months of
 * spending ago: a member who elected $450 and has since run their balance down
 * to $50 still has a $450 election on the row. Quoting that raw figure told them
 * "$450 of credit is still available" and told an operator to consider refunding
 * "the difference" — an invitation to hand back nine times what the account
 * actually holds. So the live balance is read here, once, and reported as the
 * figure that matters: what the member can actually spend. The elected amount is
 * still stated, but only ever in the past tense, as the choice that was made.
 * The balance read is best-effort too — if it fails, the copy simply omits every
 * availability figure rather than falling back to the overstating one.
 *
 * Best-effort by design: this runs AFTER the money has been captured and the
 * clear has committed. Neither a failed audit write nor an undeliverable email
 * may turn a settled booking's reconciliation into an error, so both are caught
 * and logged. The log line is the floor — something always records it.
 */
/**
 * The operator alert's closing sentence: what, if anything, is actually
 * refundable now.
 *
 * Three genuinely different situations, so three sentences rather than one with
 * holes in it. A zero balance must not read "refund at most $0.00" — the useful
 * thing to say is that there is nothing left to refund and why.
 */
function operatorAvailabilitySentence(
  electionCents: number,
  availableCreditCents: number | null,
  refundableCents: number | null
): string {
  if (availableCreditCents == null || refundableCents == null) {
    return "Their live credit balance could not be read just now, so check it in the admin before deciding anything: refund at most what the account actually holds, or leave the credit for their next stay.";
  }
  if (refundableCents === 0) {
    return "They now hold no account credit at all — the balance was spent elsewhere between electing it and this settlement — so there is nothing to refund here and no action is needed.";
  }
  const movedNote =
    refundableCents < electionCents
      ? ` — less than the ${formatCents(electionCents)} they elected, because their balance has moved since`
      : "";
  return `They now hold ${formatCents(availableCreditCents)} of account credit, so at most ${formatCents(refundableCents)} could be refunded against this booking${movedNote}. Decide whether to refund that or leave the credit for their next stay.`;
}

export async function reportUnappliedCreditElection({
  bookingId,
  memberId,
  memberFirstName,
  memberLastName,
  checkIn,
  checkOut,
  electionCents,
  paidAmountCents,
  source,
  reference,
  extraDetails = {},
}: {
  bookingId: string;
  /**
   * The booking OWNER's member id, or null when the booking is owned by an
   * `Organisation` (#3369). Only a member can elect to spend account credit, so
   * a null here means a booking that could never have held an election — the
   * report still runs, reads no balance, and records no audit SUBJECT
   * (`INV-PRIV-019`).
   */
  memberId: string | null;
  memberFirstName: string;
  memberLastName: string;
  checkIn: Date;
  checkOut: Date;
  /** What the member had asked to apply, integer cents, as cleared. */
  electionCents: number;
  /**
   * What this settlement actually took from the member, in integer cents — the
   * booking's price less any credit already applied to it, which is the same
   * figure the Payment mirror's `amountCents` carries. On a booking that still
   * held an unconsumed election that is the full price by construction (an
   * unconsumed election means the election applied nothing), but the doors pass
   * what they settled rather than the list price, so this is never a claim about
   * a price the member did not pay.
   */
  paidAmountCents: number;
  /** Which settlement cleared it, for the audit trail. */
  source:
    | "payment-reconciliation"
    | "payment-link"
    | "xero-inbound-invoice"
    | "manual-mark-paid";
  /**
   * What to show in the operator alert's reference slot — the Stripe intent id,
   * the Xero invoice id, or (when the settlement has neither) the booking id, so
   * an officer always has something to search on.
   */
  reference: string;
  /** Source-specific identifiers to carry into the audit row. */
  extraDetails?: Record<string, string | number | null>;
}): Promise<void> {
  // The member's live balance, read once and shared by the audit row, the
  // member-visible history note and the operator alert, so the three cannot
  // disagree. Best-effort: a failed read means the copy states no availability
  // figure at all, which is honest, rather than the elected figure, which may
  // not be.
  const availableCreditCents = memberId
    ? await getMemberCreditBalance(memberId).catch((err) => {
        logger.error(
          { err, bookingId, source },
          "Could not read the member's live credit balance while reporting a cleared election; the copy will omit availability figures"
        );
        return null;
      })
    // #3369: no member, no ledger, no balance to state.
    : null;
  // What could actually be handed back against THIS booking: never more than
  // the member elected, and never more than their account still holds. Integer
  // cents throughout.
  const refundableCents =
    availableCreditCents == null
      ? null
      : Math.max(0, Math.min(electionCents, availableCreditCents));

  logger.warn(
    {
      bookingId,
      creditElectionCents: electionCents,
      paidAmountCents,
      availableCreditCents,
      source,
    },
    "Cleared a stored credit election on a settlement that could not honour it: the full price was already taken, so the member's balance stays whole (#2265)"
  );

  const details = {
    source,
    creditElectionCents: electionCents,
    paidAmountCents,
    // #2262 delta MED-2: the LIVE balance at report time, so nothing downstream
    // has to treat the elected figure as if it were still available.
    availableCreditCents,
    refundableCents,
    ...extraDetails,
  };

  try {
    await createAuditLog({
      action: UNAPPLIED_CREDIT_ELECTION_AUDIT_ACTION,
      targetId: bookingId,
      subjectMemberId: memberId,
      entityType: "Booking",
      entityId: bookingId,
      category: "payment",
      outcome: "success",
      summary:
        "Stored credit election cleared: the booking was settled at the full price",
      details: JSON.stringify(details),
      metadata: details,
    });
  } catch (err) {
    logger.error(
      { err, bookingId, source },
      "Failed to audit a cleared credit election"
    );
  }

  await sendAdminPaymentFailureAlert({
    memberName: `${memberFirstName} ${memberLastName}`,
    checkIn,
    checkOut,
    // The headline figure is what could actually be handed back, never the raw
    // election — an operator reading "Amount: $450" against a $50 balance would
    // be reading an instruction to overpay.
    amountCents: refundableCents ?? electionCents,
    errorMessage: `This member had asked to put ${formatCents(electionCents)} of account credit towards this booking, but it was settled for ${formatCents(paidAmountCents)} before the credit could be applied, so the saved choice has been cleared. Their account credit balance was never debited and the booking is fully settled — no money is missing and nothing was charged twice. ${operatorAvailabilitySentence(
      electionCents,
      availableCreditCents,
      refundableCents
    )}`,
    paymentIntentId: reference,
  }).catch((err) =>
    logger.error(
      { err, bookingId, source },
      "Failed to alert admins about a cleared credit election"
    )
  );
}
