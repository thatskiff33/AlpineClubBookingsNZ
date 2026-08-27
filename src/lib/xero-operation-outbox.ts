import { PaymentSource, Prisma } from "@prisma/client";
import logger from "@/lib/logger";
import {
  createXeroMembershipCancellationCreditNote,
  syncXeroMembershipCancellationContact,
} from "@/lib/membership-cancellation-xero";
import { prisma } from "@/lib/prisma";
import { resolveStripeCashRefundEvidence } from "@/lib/stripe-cash-refund-evidence";
import { claimXeroSyncOperationToRunning } from "@/lib/xero-operation-claim";
import { readClubTimeZoneOutsideRequest } from "@/lib/club-time-zone-runtime";
import { clubSeasonYear } from "@/lib/financial-year";
import {
  buildXeroIdempotencyKey,
  completeXeroSyncOperation,
  failXeroSyncOperation,
  findCanonicalPaymentRefundCreditNote,
  startXeroSyncOperation,
  sumCoveredRefundCreditNoteCents,
  upsertXeroObjectLink,
} from "@/lib/xero-sync";
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
import { createXeroEntranceFeeInvoice } from "@/lib/xero-entrance-fee-invoices";
import {
  buildEntranceFeeInvoiceIdempotencyKey,
  ENTRANCE_FEE_EXEMPT_MESSAGE,
  getEntranceFeeContext,
  type EntranceFeeContext,
} from "@/lib/xero-mappings";
import { createXeroCreditNoteForModification } from "@/lib/xero-modification-credit-notes";
import { allocateAppliedCreditForBooking } from "@/lib/xero-applied-credit-allocation";
import { deallocateExcessAppliedCreditForBooking } from "@/lib/xero-applied-credit-deallocation";
import { isXeroAppliedCreditOperationBusyError } from "@/lib/xero-applied-credit-operation-serialization";
import { createXeroSupplementaryInvoice } from "@/lib/xero-supplementary-invoices";
import { isXeroConnected } from "@/lib/xero-token-store";
import {
  createXeroInvoiceForGroupSettlement,
  voidXeroInvoiceForCancelledGroupSettlement,
} from "@/lib/xero-group-settlement-invoices";
import { createXeroMembershipSubscriptionInvoice } from "@/lib/xero-subscription-invoices";
import {
  getQueuedOutboxExpectedOperation,
  readQueuedOutboxPayload,
  readQueueType,
  XERO_OUTBOX_ACCOUNT_CREDIT_NOTE_TYPE,
  XERO_OUTBOX_APPLIED_CREDIT_ALLOCATION_TYPE,
  XERO_OUTBOX_APPLIED_CREDIT_DEALLOCATION_TYPE,
  XERO_OUTBOX_BOOKING_INVOICE_TYPE,
  XERO_OUTBOX_BOOKING_INVOICE_UPDATE_TYPE,
  XERO_OUTBOX_CREDIT_NOTE_ALLOCATION_TYPE,
  XERO_OUTBOX_ENTRANCE_FEE_TYPE,
  XERO_OUTBOX_GROUP_SETTLEMENT_INVOICE_TYPE,
  XERO_OUTBOX_GROUP_SETTLEMENT_INVOICE_VOID_TYPE,
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
import { formatDateOnly } from "@/lib/date-only";

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

export async function enqueueXeroBookingInvoiceOperation(
  bookingId: string,
  options?: { createdByMemberId?: string }
) {
  const booking = await prisma.booking.findUnique({
    where: { id: bookingId },
    select: {
      id: true,
      payment: {
        select: {
          id: true,
          xeroInvoiceId: true,
          manuallyMarkedPaidAt: true,
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

  const existingLink = await prisma.xeroObjectLink.findFirst({
    where: {
      localModel: "Payment",
      localId: booking.payment.id,
      xeroObjectType: "INVOICE",
      role: "PRIMARY_INVOICE",
      active: true,
    },
    select: { id: true },
  });

  if (existingLink) {
    return {
      queueOperationId: null,
      message: "Xero booking invoice already linked for this booking.",
    };
  }

  const correlationKey = buildXeroIdempotencyKey(
    "booking",
    bookingId,
    "invoice",
    "v1"
  );

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
    createdByMemberId: options?.createdByMemberId ?? null,
  });

  return {
    queueOperationId: queuedOperation.id,
    message: "Xero booking invoice queued for background processing.",
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

  // Unallocated applied credit = BOOKING_APPLIED rows not yet stamped with an
  // allocated Xero note (the ledger-truth predicate the handler also uses).
  const appliedAgg = await prisma.memberCredit.aggregate({
    where: {
      appliedToBookingId: bookingId,
      type: "BOOKING_APPLIED",
      xeroCreditNoteId: null,
    },
    _sum: { amountCents: true },
  });
  const appliedCents = Math.max(0, -(appliedAgg._sum.amountCents ?? 0));
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

export async function enqueueXeroGroupSettlementInvoiceOperation(
  settlementId: string,
  options?: {
    createdByMemberId?: string;
    store?: Prisma.TransactionClient;
  }
) {
  const db = options?.store ?? prisma;
  const settlement = await db.groupBookingSettlement.findUnique({
    where: { id: settlementId },
    select: {
      id: true,
      xeroInvoiceId: true,
    },
  });

  if (!settlement) {
    throw new Error(`Group settlement not found: ${settlementId}`);
  }

  if (settlement.xeroInvoiceId) {
    return {
      queueOperationId: null,
      message: "Xero settlement invoice already linked for this group.",
    };
  }

  const existingLink = await db.xeroObjectLink.findFirst({
    where: {
      localModel: "GroupBookingSettlement",
      localId: settlement.id,
      xeroObjectType: "INVOICE",
      role: "GROUP_SETTLEMENT_INVOICE",
      active: true,
    },
    select: { id: true },
  });

  if (existingLink) {
    return {
      queueOperationId: null,
      message: "Xero settlement invoice already linked for this group.",
    };
  }

  const correlationKey = buildXeroIdempotencyKey(
    "group-settlement",
    settlementId,
    "invoice",
    "v1"
  );

  const existingQueuedOperation = await db.xeroSyncOperation.findFirst({
    where: {
      correlationKey,
      direction: "OUTBOUND",
      entityType: "INVOICE",
      operationType: "CREATE",
      localModel: "GroupBookingSettlement",
      localId: settlement.id,
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
      message: "Xero settlement invoice is already queued for background processing.",
    };
  }

  const queuedOperation = await startXeroSyncOperation({
    direction: "OUTBOUND",
    entityType: "INVOICE",
    operationType: "CREATE",
    localModel: "GroupBookingSettlement",
    localId: settlement.id,
    status: "PENDING",
    idempotencyKey: correlationKey,
    correlationKey,
    requestPayload: {
      queueType: XERO_OUTBOX_GROUP_SETTLEMENT_INVOICE_TYPE,
      settlementId,
    },
    createdByMemberId: options?.createdByMemberId ?? null,
    store: options?.store,
  });

  return {
    queueOperationId: queuedOperation.id,
    message: "Xero settlement invoice queued for background processing.",
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

export async function enqueueXeroRefundCreditNoteOperation(
  paymentId: string,
  refundAmountCents: number,
  options?: { createdByMemberId?: string; store?: Prisma.TransactionClient }
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

  const canonicalLink = await findCanonicalPaymentRefundCreditNote(paymentId, db);
  let noteAmountCents = refundAmountCents;
  let watermarkCents = refundAmountCents;

  if (payment.source === PaymentSource.STRIPE) {
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
    const coveredCents = await sumCoveredRefundCreditNoteCents(paymentId, db);
    const evidence = await resolveStripeCashRefundEvidence(payment, db);
    noteAmountCents = Math.max(
      0,
      Math.min(refundAmountCents, evidence.cashRefundCents - coveredCents)
    );
    watermarkCents = coveredCents + noteAmountCents;
    if (noteAmountCents <= 0) {
      return {
        queueOperationId: null,
        message:
          "No provider-backed Stripe cash refund remains uncovered by refund credit notes for this payment.",
      };
    }
  } else if (canonicalLink) {
    // Non-Stripe callers (internet-banking cron, group-cancel) issue at most one
    // refund per payment and re-enqueue on cron reruns; the single-note skip
    // absorbs those replays by repointing at the existing note.
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
  const correlationKey = buildXeroIdempotencyKey(
    "payment",
    paymentId,
    "refund-credit-note",
    payment.source === PaymentSource.STRIPE ? watermarkCents : noteAmountCents,
    payment.source === PaymentSource.STRIPE ? "v2" : "v1"
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
      watermarkCents,
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
  options?: { createdByMemberId?: string; store?: Prisma.TransactionClient }
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
      refundAmountCents,
    },
    createdByMemberId: options?.createdByMemberId ?? null,
    store: db,
  });

  return {
    queueOperationId: queuedOperation.id,
    message: "Xero account-credit note queued for background processing.",
  };
}

export async function enqueueXeroSupplementaryInvoiceOperation(
  params: {
    bookingId: string;
    priceDiffCents: number;
    changeFeeCents: number;
    bookingModificationId?: string;
  },
  options?: {
    createdByMemberId?: string;
    paymentIntentId?: string | null;
    waitForConfirmedAdditionalPayment?: boolean;
    recordPayment?: boolean;
  }
) {
  const {
    bookingId,
    priceDiffCents,
    changeFeeCents,
    bookingModificationId,
  } = params;

  // Net-based guard (#1356): the components are signed, and a supplementary
  // invoice exists only to bill a positive net. A mixed-sign edit whose net is
  // not positive settles via the credit-note paths; queueing it here would
  // gross-bill the fee while dropping the larger reduction.
  if (priceDiffCents + changeFeeCents <= 0) {
    return {
      queueOperationId: null,
      message: "No supplementary invoice is required for this modification.",
    };
  }

  const booking = await prisma.booking.findUnique({
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

  const existingLink = await prisma.xeroObjectLink.findFirst({
    where: {
      localModel,
      localId,
      xeroObjectType: "INVOICE",
      role: "SUPPLEMENTARY_INVOICE",
      active: true,
    },
    select: { id: true },
  });

  if (existingLink) {
    return {
      queueOperationId: null,
      message: "Xero supplementary invoice already linked for this modification.",
    };
  }

  const correlationKey = buildXeroIdempotencyKey(
    bookingModificationId ? "booking-mod" : "booking",
    localId,
    "supplementary-invoice",
    priceDiffCents,
    changeFeeCents,
    "v1"
  );

  const existingQueuedOperation = await prisma.xeroSyncOperation.findFirst({
    where: {
      correlationKey,
      direction: "OUTBOUND",
      entityType: "INVOICE",
      operationType: "CREATE",
      localModel,
      localId,
      status: {
        in: ["PENDING", "RUNNING", "WAITING_PAYMENT"],
      },
    },
    orderBy: {
      createdAt: "desc",
    },
  });

  if (existingQueuedOperation) {
    return {
      queueOperationId: existingQueuedOperation.id,
      message: "Xero supplementary invoice is already queued for background processing.",
    };
  }

  const queuedOperation = await startXeroSyncOperation({
    direction: "OUTBOUND",
    entityType: "INVOICE",
    operationType: "CREATE",
    localModel,
    localId,
    status: options?.waitForConfirmedAdditionalPayment ? "WAITING_PAYMENT" : "PENDING",
    idempotencyKey: correlationKey,
    correlationKey,
    requestPayload: {
      queueType: XERO_OUTBOX_SUPPLEMENTARY_INVOICE_TYPE,
      bookingId,
      priceDiffCents,
      changeFeeCents,
      bookingModificationId: bookingModificationId ?? null,
      recordPayment: options?.recordPayment ?? true,
      paymentIntentId: options?.paymentIntentId ?? null,
      waitForConfirmedAdditionalPayment:
        options?.waitForConfirmedAdditionalPayment ?? false,
    },
    createdByMemberId: options?.createdByMemberId ?? null,
  });

  return {
    queueOperationId: queuedOperation.id,
    message: options?.waitForConfirmedAdditionalPayment
      ? "Xero supplementary invoice is waiting for confirmed additional payment."
      : "Xero supplementary invoice queued for background processing.",
  };
}

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

  if (waitingOperations.length === 0) {
    return {
      released: 0,
      queueOperationIds: [] as string[],
    };
  }

  const queueOperationIds = waitingOperations.map((operation) => operation.id);
  const updateResult = await prisma.xeroSyncOperation.updateMany({
    where: {
      id: {
        in: queueOperationIds,
      },
      status: "WAITING_PAYMENT",
    },
    data: {
      status: "PENDING",
      startedAt: null,
      lastErrorCode: null,
      lastErrorMessage: null,
    },
  });

  return {
    released: updateResult.count,
    queueOperationIds,
  };
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
    where: {
      status: "WAITING_PAYMENT",
      direction: "OUTBOUND",
      entityType: "INVOICE",
      operationType: "CREATE",
      requestPayload: {
        path: ["bookingModificationId"],
        equals: bookingModificationId,
      },
    },
    select: { id: true, requestPayload: true },
  });

  let attached = 0;
  for (const operation of waitingOperations) {
    const payload =
      operation.requestPayload &&
      typeof operation.requestPayload === "object" &&
      !Array.isArray(operation.requestPayload)
        ? (operation.requestPayload as Record<string, unknown>)
        : null;
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

const STALE_WAITING_PAYMENT_AGE_DAYS = 14;

// F19 (#1887): a FAILED Stripe payment does not reap its WAITING_PAYMENT Xero
// op immediately. A failed PaymentIntent can be retried and SUCCEED on the same
// intent id, so cancelling the moment the transaction flips FAILED races that
// retry — the member's card is captured but the Xero invoice op is gone. Only
// reap a FAILED transaction that has stayed FAILED past this grace window, by
// which point a retry-success is no longer realistic (Stripe intents do not
// stay retriable this long). The 14-day createdAt sweep is the separate,
// intent-agnostic backstop for ops whose intent never resolved at all.
const FAILED_TRANSACTION_REAP_GRACE_HOURS = 24;

export async function reapStaleWaitingPaymentXeroOutboxOperations(options?: {
  /** Override the staleness threshold in days. Defaults to 14. */
  ageInDays?: number;
  /**
   * Override the FAILED-transaction grace window in hours. Defaults to 24. A
   * FAILED Stripe transaction only reaps its WAITING_PAYMENT op once it has been
   * FAILED for at least this long (F19, #1887).
   */
  failedTransactionGraceHours?: number;
}): Promise<{ reaped: number; queueOperationIds: string[] }> {
  const ageInDays =
    options?.ageInDays ?? STALE_WAITING_PAYMENT_AGE_DAYS;
  const ageThreshold = new Date(
    Date.now() - ageInDays * 24 * 60 * 60 * 1000,
  );
  const failedGraceHours =
    options?.failedTransactionGraceHours ?? FAILED_TRANSACTION_REAP_GRACE_HOURS;
  const failedGraceThreshold = new Date(
    Date.now() - failedGraceHours * 60 * 60 * 1000,
  );

  const waitingOperations = await prisma.xeroSyncOperation.findMany({
    where: {
      status: "WAITING_PAYMENT",
      direction: "OUTBOUND",
    },
    select: {
      id: true,
      createdAt: true,
      requestPayload: true,
    },
  });

  if (waitingOperations.length === 0) {
    return { reaped: 0, queueOperationIds: [] };
  }

  const reapableIds: string[] = [];
  for (const operation of waitingOperations) {
    if (operation.createdAt <= ageThreshold) {
      reapableIds.push(operation.id);
      continue;
    }

    const payload = operation.requestPayload as
      | { paymentIntentId?: string | null }
      | null;
    const paymentIntentId = payload?.paymentIntentId ?? null;
    if (!paymentIntentId) continue;

    // F19 (#1887): require the transaction to have been FAILED, by its
    // `updatedAt`, since before the grace window, so a not-yet-retried failure
    // cannot be cancelled out from under a same-intent retry about to succeed. A
    // retry that already succeeded flips this same row to SUCCEEDED, so the
    // status filter alone excludes it; the grace only guards the narrow
    // FAILED→about-to-SUCCEED race.
    //
    // Caveat (not "stable in the terminal state"): a redelivered
    // payment_intent.payment_failed re-runs markPaymentIntentTransactionFailed,
    // which writes status=FAILED unconditionally, so Prisma's @updatedAt bumps
    // and the 24h grace RESTARTS on each redelivered failure. The effect is
    // benign — it can only DELAY the reap, never reap early — and the
    // intent-agnostic 14-day createdAt sweep is the hard backstop that bounds it.
    // If exact grace semantics are ever needed, anchor on a dedicated
    // last-failure timestamp rather than @updatedAt.
    const failedTransaction = await prisma.paymentTransaction.findFirst({
      where: {
        source: "STRIPE",
        stripePaymentIntentId: paymentIntentId,
        status: "FAILED",
        updatedAt: { lte: failedGraceThreshold },
      },
      select: { id: true },
    });
    if (failedTransaction) {
      reapableIds.push(operation.id);
    }
  }

  if (reapableIds.length === 0) {
    return { reaped: 0, queueOperationIds: [] };
  }

  const updateResult = await prisma.xeroSyncOperation.updateMany({
    where: {
      id: { in: reapableIds },
      status: "WAITING_PAYMENT",
    },
    data: {
      status: "CANCELLED",
      completedAt: new Date(),
      lastErrorCode: "STALE_WAITING_PAYMENT",
      lastErrorMessage:
        "Reaped: linked Stripe payment failed or did not confirm in time.",
    },
  });

  if (updateResult.count > 0) {
    logger.info(
      { reaped: updateResult.count, ageInDays },
      "Reaped stale WAITING_PAYMENT Xero outbox operations",
    );
  }

  return {
    reaped: updateResult.count,
    queueOperationIds: reapableIds,
  };
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

  await completeXeroSyncOperation(operation.id, {
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
  },
  options?: { createdByMemberId?: string }
) {
  const {
    bookingId,
    refundAmountCents,
    bookingModificationId,
  } = params;

  if (refundAmountCents <= 0) {
    return {
      queueOperationId: null,
      message: "No modification credit note is required for this change.",
    };
  }

  const booking = await prisma.booking.findUnique({
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

  const existingLink = await prisma.xeroObjectLink.findFirst({
    where: {
      localModel,
      localId,
      xeroObjectType: "CREDIT_NOTE",
      role: "MODIFICATION_CREDIT_NOTE",
      active: true,
    },
    select: { id: true },
  });

  if (existingLink) {
    return {
      queueOperationId: null,
      message: "Xero modification credit note already linked for this change.",
    };
  }

  const correlationKey = buildXeroIdempotencyKey(
    bookingModificationId ? "booking-mod" : "booking",
    localId,
    "mod-credit-note",
    refundAmountCents,
    "v1"
  );

  const existingQueuedOperation = await prisma.xeroSyncOperation.findFirst({
    where: {
      correlationKey,
      direction: "OUTBOUND",
      entityType: "CREDIT_NOTE",
      operationType: "CREATE",
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
    },
    createdByMemberId: options?.createdByMemberId ?? null,
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
  },
  options?: { createdByMemberId?: string }
) {
  const {
    bookingId,
    refundAmountCents,
    bookingModificationId,
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

  const existingLink = await prisma.xeroObjectLink.findFirst({
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
  // operations oldest-first (orderBy createdAt asc), so this ensures the credit
  // note is pushed to Xero before the contact is archived. Archiving first
  // would block the credit note, because Xero rejects credit notes raised
  // against an archived contact. The contact operation also re-checks this at
  // run time and defers if the credit note has not settled yet.
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
    },
    orderBy: {
      createdAt: "asc",
    },
    take: limit,
  });

  const result: ProcessQueuedXeroOutboxOperationsResult = {
    found: queuedOperations.length,
    processed: 0,
    succeeded: 0,
    failed: 0,
    skipped: 0,
  };

  for (const queuedOperation of queuedOperations) {
    const payload = readQueuedOutboxPayload(queuedOperation.requestPayload);
    const queueType = readQueueType(queuedOperation.requestPayload);
    const expectedOperation = getQueuedOutboxExpectedOperation(queueType);
    const claimed = await claimQueuedOutboxOperation(queuedOperation.id, expectedOperation);
    if (!claimed) {
      result.skipped += 1;
      continue;
    }

    result.processed += 1;

    const entranceFeeContext = payload
      ? buildPrecomputedEntranceFeeContext(payload)
      : null;

    try {
      if (
        payload?.queueType === XERO_OUTBOX_ENTRANCE_FEE_TYPE &&
        queuedOperation.localId &&
        entranceFeeContext
      ) {
        await createXeroEntranceFeeInvoice(queuedOperation.localId, {
          createdByMemberId: queuedOperation.createdByMemberId ?? undefined,
          syncOperationId: queuedOperation.id,
          precomputedEntranceFee: entranceFeeContext,
        });
      } else if (payload?.queueType === XERO_OUTBOX_BOOKING_INVOICE_TYPE) {
        await createXeroInvoiceForBooking(payload.bookingId, {
          createdByMemberId: queuedOperation.createdByMemberId ?? undefined,
          syncOperationId: queuedOperation.id,
        });
      } else if (payload?.queueType === XERO_OUTBOX_BOOKING_INVOICE_UPDATE_TYPE) {
        await updateXeroBookingInvoiceForBooking(payload.bookingId, {
          createdByMemberId: queuedOperation.createdByMemberId ?? undefined,
          syncOperationId: queuedOperation.id,
        });
      } else if (
        payload?.queueType === XERO_OUTBOX_GROUP_SETTLEMENT_INVOICE_TYPE
      ) {
        await createXeroInvoiceForGroupSettlement(payload.settlementId, {
          createdByMemberId: queuedOperation.createdByMemberId ?? undefined,
          syncOperationId: queuedOperation.id,
        });
      } else if (
        payload?.queueType === XERO_OUTBOX_GROUP_SETTLEMENT_INVOICE_VOID_TYPE
      ) {
        await voidXeroInvoiceForCancelledGroupSettlement(
          payload.settlementId,
          { syncOperationId: queuedOperation.id }
        );
      } else if (
        payload?.queueType === XERO_OUTBOX_SUBSCRIPTION_INVOICE_TYPE
      ) {
        await createXeroMembershipSubscriptionInvoice({
          chargeId: payload.chargeId,
          createdByMemberId: queuedOperation.createdByMemberId ?? undefined,
          syncOperationId: queuedOperation.id,
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
            syncOperationId: queuedOperation.id,
            watermarkCents: payload.watermarkCents,
          }
        );
      } else if (
        payload?.queueType === XERO_OUTBOX_ACCOUNT_CREDIT_NOTE_TYPE &&
        queuedOperation.localId
      ) {
        await createUnappliedXeroCreditNote(
          queuedOperation.localId,
          payload.refundAmountCents,
          {
            createdByMemberId: queuedOperation.createdByMemberId ?? undefined,
            syncOperationId: queuedOperation.id,
          }
        );
      } else if (
        payload?.queueType === XERO_OUTBOX_MODIFICATION_ACCOUNT_CREDIT_NOTE_TYPE
      ) {
        await createUnappliedXeroCreditNoteForModification({
          paymentId: payload.paymentId,
          refundAmountCents: payload.refundAmountCents,
          bookingModificationId: payload.bookingModificationId,
          createdByMemberId: queuedOperation.createdByMemberId ?? undefined,
          syncOperationId: queuedOperation.id,
        });
      } else if (payload?.queueType === XERO_OUTBOX_SUPPLEMENTARY_INVOICE_TYPE) {
        await createXeroSupplementaryInvoice({
          bookingId: payload.bookingId,
          priceDiffCents: payload.priceDiffCents,
          changeFeeCents: payload.changeFeeCents,
          bookingModificationId: payload.bookingModificationId,
          recordPayment: payload.recordPayment ?? true,
          createdByMemberId: queuedOperation.createdByMemberId ?? undefined,
          syncOperationId: queuedOperation.id,
        });
      } else if (payload?.queueType === XERO_OUTBOX_MODIFICATION_CREDIT_NOTE_TYPE) {
        await createXeroCreditNoteForModification({
          bookingId: payload.bookingId,
          refundAmountCents: payload.refundAmountCents,
          bookingModificationId: payload.bookingModificationId,
          createdByMemberId: queuedOperation.createdByMemberId ?? undefined,
          syncOperationId: queuedOperation.id,
        });
      } else if (
        payload?.queueType === XERO_OUTBOX_MEMBERSHIP_CANCELLATION_CREDIT_NOTE_TYPE
      ) {
        await createXeroMembershipCancellationCreditNote({
          subscriptionId: payload.subscriptionId,
          requestId: payload.requestId,
          participantId: payload.participantId,
          createdByMemberId: queuedOperation.createdByMemberId ?? undefined,
          syncOperationId: queuedOperation.id,
        });
      } else if (
        payload?.queueType === XERO_OUTBOX_MEMBERSHIP_CANCELLATION_CONTACT_TYPE
      ) {
        await syncXeroMembershipCancellationContact({
          memberId: payload.memberId,
          requestId: payload.requestId,
          participantId: payload.participantId,
          createdByMemberId: queuedOperation.createdByMemberId ?? undefined,
          syncOperationId: queuedOperation.id,
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
            syncOperationId: queuedOperation.id,
          }
        );
      } else if (
        payload?.queueType === XERO_OUTBOX_APPLIED_CREDIT_ALLOCATION_TYPE
      ) {
        await allocateAppliedCreditForBooking(payload.bookingId, {
          createdByMemberId: queuedOperation.createdByMemberId ?? undefined,
          syncOperationId: queuedOperation.id,
        });
      } else if (
        payload?.queueType === XERO_OUTBOX_APPLIED_CREDIT_DEALLOCATION_TYPE
      ) {
        await deallocateExcessAppliedCreditForBooking(payload.bookingId, {
          syncOperationId: queuedOperation.id,
        });
      } else {
        throw new Error("Queued Xero outbox payload is incomplete.");
      }

      result.succeeded += 1;
    } catch (error) {
      if (isXeroAppliedCreditOperationBusyError(error)) {
        // Two independent outbox runners can claim allocation and deallocation
        // for the same Payment before either handler observes the other. That
        // collision is transient: return this row to PENDING so the next scan
        // serializes them, rather than stranding both rows as FAILED.
        await prisma.xeroSyncOperation.updateMany({
          where: { id: queuedOperation.id, status: "RUNNING" },
          data: {
            status: "PENDING",
            startedAt: null,
            lastErrorCode: null,
            lastErrorMessage: null,
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
        // state the outbox expects. Twelve of the fifteen queue types own a
        // `catch { await failXeroSyncOperation(<this outbox row>, error); throw }`,
        // and `failXeroSyncOperation` writes `status: FAILED` + `completedAt`
        // with no status guard — so by the time this branch runs the row is
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
            status: { in: ["RUNNING", "FAILED"] },
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
          continue;
        }
        // The row was in neither RUNNING nor FAILED (e.g. a concurrent worker
        // moved it out from under us). Do NOT report a return-to-PENDING that
        // did not happen — that false "skipped" is what let an incident summary
        // tell an operator the queue would self-heal while invoices sat stuck.
        // Fall through to the honest FAILED path so the log and the failed
        // counter reflect a row that was NOT recovered.
        logger.warn(
          {
            err: error,
            queueOperationId: queuedOperation.id,
            queueType: payload?.queueType ?? null,
          },
          "Xero cooldown refused an outbox operation but the row was not in a returnable state; failing it"
        );
      }
      if (payload?.queueType === XERO_OUTBOX_SUBSCRIPTION_INVOICE_TYPE) {
        const currentCharge = await prisma.membershipSubscriptionCharge.findUnique({
          where: { id: payload.chargeId },
          select: { xeroInvoiceId: true, status: true },
        }).catch(() => null);
        // #2147: never resurrect a VOIDED charge (its invoice was voided and its
        // coverage released) back to a retryable QUEUED/EMAIL_FAILED state.
        if (currentCharge && currentCharge.status !== "VOIDED") {
          await prisma.membershipSubscriptionCharge.update({
            where: { id: payload.chargeId },
            data: {
              status: currentCharge.xeroInvoiceId ? "EMAIL_FAILED" : "QUEUED",
              lastErrorCode: currentCharge.xeroInvoiceId ? "EMAIL_FAILED" : "XERO_FAILED",
              lastErrorMessage: error instanceof Error ? error.message : String(error),
            },
          }).catch((chargeError) => {
            logger.error({ err: chargeError, chargeId: payload.chargeId }, "Failed to expose subscription charge outbox error");
          });
        }
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
      try {
        await failXeroSyncOperation(
          queuedOperation.id,
          error instanceof Error ? error : new Error(String(error))
        );
      } catch (failErr) {
        logger.error(
          { err: failErr, queueOperationId: queuedOperation.id },
          "Failed to mark queued Xero outbox operation FAILED after an error"
        );
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
