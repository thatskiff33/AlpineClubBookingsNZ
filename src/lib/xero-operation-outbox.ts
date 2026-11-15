import { ORGANISER_COMBINED_INVOICE_PLACE_MESSAGE, ORGANISER_COMBINED_INVOICE_PLACE_REFUSAL } from "@/lib/organiser-billing";
import { paidByOrganiserInternetBanking } from "@/lib/group-organiser-paid";
import { executeOrganiserExtraAdjustment } from "@/lib/organiser-extra-adjustment";
import { XERO_OUTBOX_ORGANISER_EXTRA_ADJUSTMENT_TYPE } from "@/lib/organiser-extra-adjustment-payload";
import { PaymentSource, Prisma } from "@prisma/client";
import logger from "@/lib/logger";
import {
  createXeroMembershipCancellationCreditNote,
  syncXeroMembershipCancellationContact,
} from "@/lib/membership-cancellation-xero";
import { prisma } from "@/lib/prisma";
import { resolveRefundNoteEligibleCash } from "@/lib/refund-note-eligible-cash";
import {
  cardRefundNoteRowsWhere,
  paidAnotherWayCloseNoteRowsWhere,
  readPaidAnotherWayCloseShare,
} from "@/lib/card-refund-paid-another-way-cash";
import { claimXeroSyncOperationToRunning } from "@/lib/xero-operation-claim";
import { cardRefundNoteKey, readCardRefundNoteShare } from "@/lib/card-refund-own-note-share";
import { readClubTimeZoneOutsideRequest } from "@/lib/club-time-zone-runtime";
import { clubSeasonYear } from "@/lib/financial-year";
import { buildXeroBookingInvoiceCorrelationKey } from "@/lib/xero-booking-invoice-key";
import { findActivePrimaryInvoiceLink } from "@/lib/xero-booking-invoice-evidence";
import {
  buildXeroIdempotencyKey,
  completeXeroSyncOperation,
  failXeroSyncOperation,
  findCanonicalPaymentRefundCreditNote,
  startXeroSyncOperation,
  upsertXeroObjectLink,
} from "@/lib/xero-sync";
import { holdsRecordedXeroSuccess, NOT_A_XERO_REPAIR_CLAIM, ownRunningClaim, type XeroOperationClaim } from "@/lib/xero-operation-outcome-guard";
import {
  createXeroInvoiceForBooking,
  updateXeroBookingInvoiceForBooking,
} from "@/lib/xero-booking-invoices";
import {
  allocateCreditNoteToInvoice,
  createUnappliedXeroCreditNote,
  createUnappliedXeroCreditNoteForModification,
  createXeroCreditNote,
} from "@/lib/xero-credit-notes";
import { readRefundRequestIdFromPayload } from "@/lib/refund-request-credit-note";
import { refundNoteKeyAfterVoidParts } from "@/lib/xero-refund-note-status";
import { RefundNoteNotRecordedError, refundNoteRecordedElsewhere } from "@/lib/xero-refund-note-record";
import {
  readModificationNoteWording,
  readRefundNoteWording,
  type CashRefundMethod,
  type ModificationNoteWording,
  type RefundNoteWording,
} from "@/lib/xero-refund-method";
import { createXeroEntranceFeeInvoice } from "@/lib/xero-entrance-fee-invoices";
import {
  buildEntranceFeeInvoiceIdempotencyKey,
  ENTRANCE_FEE_EXEMPT_MESSAGE,
  getEntranceFeeContext,
  type EntranceFeeContext,
} from "@/lib/xero-mappings";
import { createXeroCreditNoteForModification } from "@/lib/xero-modification-credit-notes";
import { allocateAppliedCreditForBooking } from "@/lib/xero-applied-credit-allocation";
import { scanSpacesAdminGrantNotesAwaitingRetry } from "@/lib/admin-grant-credit-note";
import { scanSpacesGroupInvoiceEmailsDeferred } from "@/lib/xero-group-settlement-invoice-outbox";
import { createAdminGrantCreditNote } from "@/lib/xero-admin-grant-credit-note";
import { unallocatedAppliedCreditCentsByBooking } from "@/lib/xero-applied-credit-ledger-state";
import { deallocateExcessAppliedCreditForBooking } from "@/lib/xero-applied-credit-deallocation";
import { outboxScanLeavesAwaitingOwnNote, OWN_NOTE_EXPECTED_KEY } from "@/lib/unpaid-ask-billed-offset-order";
import { isXeroAppliedCreditOperationBusyError } from "@/lib/xero-applied-credit-operation-serialization";
import {
  findResolvedBookingInvoiceCreate,
  findResolvedSiblingSince,
  resolvedSiblingCopySkippedPayload,
  readResolvedRefundCreditNoteCoverage,
  sumRefundCreditNoteCoverageCents,
} from "@/lib/xero-resolved-in-xero-fences";
import { createXeroSupplementaryInvoice } from "@/lib/xero-supplementary-invoices";
import { createXeroKeptLateCaptureInvoice } from "@/lib/xero-kept-late-capture-invoice";
import { createXeroCardRefundReversalInvoice } from "@/lib/xero-card-refund-reversal-invoice";
import { XERO_OUTBOX_CARD_REFUND_REVERSAL_INVOICE_TYPE } from "@/lib/xero-card-refund-reversal-outbox";
import { recordAdditionalCaptureReceipt } from "@/lib/additional-capture-xero-receipt";
import { outboxScanSpacesWaitingReceipts } from "@/lib/additional-capture-receipt-gate";
import { scanSpacesRefundNotesAwaitingResolve } from "@/lib/xero-refund-note-in-flight";
import { XERO_OUTBOX_ADMIN_GRANT_CREDIT_NOTE_TYPE } from "@/lib/admin-grant-credit-note-payload";
import { isXeroConnected } from "@/lib/xero-token-store";
import { createXeroInvoiceForGroupSettlement } from "@/lib/xero-group-settlement-invoices";
import {
  voidXeroInvoiceForAbandonedGroupSettlement,
  voidXeroInvoiceForCancelledGroupSettlement,
} from "@/lib/xero-group-settlement-invoice-voids";
import { createXeroMembershipSubscriptionInvoice } from "@/lib/xero-subscription-invoices";
import {
  liveChargeWhere,
  membershipChargeNeedsNoInvoice,
} from "@/lib/subscription-charge-already-paid";
import {
  readXeroInvoiceEmailInstruction,
  type XeroInvoiceEmailInstruction,
} from "@/lib/xero-invoice-email-instruction";
import {
  getQueuedOutboxExpectedOperation,
  readQueuedOutboxPayload,
  readQueueType,
  subscriptionInvoiceChargeId,
  XERO_OUTBOX_ACCOUNT_CREDIT_NOTE_TYPE,
  XERO_OUTBOX_APPLIED_CREDIT_ALLOCATION_TYPE,
  XERO_OUTBOX_APPLIED_CREDIT_DEALLOCATION_TYPE,
  XERO_OUTBOX_BOOKING_INVOICE_TYPE,
  XERO_OUTBOX_BOOKING_INVOICE_UPDATE_TYPE,
  XERO_OUTBOX_CREDIT_NOTE_ALLOCATION_TYPE,
  XERO_OUTBOX_ENTRANCE_FEE_TYPE,
  XERO_OUTBOX_GROUP_SETTLEMENT_INVOICE_TYPE,
  XERO_OUTBOX_GROUP_SETTLEMENT_INVOICE_VOID_TYPE,
  XERO_OUTBOX_KEPT_LATE_CAPTURE_INVOICE_TYPE,
  XERO_OUTBOX_ADDITIONAL_CAPTURE_RECEIPT_TYPE,
  XERO_OUTBOX_MEMBERSHIP_CANCELLATION_CONTACT_TYPE,
  XERO_OUTBOX_MEMBERSHIP_CANCELLATION_CREDIT_NOTE_TYPE,
  XERO_OUTBOX_MODIFICATION_ACCOUNT_CREDIT_NOTE_TYPE,
  XERO_OUTBOX_MODIFICATION_CREDIT_NOTE_TYPE,
  XERO_OUTBOX_QUEUE_TYPES,
  XERO_OUTBOX_REFUND_CREDIT_NOTE_TYPE,
  XERO_OUTBOX_SUPPLEMENTARY_INVOICE_TYPE,
  XERO_OUTBOX_SUBSCRIPTION_INVOICE_TYPE,
  type QueuedOutboxExpectedOperation,
  type QueuedOutboxPayload,
} from "@/lib/xero-operation-outbox-payload";
import { linkReviewTaskId, queuedReviewTaskId, reviewTaskKeyParts } from "@/lib/xero-review-task-key";
import { supplementaryInvoicePayload } from "@/lib/xero-supplementary-invoice-enqueue";
import { OUTSTANDING_SUPPLEMENTARY_INVOICE_STATUSES, stillWaitingOnIntentWhere, waitingSupplementaryInvoiceOperationsWhere } from "@/lib/xero-supplementary-invoice-statuses";
import { formatDateOnly } from "@/lib/date-only";
import { clubFormatValues } from "@/lib/club-format-server";

/**
 * Was this operation REFUSED by a process-global Xero cooldown BEFORE any HTTP
 * call — i.e. never attempted against Xero — rather than attempted and failed?
 * (#2423 review F2)
 *
 * Keyed on the error NAME **plus its `preHttp` marker**, not `instanceof`.
 * Name-keying keeps this module decoupled from `xero-api-client`'s class
 * identities (which differ across the mock/live paths and under module mocking),
 * matching `getXeroApiErrorInfo` and `classifyOrganisationReadFailure`; reading
 * the plain `preHttp` property is equally identity-independent.
 *
 * The marker is the load-bearing part. `XeroDailyLimitError` has TWO
 * construction sites: the pre-HTTP daily gate (`throwIfXeroDailyLimitActive`,
 * also re-checked inside `getAuthenticatedXeroClient`) sets `preHttp: true`, but
 * `withXeroRetry` ALSO mints a fresh `XeroDailyLimitError` from a real HTTP 429
 * that Xero itself returned carrying `x-rate-limit-problem: day` — an ATTEMPTED
 * call — and that one carries `preHttp: false`. Keying on the bare name alone
 * (the pre-fix behaviour) would misclassify that attempted 429 as never-sent and
 * auto-re-drive an operation that may already have changed provider state.
 * Requiring `preHttp === true` makes "never attempted" a genuine invariant of
 * the classification rather than an accident of which queue types happen to
 * re-drive safely today: only a refusal raised before `fn()` ran is returned to
 * PENDING; every attempted failure — including a Xero-returned 429/day — keeps
 * the replayable FAILED path. A pre-HTTP refusal sent nothing, so there is no
 * invoice, credit note or allocation to duplicate and no provider-side state for
 * a re-drive to collide with, whatever the queue type. `XeroTransientOutageError`
 * has only the pre-HTTP construction site, but is marked and checked the same
 * way for symmetry and to stay safe if a post-HTTP use is ever added.
 *
 * `XeroContactEnvironmentUnknownError` (#3036) joins them on the same terms: the
 * environment-role gate that raises it runs before the request is built, so it
 * cannot have reached Xero, and it carries the same `preHttp` marker so the
 * requirement below is a check rather than a courtesy. The state it reports is
 * transient in exactly the way a re-drive needs — an unreadable
 * `EnvironmentSafetySettings` row, or a declaration that has since been set — so
 * an operation refused by it is the clearest case there is of one that belongs
 * back on PENDING rather than needing a hand requeue.
 */
function isXeroCooldownRefusal(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false;
  }
  const isCooldownName =
    error.name === "XeroTransientOutageError" ||
    error.name === "XeroDailyLimitError" ||
    /*
      #3036: the environment-role gate inside `callXeroApi` refuses a Xero
      MUTATION while nothing has declared whether this installation is the club's
      live site or a copy. It sits ahead of `withXeroRetry` and ahead of the
      usage meter, so its refusal is pre-HTTP by construction and the class
      carries `preHttp = true` — which is what the requirement below then
      verifies rather than assumes. Without this name the refusal took the
      ordinary path, and twelve of fifteen handlers have written `status: FAILED`
      by that point, leaving never-attempted operations terminally failed: the
      defect this predicate exists to prevent (#2423 F2).
    */
    error.name === "XeroContactEnvironmentUnknownError";
  return (
    isCooldownName && (error as { preHttp?: unknown }).preHttp === true
  );
}

async function claimQueuedOutboxOperation(
  operationId: string,
  expectedOperation: QueuedOutboxExpectedOperation
) {
  // Delegates to the shared claim-to-RUNNING single-flight (#1272). The guard
  // below is the outbound-outbox predicate; combined with the helper's
  // `status: "PENDING"` precondition the resulting WHERE is identical to the
  // pre-consolidation inline claim.
  return claimXeroSyncOperationToRunning(operationId, {
    direction: "OUTBOUND",
    entityType: expectedOperation.entityType,
    operationType: expectedOperation.operationType,
    localModel: {
      in: [...expectedOperation.localModels],
    },
  });
}

