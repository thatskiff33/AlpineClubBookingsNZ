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
import { z } from "zod";

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
  classGateRule,
  isCoverageName,
  type BookingLedgerCensusClass,
  type BookingLedgerClassGateRule,
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

/** One class instance; `acknowledged` once an entry in the owner's file matched it to the cent. */
type Instance = { bookingId: string; identity: BookingLedgerIdentity | null; cents: number; detail?: string; acknowledged: boolean };
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
  /**
   * `holdsGate`: an unacknowledged instance closes the gate (`HOLDS` and
   * `ACKNOWLEDGE` alike); `unacknowledged` counts those instances.
   */
  classes: Record<
    BookingLedgerCensusClass,
    { gateRule: BookingLedgerClassGateRule; holdsGate: boolean; bookings: number; instances: Instance[]; unacknowledged: number }
  >;
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
  /** Class instances the owner has not acknowledged, of every class that needs it: printed beside the verdict. */
  unacknowledgedClassInstances: number;
};

function zeroed<K extends string, V>(keys: readonly K[], make: () => V): Record<K, V> {
  return Object.fromEntries(keys.map((key) => [key, make()])) as Record<K, V>;
}

/**
 * THE GATE (owner decision D-3532-1, the plan comment on #3583, design §6):
 * zero unclassified, unacknowledged disagreements, zero coverage gaps, zero
 * integrity findings, no unacknowledged booking in a class that holds it, and
 * every other class acknowledged by the owner — instance by instance, to the
 * cent — save `GROUP_SETTLEMENT_OFF_LEDGER`, which the owner decided is listed
 * only (`classGateRule`).
 */
export function summarizeBookingLedgerCensus(
  evaluations: readonly BookingLedgerEvaluation[],
  tableStatistics: LedgerTableStatistics,
  acknowledgements: readonly BookingLedgerAcknowledgement[] = [],
): BookingLedgerCensusReport {
  const identities = zeroed(BOOKING_LEDGER_IDENTITIES, () => ({ applicable: 0, agree: 0, disagree: 0, classified: 0, coverage: 0 }));
  const coverage = zeroed(BOOKING_LEDGER_COVERAGE_KINDS, () => [] as string[]);
  const counts = zeroed(BOOKING_LEDGER_INTEGRITY_KINDS, () => 0);
  const classes = zeroed(BOOKING_LEDGER_CENSUS_CLASSES, () => ({
    gateRule: "ACKNOWLEDGE" as BookingLedgerClassGateRule,
    holdsGate: true,
    bookings: 0,
    instances: [] as Instance[],
    unacknowledged: 0,
  }));
  for (const name of BOOKING_LEDGER_CENSUS_CLASSES) {
    classes[name].gateRule = classGateRule(name);
    classes[name].holdsGate = classes[name].gateRule !== "OPEN";
  }
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
      classes[evaluation.bookingClass].instances.push({ bookingId: evaluation.bookingId, identity: null, cents: 0, acknowledged: false });
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
          acknowledged: false,
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
      exact.acknowledged = true;
      acknowledged.matched.push({ ...entry, matched: "CLASS" });
    } else if (candidates.length > 0) {
      acknowledged.stale.push({ ...entry, foundCents: candidates.map((instance) => instance.cents) });
    } else {
      acknowledged.unmatched.push(entry);
    }
  }

  let unacknowledgedClassInstances = 0;
  for (const name of BOOKING_LEDGER_CENSUS_CLASSES) {
    classes[name].bookings = new Set(classes[name].instances.map((instance) => instance.bookingId)).size;
    if (!classes[name].holdsGate) continue;
    classes[name].unacknowledged = classes[name].instances.filter((instance) => !acknowledgedInstances.has(instance)).length;
    unacknowledgedClassInstances += classes[name].unacknowledged;
  }
  const gateClosedBecause: string[] = [];
  if (disagreements.length > 0) gateClosedBecause.push(`${disagreements.length} unclassified disagreement(s)`);
  for (const kind of BOOKING_LEDGER_COVERAGE_KINDS) {
    if (coverage[kind].length > 0) gateClosedBecause.push(`${coverage[kind].length} booking(s) with coverage gap ${kind}`);
  }
  if (findings.length > 0) gateClosedBecause.push(`${findings.length} integrity finding(s)`);
  for (const name of BOOKING_LEDGER_CENSUS_CLASSES) {
    if (!classes[name].holdsGate) continue;
    const pending = classes[name].instances.filter((instance) => !acknowledgedInstances.has(instance));
    if (pending.length === 0) continue;
    const bookings = new Set(pending.map((instance) => instance.bookingId)).size;
    gateClosedBecause.push(
      classes[name].gateRule === "HOLDS"
        ? `${bookings} booking(s) in ${name}, which holds the gate`
        : `${pending.length} unacknowledged instance(s) of ${name} on ${bookings} booking(s): the owner acknowledges each on #3583`,
    );
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
    unacknowledgedClassInstances,
  };
}

