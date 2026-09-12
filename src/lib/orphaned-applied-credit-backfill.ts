// One-off, idempotent, local-only backfill for account credit that a member
// applied to a booking (a negative BOOKING_APPLIED MemberCredit row) but which
// was never reversed when the booking was cancelled — the pre-#1547 defect:
// applying credit, abandoning payment, then cancelling left the negative row on
// the ledger, so the member permanently lost that credit (#1547).
//
// Detection (per CANCELLED booking, conservative — never over-restores):
//   status === CANCELLED
//     ∧ ∃ MemberCredit(type=BOOKING_APPLIED, appliedToBookingId=booking)
//     ∧ ¬∃ MemberCredit(type=CANCELLATION_REFUND, sourceBookingId=booking)
//     ∧ (no payment ∨ (¬paymentHasCaptureEvidence(payment)
//                       ∧ payment.status ≠ SUCCEEDED))
// The ¬CANCELLATION_REFUND clause excludes healthy restores AND held-as-credit
// cancels. The capture clause excludes the legitimately-unrestored captured
// shapes — 0%-tier paid cancels (restore amount 0 writes NO row) and
// held-credit refunds. The SUCCEEDED clause excludes settlement WITHOUT cash:
// a fully-credit-covered booking gets a $0 SUCCEEDED payment with no
// transaction ledger rows (booking-create), takes the PAID path, and a
// 0%-tier / fee-swallowed cancel legitimately retains the whole credit slice —
// healing it would hand back policy-retained credit.
// Soft-deleted bookings are included: the ledger rows survive soft-delete and
// the credit is still lost.
//
// KNOWN FALSE NEGATIVE (conservative by design): a pre-#1547 orphan whose
// CANCELLED booking later received late cash is skipped — the inbound
// invoice-paid effects mint a CANCELLATION_REFUND row ("Internet Banking
// payment credit for cancelled booking …", invoice-paid-effects.ts) that
// compensates the CASH, not the applied credit, and this predicate cannot
// structurally tell it from a restore row. Preferring a missed heal over a
// double-restore is deliberate; such bookings need manual review.
//
// Pure local DB repair: no Xero, Stripe, SES, or Sentry calls; money stays in
// integer cents. Every heal restores 100% of the applied credit (ledger truth),
// matching the never-captured cancel path.
import {
  BookingEventType,
  BookingStatus,
  CreditType,
  PaymentStatus,
  Prisma,
} from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { createAuditLog } from "@/lib/audit";
import { recordBookingEvent } from "@/lib/booking-events";
import {
  lockMemberCreditLedger,
  restoreCreditFromBooking,
} from "@/lib/member-credit";
import { calculateRestoredCreditAmount } from "@/lib/policies/member-credit";
import { paymentHasCaptureEvidence } from "@/lib/cancel-flattened-payment-backfill";
import { formatCents } from "@/lib/utils";

// The full client, not a nested TransactionClient: the heal path opens its own
// per-booking $transaction, so it must not run inside another one.
type BackfillStore = typeof prisma;

export interface OrphanedAppliedCreditFinding {
  bookingId: string;
  memberId: string;
  appliedCreditCents: number; // positive SIGNED net of BOOKING_APPLIED rows (post-clamp, #1887 F2)
  appliedRowCount: number;
  paymentId: string | null;
  paymentSource: string | null;
  paymentStatus: string | null;
  bookingDeletedAt: string | null;
}

// Full FlattenedCandidatePayment shape so paymentHasCaptureEvidence type-checks.
const CANDIDATE_BOOKING_SELECT = {
  id: true,
  memberId: true,
  status: true,
  deletedAt: true,
  creditsApplied: {
    where: { type: CreditType.BOOKING_APPLIED },
    select: { amountCents: true },
  },
  creditsFromCancellation: {
    where: { type: CreditType.CANCELLATION_REFUND },
    select: { id: true },
  },
  payment: {
    select: {
      id: true,
      bookingId: true,
      source: true,
      status: true,
      amountCents: true,
      refundedAmountCents: true,
      transactions: {
        select: { status: true },
      },
    },
  },
} satisfies Prisma.BookingSelect;

type CandidateBooking = Prisma.BookingGetPayload<{
  select: typeof CANDIDATE_BOOKING_SELECT;
}>;

/**
 * The detection predicate, self-contained (re-checks status too) so it is safe
 * to run both in the scan and — critically — in the under-lock re-check that
 * makes the heal idempotent. Returns a finding, or null when the booking is not
 * an orphan under this exact predicate.
 */