function buildPrecomputedEntranceFeeContext(
  payload: QueuedOutboxPayload
): EntranceFeeContext | null {
  if (
    payload.queueType !== XERO_OUTBOX_ENTRANCE_FEE_TYPE ||
    !payload.category ||
    payload.feeAmountCents === null ||
    payload.feeAmountCents === undefined
  ) {
    return null;
  }

  const entranceFeeContext: EntranceFeeContext = {
    category: payload.category,
    feeMapping: {
      itemCode: payload.itemCode ?? null,
      amountCents: payload.feeAmountCents,
    },
  };
  if (payload.description) {
    entranceFeeContext.description = payload.description;
  }

  return entranceFeeContext;
}

export async function enqueueXeroEntranceFeeInvoiceOperation(
  memberId: string,
  options?: {
    createdByMemberId?: string;
    amountCents?: number | null;
    description?: string | null;
    store?: Prisma.TransactionClient;
    /**
     * The membership season the joining fee is resolved in. REQUIRED alongside
     * `store`: the chain below (`getEntranceFeeContext` ->
     * `resolveMemberJoiningFeeClassification`) would otherwise read the club's
     * timezone on the global client while the caller's transaction holds its
     * advisory locks, and that season picks the `JoiningFee` row whose amount
     * lands on an immutable invoice (#2870, correctness review).
     */
    seasonYear?: number;
    /**
     * The day the joining fee's schedule window is evaluated on. REQUIRED
     * alongside `store` for the identical reason as `seasonYear`, and enforced
     * by `getEntranceFeeContext` (#3123): it selects the `JoiningFee` row whose
     * `amountCents` lands on an immutable invoice, and resolving it below a
     * caller's open transaction would read `ClubTimeSettings` on the global
     * client while that transaction holds its advisory locks.
     */
    asOf?: Date;
  }
) {
  // Optional transaction client (#1886, F22) so membership approval can write
  // this outbox row inside the same transaction that creates the member and
  // approves the application — the joining fee then commits atomically with
  // the approval instead of riding a post-commit crash window that silently
  // lost the invoice. Every internal read/write goes through the same client
  // (mirroring enqueueXeroRefundCreditNoteOperation, #1357) so the member and
  // family-group rows created in that still-open transaction are visible and
  // the #1354 correlation-key dedupe sees a consistent state. Defaults to the
  // global `prisma`, keeping existing callers unchanged. Only the durable row
  // write happens here — dispatching the live Xero call stays a post-commit
  // concern for the caller.
  const db = options?.store ?? prisma;

  const existingLink = await db.xeroObjectLink.findFirst({
    where: {
      localModel: "Member",
      localId: memberId,
      xeroObjectType: "INVOICE",
      role: "ENTRANCE_FEE_INVOICE",
      active: true,
    },
    select: { id: true },
  });

  if (existingLink) {
    return {
      queueOperationId: null,
      message: "Xero joining fee invoice already linked for this member.",
    };
  }

  const entranceFee = await getEntranceFeeContext(
    memberId,
    db,
    options?.seasonYear,
    options?.asOf,
  );

  // Organisations/schools are exempt from joining fees (owner decision,
  // 2026-07-07) — checked before the amount override so an explicitly
  // entered amount can never bill an organisation.
  if (entranceFee.exempt) {
    return {
      queueOperationId: null,
      message: ENTRANCE_FEE_EXEMPT_MESSAGE,
    };
  }

  const feeAmountCents =
    options?.amountCents ?? entranceFee.feeMapping.amountCents;
  const description = options?.description?.trim() || null;

  if (!feeAmountCents || feeAmountCents <= 0) {
    return {
      queueOperationId: null,
      message: "No joining fee is configured for this membership type.",
    };
  }

  const correlationKey = buildEntranceFeeInvoiceIdempotencyKey(
    memberId,
    entranceFee.category,
    feeAmountCents
  );

  const existingQueuedOperation = await db.xeroSyncOperation.findFirst({
    where: {
      correlationKey,
      direction: "OUTBOUND",
      entityType: "INVOICE",
      operationType: "CREATE",
      localModel: "Member",
      localId: memberId,
      status: {
        in: ["PENDING", "RUNNING"],
      },
    },
    orderBy: {
      createdAt: "desc",
    },
  });

  if (existingQueuedOperation) {
    return {
      queueOperationId: existingQueuedOperation.id,
      message: "Xero joining fee invoice is already queued for background processing.",
    };
  }

  const queuedOperation = await startXeroSyncOperation({
    direction: "OUTBOUND",
    entityType: "INVOICE",
    operationType: "CREATE",
    localModel: "Member",
    localId: memberId,
    status: "PENDING",
    idempotencyKey: correlationKey,
    correlationKey,
    requestPayload: {
      queueType: XERO_OUTBOX_ENTRANCE_FEE_TYPE,
      category: entranceFee.category,
      itemCode: entranceFee.feeMapping.itemCode,
      feeAmountCents,
      ...(description ? { description } : {}),
    },
    createdByMemberId: options?.createdByMemberId ?? null,
    store: db,
  });

  return {
    queueOperationId: queuedOperation.id,
    message: "Xero joining fee invoice queued for background processing.",
  };
}

/**
 * The creation-time instruction a PREVIOUS enqueue of THIS SAME invoice
 * recorded (#2929).
 *
 * ## The hole this closes
 *
 * The dedup above short-circuits only on a `PENDING` or `RUNNING` row, and the
 * `existingLink` check above it only on an invoice that was actually raised. A
 * booking whose invoice operation `FAILED` — or finished `PARTIAL` without
 * raising one — therefore has neither, and any surface that re-drives it mints a
 * FRESH operation: the admin "queue missing invoices" sweep, force-sync, and the
 * repair pass's primary-invoice queue. Each of those passes `null`, because none
 * of them has an officer in front of it to ask. Without this, the fresh row
 * records nothing, the dispatcher reads nothing, and Xero emails the member the
 * invoice the officer chose to withhold — from a re-drive nobody watched. That
 * is the same failure as the lost caller flag, arriving by a different door.
 *
 * ## Why inheriting is the right answer and not a widening
 *
 * The correlation key IS the invoice: `booking:<id>:invoice:v1`, one per
 * booking, and only ever one PRIMARY invoice behind it. So a later operation
 * under that key is not a new decision — it is the same invoice creation being
 * attempted again. The instruction belongs to the invoice, not to the row that
 * happened to carry it first, and re-minting a row must not forget it. This is
 * exactly the "persist across retry/replay" the issue asks for; a re-mint is a
 * replay that happens to need a new row.
 *
 * ## Why it cannot pick up a stranger's withhold
 *
 * Only the on-behalf booking create ever writes a non-null value, and it writes
 * one only where it enqueues: the Internet Banking create, and the zero-dollar
 * confirmed create. The card path enqueues no booking invoice at all, so it
 * leaves no row to inherit from; and `switch-to-internet-banking`, the one route
 * that could later raise a first invoice for a booking that had none, admits
 * only a `PAYMENT_PENDING` booking, which a zero-dollar create never leaves
 * behind (it is `CONFIRMED`). Rows written before #2929 are null and are skipped
 * by the `not: null` filter, so an older null can never mask a newer choice.
 *
 * Returns `null` when no previous operation expressed a choice, which is every
 * booking this feature never touched.
 */
async function inheritedBookingInvoiceEmailInstruction(params: {
  correlationKey: string;
  paymentId: string;
}): Promise<XeroInvoiceEmailInstruction | null> {
  const previous = await prisma.xeroSyncOperation.findFirst({
    where: {
      correlationKey: params.correlationKey,
      direction: "OUTBOUND",
      entityType: "INVOICE",
      operationType: "CREATE",
      localModel: "Payment",
      localId: params.paymentId,
      invoiceEmailDelivery: { not: null },
    },
    orderBy: { createdAt: "desc" },
    select: { invoiceEmailDelivery: true },
  });
  // Through the reader, never the raw column: an unrecognised stored value must
  // parse to "no instruction" rather than be copied forward as one.
  return readXeroInvoiceEmailInstruction(previous?.invoiceEmailDelivery);
}

export async function enqueueXeroBookingInvoiceOperation(
  bookingId: string,
  options: {
    createdByMemberId?: string;
    /**
     * The creation-time Xero-invoice-email delivery instruction (#2929).
     *
     * REQUIRED, and nullable rather than optional, so that a new booking-invoice
     * enqueuer is a COMPILE ERROR until its author says which it is. This
     * repository's rule is that a required argument beats a lint rule
     * (`INV-SSOT`), and the module next door already settled the identical
     * question the same way: every send carries a required, typed context.
     * Optional here, the next enqueuer added would omit the field, compile,
     * and email the member the officer chose not to email. (No ordinal here on
     * purpose: the live population is counted and enumerated in ONE place, the
     * `xero-operation-outbox` census that names every null-passing caller, so a
     * second count cannot drift out of step with it.)
     *
     * `null` means "this caller has no creation-time choice to express" — which
     * is every enqueuer but the on-behalf booking create. It is not the same as
     * `SEND`: see {@link inheritedBookingInvoiceEmailInstruction}, which lets a
     * null-passing RE-MINT of the same invoice keep the instruction the original
     * enqueue recorded.
     *
     * It is recorded on the operation row rather than carried in the call
     * because the invoice is raised by a worker later, and possibly by an
     * operator retry later still.
     */
    invoiceEmailDelivery: XeroInvoiceEmailInstruction | null;
    /**
     * #3635 (`INV-INT-025`): raise the invoice even though an officer resolved
     * the last create in Xero. Only the single-booking force-sync passes it,
     * and it audits the override; every other enqueuer is refused.
     */
    overrideResolvedInXero?: boolean;
  }
) {
  const booking = await prisma.booking.findUnique({
    where: { id: bookingId },
    select: {
      id: true,
      organiserSettled: true,
      parentBookingId: true,
      payment: {
        select: {
          id: true,
          xeroInvoiceId: true,
          manuallyMarkedPaidAt: true,
          source: true,
        },
      },
    },
  });

  if (!booking) {
    throw new Error(`Booking not found: ${bookingId}`);
  }

  if (!booking.payment) {
    throw new Error(`No payment record for booking: ${bookingId}`);
  }

  if (booking.payment.xeroInvoiceId) {
    return {
      queueOperationId: null,
      message: "Xero booking invoice already linked for this booking.",
    };
  }

  // B5 (#2262) HIGH #2, level 1 — the outbound invoice-mint fence, placed at
  // the CHOKE POINT so it covers all thirteen enqueuers (booking-create,
  // confirm-draft, waitlist-confirm, charge-saved-method, switch-to-IB,
  // confirm-pending-guests, cron-confirm-pending, group-settlement,
  // school-booking-request, xero-booking-edit-settlement,
  // admin-payment-invoice-service, the invoice queue, and the admin
  // missing-invoices / force-sync / repair surfaces) plus every future one.
  //
  // A manually settled booking is PAID with source INTERNET_BANKING and no
  // invoice — exactly the shape these surfaces read as "missing invoice, mint
  // one". Left unfenced they would create a real AWAITING-PAYMENT invoice in
  // Xero and EMAIL IT TO THE MEMBER (createXeroInvoiceForBooking emails the
  // invoice precisely when source is INTERNET_BANKING) for money the club
  // already holds in cash.
  //
  // Provenance is `manuallyMarkedPaidAt` ALONE — never conjoined with "has no
  // Xero id" — because two stampers outside the cash-settle loop can
  // legitimately stamp a Xero id onto a manual row, and that must not launder
  // the row's provenance away from this fence.
  //
  // Returns the existing skip shape, which every caller already handles (the
  // repair pass maps a null queueOperationId to "skipped"; the force-sync and
  // missing-invoices routes surface the message), but logs at WARN so a
  // repeated attempt is visible rather than silent.
  if (booking.payment.manuallyMarkedPaidAt) {
    logger.warn(
      {
        bookingId,
        paymentId: booking.payment.id,
        manuallyMarkedPaidAt: booking.payment.manuallyMarkedPaidAt,
      },
      "Refusing to queue a Xero booking invoice for a manually marked-paid booking (#2262)"
    );
    return {
      queueOperationId: null,
      message:
        "Booking was manually marked paid (cash / off-Xero) — no Xero invoice is expected.",
    };
  }

  // #4299 B1 (`INV-PAY-148`): a place the group organiser paid by internet
  // banking is settled on the organiser's combined invoice and has no invoice
  // of its own by design. A primary invoice here would bill, and email, the
  // joiner for the whole place, so no enqueuer may mint one - the same
  // choke-point placement as the manual-settlement fence above. Its extras go
  // to the organiser on supplementary invoices, never through here.
  if (paidByOrganiserInternetBanking(booking)) {
    logger.warn(
      { bookingId, paymentId: booking.payment.id },
      "Refusing to queue a Xero booking invoice for an organiser-paid internet-banking place (#4299)"
    );
    return {
      queueOperationId: null,
      refusal: ORGANISER_COMBINED_INVOICE_PLACE_REFUSAL,
      message: ORGANISER_COMBINED_INVOICE_PLACE_MESSAGE,
    };
  }

  // #3001: the SAME predicate the booking page's warning asks, from its one
  // home. Both are asking "does an invoice for this booking already exist in
  // Xero?" — here to refuse a second mint, there to refuse to tell an officer
  // that no invoice exists. Two spellings of one question is how those two
  // answers drift apart.
  const existingLink = await findActivePrimaryInvoiceLink(booking.payment.id);

  if (existingLink) {
    return {
      queueOperationId: null,
      message: "Xero booking invoice already linked for this booking.",
    };
  }

  // #3635 (`INV-INT-025`): an officer raised this invoice by hand in Xero and
  // resolved the create, so a new one would bill the member twice.
  const resolvedCreate = await findResolvedBookingInvoiceCreate(booking.payment.id);
  if (resolvedCreate && !options.overrideResolvedInXero) {
    return {
      queueOperationId: null,
      resolvedInXeroOperationId: resolvedCreate.id,
      message:
        "An officer resolved this booking's Xero invoice by hand in Xero, so no new invoice is queued.",
    };
  }

  const correlationKey = buildXeroBookingInvoiceCorrelationKey(bookingId);

  const existingQueuedOperation = await prisma.xeroSyncOperation.findFirst({
    where: {
      correlationKey,
      direction: "OUTBOUND",
      entityType: "INVOICE",
      operationType: "CREATE",
      localModel: "Payment",
      localId: booking.payment.id,
      status: {
        in: ["PENDING", "RUNNING"],
      },
    },
    orderBy: {
      createdAt: "desc",
    },
  });

  if (existingQueuedOperation) {
    return {
      queueOperationId: existingQueuedOperation.id,
      message: "Xero booking invoice is already queued for background processing.",
    };
  }

  const queuedOperation = await startXeroSyncOperation({
    direction: "OUTBOUND",
    entityType: "INVOICE",
    operationType: "CREATE",
    localModel: "Payment",
    localId: booking.payment.id,
    status: "PENDING",
    idempotencyKey: correlationKey,
    correlationKey,
    requestPayload: {
      queueType: XERO_OUTBOX_BOOKING_INVOICE_TYPE,
      bookingId,
    },
    invoiceEmailDelivery:
      options.invoiceEmailDelivery ??
      (await inheritedBookingInvoiceEmailInstruction({
        correlationKey,
        paymentId: booking.payment.id,
      })),
    createdByMemberId: options?.createdByMemberId ?? null,
  });

  return {
    queueOperationId: queuedOperation.id,
    message: "Xero booking invoice queued for background processing.",
    // #3635: set only when force-sync overrode an officer's resolve, so it can
    // say so in its audit row.
    ...(resolvedCreate ? { overrodeResolvedInXeroOperationId: resolvedCreate.id } : {}),
  };
}

