/**
 * #1620 — allocate-existing applied credit on the Internet-Banking raise path.
 *
 * An IB booking's Xero invoice is raised at the FULL finalPrice; locally-applied
 * member credit historically never reduced it (DOMAIN_INVARIANTS: "locally-applied
 * credit never reduced the invoice"), so a member who applied credit and paid the
 * full invoice double-paid. This engine makes the member pay EFFECTIVE by reducing
 * the invoice: it allocates the member's EXISTING floating ACCRECCREDIT notes
 * (minted when the credit was created, e.g. a cancellation) against the new
 * invoice, oldest-first, up to the applied amount. Credit with no floating note
 * (admin adjustments, and #1547 restored credit whose funding note was consumed by
 * a prior cancel) is covered by a freshly minted note for the remainder.
 *
 * Minting a fresh note for the WHOLE applied amount would double-count against the
 * still-floating original note; allocating the existing note is the only
 * conservation-correct mechanism (owner decision, #1620).
 *
 * Per-note remaining balances are tracked in `MemberCreditNoteAllocation`
 * (remaining = lot.amountCents − Σ its allocation rows). Provider calls run in the
 * outbox worker, outside the ledger transactions.
 */
import { CreditNote, LineAmountTypes, type LineItem } from "xero-node";
import { CreditType, Prisma } from "@prisma/client";
import { prisma } from "./prisma";
import { lockMemberCreditLedger } from "./member-credit";
import { allocateCreditNoteToInvoice } from "./xero-credit-notes";
import {
  buildXeroIdempotencyKey,
  completeXeroSyncOperation,
  failXeroSyncOperation,
  startXeroSyncOperation,
} from "@/lib/xero-sync";
import { callXeroApi, getAuthenticatedXeroClient } from "./xero-api-client";
import { getResolvedAccountMapping } from "./xero-mappings";
import {
  findOrCreateXeroContact,
  retryXeroWriteWithContactRepair,
} from "./xero-contacts";
import { readClubTimeZoneOutsideRequest } from "@/lib/club-time-zone-runtime";
import { xeroDocumentDateForClubToday } from "@/lib/xero-provider-dates";
import logger from "@/lib/logger";
import {
  assertNoAppliedCreditDeallocationFence,
} from "./xero-applied-credit-operation-serialization";

// XeroObjectLink roles for this engine's artefacts.
const APPLIED_CREDIT_ALLOCATION_ROLE = "APPLIED_CREDIT_ALLOCATION";
const APPLIED_CREDIT_REMAINDER_NOTE_ROLE = "APPLIED_CREDIT_REMAINDER_NOTE";
const APPLIED_CREDIT_REMAINDER_ALLOCATION_ROLE =
  "APPLIED_CREDIT_REMAINDER_ALLOCATION";

// ---------------------------------------------------------------------------
// Pure allocation planner (unit-tested)
// ---------------------------------------------------------------------------

