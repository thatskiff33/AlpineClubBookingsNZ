/**
 * THE BOOKING-LEDGER CENSUS'S REPORT AND VERDICT (#3583, `INV-MONEY-037`).
 *
 * Pure: per-booking evaluations (`booking-ledger-projection-census.ts`) and
 * the owner's acknowledgements in, the report out.
 *
 * ACKNOWLEDGEMENT IS EXACT. The owner's file names a booking, an identity or a
 * class, the cents and their own reference (the decision that wrote it off or
 * the correction that is coming). An entry that matches a finding to the cent
 * moves it to `acknowledged`, where it no longer holds the gate. One whose
 * booking and identity or class match but whose cents do not is STALE: the
 * finding stays where it was, still blocking, so a figure that moved after the
 * owner signed it off is looked at again. One that matches nothing is listed
 * as unmatched. The file is the owner's and never lives in the repository.
 */
import {
  BOOKING_LEDGER_IDENTITIES,
  BOOKING_LEDGER_INTEGRITY_KINDS,
  type BookingLedgerEvaluation,
  type BookingLedgerIdentity,
  type BookingLedgerIntegrityFinding,
  type BookingLedgerIntegrityKind,
} from "@/lib/booking-ledger-projection-census";
import {
  BOOKING_LEDGER_CENSUS_CLASSES,
  BOOKING_LEDGER_COVERAGE_KINDS,
  classHoldsGate,
  isCoverageName,
  type BookingLedgerCensusClass,
  type BookingLedgerCoverageKind,
} from "@/lib/booking-ledger-projection-census-classes";

/** `pg_stat_user_tables` for the ledger table: information only, never the gate. */
export type LedgerTableStatistics = { inserts: number; updates: number; deletes: number } | null;

/** One line of the owner's acknowledgement file: exactly one of `identity` or `class`. */
export type BookingLedgerAcknowledgement = {
  bookingId: string;
  identity?: BookingLedgerIdentity;
  class?: BookingLedgerCensusClass;
  cents: number;
  reference: string;
};

type Instance = { bookingId: string; identity: BookingLedgerIdentity | null; cents: number; detail?: string };
type Strand = { bookings: number; cents: number; items: Array<{ bookingId: string; cents: number }> };

export type BookingLedgerCensusReport = {
  population: { bookings: number; bookingsWithLines: number; lines: number };
  identities: Record<BookingLedgerIdentity, { applicable: number; agree: number; disagree: number; classified: number; coverage: number }>;
  coverage: Record<BookingLedgerCoverageKind, string[]>;
  integrity: {
    counts: Record<BookingLedgerIntegrityKind, number>;
    findings: BookingLedgerIntegrityFinding[];
    info: { unkeyedLines: number; tableStatistics: LedgerTableStatistics };
  };
  classes: Record<BookingLedgerCensusClass, { holdsGate: boolean; bookings: number; instances: Instance[] }>;
  acknowledged: {
    matched: Array<BookingLedgerAcknowledgement & { matched: "DISAGREEMENT" | "CLASS" }>;
    stale: Array<BookingLedgerAcknowledgement & { foundCents: number[] }>;
    unmatched: BookingLedgerAcknowledgement[];
  };
  info: {
    retainedCollected: { bookings: number; cents: number };
    /** Shown under CREDIT_APPLIED; #1620's realized and pending strands, each booking listed. */
    ibUnallocatedAppliedCredit: { realized: Strand; pending: Strand };
  };
  disagreements: Array<{ bookingId: string; identity: BookingLedgerIdentity; columnCents: number; ledgerCents: number; deltaCents: number }>;
  verdict: "GATE_OPEN" | "GATE_CLOSED";
  gateClosedBecause: string[];
};

function zeroed<K extends string, V>(keys: readonly K[], make: () => V): Record<K, V> {
  return Object.fromEntries(keys.map((key) => [key, make()])) as Record<K, V>;
}

/**
 * THE GATE (owner decision D-3532-1, the plan comment on #3583): zero
 * unclassified, unacknowledged disagreements, zero coverage gaps, zero
 * integrity findings, and no unacknowledged instance of a class the policy
 * says holds it. Every other class is a list the owner acknowledges.
 */