/**
 * #1620 — enqueue the applied-credit allocation orchestration op for a booking.
 * Skips when the booking carries no unallocated applied credit. The handler runs
 * after the invoice op and reduces the invoice to the effective amount by
 * allocating the member's existing floating credit notes.
 *
 * Payment-method-agnostic (#1641): keyed on the booking's payment + BOOKING_APPLIED
 * ledger, never on payment.source. In #1620 the only call sites are Internet
 * Banking (create-time IB + switch-to-IB); #1641 adds a card caller.
 */
export async function enqueueXeroAppliedCreditAllocationOperation(
  bookingId: string,
  options?: { createdByMemberId?: string }
) {
  const booking = await prisma.booking.findUnique({
    where: { id: bookingId },
    select: {
      id: true,
      payment: { select: { id: true } },
    },
  });

  if (!booking?.payment) {
    return {
      queueOperationId: null,
      message: "No payment record for booking; nothing to allocate.",
    };
  }

  // Unallocated applied credit: the engine's own predicate (#3836, one form).
  const appliedCents = (await unallocatedAppliedCreditCentsByBooking([bookingId])).get(bookingId) ?? 0;
  if (appliedCents === 0) {
    return {
      queueOperationId: null,
      message: "No unallocated applied credit; nothing to allocate.",
    };
  }

  const correlationKey = buildXeroIdempotencyKey(
    "booking",
    bookingId,
    "applied-credit-allocation",
    "v1"
  );

  const existingQueuedOperation = await prisma.xeroSyncOperation.findFirst({
    where: {
      correlationKey,
      direction: "OUTBOUND",
      entityType: "ALLOCATION",
      operationType: "ALLOCATE",
      localModel: "Payment",
      localId: booking.payment.id,
      status: { in: ["PENDING", "RUNNING"] },
    },
    orderBy: { createdAt: "desc" },
  });
  if (existingQueuedOperation) {
    return {
      queueOperationId: existingQueuedOperation.id,
      message: "Applied-credit allocation is already queued for background processing.",
    };
  }

  const queuedOperation = await startXeroSyncOperation({
    direction: "OUTBOUND",
    entityType: "ALLOCATION",
    operationType: "ALLOCATE",
    localModel: "Payment",
    localId: booking.payment.id,
    status: "PENDING",
    idempotencyKey: correlationKey,
    correlationKey,
    requestPayload: {
      queueType: XERO_OUTBOX_APPLIED_CREDIT_ALLOCATION_TYPE,
      bookingId,
    },
    createdByMemberId: options?.createdByMemberId ?? null,
  });

  return {
    queueOperationId: queuedOperation.id,
    message: "Applied-credit allocation queued for background processing.",
  };
}

export async function enqueueXeroBookingInvoiceUpdateOperation(
  bookingId: string,
  options?: { createdByMemberId?: string }
) {
  const booking = await prisma.booking.findUnique({
    where: { id: bookingId },
    select: {
      id: true,
      checkIn: true,
      checkOut: true,
      payment: {
        select: {
          id: true,
          xeroInvoiceId: true,
        },
      },
    },
  });

  if (!booking) {
    throw new Error(`Booking not found: ${bookingId}`);
  }

  if (!booking.payment) {
    throw new Error(`No payment record for booking: ${bookingId}`);
  }

  if (!booking.payment.xeroInvoiceId) {
    return {
      queueOperationId: null,
      message: "No original Xero invoice exists for this booking.",
    };
  }

  const correlationKey = buildXeroIdempotencyKey(
    "booking",
    bookingId,
    "invoice-update",
    booking.payment.xeroInvoiceId,
    formatDateOnly(booking.checkIn),
    formatDateOnly(booking.checkOut),
    "v1"
  );

  const existingQueuedOperation = await prisma.xeroSyncOperation.findFirst({
    where: {
      correlationKey,
      direction: "OUTBOUND",
      entityType: "INVOICE",
      operationType: "UPDATE",
      localModel: "Payment",
      localId: booking.payment.id,
      status: {
        in: ["PENDING", "RUNNING"],
      },
    },
    orderBy: {
      createdAt: "desc",
    },
  });

  if (existingQueuedOperation) {
    return {
      queueOperationId: existingQueuedOperation.id,
      message: "Xero booking invoice update is already queued for background processing.",
    };
  }

  const queuedOperation = await startXeroSyncOperation({
    direction: "OUTBOUND",
    entityType: "INVOICE",
    operationType: "UPDATE",
    localModel: "Payment",
    localId: booking.payment.id,
    status: "PENDING",
    idempotencyKey: correlationKey,
    correlationKey,
    requestPayload: {
      queueType: XERO_OUTBOX_BOOKING_INVOICE_UPDATE_TYPE,
      bookingId,
      xeroInvoiceId: booking.payment.xeroInvoiceId,
    },
    createdByMemberId: options?.createdByMemberId ?? null,
  });

  return {
    queueOperationId: queuedOperation.id,
    message: "Xero booking invoice update queued for background processing.",
  };
}

/**
 * How the money went back (`INV-PAY-101`, #3529), from the caller that made
 * the settlement decision. Omitted, the executor reads the payment's source:
 * Stripe money can only have left through Stripe.
 *
 * #3935 (`INV-PAY-116`): the officer's "In cash" answer on a review's
 * hand-back words the note too - words only, never in the key or the
 * settlement - and is representable only beside the internet-banking method,
 * so a card note can never be asked to say it.
 */
type RefundMethodAndNoteWording =
  | { refundMethod: "internet-banking"; noteWording?: RefundNoteWording }
  | { refundMethod?: CashRefundMethod; noteWording?: undefined };

