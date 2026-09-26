import {
  BookingEventType,
  BookingStatus,
  PaymentSource,
  PaymentStatus,
} from "@prisma/client";
import { bookingOwner } from "@/lib/booking-owner";
import { createAuditLog } from "@/lib/audit";
import { settleHostingCoverageAfterCommit } from "@/lib/adult-member-hosting-coverage-drain";
import { reconcileHostingReviewForSystemCancellation } from "@/lib/adult-member-hosting-system-cancellation";
import { reconcileBedAllocationsForBookingWithLodgeLockHeld } from "@/lib/bed-allocation-lifecycle";
import { acquireLodgeCapacityLock } from "@/lib/capacity";
import { recordBookingEvent } from "@/lib/booking-events";
import { paymentHasCaptureEvidence } from "@/lib/cancel-flattened-payment-backfill";
import { sendBookingCancelledEmail } from "@/lib/email";
import logger from "@/lib/logger";
import {
  lockMemberCreditLedger,
  restoreCreditFromBooking,
} from "@/lib/member-credit";
import { revokePaymentLinksForBooking } from "@/lib/payment-link";
import { prisma } from "@/lib/prisma";
import { formatCents } from "@/lib/utils";
import {
  RELEASE_ADMIN_CAPACITY_HOLD_UPDATE,
  RELEASE_WHOLE_LODGE_HOLD_UPDATE,
} from "@/lib/booking-status";
import { processWaitlistForDates } from "@/lib/waitlist";
import {
  enqueueXeroModificationCreditNoteOperation,
  kickQueuedXeroOutboxOperationsIfConnected,
} from "@/lib/xero-operation-outbox";
import { repairLegacyAppliedCreditNoteAllocationsForBooking } from "@/lib/xero-applied-credit-allocation-repair";
import { findUnconvergedAppliedCreditDeallocation } from "@/lib/xero-applied-credit-operation-serialization";
import { clubFormatValues } from "@/lib/club-format-server";
import { unpaidInvoiceClearingAmountCents } from "@/lib/invoice-clearing-amount";

export interface InternetBankingHoldReleaseResult {
  scanned: number;
  released: number;
  skipped: number;
  failed: number;
  bookingIds: string[];
  paymentIds: string[];
}

