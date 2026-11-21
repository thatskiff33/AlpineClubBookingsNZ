/**
 * COMPARISON REPORTS V1 TO V3: THE JOURNAL AGAINST THE LEGACY LEDGER (#4627,
 * Ledger M3b; #4628, M3c; the M3 plan on #4515; #5185, M4d). Pure: the census
 * row in, ONE charge identity and its integrity findings out, added to the
 * booking's evaluation: `JOURNAL_PENDING` (v2, `pendingChargeComparison` below)
 * for a bank-transfer booking whose binding R01 is in the journal and none of
 * whose legacy lines is linked yet, `JOURNAL` (v1) for every other booking;
 * then v3's refund identity, `JOURNAL_REFUND_PAYABLE`, and the hand-back
 * classes (`journalRefundPayableComparison` below).
 *
 * V1: for every booking whose confirmation (R01) is in the member-money journal
 * and linked, the journal's live charge components must add up to the legacy
 * charge lines bridged to it. Each line counts only through the one rule that maps a legacy
 * line to a component (`journalComponentOfLegacyLine`, `INV-SSOT`), so a
 * settlement line never does. The comparison is of the booking's total, not
 * component by component: a give-back the booking charge cannot absorb is taken
 * from its change fees (`booking-charges.ts`), so the legacy kinds and the
 * journal's components legitimately differ in how the total is split. Its
 * figures are `columnCents` = what the journal carries and `ledgerCents` = what
 * the bridged lines add up to, so an acknowledgement uses the census's own
 * format, with identity `JOURNAL`.
 *
 * Every charge line with money on such a booking must be bridged (and on a
 * pending one, none may exist: see v2): one that is not is an
 * `UNBRIDGED_CHARGE_LINE` integrity finding (a door that wrote the
 * legacy line and skipped the journal), which holds the gate. A booking
 * confirmed before M3b is NOT_APPLICABLE: M9 back-posts its whole history.
 *
 * #4516 review M2: the one journal charge no legacy line carries is the rest a
 * part "Paid another way" close let the club keep (R14's close-out, a component
 * per close record, `refundCloseOutIdentity`). The legacy ledger keeps that rest
 * on the close's record instead (`paidAnotherWayUnpaidCents`), so each close-out
 * component in the journal counts on the ledger side as its record's kept rest:
 * the two agree exactly when the journal kept what the record says. A close-out
 * whose record is gone, or says otherwise, disagrees. A kept rest the journal
 * never closed out is the refund census's (`KEPT_REST_WITHOUT_CLOSE_OUT`).
 *
 * #4516 (M4d): a late capture the treasurer keeps, and no invoice already bills,
 * is the other journal charge with no legacy line (`kept-capture:<intent>`).
 * It counts on the ledger side as the gross the journal still carries, so the
 * two agree. A keep an invoice already bills adds no component.
 */
import {
  classifyHandBacks,
  heldCaptureReturnOwedCents,
  heldHandBackOwedCents,
  isJournalEraBooking,
  journalComponentOfLegacyLine,
  keptCapturePaymentIntentOfIdentity,
  MemberMoneyPlanError,
  refundCloseOutRecordOfIdentity,
} from "@/lib/member-money";
import { paidAnotherWayUnpaidCents } from "@/lib/manual-refund-task-settlement-rules";
import { cardRefundOperationUnmadeCents } from "@/lib/open-card-refund-owed";
import type { BookingLedgerEvaluation, BookingLedgerIdentityResult, BookingLedgerIntegrityFinding } from "@/lib/booking-ledger-projection-census";
import type { BookingLedgerCensusRow } from "@/lib/booking-ledger-projection-census-row";
import type { BookingLedgerCensusReport } from "@/lib/booking-ledger-projection-census-report";

/**
 * COMPARISON REPORT V2 (#4628, M3c): a bank-transfer booking charged at its
 * binding moment holds its charge in the journal only, until its legacy
 * confirmation writes lines and links them (`pending`). Its live components
 * are compared with what the booking says it owes: its final price plus the
 * fees recorded on its payment (`bookingAmountOwedCents`'s charge side, before
 * credit, which the journal does not yet post), or, once cancelled, what the
 * club kept as the CANCELLED snapshot froze it (nothing, where it froze none).
 * Identity `JOURNAL_PENDING`, in place of `JOURNAL`: `columnCents` = what the journal carries,
 * `ledgerCents` = what the booking owes, the census's acknowledgement format.
 * A pending booking has no legacy charge line by definition: one with money is
 * a confirmation that skipped the bridge, `UNBRIDGED_CHARGE_LINE`.
 */
