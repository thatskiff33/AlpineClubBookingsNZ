/**
 * COMPARISON REPORTS V1 AND V2: THE JOURNAL AGAINST THE LEGACY LEDGER (#4627,
 * Ledger M3b; #4628, M3c; the M3 plan on #4515). Pure: the census row in, ONE
 * journal identity and its integrity findings out, added to the booking's
 * evaluation: `JOURNAL_PENDING` (v2, `pendingChargeComparison` below) for a
 * bank-transfer booking whose binding R01 is in the journal and none of whose
 * legacy lines is linked yet, `JOURNAL` (v1) for every other booking.
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
 */
import { isJournalEraBooking, journalComponentOfLegacyLine, MemberMoneyPlanError } from "@/lib/member-money";
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

  const columnCents = row.journal.components.reduce((sum, component) => sum + component.liveGrossCents, 0);
  return {
    identity: { identity: "JOURNAL", status: columnCents === ledgerCents ? "AGREE" : "DISAGREE", columnCents, ledgerCents,
      deltaCents: columnCents - ledgerCents, explainedBy: [] },
    integrity,
  };
}

/** The booking's evaluation with the journal comparison added. */
export function withJournalChargeComparison(evaluation: BookingLedgerEvaluation, row: BookingLedgerCensusRow): BookingLedgerEvaluation {
  const { identity, integrity } = journalChargeComparison(row);
  return { ...evaluation, identities: [...evaluation.identities, identity], integrity: [...evaluation.integrity, ...integrity] };
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
