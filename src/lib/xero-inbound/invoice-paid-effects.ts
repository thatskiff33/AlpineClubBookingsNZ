import { type Invoice } from "xero-node";
import { BookingEventType, BookingStatus, CreditType, PaymentSource, PaymentStatus, PaymentTransactionKind, Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import logger from "@/lib/logger";
import {
  sendAdminManualSettlementConflictAlert,
  sendAdminPaymentFailureAlert,
  sendBookingCancelledEmail,
  sendBookingConfirmedEmail,
} from "@/lib/email";
import { claimAlertCooldown } from "@/lib/alert-cooldown";
import { providerAmountToCents } from "@/lib/money-provider-amount";
import { buildXeroInvoiceUrl } from "@/lib/xero-links";
import {
  MANUAL_SETTLEMENT_CONFLICT_EVENT_KIND,
  MANUAL_SETTLEMENT_CONFLICT_EVENT_REASON,
  type ManualSettlementConflictEventSnapshot,
} from "@/lib/manual-settlement-reversal-event";
import { applyGroupSettlementSucceededFromInvoice } from "@/lib/group-settlement";
import { reconcileBedAllocationsForBookingWithLodgeLockHeld } from "@/lib/bed-allocation-lifecycle";
import { settleHostingCoverageAfterCommit } from "@/lib/adult-member-hosting-coverage-drain";
import { enqueueOwnHostingCoverageReevaluation } from "@/lib/adult-member-hosting-review";
import {
  acquireLodgeCapacityLock,
  checkCapacityForGuestRanges,
} from "@/lib/capacity";
import { recordBookingEvent } from "@/lib/booking-events";
import { bookingHasCapacityOverride } from "@/lib/booking-status";
import { processWaitlistForDates } from "@/lib/waitlist";
import { enqueueXeroAccountCreditNoteOperation } from "@/lib/xero-operation-outbox";
import { createAuditLog } from "@/lib/audit";
import { clearStaleCreditElection } from "@/lib/booking-credit-election";
import { reportUnappliedCreditElection } from "@/lib/booking-credit-election-report";
import { getProvisionalNonMemberChildSummary } from "@/lib/booking-split-summary";
import { formatCents } from "@/lib/utils";

function isPaidXeroInvoice(invoice: Invoice): boolean {
  const status = String(invoice.status ?? "").toUpperCase();
  return status === "PAID" || Boolean(invoice.fullyPaidOnDate);
}

type XeroInvoiceCashEvidence = "cash" | "none" | "indeterminate";

// A PAID invoice event alone is not cash (#1357/#1435): Xero also reports
// PAID when a credit note is ALLOCATED against the invoice — allocations
// accrue to amountCredited, never amountPaid, and the app's own
// invoice-clearing notes produce exactly that zero-cash PAID event on every
// ordinary unpaid-IB cancellation.
//
// Evidence order:
//  1. Overpayment/prepayment allocations count as cash: they are real member
//     money sitting on the Xero contact that an operator deliberately applied
//     (a standard bank-rec flow for transfers with mangled references). Xero
//     books them under amountCredited, but the app itself only ever produces
//     CREDIT-NOTE allocations, so these can never be the clearing-note echo
//     this gate exists to stop.
//  2. `amountPaid` is authoritative when present as a finite number — an
//     explicit 0 means Xero says no cash arrived, and the payments fallback
//     must NOT override it (stale entries could linger there).
//  3. The invoice's actual payment records are the fallback, ignoring
//     DELETED (reversed) payments.
//  4. A payload carrying none of these fields is "indeterminate" — the fresh
//     getInvoice fetch behind the only caller always carries the cash
//     fields, so this arm only guards degraded payload shapes.
function classifyXeroInvoiceCashEvidence(
  invoice: Invoice
): XeroInvoiceCashEvidence {
  if (
    (invoice.overpayments?.length ?? 0) > 0 ||
    (invoice.prepayments?.length ?? 0) > 0
  ) {
    return "cash";
  }
  const amountPaidCents = providerAmountToCents(invoice.amountPaid);
  if (amountPaidCents !== null) {
    return amountPaidCents > 0 ? "cash" : "none";
  }
  if (Array.isArray(invoice.payments)) {
    const cashPayments = invoice.payments.filter(
      (payment) => String(payment.status ?? "").toUpperCase() !== "DELETED"
    );
    return cashPayments.length > 0 ? "cash" : "none";
  }
  return "indeterminate";
}

// Quantification of the invoice's cash in integer cents — the sizing
// companion to the boolean classifier above, used by both credit-minting
// arms (#1459). `knownCents` is the verified cash floor; `complete` is false
// when any cash component present on the payload had to be estimated or
// skipped, so callers can label the figure as unverified.
type XeroInvoiceCashQuantification = {
  knownCents: number;
  complete: boolean;
};

// Components mirror the classifier's evidence order and never double-count:
// a finite `amountPaid` is the sum of direct bank payments (falling back to
// the invoice's own non-DELETED payment records only when `amountPaid` is
// unusable), and each overpayment/prepayment allocation is additive on top
// because Xero accrues those to `amountCredited`, never `amountPaid`. An
// allocation without a usable `appliedAmount` contributes its `total`
// instead — an upper bound (the overpayment may be partly applied
// elsewhere), so it also marks the result incomplete. Any present-but-
// unreadable component marks the result incomplete without discarding the
// components that did quantify: the known floor stays usable. The fresh
// getInvoice fetch behind the only caller always carries the amount fields,
// so incomplete results only arise from degraded payload shapes.
function quantifyXeroInvoiceCashCents(
  invoice: Invoice
): XeroInvoiceCashQuantification {
  let knownCents = 0;
  let complete = true;

  const amountPaidCents = providerAmountToCents(invoice.amountPaid);
  if (amountPaidCents !== null) {
    knownCents += amountPaidCents;
  } else {
    if (invoice.amountPaid !== undefined && invoice.amountPaid !== null) {
      // Present but unreadable (e.g. a stringly-typed degraded payload).
      complete = false;
    }
    if (Array.isArray(invoice.payments)) {
      for (const payment of invoice.payments) {
        if (String(payment.status ?? "").toUpperCase() === "DELETED") {
          continue;
        }
        const paymentCents = providerAmountToCents(payment.amount);
        if (paymentCents !== null) {
          knownCents += paymentCents;
        } else {
          complete = false;
        }
      }
    }
  }

  for (const allocation of [
    ...(invoice.overpayments ?? []),
    ...(invoice.prepayments ?? []),
  ]) {
    const appliedCents = providerAmountToCents(allocation.appliedAmount);
    const totalCents = providerAmountToCents(allocation.total);
    if (appliedCents !== null) {
      knownCents += appliedCents;
    } else if (totalCents !== null) {
      knownCents += totalCents;
      complete = false;
    } else {
      complete = false;
    }
  }

  return { knownCents, complete };
}

// Resolve how much a credit-minting arm may mint for one payment (#1459,
// #1505). Two independent clamps apply:
//  - Per payment (#1459): verified cash floors the mint at `min(face,
//    knownCents)`, flagged partial when it undercuts the payment's face
//    amount so the alerts can name both figures.
//  - Per invoice, aggregate (#1505): `otherPaymentsMintedCents` is the cash of
//    this SAME invoice already minted as credit for OTHER matched Internet
//    Banking payments; the mint is further capped at the invoice's remaining
//    cash (`knownCents - otherPaymentsMintedCents`). The per-payment clamp
//    alone let two never-settled payments matched to one invoice each mint
//    `min(own, cash)`, so their SUM could exceed the invoice's cash; this cap
//    apportions the invoice's cash across its payments so the aggregate can
//    never exceed it. `aggregateCapped` is true when this second clamp bit.
// When NOTHING quantified but the classifier still saw positive cash evidence,
// fall back to the payment's full amount (the issue-blessed fallback: minting
// the zero floor would silently under-credit a genuinely cash-settled invoice,
// and this arm only guards degraded payloads).
function resolveMintableCents(
  faceCents: number,
  cash: XeroInvoiceCashQuantification,
  otherPaymentsMintedCents = 0
): {
  mintableCents: number;
  mintPartial: boolean;
  cashUnverified: boolean;
  aggregateCapped: boolean;
} {
  if (cash.knownCents <= 0 && !cash.complete) {
    // Nothing quantifiable (degraded payload only; the fresh getInvoice fetch
    // behind the caller always carries the amount fields). The aggregate cap
    // needs a known cash figure to apportion against, so it cannot apply here
    // — fall back to the issue-blessed full-amount mint exactly as pre-#1505.
    return {
      mintableCents: faceCents,
      mintPartial: false,
      cashUnverified: true,
      aggregateCapped: false,
    };
  }
  const perPaymentCents = Math.min(faceCents, cash.knownCents);
  const invoiceRemainingCents = Math.max(
    0,
    cash.knownCents - otherPaymentsMintedCents
  );
  const mintableCents = Math.min(perPaymentCents, invoiceRemainingCents);
  return {
    mintableCents,
    mintPartial: mintableCents < faceCents,
    cashUnverified: !cash.complete,
    aggregateCapped: mintableCents < perPaymentCents,
  };
}

// Sum the credit THIS Internet Banking minting pipeline has already minted for
// a set of bookings (#1505). Read back INSIDE the reconcile transaction (after
// the shared advisory lock) so the aggregate cap sees every credit committed
// by an earlier payment in the same invoice's loop — each payment commits its
// own transaction under `pg_advisory_xact_lock(1)` before the next begins — as
// well as any prior invocation's, which keeps the cap idempotent under retry:
// a replayed payment finds its own credit via the per-booking dedup and mints
// nothing, and the cap for a fresh payment is computed from OTHER bookings'
// already-committed credits (never this booking's own), so it is stable across
// runs. Keyed on the pipeline's own credit descriptions and CANCELLATION_REFUND
// type — never on amount — exactly as the per-booking dedup keys, so it never
// counts unrelated cancellation-flow credit rows.
async function sumInternetBankingMintedCentsForBookings(
  tx: Prisma.TransactionClient,
  bookingIds: string[]
): Promise<number> {
  if (bookingIds.length === 0) {
    return 0;
  }
  const aggregate = await tx.memberCredit.aggregate({
    where: {
      sourceBookingId: { in: bookingIds },
      type: CreditType.CANCELLATION_REFUND,
      description: { startsWith: "Internet Banking payment credit for " },
    },
    _sum: { amountCents: true },
  });
  return aggregate._sum.amountCents ?? 0;
}

/**
 * B5 (#2262): repeat-alert window for the reciprocal fence. A webhook replay
 * must RE-COUNT the conflict (it is still unreconciled) without re-mailing the
 * admins every time Xero redelivers the same event.
 */
const MANUAL_SETTLEMENT_CONFLICT_ALERT_COOLDOWN_MS = 24 * 60 * 60 * 1000;

/**
 * B5 (#2262): the durable half of the reciprocal fence. Records the conflict
 * ONCE per (payment, invoice) as an admin-only BookingEvent, then alerts the
 * admins behind a cross-instance cooldown. Runs AFTER the transaction — the
 * provider call must never sit inside one — and never changes money state.
 */
async function recordManualSettlementConflict({
  payment,
  bookingStatus,
  invoiceId,
  invoiceNumber,
}: {
  payment: Prisma.PaymentGetPayload<{
    include: { booking: { include: { member: true } } };
  }>;
  bookingStatus: BookingStatus;
  invoiceId: string;
  invoiceNumber: string | null;
}) {
  const snapshot: ManualSettlementConflictEventSnapshot = {
    kind: MANUAL_SETTLEMENT_CONFLICT_EVENT_KIND,
    invoiceId,
    invoiceNumber,
    bookingStatus,
  };

  // BEST-EFFORT once per (payment, invoice): this is a read-then-create with
  // no unique key, so two concurrent replays of the same invoice event can
  // both pass the read and record twice. That duplicate is harmless — the
  // event is an admin-only history marker, the alert below has its own
  // cross-instance cooldown, and no money state keys off the event — so a
  // unique constraint is deliberately not added. A DIFFERENT invoice reporting
  // paid against the same payment still records its own conflict.
  const alreadyRecorded = await prisma.bookingEvent
    .findFirst({
      where: {
        bookingId: payment.bookingId,
        type: BookingEventType.CANCELLED,
        snapshot: { path: ["kind"], equals: MANUAL_SETTLEMENT_CONFLICT_EVENT_KIND },
        AND: [{ snapshot: { path: ["invoiceId"], equals: invoiceId } }],
      },
      select: { id: true },
    })
    .catch((err) => {
      logger.error(
        { err, bookingId: payment.bookingId, invoiceId },
        "Failed to look up an existing manual-settlement conflict event; recording a fresh one"
      );
      return null;
    });

  if (!alreadyRecorded) {
    await recordBookingEvent({
      bookingId: payment.bookingId,
      type: BookingEventType.CANCELLED,
      actorMemberId: null,
      amountCents: payment.amountCents,
      reason: MANUAL_SETTLEMENT_CONFLICT_EVENT_REASON,
      snapshot: snapshot as unknown as Prisma.InputJsonValue,
    });
  }

  const holdsClaim = await claimAlertCooldown({
    key: `manual-settlement-conflict:${payment.id}:${invoiceId}`,
    windowMs: MANUAL_SETTLEMENT_CONFLICT_ALERT_COOLDOWN_MS,
  }).catch((err) => {
    logger.error(
      { err, paymentId: payment.id, invoiceId },
      "Failed to claim the manual-settlement conflict alert cooldown; sending anyway rather than staying silent about unreconciled money"
    );
    return true;
  });
  if (!holdsClaim) return;

  await sendAdminManualSettlementConflictAlert({
    memberName: `${payment.booking.member.firstName} ${payment.booking.member.lastName}`,
    checkIn: payment.booking.checkIn,
    checkOut: payment.booking.checkOut,
    amountCents: payment.amountCents,
    bookingId: payment.bookingId,
    bookingStatus,
    xeroInvoiceNumber: invoiceNumber,
    // Cross-lane #2283: Xero deep links are BUILT, never hand-rolled.
    xeroInvoiceUrl: buildXeroInvoiceUrl(invoiceId),
  }).catch((err) =>
    logger.error(
      { err, bookingId: payment.bookingId, paymentId: payment.id, invoiceId },
      "Failed to alert admins about a manual-settlement vs Xero payment conflict"
    )
  );
}

export async function syncInternetBankingPaymentsForPaidInvoice(
  invoice: Invoice,
  linkedPaymentIds: string[]
) {
  const invoiceId = invoice.invoiceID ?? null;
  const invoiceNumber = invoice.invoiceNumber ?? null;
  const result = {
    matchedInternetBankingPayments: 0,
    paidInternetBankingPayments: 0,
    paidInternetBankingBookings: 0,
    creditedInternetBankingBookings: 0,
    partialCashCreditedInternetBankingBookings: 0,
    skippedAlreadyPaidBookings: 0,
    skippedNoCashEvidencePayments: 0,
    // B5 (#2262): inbound PAID events that landed on a manually settled
    // booking. Surfaced in the inbound-event result JSON the replay route
    // returns, so the fence is never a quiet return.
    manualSettlementConflicts: 0,
  };

  if (!invoiceId || !isPaidXeroInvoice(invoice)) {
    return result;
  }

  const paymentWhere = [
    {
      xeroInvoiceId: invoiceId,
    },
    ...(linkedPaymentIds.length > 0
      ? [
          {
            id: {
              in: linkedPaymentIds,
            },
          },
        ]
      : []),
  ];
  const paymentFilter = {
    source: PaymentSource.INTERNET_BANKING,
    OR: paymentWhere,
  };

  // #1435: settlement itself is cash-gated, not just credit minting (#1357).
  // Without positive cash evidence the loop settles NOTHING — no
  // PaymentTransaction/Payment SUCCEEDED flip, no booking PAID flip, no
  // member credit, no emails.
  const cashEvidence = classifyXeroInvoiceCashEvidence(invoice);
  const invoiceHasCashPayment = cashEvidence === "cash";
  if (!invoiceHasCashPayment) {
    // The app's own clearing-note echo (every ordinary unpaid-IB
    // cancellation) lands here, so this arm stays slim: no booking-graph
    // joins beyond what the admin alert below needs.
    const matchedPayments = await prisma.payment.findMany({
      where: paymentFilter,
      select: {
        id: true,
        amountCents: true,
        booking: {
          select: {
            status: true,
            checkIn: true,
            checkOut: true,
            member: { select: { firstName: true, lastName: true } },
          },
        },
      },
    });
    result.matchedInternetBankingPayments = matchedPayments.length;
    if (matchedPayments.length === 0) {
      return result;
    }

    if (cashEvidence === "indeterminate") {
      // A payload carrying neither amountPaid nor payments proves nothing
      // either way. Throwing (rather than settling blind or skipping
      // terminally) hands the event to the inbound FAILED-retry machinery,
      // which re-fetches the invoice fresh on every sweep: a transient
      // degradation self-heals, and a persistent one surfaces as a loud,
      // operator-replayable FAILED event instead of a booking that silently
      // never settles (#1435 owner decision).
      logger.warn(
        { invoiceId, invoiceNumber, matchedPayments: matchedPayments.length },
        "Xero PAID invoice payload carried neither amountPaid nor payments; refusing to settle Internet Banking payments without cash evidence"
      );
      throw new Error(
        `Xero PAID invoice ${invoiceId} carried neither amountPaid nor payments; refusing to settle ${matchedPayments.length} Internet Banking payment(s) without cash evidence (#1435)`
      );
    }

    // Zero-cash PAID (credit-note allocation). Settle nothing — but keep the
    // linkage the pre-gate loop provided: stamp MISSING invoice identifiers
    // (never status) on the matched payments and their PRIMARY transactions,
    // so a later real-cash event for this invoice still matches them
    // (#1357's stale-invoice flow depends on that match). This also covers
    // the multi-payment case syncLinkedPaymentInvoiceMetadata deliberately
    // leaves alone (it only stamps a canonical single match).
    const matchedPaymentIds = matchedPayments.map((payment) => payment.id);
    await prisma.paymentTransaction.updateMany({
      where: {
        paymentId: { in: matchedPaymentIds },
        source: PaymentSource.INTERNET_BANKING,
        kind: PaymentTransactionKind.PRIMARY,
        xeroInvoiceId: null,
      },
      data: { xeroInvoiceId: invoiceId, xeroInvoiceNumber: invoiceNumber },
    });
    await prisma.payment.updateMany({
      where: { id: { in: matchedPaymentIds }, xeroInvoiceId: null },
      data: { xeroInvoiceId: invoiceId, xeroInvoiceNumber: invoiceNumber },
    });

    result.skippedNoCashEvidencePayments = matchedPayments.length;
    logger.info(
      { invoiceId, invoiceNumber, matchedPayments: matchedPayments.length },
      "Xero invoice reports PAID without cash payments (credit-note allocation); Internet Banking settlement skipped"
    );

    // An allocation-cleared invoice for a LIVE booking means an operator
    // cleared it Xero-side (e.g. wrote it off with a credit note) while the
    // booking still awaits payment in the app — under the default
    // non-holding config nothing will ever settle or expire that booking,
    // so tell the admins instead of parking it silently. The routine
    // clearing-note echo never fires this: its booking is already CANCELLED.
    for (const payment of matchedPayments) {
      if (
        payment.booking.status === BookingStatus.CANCELLED ||
        payment.booking.status === BookingStatus.PAID
      ) {
        continue;
      }
      await sendAdminPaymentFailureAlert({
        memberName: `${payment.booking.member.firstName} ${payment.booking.member.lastName}`,
        checkIn: payment.booking.checkIn,
        checkOut: payment.booking.checkOut,
        amountCents: payment.amountCents,
        errorMessage:
          "This booking's Xero invoice reports PAID via credit-note allocation, not a cash payment, so the app did not settle it and the booking still awaits payment. If the invoice was written off in Xero, cancel the booking in the app; if the member actually paid, record the cash payment against the invoice in Xero.",
        paymentIntentId: invoiceId,
      }).catch((err) =>
        logger.error(
          { err, paymentId: payment.id, invoiceId },
          "Failed to alert admins about an allocation-cleared invoice on a live booking"
        )
      );
    }
    return result;
  }

  // #1459: quantified once per invoice; sizes both credit-minting arms below
  // (already-cancelled and late-capacity-failure). The clamp is per payment —
  // cash is not apportioned across multiple matched payments, a shape no app
  // flow produces (group settlements ride their own settlement path).
  const invoiceCash = quantifyXeroInvoiceCashCents(invoice);

  const payments = await prisma.payment.findMany({
    where: paymentFilter,
    include: {
      booking: {
        include: {
          member: true,
          guests: { include: { nights: true } },
          promoRedemption: {
            include: {
              promoCode: true,
            },
          },
        },
      },
    },
  });

  result.matchedInternetBankingPayments = payments.length;

  // #1505: the set of bookings whose Internet Banking payments are matched to
  // this invoice. Each minting arm below caps its mint at the invoice's cash
  // MINUS what has already been minted for the OTHER bookings in this set, so
  // the aggregate credit across every matched payment can never exceed the
  // invoice's cash. With a single matched payment this set has one entry, the
  // "other bookings" list is empty, and the aggregate cap is inert — leaving
  // the #1459 per-payment clamp exactly as it was.
  const matchedBookingIds = Array.from(
    new Set(payments.map((payment) => payment.bookingId))
  );

  for (const payment of payments) {
    const outcome = await prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(1)`;

      const fresh = await tx.payment.findUnique({
        where: { id: payment.id },
        include: {
          booking: {
            include: {
              member: true,
              guests: { include: { nights: true } },
              promoRedemption: { include: { promoCode: true } },
            },
          },
        },
      });

      if (!fresh || fresh.source !== PaymentSource.INTERNET_BANKING) {
        return { type: "missing" as const };
      }

      // B5 (#2262) — the RECIPROCAL fence, and the counterpart to the outbound
      // refusal. An admin recorded this booking's payment as cash / an off-Xero
      // bank transfer; Xero now reports the same booking's invoice PAID. The
      // club may be holding the same money twice, and only a person can decide
      // which is real, so this pipeline writes NOTHING further and raises a
      // durable alert instead of returning quietly.
      //
      // Placed BEFORE the transactionUpdate below on purpose, so the settle
      // loop never stamps a Xero invoice id onto a manually settled payment's
      // rows.
      //
      // Keyed on `manuallyMarkedPaidAt` ALONE, with NO status conjunct:
      //  * PAID     — the plain double settlement;
      //  * CANCELLED — must conflict, because the inbound path would otherwise
      //    mint member credit for this cash while an OPEN ManualRefundTask
      //    already owes the member the same money: a double refund;
      //  * COMPLETED — must conflict, because cron-complete-bookings flips
      //    PAID -> COMPLETED post-stay, so a late bank transfer lands here.
      // And with no "…and carries no Xero id" conjunct either: two stampers
      // outside this loop (syncLinkedPaymentInvoiceMetadata, which runs BEFORE
      // it, and the zero-cash arm below) can legitimately have stamped an id
      // onto a manual row, and that must not launder its provenance.
      if (fresh.manuallyMarkedPaidAt) {
        return {
          type: "manualSettlementConflict" as const,
          payment: fresh,
          bookingStatus: fresh.booking.status,
          // Carried so the discriminated union keeps type-checking at the
          // shared `outcome.paymentWasPending` read below; this arm never
          // counts as a payment the inbound pipeline settled.
          paymentWasPending: false,
        };
      }

      const transactionUpdate = await tx.paymentTransaction.updateMany({
        where: {
          paymentId: fresh.id,
          source: PaymentSource.INTERNET_BANKING,
          kind: PaymentTransactionKind.PRIMARY,
          // Refunded rows keep their refund bookkeeping on replays (#1357).
          status: {
            notIn: [PaymentStatus.REFUNDED, PaymentStatus.PARTIALLY_REFUNDED],
          },
        },
        data: {
          status: PaymentStatus.SUCCEEDED,
          xeroInvoiceId: invoiceId,
          xeroInvoiceNumber: invoiceNumber,
        },
      });

      if (transactionUpdate.count === 0) {
        // A refunded PRIMARY row is excluded from the update above but still
        // exists — only mint a fresh SUCCEEDED row when none exists at all.
        const existingPrimary = await tx.paymentTransaction.findFirst({
          where: {
            paymentId: fresh.id,
            source: PaymentSource.INTERNET_BANKING,
            kind: PaymentTransactionKind.PRIMARY,
          },
          select: { id: true },
        });
        if (!existingPrimary) {
          await tx.paymentTransaction.create({
            data: {
              paymentId: fresh.id,
              kind: PaymentTransactionKind.PRIMARY,
              source: PaymentSource.INTERNET_BANKING,
              stripePaymentIntentId: null,
              xeroInvoiceId: invoiceId,
              xeroInvoiceNumber: invoiceNumber,
              reference: fresh.reference ?? undefined,
              amountCents: fresh.amountCents,
              status: PaymentStatus.SUCCEEDED,
              reason: "xero_invoice_paid_reconciliation",
            },
          });
        }
      }

      const paymentWasPending = fresh.status !== PaymentStatus.SUCCEEDED;
      // A PAID invoice event must never un-refund money (#1357, the #1353
      // raise-only spirit): a payment already (PARTIALLY_)REFUNDED keeps its
      // refund state on replays — only the invoice identifiers are refreshed.
      const paymentInRefundedState =
        fresh.status === PaymentStatus.REFUNDED ||
        fresh.status === PaymentStatus.PARTIALLY_REFUNDED;
      if (paymentWasPending || !fresh.xeroInvoiceId || fresh.xeroInvoiceNumber !== invoiceNumber) {
        await tx.payment.update({
          where: { id: fresh.id },
          data: {
            ...(paymentInRefundedState ? {} : { status: PaymentStatus.SUCCEEDED }),
            xeroInvoiceId: invoiceId,
            xeroInvoiceNumber: invoiceNumber,
          },
        });
      }

      if (fresh.booking.status === BookingStatus.PAID) {
        return {
          type: "alreadyPaid" as const,
          payment: fresh,
          paymentWasPending,
        };
      }

      // #1587: the already-cancelled credit-mint arm, hoisted into a local
      // closure so it is reachable from BOTH the pre-lock CANCELLED branch and
      // the post-lodge-lock re-read (a booking a concurrent actor cancelled
      // inside the lodge-lock wait window). Cash that arrived for a cancelled
      // booking becomes member credit — resurrecting it to PAID would be a
      // phantom capacity claim + inconsistent money state. The body is
      // byte-identical to the pre-#1587 arm and closes over tx/payment context/
      // paymentWasPending and the invoice-scoped cash context lexically.
      const runAlreadyCancelledCreditMintArm = async (
        settlementPayment = fresh,
        originalPaymentStatus = fresh.status,
      ) => {
        // A member paying the stale open invoice of an already-cancelled
        // booking (#1357, F17) must not land silently — but this branch is
        // reachable for EVERY cancelled booking whose invoice reports PAID,
        // and Xero also reports PAID when our own invoice-clearing credit
        // note is allocated (zero cash). Minting therefore requires ALL of:
        //  1. positive CASH evidence on the invoice (amountPaid, falling back
        //     to actual payment records) — an allocation-cleared invoice has
        //     credit applied, not cash, and must mint nothing. Since #1435
        //     the loop entry enforces this for every arm; the re-assert here
        //     is belt-and-braces for MINTING only (if the outer gate is ever
        //     reshaped, the settlement flips in the other arms are pinned by
        //     the #1435 regression tests, not by this condition);
        //  2. a payment that never settled (PENDING/FAILED) — a
        //     paid-then-cancelled booking's replayed event is old money that
        //     the cancellation flow already settled under its own policy;
        //  3. no credit already minted by THIS pipeline (matched by its own
        //     descriptions — never by amount, which collides with unrelated
        //     cancellation-flow rows and misses policy-tiered ones).
        const paymentNeverSettled =
          originalPaymentStatus === PaymentStatus.PENDING ||
          originalPaymentStatus === PaymentStatus.FAILED;
        const bookingLabel = settlementPayment.bookingId.slice(0, 8);

        // #1459: size the mint by the invoice's quantified CASH, never by the
        // payment's face amount alone. On a mixed invoice — the member
        // part-pays in cash and the remainder is cleared by credit allocation
        // (the app's own invoice-clearing note, an operator write-off, or an
        // operator-allocated member credit note) — `amountPaid` is only the
        // cash portion, and minting the full payment amount would credit
        // money that never arrived.
        // #1505: further cap the mint at the invoice's cash NOT already minted
        // for the other payments matched to it, so two never-settled payments
        // on one invoice can never in aggregate mint more than its cash. The
        // sum excludes this booking's own credit (read fresh under the advisory
        // lock), which keeps the cap stable across replays.
        const otherMintedCents = await sumInternetBankingMintedCentsForBookings(
          tx,
          matchedBookingIds.filter((id) => id !== settlementPayment.bookingId)
        );
        const { mintableCents, mintPartial, cashUnverified, aggregateCapped } =
          resolveMintableCents(
            settlementPayment.amountCents,
            invoiceCash,
            otherMintedCents,
          );

        // Looked up unconditionally (amount included): the dedup gate needs
        // its existence, and the later-cash detection below needs its size.
        const existingCredit = await tx.memberCredit.findFirst({
          where: {
            memberId: settlementPayment.booking.memberId,
            sourceBookingId: settlementPayment.bookingId,
            type: CreditType.CANCELLATION_REFUND,
            description: {
              in: [
                `Internet Banking payment credit for booking ${bookingLabel}`,
                `Internet Banking payment credit for cancelled booking ${bookingLabel}`,
              ],
            },
          },
          select: { id: true, amountCents: true },
        });

        const credited =
          invoiceHasCashPayment &&
          paymentNeverSettled &&
          !existingCredit &&
          mintableCents > 0;

        // A partial mint's remainder never auto-credits: a later PAID event
        // for this invoice lands here with a settled payment (or the dedup
        // hit) and mints nothing. When the VERIFIED cash now exceeds what was
        // already minted, say so instead of staying silent — the member is
        // owed the delta and only an operator can size the top-up. The
        // comparison uses the aggregate-apportioned `mintableCents` (#1505), so
        // a multi-payment replay whose cash was already shared out does not
        // raise a false later-cash alert on every sweep.
        const laterCashCents =
          !credited &&
          existingCredit &&
          invoiceCash.complete &&
          mintableCents > existingCredit.amountCents
            ? mintableCents - existingCredit.amountCents
            : 0;

        // A never-settled payment whose creditable cash is zero settled with no
        // credit behind it — never silent. Two causes, both loud below: the
        // classifier and quantifier disagree at zero (cash-classified evidence
        // that quantifies to nothing), or the invoice's cash was already fully
        // minted for the other payments matched to it (#1505 aggregate cap).
        const zeroCashAnomaly =
          invoiceHasCashPayment &&
          paymentNeverSettled &&
          !existingCredit &&
          mintableCents === 0 &&
          settlementPayment.amountCents > 0;
        if (zeroCashAnomaly) {
          logger.warn(
            {
              invoiceId,
              paymentId: settlementPayment.id,
              bookingId: settlementPayment.bookingId,
              aggregateCapped,
            },
            aggregateCapped
              ? "Xero PAID invoice's cash was already fully minted for other Internet Banking payments on the same invoice; no further member credit minted for this cancelled booking (#1505)"
              : "Xero PAID invoice classified as cash-settled but its cash quantified to zero; no member credit minted for the cancelled booking"
          );
        } else if (aggregateCapped && credited) {
          logger.warn(
            {
              invoiceId,
              paymentId: settlementPayment.id,
              bookingId: settlementPayment.bookingId,
              mintableCents,
              otherMintedCents,
              invoiceCashCents: invoiceCash.knownCents,
            },
            "Internet Banking credit mint reduced by the per-invoice aggregate cap: other payments on this invoice already claimed part of its cash (#1505)"
          );
        }

        if (credited) {
          await tx.memberCredit.create({
            data: {
              memberId: settlementPayment.booking.memberId,
              amountCents: mintableCents,
              type: CreditType.CANCELLATION_REFUND,
              description: `Internet Banking payment credit for cancelled booking ${bookingLabel}`,
              sourceBookingId: settlementPayment.bookingId,
            },
          });
          // Real cash arrived, so the hold-expiry release's still-pending
          // invoice-clearing refund credit note (which would post a fictional
          // cash refund) is obsolete — retire it in the same transaction. An
          // already-executed note can't be retired here; the admin alert
          // below calls out that state for manual reconciliation.
          await tx.xeroSyncOperation.updateMany({
            where: {
              localModel: "Payment",
              localId: settlementPayment.id,
              direction: "OUTBOUND",
              entityType: "CREDIT_NOTE",
              operationType: "CREATE",
              status: "PENDING",
              correlationKey: {
                startsWith: `payment:${settlementPayment.id}:refund-credit-note:`,
              },
            },
            data: {
              status: "CANCELLED",
            },
          });
          await enqueueXeroAccountCreditNoteOperation(
            settlementPayment.id,
            mintableCents,
            { store: tx },
          );
        }

        return {
          type: "alreadyCancelled" as const,
          payment: settlementPayment,
          paymentWasPending,
          credited,
          creditedCents: mintableCents,
          creditedPartial: mintPartial,
          cashUnverified,
          aggregateCapped,
          laterCashCents,
          zeroCashAnomaly,
          clearingNoteAlreadyIssued: Boolean(
            settlementPayment.xeroRefundCreditNoteId,
          ),
        };
      };

      if (fresh.booking.status === BookingStatus.CANCELLED) {
        return runAlreadyCancelledCreditMintArm();
      }

      // Reconciliation writes bed allocations even for an already-held
      // CONFIRMED booking. Acquire the immutable lodge key for every branch
      // that can reach PAID, then consume only this post-lock snapshot.
      await acquireLodgeCapacityLock(tx, fresh.booking.lodgeId);
      const locked = await tx.payment.findUnique({
        where: { id: fresh.id },
        include: {
          booking: {
            include: {
              member: true,
              guests: { include: { nights: true } },
              promoRedemption: { include: { promoCode: true } },
            },
          },
        },
      });
      if (!locked || locked.source !== PaymentSource.INTERNET_BANKING) {
        throw new Error(
          "Internet Banking payment disappeared during Xero reconciliation",
        );
      }
      if (locked.booking.status === BookingStatus.PAID) {
        return {
          type: "alreadyPaid" as const,
          payment: fresh,
          paymentWasPending,
        };
      }
      if (locked.booking.status === BookingStatus.CANCELLED) {
        return runAlreadyCancelledCreditMintArm(locked, fresh.status);
      }

      if (
        locked.booking.status === BookingStatus.PAYMENT_PENDING &&
        !locked.internetBankingHoldSlots
      ) {
        // Two-lock composition (multi-lodge). The outer pg_advisory_xact_lock(1)
        // above sequences Internet Banking webhook/reconciliation processing;
        // it no longer excludes per-lodge booking creators, who serialize on
        // hash(lodge) instead. Flipping an unheld PAYMENT_PENDING booking to
        // PAID here is a net-new capacity claim, so it must ALSO take the
        // booking's per-lodge lock to serialize against those creators. lodgeId
        // is immutable, so keying the lock from the pre-lock read is safe.
        // #1587: a concurrent actor may have CANCELLED this booking while we
        // waited on the lodge lock — the pre-lock branch decision above was
        // taken under lock(1) only, so a cancellation that landed inside the
        // lodge-lock wait window is only visible now. Flipping it to PAID from
        // here would resurrect a cancelled booking (a phantom capacity claim
        // and inconsistent money state). Route the cash into the SAME
        // already-cancelled credit-mint arm instead, exactly as if the
        // cancellation had been observed before the payment landed. Only the
        // post-lock-CANCELLED path changes; every other post-lock state falls
        // through to the capacity gate / PAID flip below unchanged.
        // Only an unheld PAYMENT_PENDING booking still needs the capacity gate.
        // If the post-lock read shows it moved on (already CONFIRMED/PAID by a
        // concurrent path, or a switch-to-Internet-Banking now holds its
        // slots), skip the gate and fall through to the PAID flip below: those
        // states already hold their beds, so there is no net-new claim to
        // serialize.
        const capacity = await checkCapacityForGuestRanges(
          locked.booking.lodgeId,
          locked.booking.checkIn,
          locked.booking.checkOut,
          locked.booking.guests,
          locked.booking.id,
          tx,
        );

        // Persisted capacity override (#1771): read off the post-lock snapshot
        // (locked is non-null whenever capacity was actually checked, but guard
        // it so TS stays happy on the { available: true } branch). The marker is
        // immutable, so the pre- vs post-lock read cannot disagree.
        const lockedHasOverride = bookingHasCapacityOverride(locked.booking);

        if (!capacity.available && lockedHasOverride) {
          // The booking was deliberately admitted above the ceiling by an admin,
          // so a late Internet Banking payment must settle it, not cancel + mint
          // a credit. Fall through to the PAID flip below.
          logger.info(
            { invoiceId, paymentId: fresh.id, bookingId: fresh.bookingId },
            "Settling an over-capacity Internet Banking booking with a persisted capacity override (#1771); skipping the capacity cancel"
          );
        }
        if (!capacity.available && !lockedHasOverride) {
          // #2265 (#2319 door 2). This booking is being cancelled and its cash
          // turned into account credit, so no consumer will ever read its
          // stored election again (both require PAYMENT_PENDING). Clear it here
          // too, for the same reason the PAID arm does: no terminal booking
          // carries a stale election. Nothing is lost — the election never
          // moved money, and the cash the member did send is minted as credit
          // just below.
          await clearStaleCreditElection(tx, locked.booking);
          const cancelled = await tx.booking.updateMany({
            where: {
              id: fresh.bookingId,
              status: locked.booking.status,
            },
            data: {
              status: BookingStatus.CANCELLED,
              draftExpiresAt: null,
            },
          });
          if (cancelled.count === 0) {
            throw new Error(
              "Xero reconciliation lost its capacity-failure cancellation claim",
            );
          }
          await reconcileBedAllocationsForBookingWithLodgeLockHeld({
            bookingId: fresh.bookingId,
            db: tx,
          });

          // #1459: this arm mints too, so it takes the same quantified-cash
          // clamp as the already-cancelled arm — a live booking's invoice can
          // also be mixed (operator write-off or allocated credit note plus
          // partial cash).
          // #1505: and the same per-invoice aggregate cap — the sum excludes
          // this booking's own credit, so the mint (and therefore the
          // amount-keyed dedup below) is stable across replays.
          const otherMintedCents =
            await sumInternetBankingMintedCentsForBookings(
              tx,
              matchedBookingIds.filter((id) => id !== fresh.bookingId)
            );
          const { mintableCents, mintPartial, cashUnverified, aggregateCapped } =
            resolveMintableCents(fresh.amountCents, invoiceCash, otherMintedCents);
          if (aggregateCapped) {
            logger.warn(
              { invoiceId, paymentId: fresh.id, bookingId: fresh.bookingId, mintableCents, otherMintedCents, invoiceCashCents: invoiceCash.knownCents },
              "Internet Banking credit mint reduced by the per-invoice aggregate cap on the late-capacity-failure arm: other payments on this invoice already claimed part of its cash (#1505)"
            );
          }

          const creditDescription = `Internet Banking payment credit for booking ${fresh.bookingId.slice(0, 8)}`;
          const existingCredit = await tx.memberCredit.findFirst({
            where: {
              memberId: fresh.booking.memberId,
              sourceBookingId: fresh.bookingId,
              amountCents: mintableCents,
              type: CreditType.CANCELLATION_REFUND,
              description: creditDescription,
            },
            select: { id: true },
          });
          if (!existingCredit && mintableCents > 0) {
            await tx.memberCredit.create({
              data: {
                memberId: fresh.booking.memberId,
                amountCents: mintableCents,
                type: CreditType.CANCELLATION_REFUND,
                description: creditDescription,
                sourceBookingId: fresh.bookingId,
              },
            });
          }

          // Enqueue the offsetting Xero account-credit note inside this same
          // transaction so the outbox intent commits atomically with the local
          // credit. Doing this post-commit risked a crash window that left a
          // local credit with no Xero mirror and no self-healing path (the
          // booking is now CANCELLED, so a re-run early-returns without
          // re-enqueueing). The enqueue is a local insert, no-ops when the
          // amount is <= 0, and dedups, so it is safe to run in-tx.
          await enqueueXeroAccountCreditNoteOperation(fresh.id, mintableCents, {
            store: tx,
          });

          return {
            type: "capacityFailed" as const,
            payment: fresh,
            paymentWasPending,
            credited: !existingCredit && mintableCents > 0,
            creditedCents: mintableCents,
            creditedPartial: mintPartial,
            cashUnverified,
            aggregateCapped,
          };
        }
      }

      // #2265 (#2319 door 2). The member has paid the invoiced amount in cash,
      // so a stored credit election can no longer be honoured on this booking —
      // clear it rather than leave a settled booking advertising an outstanding
      // election. Read off `fresh`, which is a post-`lock(1)` snapshot, and
      // taken as a guarded claim; see claimStaleCreditElection for the full
      // reasoning and for who can still reach here carrying one.
      const staleCreditElectionCents = await clearStaleCreditElection(
        tx,
        locked.booking
      );

      const claimed = await tx.booking.updateMany({
        where: {
          id: fresh.bookingId,
          status: locked.booking.status,
        },
        data: {
          status: BookingStatus.PAID,
          draftExpiresAt: null,
        },
      });
      if (claimed.count === 0) {
        throw new Error("Xero reconciliation lost its booking status claim");
      }
      await reconcileBedAllocationsForBookingWithLodgeLockHeld({
        bookingId: fresh.bookingId,
        db: tx,
      });

      // #2576 §9. An inbound Xero PAID is a confirmation, so the hosting facts are
      // re-read rather than trusted. Enqueued and never refused: the money is
      // already in the club's bank account by the time Xero tells us, so the only
      // available answer is to allow the transition and escalate anything uncovered
      // to an urgent incident (§8).
      await enqueueOwnHostingCoverageReevaluation(fresh.bookingId, tx, {
        cause: "SYSTEM_CHANGE",
      });

      return {
        type: "paid" as const,
        payment: fresh,
        paymentWasPending,
        staleCreditElectionCents,
      };
    });

    if (outcome.type === "missing") {
      continue;
    }

    // #2576 §9: drain what the PAID transition queued, per booking, now that it has
    // committed. Scoped to this booking's owner so one invoice's settlement never
    // runs another member's backlog inside this webhook.
    await settleHostingCoverageAfterCommit({
      bookingId: outcome.payment.bookingId,
    });

    if (outcome.type === "manualSettlementConflict") {
      // B5 (#2262). Loud on every axis: a counter in the returned result, an
      // error log, a durable admin-only BookingEvent (once per payment+invoice)
      // and an admin alert throttled by a cross-instance cooldown so webhook
      // replays re-count without re-spamming. NO money state was changed.
      result.manualSettlementConflicts += 1;
      logger.error(
        {
          bookingId: outcome.payment.bookingId,
          paymentId: outcome.payment.id,
          bookingStatus: outcome.bookingStatus,
          invoiceId,
          invoiceNumber,
        },
        "Inbound Xero PAID landed on a manually settled booking (#2262): the club may hold the same money twice — nothing was written"
      );
      await recordManualSettlementConflict({
        payment: outcome.payment,
        bookingStatus: outcome.bookingStatus,
        invoiceId,
        invoiceNumber,
      });
      continue;
    }

    if (outcome.paymentWasPending) {
      result.paidInternetBankingPayments += 1;
    }

    if (outcome.type === "alreadyPaid") {
      result.skippedAlreadyPaidBookings += 1;
      continue;
    }

    if (outcome.type === "alreadyCancelled") {
      // `credited` is the one state where new cash landed and was minted.
      // Routine replays, allocation-driven PAID flips (our own clearing
      // notes), and paid-then-cancelled histories all reach this arm with
      // credited=false and stay silent — EXCEPT the two anomalies below
      // (verified later cash exceeding the minted credit, and cash-classified
      // evidence that quantified to zero), which alert instead of parking a
      // money discrepancy silently.
      if (outcome.credited) {
        result.creditedInternetBankingBookings += 1;
        if (outcome.creditedPartial) {
          result.partialCashCreditedInternetBankingBookings += 1;
        }
        await recordBookingEvent({
          bookingId: outcome.payment.bookingId,
          type: BookingEventType.CREDITED,
          amountCents: outcome.creditedCents,
          reason: outcome.creditedPartial
            ? "Internet Banking cash received after cancellation; cash portion held as account credit."
            : "Internet Banking payment received after cancellation; amount held as account credit.",
        });
        sendBookingCancelledEmail(
          {
            bookingId: outcome.payment.booking.id,
            recipientMemberId: outcome.payment.booking.memberId,
          },
          outcome.payment.booking.member.email,
          outcome.payment.booking.member.firstName,
          outcome.payment.booking.checkIn,
          outcome.payment.booking.checkOut,
          outcome.creditedCents,
          "credit",
          0,
          outcome.payment.booking.lodgeId,
        ).catch((err) =>
          logger.error(
            { err, bookingId: outcome.payment.bookingId, paymentId: outcome.payment.id },
            "Failed to email member about credit for payment on cancelled booking"
          )
        );
        const unverifiedSuffix = outcome.cashUnverified
          ? " Cash amounts could not be fully verified from the Xero payload — confirm the figures against the invoice in Xero."
          : "";
        sendAdminPaymentFailureAlert({
          memberName: `${outcome.payment.booking.member.firstName} ${outcome.payment.booking.member.lastName}`,
          checkIn: outcome.payment.booking.checkIn,
          checkOut: outcome.payment.booking.checkOut,
          amountCents: outcome.creditedCents,
          errorMessage: outcome.aggregateCapped
            ? `Internet Banking cash of ${formatCents(outcome.creditedCents)} was credited for an already-cancelled booking, but this invoice's cash was already partly credited to other Internet Banking payment(s) matched to the same invoice. This payment's face amount is ${formatCents(outcome.payment.amountCents)}; only the invoice's remaining cash is held as the member's account credit, because the aggregate credit across all payments on one invoice can never exceed the invoice's cash. Verify the invoice's payments in Xero. If more cash arrives for this invoice later it will NOT credit automatically — top up the member's account credit manually.${outcome.clearingNoteAlreadyIssued ? " An invoice-clearing credit note was ALREADY issued for this invoice, so also check Xero for duplicate settlement artifacts." : ""}${unverifiedSuffix}`
            : outcome.creditedPartial
            ? `Internet Banking cash of ${formatCents(outcome.creditedCents)} was received for an already-cancelled booking whose ${formatCents(outcome.payment.amountCents)} payment was otherwise settled by credit allocation in Xero (mixed invoice). Only the cash portion is held as the member's account credit — verify the allocation source on the invoice (the app's own invoice-clearing credit note is routine; a manual write-off or an operator-allocated member credit note needs its own follow-up). If more cash arrives for this invoice later it will NOT credit automatically — top up the member's account credit manually.${outcome.clearingNoteAlreadyIssued ? " An invoice-clearing credit note was ALREADY issued for this invoice, so also check Xero for duplicate settlement artifacts." : ""}${unverifiedSuffix}`
            : outcome.clearingNoteAlreadyIssued
              ? `Internet Banking payment was received for an already-cancelled booking. The amount is held as the member's account credit — and an invoice-clearing credit note was ALREADY issued for this invoice, so Xero needs manual reconciliation (void the clearing note's refund payment or the duplicate artifact).${unverifiedSuffix}`
              : `Internet Banking payment was received for an already-cancelled booking. The amount is held as the member's account credit; follow up with the member if a bank refund is more appropriate.${unverifiedSuffix}`,
          paymentIntentId: invoiceId,
        }).catch((err) =>
          logger.error(
            { err, bookingId: outcome.payment.bookingId, paymentId: outcome.payment.id },
            "Failed to alert admins about Internet Banking payment on cancelled booking"
          )
        );
      } else if (outcome.laterCashCents > 0) {
        sendAdminPaymentFailureAlert({
          memberName: `${outcome.payment.booking.member.firstName} ${outcome.payment.booking.member.lastName}`,
          checkIn: outcome.payment.booking.checkIn,
          checkOut: outcome.payment.booking.checkOut,
          amountCents: outcome.laterCashCents,
          errorMessage: `Additional Internet Banking cash of ${formatCents(outcome.laterCashCents)} appears on the invoice of a cancelled booking that was already credited (verified cash now ${formatCents(outcome.creditedCents)}, credited so far ${formatCents(outcome.creditedCents - outcome.laterCashCents)}). Later cash never credits automatically — verify the invoice in Xero and top up the member's account credit manually.`,
          paymentIntentId: invoiceId,
        }).catch((err) =>
          logger.error(
            { err, bookingId: outcome.payment.bookingId, paymentId: outcome.payment.id },
            "Failed to alert admins about later cash on an already-credited cancelled booking"
          )
        );
      } else if (outcome.zeroCashAnomaly) {
        sendAdminPaymentFailureAlert({
          memberName: `${outcome.payment.booking.member.firstName} ${outcome.payment.booking.member.lastName}`,
          checkIn: outcome.payment.booking.checkIn,
          checkOut: outcome.payment.booking.checkOut,
          amountCents: outcome.payment.amountCents,
          errorMessage: outcome.aggregateCapped
            ? "This cancelled booking's Xero invoice reports PAID, but the invoice's cash was already fully credited to other Internet Banking payment(s) matched to the same invoice, so this payment was marked settled with NO member credit (the aggregate credit across all payments on one invoice can never exceed the invoice's cash). Reconcile the invoice manually in Xero and credit the member if additional cash actually arrived for this payment."
            : "This cancelled booking's Xero invoice reports PAID with cash-classified evidence that quantifies to zero, so the payment was marked settled but NO member credit was minted. Reconcile the invoice manually in Xero and credit the member if cash actually arrived.",
          paymentIntentId: invoiceId,
        }).catch((err) =>
          logger.error(
            { err, bookingId: outcome.payment.bookingId, paymentId: outcome.payment.id },
            "Failed to alert admins about zero-quantified cash on a cancelled booking"
          )
        );
      }
      continue;
    }

    if (outcome.type === "capacityFailed") {
      result.creditedInternetBankingBookings += 1;
      if (outcome.credited && outcome.creditedPartial) {
        result.partialCashCreditedInternetBankingBookings += 1;
      }

      await recordBookingEvent({
        bookingId: outcome.payment.bookingId,
        type: BookingEventType.CANCELLED,
        amountCents: outcome.payment.amountCents,
        reason: "Internet Banking payment reconciled after capacity was no longer available.",
      });
      if (outcome.credited) {
        await recordBookingEvent({
          bookingId: outcome.payment.bookingId,
          type: BookingEventType.CREDITED,
          amountCents: outcome.creditedCents,
          reason: outcome.creditedPartial
            ? "Cash portion of the Internet Banking payment held as account credit."
            : "Paid Internet Banking amount held as account credit.",
        });
      }

      // The Xero account-credit note is now enqueued inside the reconcile
      // transaction above (atomic with the local credit), so there is no
      // post-commit fire-and-forget enqueue here.
      sendAdminPaymentFailureAlert({
        memberName: `${outcome.payment.booking.member.firstName} ${outcome.payment.booking.member.lastName}`,
        checkIn: outcome.payment.booking.checkIn,
        checkOut: outcome.payment.booking.checkOut,
        amountCents: outcome.credited ? outcome.creditedCents : outcome.payment.amountCents,
        errorMessage: `Internet Banking payment reconciled, but the lodge no longer had capacity. The booking was cancelled and member account credit was created.${outcome.creditedPartial && !outcome.aggregateCapped ? ` Only ${formatCents(outcome.creditedCents)} of the ${formatCents(outcome.payment.amountCents)} payment arrived as cash (mixed invoice) — the credit was sized at the cash portion; verify the allocation source on the invoice in Xero.` : ""}${outcome.aggregateCapped ? ` This invoice's cash was already partly credited to other Internet Banking payment(s) matched to the same invoice, so this booking's credit was capped at the invoice's remaining cash${outcome.credited ? ` (${formatCents(outcome.creditedCents)}, from a ${formatCents(outcome.payment.amountCents)} payment)` : " (nothing remained, so no credit was created)"}; the aggregate credit across all payments on one invoice can never exceed the invoice's cash. Verify the invoice's payments in Xero.` : ""}${outcome.cashUnverified ? " Cash amounts could not be fully verified from the Xero payload — confirm the figures against the invoice in Xero." : ""}`,
        paymentIntentId: invoiceId,
      }).catch((err) =>
        logger.error(
          { err, bookingId: outcome.payment.bookingId, paymentId: outcome.payment.id },
          "Failed to alert admins about late Internet Banking capacity failure"
        )
      );
      sendBookingCancelledEmail(
        {
          bookingId: outcome.payment.booking.id,
          recipientMemberId: outcome.payment.booking.memberId,
        },
        outcome.payment.booking.member.email,
        outcome.payment.booking.member.firstName,
        outcome.payment.booking.checkIn,
        outcome.payment.booking.checkOut,
        outcome.credited ? outcome.creditedCents : outcome.payment.amountCents,
        "credit",
        0,
        outcome.payment.booking.lodgeId,
      ).catch((err) =>
        logger.error(
          { err, bookingId: outcome.payment.bookingId, paymentId: outcome.payment.id },
          "Failed to email member about late Internet Banking cancellation"
        )
      );
      processWaitlistForDates({
        checkIn: outcome.payment.booking.checkIn,
        checkOut: outcome.payment.booking.checkOut,
        lodgeId: outcome.payment.booking.lodgeId,
      }).catch((err) =>
        logger.error(
          { err, bookingId: outcome.payment.bookingId },
          "Failed to process waitlist after late Internet Banking cancellation"
        )
      );
      continue;
    }

    result.paidInternetBankingBookings += 1;

    try {
      await createAuditLog({
        action: "booking.payment.confirmed",
        targetId: outcome.payment.bookingId,
        subjectMemberId: outcome.payment.booking.memberId,
        entityType: "Booking",
        entityId: outcome.payment.bookingId,
        category: "payment",
        outcome: "success",
        summary: "Internet Banking payment confirmed from Xero",
        details: JSON.stringify({
          source: "xero-inbound-invoice",
          paymentId: outcome.payment.id,
          xeroInvoiceId: invoiceId,
          xeroInvoiceNumber: invoiceNumber,
          amountCents: outcome.payment.amountCents,
          finalCapacityClaimed:
            outcome.payment.booking.status === BookingStatus.PAYMENT_PENDING &&
            !outcome.payment.internetBankingHoldSlots,
        }),
        metadata: {
          source: "xero-inbound-invoice",
          paymentId: outcome.payment.id,
          paymentSource: PaymentSource.INTERNET_BANKING,
          xeroInvoiceId: invoiceId,
          xeroInvoiceNumber: invoiceNumber,
          amountCents: outcome.payment.amountCents,
          finalCapacityClaimed:
            outcome.payment.booking.status === BookingStatus.PAYMENT_PENDING &&
            !outcome.payment.internetBankingHoldSlots,
        },
      });
    } catch (err) {
      logger.error(
        { err, bookingId: outcome.payment.bookingId, paymentId: outcome.payment.id },
        "Failed to audit Internet Banking payment reconciliation"
      );
    }

    // #2265 (#2319 door 2). The settle cleared a stored credit election this
    // invoice could not honour — the member bank-transferred the full invoiced
    // amount while holding credit they had asked to spend. Reported through the
    // shared reporter so the member's booking history and the operator alert read
    // identically however the clear was reached.
    if (outcome.staleCreditElectionCents != null) {
      await reportUnappliedCreditElection({
        bookingId: outcome.payment.bookingId,
        memberId: outcome.payment.booking.memberId,
        memberFirstName: outcome.payment.booking.member.firstName,
        memberLastName: outcome.payment.booking.member.lastName,
        checkIn: outcome.payment.booking.checkIn,
        checkOut: outcome.payment.booking.checkOut,
        electionCents: outcome.staleCreditElectionCents,
        paidAmountCents: outcome.payment.amountCents,
        source: "xero-inbound-invoice",
        reference: invoiceId,
        extraDetails: { xeroInvoiceId: invoiceId, xeroInvoiceNumber: invoiceNumber },
      });
    }

    await recordBookingEvent({
      bookingId: outcome.payment.bookingId,
      type: BookingEventType.MEMBER_PAID,
      amountCents: outcome.payment.amountCents,
      reason: "Internet Banking payment reconciled from Xero.",
    });

    // Split-booking parent (#738/#1942): describe the provisional non-member
    // child so the Internet-Banking/invoice-settled confirmation explains the
    // separate later charge. Read-only; null on non-split bookings.
    const provisionalGuests = await getProvisionalNonMemberChildSummary({
      id: outcome.payment.bookingId,
      memberId: outcome.payment.booking.memberId,
    });

    sendBookingConfirmedEmail(
      {
        bookingId: outcome.payment.booking.id,
        recipientMemberId: outcome.payment.booking.memberId,
      },
      outcome.payment.booking.member.email,
      outcome.payment.booking.member.firstName,
      outcome.payment.booking.checkIn,
      outcome.payment.booking.checkOut,
      outcome.payment.booking.guests.length,
      outcome.payment.booking.finalPriceCents,
      {
        // Always thread the booking's lodge so the confirmation email carries
        // that lodge's name/travel note/door code, promo or not (multi-lodge).
        lodgeId: outcome.payment.booking.lodgeId,
        ...(provisionalGuests ? { provisionalGuests } : {}),
        ...(outcome.payment.booking.promoRedemption?.promoCode
          ? {
              discountCents: outcome.payment.booking.discountCents,
              promoAdjustmentCents: outcome.payment.booking.promoAdjustmentCents,
              promoCode: outcome.payment.booking.promoRedemption.promoCode.code,
            }
          : {}),
      }
    ).catch((err) =>
      logger.error(
        { err, bookingId: outcome.payment.bookingId, paymentId: outcome.payment.id },
        "Failed to send booking confirmation email after Internet Banking reconciliation"
      )
    );
  }

  return result;
}

