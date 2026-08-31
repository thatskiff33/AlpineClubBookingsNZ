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
  buildXeroSupplementaryInvoiceKey,
  type XeroSupplementaryInvoiceAnchorModel,
} from "@/lib/xero-supplementary-invoice-key";
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

/**
 * The two states in which a queued supplementary invoice has not yet reached
 * Xero, so its amount may still be restated. Named once because the read and the
 * write must use the SAME set - a filter on one and not the other is a
 * check-then-act, which is how a restate came to rewrite an operation the outbox
 * had already moved on (#3170 fix round, F3).
 */
const RESTATABLE_SUPPLEMENTARY_INVOICE_STATUSES = [
  "PENDING",
  "WAITING_PAYMENT",
] as const;

/**
 * The states in which a supplementary invoice for this anchor is still going to
 * be sent, so a second one must not be queued behind it. Wider than the
 * restatable set by `RUNNING`: an operation the outbox is executing right now
 * cannot have its amount changed, but it is very much still an invoice.
 */
const OUTSTANDING_SUPPLEMENTARY_INVOICE_STATUSES = [
  "PENDING",
  "RUNNING",
  "WAITING_PAYMENT",
] as const;

/**
 * #3170 fix round (F2): the advisory key that makes "one supplementary invoice
 * per booking modification" TRUE rather than asserted.
 *
 * The check-then-create below was racy, and the race lost real money rather than
 * merely duplicating work. Two officers settling the two review tasks of one
 * booking edit both compute a total, both find nothing queued for the anchor, and
 * both queue - and because the queued-operation lookup deduped on a
 * `correlationKey` BUILT FROM THE AMOUNT, $200 and $230 were two different keys
 * and neither found the other. `createXeroSupplementaryInvoice` has no
 * active-link guard of its own and its provider idempotency key also embeds the
 * amount, so that is two Xero invoices to the member totalling $430 for a $230
 * edit. Before the combined request each share queued its own amount and the
 * concurrent case summed correctly, so this shape was introduced by the combining
 * and had to be closed by it.
 *
 * A scoped, namespaced key in the ordinary style of `backup-run.ts`'s
 * reap-check-insert claim: held for the milliseconds of one short transaction
 * that reads and writes only `XeroSyncOperation` and `XeroObjectLink`, composing
 * with no other lock family, so no ordering cycle is possible. The Xero round
 * trip happens later, in the outbox worker, entirely outside this transaction.
 *
 * THE THREE CALLERS, NAMED, because "every caller is post-commit" was not true
 * and a lock-ordering claim has to be checkable. An enumeration written to be
 * audited is worse than useless once it is silently incomplete, so a new caller
 * belongs in this list before it belongs in the tree.
 *
 *   1. The SETTLEMENT callers reach it post-commit through a fire-and-forget
 *      `queueXeroBookingEditSettlement`, holding nothing.
 *   2. The booking-vs-Xero REPAIR PASS (`xero-booking-repair-passes.ts`,
 *      `QUEUE_SUPPLEMENTARY_INVOICE`) calls it DIRECTLY. That pass is an
 *      operator-driven admin/CLI action which opens no transaction of its own
 *      and holds no advisory lock, so it too arrives holding nothing.
 *   3. The PAYMENT-RECOVERY WORKER (#3181,
 *      `processCreateAdditionalPaymentIntentOperation` ->
 *      `completeDeferredXeroSupplementaryInvoice`), raising the supplementary
 *      invoice a failed mint deferred. It claims its recovery row with a
 *      status-guarded `updateMany` rather than a transaction, and every write it
 *      makes is its own short statement, so it holds neither a transaction nor an
 *      advisory lock when it arrives - and its Stripe round trip has completed
 *      long before this line.
 *
 * The conclusion is unchanged, and for a stronger reason than "they are all
 * post-commit": none of the three holds anything. This remains a single-lock
 * holder either way.
 *
 * ONE THING THIS TRANSACTION TAKES AWAY, recorded because it is easy to miss:
 * `startXeroSyncOperation` below runs on `tx`, and its P2002 fallback - re-read
 * the winner's row and return it - cannot run inside an aborted Postgres
 * transaction. Under this lock that fallback is unreachable: a concurrent
 * enqueue for the same anchor is serialised behind us and finds our row through
 * the queued-check above, so the create never races. It is defence-in-depth for
 * the module-client callers and dead code here, not a recovery this path can
 * rely on.
 */
