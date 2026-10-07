/**
 * THE CUT-OVER GATE: DOES EVERY BOOKING'S LEDGER AGREE WITH ITS MONEY COLUMNS?
 * (#3583, `INV-MONEY-037`; design `docs/design/booking-ledger.md` §6, §7.)
 *
 * Until the reads move (#3584), `Booking.finalPriceCents` and the five
 * `Payment` money columns are PROJECTIONS of the booking ledger. This module
 * states the seven identities that say so and judges one booking against them,
 * from a snapshot row it is handed. It reads nothing and writes nothing; the
 * one-snapshot read is `booking-ledger-projection-census-store.ts`, the
 * operator command `scripts/booking-ledger-census.ts`.
 *
 * Every identity is `column == ledger figure`, and every disagreement is
 * reported with both figures and `delta = column − ledger`. A difference the
 * design expects is NAMED, never silenced: it is classified only when the
 * named components (`booking-ledger-projection-census-classes.ts`) add up to
 * the delta to the cent. Nothing here repairs anything.
 *
 * Not to be confused with #3340's census (`additional-payment-ask.ts`,
 * `payments:audit-booking-ledger`), which checks `INV-PAY-047`'s mirror
 * columns against each other, not against ledger lines.
 */
import type { LedgerAnchorKind } from "@prisma/client";

import { isSingleNightLine } from "@/lib/booking-ledger-charge-line";
import { bookingLedgerBalance } from "@/lib/booking-ledger-balance";
import { liveLines } from "@/lib/booking-ledger-modification-posting";
import {
  agreedAdjustmentKey,
  agreedGiveBackKey,
  captureKey,
  cancellationFeeKey,
  confirmationNightKey,
  confirmationPromotionKey,
  creditKey,
  handBackKey,
  modificationChangeFeeKey,
  modificationNightKey,
  modificationPromotionKey,
  refundKey,
  reversalKey,
} from "@/lib/booking-ledger-posting-keys";
import { bookingLedgerResidualCents, outstandingAdditionalAskCents } from "@/lib/additional-payment-ask";
import { isCapturedPaymentStatus } from "@/lib/booking-payment-state";
import { isPaidLikeBookingStatus } from "@/lib/booking-status";
import { calendarDateOfDateOnlyInstant } from "@/lib/club-time";
import { compareOrdinal } from "@/lib/ordinal-order";
import type { InternetBankingSettlementEvidence } from "@/lib/internet-banking-settlement-evidence";
import {
  isCapturedTransactionStatus,
  isRecordedRefundStatus,
  latestTransactionOfKind,
} from "@/lib/payment-transaction-status";
import {
  CAPTURE_KINDS,
  additionalComponents,
  cancelledOwedComponents,
  capturedComponents,
  changeFeeComponents,
  creditAppliedComponents,
  explainResidual,
  ibSettlementEvidence,
  isCoverageName,
  isGroupSettlementOffLedger,
  liveOwedComponents,
  nonAllocatingIssuedCents,
  refundedComponents,
  retainedChargeShareCents,
  sumKinds,
  unallocatedAppliedCreditCents,
  unpostedCredits,
  unpostedSettlements,
  type BookingLedgerCensusClass,
  type BookingLedgerCoverageKind,
  type ResidualComponent,
} from "@/lib/booking-ledger-projection-census-classes";
import type { BookingLedgerCensusRow, CensusLedgerLine } from "@/lib/booking-ledger-projection-census-row";
import { reviewAdjustmentEvidence, type ReviewAdjustmentEvidence } from "@/lib/booking-ledger-projection-census-review-adjustments";

/**
 * The six identities of design §6, identity 1 in its corrected §5.3 form, and
 * a seventh that closes what the six leave between them: a live booking's
 * `owed(b)` against what its columns say is owed (`INV-PAY-047`'s residual plus
 * the ask). Without it a line no column projects — a `CREDIT_ISSUED` or
 * `BANK_REFUND` — could be missing, or wrong, with every column agreeing.
 */