/**
 * Match a paid Xero invoice to an Internet Banking group settlement and, when
 * found, flip every joiner child booking to PAID. This is the settlement parallel
 * to `syncInternetBankingPaymentsForPaidInvoice`: a single combined invoice
 * settles the whole ORGANISER_PAYS group at once.
 */
export async function syncGroupSettlementForPaidInvoice(invoice: Invoice) {
  const invoiceId = invoice.invoiceID ?? null;
  const result = {
    matchedGroupSettlements: 0,
    settledGroupSettlements: 0,
    settledChildBookings: 0,
    skippedNoCashEvidenceSettlements: 0,
  };

  if (!invoiceId || !isPaidXeroInvoice(invoice)) {
    return result;
  }

  const settlement = await prisma.groupBookingSettlement.findFirst({
    where: {
      xeroInvoiceId: invoiceId,
      source: PaymentSource.INTERNET_BANKING,
    },
    select: { id: true, status: true },
  });

  if (!settlement) {
    return result;
  }

  result.matchedGroupSettlements = 1;
  if (settlement.status === PaymentStatus.SUCCEEDED) {
    return result;
  }

  // #1435: the combined group invoice is subject to the same rule as the
  // per-payment loop above — a PAID event produced by credit-note allocation
  // (e.g. an operator writing the invoice off in Xero) carries zero cash and
  // must not flip a whole group of child bookings to PAID. The settlement
  // stays PENDING for the group-settlement reaper's normal expiry handling.
  const cashEvidence = classifyXeroInvoiceCashEvidence(invoice);
  if (cashEvidence !== "cash") {
    if (cashEvidence === "indeterminate") {
      // Same durable-deferral rule as the per-payment loop: hand the event
      // to the inbound FAILED-retry machinery rather than settling blind or
      // skipping terminally.
      logger.warn(
        { invoiceId, settlementId: settlement.id },
        "Xero PAID group settlement invoice payload carried neither amountPaid nor payments; refusing to settle without cash evidence"
      );
      throw new Error(
        `Xero PAID invoice ${invoiceId} carried neither amountPaid nor payments; refusing to settle group settlement ${settlement.id} without cash evidence (#1435)`
      );
    }
    result.skippedNoCashEvidenceSettlements = 1;
    logger.info(
      { invoiceId, settlementId: settlement.id },
      "Xero group settlement invoice reports PAID without cash payments (credit-note allocation); settlement skipped"
    );
    return result;
  }

  try {
    const applied = await applyGroupSettlementSucceededFromInvoice(invoiceId);
    if (applied.outcome === "settled") {
      result.settledGroupSettlements = 1;
      result.settledChildBookings = applied.settledBookingIds.length;
    } else if (
      applied.outcome === "amount_mismatch" ||
      applied.outcome === "cancelled"
    ) {
      // A child booking changed while the combined invoice sat open (#1033):
      // the bank transfer no longer matches what the children cost. Unlike
      // Stripe there is nothing to auto-refund, so alert the operators; the
      // settlement stays PENDING for manual reconciliation.
      logger.error(
        { invoiceId, settlementId: settlement.id },
        applied.outcome === "cancelled"
          ? "Paid group settlement invoice belongs to a cancelled group - operator refund required"
          : "Paid group settlement invoice no longer matches its children - operator review required"
      );
      const settlementDetail = await prisma.groupBookingSettlement.findUnique({
        where: { id: settlement.id },
        select: {
          amountCents: true,
          groupBooking: {
            select: {
              organiserMember: { select: { firstName: true, lastName: true } },
              organiserBooking: { select: { checkIn: true, checkOut: true } },
            },
          },
        },
      });
      await sendAdminPaymentFailureAlert({
        memberName: settlementDetail
          ? `${settlementDetail.groupBooking.organiserMember.firstName} ${settlementDetail.groupBooking.organiserMember.lastName}`
          : "Unknown group organiser",
        checkIn: settlementDetail?.groupBooking.organiserBooking.checkIn ?? null,
        checkOut: settlementDetail?.groupBooking.organiserBooking.checkOut ?? null,
        amountCents: settlementDetail?.amountCents ?? 0,
        errorMessage:
          applied.outcome === "cancelled"
            ? `Group settlement invoice ${invoiceId} was paid after the organiser cancelled the group. No child bookings were settled; refund or credit the organiser in Xero.`
            : `Group settlement invoice ${invoiceId} was paid, but a child booking changed while it was open so the total no longer matches. No bookings were settled; reconcile manually (short-pay/refund the difference or re-issue the settlement).`,
        paymentIntentId: invoiceId,
      }).catch((alertErr) =>
        logger.error(
          { err: alertErr, invoiceId, settlementId: settlement.id },
          "Failed to send admin alert for mismatched group settlement invoice"
        )
      );
    }
  } catch (err) {
    // #1887: same durable-deferral rule as the indeterminate-cash arms above
    // (#1435) — a failed apply (DB contention, lock timeout, capacity-lock
    // conflict) must not let the inbound event complete as PROCESSED, or the
    // settlement sits PENDING forever while the organiser's money is in the
    // bank and the group-settlement expiry path can later cancel the whole
    // group's child bookings despite payment. Rethrow so the event lands
    // FAILED and the backoff sweep re-fetches the invoice and retries.
    // (amount_mismatch above is the one intentionally-terminal outcome: it
    // returns a value, alerts the operators, and never reaches this catch.)
    logger.error(
      { err, invoiceId, settlementId: settlement.id },
      "Failed to settle group booking from paid Xero invoice"
    );
    throw err;
  }

  return result;
}