export function summarizeBookingLedgerCensus(
  evaluations: readonly BookingLedgerEvaluation[],
  tableStatistics: LedgerTableStatistics,
  acknowledgements: readonly BookingLedgerAcknowledgement[] = [],
): BookingLedgerCensusReport {
  const identities = zeroed(BOOKING_LEDGER_IDENTITIES, () => ({ applicable: 0, agree: 0, disagree: 0, classified: 0, coverage: 0 }));
  const coverage = zeroed(BOOKING_LEDGER_COVERAGE_KINDS, () => [] as string[]);
  const counts = zeroed(BOOKING_LEDGER_INTEGRITY_KINDS, () => 0);
  const classes = zeroed(BOOKING_LEDGER_CENSUS_CLASSES, () => ({ holdsGate: false, bookings: 0, instances: [] as Instance[] }));
  for (const name of BOOKING_LEDGER_CENSUS_CLASSES) classes[name].holdsGate = classHoldsGate(name);
  const findings: BookingLedgerIntegrityFinding[] = [];
  let disagreements: BookingLedgerCensusReport["disagreements"] = [];
  const strand = (): Strand => ({ bookings: 0, cents: 0, items: [] });
  const info: BookingLedgerCensusReport["info"] = {
    retainedCollected: { bookings: 0, cents: 0 },
    ibUnallocatedAppliedCredit: { realized: strand(), pending: strand() },
  };
  let lines = 0;
  let bookingsWithLines = 0;
  let unkeyedLines = 0;

  for (const evaluation of evaluations) {
    lines += evaluation.lineCount;
    if (evaluation.lineCount > 0) bookingsWithLines += 1;
    unkeyedLines += evaluation.info.unkeyedLines;
    for (const kind of evaluation.coverage) coverage[kind].push(evaluation.bookingId);
    if (evaluation.bookingClass) {
      classes[evaluation.bookingClass].instances.push({ bookingId: evaluation.bookingId, identity: null, cents: 0 });
    }
    for (const identity of evaluation.identities) {
      if (identity.status === "NOT_APPLICABLE") continue;
      const tally = identities[identity.identity];
      tally.applicable += 1;
      if (identity.status === "AGREE") tally.agree += 1;
      else if (identity.status === "DISAGREE") tally.disagree += 1;
      else if (identity.status === "CLASSIFIED") tally.classified += 1;
      else tally.coverage += 1;
      if (identity.status === "DISAGREE") {
        disagreements.push({
          bookingId: evaluation.bookingId,
          identity: identity.identity,
          columnCents: identity.columnCents,
          ledgerCents: identity.ledgerCents,
          deltaCents: identity.deltaCents,
        });
      }
      for (const component of identity.explainedBy) {
        if (isCoverageName(component.name)) continue;
        classes[component.name].instances.push({
          bookingId: evaluation.bookingId,
          identity: identity.identity,
          cents: component.cents,
          ...(component.detail ? { detail: component.detail } : {}),
        });
      }
    }
    findings.push(...evaluation.integrity);
    for (const finding of evaluation.integrity) counts[finding.kind] += 1;
    if (evaluation.info.retainedCollectedCents > 0) {
      info.retainedCollected.bookings += 1;
      info.retainedCollected.cents += evaluation.info.retainedCollectedCents;
    }
    const strandInfo = evaluation.info.ibUnallocatedAppliedCredit;
    if (strandInfo) {
      const bucket = strandInfo.realized ? info.ibUnallocatedAppliedCredit.realized : info.ibUnallocatedAppliedCredit.pending;
      bucket.bookings += 1;
      bucket.cents += strandInfo.cents;
      bucket.items.push({ bookingId: evaluation.bookingId, cents: strandInfo.cents });
    }
  }

  const acknowledged: BookingLedgerCensusReport["acknowledged"] = { matched: [], stale: [], unmatched: [] };
  const acknowledgedInstances = new Set<Instance>();
  for (const entry of acknowledgements) {
    if (entry.identity !== undefined) {
      const candidates = disagreements.filter((row) => row.bookingId === entry.bookingId && row.identity === entry.identity);
      const exact = candidates.find((row) => row.deltaCents === entry.cents);
      if (exact) {
        disagreements = disagreements.filter((row) => row !== exact);
        acknowledged.matched.push({ ...entry, matched: "DISAGREEMENT" });
      } else if (candidates.length > 0) {
        acknowledged.stale.push({ ...entry, foundCents: candidates.map((row) => row.deltaCents) });
      } else {
        acknowledged.unmatched.push(entry);
      }
      continue;
    }
    const candidates = entry.class
      ? classes[entry.class].instances.filter((instance) => instance.bookingId === entry.bookingId && !acknowledgedInstances.has(instance))
      : [];
    const exact = candidates.find((instance) => instance.cents === entry.cents);
    if (exact) {
      acknowledgedInstances.add(exact);
      acknowledged.matched.push({ ...entry, matched: "CLASS" });
    } else if (candidates.length > 0) {
      acknowledged.stale.push({ ...entry, foundCents: candidates.map((instance) => instance.cents) });
    } else {
      acknowledged.unmatched.push(entry);
    }
  }

  for (const name of BOOKING_LEDGER_CENSUS_CLASSES) {
    classes[name].bookings = new Set(classes[name].instances.map((instance) => instance.bookingId)).size;
  }
  const gateClosedBecause: string[] = [];
  if (disagreements.length > 0) gateClosedBecause.push(`${disagreements.length} unclassified disagreement(s)`);
  for (const kind of BOOKING_LEDGER_COVERAGE_KINDS) {
    if (coverage[kind].length > 0) gateClosedBecause.push(`${coverage[kind].length} booking(s) with coverage gap ${kind}`);
  }
  if (findings.length > 0) gateClosedBecause.push(`${findings.length} integrity finding(s)`);
  for (const name of BOOKING_LEDGER_CENSUS_CLASSES) {
    if (!classes[name].holdsGate) continue;
    const holding = new Set(classes[name].instances.filter((instance) => !acknowledgedInstances.has(instance)).map((instance) => instance.bookingId));
    if (holding.size > 0) gateClosedBecause.push(`${holding.size} booking(s) in ${name}, which holds the gate`);
  }
  if (acknowledged.stale.length > 0) gateClosedBecause.push(`${acknowledged.stale.length} stale acknowledgement(s): the figure moved since it was signed off`);

  return {
    population: { bookings: evaluations.length, bookingsWithLines, lines },
    identities,
    coverage,
    integrity: { counts, findings, info: { unkeyedLines, tableStatistics } },
    classes,
    acknowledged,
    info,
    disagreements,
    verdict: gateClosedBecause.length === 0 ? "GATE_OPEN" : "GATE_CLOSED",
    gateClosedBecause,
  };
}
