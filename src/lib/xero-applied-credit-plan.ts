/**
 * The pure applied-credit allocation planner (#1620), split from
 * `xero-applied-credit-allocation.ts` (#3836) so the engine stays within its
 * size budget. Unit-tested; the engine re-exports it.
 */
import type { CreditType, Prisma } from "@prisma/client";
import type { ClubFormat } from "@/lib/club-format";
import { formatCents } from "@/lib/utils";

// ---------------------------------------------------------------------------
// Credit-lot use order (INV-PAY-127, #4013)
// ---------------------------------------------------------------------------

/**
 * The ONE order in which a member's positive credit lots are used: oldest
 * first, and between two lots stamped with the same instant, the lower `id`
 * first. Every read that hands lots to {@link planAppliedCreditAllocation}
 * orders by this and by nothing else (`INV-PAY-127`), and
 * `credit-lot-use-order-census.test.ts` fails a `memberCredit` read that orders
 * by `createdAt` any other way.
 *
 * `createdAt` alone is not an order. Two lots written in one transaction, or
 * under the frozen test clock, carry the same instant, and PostgreSQL returns
 * tied rows in whatever order its plan meets them: a noted lot one run and a
 * noteless one the next, which decides whether the engine allocates an existing
 * note or mints a remainder (#4013). The `id` tie-break changes no amount and no
 * lot's eligibility; it only makes the tie the same every time. Spread it into
 * the query (`orderBy: [...CREDIT_LOT_USE_ORDER]`) — Prisma takes a mutable
 * array and this one stays frozen.
 *
 * It lives here because the planner is its only consumer today. A second
 * consumer moves it to a Prisma-free member-credit module both import, rather
 * than reaching into the Xero planner for a ledger fact.
 */
export const CREDIT_LOT_USE_ORDER = [
  { createdAt: "asc" },
  { id: "asc" },
] as const satisfies readonly Prisma.MemberCreditOrderByWithRelationInput[];

// ---------------------------------------------------------------------------
// Pure allocation planner (unit-tested)
// ---------------------------------------------------------------------------

export interface AppliedCreditLot {
  memberCreditId: string;
  /** The lot's floating Xero note, or null for a noteless lot (admin adjustment
   * or #1547-restored credit) that must be covered by a freshly minted note. */
  xeroCreditNoteId: string | null;
  /**
   * The ledger row's own credit type. REQUIRED (#2717): it is what decides
   * which Xero mapping a MINTED slice of this lot posts to, and "noteless"
   * does not answer that — an admin adjustment and #1547-restored cancellation
   * credit are both noteless and are opposite accounting events. Making it a
   * required field rather than an optional hint is deliberate: a caller that
   * forgets it cannot compile, so a new lot loader cannot silently book a
   * member's own refunded money as a discretionary club expense.
   */
  creditType: CreditType;
  /** lot.amountCents − Σ already-allocated slices (>= 0). */
  remainingCents: number;
}

export interface PlannedNoteAllocation {
  memberCreditId: string;
  xeroCreditNoteId: string;
  amountCents: number;
}

export interface PlannedMintSlice {
  memberCreditId: string;
  /** Carried from the lot — see `AppliedCreditLot.creditType` (#2717). */
  creditType: CreditType;
  amountCents: number;
}

export interface AppliedCreditPlan {
  /** Existing floating notes to allocate against the invoice. */
  noteAllocations: PlannedNoteAllocation[];
  /** Noteless lots to cover with a single freshly minted note. */
  mintSlices: PlannedMintSlice[];
  /** Σ mintSlices — the amount of the fresh note to mint (0 when none). */
  mintTotalCents: number;
  /** Total planned; always equals appliedCents for a well-formed ledger. */
  coveredCents: number;
}

/**
 * Decide which credit lots fund `appliedCents`, in the order given — which the
 * loader makes {@link CREDIT_LOT_USE_ORDER}. Conservation is independent of lot
 * order (owner/advisor: lot order is neutral); oldest-first, ties by `id`, is
 * the deterministic default. Throws if the lots cannot cover the applied amount —
 * that can only happen on a corrupted ledger, since applied credit never exceeds
 * the balance at apply-time and allocations never exceed prior applications.
 */
export function planAppliedCreditAllocation(
  lots: AppliedCreditLot[],
  appliedCents: number,
  format: ClubFormat,
): AppliedCreditPlan {
  const noteAllocations: PlannedNoteAllocation[] = [];
  const mintSlices: PlannedMintSlice[] = [];
  let outstanding = appliedCents;

  for (const lot of lots) {
    if (outstanding <= 0) {
      break;
    }
    const slice = Math.min(lot.remainingCents, outstanding);
    if (slice <= 0) {
      continue;
    }
    if (lot.xeroCreditNoteId) {
      noteAllocations.push({
        memberCreditId: lot.memberCreditId,
        xeroCreditNoteId: lot.xeroCreditNoteId,
        amountCents: slice,
      });
    } else {
      mintSlices.push({
        memberCreditId: lot.memberCreditId,
        creditType: lot.creditType,
        amountCents: slice,
      });
    }
    outstanding -= slice;
  }

  if (outstanding > 0) {
    throw new Error(
      `Applied credit ${formatCents(appliedCents, format)} exceeds available credit-lot remaining by ${formatCents(outstanding, format)} — member-credit ledger inconsistency`,
    );
  }

  const mintTotalCents = mintSlices.reduce((sum, m) => sum + m.amountCents, 0);
  return {
    noteAllocations,
    mintSlices,
    mintTotalCents,
    coveredCents: appliedCents - outstanding,
  };
}

// ---------------------------------------------------------------------------
// The free credit of each lot (#1620, #4219, #4220)
// ---------------------------------------------------------------------------