function pendingChargeComparison(row: BookingLedgerCensusRow, journal: NonNullable<BookingLedgerCensusRow["journal"]>): {
  identity: BookingLedgerIdentityResult;
  integrity: BookingLedgerIntegrityFinding[];
} {
  const columnCents = journal.components.reduce((sum, component) => sum + component.liveGrossCents, 0);
  const ledgerCents = row.booking.status === "CANCELLED"
    ? (row.cancellation?.keptCents ?? 0)
    : row.booking.finalPriceCents + (row.payment?.changeFeeCents ?? 0);
  const integrity: BookingLedgerIntegrityFinding[] = row.lines
    .filter((line) => line.side !== "SETTLEMENT" && line.amountCents !== 0)
    .map((line) => ({ bookingId: row.booking.id, lineId: line.id, kind: "UNBRIDGED_CHARGE_LINE",
      detail: `a ${line.kind} line on a booking whose bank-transfer charge is pending in the journal, but the confirmation bridge never linked it` }));
  return {
    identity: { identity: "JOURNAL_PENDING", status: columnCents === ledgerCents ? "AGREE" : "DISAGREE", columnCents, ledgerCents,
      deltaCents: columnCents - ledgerCents, explainedBy: [] },
    integrity,
  };
}

/** The booking's one journal identity: `JOURNAL_PENDING` while its bank-transfer charge is pending, `JOURNAL` otherwise. */
export function journalChargeComparison(row: BookingLedgerCensusRow): {
  identity: BookingLedgerIdentityResult;
  integrity: BookingLedgerIntegrityFinding[];
} {
  const notApplicable = { identity: "JOURNAL", status: "NOT_APPLICABLE", columnCents: 0, ledgerCents: 0, deltaCents: 0, explainedBy: [] } as const;
  if (row.journal?.charged && row.journal.pending) return pendingChargeComparison(row, row.journal);
  if (!row.journal?.charged) {
    // Confirmed before M3b, or never confirmed: not compared. But a booking
    // created after the journal's first R01 and confirmed on the ledger must
    // have one; without it, a door wrote its lines and skipped the journal.
    const confirmation = row.lines.find((line) => line.anchorKind === "CONFIRMATION");
    const skipped = confirmation !== undefined && isJournalEraBooking(row.booking.createdAt, row.journal?.journalSince ?? null);
    return {
      identity: { ...notApplicable, explainedBy: [] },
      integrity: skipped ? [{ bookingId: row.booking.id, lineId: confirmation.id, kind: "CONFIRMED_WITHOUT_R01",
        detail: "created after the journal's first confirmation and confirmed on the ledger, but its R01 was never posted" }] : [],
    };
  }

  const bookingId = row.booking.id;
  const keyById = new Map(row.lines.map((line) => [line.id, line.postingKey]));
  let ledgerCents = 0;
  const integrity: BookingLedgerIntegrityFinding[] = [];
  for (const line of row.lines) {
    if (line.side === "SETTLEMENT" || line.amountCents === 0) continue;
    let component;
    try {
      component = journalComponentOfLegacyLine({
        bookingId,
        kind: line.kind,
        postingKey: line.postingKey,
        reversesLineId: line.reversesLineId,
        reversedPostingKey: line.reversesLineId === null ? null : (keyById.get(line.reversesLineId) ?? null),
      });
    } catch (error) {
      if (!(error instanceof MemberMoneyPlanError)) throw error;
      integrity.push({ bookingId, lineId: line.id, kind: "UNBRIDGED_CHARGE_LINE", detail: error.problems.join("; ") });
      continue;
    }
    if (!component) continue;
    if (!row.journal.bridgedLineIds.has(line.id)) {
      integrity.push({ bookingId, lineId: line.id, kind: "UNBRIDGED_CHARGE_LINE",
        detail: `a ${line.kind} line on a booking whose confirmation is in the journal, but no journal batch links it` });
      continue;
    }
    ledgerCents += line.amountCents;
  }
  const keptByRecord = new Map(row.tasks.map((task) => [task.id, paidAnotherWayUnpaidCents({ amountCents: task.amountCents, raisedAmountCents: task.raisedAmountCents ?? null })]));
  for (const component of row.journal.components) {
    const recordId = refundCloseOutRecordOfIdentity(component.chargeIdentity);
    if (recordId !== null) ledgerCents += keptByRecord.get(recordId) ?? 0;
    else if (keptCapturePaymentIntentOfIdentity(component.chargeIdentity) !== null) ledgerCents += component.liveGrossCents;
  }

  const columnCents = row.journal.components.reduce((sum, component) => sum + component.liveGrossCents, 0);
  return {
    identity: { identity: "JOURNAL", status: columnCents === ledgerCents ? "AGREE" : "DISAGREE", columnCents, ledgerCents,
      deltaCents: columnCents - ledgerCents, explainedBy: [] },
    integrity,
  };
}