const XERO_SUPPLEMENTARY_INVOICE_LOCK_NAMESPACE = "xero-supplementary-invoice";

/**
 * DOES THIS EDIT'S ACCOUNTING ASK NOW BILL WHAT THE CALLER ASKED FOR? (#3170 fix
 * round, F2.)
 *
 * The `message` beside this is prose for an operator's repair report and has
 * always been read by a person; nothing could branch on it. The edit-review
 * settlement needs to branch on it, because the difference between "the invoice
 * now bills the combined total" and "the invoice had already left the queue and
 * bills the earlier figure" is the difference between a settled share that is
 * billed and one the club has to collect by hand. Deciding that HERE, where the
 * link check, the queued check and the restate all happen under one lock, is the
 * only place it can be decided at all - the caller can no longer tell afterwards,
 * because `createXeroSupplementaryInvoice` overwrites the operation's payload
 * with the Xero invoice body at dispatch.
 *
 *   * `covers-total` - the ask bills at least the requested net, because this
 *     call queued it, raised it, or found it already asking for that much.
 *   * `short` - an invoice for this anchor exists and could NOT be raised: the
 *     outbox has claimed it (RUNNING), or it has already been sent and the anchor
 *     carries an active `SUPPLEMENTARY_INVOICE` link. Refusing to queue a second
 *     one is correct - two invoices for one edit is the failure this round
 *     removed - but the difference is now owed outside the invoice.
 *   * `none` - no supplementary invoice is involved at all: nothing positive to
 *     bill, or the booking has no primary Xero invoice to supplement. Not a
 *     shortfall, and not a success either.
 */
export type XeroSupplementaryInvoiceEnqueueOutcome =
  | "covers-total"
  | "short"
  | "none";

/**
 * THE SECOND ASK (#3193, epic #2797): raise a settled review share's OWN small
 * supplementary invoice, because the booking change's invoice had already left
 * the queue and could not be raised to include it.
 *
 * The owner decided on 31 Aug 2026 that the difference is billed through the
 * system rather than chased by hand. That NARROWS #3170's "one booking edit, one
 * ask" rather than overturning it: while the invoice is still in the queue a
 * second settlement RAISES it and the member is asked once, which remains the
 * ordinary case. Only once the invoice has been claimed for sending or sent -
 * the window where the alternative was billing the member too little - does the
 * difference become its own ask.
 *
 * WHY IT CANNOT DOUBLE-BILL, which is the whole design and not a caveat:
 *
 *   * IT BILLS THE SHARE, NEVER THE TOTAL. This function is reached only when
 *     `enqueueXeroSupplementaryInvoiceOperation` answered `short`, and `short`
 *     means the caller's restate found nothing restatable AND nothing already
 *     covering - so this share is provably NOT in the invoice that went out.
 *     Every settled share is therefore billed exactly once: by the change's
 *     invoice if it was in it, by its own invoice if it was not. The shares sum
 *     to the derived total by construction, with no figure read back off a sent
 *     invoice and no difference computed from anything the club would have to
 *     guess.
 *   * IT ANCHORS ON THE TASK, NOT THE CHANGE. The outbox row and the resulting
 *     `XeroObjectLink` sit on `ManualRefundTask/<taskId>`, so the link-check and
 *     the queued-check below fence THIS SHARE'S ask - one per share, whatever
 *     order shares settle in and however many there are. Two shares racing after
 *     the invoice went out are two different keys doing two independent, correct
 *     things; they cannot both bill the same difference, because neither of them
 *     bills a difference at all.
 *   * IT IS INVISIBLE TO THE ORDINARY PATH, and that is load-bearing rather than
 *     tidy. A pending second ask found by the change's own restate would be
 *     RAISED to the combined total - $30 becoming $230 on top of a $200 invoice
 *     already sent. It cannot be found there, because every one of those reads is
 *     scoped to `BookingModification/<modificationId>`.
 *
 * Safe to run twice, which a settlement's fire-and-forget dispatch needs: a
 * second call for the same task finds its own queued operation or its own active
 * link and queues nothing.
 *
 * A NAMED PATH, not a relaxation of the refusal. It reaches the same locked
 * decision the ordinary enqueue makes - one transaction, one advisory key, one
 * link-check -> queued-check -> write - with a different anchor, so there is
 * still exactly one place that answers "does this ask already have an invoice
 * going out?".
 */