/** A positive credit lot as the loader reads it, before its free credit is worked out. */
export interface CreditLotRow {
  id: string;
  amountCents: number;
  type: CreditType;
  xeroCreditNoteId: string | null;
}

/**
 * THE FREE CREDIT OF EACH LOT, in the order given (the loader's
 * {@link CREDIT_LOT_USE_ORDER}): the lot's amount, less the slices already drawn
 * from it, less its note's net write-down (#4219), which is taken once per note,
 * oldest lot first, never from each lot stamped with the note. A lot with nothing
 * free is dropped. The allocation engine's loader (`gatherAppliedCreditLots`) and
 * the early warning's replay of its draw (#4220) both work it out here (`INV-SSOT`).
 */
export function freeCreditLots(
  lots: readonly CreditLotRow[],
  allocatedByLotId: ReadonlyMap<string, number>,
  writtenDownByNote: ReadonlyMap<string, number>,
): AppliedCreditLot[] {
  const writtenDown = new Map(writtenDownByNote);
  const free: AppliedCreditLot[] = [];
  for (const lot of lots) {
    const unallocated = lot.amountCents - (allocatedByLotId.get(lot.id) ?? 0);
    // A note's write-down is taken once, oldest lot first, never from each lot stamped with the note.
    const downCents = lot.xeroCreditNoteId ? Math.min(Math.max(unallocated, 0), writtenDown.get(lot.xeroCreditNoteId) ?? 0) : 0;
    if (lot.xeroCreditNoteId && downCents > 0) writtenDown.set(lot.xeroCreditNoteId, (writtenDown.get(lot.xeroCreditNoteId) ?? 0) - downCents);
    const remainingCents = unallocated - downCents;
    if (remainingCents <= 0) {
      continue;
    }
    free.push({
      memberCreditId: lot.id,
      creditType: lot.type,
      xeroCreditNoteId: lot.xeroCreditNoteId,
      remainingCents,
    });
  }
  return free;
}

/**
 * What {@link planAppliedCreditAllocation} takes from one lot when it fills
 * `appliedCents` from `lots` in order: everything before the lot is used first,
 * so the lot gives what is still outstanding when it is reached, up to its free
 * credit. The planner's fill in closed form, for a reader that must not plan (it
 * never throws on a shortfall); its tests check the two agree.
 */
export function plannedDrawFromLot(lots: readonly AppliedCreditLot[], appliedCents: number, memberCreditId: string): number {
  let before = 0;
  for (const lot of lots) {
    if (lot.memberCreditId === memberCreditId) return Math.min(lot.remainingCents, Math.max(0, appliedCents - before));
    before += lot.remainingCents;
  }
  return 0;
}

// ---------------------------------------------------------------------------
// A retry keeps the slices it committed (INV-PAY-127, #4013)
// ---------------------------------------------------------------------------

/** A slice this booking already committed: one lot, its note, its cents. */
export interface CommittedAppliedCreditSlice {
  memberCreditId: string;
  xeroCreditNoteId: string;
  amountCents: number;
}

/** The re-plan would move money a committed slice already holds. */
export class AppliedCreditReplanDivergedError extends Error {
  override readonly name = "AppliedCreditReplanDivergedError";
}

/**
 * Refuse a plan that does not keep every slice this booking already committed.
 *
 * The engine commits its join rows, then calls Xero outside the transaction; a
 * retry re-plans the WHOLE applied amount (its own rows excluded) and upserts
 * on `(lot, booking)` with nothing to update. That is idempotent only if the
 * re-plan reproduces the committed slices. Under `CREDIT_LOT_USE_ORDER` it
 * does; a slice committed under another order — `createdAt` alone, before
 * #4013, across the deploy — may not, and upserting the new plan would then
 * leave the old row orphaned or credit the invoice twice. So a committed slice
 * whose lot is missing from the plan, or planned at another figure or on
 * another note, stops the run before anything is written: the operation fails
 * where an officer sees it, and nothing is allocated twice.
 *
 * A slice on a minted remainder note is compared by lot and amount only: the
 * plan does not know the minted note's id.
 */
export function assertPlanKeepsCommittedSlices(
  bookingId: string,
  committed: readonly CommittedAppliedCreditSlice[],
  plan: AppliedCreditPlan,
  format: ClubFormat,
): void {
  const planned = new Map<string, { amountCents: number; xeroCreditNoteId: string | null }>();
  for (const na of plan.noteAllocations) planned.set(na.memberCreditId, na);
  for (const ms of plan.mintSlices) planned.set(ms.memberCreditId, { amountCents: ms.amountCents, xeroCreditNoteId: null });
  const diverged = committed.filter((slice) => {
    const match = planned.get(slice.memberCreditId);
    return !match || match.amountCents !== slice.amountCents ||
      (match.xeroCreditNoteId !== null && match.xeroCreditNoteId !== slice.xeroCreditNoteId);
  });
  if (diverged.length === 0) return;
  const described = diverged
    .map((slice) => `${formatCents(slice.amountCents, format)} on credit ${slice.memberCreditId}`)
    .join(", ");
  throw new AppliedCreditReplanDivergedError(
    `Booking ${bookingId}'s applied-credit allocation stopped: its retry would not keep the slice(s) already committed (${described}), so nothing was allocated or recorded. Check the booking's credit notes in Xero against its allocation rows. If a credit was handed back since, retry once that hand-back has gone through; if they genuinely disagree, resolve the operation in Xero rather than retrying (INV-PAY-127).`,
  );
}

// ---------------------------------------------------------------------------
// Ledger reads
// ---------------------------------------------------------------------------