export async function enqueueXeroRefundCreditNoteOperation(
  paymentId: string,
  refundAmountCents: number,
  options?: RefundMethodAndNoteWording & {
    createdByMemberId?: string;
    store?: Prisma.TransactionClient;
    /**
     * #3635 round-3 R4: the late capture this note answers, recorded on the
     * note so its refunds are noted once per capture
     * (`sumLateCaptureNotedCents`), and the note names that capture's receipt.
     */
    paymentIntentId?: string;
    /**
     * #3635 round-3 R3: the club day the refund left Stripe (`YYYY-MM-DD`),
     * for a note raised after the fact. Omitted, the note is dated today.
     */
    documentDate?: string;
    /** #3880: a review's refund on a CANCELLED booking - keyed on the task, and
     * noted per refund, capped by coverage, on a bank transfer as on a card. */
    reviewTaskId?: string;
    /**
     * #3924 round 4 (M3, `INV-PAY-122`): the bank record this note answers - a
     * "Paid another way" close, a card refund shortfall (#4097), a re-confirmed
     * bank refund (#4162) or a later cancellation hand-back (#4287,
     * `INV-ADDPAY-043`). Keyed on it, so its note is a row of its own beside any
     * other note on the payment. Round 8: sized by the record alone - what it
     * paid back less what its own notes cover (`readPaidAnotherWayCloseShare`),
     * and never above `refundAmountCents` (#4104).
     */
    paidAnotherWayTaskId?: string;
    /**
     * #3924 round 7 (money M5, `INV-PAY-122`): the invoice this note credits,
     * when the caller knows it - a paid-another-way close of a late capture's
     * refund names that capture's receipt. Never `paymentIntentId` for that:
     * a note recording the capture is counted as the capture's CARD refund note
     * (`sumLateCaptureNotedCents`), and would mask a later Stripe refund of it.
     */
    creditsInvoiceId?: string;
    /**
     * #4162 (`INV-ADDPAY-042`): the bank hand-back task whose completion this
     * note records. Payload only - never part of the key or the sizing - so a
     * void of the note can be matched to the hand-back it recorded
     * (`bank-refund-void-scan.ts`).
     */
    handBackTaskId?: string;
    /**
     * #4312 (`INV-ADDPAY-047`): the card refund (its `stripeRefundId`) on a
     * bank-transfer payment this note answers. Keyed and sized on that refund
     * alone (`readCardRefundNoteShare`), as a close's note is on its record.
     */
    cardRefundId?: string;
  }
) {
  // Optional transaction client (#1357) so callers (e.g. the Internet Banking
  // hold-expiry cron) can enqueue the outbox row inside the same transaction
  // that releases the hold — the invoice-clearing intent then commits
  // atomically with the release instead of riding a post-commit crash window.
  // Every internal read/write goes through the same client so the #1354
  // correlation-key dedupe sees a consistent (uncommitted) state. Defaults to
  // the global `prisma`, keeping existing callers unchanged.
  const db = options?.store ?? prisma;

  const payment = await db.payment.findUnique({
    where: { id: paymentId },
    select: {
      id: true,
      bookingId: true,
      source: true,
      refundedAmountCents: true,
      xeroRefundCreditNoteId: true,
    },
  });

  if (!payment) {
    throw new Error(`Payment not found: ${paymentId}`);
  }

  if (refundAmountCents <= 0) {
    return {
      queueOperationId: null,
      message: "No additional Xero refund credit note is required for this payment.",
    };
  }

  // #3635 (`INV-INT-025`): a refund note an officer raised by hand in Xero and
  // resolved has no local link, so link coverage alone reads it as missing.
  // Its RECORDED amount counts as covered - never a per-payment block, so a
  // later, different refund on this payment still gets its own note.
  const resolvedCoverage = await readResolvedRefundCreditNoteCoverage(paymentId, db);
  if (resolvedCoverage.unreadableOperationIds.length > 0) {
    // Refused LOUDLY: the amount the officer covered cannot be read, so any
    // figure here could credit the member twice or leave a refund unrecorded.
    logger.error(
      {
        paymentId,
        refundAmountCents,
        resolvedOperationIds: resolvedCoverage.unreadableOperationIds,
      },
      "Refusing to queue a Xero refund credit note: a note resolved by hand in Xero on this payment has no readable amount (#3635)"
    );
    return {
      queueOperationId: null,
      resolvedInXeroOperationId: resolvedCoverage.unreadableOperationIds[0],
      message:
        "A refund credit note on this payment was resolved by hand in Xero and its amount cannot be read, so no new note is queued. Raise this refund's credit note in Xero by hand.",
    };
  }

  const canonicalLink = await findCanonicalPaymentRefundCreditNote(paymentId, db);
  let noteAmountCents = refundAmountCents;
  let watermarkCents = refundAmountCents;

  // #3924 round 7 (concurrency C8): a paid-another-way close's note is one of
  // several on its payment whatever the payment's source - an internet-banking
  // payment can carry a card refund (an edit's Stripe capture). The single-note
  // branch below would read the payment's other note as this one's and write
  // the Payment row, which the receipt's worker must not do under the task row.
  const stepped =
    payment.source === PaymentSource.STRIPE ||
    Boolean(options?.reviewTaskId) ||
    Boolean(options?.paidAnotherWayTaskId) ||
    Boolean(options?.cardRefundId);
  // #4312: what a card refund's own notes already cover, which keys its note.
  let cardRefundCoveredCents: number | null = null;
  if (stepped) {
    // Stripe payments can be refunded in several steps, and each step needs
    // its own credit note for the still-uncovered delta. The cumulative total
    // a refund note may cover is the provider-backed CASH evidence (#2902,
    // INV-PAY-050: succeeded PaymentRefund rows, with the pre-ledger legacy
    // fallback) — NEVER the raw refundedAmountCents mirror, which also counts
    // account-credit dispositions. The evidence already includes this delta
    // at enqueue time (the cash paths record the ledger row before enqueuing),
    // so capping the note to `cashRefundCents - coveredCents` yields this
    // delta while replays of an already-covered state — and account-credit
    // cancellations, whose cash evidence is zero — cap at zero.
    const coveredCents = await sumRefundCreditNoteCoverageCents(
      paymentId,
      resolvedCoverage,
      db
    );
    if (options?.paidAnotherWayTaskId) {
      // #3924 round 8 (money review, `INV-PAY-122`): a close's note is sized by
      // its record - exactly what it paid back less what its OWN notes already
      // cover (`readPaidAnotherWayCloseShare`) - never by the payment-wide gap,
      // which an internet-banking payment's earlier hand-backs, or any other
      // refund's note, could shrink or empty.
      const share = await readPaidAnotherWayCloseShare(db, paymentId, options.paidAnotherWayTaskId);
      if (!share) {
        throw new Error(
          `Refusing to queue a Xero refund note for payment ${paymentId}: its bank record ${options.paidAnotherWayTaskId} (a paid-another-way close, a shortfall, a re-confirmed refund or a completed hand-back) is not on this payment`
        );
      }
      // Never more than the caller asks for. A covered failed-later close asks
      // for the whole amount (`INV-PAY-151`); the record no longer stores a
      // card-note cover that would shrink it.
      noteAmountCents = Math.min(refundAmountCents, share.uncoveredCents);
    } else if (options?.cardRefundId) {
      // #4312 (`INV-ADDPAY-047`): sized by the refund alone, never the payment-wide gap.
      const share = await readCardRefundNoteShare(db, paymentId, options.cardRefundId);
      if (!share) throw new Error(`Refusing to queue a Xero refund note for payment ${paymentId}: its card refund ${options.cardRefundId} is not on this payment`);
      noteAmountCents = Math.min(refundAmountCents, share.uncoveredCents);
      cardRefundCoveredCents = share.coveredCents;
    } else {
      // #3635 round-3 R1: the cash a note may answer, which leaves out refunds of
      // late captures the app never recorded in Xero (`INV-PAY-110`).
      const { eligibleCashCents } = await resolveRefundNoteEligibleCash(payment, db);
      noteAmountCents = Math.max(
        0,
        Math.min(refundAmountCents, eligibleCashCents - coveredCents)
      );
    }
    watermarkCents = coveredCents + noteAmountCents;
    if (noteAmountCents <= 0) {
      if (resolvedCoverage.coveredCents > 0) {
        logger.info(
          { paymentId, resolvedInXeroCents: resolvedCoverage.coveredCents },
          "Xero refund credit note not queued: notes raised by hand in Xero cover this payment's cash refunds (#3635)"
        );
      }
      return {
        queueOperationId: null,
        message: options?.paidAnotherWayTaskId
          ? "This paid-another-way close's own refund credit notes already cover what it paid back."
          : options?.cardRefundId
          ? "This card refund's own refund credit notes already cover it, or it gets no note of its own."
          : "No provider-backed Stripe cash refund remains uncovered by refund credit notes for this payment.",
      };
    }
  } else if (canonicalLink) {
    // Non-Stripe callers that name no record of their own (internet-banking cron,
    // group-cancel) re-enqueue on reruns; the single-note skip absorbs those replays
    // by repointing. #4287: a later hand-back names its own (`paidAnotherWayTaskId`).
    if (payment.xeroRefundCreditNoteId !== canonicalLink.xeroObjectId) {
      await db.payment.update({
        where: { id: paymentId },
        data: {
          xeroRefundCreditNoteId: canonicalLink.xeroObjectId,
        },
      });
    }
    await upsertXeroObjectLink(
      {
        localModel: "Payment",
        localId: paymentId,
        xeroObjectType: "CREDIT_NOTE",
        xeroObjectId: canonicalLink.xeroObjectId,
        xeroObjectNumber: canonicalLink.xeroObjectNumber,
        role: "REFUND_CREDIT_NOTE",
      },
      options?.store ? { store: options.store } : undefined
    );

    return {
      queueOperationId: null,
      message: "Xero refund credit note already linked for this payment.",
    };
  }

  // The cumulative watermark distinguishes equal-amount Stripe deltas so each one
  // gets its own note, while replays of the same state produce the same key and
  // collide into the PENDING/RUNNING dedupe just below.
  const correlationKey = options?.cardRefundId && cardRefundCoveredCents !== null
    ? await cardRefundNoteKey(paymentId, options.cardRefundId, cardRefundCoveredCents, db) // #4312: one row per refund
    : buildXeroIdempotencyKey(
    "payment", paymentId, "refund-credit-note", stepped ? watermarkCents : noteAmountCents, stepped ? "v2" : "v1",
    ...reviewTaskKeyParts(options?.reviewTaskId),
    ...(options?.paidAnotherWayTaskId ? ["paid-another-way", options.paidAnotherWayTaskId] : []),
    ...(await refundNoteKeyAfterVoidParts(paymentId, options?.paidAnotherWayTaskId // `INV-ADDPAY-041`, the executor's rule
      ? { closeRowsWhere: paidAnotherWayCloseNoteRowsWhere(paymentId, options.paidAnotherWayTaskId) } : stepped ? { watermarkCents } : { amountCents: noteAmountCents }, db))
  );


  // #3635: a non-Stripe payment issues one refund, so the resolved create for
  // THIS refund carries this very key; its hand-made note covers it.
  const resolvedKeyIndex = resolvedCoverage.correlationKeys.indexOf(correlationKey);
  if (resolvedKeyIndex >= 0) {
    logger.warn(
      { paymentId, correlationKey },
      "Xero refund credit note not queued: an officer raised this refund's note by hand in Xero (#3635)"
    );
    return {
      queueOperationId: null,
      resolvedInXeroOperationId: resolvedCoverage.operationIds[resolvedKeyIndex],
      message:
        "An officer resolved this refund's Xero credit note by hand in Xero, so no new note is queued.",
    };
  }

  // #3924 round 8: a close's note is one row per close, whatever watermark
  // the payment's coverage gave it - found the one way a close's rows are.
  const existingQueuedOperation = await db.xeroSyncOperation.findFirst({
    where: {
      ...(options?.paidAnotherWayTaskId
        ? paidAnotherWayCloseNoteRowsWhere(paymentId, options.paidAnotherWayTaskId)
        : options?.cardRefundId
        ? cardRefundNoteRowsWhere(paymentId, options.cardRefundId)
        : {
            correlationKey,
            direction: "OUTBOUND",
            entityType: "CREDIT_NOTE",
            operationType: "CREATE",
            localModel: "Payment",
            localId: paymentId,
          }),
      status: {
        in: ["PENDING", "RUNNING"],
      },
    },
    orderBy: {
      createdAt: "desc",
    },
  });

  if (existingQueuedOperation) {
    return {
      queueOperationId: existingQueuedOperation.id,
      message: "Xero refund credit note is already queued for background processing.",
    };
  }

  const queuedOperation = await startXeroSyncOperation({
    direction: "OUTBOUND",
    entityType: "CREDIT_NOTE",
    operationType: "CREATE",
    localModel: "Payment",
    localId: paymentId,
    status: "PENDING",
    idempotencyKey: correlationKey,
    correlationKey,
    requestPayload: {
      queueType: XERO_OUTBOX_REFUND_CREDIT_NOTE_TYPE,
      refundAmountCents: noteAmountCents,
      // #4312: none on a card refund's own row - an older release's worker then runs it as the one note it would fold into.
      ...(options?.cardRefundId && cardRefundCoveredCents !== null ? {} : { watermarkCents }),
      ...(options?.refundMethod ? { refundMethod: options.refundMethod } : {}),
      // Normalised at write time too (a cast or untyped caller): cash wording
      // is stored only with the internet-banking method (`readRefundNoteWording`).
      ...(readRefundNoteWording(options) ? { noteWording: "cash" as const } : {}),
      ...(options?.paymentIntentId ? { paymentIntentId: options.paymentIntentId } : {}),
      ...(options?.documentDate ? { documentDate: options.documentDate } : {}),
      ...(options?.reviewTaskId ? { reviewTaskId: options.reviewTaskId } : {}),
      ...(options?.paidAnotherWayTaskId ? { paidAnotherWayTaskId: options.paidAnotherWayTaskId } : {}),
      ...(options?.creditsInvoiceId ? { creditsInvoiceId: options.creditsInvoiceId } : {}),
      ...(options?.handBackTaskId ? { handBackTaskId: options.handBackTaskId } : {}),
      ...(options?.cardRefundId ? { cardRefundId: options.cardRefundId } : {}),
    },
    createdByMemberId: options?.createdByMemberId ?? null,
    store: db,
  });

  return {
    queueOperationId: queuedOperation.id,
    message: "Xero refund credit note queued for background processing.",
  };
}

export async function enqueueXeroAccountCreditNoteOperation(
  paymentId: string,
  refundAmountCents: number,
  options?: { createdByMemberId?: string; store?: Prisma.TransactionClient; memberCreditId?: string }
) {
  if (refundAmountCents <= 0) {
    return {
      queueOperationId: null,
      message: "No account-credit note is required for this refund.",
    };
  }

  // Optional transaction client so callers (e.g. the late Internet Banking
  // capacity-fail reconcile) can enqueue the outbox row inside the same
  // transaction that creates the offsetting local credit; defaults to the
  // global `prisma` so existing callers are unaffected.
  const db = options?.store ?? prisma;

  const payment = await db.payment.findUnique({
    where: { id: paymentId },
    select: {
      id: true,
    },
  });

  if (!payment) {
    throw new Error(`Payment not found: ${paymentId}`);
  }

  const existingLink = await db.xeroObjectLink.findFirst({
    where: {
      localModel: "Payment",
      localId: paymentId,
      xeroObjectType: "CREDIT_NOTE",
      role: "ACCOUNT_CREDIT_NOTE",
      active: true,
    },
    select: { id: true },
  });

  if (existingLink) {
    return {
      queueOperationId: null,
      message: "Xero account-credit note already linked for this payment.",
    };
  }

  const correlationKey = buildXeroIdempotencyKey(
    "payment",
    paymentId,
    "unapplied-credit-note",
    refundAmountCents,
    "v1"
  );

  const existingQueuedOperation = await db.xeroSyncOperation.findFirst({
    where: {
      correlationKey,
      direction: "OUTBOUND",
      entityType: "CREDIT_NOTE",
      operationType: "CREATE",
      localModel: "Payment",
      localId: paymentId,
      status: {
        in: ["PENDING", "RUNNING"],
      },
    },
    orderBy: {
      createdAt: "desc",
    },
  });

  if (existingQueuedOperation) {
    return {
      queueOperationId: existingQueuedOperation.id,
      message: "Xero account-credit note is already queued for background processing.",
    };
  }

  const queuedOperation = await startXeroSyncOperation({
    direction: "OUTBOUND",
    entityType: "CREDIT_NOTE",
    operationType: "CREATE",
    localModel: "Payment",
    localId: paymentId,
    status: "PENDING",
    idempotencyKey: correlationKey,
    correlationKey,
    requestPayload: {
      queueType: XERO_OUTBOX_ACCOUNT_CREDIT_NOTE_TYPE,
      refundAmountCents, // #4685: and the credit it is for, which its stamp writes by id
      ...(options?.memberCreditId ? { memberCreditId: options.memberCreditId } : {}),
    },
    createdByMemberId: options?.createdByMemberId ?? null,
    store: db,
  });

  return {
    queueOperationId: queuedOperation.id,
    message: "Xero account-credit note queued for background processing.",
  };
}

// `RESTATABLE_SUPPLEMENTARY_INVOICE_STATUSES` moved to its leaf with its read (#3947).

// #3502: moved to its own leaf; re-exported so no importer moved.
export { OUTSTANDING_SUPPLEMENTARY_INVOICE_STATUSES };