function releaseOneHold(paymentId: string, now: Date) {
  return prisma.$transaction(
    async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(1)`;

      const fresh = await tx.payment.findUnique({
        where: { id: paymentId },
        include: {
          booking: {
            include: {
              member: true,
              // #3369: the owner may be an Organisation; bookingOwner() reads both.
              organisation: { select: { name: true, email: true } },
              guests: { include: { nights: true } },
            },
          },
        },
      });

      if (
        !fresh ||
        fresh.source !== PaymentSource.INTERNET_BANKING ||
        fresh.status !== PaymentStatus.PENDING ||
        !fresh.internetBankingHoldSlots ||
        fresh.internetBankingHoldReleasedAt ||
        !fresh.internetBankingHoldUntil ||
        fresh.internetBankingHoldUntil > now ||
        fresh.booking.status !== BookingStatus.CONFIRMED
      ) {
        return { type: "skipped" as const };
      }

      // Global booking/money first, then the per-member credit ledger (#1881).
      // Holding both through the transition prevents inbound Xero repair and
      // allocation/deallocation reconciliation from changing precise slices
      // between this guard, the local restore, and the clearing aggregate.
      await acquireLodgeCapacityLock(tx, fresh.booking.lodgeId);
      const creditLedgerMemberId = bookingOwner(fresh.booking).memberId;
      // #3369: the credit ledger is a MEMBER ledger and an organisation-owned
      // booking has none, so there is no key to take. Passing a null key would
      // either throw inside the helper or degenerate to a shared advisory key,
      // which is an `INV-LOCK` hazard that shows up only under concurrency.
      if (creditLedgerMemberId) {
        await lockMemberCreditLedger(creditLedgerMemberId, tx);
      }

      if (await findUnconvergedAppliedCreditDeallocation(fresh.id, tx)) {
        return {
          type: "skipped" as const,
          reason: "applied-credit-deallocation" as const,
        };
      }

      await tx.booking.update({
        where: { id: fresh.bookingId },
        data: {
          status: BookingStatus.CANCELLED,
          draftExpiresAt: null,
          ...RELEASE_ADMIN_CAPACITY_HOLD_UPDATE,
          // Best-effort field clearing (#177): this IB-expiry cron transition
          // has no per-booking audit context, so it mirrors the capacity-hold
          // sibling — clear the stale hold, no released audit.
          ...RELEASE_WHOLE_LODGE_HOLD_UPDATE,
        },
      });
      await tx.payment.update({
        where: { id: fresh.id },
        data: {
          status: PaymentStatus.FAILED,
          internetBankingHoldReleasedAt: now,
        },
      });
      await revokePaymentLinksForBooking(fresh.bookingId, tx);
      await reconcileBedAllocationsForBookingWithLodgeLockHeld({
        bookingId: fresh.bookingId,
        db: tx,
      });

      // #1547: a hold-expiry release IS a cancel, and an IB booking can be
      // partly (or fully) credit-covered — booking-create applies credit for
      // every IB shape. Restore it at 100% inside this claim, exactly like the
      // never-captured cancel branch: nothing was captured, so no
      // cancellation-policy tiering. restoreCreditFromBooking has no internal
      // replay guard; this transaction's guard set (payment still PENDING,
      // hold not yet released, booking still CONFIRMED) is its exactly-once
      // guarantee — re-runs skip released holds before reaching this line.
      // #3369: no member, no ledger, so nothing to restore. Zero is the fact.
      const restoreMemberId = bookingOwner(fresh.booking).memberId;
      const creditRestoredCents = restoreMemberId
        ? await restoreCreditFromBooking(restoreMemberId, fresh.bookingId, tx)
        : 0;

      // Size the invoice-clearing credit note like the never-captured cancel
      // path (#1547 / booking-cancel.ts), NOT the credit-reduced payment amount
      // (#1597). The booking invoice is raised at the FULL finalPriceCents
      // (createXeroInvoiceForBooking bills guest lines + promo, never the
      // effectivePriceCents the member still owes after credit), so
      // `fresh.amountCents` (= effectivePriceCents) under-clears the invoice by
      // exactly the applied credit and leaves that slice open forever. The true
      // outstanding is finalPrice + changeFee minus only the credit already
      // allocated to the invoice AS A XERO CREDIT NOTE (the
      // MemberCreditNoteAllocation slices). Locally-applied credit never reduced
      // the Xero invoice balance, so it is NOT subtracted here — the 100% local
      // restore above and this full-invoice clearing note do not double-count.
      // changeFeeCents is NOT always 0 on an unpaid hold: an edit with a change
      // fee increments it whether or not money was captured
      // (booking-modify-settlement.ts), and that fee is billed on the edit's
      // supplementary invoice, which the note also clears. The formula has one
      // home, `unpaidInvoiceClearingAmountCents` (INV-PAY-017).
      //
      // The cancel path gates on `xeroInvoiceId && !freshPaymentCaptured`
      // (booking-cancel.ts:820); mirror BOTH clauses.
      //
      // (1) Issued invoice (#1597 trace): the create-time hold-slots shape is
      // CONFIRMED, and booking-create only enqueues the invoice for a
      // PAYMENT_PENDING booking, so that shape reaches release with NO invoice
      // (`xeroInvoiceId` null). Enqueuing a note for it minted a
      // permanently-failing outbox op before #1597 — the worker had no invoice
      // to credit.
      //
      // (2) Never-captured payment: a clearing note is only ever right for money
      // that never settled. If ledger evidence shows the payment captured, its
      // invoice is normally already settled Xero-side, and in the failed-record
      // retry window a clearing note would close the invoice under the op-retry
      // stack and poison it (booking-cancel.ts's #1473 reasoning). The candidate
      // guards already require a PENDING payment, so this is inert for every
      // reachable candidate — but it completes the mirror and protects the
      // unprovable edge (a captured ledger row under a stale PENDING aggregate).
      // Reuse the exported capture discriminator (kept in lockstep with
      // booking-cancel's private copy) with one ledger read under the advisory
      // lock held above (line 33).
      //
      // Either clause failing skips the note entirely (nothing to clear).
      let xeroClearingAmountCents = 0;
      if (fresh.xeroInvoiceId) {
        const paymentTransactions = await tx.paymentTransaction.findMany({
          where: { paymentId: fresh.id },
          select: { status: true },
        });
        const freshPaymentCaptured = paymentHasCaptureEvidence({
          ...fresh,
          transactions: paymentTransactions,
        });
        if (!freshPaymentCaptured) {
          await repairLegacyAppliedCreditNoteAllocationsForBooking(
            fresh.bookingId,
            fresh.xeroInvoiceId,
            tx,
          );
          // Read Xero-allocated applied credit while both global lock(1) and
          // the per-member credit-ledger lock remain held, matching cancel.
          // Precise post-deallocation truth; the MemberCredit note stamp is a
          // coarse historical marker and cannot represent a partial target.
          const xeroAllocated = await tx.memberCreditNoteAllocation.aggregate({
            where: {
              appliedToBookingId: fresh.bookingId,
            },
            _sum: { amountCents: true },
          });
          const xeroAllocatedAppliedCreditCents = Math.max(
            0,
            xeroAllocated._sum.amountCents ?? 0,
          );
          xeroClearingAmountCents = unpaidInvoiceClearingAmountCents({
            finalPriceCents: fresh.booking.finalPriceCents,
            changeFeeCents: fresh.changeFeeCents,
            xeroAllocatedAppliedCreditCents,
          });
        }
      }

      // Enqueue the clearing credit note INSIDE the release transaction (#1357,
      // the #1233 in-tx pattern): the outbox row commits atomically with
      // `internetBankingHoldReleasedAt`, so no crash point can strand the open
      // Xero invoice with no self-heal (re-runs skip released holds). The
      // enqueue is a pure local insert — the Xero call happens in the outbox
      // worker, outside this transaction. Guard on `> 0` exactly like the
      // cancel path (#1547): a zero amount (no invoice, or an invoice already
      // fully credit-noted) enqueues nothing at all — no note, no
      // permanently-failing outbox op.
      //
      // #3535: the SAME note the never-captured cancel path raises — anchored
      // on the booking, ALLOCATED against its invoice, no credit-note payment —
      // so the unpaid invoice closes and no money is recorded as moving. It
      // was the cash-refund note, which is never allocated and named a bank
      // transfer refund for money nobody paid. The wording now says the
      // invoice was cleared because the booking was not paid.
      // Idempotency: this line runs once per hold (the guard set above). The
      // enqueue dedupes on the booking's active MODIFICATION_CREDIT_NOTE link
      // and on a live operation with the same `booking:<id>:mod-credit-note:
      // <cents>:v1` key. The cancel path and the repair tool's
      // cancelled-open-invoice arm raise this same booking-anchored note, sized
      // by the same helper; the repair arm also stands down while any clearing
      // operation for the booking exists, whatever its cents.
      let queueOperationId: string | null = null;
      if (xeroClearingAmountCents > 0) {
        const queued = await enqueueXeroModificationCreditNoteOperation(
          {
            bookingId: fresh.bookingId,
            refundAmountCents: xeroClearingAmountCents,
            clearsUnpaidInvoice: true,
          },
          { store: tx },
        );
        queueOperationId = queued.queueOperationId;
      }

      // #3209 / #2576 §8. The beds are reconciled above; ADULT SUPERVISION was
      // not. The guard set this branch runs under requires
      // `fresh.booking.status === BookingStatus.CONFIRMED`, and CONFIRMED is one
      // of the two statuses that qualify a booking as a `SAME_BOOKING_OWNER`
      // coverage source — so an expired hold can remove the qualifying adult who
      // was covering ANOTHER booking of the same member at this lodge, on the
      // exact nights its non-member guests are there, and nothing anywhere
      // noticed: no incident, no owner email, nothing in the officer queue.
      //
      // Last in the transaction, after the lodge capacity key and the per-member
      // credit-ledger key, because the coverage-owner key this takes is always
      // acquired last (`INV-HOST-031`, `INV-LOCK-002`). In the transaction so the
      // obligation commits with the release, and through the system-cancellation
      // seam so it can never refuse one: a hold expiry has no actor to answer, and
      // a rolled-back release is re-attempted by the next run against the same
      // rows, so a refusal here would wedge the hold — and the beds — permanently.
      await reconcileHostingReviewForSystemCancellation(fresh.bookingId, tx);

      return {
        type: "released" as const,
        payment: fresh,
        creditRestoredCents,
        queueOperationId,
      };
    },
    // The enqueue adds a handful of reads under the club-wide advisory lock;
    // give the interactive transaction headroom over Prisma's 5s default so
    // lock contention alone cannot abort a release mid-flight.
    { timeout: 15000 },
  );
}

