/**
 * COMPARISON REPORT V1: THE JOURNAL AGAINST THE LEGACY LEDGER (#4627, Ledger
 * M3b; the M3 plan on #4515). Pure: the census row in, one identity and its
 * integrity findings out, added to the booking's evaluation.
 *
 * For every booking whose confirmation (R01) is in the member-money journal,
 * the journal's live charge components must add up to the legacy charge lines
 * bridged to it. Each line counts only through the one rule that maps a legacy
 * line to a component (`journalComponentOfLegacyLine`, `INV-SSOT`), so a
 * settlement line never does. The comparison is of the booking's total, not
 * component by component: a give-back the booking charge cannot absorb is taken
 * from its change fees (`booking-charges.ts`), so the legacy kinds and the
 * journal's components legitimately differ in how the total is split. Its
 * figures are `columnCents` = what the journal carries and `ledgerCents` = what
 * the bridged lines add up to, so an acknowledgement uses the census's own
 * format, with identity `JOURNAL`.
 *
 * Every charge line with money on such a booking must be bridged: one that is
 * not is an `UNBRIDGED_CHARGE_LINE` integrity finding (a door that wrote the
 * legacy line and skipped the journal), which holds the gate. A booking
 * confirmed before M3b is NOT_APPLICABLE: M9 back-posts its whole history.
 */
import { journalComponentOfLegacyLine, MemberMoneyPlanError } from "@/lib/member-money";
import type { BookingLedgerEvaluation, BookingLedgerIdentityResult, BookingLedgerIntegrityFinding } from "@/lib/booking-ledger-projection-census";
import type { BookingLedgerCensusRow } from "@/lib/booking-ledger-projection-census-row";

export function journalChargeComparison(row: BookingLedgerCensusRow): {
  identity: BookingLedgerIdentityResult;
  integrity: BookingLedgerIntegrityFinding[];
} {
  const notApplicable = { identity: "JOURNAL", status: "NOT_APPLICABLE", columnCents: 0, ledgerCents: 0, deltaCents: 0, explainedBy: [] } as const;
  if (!row.journal?.charged) return { identity: { ...notApplicable, explainedBy: [] }, integrity: [] };

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