// ---------------------------------------------------------------------------
// The owner's acknowledgement file, and a draft of it
// ---------------------------------------------------------------------------

/** The acknowledgement file's format: what `--acknowledged` reads and `--write-acknowledgement-draft` writes. */
export const BOOKING_LEDGER_ACKNOWLEDGEMENT_FILE = z.array(
  z
    .object({
      bookingId: z.string().min(1),
      identity: z.enum(BOOKING_LEDGER_IDENTITIES).optional(),
      class: z.enum(BOOKING_LEDGER_CENSUS_CLASSES).optional(),
      cents: z.number().int(),
      reference: z.string().min(1),
    })
    .strict()
    .refine((entry) => (entry.identity === undefined) !== (entry.class === undefined), {
      message: "each entry names exactly one of identity or class",
    }),
);

/** Classes a draft never writes off, and why. */
const NEVER_DRAFTED: Partial<Record<BookingLedgerCensusClass, string>> = {
  KNOWN_DEFECT_HISTORY:
    "owner decision 1 on #3583: each booking is corrected by an officer or written off deliberately on #3583, never in bulk",
};

export type BookingLedgerAcknowledgementDraft = {
  entries: BookingLedgerAcknowledgement[];
  excluded: Array<{ class: BookingLedgerCensusClass; instances: number; bookings: number; reason: string }>;
};

/**
 * A DRAFT of the owner's acknowledgement file: one entry, to the cent, per
 * class instance still holding the gate for want of acknowledgement. It never
 * contains a disagreement, a coverage gap or an integrity finding — those hold
 * until fixed — nor a `KNOWN_DEFECT_HISTORY` instance (`NEVER_DRAFTED`), which
 * it counts as left out instead. Every entry's reference says it is a draft:
 * the owner reviews each line before it releases anything.
 */
export function draftBookingLedgerAcknowledgements(report: BookingLedgerCensusReport): BookingLedgerAcknowledgementDraft {
  const draft: BookingLedgerAcknowledgementDraft = { entries: [], excluded: [] };
  for (const name of BOOKING_LEDGER_CENSUS_CLASSES) {
    const entry = report.classes[name];
    if (!entry.holdsGate) continue;
    const pending = entry.instances.filter((instance) => !instance.acknowledged);
    if (pending.length === 0) continue;
    const reason = NEVER_DRAFTED[name];
    if (reason !== undefined) {
      draft.excluded.push({ class: name, instances: pending.length, bookings: new Set(pending.map((instance) => instance.bookingId)).size, reason });
      continue;
    }
    for (const instance of pending) {
      const where = [instance.identity ?? "booking", instance.detail].filter(Boolean).join(", ");
      draft.entries.push({ bookingId: instance.bookingId, class: name, cents: instance.cents, reference: `DRAFT, review before signing off: ${name} on ${where}` });
    }
  }
  return draft;
}