export const BOOKING_LEDGER_IDENTITIES = [
  "PRICE",
  "CAPTURED",
  "CREDIT_APPLIED",
  "REFUNDED",
  "CHANGE_FEE",
  "ADDITIONAL",
  "OWED",
] as const;
export type BookingLedgerIdentity = (typeof BOOKING_LEDGER_IDENTITIES)[number];

export type BookingLedgerIdentityStatus = "NOT_APPLICABLE" | "AGREE" | "DISAGREE" | "CLASSIFIED" | "COVERAGE";

export type BookingLedgerIdentityResult = {
  identity: BookingLedgerIdentity;
  status: BookingLedgerIdentityStatus;
  /** The column's figure (for a cancelled booking's PRICE, the zero `owed(b)` should be). */
  columnCents: number;
  ledgerCents: number;
  /** `columnCents − ledgerCents`. */
  deltaCents: number;
  /** The components that explain the delta exactly, when status is CLASSIFIED or COVERAGE. */
  explainedBy: ResidualComponent[];
};

export const BOOKING_LEDGER_INTEGRITY_KINDS = [
  "REVERSAL_TARGET_MISSING",
  "REVERSAL_NOT_OPPOSITE",
  "DUPLICATE_LIVE_NIGHT",
  "UNKNOWN_KEY_NAMESPACE",
  "KEY_ANCHOR_MISMATCH",
  "SOURCE_DRIFT",
] as const;
export type BookingLedgerIntegrityKind = (typeof BOOKING_LEDGER_INTEGRITY_KINDS)[number];

export type BookingLedgerIntegrityFinding = {
  bookingId: string;
  lineId: string;
  kind: BookingLedgerIntegrityKind;
  detail: string;
};

export type BookingLedgerEvaluation = {
  bookingId: string;
  lineCount: number;
  identities: BookingLedgerIdentityResult[];
  /** Coverage gaps, the booking-level ones and those an identity's delta is made of. */
  coverage: BookingLedgerCoverageKind[];
  /** A booking-level class (today only `GROUP_SETTLEMENT_OFF_LEDGER`). */
  bookingClass: BookingLedgerCensusClass | null;
  /**
   * Booking-level class instances that carry figures, each acknowledged to the
   * cent: today only `AMBIGUOUS_REVIEW_GIVE_BACK` (#3791's give-back rows the
   * census cannot attribute to their tasks).
   */
  bookingInstances: ResidualComponent[];
  integrity: BookingLedgerIntegrityFinding[];
  /** Informational figures that are not identities and never decide the gate. */
  info: {
    unkeyedLines: number;
    /** `RETAINED_COLLECTED`: a retained CHARGE share since collected, `owed(b) = −share`. */
    retainedCollectedCents: number;
    /**
     * #1620 (decision C): applied credit on a live internet-banking payment no
     * Xero note allocates, with whether its invoice is proven paid (#3632).
     */
    ibUnallocatedAppliedCredit: { evidence: InternetBankingSettlementEvidence; cents: number } | null;
  };
};

const CHARGE_PRICE_KINDS = ["GUEST_NIGHT", "PROMOTION", "GROUP_DISCOUNT"] as const;

/**
 * Every namespace a posting key can carry — read off the key builders
 * themselves, so a builder's spelling is never restated here (`INV-MONEY-033`,
 * `INV-SSOT`) — paired with the anchor kinds the posters put a line under that
 * key on (design §5). A reversal is anchored on the event that takes the line
 * back; a credit line on its row, or on the cancellation for a restore.
 */
