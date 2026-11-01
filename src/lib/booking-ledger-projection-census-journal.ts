/**
 * COMPARISON REPORT V1: THE JOURNAL AGAINST THE LEGACY LEDGER (#4627, Ledger
 * M3b; the M3 plan on #4515). Pure: the census row in, one identity and its
 * integrity findings out, added to the booking's evaluation.
 *
 * For every booking whose confirmation (R01) is in the member-money journal,
 * the journal's live charge components must equal the legacy charge lines
 * bridged to it, component by component, through the one rule that maps a
 * legacy line to its component (`journalComponentOfLegacyLine`, `INV-SSOT`):
 * the folded booking charge (nights, promotion, agreed adjustments) and each
 * fee. Its figures are `columnCents` = what the journal carries and
 * `ledgerCents` = what the bridged lines add up to, so an acknowledgement uses
 * the census's own format, with identity `JOURNAL`.
 *
 * Every charge line with money on such a booking must be bridged: one that is
 * not is an `UNBRIDGED_CHARGE_LINE` integrity finding (a door that wrote the
 * legacy line and skipped the journal), which holds the gate. A booking
 * confirmed before M3b is NOT_APPLICABLE: M9 back-posts its whole history.
 */
import { bookingComponentKey, journalComponentOfLegacyLine, MemberMoneyPlanError } from "@/lib/member-money";
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
  const legacy = new Map<string, number>();
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
    const key = bookingComponentKey(component);
    legacy.set(key, (legacy.get(key) ?? 0) + line.amountCents);
  }

  const journal = new Map(row.journal.components.map((component) => [bookingComponentKey(component), component.liveGrossCents]));
  const columnCents = [...journal.values()].reduce((sum, cents) => sum + cents, 0);
  const ledgerCents = [...legacy.values()].reduce((sum, cents) => sum + cents, 0);
  const agree = [...new Set([...journal.keys(), ...legacy.keys()])]
    .every((key) => (journal.get(key) ?? 0) === (legacy.get(key) ?? 0));
  return {
    identity: { identity: "JOURNAL", status: agree ? "AGREE" : "DISAGREE", columnCents, ledgerCents,
      deltaCents: columnCents - ledgerCents, explainedBy: [] },
    integrity,
  };
}

/** The booking's evaluation with the journal comparison added. */
export function withJournalChargeComparison(evaluation: BookingLedgerEvaluation, row: BookingLedgerCensusRow): BookingLedgerEvaluation {
  const { identity, integrity } = journalChargeComparison(row);
  return { ...evaluation, identities: [...evaluation.identities, identity], integrity: [...evaluation.integrity, ...integrity] };
}
