/**
 * Browser-side half of #3232's linked-move offer.
 *
 * Keep this module free of Prisma, Node crypto and server-only imports, exactly
 * as its `hosting-coverage-override-client.ts` sibling is. The server owns both
 * digests; the browser only validates the typed 409 and returns the opaque
 * versioned correlator belonging to the arm the member chose.
 *
 * FAIL CLOSED, and here that means "show no offer" rather than "show a partial
 * one". A half-read prompt would put a price in front of a member that the server
 * never quoted, or a Move-both button whose state key is missing — which the
 * server would reject as stale, leaving them clicking a button that cannot work.
 * Every field the offer needs is therefore required, and anything short of the
 * complete body reads as no offer at all, which falls back to the plain refusal
 * sentence the panel already renders.
 */

export interface HostingCoverageLinkedMoveBooking {
  bookingId: string;
  reference: string;
  lodgeName: string;
  uncoveredNights: string[];
  currentCheckIn: string;
  currentCheckOut: string;
  proposedCheckIn: string;
  proposedCheckOut: string;
  priceDiffCents: number;
  changeFeeCents: number;
}

export interface HostingCoverageLinkedMovePromptData {
  message: string;
  /** The key `MOVE_BOTH` must return; bound to the moves AND the money. */
  acceptStateKey: string;
  /** The key `LEAVE_UNCOVERED` must return; bound to the stranded set alone. */
  declineStateKey: string;
  /** False when there are not beds for both — the owner's "cannot" arm. */
  linkedMoveAvailable: boolean;
  linkedBookings: HostingCoverageLinkedMoveBooking[];
  combinedAmountDueCents: number;
  combinedRefundCents: number;
  combinedChangeFeeCents: number;
  settlementMethodRequired: boolean;
  bothChangeFeesCharged: boolean;
}

export type HostingCoverageLinkedMoveChoice = "MOVE_BOTH" | "LEAVE_UNCOVERED";

const STATE_KEY_PATTERN = /^v1:[0-9a-f]{64}$/;
const LODGE_NIGHT_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

function isLodgeNight(value: unknown): value is string {
  return typeof value === "string" && LODGE_NIGHT_PATTERN.test(value);
}

/**
 * Integer cents, and nothing else.
 *
 * A non-integer amount here would be a server defect, but rendering one would put
 * a fractional cent in front of a member, so it fails the whole read instead.
 */
function isCents(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value);
}

function readBooking(value: unknown): HostingCoverageLinkedMoveBooking | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const row = value as Record<string, unknown>;
  if (
    typeof row.bookingId !== "string" ||
    row.bookingId.length === 0 ||
    typeof row.reference !== "string" ||
    row.reference.trim().length === 0 ||
    typeof row.lodgeName !== "string" ||
    row.lodgeName.trim().length === 0 ||
    !Array.isArray(row.uncoveredNights) ||
    row.uncoveredNights.length === 0 ||
    !row.uncoveredNights.every(isLodgeNight) ||
    !isLodgeNight(row.currentCheckIn) ||
    !isLodgeNight(row.currentCheckOut) ||
    !isLodgeNight(row.proposedCheckIn) ||
    !isLodgeNight(row.proposedCheckOut) ||
    !isCents(row.priceDiffCents) ||
    !isCents(row.changeFeeCents)
  ) {
    return null;
  }
  return {
    bookingId: row.bookingId,
    reference: row.reference,
    lodgeName: row.lodgeName,
    uncoveredNights: row.uncoveredNights as string[],
    currentCheckIn: row.currentCheckIn,
    currentCheckOut: row.currentCheckOut,
    proposedCheckIn: row.proposedCheckIn,
    proposedCheckOut: row.proposedCheckOut,
    priceDiffCents: row.priceDiffCents,
    changeFeeCents: row.changeFeeCents,
  };
}

/** Fail closed unless the complete typed 409 body is present. */
export function readHostingCoverageLinkedMovePrompt(
  value: unknown,
): HostingCoverageLinkedMovePromptData | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if (
    record.code !== "SAME_OWNER_COVERAGE_LINKED_MOVE_REQUIRED" ||
    record.requiresLinkedMoveChoice !== true ||
    typeof record.error !== "string" ||
    record.error.trim().length === 0 ||
    typeof record.acceptStateKey !== "string" ||
    !STATE_KEY_PATTERN.test(record.acceptStateKey) ||
    typeof record.declineStateKey !== "string" ||
    !STATE_KEY_PATTERN.test(record.declineStateKey) ||
    typeof record.linkedMoveAvailable !== "boolean" ||
    typeof record.settlementMethodRequired !== "boolean" ||
    typeof record.bothChangeFeesCharged !== "boolean" ||
    !isCents(record.combinedAmountDueCents) ||
    !isCents(record.combinedRefundCents) ||
    !isCents(record.combinedChangeFeeCents) ||
    !Array.isArray(record.linkedBookings) ||
    record.linkedBookings.length === 0
  ) {
    return null;
  }

  const linkedBookings: HostingCoverageLinkedMoveBooking[] = [];
  for (const candidate of record.linkedBookings) {
    const row = readBooking(candidate);
    if (!row) return null;
    linkedBookings.push(row);
  }

  return {
    message: record.error,
    acceptStateKey: record.acceptStateKey,
    declineStateKey: record.declineStateKey,
    linkedMoveAvailable: record.linkedMoveAvailable,
    linkedBookings,
    combinedAmountDueCents: record.combinedAmountDueCents,
    combinedRefundCents: record.combinedRefundCents,
    combinedChangeFeeCents: record.combinedChangeFeeCents,
    settlementMethodRequired: record.settlementMethodRequired,
    bothChangeFeesCharged: record.bothChangeFeesCharged,
  };
}

/**
 * The answer to put on the retry, for the arm the member chose.
 *
 * THE ARM DECIDES WHICH KEY TRAVELS, and getting that wrong is not a cosmetic
 * error: the server checks the key against a different derivation per arm, so the
 * other arm's key simply does not match and the member is re-prompted. One
 * function so no surface has to remember which is which.
 *
 * Returns `null` for `MOVE_BOTH` when the offer is not available, because there is
 * no such answer to give — a client that sent one anyway would be answering an
 * offer the server did not make.
 */
export function hostingCoverageLinkedMoveAnswer(
  prompt: HostingCoverageLinkedMovePromptData,
  choice: HostingCoverageLinkedMoveChoice,
): { choice: HostingCoverageLinkedMoveChoice; acknowledged: true; stateKey: string } | null {
  if (choice === "MOVE_BOTH") {
    if (!prompt.linkedMoveAvailable) return null;
    return { choice, acknowledged: true, stateKey: prompt.acceptStateKey };
  }
  return { choice, acknowledged: true, stateKey: prompt.declineStateKey };
}