export async function enqueueXeroSecondSupplementaryInvoiceOperation(
  params: {
    bookingId: string;
    bookingModificationId: string;
    /** The review task whose settled share this invoice bills. The anchor. */
    reviewTaskId: string;
    /** That share, and only that share. Never the edit's combined total. */
    shareCents: number;
  },
  options?: { createdByMemberId?: string }
) {
  return enqueueXeroSupplementaryInvoiceOperation(
    {
      bookingId: params.bookingId,
      priceDiffCents: params.shareCents,
      changeFeeCents: 0,
      bookingModificationId: params.bookingModificationId,
    },
    {
      createdByMemberId: options?.createdByMemberId,
      /**
       * UNPAID AND SENT NOW, on both routes, and the card route is the one worth
       * arguing. `short` on the card route requires the change's invoice to have
       * left WAITING_PAYMENT, which only the additional payment confirming can
       * do - so the card has already been taken at the EARLIER figure and this
       * share is genuinely unbilled. Recording a payment against it would invent
       * money nobody sent, and waiting for a payment would wait for a
       * confirmation that has already happened.
       */
      recordPayment: false,
      waitForConfirmedAdditionalPayment: false,
      paymentIntentId: null,
      shortfallReviewTaskId: params.reviewTaskId,
    }
  );
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
    /**
     * #3193: anchor this invoice on a review task instead of the booking change,
     * because it bills that task's settled share alone. Set ONLY by
     * `enqueueXeroSecondSupplementaryInvoiceOperation` above, which is where the
     * reasoning lives.
     */
    shortfallReviewTaskId?: string;
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
      outcome: "none" as XeroSupplementaryInvoiceEnqueueOutcome,
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
      outcome: "none" as XeroSupplementaryInvoiceEnqueueOutcome,
      message: "No original Xero invoice exists for this booking.",
    };
  }

  // #3193: a second ask anchors on the review task whose share it bills, so
  // every read below - the link check, the queued check, the advisory key - is
  // scoped to that share rather than to the booking change's own invoice.
  const shortfallReviewTaskId = options?.shortfallReviewTaskId ?? null;
  const localModel: XeroSupplementaryInvoiceAnchorModel = shortfallReviewTaskId
    ? "ManualRefundTask"
    : bookingModificationId
      ? "BookingModification"
      : "Booking";
  const localId = shortfallReviewTaskId ?? bookingModificationId ?? bookingId;

  const correlationKey = buildXeroSupplementaryInvoiceKey({
    localModel,
    localId,
    priceDiffCents,
    changeFeeCents,
  });

  /**
   * ONE SUPPLEMENTARY INVOICE PER ANCHOR, decided under a lock (#3170 fix round).
   *
   * Two things changed here and they only work together. The lock
   * (`XERO_SUPPLEMENTARY_INVOICE_LOCK_NAMESPACE`) serialises the whole
   * link-check -> queued-check -> write against another settlement of the same
   * edit; and the queued check is now scoped to the ANCHOR rather than to a
   * `correlationKey` that embeds the amount, so a second share arriving with a
   * larger total FINDS the first invoice instead of queueing a second one beside
   * it. Either alone leaves a way to send two invoices for one edit.
   *
   * Finding one does not mean leaving it alone: an operation asking for LESS is
   * raised to this total through the one restate function, so the second share is
   * billed rather than silently dropped. That function refuses to LOWER, so a
   * stale, smaller total arriving second changes nothing.
   */
  return prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${XERO_SUPPLEMENTARY_INVOICE_LOCK_NAMESPACE}), hashtext(${localId}))`;

    const existingLink = await tx.xeroObjectLink.findFirst({
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
      // `short`, not `covers-total`, and the caller acts on the difference.
      // The invoice has been SENT, so what it bills is whatever the payload said
      // when the worker picked it up - a figure this row no longer holds, because
      // the handler overwrote the payload with the Xero invoice body. An
      // edit-review share only reaches here after failing to restate, which on
      // that path means the ask went out before this share was settled; treating
      // that as covered would be the silent drop the whole round removed.
      return {
        queueOperationId: null,
        outcome: "short" as XeroSupplementaryInvoiceEnqueueOutcome,
        message: "Xero supplementary invoice already linked for this modification.",
      };
    }

    const existingQueuedOperation = await tx.xeroSyncOperation.findFirst({
      where: {
        direction: "OUTBOUND",
        entityType: "INVOICE",
        operationType: "CREATE",
        localModel,
        localId,
        queueType: XERO_OUTBOX_SUPPLEMENTARY_INVOICE_TYPE,
        status: {
          in: [...OUTSTANDING_SUPPLEMENTARY_INVOICE_STATUSES],
        },
      },
      orderBy: {
        createdAt: "desc",
      },
    });

    if (existingQueuedOperation) {
      const raised = await restatePendingSupplementaryInvoiceAmount({
        bookingModificationId: localId,
        // `localId` is the BOOKING id when no modification id was supplied, so
        // the model has to travel with it. Hard-coding `BookingModification`
        // there matched nothing and silently skipped the raise (#3170 fix round,
        // nit 3).
        localModel,
        priceDiffCents,
        changeFeeCents,
        store: tx,
      });
      // Raised, or already asking for at least this much: either way the queued
      // invoice bills the requested net. Zero on BOTH counters is the one case
      // that does not - the operation is RUNNING, outside the restatable set, so
      // the outbox is sending the earlier figure right now.
      const coversTotal = raised.restated + raised.alreadyCovering > 0;
      return {
        queueOperationId: existingQueuedOperation.id,
        outcome: (coversTotal
          ? "covers-total"
          : "short") as XeroSupplementaryInvoiceEnqueueOutcome,
        message:
          raised.restated > 0
            ? "Xero supplementary invoice already queued for this change was raised to the combined amount."
            : coversTotal
              ? "Xero supplementary invoice is already queued for background processing."
              : "Xero supplementary invoice for this change is already being sent and could not be raised.",
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
        // #3193: the handler reads this to anchor the link, scope the Xero
        // idempotency key and tell the member why they are being asked twice.
        shortfallReviewTaskId,
      },
      createdByMemberId: options?.createdByMemberId ?? null,
      store: tx,
    });

    return {
      queueOperationId: queuedOperation.id,
      outcome: "covers-total" as XeroSupplementaryInvoiceEnqueueOutcome,
      message: options?.waitForConfirmedAdditionalPayment
        ? "Xero supplementary invoice is waiting for confirmed additional payment."
        : "Xero supplementary invoice queued for background processing.",
    };
  });
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
/**
 * #3170 (epic #2797): raise what an already-queued supplementary invoice will
 * bill, in place, instead of queueing a second one for the same booking edit.
 *
 * ONE EDIT, ONE ASK. A booking edit whose money could not be valued can raise TWO
 * review tasks, and an officer may settle both as money owed to the club. The
 * owner's 30 Aug 2026 decision on #3170 is that both contribute to a single
 * request for the total, so the Xero leg has to move with it: the supplementary
 * invoice must bill $230, not $200 and then $30.
 *
 * QUEUEING THE SECOND ONE DOES NOT WORK, which is why this exists rather than a
 * second `enqueueXeroSupplementaryInvoiceOperation` call.
 * `enqueueXeroSupplementaryInvoiceOperation` refuses an anchor that already has
 * an active `SUPPLEMENTARY_INVOICE` link and returns a message rather than an
 * error, so the second share would be dropped in silence; and where it did NOT
 * refuse, the club would send two invoices for one edit while the member's card
 * is asked for one combined figure.
 *
 * ONLY OPERATIONS THAT HAVE NOT RUN. PENDING and WAITING_PAYMENT are the two
 * states in which nothing has reached Xero yet, so restating the amount changes
 * what will be billed rather than contradicting what was. An operation in any
 * other state - RUNNING, SUCCEEDED, FAILED - is left alone, and the caller's
 * pre-claim refusal (`REVIEW_CHARGE_REQUEST_CLOSED_MESSAGE`) is what stops a
 * share reaching an ask that has already gone out.
 *
 * THE STATUS FILTER IS ON THE READ **AND** ON THE WRITE (#3170 fix round, F3).
 * It was on the read alone, which is a check-then-act: an operation that left
 * PENDING between the two statements was rewritten anyway, contradicting the
 * paragraph above. The write is now an `updateMany` carrying the same status
 * predicate, so a row that has moved on matches nothing and is counted as not
 * restated.
 *
 * THE STATUS GUARD ONLY MEANS ANYTHING BECAUSE THE WORKER RE-READS AFTER ITS
 * CLAIM (#3170 fix round, F1). The guard alone was not enough and the gap was
 * not the one previously documented here. `processQueuedXeroOutboxOperations`
 * loaded each operation's `requestPayload` in its SCAN and claimed the row only
 * when the loop reached it - one Xero round trip per row later. In that window
 * the row is still PENDING, so a restate MATCHES and WRITES and honestly reports
 * `restated: 1`, while the send that follows uses the scanned figure. Its caller
 * then returns early believing the combined total is billed. On the
 * internet-banking route, where the supplementary invoice IS the ask, that
 * invoiced $200 of a $230 edit and left the $30 recorded nowhere. The worker now
 * re-reads the payload after the claim commits, so a restate either lands and is
 * sent, or matches nothing and reports `restated: 0`. There is no third outcome.
 *
 * WHAT IS STILL NOT GUARANTEED, STATED RATHER THAN IMPLIED: that a restate can
 * always land at all. Once the worker has claimed the row it is RUNNING, and
 * once the invoice exists the anchor carries an active `SUPPLEMENTARY_INVOICE`
 * link; a share settled after either point meets an ask that has left the
 * building. This function reports `restated: 0` and `alreadyCovering: 0`, the
 * caller falls through to the ordinary enqueue, and the enqueue refuses to queue
 * a second invoice behind the first. That refusal is correct - two invoices for
 * one edit is the failure this whole round exists to remove - but it is not
 * free: the invoice bills the earlier figure, and the club has to collect the
 * difference by hand. The settlement path therefore reads the enqueue's own
 * verdict and writes an audit row when the ask is short
 * (`recordUncollectedEditReviewChargeShare`, leg `xero-invoice`), which is the
 * only reason this residual is a recoverable shortfall rather than lost money.
 *
 * IT NEVER LOWERS AN ASK. The combined total is derived from settled shares and
 * a settled share is terminal, so the figure only ever grows and a SMALLER one is
 * always the older answer. Two settlements racing can compute their totals in
 * either order, so without this comparison the stale run's restate could land
 * last and take a queued $230 invoice back down to $200 - and its caller would
 * then return early, having "restated", so nothing re-queued the difference. An
 * operation already asking for at least this much is counted in
 * `alreadyCovering` instead: nothing is written, and the caller still knows not
 * to queue a second invoice behind it.
 *
 * The correlation key moves with the amount, because it is built FROM the amount:
 * leaving it stale would let a later enqueue for the new total find no match and
 * queue a duplicate.
 *
 * Returns how many operations this raised and how many already asked for at least
 * this much. `restated + alreadyCovering === 0` means "nothing is queued for this
 * edit", which is the FIRST share's ordinary answer and tells the caller to
 * enqueue normally.
 */
export async function restatePendingSupplementaryInvoiceAmount({
  bookingModificationId,
  localModel = "BookingModification",
  priceDiffCents,
  changeFeeCents,
  store = prisma,
}: {
  bookingModificationId: string;
  /**
   * The anchor's model, because `localId` alone does not identify a row.
   *
   * Defaults to `BookingModification`, which is every edit-review caller and was
   * the hard-coded value. It is a parameter because
   * `enqueueXeroSupplementaryInvoiceOperation` also anchors on the BOOKING when
   * no modification id is supplied: passing that booking id under a hard-coded
   * `BookingModification` matched nothing by construction, so the enqueue's own
   * docblock claim that a queued operation asking for LESS is raised was false
   * on exactly that branch - quietly, because "nothing matched" and "nothing
   * needed raising" return the same zeroes.
   *
   * `ManualRefundTask` is #3193's second ask. A raise there is only ever a
   * no-op: a settled share is a terminal, fixed figure, so a repeat arrives with
   * the amount already queued and is counted as `alreadyCovering`. It is passed
   * through rather than special-cased because the enqueue's decision is one
   * decision for all three anchors, and a carve-out would be a second answer to
   * the same question.
   */
  localModel?: XeroSupplementaryInvoiceAnchorModel;
  priceDiffCents: number;
  changeFeeCents: number;
  /**
   * The enqueue calls this from INSIDE its advisory-locked transaction, so the
   * raise and the decision not to queue a second invoice are one atomic act.
   * Every other caller runs post-commit on the module client.
   */
  store?: Prisma.TransactionClient | typeof prisma;
}): Promise<{ restated: number; alreadyCovering: number }> {
  const operations = await store.xeroSyncOperation.findMany({
    where: {
      status: { in: [...RESTATABLE_SUPPLEMENTARY_INVOICE_STATUSES] },
      direction: "OUTBOUND",
      entityType: "INVOICE",
      operationType: "CREATE",
      localModel,
      localId: bookingModificationId,
      requestPayload: {
        path: ["queueType"],
        equals: XERO_OUTBOX_SUPPLEMENTARY_INVOICE_TYPE,
      },
    },
    select: { id: true, requestPayload: true },
  });

  // The SAME shape the enqueue mints, prefix included: it derives the prefix
  // from the anchor's model, so restating a Booking-anchored operation under a
  // `booking-mod` prefix would leave the row describing an anchor it does not
  // have. #3193 collapsed the three copies of that shape into one mint rather
  // than adding a fourth anchor to each of them (`INV-SSOT`).
  const correlationKey = buildXeroSupplementaryInvoiceKey({
    localModel,
    localId: bookingModificationId,
    priceDiffCents,
    changeFeeCents,
  });

  const requestedNetCents = priceDiffCents + changeFeeCents;

  let restated = 0;
  let alreadyCovering = 0;
  for (const operation of operations) {
    const payload =
      operation.requestPayload &&
      typeof operation.requestPayload === "object" &&
      !Array.isArray(operation.requestPayload)
        ? (operation.requestPayload as Record<string, unknown>)
        : null;
    if (!payload) continue;
    // What the queued invoice would BILL, which is the sum of its two signed
    // components (`createXeroSupplementaryInvoice` bills `priceDiffCents +
    // changeFeeCents`). Comparing the net rather than one component is what makes
    // "never lower" mean what it says on a queued row carrying a change fee.
    const queuedNetCents =
      (typeof payload.priceDiffCents === "number" ? payload.priceDiffCents : 0) +
      (typeof payload.changeFeeCents === "number" ? payload.changeFeeCents : 0);
    if (queuedNetCents >= requestedNetCents) {
      // Already asking for at least this much: an exact replay, or a stale,
      // smaller total arriving after a larger one. Neither may write.
      alreadyCovering += 1;
      continue;
    }
    // `updateMany` rather than `update`, carrying the same status predicate the
    // read used: an operation the outbox claimed between the two statements
    // matches nothing and is left exactly as the worker found it.
    const raised = await store.xeroSyncOperation.updateMany({
      where: {
        id: operation.id,
        status: { in: [...RESTATABLE_SUPPLEMENTARY_INVOICE_STATUSES] },
      },
      data: {
        requestPayload: {
          ...payload,
          priceDiffCents,
          changeFeeCents,
        } as Prisma.InputJsonValue,
        idempotencyKey: correlationKey,
        correlationKey,
      },
    });
    if (raised.count === 1) restated += 1;
  }

  return { restated, alreadyCovering };
}

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
    const queueType = readQueueType(queuedOperation.requestPayload);
    const expectedOperation = getQueuedOutboxExpectedOperation(queueType);
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
          // #3193: present means this row is one review share's OWN invoice, so
          // the handler anchors its link on that task, scopes the Xero
          // idempotency key to it, and says on the invoice why the member is
          // being asked twice.
          shortfallReviewTaskId: payload.shortfallReviewTaskId,
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