const KEY_NAMESPACE_ANCHORS: ReadonlyMap<string, ReadonlySet<LedgerAnchorKind>> = (() => {
  const pairs: Array<[string, LedgerAnchorKind[]]> = [
    [confirmationNightKey("b", "g", new Date(0)), ["CONFIRMATION"]],
    [confirmationPromotionKey("b"), ["CONFIRMATION"]],
    [modificationNightKey("m", "g", new Date(0)), ["MODIFICATION"]],
    [modificationPromotionKey("m"), ["MODIFICATION"]],
    [modificationChangeFeeKey("m"), ["MODIFICATION"]],
    [cancellationFeeKey("b"), ["CANCELLATION"]],
    [agreedAdjustmentKey("t"), ["REVIEW_TASK"]],
    [agreedGiveBackKey("t"), ["REVIEW_TASK"]],
    [reversalKey("l"), ["MODIFICATION", "CANCELLATION", "REVIEW_TASK", "PAYMENT_TRANSACTION", "PAYMENT_REFUND"]],
    [captureKey("t"), ["PAYMENT_TRANSACTION"]],
    [refundKey("r"), ["PAYMENT_REFUND"]],
    [creditKey("c"), ["MEMBER_CREDIT", "CANCELLATION"]],
    [handBackKey("t"), ["REVIEW_TASK"]],
  ];
  const map = new Map<string, Set<LedgerAnchorKind>>();
  for (const [key, anchors] of pairs) {
    const namespace = keyNamespace(key);
    map.set(namespace, new Set([...(map.get(namespace) ?? []), ...anchors]));
  }
  return map;
})();

function keyNamespace(postingKey: string): string {
  return postingKey.split(":")[0] ?? "";
}

function result(
  identity: BookingLedgerIdentity,
  columnCents: number,
  ledgerCents: number,
  alternatives: ReadonlyArray<readonly ResidualComponent[]>,
): BookingLedgerIdentityResult {
  const deltaCents = columnCents - ledgerCents;
  if (deltaCents === 0) return { identity, status: "AGREE", columnCents, ledgerCents, deltaCents, explainedBy: [] };
  const explainedBy = explainResidual(deltaCents, alternatives);
  if (!explainedBy) return { identity, status: "DISAGREE", columnCents, ledgerCents, deltaCents, explainedBy: [] };
  const status = explainedBy.some((component) => isCoverageName(component.name)) ? "COVERAGE" : "CLASSIFIED";
  return { identity, status, columnCents, ledgerCents, deltaCents, explainedBy };
}

function notApplicable(identity: BookingLedgerIdentity): BookingLedgerIdentityResult {
  return { identity, status: "NOT_APPLICABLE", columnCents: 0, ledgerCents: 0, deltaCents: 0, explainedBy: [] };
}

function coverageOnly(identity: BookingLedgerIdentity, kind: BookingLedgerCoverageKind): BookingLedgerIdentityResult {
  return { identity, status: "COVERAGE", columnCents: 0, ledgerCents: 0, deltaCents: 0, explainedBy: [{ name: kind, cents: 0 }] };
}

/** Money columns, or rows the posters would have posted from: what makes "no lines" a gap. */
function hasMoneyColumns(row: BookingLedgerCensusRow): boolean {
  const payment = row.payment;
  return (
    (isPaidLikeBookingStatus(row.booking.status) && row.booking.finalPriceCents !== 0) ||
    (payment !== null &&
      ((isCapturedPaymentStatus(payment.status) && payment.amountCents > 0) ||
        payment.creditAppliedCents !== 0 ||
        payment.refundedAmountCents !== 0 ||
        payment.changeFeeCents !== 0 ||
        outstandingAdditionalAskCents(payment) > 0)) ||
    row.transactions.some((txn) => isCapturedTransactionStatus(txn.status) && txn.amountCents > 0) ||
    row.refunds.some((refund) => isRecordedRefundStatus(refund.status) && refund.amountCents > 0) ||
    row.credits.some((credit) => credit.amountCents !== 0)
  );
}