/**
 * Whether any supplementary-invoice outbox operation tied to this
 * PaymentIntent has left WAITING_PAYMENT (was released, is running, already
 * SUCCEEDED, or FAILED-but-replayable) — i.e. a Xero invoice for the
 * additional amount exists or may still be created (#1350). Used by the
 * cancelled-booking late-capture webhook path to decide whether a corrective
 * refund credit note is needed; a still-WAITING_PAYMENT (or CANCELLED)
 * operation produces no invoice, so crediting it would over-credit the books.
 */
export async function hasReleasedXeroSupplementaryInvoiceOperationsForPaymentIntent(
  paymentIntentId: string
): Promise<boolean> {
  const releasedCount = await prisma.xeroSyncOperation.count({
    where: {
      direction: "OUTBOUND",
      entityType: "INVOICE",
      operationType: "CREATE",
      status: { notIn: ["WAITING_PAYMENT", "CANCELLED"] },
      requestPayload: {
        path: ["paymentIntentId"],
        equals: paymentIntentId,
      },
    },
  });
  return releasedCount > 0;
}

export async function releaseXeroSupplementaryInvoiceOperationsForPaymentIntent(
  paymentIntentId: string
) {
  const waitingOperations = await prisma.xeroSyncOperation.findMany({
    where: {
      status: "WAITING_PAYMENT",
      direction: "OUTBOUND",
      entityType: "INVOICE",
      operationType: "CREATE",
      requestPayload: {
        path: ["paymentIntentId"],
        equals: paymentIntentId,
      },
    },
    select: { id: true },
  });

  // #3403: also match this intent, so an invoice a later request took over is not released as a Stripe receipt.
  return releaseWaitingSupplementaryInvoiceOperations(waitingOperations.map((operation) => operation.id), paymentIntentId);
}

/**
 * THE RELEASE WRITE: move these waiting invoices to PENDING for the outbox to
 * send. Guarded on WAITING_PAYMENT, so a row the reaper retired, or another
 * caller released, in the meantime matches nothing. The one home for it: the
 * repair tool's release above and the late-capture release (#3641) both end
 * here.
 */
export async function releaseWaitingSupplementaryInvoiceOperations(
  queueOperationIds: string[],
  /** #3403 review: the capture they were read waiting on; one moved off it since is not its to release. */
  paymentIntentId?: string,
): Promise<{ released: number; queueOperationIds: string[] }> {
  if (queueOperationIds.length === 0) return { released: 0, queueOperationIds: [] };
  const updateResult = await prisma.xeroSyncOperation.updateMany({
    where: {
      id: { in: queueOperationIds },
      ...(paymentIntentId ? stillWaitingOnIntentWhere(paymentIntentId) : { status: "WAITING_PAYMENT" }),
    },
    data: {
      status: "PENDING",
      startedAt: null,
      lastErrorCode: null,
      lastErrorMessage: null,
    },
  });

  return { released: updateResult.count, queueOperationIds };
}

// The waiting-anchor filter moved to `xero-supplementary-invoice-statuses.ts`
// (#3954), so a price reduction can retire an unminted ask's parked invoice.

/**
 * IS THIS BOOKING CHANGE'S INVOICE STILL WAITING ON THIS EXACT ASK? (#3220 fix
 * round.)
 *
 * The read behind `INV-PAY-057`'s one exception. A supplementary invoice parked
 * `WAITING_PAYMENT` on a PaymentIntent is released by a CONFIRMED payment on
 * that intent and by nothing else, and while it sits there the booking-vs-Xero
 * repair pass reports the change as `BLOCKED_BY_XERO_OPERATION` rather than
 * raising the invoice - so cancelling the intent underneath it would strand the
 * row and leave the change with no invoice at all until the fourteen-day reaper
 * retires it. The intent id is matched too, not just the change: an operation
 * waiting on a DIFFERENT intent is not this ask's blocker.
 */
export async function findWaitingSupplementaryInvoiceOperationForPaymentIntent({
  bookingModificationId,
  paymentIntentId,
}: {
  bookingModificationId: string;
  paymentIntentId: string;
}): Promise<{ id: string } | null> {
  const waitingOperations = await prisma.xeroSyncOperation.findMany({
    where: waitingSupplementaryInvoiceOperationsWhere(bookingModificationId),
    select: { id: true, requestPayload: true },
  });

  for (const operation of waitingOperations) {
    const payload = supplementaryInvoicePayload(operation.requestPayload);
    if (payload?.paymentIntentId === paymentIntentId) {
      return { id: operation.id };
    }
  }

  return null;
}

/**
 * Point a modification's WAITING_PAYMENT supplementary-invoice operations at
 * a recovered additional PaymentIntent (#1096). The operation was enqueued
 * while intent creation was failing, so its payload carries a null
 * paymentIntentId that the payment-succeeded release could never match.
 */
export async function attachPaymentIntentToWaitingSupplementaryInvoiceOperations({
  bookingModificationId,
  paymentIntentId,
}: {
  bookingModificationId: string;
  paymentIntentId: string;
}): Promise<{ attached: number }> {
  const waitingOperations = await prisma.xeroSyncOperation.findMany({
    where: waitingSupplementaryInvoiceOperationsWhere(bookingModificationId),
    select: { id: true, requestPayload: true },
  });

  let attached = 0;
  for (const operation of waitingOperations) {
    const payload = supplementaryInvoicePayload(operation.requestPayload);
    if (!payload || payload.paymentIntentId) {
      continue;
    }
    await prisma.xeroSyncOperation.update({
      where: { id: operation.id },
      data: {
        requestPayload: {
          ...payload,
          paymentIntentId,
        } as Prisma.InputJsonValue,
      },
    });
    attached += 1;
  }

  return { attached };
}

export async function recordSkippedXeroBookingInvoiceUpdateOperation(params: {
  bookingId: string;
  bookingModificationId: string;
  reason: string;
  createdByMemberId?: string;
}) {
  const booking = await prisma.booking.findUnique({
    where: { id: params.bookingId },
    select: {
      payment: {
        select: {
          id: true,
          xeroInvoiceId: true,
          xeroInvoiceNumber: true,
        },
      },
    },
  });

  const correlationKey = buildXeroIdempotencyKey(
    "booking-mod",
    params.bookingModificationId,
    "primary-invoice-update",
    "skipped",
    "v1"
  );
  const existingOperation = await prisma.xeroSyncOperation.findFirst({
    where: {
      correlationKey,
      direction: "OUTBOUND",
      entityType: "INVOICE",
      operationType: "UPDATE",
      localModel: "BookingModification",
      localId: params.bookingModificationId,
    },
    orderBy: {
      createdAt: "desc",
    },
    select: { id: true },
  });

  if (existingOperation) {
    return {
      queueOperationId: existingOperation.id,
      message: "Skipped Xero primary invoice update already recorded for this modification.",
    };
  }

  const operation = await startXeroSyncOperation({
    direction: "OUTBOUND",
    entityType: "INVOICE",
    operationType: "UPDATE",
    localModel: "BookingModification",
    localId: params.bookingModificationId,
    idempotencyKey: correlationKey,
    correlationKey,
    requestPayload: {
      queueType: XERO_OUTBOX_BOOKING_INVOICE_UPDATE_TYPE,
      bookingId: params.bookingId,
      xeroInvoiceId: booking?.payment?.xeroInvoiceId ?? null,
      skippedByPolicy: true,
      reason: params.reason,
    },
    createdByMemberId: params.createdByMemberId ?? null,
  });

  await completeXeroSyncOperation(operation, {
    responsePayload: {
      skipped: true,
      reason: params.reason,
      bookingId: params.bookingId,
      bookingModificationId: params.bookingModificationId,
      paymentId: booking?.payment?.id ?? null,
    },
    xeroObjectType: booking?.payment?.xeroInvoiceId ? "INVOICE" : null,
    xeroObjectId: booking?.payment?.xeroInvoiceId ?? null,
    xeroObjectNumber: booking?.payment?.xeroInvoiceNumber ?? null,
  });

  return {
    queueOperationId: operation.id,
    message: "Skipped Xero primary invoice update recorded for this modification.",
  };
}

export async function enqueueXeroModificationCreditNoteOperation(
  params: {
    bookingId: string;
    refundAmountCents: number;
    bookingModificationId?: string;
    /**
     * #3791: one review task's share, so the note is scoped to that task
     * (`reviewTaskKeyParts`) and a sibling review's note on the same edit is
     * neither folded into it nor refused by its link.
     */
    reviewTaskId?: string;
    /**
     * #3954 round 7: a billed-offset note's edit expects its own note too, so
     * this one waits for it (`unpaid-ask-billed-offset-order.ts`). Recorded on
     * the payload only when true; never part of the key.
     */
    ownNoteExpected?: boolean;
  } & ModificationNoteWording,
  options?: {
    createdByMemberId?: string;
    /** The caller's transaction (#3535, `INV-PAY-017`): reads, dedupe and insert commit with it. */
    store?: Prisma.TransactionClient;
  }
) {
  const {
    bookingId,
    refundAmountCents,
    bookingModificationId,
  } = params;
  const reviewTaskId = bookingModificationId ? params.reviewTaskId : undefined;
  const db = options?.store ?? prisma;

  if (refundAmountCents <= 0) {
    return {
      queueOperationId: null,
      message: "No modification credit note is required for this change.",
    };
  }

  const booking = await db.booking.findUnique({
    where: { id: bookingId },
    select: {
      id: true,
      payment: {
        select: {
          xeroInvoiceId: true,
        },
      },
    },
  });

  if (!booking) {
    throw new Error(`Booking not found: ${bookingId}`);
  }

  if (!booking.payment?.xeroInvoiceId) {
    return {
      queueOperationId: null,
      message: "No original Xero invoice exists for this booking.",
    };
  }

  const localModel = bookingModificationId ? "BookingModification" : "Booking";
  const localId = bookingModificationId ?? bookingId;

  // An edit's own note: one per anchor, so a link already there answers it. A
  // review task's share is one of possibly several on that anchor, so its own
  // key - including a SUCCEEDED row - is what answers it instead (#3791).
  // #3954 round 6: and only the edit's OWN note's link answers it - a scoped
  // side note's (a give-back, a billed offset) beside it on the same anchor
  // records its scope on the link and never stands in for the edit's own.
  const existingLink = reviewTaskId
    ? null
    : (
        await db.xeroObjectLink.findMany({
          where: {
            localModel,
            localId,
            xeroObjectType: "CREDIT_NOTE",
            role: "MODIFICATION_CREDIT_NOTE",
            active: true,
          },
          select: { id: true, metadata: true },
        })
      ).find((link) => !linkReviewTaskId(link)) ?? null;

  if (existingLink) {
    return {
      queueOperationId: null,
      message: "Xero modification credit note already linked for this change.",
    };
  }

  const correlationKey = buildXeroIdempotencyKey(
    bookingModificationId ? "booking-mod" : "booking",
    localId,
    ...reviewTaskKeyParts(reviewTaskId),
    "mod-credit-note",
    refundAmountCents,
    "v1"
  );

  const existingQueuedOperation = await db.xeroSyncOperation.findFirst({
    where: {
      correlationKey,
      direction: "OUTBOUND",
      entityType: "CREDIT_NOTE",
      operationType: "CREATE",
      localModel,
      localId,
      status: {
        in: reviewTaskId ? ["PENDING", "RUNNING", "SUCCEEDED"] : ["PENDING", "RUNNING"],
      },
    },
    orderBy: {
      createdAt: "desc",
    },
  });

  if (existingQueuedOperation) {
    return {
      queueOperationId: existingQueuedOperation.id,
      message: "Xero modification credit note is already queued for background processing.",
    };
  }

  const queuedOperation = await startXeroSyncOperation({
    direction: "OUTBOUND",
    entityType: "CREDIT_NOTE",
    operationType: "CREATE",
    localModel,
    localId,
    status: "PENDING",
    idempotencyKey: correlationKey,
    correlationKey,
    requestPayload: {
      queueType: XERO_OUTBOX_MODIFICATION_CREDIT_NOTE_TYPE,
      bookingId,
      refundAmountCents,
      bookingModificationId: bookingModificationId ?? null,
      ...(reviewTaskId ? { reviewTaskId } : {}),
      ...(reviewTaskId && params.ownNoteExpected ? { [OWN_NOTE_EXPECTED_KEY]: true } : {}),
      ...readModificationNoteWording(params),
    },
    createdByMemberId: options?.createdByMemberId ?? null,
    store: db,
  });

  return {
    queueOperationId: queuedOperation.id,
    message: "Xero modification credit note queued for background processing.",
  };
}