export function deriveOrphanedAppliedCreditFinding(
  booking: CandidateBooking
): OrphanedAppliedCreditFinding | null {
  if (booking.status !== BookingStatus.CANCELLED) {
    return null;
  }
  if (booking.creditsApplied.length === 0) {
    return null;
  }
  // A CANCELLATION_REFUND row referencing this booking means the applied credit
  // was already restored (healthy) or the cancel held the payment as credit —
  // neither is an orphan.
  if (booking.creditsFromCancellation.length > 0) {
    return null;
  }
  // Captured money is the legitimately-unrestored captured shapes (0%-tier
  // paid cancel writes no restore row; held-credit refund keeps the applied
  // rows).
  if (booking.payment && paymentHasCaptureEvidence(booking.payment)) {
    return null;
  }
  // A SUCCEEDED aggregate is settlement even with no cash ledger rows: the
  // fully-credit-covered $0 payment (booking-create) settles the booking as
  // PAID, so its cancel took the paid path — a 0%-tier / fee-swallowed restore
  // of 0 there is the cancellation policy retaining the credit, not an orphan.
  if (booking.payment && booking.payment.status === PaymentStatus.SUCCEEDED) {
    return null;
  }

  // 100% restore mirrors restoreCreditFromBooking with no override: the SIGNED
  // net of the BOOKING_APPLIED rows (calculateRestoredCreditAmount), NOT
  // Σ|amountCents|. An F20 (#1887) clamp offset makes a row positive, so the
  // abs-sum would over-report (and over-heal) by 2×excess; the net is the credit
  // that is actually still applied and unrestored.
  const appliedCreditCents = calculateRestoredCreditAmount(booking.creditsApplied);
  if (appliedCreditCents <= 0) {
    return null;
  }

  return {
    bookingId: booking.id,
    memberId: booking.memberId,
    appliedCreditCents,
    appliedRowCount: booking.creditsApplied.length,
    paymentId: booking.payment?.id ?? null,
    paymentSource: booking.payment?.source ?? null,
    paymentStatus: booking.payment?.status ?? null,
    bookingDeletedAt: booking.deletedAt ? booking.deletedAt.toISOString() : null,
  };
}

/**
 * Scan (read-only) for CANCELLED bookings whose applied account credit was
 * never restored. Cursor-paginates so a large history never loads at once.
 * `scanned` counts candidates examined.
 */
export async function findOrphanedAppliedCredits(options?: {
  store?: BackfillStore;
  batchSize?: number;
}): Promise<{ scanned: number; findings: OrphanedAppliedCreditFinding[] }> {
  const store = options?.store ?? prisma;
  const batchSize = options?.batchSize ?? 500;
  const findings: OrphanedAppliedCreditFinding[] = [];
  let scanned = 0;
  let cursor: string | undefined;

  for (;;) {
    const page = await store.booking.findMany({
      // No deletedAt filter — soft-deleted orphans still hold lost credit.
      where: {
        status: BookingStatus.CANCELLED,
        creditsApplied: { some: { type: CreditType.BOOKING_APPLIED } },
      },
      select: CANDIDATE_BOOKING_SELECT,
      orderBy: { id: "asc" },
      take: batchSize,
      ...(cursor ? { skip: 1, cursor: { id: cursor } } : {}),
    });

    if (page.length === 0) {
      break;
    }

    for (const booking of page) {
      scanned += 1;
      const finding = deriveOrphanedAppliedCreditFinding(booking);
      if (finding) {
        findings.push(finding);
      }
    }

    if (page.length < batchSize) {
      break;
    }
    cursor = page[page.length - 1]!.id;
  }

  return { scanned, findings };
}

export interface OrphanedAppliedCreditHealResult {
  scanned: number;
  findings: OrphanedAppliedCreditFinding[];
  healed: Array<{ bookingId: string; memberId: string; restoredCents: number }>;
  skipped: Array<{ bookingId: string; reason: string }>;
}

/**
 * Restore each orphaned applied credit, one per transaction. Per booking:
 * lock the member's credit ledger, RE-CHECK the full predicate under the lock
 * (a concurrent second run or a cancel-retry that already restored is found
 * here and skipped — restoreCreditFromBooking has NO internal replay guard, so
 * this re-check IS the idempotency mechanism), restore 100%, and write a
 * critical finance audit row atomically. The CREDITED booking event is written
 * AFTER the tx commits (booking-events must not sit inside the transition tx).
 */