/**
 * The edits made after a booking's confirmation on the ledger that no line is
 * anchored on, in the order they were made, split in two by ONE rule the census
 * and the back-post share (`INV-SSOT`; #3583's review, M1):
 *
 * - `awaiting`: no later edit has lines. Its movement is not on the ledger
 *   until something posts it — design §5.1's sum-or-nothing refusal, "logged for
 *   C4 to count" — so it is coverage.
 * - `carriedByLater`: a later edit has lines. Either the back-post re-derived
 *   every unposted edit's nights onto that later one (the night rows say only
 *   where the nights ended, never which edit moved which), and the ledger
 *   carries it; or a live edit posted past it, which never absorbs a refused
 *   edit's movement, and it is still missing. The identities try awaiting
 *   alone first, then awaiting and carried (`unpostedEdits`), so the first
 *   case agrees and the second is coverage — never a signable disagreement.
 */
export function postConfirmationEditsWithoutLines(
  modifications: ReadonlyArray<{ id: string; createdAt: Date }>,
  lines: ReadonlyArray<Pick<CensusLedgerLine, "anchorKind" | "anchorId" | "postedAt">>,
): { awaiting: string[]; carriedByLater: string[] } {
  const confirmations = lines.filter((line) => line.anchorKind === "CONFIRMATION");
  if (confirmations.length === 0) return { awaiting: [], carriedByLater: [] };
  const confirmedAt = Math.min(...confirmations.map((line) => line.postedAt.getTime()));
  const withLines = new Set(lines.filter((line) => line.anchorKind === "MODIFICATION").map((line) => line.anchorId));
  const ordered = [...modifications]
    .filter((modification) => modification.createdAt.getTime() > confirmedAt)
    .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime() || compareOrdinal(a.id, b.id));
  const lastWithLines = ordered.map((modification) => withLines.has(modification.id)).lastIndexOf(true);
  const awaiting: string[] = [];
  const carriedByLater: string[] = [];
  ordered.forEach((modification, index) => {
    if (withLines.has(modification.id)) return;
    (index < lastWithLines ? carriedByLater : awaiting).push(modification.id);
  });
  return { awaiting, carriedByLater };
}

/**
 * Edits awaiting a line (above), and change fees no line records — including
 * one charged before confirmation (#3611 V4). `withCarriedCents` adds the edits
 * a later edit passed: a live edit refuses unless the ledger already holds the
 * nights it removes and not the ones it adds, so one posting after a refused
 * edit never absorbs it — only the back-post or a closure's re-price folds it
 * in. The identities try awaiting alone first, then awaiting and carried, so a
 * gap either way is coverage, never a signable disagreement (#3583 delta, M-1).
 */
function unpostedEdits(row: BookingLedgerCensusRow): { priceCents: number; withCarriedCents: number; changeFeeCents: number } {
  const keys = new Set(row.lines.flatMap((line) => (line.postingKey ? [line.postingKey] : [])));
  const split = postConfirmationEditsWithoutLines(row.modifications, row.lines);
  const awaiting = new Set(split.awaiting);
  const carried = new Set(split.carriedByLater);
  let priceCents = 0;
  let carriedCents = 0;
  let changeFeeCents = 0;
  for (const modification of row.modifications) {
    if (awaiting.has(modification.id)) priceCents += modification.priceDiffCents;
    if (carried.has(modification.id)) carriedCents += modification.priceDiffCents;
    if (modification.changeFeeCents > 0 && !keys.has(modificationChangeFeeKey(modification.id))) {
      changeFeeCents += modification.changeFeeCents;
    }
  }
  return { priceCents, withCarriedCents: priceCents + carriedCents, changeFeeCents };
}