export async function enqueueXeroModificationAccountCreditNoteOperation(
  params: {
    bookingId: string;
    refundAmountCents: number;
    bookingModificationId: string;
    /** #3791: as on `enqueueXeroModificationCreditNoteOperation`. */
    reviewTaskId?: string;
  },
  options?: { createdByMemberId?: string }
) {
  const {
    bookingId,
    refundAmountCents,
    bookingModificationId,
    reviewTaskId,
  } = params;

  if (refundAmountCents <= 0) {
    return {
      queueOperationId: null,
      message: "No modification account-credit note is required for this change.",
    };
  }

  const booking = await prisma.booking.findUnique({
    where: { id: bookingId },
    select: {
      id: true,
      payment: {
        select: {
          id: true,
        },
      },
    },
  });

  if (!booking) {
    throw new Error(`Booking not found: ${bookingId}`);
  }

  if (!booking.payment?.id) {
    return {
      queueOperationId: null,
      message: "No original payment exists for this booking.",
    };
  }

  // As on the invoice-applied note: a review task's share answers to its own
  // key, never to the anchor's link (#3791).
  const existingLink = reviewTaskId
    ? null
    : await prisma.xeroObjectLink.findFirst({
        where: {
          localModel: "BookingModification",
          localId: bookingModificationId,
          xeroObjectType: "CREDIT_NOTE",
          role: "MODIFICATION_ACCOUNT_CREDIT_NOTE",
          active: true,
        },
        select: { id: true },
      });

  if (existingLink) {
    return {
      queueOperationId: null,
      message: "Xero modification account-credit note already linked for this change.",
    };
  }

  const correlationKey = buildXeroIdempotencyKey(
    "booking-mod",
    bookingModificationId,
    ...reviewTaskKeyParts(reviewTaskId),
    "mod-account-credit-note",
    refundAmountCents,
    "v1"
  );

  const existingQueuedOperation = await prisma.xeroSyncOperation.findFirst({
    where: {
      correlationKey,
      direction: "OUTBOUND",
      entityType: "CREDIT_NOTE",
      operationType: "CREATE",
      localModel: "BookingModification",
      localId: bookingModificationId,
      status: {
        in: reviewTaskId ? ["PENDING", "RUNNING", "SUCCEEDED"] : ["PENDING", "RUNNING"],
      },
    },
    orderBy: {
      createdAt: "desc",
    },
  });

  if (existingQueuedOperation) {
    return {
      queueOperationId: existingQueuedOperation.id,
      message: "Xero modification account-credit note is already queued for background processing.",
    };
  }

  const queuedOperation = await startXeroSyncOperation({
    direction: "OUTBOUND",
    entityType: "CREDIT_NOTE",
    operationType: "CREATE",
    localModel: "BookingModification",
    localId: bookingModificationId,
    status: "PENDING",
    idempotencyKey: correlationKey,
    correlationKey,
    requestPayload: {
      queueType: XERO_OUTBOX_MODIFICATION_ACCOUNT_CREDIT_NOTE_TYPE,
      bookingId,
      paymentId: booking.payment.id,
      refundAmountCents,
      bookingModificationId,
      ...(reviewTaskId ? { reviewTaskId } : {}),
    },
    createdByMemberId: options?.createdByMemberId ?? null,
  });

  return {
    queueOperationId: queuedOperation.id,
    message: "Xero modification account-credit note queued for background processing.",
  };
}

export async function enqueueXeroCreditNoteAllocationOperation(
  params: {
    localModel: "Payment" | "Booking" | "BookingModification";
    localId: string;
    creditNoteId: string;
    invoiceId: string;
    amountCents: number;
    role?: string;
  },
  options?: { createdByMemberId?: string }
) {
  const {
    localModel,
    localId,
    creditNoteId,
    invoiceId,
    amountCents,
    role,
  } = params;

  if (amountCents <= 0) {
    return {
      queueOperationId: null,
      message: "No Xero credit-note allocation is required for this repair.",
    };
  }

  const existingLink = await prisma.xeroObjectLink.findFirst({
    where: {
      localModel,
      localId,
      xeroObjectType: "ALLOCATION",
      role: role ?? "CREDIT_NOTE_ALLOCATION",
      active: true,
    },
    select: { id: true },
  });

  if (existingLink) {
    return {
      queueOperationId: null,
      message: "Xero credit-note allocation already linked for this record.",
    };
  }

  const correlationKey = buildXeroIdempotencyKey(
    "credit-note",
    creditNoteId,
    "invoice",
    invoiceId,
    "allocation",
    amountCents,
    role ?? "CREDIT_NOTE_ALLOCATION",
    "v1"
  );

  const existingQueuedOperation = await prisma.xeroSyncOperation.findFirst({
    where: {
      correlationKey,
      direction: "OUTBOUND",
      entityType: "ALLOCATION",
      operationType: "ALLOCATE",
      localModel,
      localId,
      status: {
        in: ["PENDING", "RUNNING"],
      },
    },
    orderBy: {
      createdAt: "desc",
    },
  });

  if (existingQueuedOperation) {
    return {
      queueOperationId: existingQueuedOperation.id,
      message: "Xero credit-note allocation is already queued for background processing.",
    };
  }

  const queuedOperation = await startXeroSyncOperation({
    direction: "OUTBOUND",
    entityType: "ALLOCATION",
    operationType: "ALLOCATE",
    localModel,
    localId,
    status: "PENDING",
    idempotencyKey: correlationKey,
    correlationKey,
    requestPayload: {
      queueType: XERO_OUTBOX_CREDIT_NOTE_ALLOCATION_TYPE,
      creditNoteId,
      invoiceId,
      amountCents,
      role: role ?? null,
    },
    createdByMemberId: options?.createdByMemberId ?? null,
  });

  return {
    queueOperationId: queuedOperation.id,
    message: "Xero credit-note allocation queued for background processing.",
  };
}

// test seam
export async function enqueueXeroMembershipCancellationCreditNoteOperation(
  params: {
    subscriptionId: string;
    requestId: string;
    participantId: string;
  },
  options?: { createdByMemberId?: string }
) {
  const subscription = await prisma.memberSubscription.findUnique({
    where: { id: params.subscriptionId },
    select: {
      id: true,
      status: true,
      xeroInvoiceId: true,
    },
  });

  if (!subscription) {
    return {
      queueOperationId: null,
      message: "Membership subscription was not found for cancellation Xero crediting.",
    };
  }

  if (
    subscription.status !== "UNPAID" &&
    subscription.status !== "OVERDUE"
  ) {
    return {
      queueOperationId: null,
      message: "No Xero membership cancellation credit note is required for this subscription status.",
    };
  }

  if (!subscription.xeroInvoiceId) {
    return {
      queueOperationId: null,
      message: "No Xero subscription invoice is linked for cancellation crediting.",
    };
  }

  const existingLink = await prisma.xeroObjectLink.findFirst({
    where: {
      localModel: "MemberSubscription",
      localId: params.subscriptionId,
      xeroObjectType: "CREDIT_NOTE",
      role: "MEMBERSHIP_CANCELLATION_CREDIT_NOTE",
      active: true,
    },
    select: { id: true },
  });

  if (existingLink) {
    return {
      queueOperationId: null,
      message: "Xero membership cancellation credit note already linked.",
    };
  }

  const correlationKey = buildXeroIdempotencyKey(
    "member-subscription",
    params.subscriptionId,
    "membership-cancellation-credit",
    params.participantId,
    "v1"
  );
  const existingQueuedOperation = await prisma.xeroSyncOperation.findFirst({
    where: {
      correlationKey,
      direction: "OUTBOUND",
      entityType: "CREDIT_NOTE",
      operationType: "CREATE",
      localModel: "MemberSubscription",
      localId: params.subscriptionId,
      status: {
        in: ["PENDING", "RUNNING"],
      },
    },
    orderBy: { createdAt: "desc" },
  });

  if (existingQueuedOperation) {
    return {
      queueOperationId: existingQueuedOperation.id,
      message: "Xero membership cancellation credit note is already queued for background processing.",
    };
  }

  const queuedOperation = await startXeroSyncOperation({
    direction: "OUTBOUND",
    entityType: "CREDIT_NOTE",
    operationType: "CREATE",
    localModel: "MemberSubscription",
    localId: params.subscriptionId,
    status: "PENDING",
    idempotencyKey: correlationKey,
    correlationKey,
    requestPayload: {
      queueType: XERO_OUTBOX_MEMBERSHIP_CANCELLATION_CREDIT_NOTE_TYPE,
      subscriptionId: params.subscriptionId,
      requestId: params.requestId,
      participantId: params.participantId,
    },
    createdByMemberId: options?.createdByMemberId ?? null,
  });

  return {
    queueOperationId: queuedOperation.id,
    message: "Xero membership cancellation credit note queued for background processing.",
  };
}

// test seam
export async function enqueueXeroMembershipCancellationContactOperation(
  params: {
    memberId: string;
    requestId: string;
    participantId: string;
  },
  options?: { createdByMemberId?: string }
) {
  const member = await prisma.member.findUnique({
    where: { id: params.memberId },
    select: { id: true, xeroContactId: true },
  });

  if (!member?.xeroContactId) {
    return {
      queueOperationId: null,
      message: "No Xero contact is linked for membership cancellation contact cleanup.",
    };
  }

  const existingLink = await prisma.xeroObjectLink.findFirst({
    where: {
      localModel: "MembershipCancellationRequestParticipant",
      localId: params.participantId,
      xeroObjectType: "CONTACT",
      role: "MEMBERSHIP_CANCELLATION_CONTACT",
      active: true,
    },
    select: { id: true },
  });

  if (existingLink) {
    return {
      queueOperationId: null,
      message: "Xero membership cancellation contact cleanup already linked.",
    };
  }

  const correlationKey = buildXeroIdempotencyKey(
    "membership-cancellation",
    params.participantId,
    "contact",
    params.memberId,
    "v1"
  );
  const existingQueuedOperation = await prisma.xeroSyncOperation.findFirst({
    where: {
      correlationKey,
      direction: "OUTBOUND",
      entityType: "CONTACT",
      operationType: "UPDATE",
      localModel: "MembershipCancellationRequestParticipant",
      localId: params.participantId,
      status: {
        in: ["PENDING", "RUNNING"],
      },
    },
    orderBy: { createdAt: "desc" },
  });

  if (existingQueuedOperation) {
    return {
      queueOperationId: existingQueuedOperation.id,
      message: "Xero membership cancellation contact cleanup is already queued for background processing.",
    };
  }

  const queuedOperation = await startXeroSyncOperation({
    direction: "OUTBOUND",
    entityType: "CONTACT",
    operationType: "UPDATE",
    localModel: "MembershipCancellationRequestParticipant",
    localId: params.participantId,
    status: "PENDING",
    idempotencyKey: correlationKey,
    correlationKey,
    requestPayload: {
      queueType: XERO_OUTBOX_MEMBERSHIP_CANCELLATION_CONTACT_TYPE,
      memberId: params.memberId,
      requestId: params.requestId,
      participantId: params.participantId,
    },
    createdByMemberId: options?.createdByMemberId ?? null,
  });

  return {
    queueOperationId: queuedOperation.id,
    message: "Xero membership cancellation contact cleanup queued for background processing.",
  };
}

export async function queueApprovedMembershipCancellationXeroOperations(params: {
  memberId: string;
  requestId: string;
  participantId: string;
  createdByMemberId?: string;
}) {
  const seasonYear = clubSeasonYear(await readClubTimeZoneOutsideRequest());
  const subscription = await prisma.memberSubscription.findUnique({
    where: {
      memberId_seasonYear: {
        memberId: params.memberId,
        seasonYear,
      },
    },
    select: { id: true },
  });
  const queuedResults: Array<{ queueOperationId: string | null; message: string }> = [];

  // Enqueue the credit note BEFORE the contact cleanup. The outbox processes
  // operations oldest-first (createdAt, then id: a same-millisecond pair is not
  // guaranteed in call order, #4663), so this puts the credit note ahead of the
  // contact archive. Archiving first would block it: Xero rejects credit notes
  // against an archived contact. The contact operation re-checks this at run
  // time and defers if the credit note has not settled yet.
  if (subscription) {
    queuedResults.push(
      await enqueueXeroMembershipCancellationCreditNoteOperation(
        {
          subscriptionId: subscription.id,
          requestId: params.requestId,
          participantId: params.participantId,
        },
        { createdByMemberId: params.createdByMemberId }
      )
    );
  } else {
    queuedResults.push({
      queueOperationId: null,
      message: "No current-season membership subscription record exists for cancellation crediting.",
    });
  }

  queuedResults.push(
    await enqueueXeroMembershipCancellationContactOperation(
      {
        memberId: params.memberId,
        requestId: params.requestId,
        participantId: params.participantId,
      },
      { createdByMemberId: params.createdByMemberId }
    )
  );

  if (queuedResults.some((result) => result.queueOperationId)) {
    void kickQueuedXeroOutboxOperationsIfConnected({ limit: queuedResults.length }).catch(
      (error) => {
        logger.error(
          { err: error, memberId: params.memberId, requestId: params.requestId },
          "Failed to kick queued Xero membership cancellation operations"
        );
      }
    );
  }

  return {
    seasonYear,
    results: queuedResults,
  };
}

export interface ProcessQueuedXeroOutboxOperationsResult {
  found: number;
  processed: number;
  succeeded: number;
  failed: number;
  skipped: number;
  cooldownDeferred?: number; // #4375: of `skipped`, refused before any call; set only when non-zero
}