export interface AppliedCreditLot {
  memberCreditId: string;
  /** The lot's floating Xero note, or null for a noteless lot (admin adjustment
   * or #1547-restored credit) that must be covered by a freshly minted note. */
  xeroCreditNoteId: string | null;
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
 * Decide which credit lots fund `appliedCents`, oldest-first. Conservation is
 * independent of lot order (owner/advisor: lot order is neutral); oldest-first is
 * a deterministic default. Throws if the lots cannot cover the applied amount —
 * that can only happen on a corrupted ledger, since applied credit never exceeds
 * the balance at apply-time and allocations never exceed prior applications.
 */
export function planAppliedCreditAllocation(
  lots: AppliedCreditLot[],
  appliedCents: number,
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
      mintSlices.push({ memberCreditId: lot.memberCreditId, amountCents: slice });
    }
    outstanding -= slice;
  }

  if (outstanding > 0) {
    throw new Error(
      `Applied credit ${appliedCents} exceeds available credit-lot remaining by ${outstanding}c — member-credit ledger inconsistency`,
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
// Ledger reads
// ---------------------------------------------------------------------------

/**
 * Gather the member's positive credit lots (oldest-first) with each lot's
 * remaining unallocated balance. Read within the caller's ledger-locked tx.
 *
 * CRITICAL — the remaining balance EXCLUDES `forBookingId`'s own prior allocation
 * rows. The plan phase commits join rows before the (out-of-transaction) Xero
 * allocations run, so a retry after a mid-flight provider failure re-enters this
 * function with this booking's own rows already committed. Counting them would
 * read the lots as consumed, produce an empty plan, and throw a spurious "ledger
 * inconsistency" — permanently bricking the op (and re-manifesting the #1620
 * double-pay). Excluding them makes the retry reproduce the SAME plan; the
 * upserts become no-ops and step 2's completion-link check skips the notes
 * already allocated. Other bookings' allocations ARE still subtracted, so
 * concurrent-different-booking consumption stays correct.
 */
async function gatherAppliedCreditLots(
  memberId: string,
  forBookingId: string,
  tx: Prisma.TransactionClient,
): Promise<AppliedCreditLot[]> {
  const positiveLots = await tx.memberCredit.findMany({
    where: { memberId, amountCents: { gt: 0 } },
    select: { id: true, amountCents: true, xeroCreditNoteId: true },
    orderBy: { createdAt: "asc" },
  });

  const allocated = await tx.memberCreditNoteAllocation.groupBy({
    by: ["memberCreditId"],
    where: {
      memberCreditId: { in: positiveLots.map((l) => l.id) },
      appliedToBookingId: { not: forBookingId },
    },
    _sum: { amountCents: true },
  });
  const allocatedById = new Map(
    allocated.map((a) => [a.memberCreditId, a._sum.amountCents ?? 0]),
  );

  const lots: AppliedCreditLot[] = [];
  for (const lot of positiveLots) {
    const remainingCents = lot.amountCents - (allocatedById.get(lot.id) ?? 0);
    if (remainingCents <= 0) {
      continue;
    }
    lots.push({
      memberCreditId: lot.id,
      xeroCreditNoteId: lot.xeroCreditNoteId,
      remainingCents,
    });
  }
  return lots;
}

async function unallocatedAppliedCents(
  bookingId: string,
  db: Prisma.TransactionClient | typeof prisma,
): Promise<number> {
  const agg = await db.memberCredit.aggregate({
    where: {
      appliedToBookingId: bookingId,
      type: CreditType.BOOKING_APPLIED,
      xeroCreditNoteId: null,
    },
    _sum: { amountCents: true },
  });
  return Math.max(0, -(agg._sum.amountCents ?? 0));
}

// ---------------------------------------------------------------------------
// Remainder mint (noteless lots)
// ---------------------------------------------------------------------------

/**
 * Mint a fresh ACCRECCREDIT note for the admin-adjustment / restored-credit
 * remainder that has no existing floating note. Idempotent: reuses an existing
 * `APPLIED_CREDIT_REMAINDER_NOTE` link for the payment. Returns the note id.
 *
 * ACCOUNTING-POLICY FLAG (#1620): the minted note uses the shared hutFeeRefunds
 * account mapping. Whether admin-granted / goodwill credit applied to an IB
 * booking should post to a distinct goodwill/write-off account is an open
 * accounting-policy question for the owner (see PR body); it does not change the
 * money math (the note is fully allocated to the invoice immediately).
 */
async function mintAppliedCreditRemainderNote(params: {
  bookingId: string;
  memberId: string;
  paymentId: string;
  amountCents: number;
  createdByMemberId?: string;
}): Promise<string> {
  const { bookingId, memberId, paymentId, amountCents, createdByMemberId } =
    params;

  const existingLink = await prisma.xeroObjectLink.findFirst({
    where: {
      localModel: "Payment",
      localId: paymentId,
      xeroObjectType: "CREDIT_NOTE",
      role: APPLIED_CREDIT_REMAINDER_NOTE_ROLE,
      active: true,
    },
    select: { xeroObjectId: true },
  });
  if (existingLink?.xeroObjectId) {
    return existingLink.xeroObjectId;
  }

  const { xero, tenantId } = await getAuthenticatedXeroClient();
  const contactId = await findOrCreateXeroContact(memberId, { createdByMemberId });
  const refundMapping = await getResolvedAccountMapping("hutFeeRefunds");
  const accountCode = refundMapping.code ?? "200";

  const lineItem: LineItem = {
    description: `Account credit applied to booking ${bookingId.slice(0, 8)}`,
    quantity: 1,
    unitAmount: amountCents / 100,
    taxType: "OUTPUT2",
  };
  if (refundMapping.itemCode) {
    lineItem.itemCode = refundMapping.itemCode;
  }
  if (
    !refundMapping.itemCode ||
    accountCode !== "200" ||
    refundMapping.codeExplicitlyConfigured
  ) {
    lineItem.accountCode = accountCode;
  }

  // Club calendar day: the note's date decides its GST period, and the UTC day
  // is still yesterday all New Zealand morning (INV-DATE-019, #2834). Read once,
  // outside a closure that runs for the recorded payload and each repair attempt.
  const remainderNoteDate = xeroDocumentDateForClubToday(await readClubTimeZoneOutsideRequest());

  const buildCreditNote = (resolvedContactId: string): CreditNote => ({
    type: CreditNote.TypeEnum.ACCRECCREDIT,
    contact: { contactID: resolvedContactId },
    date: remainderNoteDate,
    lineAmountTypes: LineAmountTypes.Inclusive,
    lineItems: [lineItem],
    reference: `Applied credit - Booking ${bookingId.slice(0, 8)}`,
    status: CreditNote.StatusEnum.AUTHORISED,
  });

  const idempotencyKey = buildXeroIdempotencyKey(
    "payment",
    paymentId,
    "applied-credit-remainder-note",
    amountCents,
    "v1",
  );
  const operation = await startXeroSyncOperation({
    direction: "OUTBOUND",
    entityType: "CREDIT_NOTE",
    operationType: "CREATE",
    localModel: "Payment",
    localId: paymentId,
    idempotencyKey,
    correlationKey: idempotencyKey,
    requestPayload: { creditNotes: [buildCreditNote(contactId)] },
    createdByMemberId: createdByMemberId ?? null,
  });

  try {
    const response = await retryXeroWriteWithContactRepair({
      memberId,
      currentContactId: contactId,
      workflow: "mintAppliedCreditRemainderNote",
      operationId: operation.id,
      createdByMemberId,
      buildRequestPayload: (resolvedContactId) => ({
        creditNotes: [buildCreditNote(resolvedContactId)],
      }),
      run: ({ contactId: resolvedContactId }) =>
        callXeroApi(
          () =>
            xero.accountingApi.createCreditNotes(
              tenantId,
              { creditNotes: [buildCreditNote(resolvedContactId)] },
              undefined,
              undefined,
              idempotencyKey,
            ),
          {
            operation: "createCreditNotes",
            resourceType: "CREDIT_NOTE",
            workflow: "mintAppliedCreditRemainderNote",
            context: `createCreditNotes(applied-credit remainder ${paymentId})`,
          },
        ),
    });

    const created = response.body.creditNotes?.[0];
    if (!created?.creditNoteID) {
      throw new Error("Failed to mint applied-credit remainder note");
    }

    await completeXeroSyncOperation(operation.id, {
      responsePayload: response.body,
      xeroObjectType: "CREDIT_NOTE",
      xeroObjectId: created.creditNoteID,
      xeroObjectNumber: created.creditNoteNumber ?? null,
      extraLinks: [
        {
          localModel: "Payment",
          localId: paymentId,
          xeroObjectType: "CREDIT_NOTE",
          xeroObjectId: created.creditNoteID,
          xeroObjectNumber: created.creditNoteNumber ?? null,
          role: APPLIED_CREDIT_REMAINDER_NOTE_ROLE,
        },
      ],
    });

    return created.creditNoteID;
  } catch (error) {
    await failXeroSyncOperation(operation.id, error);
    throw error;
  }
}

// ---------------------------------------------------------------------------
// Orchestration handler (outbox op APPLIED_CREDIT_ALLOCATION)
// ---------------------------------------------------------------------------

async function completeSkip(syncOperationId: string | undefined, reason: string) {
  if (syncOperationId) {
    await completeXeroSyncOperation(syncOperationId, {
      responsePayload: { skipped: true, reason },
    });
  }
}

/**
 * Allocate the member's existing floating credit notes (plus a minted remainder)
 * against an Internet-Banking booking's invoice, so the member pays the
 * credit-reduced (effective) amount. Idempotent and retry-safe.
 *
 * Ordering: enqueued after the invoice op; if the invoice is not raised yet this
 * throws so the outbox retries (the invoice op, older, completes first).
 */
export async function allocateAppliedCreditForBooking(
  bookingId: string,
  options?: { createdByMemberId?: string; syncOperationId?: string },
): Promise<void> {
  const syncOperationId = options?.syncOperationId;
  const createdByMemberId = options?.createdByMemberId;

  const booking = await prisma.booking.findUnique({
    where: { id: bookingId },
    include: { payment: true },
  });
  if (!booking?.payment) {
    await completeSkip(syncOperationId, "No booking or payment.");
    return;
  }
  const payment = booking.payment;
  // Payment-method-agnostic (#1620/#1641): the engine keys on the booking's
  // invoice + BOOKING_APPLIED ledger, never on payment.source. The enqueue call
  // sites are Internet-Banking-only in #1620; #1641 will add a card caller
  // (which must handle card invoice timing — see the note in the report).

  const appliedCents = await unallocatedAppliedCents(bookingId, prisma);
  if (appliedCents === 0) {
    await completeSkip(syncOperationId, "No unallocated applied credit.");
    return;
  }

  if (!payment.xeroInvoiceId) {
    // Invoice not raised yet — retry (the booking-invoice op is enqueued first
    // and completes first; this throw is the self-healing ordering fallback).
    throw new Error(
      `Booking ${bookingId} has ${appliedCents}c applied credit to allocate but no Xero invoice yet; retrying.`,
    );
  }
  const invoiceId = payment.xeroInvoiceId;

  // 1) LOCAL: plan the allocation and persist the note-allocation join rows under
  // the ledger lock. Mint-slice join rows are written after the note is minted.
  const plan = await prisma.$transaction(async (tx) => {
    await lockMemberCreditLedger(booking.memberId, tx);
    await assertNoAppliedCreditDeallocationFence(payment.id, tx, {
      // An older allocation must be allowed to complete before a fresh clamp's
      // deallocation. Once that deallocation has a snapshot/checkpoint it is a
      // hard fence and this worker returns to PENDING.
      allowUncheckpointedPending: true,
    });
    const lockedApplied = await unallocatedAppliedCents(bookingId, tx);
    if (lockedApplied === 0) {
      return null; // a concurrent run already stamped it
    }
    const lots = await gatherAppliedCreditLots(booking.memberId, bookingId, tx);
    const planned = planAppliedCreditAllocation(lots, lockedApplied);
    for (const na of planned.noteAllocations) {
      await tx.memberCreditNoteAllocation.upsert({
        where: {
          memberCreditId_appliedToBookingId: {
            memberCreditId: na.memberCreditId,
            appliedToBookingId: bookingId,
          },
        },
        create: {
          memberCreditId: na.memberCreditId,
          xeroCreditNoteId: na.xeroCreditNoteId,
          appliedToBookingId: bookingId,
          amountCents: na.amountCents,
        },
        update: {},
      });
    }
    return planned;
  });

  if (!plan) {
    await completeSkip(syncOperationId, "Applied credit already allocated.");
    return;
  }

  // 2) Allocate each existing floating note against the invoice (idempotent per
  // join row via its completion link).
  for (const na of plan.noteAllocations) {
    const joinRow = await prisma.memberCreditNoteAllocation.findUnique({
      where: {
        memberCreditId_appliedToBookingId: {
          memberCreditId: na.memberCreditId,
          appliedToBookingId: bookingId,
        },
      },
      select: { id: true },
    });
    if (!joinRow) {
      continue;
    }
    const alreadyAllocated = await prisma.xeroObjectLink.findFirst({
      where: {
        localModel: "MemberCreditNoteAllocation",
        localId: joinRow.id,
        xeroObjectType: "ALLOCATION",
        role: APPLIED_CREDIT_ALLOCATION_ROLE,
        active: true,
      },
      select: { id: true },
    });
    if (alreadyAllocated) {
      continue;
    }
    await allocateCreditNoteToInvoice(na.xeroCreditNoteId, invoiceId, na.amountCents, {
      localModel: "MemberCreditNoteAllocation",
      localId: joinRow.id,
      role: APPLIED_CREDIT_ALLOCATION_ROLE,
      createdByMemberId,
      appliedCreditContext: {
        parentOperationId: syncOperationId ?? null,
        bookingId,
        paymentId: payment.id,
      },
    });
  }

  // 3) Mint + allocate the noteless (admin / restored) remainder, if any.
  let remainderNoteId: string | null = null;
  if (plan.mintTotalCents > 0) {
    remainderNoteId = await mintAppliedCreditRemainderNote({
      bookingId,
      memberId: booking.memberId,
      paymentId: payment.id,
      amountCents: plan.mintTotalCents,
      createdByMemberId,
    });
    const mintedNoteId = remainderNoteId;

    await prisma.$transaction(async (tx) => {
      await lockMemberCreditLedger(booking.memberId, tx);
      for (const ms of plan.mintSlices) {
        await tx.memberCreditNoteAllocation.upsert({
          where: {
            memberCreditId_appliedToBookingId: {
              memberCreditId: ms.memberCreditId,
              appliedToBookingId: bookingId,
            },
          },
          create: {
            memberCreditId: ms.memberCreditId,
            xeroCreditNoteId: mintedNoteId,
            appliedToBookingId: bookingId,
            amountCents: ms.amountCents,
          },
          update: { xeroCreditNoteId: mintedNoteId },
        });
      }
    });

    const remainderAllocated = await prisma.xeroObjectLink.findFirst({
      where: {
        localModel: "Payment",
        localId: payment.id,
        xeroObjectType: "ALLOCATION",
        role: APPLIED_CREDIT_REMAINDER_ALLOCATION_ROLE,
        active: true,
      },
      select: { id: true },
    });
    if (!remainderAllocated) {
      await allocateCreditNoteToInvoice(mintedNoteId, invoiceId, plan.mintTotalCents, {
        localModel: "Payment",
        localId: payment.id,
        role: APPLIED_CREDIT_REMAINDER_ALLOCATION_ROLE,
        createdByMemberId,
        appliedCreditContext: {
          parentOperationId: syncOperationId ?? null,
          bookingId,
          paymentId: payment.id,
        },
      });
    }
  }

  // 4) STAMP LAST — only now that the FULL applied amount is covered by allocated
  // notes. The #1597 hold-expiry / cancel clearing formula subtracts
  // `Σ BOOKING_APPLIED with xeroCreditNoteId` as the invoice's already-allocated
  // credit; stamping before full coverage would let a concurrent cancel/expiry
  // subtract credit not yet on the invoice and UNDER-clear. The reverse
  // partial-window residual (some notes allocated, stamp not yet written) is
  // documented and self-healing: a concurrent cancel treats the credit as
  // unallocated and its clearing note + the allocations can exceed the invoice,
  // which Xero rejects LOUDLY (the #1597 loud-over-allocation class); this op's
  // retry finishes the remaining allocations and then stamps. The @@unique join
  // key + per-row completion links make that retry idempotent.
  const representativeNoteId =
    plan.noteAllocations[0]?.xeroCreditNoteId ?? remainderNoteId;
  if (representativeNoteId) {
    await prisma.$transaction(async (tx) => {
      await lockMemberCreditLedger(booking.memberId, tx);
      await tx.memberCredit.updateMany({
        where: {
          appliedToBookingId: bookingId,
          type: CreditType.BOOKING_APPLIED,
          xeroCreditNoteId: null,
        },
        data: { xeroCreditNoteId: representativeNoteId },
      });
    });
  }

  logger.info(
    {
      bookingId,
      invoiceId,
      appliedCents,
      noteAllocations: plan.noteAllocations.length,
      mintedRemainderCents: plan.mintTotalCents,
    },
    "Allocated existing applied credit against Internet-Banking invoice (#1620)",
  );

  if (syncOperationId) {
    await completeXeroSyncOperation(syncOperationId, {
      responsePayload: {
        bookingId,
        invoiceId,
        appliedCents,
        allocatedNotes: plan.noteAllocations.length,
        mintedRemainderCents: plan.mintTotalCents,
      },
    });
  }
}