/** Judge one booking. Pure: the snapshot row in, the seven results, coverage and integrity out. */
export function evaluateBookingLedgerIdentities(row: BookingLedgerCensusRow): BookingLedgerEvaluation {
  const { booking, payment, lines } = row;
  const coverage = new Set<BookingLedgerCoverageKind>();
  const reviewAdjustments = reviewAdjustmentEvidence(row);
  const integrity = integrityFindings(row, reviewAdjustments);
  const ibUnallocatedAppliedCredit = ibUnallocatedApplied(row);
  const base = {
    bookingId: booking.id,
    lineCount: lines.length,
    integrity,
    info: { unkeyedLines: lines.filter((line) => line.postingKey === null).length, retainedCollectedCents: 0, ibUnallocatedAppliedCredit },
  };

  if (lines.length === 0) {
    const money = hasMoneyColumns(row);
    const offLedger = money && isGroupSettlementOffLedger(row);
    if (money && !offLedger) coverage.add("NO_LINES");
    if (unpostedCredits(row).length > 0) coverage.add("UNPOSTED_CREDIT");
    return {
      ...base,
      identities: BOOKING_LEDGER_IDENTITIES.map(notApplicable),
      coverage: [...coverage],
      bookingClass: offLedger ? "GROUP_SETTLEMENT_OFF_LEDGER" : null,
      bookingInstances: [],
    };
  }

  const balance = bookingLedgerBalance(lines);
  const cancelled = booking.status === "CANCELLED";
  const confirmed = lines.some((line) => line.anchorKind === "CONFIRMATION");
  const edits = unpostedEdits(row);
  const identities: BookingLedgerIdentityResult[] = [];

  // 1. PRICE. Live: finalPriceCents == Σ GUEST_NIGHT + PROMOTION + GROUP_DISCOUNT
  // + adjusted(b) (design §5.3; a change fee is not in the price), less the
  // agreed give-backs: a price below the strands', which finalPriceCents —
  // re-based from the strands — never carries (#3791). Cancelled: owed(b) == 0
  // once its refunds have posted (design §6, #3611).
  if (cancelled) {
    if (!confirmed && row.cancellation !== null) {
      coverage.add("NOT_CONFIRMED_ON_LEDGER");
      identities.push(coverageOnly("PRICE", "NOT_CONFIRMED_ON_LEDGER"));
    } else {
      identities.push(result("PRICE", 0, balance.owedCents, cancelledOwedComponents(row)));
    }
  } else if (!confirmed) {
    if (isPaidLikeBookingStatus(booking.status)) {
      coverage.add("NOT_CONFIRMED_ON_LEDGER");
      identities.push(coverageOnly("PRICE", "NOT_CONFIRMED_ON_LEDGER"));
    } else {
      identities.push(notApplicable("PRICE"));
    }
  } else {
    identities.push(
      result("PRICE", booking.finalPriceCents, sumKinds(lines, CHARGE_PRICE_KINDS) + balance.adjustedCents - reviewAdjustments.agreedGiveBackLineCents, [
        [{ name: "UNPOSTED_EDIT", cents: edits.priceCents }],
        [{ name: "UNPOSTED_EDIT", cents: edits.withCarriedCents }],
      ]),
    );
  }

  // 2–6 are about the payment's columns: a booking with no payment row reads
  // them as zero, so a line without a payment still disagrees.
  const column = <K extends "amountCents" | "creditAppliedCents" | "refundedAmountCents" | "changeFeeCents">(key: K) =>
    payment ? payment[key] : 0;
  const applies = (ledgerCents: number) => payment !== null || ledgerCents !== 0;

  // 2. CAPTURED: amountCents == Σ CARD_CAPTURE + BANK_RECEIPT + CASH_RECORDED.
  const captured = sumKinds(lines, CAPTURE_KINDS);
  identities.push(
    applies(captured)
      ? result("CAPTURED", column("amountCents"), captured, capturedComponents(row))
      : notApplicable("CAPTURED"),
  );

  // 3. CREDIT_APPLIED: creditAppliedCents == Σ CREDIT_APPLIED.
  const applied = sumKinds(lines, ["CREDIT_APPLIED"]);
  identities.push(
    applies(applied)
      ? result("CREDIT_APPLIED", column("creditAppliedCents"), applied, creditAppliedComponents(row))
      : notApplicable("CREDIT_APPLIED"),
  );

  // 4. REFUNDED: refundedAmountCents == −Σ CARD_REFUND, its residual classified.
  const cardRefunded = -sumKinds(lines, ["CARD_REFUND"]);
  identities.push(
    applies(cardRefunded)
      ? result("REFUNDED", column("refundedAmountCents"), cardRefunded, refundedComponents(row))
      : notApplicable("REFUNDED"),
  );

  // 5. CHANGE_FEE: changeFeeCents == Σ CHANGE_FEE.
  const fees = sumKinds(lines, ["CHANGE_FEE"]);
  identities.push(
    applies(fees)
      ? result("CHANGE_FEE", column("changeFeeCents"), fees, changeFeeComponents(row, edits.changeFeeCents))
      : notApplicable("CHANGE_FEE"),
  );

  // 6. ADDITIONAL: the uncollected ask == max(0, owed(b)) while the payment
  // carries a live ask, else 0. A cancelled booking's ask is dead (its columns
  // stay as they were), so PRICE's owed-is-zero form judges it instead.
  const latestAsk = latestTransactionOfKind(
    row.transactions.filter((txn) => txn.withdrawnAt === null),
    "ADDITIONAL",
  );
  const liveAsk = latestAsk !== null && !isCapturedTransactionStatus(latestAsk.status);
  identities.push(
    payment && !cancelled
      ? result(
          "ADDITIONAL",
          outstandingAdditionalAskCents(payment),
          liveAsk ? Math.max(0, balance.owedCents) : 0,
          additionalComponents(row, balance.owedCents, liveAsk),
        )
      : notApplicable("ADDITIONAL"),
  );

  // 7. OWED (live, confirmed on the ledger): owed(b) == what the columns say
  // is owed — `INV-PAY-047`'s residual plus the uncollected ask — plus issued
  // credit the refunded column never counted, less the agreed give-backs the
  // review give-back rows evidence (the residual counts a give-back as owed,
  // the price never having come down by it). Every line the ledger holds,
  // CREDIT_ISSUED and BANK_REFUND included, moves owed(b), so no line can be
  // missing or wrong here while the six above agree.
  if (!cancelled && confirmed) {
    const columnOwed =
      bookingLedgerResidualCents({
        finalPriceCents: booking.finalPriceCents,
        changeFeeCents: column("changeFeeCents"),
        amountCents: column("amountCents"),
        refundedAmountCents: column("refundedAmountCents"),
        creditAppliedCents: column("creditAppliedCents"),
        additionalAmountCents: payment?.additionalAmountCents ?? 0,
        additionalPaymentStatus: payment?.additionalPaymentStatus ?? null,
      }) +
      outstandingAdditionalAskCents(payment) +
      nonAllocatingIssuedCents(row) +
      reviewAdjustments.agreedGiveBackEvidenceCents;
    identities.push(result("OWED", columnOwed, balance.owedCents, liveOwedComponents(row, edits)));
  } else {
    identities.push(notApplicable("OWED"));
  }

  if (unpostedCredits(row).length > 0) coverage.add("UNPOSTED_CREDIT");
  if (unpostedSettlements(row).count > 0) coverage.add("UNPOSTED_SETTLEMENT");
  for (const identity of identities) {
    for (const component of identity.explainedBy) if (isCoverageName(component.name)) coverage.add(component.name);
  }
  const retained = cancelled ? 0 : retainedChargeShareCents(row);
  return {
    ...base,
    info: {
      ...base.info,
      retainedCollectedCents: retained > 0 && !liveAsk && balance.owedCents === -retained ? retained : 0,
    },
    identities,
    coverage: [...coverage],
    bookingClass: null,
    bookingInstances: ambiguousReviewGiveBack(reviewAdjustments),
  };
}