export async function kickQueuedXeroOutboxOperationsIfConnected(options?: {
  limit?: number;
}) {
  if (!(await isXeroConnected())) {
    return null;
  }

  return processQueuedXeroOutboxOperations(options);
}

export async function processQueuedXeroOutboxOperations(options?: {
  limit?: number;
}): Promise<ProcessQueuedXeroOutboxOperationsResult> {
  const limit = Math.min(Math.max(options?.limit ?? 10, 1), 50);
  const queuedOperations = await prisma.xeroSyncOperation.findMany({
    // Scan the indexed, denormalized `queueType` column (#1271, item 3 of
    // #1208) instead of a 12-branch `requestPayload->>'queueType'` OR predicate.
    // Behavior-identical for this scan: the column is written at enqueue in
    // `startXeroSyncOperation` from the same sanitized payload and never updated
    // afterward, and the only non-enqueue path into PENDING (the
    // WAITING_PAYMENT -> PENDING supplementary release) only flips status. So
    // for every PENDING row the column mirrors the enqueue-time
    // `payload.queueType` exactly (#1271's migration also backfilled existing
    // rows), and this selects the identical set the OR predicate did — now via
    // the `(queueType, status, createdAt)` index. Dispatch below still reads
    // `queueType` from the payload, so routing is unchanged.
    where: {
      status: "PENDING",
      direction: "OUTBOUND",
      queueType: {
        in: [...XERO_OUTBOX_QUEUE_TYPES],
      },
      // Rows waiting their turn are looked at only every few minutes, not on every kick (#3954, #3953, #4692 `INV-INT-035`); an owed group invoice email every minute (#4919).
      AND: [outboxScanLeavesAwaitingOwnNote(new Date()), outboxScanSpacesWaitingReceipts(new Date()), scanSpacesRefundNotesAwaitingResolve(new Date()), scanSpacesAdminGrantNotesAwaitingRetry(new Date()), scanSpacesGroupInvoiceEmailsDeferred(new Date())],
    },
    // Ties on `createdAt` (same ms; all rows under the frozen clock) fall to `id`:
    // deterministic, not insertion order (#4663; STATE_MACHINES.md).
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    take: limit,
  });
  // The club's format (#3565), once for the whole batch: three of the documents
  // below can render an amount into a Xero line description, and a read per
  // operation would be a read per row.
  const format = await clubFormatValues();

  const result: ProcessQueuedXeroOutboxOperationsResult = {
    found: queuedOperations.length,
    processed: 0,
    succeeded: 0,
    failed: 0,
    skipped: 0,
  };

  for (const queuedOperation of queuedOperations) {
    const queueType = readQueueType(queuedOperation.requestPayload);
    const expectedOperation = getQueuedOutboxExpectedOperation(queueType);
    // #4373: the claim this dispatch's outcomes are written under (`INV-INT-029`).
    const claimed = await claimQueuedOutboxOperation(queuedOperation.id, expectedOperation);
    if (!claimed) {
      result.skipped += 1;
      continue;
    }

    result.processed += 1;

    /**
     * THE PAYLOAD IS RE-READ AFTER THE CLAIM, NOT TAKEN FROM THE SCAN (#3170
     * fix round, F1).
     *
     * The scan above loads every row's `requestPayload` in one query and this
     * loop then does a Xero round trip per row before claiming the next, so by
     * the time row N is claimed its scanned payload is N-1 provider calls old -
     * tens of seconds to minutes at a limit of 50. That mattered the moment an
     * amount became restatable: `restatePendingSupplementaryInvoiceAmount`
     * guards its write on `status IN (PENDING, WAITING_PAYMENT)`, so a restate
     * landing in that window MATCHES, writes, and truthfully reports
     * `restated: 1` - while the send that follows used the figure from the scan.
     * Its caller returns early believing the combined total is billed, and on
     * the internet-banking route, where the supplementary invoice IS the ask,
     * the second share is then invoiced nowhere.
     *
     * Re-reading here closes that window rather than documenting it. The claim
     * has already committed `status: RUNNING`, and RUNNING is outside the
     * restatable set, so after this point no restate can match the row: the
     * payload read here is the one the row will still hold when the handler
     * sends it. A restate is therefore either taken (it landed first, and this
     * read sees it) or refused and reported as `restated: 0` (it landed second),
     * with nothing in between.
     *
     * Every queue type is re-read, not just the supplementary invoice, because
     * "send what the row says now" is the correct rule for all of them and a
     * type-specific carve-out would be a second answer to the same question.
     * ROUTING still comes from the scan's `queueType`: the column and the
     * payload key are written once at enqueue and never updated, so re-deriving
     * dispatch from the fresh row could only ever agree - and pinning the two to
     * the same value the claim guard was built from keeps that true by
     * construction rather than by comment. A row that vanished between the claim
     * and this read is impossible (the claim just updated it), but the fallback
     * to the scanned payload keeps this a strictly-fresher read rather than a
     * new way to fail.
     */
    const claimedOperation = await prisma.xeroSyncOperation.findUnique({
      where: { id: queuedOperation.id },
      select: { requestPayload: true },
    });
    const claimedPayload = claimedOperation
      ? readQueuedOutboxPayload(claimedOperation.requestPayload)
      : null;
    const payload =
      claimedPayload && claimedPayload.queueType === queueType
        ? claimedPayload
        : readQueuedOutboxPayload(queuedOperation.requestPayload);

    // #3635 round 4 (review N3, `INV-INT-025`): a copy queued before an
    // officer resolved a sibling for the same document is stale - the
    // hand-made document stands for it. Closed CANCELLED, before any Xero call.
    const resolvedSibling = await findResolvedSiblingSince(queuedOperation);
    if (resolvedSibling) {
      await completeXeroSyncOperation(claimed, { status: "CANCELLED", responsePayload: resolvedSiblingCopySkippedPayload(resolvedSibling.id) });
      result.skipped += 1;
      continue;
    }

    const entranceFeeContext = payload
      ? buildPrecomputedEntranceFeeContext(payload)
      : null;
    const subscriptionChargeId = subscriptionInvoiceChargeId(queuedOperation);
    // #4655 (#4672 review S1/S2, `INV-INT-029`): the claim this dispatch's outcome is
    // written under. An organiser adjustment whose late note re-took a row a reset
    // failed hands back its fresh claim; every give-back and failure below follows it.
    let outcomeClaim: XeroOperationClaim = claimed;

    try {
      if (
        payload?.queueType === XERO_OUTBOX_ENTRANCE_FEE_TYPE &&
        queuedOperation.localId &&
        entranceFeeContext
      ) {
        await createXeroEntranceFeeInvoice(queuedOperation.localId, {
          createdByMemberId: queuedOperation.createdByMemberId ?? undefined,
          syncOperation: claimed,
          precomputedEntranceFee: entranceFeeContext,
        });
      } else if (payload?.queueType === XERO_OUTBOX_BOOKING_INVOICE_TYPE) {
        await createXeroInvoiceForBooking(payload.bookingId, {
          createdByMemberId: queuedOperation.createdByMemberId ?? undefined,
          syncOperation: claimed,
        });
      } else if (payload?.queueType === XERO_OUTBOX_BOOKING_INVOICE_UPDATE_TYPE) {
        await updateXeroBookingInvoiceForBooking(payload.bookingId, {
          createdByMemberId: queuedOperation.createdByMemberId ?? undefined,
          syncOperation: claimed,
        });
      } else if (
        payload?.queueType === XERO_OUTBOX_GROUP_SETTLEMENT_INVOICE_TYPE
      ) {
        await createXeroInvoiceForGroupSettlement(payload.settlementId, {
          createdByMemberId: queuedOperation.createdByMemberId ?? undefined,
          syncOperation: claimed,
        });
      } else if (
        payload?.queueType === XERO_OUTBOX_GROUP_SETTLEMENT_INVOICE_VOID_TYPE
      ) {
        if (payload.xeroInvoiceId) {
          // #3642: the invoice a live group's settlement abandoned.
          await voidXeroInvoiceForAbandonedGroupSettlement(
            payload.settlementId,
            payload.xeroInvoiceId,
            { syncOperation: claimed }
          );
        } else {
          await voidXeroInvoiceForCancelledGroupSettlement(
            payload.settlementId,
            { syncOperation: claimed }
          );
        }
      } else if (payload?.queueType === XERO_OUTBOX_SUBSCRIPTION_INVOICE_TYPE && subscriptionChargeId) {
        await createXeroMembershipSubscriptionInvoice({ // INV-INT-026
          chargeId: subscriptionChargeId,
          createdByMemberId: queuedOperation.createdByMemberId ?? undefined,
          syncOperation: claimed,
        });
      } else if (
        payload?.queueType === XERO_OUTBOX_REFUND_CREDIT_NOTE_TYPE &&
        queuedOperation.localId
      ) {
        await createXeroCreditNote(
          queuedOperation.localId,
          payload.refundAmountCents,
          {
            createdByMemberId: queuedOperation.createdByMemberId ?? undefined,
            syncOperation: claimed,
            watermarkCents: payload.watermarkCents,
            ...(payload.refundMethod && payload.refundMethod !== "account-credit"
              ? { refundMethod: payload.refundMethod }
              : {}),
            ...(payload.noteWording ? { noteWording: payload.noteWording } : {}),
            ...(payload.paymentIntentId ? { paymentIntentId: payload.paymentIntentId } : {}),
            ...(payload.documentDate ? { documentDate: payload.documentDate } : {}),
            ...(payload.paidAnotherWayTaskId ? { paidAnotherWayTaskId: payload.paidAnotherWayTaskId } : {}),
            ...(payload.creditsInvoiceId ? { creditsInvoiceId: payload.creditsInvoiceId } : {}),
            // #4162: the hand-back this note records rides the executed row.
            ...(payload.handBackTaskId ? { handBackTaskId: payload.handBackTaskId } : {}),
            ...(payload.cardRefundId ? { cardRefundId: payload.cardRefundId } : {}), // #4312: the card refund it answers
            // #3827 (D-3813-8): a refund request's own note (`refund-request-credit-note.ts`).
            ...(readRefundRequestIdFromPayload(queuedOperation.requestPayload)
              ? { refundRequestId: readRefundRequestIdFromPayload(queuedOperation.requestPayload)! }
              : {}),
            ...(queuedReviewTaskId(queuedOperation) ? { reviewTaskId: queuedReviewTaskId(queuedOperation) } : {}),
          }
        );
      } else if (
        payload?.queueType === XERO_OUTBOX_ACCOUNT_CREDIT_NOTE_TYPE &&
        queuedOperation.localId
      ) {
        await createUnappliedXeroCreditNote(
          queuedOperation.localId,
          payload.refundAmountCents,
          format,
          { createdByMemberId: queuedOperation.createdByMemberId ?? undefined, syncOperation: claimed, memberCreditId: payload.memberCreditId }
        );
      } else if (payload?.queueType === XERO_OUTBOX_ADMIN_GRANT_CREDIT_NOTE_TYPE) {
        await createAdminGrantCreditNote({ syncOperation: claimed, payload });
      } else if (
        payload?.queueType === XERO_OUTBOX_MODIFICATION_ACCOUNT_CREDIT_NOTE_TYPE
      ) {
        await createUnappliedXeroCreditNoteForModification({
          paymentId: payload.paymentId,
          refundAmountCents: payload.refundAmountCents,
          bookingModificationId: payload.bookingModificationId,
          reviewTaskId: queuedReviewTaskId(queuedOperation),
          createdByMemberId: queuedOperation.createdByMemberId ?? undefined,
          syncOperation: claimed,
          format,
        });
      } else if (payload?.queueType === XERO_OUTBOX_KEPT_LATE_CAPTURE_INVOICE_TYPE) {
        // #3635: a late capture a treasurer kept, invoiced and paid in Xero.
        await createXeroKeptLateCaptureInvoice({
          syncOperation: claimed,
          createdByMemberId: queuedOperation.createdByMemberId ?? undefined,
        });
      } else if (payload?.queueType === XERO_OUTBOX_CARD_REFUND_REVERSAL_INVOICE_TYPE) {
        // #4369: a failed card refund's money back in the Stripe account.
        await createXeroCardRefundReversalInvoice({ syncOperation: claimed, createdByMemberId: queuedOperation.createdByMemberId ?? undefined });
      } else if (payload?.queueType === XERO_OUTBOX_ADDITIONAL_CAPTURE_RECEIPT_TYPE) {
        // #3953: a change's card capture nothing waited on, recorded against the invoice billing it.
        await recordAdditionalCaptureReceipt({ syncOperation: claimed, createdByMemberId: queuedOperation.createdByMemberId ?? undefined });
      } else if (payload?.queueType === XERO_OUTBOX_ORGANISER_EXTRA_ADJUSTMENT_TYPE) {
        const ran = await executeOrganiserExtraAdjustment(payload, claimed, { onRetake: (retaken) => { outcomeClaim = retaken; } });
        // #4655, #4680, #4701: a stood-down run wrote no outcome, whether its note landed on a re-queued row, on none, or it lost its claim before a money-moving call.
        if (ran === "stood-down") {
          result.skipped += 1;
          continue;
        }
      } else if (payload?.queueType === XERO_OUTBOX_SUPPLEMENTARY_INVOICE_TYPE) {
        await createXeroSupplementaryInvoice({
          bookingId: payload.bookingId,
          priceDiffCents: payload.priceDiffCents,
          changeFeeCents: payload.changeFeeCents,
          bookingModificationId: payload.bookingModificationId,
          recordPayment: payload.recordPayment ?? true,
          // #3193: present means this row is one review share's OWN invoice, so
          // the handler anchors its link on that task, scopes the Xero
          // idempotency key to it, and says on the invoice why the member is
          // being asked twice.
          shortfallReviewTaskId: payload.shortfallReviewTaskId,
          createdByMemberId: queuedOperation.createdByMemberId ?? undefined,
          syncOperation: claimed,
          format,
        });
      } else if (payload?.queueType === XERO_OUTBOX_MODIFICATION_CREDIT_NOTE_TYPE) {
        await createXeroCreditNoteForModification({
          bookingId: payload.bookingId,
          refundAmountCents: payload.refundAmountCents,
          bookingModificationId: payload.bookingModificationId,
          reviewTaskId: queuedReviewTaskId(queuedOperation),
          ...readModificationNoteWording(payload),
          createdByMemberId: queuedOperation.createdByMemberId ?? undefined,
          syncOperation: claimed,
          format,
        });
      } else if (
        payload?.queueType === XERO_OUTBOX_MEMBERSHIP_CANCELLATION_CREDIT_NOTE_TYPE
      ) {
        await createXeroMembershipCancellationCreditNote({
          subscriptionId: payload.subscriptionId,
          requestId: payload.requestId,
          participantId: payload.participantId,
          createdByMemberId: queuedOperation.createdByMemberId ?? undefined,
          syncOperation: claimed,
        });
      } else if (
        payload?.queueType === XERO_OUTBOX_MEMBERSHIP_CANCELLATION_CONTACT_TYPE
      ) {
        await syncXeroMembershipCancellationContact({
          memberId: payload.memberId,
          requestId: payload.requestId,
          participantId: payload.participantId,
          createdByMemberId: queuedOperation.createdByMemberId ?? undefined,
          syncOperation: claimed,
        });
      } else if (
        payload?.queueType === XERO_OUTBOX_CREDIT_NOTE_ALLOCATION_TYPE &&
        queuedOperation.localModel &&
        queuedOperation.localId
      ) {
        await allocateCreditNoteToInvoice(
          payload.creditNoteId,
          payload.invoiceId,
          payload.amountCents,
          {
            localModel: queuedOperation.localModel,
            localId: queuedOperation.localId,
            role: payload.role,
            createdByMemberId: queuedOperation.createdByMemberId ?? undefined,
            syncOperation: claimed,
          }
        );
      } else if (
        payload?.queueType === XERO_OUTBOX_APPLIED_CREDIT_ALLOCATION_TYPE
      ) {
        await allocateAppliedCreditForBooking(payload.bookingId, {
          createdByMemberId: queuedOperation.createdByMemberId ?? undefined,
          syncOperation: claimed,
        });
      } else if (
        payload?.queueType === XERO_OUTBOX_APPLIED_CREDIT_DEALLOCATION_TYPE
      ) {
        await deallocateExcessAppliedCreditForBooking(payload.bookingId, {
          syncOperation: claimed,
        });
      } else {
        throw new Error("Queued Xero outbox payload is incomplete.");
      }

      result.succeeded += 1;
    } catch (error) {
      if (error instanceof RefundNoteNotRecordedError) {
        // #4656 (`INV-INT-029`): a note this run did not record, already traced; the row stays as the record left it.
        // Skipped, never succeeded: this run completed nothing, even where the row records this very note.
        const level = refundNoteRecordedElsewhere(error.outcome) ? "info" : "warn";
        logger[level]({ queueOperationId: queuedOperation.id, outcome: error.outcome }, error.message);
        result.skipped += 1;
        continue;
      }
      if (isXeroAppliedCreditOperationBusyError(error)) {
        // Two independent outbox runners can claim allocation and deallocation
        // for the same Payment before either handler observes the other. That
        // collision is transient: return this row to PENDING so the next scan
        // serializes them, rather than stranding both rows as FAILED.
        // #3791: the reason stays on the row, so a note waiting on a
        // deallocation says what it is waiting for.
        await prisma.xeroSyncOperation.updateMany({
          // #4356: never take back a repair's marked claim; #4373: nor any claim but this dispatch's (`INV-INT-029`).
          where: { id: queuedOperation.id, ...ownRunningClaim(outcomeClaim), ...NOT_A_XERO_REPAIR_CLAIM },
          data: {
            status: "PENDING",
            startedAt: null,
            // #3954 round 8: a wait the scan spaces out names itself here.
            lastErrorCode: error.waitCode,
            lastErrorMessage: error.message,
          },
        });
        result.skipped += 1;
        continue;
      }
      if (isXeroCooldownRefusal(error)) {
        // Same shape, same reason (#2423 review F2). A process-global cooldown
        // — the transient-outage breaker or the daily-limit gate — refused this
        // operation before any HTTP, so it was never attempted. Marking it
        // terminal FAILED here is what turned an outage into a pile of
        // FAILED-unattempted invoices that NOTHING auto-recovers: the retry
        // scanner only processes operator-created REQUEUE rows, so each one
        // waits for an admin to notice and press Requeue. Typically the first
        // operation of a batch fails for real and arms the breaker, and
        // operations 2..N of the SAME batch are then condemned without ever
        // reaching Xero.
        //
        // The un-claim must match the state the HANDLER left the row in, not the
        // state the outbox expects. Every queue type but the three named below
        // owns a `catch { await failXeroSyncOperation(<this outbox row>, error); throw }`
        // (the kept late-capture invoice, #3635, self-fails like the rest),
        // and `failXeroSyncOperation` writes `status: FAILED` + `completedAt` over a
        // RUNNING row (only a recorded success is kept, `INV-INT-029`) — so by the time this branch runs the row is
        // already FAILED for those types, and a `status: "RUNNING"`-only guard
        // would match zero rows and leave it terminally FAILED (the very bug the
        // #2423 F2 review caught). The three handlers that do NOT self-fail
        // (SUBSCRIPTION_INVOICE, APPLIED_CREDIT_ALLOCATION,
        // APPLIED_CREDIT_DEALLOCATION) leave it RUNNING. Match BOTH, and clear
        // `completedAt` so a returned row is indistinguishable from one never
        // picked up.
        //
        // Widening the guard to include FAILED is safe precisely because
        // `isXeroCooldownRefusal` now requires the pre-HTTP marker: we only
        // un-FAIL a row whose error proves nothing was sent. A genuine
        // post-HTTP failure — including a 429 Xero itself returned, whose
        // freshly-minted XeroDailyLimitError carries `preHttp: false` — is not a
        // cooldown refusal, never reaches this branch, and keeps its replayable
        // FAILED row untouched. (Chosen over rethrowing the refusal ahead of
        // `failXeroSyncOperation` in all twelve handler catches: that is a far
        // larger, money-path blast radius, and without this same marker it would
        // be no safer — so the contained guard here is the more robust fix.)
        //
        // Returning the row to PENDING is idempotency-neutral: nothing was sent,
        // so the next cron simply drives the same queued work. It is deliberately
        // BEFORE the subscription-charge error exposure below, so a genuinely
        // un-attempted operation leaves its charge exactly as the enqueue left it
        // (QUEUED / INVOICE_CREATED, errors cleared), which is the truth.
        const returned = await prisma.xeroSyncOperation.updateMany({
          where: {
            id: queuedOperation.id,
            // #4373/#4687: RUNNING or self-failed FAILED only under this dispatch's own claim, never a later one's (`INV-INT-029`).
            AND: [{ status: { in: ["RUNNING", "FAILED"] }, startedAt: outcomeClaim.startedAt }],
            // Never revive a row an officer resolved (#3635, `INV-INT-025`), nor a repair's marked claim (#4356).
            manuallyResolvedAt: null,
            ...NOT_A_XERO_REPAIR_CLAIM,
          },
          data: {
            status: "PENDING",
            startedAt: null,
            completedAt: null,
            lastErrorCode: null,
            lastErrorMessage: null,
          },
        });
        if (returned.count > 0) {
          logger.warn(
            {
              err: error,
              queueOperationId: queuedOperation.id,
              queueType: payload?.queueType ?? null,
            },
            "Returned un-attempted Xero outbox operation to PENDING: a Xero cooldown refused it before any call"
          );
          result.skipped += 1;
          result.cooldownDeferred = (result.cooldownDeferred ?? 0) + 1;
          continue;
        }
        // #4356: a caller sharing this row recorded a success on it, so the handler's
        // own failure was refused (`INV-INT-029`): nothing failed, that outcome stands.
        const held = await prisma.xeroSyncOperation.findUnique({ where: { id: queuedOperation.id }, select: { status: true } });
        if (held && holdsRecordedXeroSuccess(held.status)) {
          logger.info({ queueOperationId: queuedOperation.id, heldStatus: held.status }, "Xero cooldown refused an outbox operation another caller had already completed; its outcome stands");
          result.skipped += 1;
          continue;
        }
        // The row was not this claim's RUNNING or FAILED row (e.g. a concurrent
        // worker moved it out from under us). Do NOT report a return-to-PENDING
        // that did not happen — that false "skipped" is what let an incident
        // summary tell an operator the queue would self-heal while invoices sat
        // stuck. Fall through to the failure path: the row counts failed when the
        // failure lands, and skipped when INV-INT-029 refuses it (#4673).
        logger.warn(
          {
            err: error,
            queueOperationId: queuedOperation.id,
            queueType: payload?.queueType ?? null,
          },
          "Xero cooldown refused an outbox operation but the row was not in a returnable state; failing it"
        );
      }
      // F4 (#1354): fail the operation for EVERY queue type, not just the two
      // membership-cancellation types and payload-shape errors. An operation
      // erroring BEFORE its handler overwrote requestPayload (token refresh,
      // contact resolution, account mapping) previously stayed RUNNING with
      // the queued payload; after an operator stale-reset the retry stack
      // could not parse that shape — a permanent manual dead-end. FAILED rows
      // are replayable, and the retry parser now understands the queued
      // payload shape, so failing fast here closes the dead-end for all
      // types.
      let failedRow: Awaited<ReturnType<typeof failXeroSyncOperation>> | undefined;
      try {
        // #3635 round-3 N5: never over a row withdrawn in the meantime (an
        // approval cancels a kept row it finds FAILED); CANCELLED stands.
        failedRow = await failXeroSyncOperation(
          outcomeClaim,
          error instanceof Error ? error : new Error(String(error)),
          undefined,
          { keepCancelled: true }
        );
      } catch (failErr) {
        logger.error(
          { err: failErr, queueOperationId: queuedOperation.id },
          "Failed to mark queued Xero outbox operation FAILED after an error"
        );
      }
      // #4673 (`INV-INT-029`): refused - no longer this run's row (a Retry queued it again, a later claim
      // holds or ended it) or it keeps a success or a withdrawal. Nothing failed: no charge error, not counted failed.
      if (failedRow === null) {
        logger.warn({ err: error, queueOperationId: queuedOperation.id, queueType: payload?.queueType ?? null }, "Queued Xero outbox operation's failure was not recorded: the row is no longer this run's (INV-INT-029)");
        result.skipped += 1;
        continue;
      }
      if (payload?.queueType === XERO_OUTBOX_SUBSCRIPTION_INVOICE_TYPE && subscriptionChargeId) {
        const currentCharge = await prisma.membershipSubscriptionCharge.findUnique({
          where: { id: subscriptionChargeId },
          select: { xeroInvoiceId: true, status: true, billingBasis: true },
        }).catch(() => null);
        // #2147: never resurrect a VOIDED charge (its invoice was voided and its
        // coverage released) back to a retryable QUEUED/EMAIL_FAILED state, nor
        // (#4098) a charge an officer closed as already paid. The write is
        // status-guarded too, so a close landing after the read still stands.
        if (currentCharge && !membershipChargeNeedsNoInvoice(currentCharge)) {
          await prisma.membershipSubscriptionCharge.updateMany({
            where: liveChargeWhere(subscriptionChargeId),
            data: {
              status: currentCharge.xeroInvoiceId ? "EMAIL_FAILED" : "QUEUED",
              lastErrorCode: currentCharge.xeroInvoiceId ? "EMAIL_FAILED" : "XERO_FAILED",
              lastErrorMessage: error instanceof Error ? error.message : String(error),
            },
          }).catch((chargeError) => {
            logger.error({ err: chargeError, chargeId: subscriptionChargeId }, "Failed to expose subscription charge outbox error");
          });
        }
      }
      logger.error(
        {
          err: error,
          queueOperationId: queuedOperation.id,
          localId: queuedOperation.localId,
          queueType: payload?.queueType ?? null,
        },
        "Failed queued Xero outbox operation"
      );
      result.failed += 1;
    }
  }

  return result;
}