export async function healOrphanedAppliedCredits(options?: {
  store?: BackfillStore;
}): Promise<OrphanedAppliedCreditHealResult> {
  const store = options?.store ?? prisma;
  const { scanned, findings } = await findOrphanedAppliedCredits({ store });
  const healed: OrphanedAppliedCreditHealResult["healed"] = [];
  const skipped: OrphanedAppliedCreditHealResult["skipped"] = [];

  for (const finding of findings) {
    const outcome = await store.$transaction(async (tx) => {
      await lockMemberCreditLedger(finding.memberId, tx);

      const fresh = await tx.booking.findUnique({
        where: { id: finding.bookingId },
        select: CANDIDATE_BOOKING_SELECT,
      });
      const recheck = fresh ? deriveOrphanedAppliedCreditFinding(fresh) : null;
      if (!recheck) {
        return {
          healed: false as const,
          reason:
            "No longer orphaned under lock (already restored or predicate changed)",
        };
      }

      const restoredCents = await restoreCreditFromBooking(
        finding.memberId,
        finding.bookingId,
        tx
      );
      if (restoredCents <= 0) {
        return {
          healed: false as const,
          reason: "Restore wrote nothing under lock (no applied credit)",
        };
      }

      await createAuditLog(
        {
          action: "member.credit.orphan-restore.backfill",
          // No session actor — this is a backfill script. The column is
          // nullable; the subject is the member whose credit was restored.
          memberId: null,
          subjectMemberId: finding.memberId,
          targetId: finding.bookingId,
          entityType: "Booking",
          entityId: finding.bookingId,
          // "payment" is the repo's named money category — the admin audit-log
          // category filter is a fixed list, so a novel category would make
          // these critical rows unfilterable.
          category: "payment",
          severity: "critical",
          outcome: "success",
          summary: "Orphaned applied credit restored by backfill",
          // The club's configured currency, through the one formatter (#3325).
          details: `Restored ${formatCents(restoredCents)} of applied account credit orphaned by a pre-#1547 cancellation`,
          metadata: { restoredCents, appliedRowCount: recheck.appliedRowCount },
        },
        tx
      );

      return { healed: true as const, restoredCents };
    });

    if (outcome.healed) {
      healed.push({
        bookingId: finding.bookingId,
        memberId: finding.memberId,
        restoredCents: outcome.restoredCents,
      });
      await recordBookingEvent({
        bookingId: finding.bookingId,
        type: BookingEventType.CREDITED,
        amountCents: outcome.restoredCents,
        reason:
          "Previously applied account credit restored by the orphaned-credit backfill.",
      });
    } else {
      skipped.push({ bookingId: finding.bookingId, reason: outcome.reason });
    }
  }

  return { scanned, findings, healed, skipped };
}

/**
 * Format a scan or heal result for the operator report, mirroring
 * formatFlattenedCancelPaymentReport.
 */
export function formatOrphanedAppliedCreditReport(
  result: {
    scanned: number;
    findings: OrphanedAppliedCreditFinding[];
    healed?: OrphanedAppliedCreditHealResult["healed"];
    skipped?: OrphanedAppliedCreditHealResult["skipped"];
  },
  mode: "dry-run" | "apply"
): string {
  const lines: string[] = [];
  lines.push(
    `Orphaned applied-credit backfill (${mode}) — scanned ${result.scanned} cancelled booking(s) with applied credit.`
  );

  if (result.findings.length === 0) {
    lines.push("No orphaned applied credit found; nothing to restore.");
    return lines.join("\n");
  }

  lines.push(
    `Found ${result.findings.length} orphaned booking(s) holding unreleased applied credit:`
  );
  for (const finding of result.findings) {
    lines.push(
      `  booking=${finding.bookingId} member=${finding.memberId} ` +
        `appliedCreditCents=${finding.appliedCreditCents} rows=${finding.appliedRowCount} ` +
        `payment=${finding.paymentId ?? "none"} ` +
        `(source=${finding.paymentSource ?? "none"}, status=${finding.paymentStatus ?? "none"}) ` +
        `deletedAt=${finding.bookingDeletedAt ?? "null"}`
    );
  }

  if (mode === "apply") {
    lines.push(`Restored ${result.healed?.length ?? 0} booking(s).`);
    if (result.skipped && result.skipped.length > 0) {
      lines.push(`Skipped ${result.skipped.length} booking(s):`);
      for (const skip of result.skipped) {
        lines.push(`  booking=${skip.bookingId} reason=${skip.reason}`);
      }
    }
  } else {
    lines.push(
      "Dry run: no changes written. Re-run with --apply to restore."
    );
  }

  return lines.join("\n");
}