/** One instance per figure, so the acknowledgement goes stale if any of them moves. */
function ambiguousReviewGiveBack({ ambiguous }: ReviewAdjustmentEvidence): ResidualComponent[] {
  return (ambiguous ?? []).map(({ detail, cents }) => ({ name: "AMBIGUOUS_REVIEW_GIVE_BACK", cents, detail }));
}

/** #1620's figure, kept as information under the credit identity (orchestrator decision C). */
function ibUnallocatedApplied(row: BookingLedgerCensusRow): BookingLedgerEvaluation["info"]["ibUnallocatedAppliedCredit"] {
  const evidence = ibSettlementEvidence(row);
  if (evidence === null || row.booking.status === "CANCELLED") return null;
  const cents = unallocatedAppliedCreditCents(row);
  return cents > 0 ? { evidence, cents } : null;
}

// ---------------------------------------------------------------------------
// Integrity: what must hold of the lines themselves, whatever the columns say
// ---------------------------------------------------------------------------

function sameInstant(a: Date | null, b: Date | null): boolean {
  return (a?.getTime() ?? null) === (b?.getTime() ?? null);
}

function integrityFindings(row: BookingLedgerCensusRow, reviewAdjustments: ReviewAdjustmentEvidence): BookingLedgerIntegrityFinding[] {
  const bookingId = row.booking.id;
  const findings: BookingLedgerIntegrityFinding[] = [];
  const byId = new Map(row.lines.map((line) => [line.id, line]));
  const add = (line: CensusLedgerLine, kind: BookingLedgerIntegrityKind, detail: string) =>
    findings.push({ bookingId, lineId: line.id, kind, detail });

  for (const line of row.lines) {
    if (line.postingKey !== null) {
      const anchors = KEY_NAMESPACE_ANCHORS.get(keyNamespace(line.postingKey));
      if (!anchors) add(line, "UNKNOWN_KEY_NAMESPACE", `key ${line.postingKey}`);
      else if (!anchors.has(line.anchorKind)) add(line, "KEY_ANCHOR_MISMATCH", `key ${line.postingKey} on a ${line.anchorKind} anchor`);
    }
    if (line.reversesLineId === null) continue;
    const target = byId.get(line.reversesLineId);
    if (!target) {
      add(line, "REVERSAL_TARGET_MISSING", `reverses ${line.reversesLineId}, which this booking does not hold`);
      continue;
    }
    const opposite =
      target.kind === line.kind &&
      target.side === line.side &&
      target.sign === -line.sign &&
      target.quantity === line.quantity &&
      target.unitCents === line.unitCents &&
      target.settlementMethod === line.settlementMethod &&
      target.bookingGuestId === line.bookingGuestId &&
      sameInstant(target.nightStart, line.nightStart) &&
      sameInstant(target.nightEndExclusive, line.nightEndExclusive);
    if (!opposite) add(line, "REVERSAL_NOT_OPPOSITE", `does not exactly reverse ${target.id}`);
  }

  const live = liveLines(row.lines);
  const nights = new Map<string, CensusLedgerLine[]>();
  for (const line of live) {
    if (!isSingleNightLine(line)) continue;
    const key = `${line.bookingGuestId}|${calendarDateOfDateOnlyInstant(line.nightStart)}`;
    nights.set(key, [...(nights.get(key) ?? []), line]);
  }
  for (const [night, standing] of nights) {
    for (const line of standing.slice(1)) add(line, "DUPLICATE_LIVE_NIGHT", `a second live line for ${night}`);
  }

  for (const line of live) {
    const drift = sourceDrift(row, line, reviewAdjustments);
    if (drift) add(line, "SOURCE_DRIFT", drift);
  }
  return findings;
}