/**
 * COMPARISON REPORT V3 (#5185, M4d): for every booking whose R01 is in the
 * journal, the journal's open refund payable (every refund debt's
 * refund-payable lines, credits less debits) must equal what the legacy records
 * still owe back on the debts the journal took on: each journal hand-back task
 * whose R05 posted, at what it still owes (`heldHandBackOwedCents`), plus each
 * open card refund row whose debt is live in the journal (the live end of its
 * chain, so a debt reversed since counts no row), at its slices not yet made
 * (`cardRefundOperationUnmadeCents`, the figure `IN_FLIGHT_REFUND` reads; a
 * dead row still owes until it is closed), plus each late capture held open
 * for the treasurer whose capture-return R05 posted and no such row pays, at
 * its task's amount (`heldCaptureReturnOwedCents`). A debt raised before its door
 * posted R05s is M9's, so neither side counts it; a debt the journal holds
 * with nothing behind it, or a refund that went back without paying its debt,
 * disagrees. Identity `JOURNAL_REFUND_PAYABLE`: `columnCents` = the journal's
 * figure, `ledgerCents` = the legacy one, the census's acknowledgement format.
 * The hand-back classes (`classifyHandBacks`) are its integrity findings, each
 * naming its task as the finding's `lineId`. A booking with no R01, or read
 * without hand-back facts (the back-post's own judgement), is NOT_APPLICABLE.
 */
export function journalRefundPayableComparison(row: BookingLedgerCensusRow): {
  identity: BookingLedgerIdentityResult;
  integrity: BookingLedgerIntegrityFinding[];
} {
  const facts = row.journal?.charged ? row.handBacks : null;
  if (!facts) {
    return { identity: { identity: "JOURNAL_REFUND_PAYABLE", status: "NOT_APPLICABLE", columnCents: 0, ledgerCents: 0, deltaCents: 0, explainedBy: [] }, integrity: [] };
  }
  // The keys are of open card refund rows whose debt is live (`readBookingHandBackJournal`), read in the same snapshot as these rows.
  const cardCents = row.recoveryOperations.filter((operation) => facts.journalCardRefundKeys.has(operation.idempotencyKey))
    .reduce((sum, operation) => sum + cardRefundOperationUnmadeCents(operation), 0);
  const columnCents = facts.openRefundPayableCents;
  const ledgerCents = heldHandBackOwedCents(facts) + heldCaptureReturnOwedCents(facts) + cardCents;
  return {
    identity: { identity: "JOURNAL_REFUND_PAYABLE", status: columnCents === ledgerCents ? "AGREE" : "DISAGREE", columnCents, ledgerCents,
      deltaCents: columnCents - ledgerCents, explainedBy: [] },
    integrity: classifyHandBacks(row.booking.id, facts).map((finding) => ({ bookingId: finding.bookingId, lineId: finding.identity, kind: finding.kind, detail: finding.detail })),
  };
}

/** The booking's evaluation with the journal comparisons added: its charge identity, then v3's refund identity. */
export function withJournalChargeComparison(evaluation: BookingLedgerEvaluation, row: BookingLedgerCensusRow): BookingLedgerEvaluation {
  const charge = journalChargeComparison(row);
  const refund = journalRefundPayableComparison(row);
  return { ...evaluation, identities: [...evaluation.identities, charge.identity, refund.identity],
    integrity: [...evaluation.integrity, ...charge.integrity, ...refund.integrity] };
}

/**
 * #4627: the club's journal is inactive (its currency no card can be charged
 * in, `bookingJournalInactiveReason`): one integrity finding that holds the gate
 * until the currency is fixed, because nothing the doors write is posted.
 */
export function withJournalInactiveFinding(report: BookingLedgerCensusReport, reason: string): BookingLedgerCensusReport {
  return {
    ...report,
    integrity: {
      ...report.integrity,
      counts: { ...report.integrity.counts, JOURNAL_INACTIVE: report.integrity.counts.JOURNAL_INACTIVE + 1 },
      findings: [...report.integrity.findings, { bookingId: "", lineId: "", kind: "JOURNAL_INACTIVE", detail: reason }],
    },
    verdict: "GATE_CLOSED",
    gateClosedBecause: [...report.gateClosedBecause, `the member-money journal is inactive: ${reason}`],
  };
}