export async function releaseExpiredInternetBankingHolds(
  now = new Date(),
): Promise<InternetBankingHoldReleaseResult> {
  // The club's format (#3565), resolved once, before any transaction or
  // lock below — never per amount and never inside a transaction.
  const format = await clubFormatValues();
  const candidates = await prisma.payment.findMany({
    where: {
      source: PaymentSource.INTERNET_BANKING,
      status: PaymentStatus.PENDING,
      internetBankingHoldSlots: true,
      internetBankingHoldUntil: { lte: now },
      internetBankingHoldReleasedAt: null,
    },
    include: {
      booking: {
        include: {
          member: true,
          // #3369: the owner may be an Organisation; bookingOwner() reads both.
          organisation: { select: { name: true, email: true } },
          guests: { include: { nights: true } },
        },
      },
    },
    orderBy: { internetBankingHoldUntil: "asc" },
  });

  const result: InternetBankingHoldReleaseResult = {
    scanned: candidates.length,
    released: 0,
    skipped: 0,
    failed: 0,
    bookingIds: [],
    paymentIds: [],
  };

  for (const candidate of candidates) {
    let transition: Awaited<ReturnType<typeof releaseOneHold>>;
    try {
      transition = await releaseOneHold(candidate.id, now);
    } catch (err) {
      // One poisoned candidate must not starve the rest of the queue: its
      // transaction rolled back whole (hold NOT released, so the next run
      // retries it), and the loop moves on (#1357).
      result.failed += 1;
      logger.error(
        { err, bookingId: candidate.bookingId, paymentId: candidate.id },
        "Failed to release expired Internet Banking hold; will retry next run",
      );
      continue;
    }

    if (transition.type === "skipped") {
      result.skipped += 1;
      continue;
    }

    const { payment, creditRestoredCents } = transition;
    result.released += 1;
    result.bookingIds.push(payment.bookingId);
    result.paymentIds.push(payment.id);

    await recordBookingEvent({
      bookingId: payment.bookingId,
      type: BookingEventType.CANCELLED,
      amountCents: payment.amountCents,
      // #1547: surface the restored applied credit in the narrative, matching
      // the cancel branches.
      reason:
        creditRestoredCents > 0
          ? `Internet Banking payment hold expired before reconciliation. ${formatCents(creditRestoredCents, format)} of applied account credit was returned.`
          : "Internet Banking payment hold expired before reconciliation.",
      snapshot: {
        paymentId: payment.id,
        holdUntil: payment.internetBankingHoldUntil?.toISOString() ?? null,
        creditRestoredCents,
      },
    });

    createAuditLog({
      action: "booking.internet_banking_hold_expired",
      targetId: payment.bookingId,
      subjectMemberId: bookingOwner(payment.booking).memberId,
      entityType: "Booking",
      entityId: payment.bookingId,
      category: "payment",
      severity: "important",
      outcome: "success",
      summary: "Expired Internet Banking hold released",
      details: JSON.stringify({
        paymentId: payment.id,
        holdUntil: payment.internetBankingHoldUntil?.toISOString() ?? null,
        amountCents: payment.amountCents,
      }),
      metadata: {
        paymentId: payment.id,
        paymentSource: PaymentSource.INTERNET_BANKING,
        holdUntil: payment.internetBankingHoldUntil?.toISOString() ?? null,
        amountCents: payment.amountCents,
        creditRestoredCents,
      },
    }).catch((err) =>
      logger.error(
        { err, bookingId: payment.bookingId, paymentId: payment.id },
        "Failed to audit expired Internet Banking hold release",
      ),
    );

    // The credit note is already durably enqueued (inside the transaction
    // above); the kick is best-effort — the outbox cron sweeps the row anyway.
    if (transition.queueOperationId) {
      kickQueuedXeroOutboxOperationsIfConnected({ limit: 1 }).catch((err) =>
        logger.error(
          { err, bookingId: payment.bookingId, paymentId: payment.id },
          "Failed to kick Xero outbox after expired Internet Banking hold release",
        ),
      );
    }

    sendBookingCancelledEmail(
      {
        bookingId: payment.booking.id,
        recipientMemberId: bookingOwner(payment.booking).memberId,
      },
      bookingOwner(payment.booking).member.email,
      bookingOwner(payment.booking).member.firstName,
      payment.booking.checkIn,
      payment.booking.checkOut,
      0,
      format,
      "credit",
      creditRestoredCents,
      payment.booking.lodgeId,
    ).catch((err) =>
      logger.error(
        { err, bookingId: payment.bookingId, paymentId: payment.id },
        "Failed to email member after expired Internet Banking hold release",
      ),
    );

    processWaitlistForDates({
      checkIn: payment.booking.checkIn,
      checkOut: payment.booking.checkOut,
      lodgeId: payment.booking.lodgeId,
    }, format).catch((err) =>
      logger.error(
        { err, bookingId: payment.bookingId },
        "Failed to process waitlist after expired Internet Banking hold release",
      ),
    );

    // #3209 / #2576 §7. The release transaction recorded WHAT has to be re-read;
    // this is the immediate half — re-read the now-committed facts, open or
    // resolve the incident, and notify the owner once. Never throws (it logs and
    // returns EMPTY), so a failing drain cannot fail a release that has already
    // committed, and the cron sweep remains the authority on completion.
    await settleHostingCoverageAfterCommit({ bookingId: payment.bookingId });
  }

  return result;
}