/**
 * Does the row a live line was posted from still say what the line says? A
 * line whose source is gone, no longer holds, or holds a different amount is
 * drift (`amountDrift` in the posters, "for C4 to count").
 */
function sourceDrift(row: BookingLedgerCensusRow, line: CensusLedgerLine, reviewAdjustments: ReviewAdjustmentEvidence): string | null {
  const bookingId = row.booking.id;
  switch (line.anchorKind) {
    case "CONFIRMATION":
      return line.anchorId === bookingId ? null : `confirmation anchor names booking ${line.anchorId}`;
    case "MODIFICATION":
      return row.modifications.some((modification) => modification.id === line.anchorId)
        ? null
        : `no modification ${line.anchorId} on this booking`;
    case "CANCELLATION": {
      if (row.booking.status !== "CANCELLED") return "a cancellation line on a booking that is not cancelled";
      if (line.kind === "CANCELLATION_FEE") {
        // The fee is the kept figure the CANCELLED event froze, less the
        // change fees that stayed charged (design §5.1).
        const keptCents = row.cancellation?.keptCents ?? null;
        if (keptCents === null) return null;
        const stayingFees = liveLines(row.lines).filter((candidate) => candidate.kind === "CHANGE_FEE").reduce((sum, fee) => sum + fee.amountCents, 0);
        return line.amountCents === keptCents - stayingFees ? null : `the CANCELLED event froze ${keptCents} kept, the fee line carries ${line.amountCents}`;
      }
      if (line.kind !== "CREDIT_ISSUED") return null;
      const restore = row.credits.find((credit) => credit.restoredFromBookingId === bookingId);
      if (!restore) return "a restore line with no restore row";
      return line.amountCents === -restore.amountCents ? null : `restore row holds ${restore.amountCents}, line ${line.amountCents}`;
    }
    case "PAYMENT_TRANSACTION": {
      const txn = row.transactions.find((candidate) => candidate.id === line.anchorId);
      if (!txn) return `no transaction ${line.anchorId} on this booking's payment`;
      if (!isCapturedTransactionStatus(txn.status) || txn.amountCents <= 0) return `transaction ${txn.id} is ${txn.status}, not captured`;
      return line.amountCents === txn.amountCents ? null : `transaction holds ${txn.amountCents}, line ${line.amountCents}`;
    }
    case "PAYMENT_REFUND": {
      const refund = row.refunds.find((candidate) => candidate.id === line.anchorId);
      if (!refund) return `no refund ${line.anchorId} on this booking's payment`;
      if (!isRecordedRefundStatus(refund.status) || refund.amountCents <= 0) return `refund ${refund.id} is ${refund.status}`;
      return line.amountCents === -refund.amountCents ? null : `refund holds ${refund.amountCents}, line ${line.amountCents}`;
    }
    case "MEMBER_CREDIT": {
      const credit = row.credits.find((candidate) => candidate.id === line.anchorId);
      if (!credit) return `no credit row ${line.anchorId} on this booking`;
      return line.amountCents === -credit.amountCents ? null : `credit row holds ${credit.amountCents}, line ${line.amountCents}`;
    }
    case "REVIEW_TASK": {
      const task = row.tasks.find((candidate) => candidate.id === line.anchorId);
      if (!task) return `no task ${line.anchorId} on this booking`;
      if (task.status !== "COMPLETED") return `task ${task.id} is ${task.status}`;
      const amount = task.amountCents ?? 0;
      // A hand-back is the share, or after a cancellation the capture's part
      // of what was still owed, which only its task's stand-in bears out (#3835).
      if (line.kind === "BANK_REFUND") {
        return line.amountCents === -amount || reviewAdjustments.nettedHandBackLineIds.has(line.id) ? null : `task holds ${amount}, line ${line.amountCents}`;
      }
      // What the closure credited, borne out by the booking's rows (#3791).
      if (line.kind === "AGREED_ADJUSTMENT") return reviewAdjustments.drift.get(line.id) ?? null;
      return null;
    }
  }
}
