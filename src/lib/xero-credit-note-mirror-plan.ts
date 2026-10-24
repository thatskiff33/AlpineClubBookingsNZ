/**
 * #4270 — the pure arithmetic of the inbound credit-note mirror: given what the
 * ledger holds and what Xero shows spent outside the app, how many cents to write
 * the lot down by, restore, or leave for the failure-triggered converge (#4219).
 * Nothing here reads or writes; the routine in `xero-credit-note-mirror.ts` feeds
 * it numbers read under the member's credit-ledger lock.
 *
 * The target is a state, not a delta from the last event, so a replayed or
 * out-of-order event cannot drift the ledger: with `O` the spend Xero shows the
 * app has no record of and `W` the net already written down for the note,
 *
 *   D = min(O, lot)          what the lot should have lost
 *   delta = D - W
 *
 * `delta > 0` writes down at most what is free (not drawn by a booking's slice,
 * not already written down, and not more than the member's balance, so a
 * balance never goes below zero); what is left is credit planned onto a booking,
 * which the converge handles when Xero refuses that booking's allocation.
 * `delta < 0` restores, and never more than `W`, because `D >= 0`.
 */
export interface OutsideSpendMirrorInput {
  /** The funding lot's amount. */
  lotCents: number;
  /** Σ of the booking slices drawn from the lot. */
  sliceCents: number;
  /** Net written down for the note (write-downs less restores), never below zero. */
  writtenDownCents: number;
  /** What Xero shows spent on things the app has no record of. */
  outsideSpendCents: number;
  /** The member's credit balance now. */
  balanceCents: number;
}

export type OutsideSpendMirrorPlan =
  | { kind: "none"; leftForAllocationCents: number }
  | { kind: "write-down"; cents: number; leftForAllocationCents: number }
  | { kind: "restore"; cents: number; leftForAllocationCents: 0 };

export function planOutsideSpendMirror(input: OutsideSpendMirrorInput): OutsideSpendMirrorPlan {
  const { lotCents, sliceCents, writtenDownCents, outsideSpendCents, balanceCents } = input;
  for (const [name, value] of Object.entries({ lotCents, sliceCents, writtenDownCents, outsideSpendCents })) {
    if (!Number.isInteger(value) || value < 0) throw new Error(`${name} must be non-negative integer cents, got ${value}.`);
  }
  if (!Number.isInteger(balanceCents)) throw new Error(`balanceCents must be integer cents, got ${balanceCents}.`);

  const targetCents = Math.min(outsideSpendCents, lotCents);
  const deltaCents = targetCents - writtenDownCents;
  if (deltaCents === 0) return { kind: "none", leftForAllocationCents: 0 };
  // `targetCents >= 0`, so `-deltaCents <= writtenDownCents`: a restore can never exceed the write-down.
  if (deltaCents < 0) return { kind: "restore", cents: -deltaCents, leftForAllocationCents: 0 };

  const freeCents = Math.max(0, lotCents - sliceCents - writtenDownCents);
  const cents = Math.min(deltaCents, freeCents, Math.max(0, balanceCents));
  const leftForAllocationCents = deltaCents - cents;
  return cents > 0 ? { kind: "write-down", cents, leftForAllocationCents } : { kind: "none", leftForAllocationCents };
}
