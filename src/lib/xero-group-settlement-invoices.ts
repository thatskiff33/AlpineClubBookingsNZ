/**
 * Combined group-settlement invoice against Xero.
 *
 * When an ORGANISER_PAYS organiser settles by Internet Banking, the whole group
 * is billed as one combined Xero invoice raised to the organiser's contact, with
 * line items aggregated across every joiner child booking. The invoice is emailed
 * so the organiser can pay it by bank transfer; inbound Xero reconciliation then
 * flips all the joiner children to PAID (see
 * `applyGroupSettlementSucceededFromInvoice` in group-settlement.ts).
 *
 * Mirrors `createXeroInvoiceForBooking`, minus the Stripe payment recording: an
 * Internet Banking invoice is never paid from a Stripe charge, so there is no
 * Xero payment to record here — it is always emailed and reconciled on payment.
 */

import { Invoice, LineAmountTypes } from "xero-node";
import { GroupBookingStatus, type Prisma } from "@prisma/client";
import { prisma } from "./prisma";
import { buildXeroInvoiceUrl } from "@/lib/xero-links";
import {
  completeXeroSyncOperation,
  failXeroSyncOperation,
  sanitizeForJson,
  startXeroSyncOperation,
  upsertXeroObjectLink,
} from "@/lib/xero-sync";
import { callXeroApi, getAuthenticatedXeroClient } from "./xero-api-client";
import { finishGroupSettlementInvoiceEmail } from "./xero-group-settlement-invoice-email";
import {
  findOrCreateXeroContact,
  retryXeroWriteWithContactRepair,
  type FindOrCreateXeroContactOptions,
} from "./xero-contacts";
import {
  buildGroupSettlementInvoiceLines,
  releaseUninvoiceableGroupSettlement,
} from "./xero-group-settlement-invoice-lines";
import { readClubTimeZoneOutsideRequest } from "@/lib/club-time-zone-runtime";
import { xeroDocumentDatesFromColumnAndInstant } from "@/lib/xero-provider-dates";
import {
  enqueueXeroGroupSettlementInvoiceAbandonVoidOperation,
  enqueueXeroGroupSettlementInvoiceVoidOperation,
} from "@/lib/xero-group-settlement-void-outbox";
import { isGroupSettlementBoundToInvoice } from "@/lib/group-settlement-invoice-binding";
import { voidCancelledGroupSettlementInvoice } from "./xero-group-settlement-invoice-voids";
import { GroupSettlementInvoiceEmailDeferredError } from "@/lib/xero-applied-credit-operation-serialization";
import {
  boundGroupSettlementInvoiceCompletion,
  currentGroupSettlementInvoiceAttempt,
  deferredGroupInvoiceEmailPayload,
  groupSettlementInvoiceCreateKey,
  groupSettlementInvoiceLink,
  parseGroupSettlementInvoiceAttempt,
  readDeferredGroupInvoiceEmail,
} from "@/lib/xero-group-settlement-invoice-outbox";
import { alertGroupSettlementInvoice } from "@/lib/group-settlement-invoice-alerts";
import { clubFormatValues } from "@/lib/club-format-server";
import { providerAmountToCents } from "@/lib/money-provider-amount";
import { formatCents } from "@/lib/utils";
import type { XeroOperationClaim } from "@/lib/xero-operation-outcome-guard";
import { LOCK1_HOLDER_TRANSACTION_BUDGET } from "@/lib/db-transaction";

export interface CreateXeroGroupSettlementInvoiceOptions
  extends FindOrCreateXeroContactOptions {
  syncOperation?: XeroOperationClaim;
}

/**
 * #3642 (`INV-PAY-105`): the post-create fence, under `lock(1)`. The invoice
 * Xero just raised is bound to the settlement only if the settlement is still
 * waiting on THIS attempt, for THIS total — otherwise it is abandoned on
 * arrival: its VOID queued and its link written INACTIVE (so a payment on it is
 * still recognised), never pointed at or emailed. That covers a settlement
 * released or taken over by card meanwhile, a later attempt that superseded
 * this one, a settlement already pointing at another invoice, and an invoice
 * whose total is not the settlement's. The ACTIVE link is written beside the
 * pointer, so a reaper that later retires the invoice always sees it.
 *
 * A cancelled group keeps the pre-#3642 rule: the pointer is written and the
 * cancellation VOID queued (`INV-PAY-035`).
 */
export async function bindCreatedGroupSettlementInvoice(
  tx: Prisma.TransactionClient,
  params: {
    settlementId: string;
    attempt: number;
    invoice: { id: string; number: string | null; totalCents: number | null };
  }
): Promise<{
  cancellationWon: boolean;
  abandoned: boolean;
  totalMismatch: boolean;
  queuedVoidOperationId: string | null;
}> {
  const { settlementId, attempt, invoice } = params;
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(1)`;
  const fresh = await tx.groupBookingSettlement.findUnique({
    where: { id: settlementId },
    select: {
      source: true,
      status: true,
      amountCents: true,
      xeroInvoiceId: true,
      groupBooking: { select: { status: true } },
    },
  });
  if (!fresh) {
    throw new Error(`Group settlement not found: ${settlementId}`);
  }
  const link = groupSettlementInvoiceLink(settlementId, invoice);
  const current = await currentGroupSettlementInvoiceAttempt(tx, settlementId);
  const totalMatches = invoice.totalCents === fresh.amountCents;
  if (
    fresh.groupBooking.status !== GroupBookingStatus.CANCELLED &&
    (!isGroupSettlementBoundToInvoice(fresh) ||
      (current !== null && attempt < current) ||
      (fresh.xeroInvoiceId !== null && fresh.xeroInvoiceId !== invoice.id) ||
      !totalMatches)
  ) {
    await enqueueXeroGroupSettlementInvoiceAbandonVoidOperation(settlementId, invoice.id, {
      store: tx,
    });
    await upsertXeroObjectLink({ ...link, active: false }, { store: tx });
    return {
      cancellationWon: false,
      abandoned: true,
      totalMismatch: isGroupSettlementBoundToInvoice(fresh) && !totalMatches,
      queuedVoidOperationId: null,
    };
  }
  await tx.groupBookingSettlement.update({
    where: { id: settlementId },
    data: { xeroInvoiceId: invoice.id, xeroInvoiceNumber: invoice.number },
  });
  await upsertXeroObjectLink(link, { store: tx });
  const cancellationWon = fresh.groupBooking.status === GroupBookingStatus.CANCELLED;
  const queuedVoid = cancellationWon
    ? await enqueueXeroGroupSettlementInvoiceVoidOperation(settlementId, { store: tx })
    : null;
  return {
    cancellationWon,
    abandoned: false,
    totalMismatch: false,
    queuedVoidOperationId: queuedVoid?.queueOperationId ?? null,
  };
}

/**
 * Raise (or re-link) the single combined Xero invoice for an Internet Banking
 * group settlement and email it to the organiser. Idempotent: an active
 * settlement that already carries a `xeroInvoiceId` re-links and returns it
 * without raising a second invoice; a cancelled settlement re-drives the
 * idempotent void compensation and never emails the invoice.
 */
export async function createXeroInvoiceForGroupSettlement(
  settlementId: string,
  options?: CreateXeroGroupSettlementInvoiceOptions
): Promise<string | null> {
  // Cancellation and invoice issuance share the global lifecycle fence. This
  // first read prevents a queued operation from starting provider work after
  // organiser cancellation has already committed. The provider call remains
  // outside the transaction; a second fenced read below decides which side won
  // if cancellation overlaps the in-flight Xero request.
  const initialFence = await prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(1)`;
    const settlement = await tx.groupBookingSettlement.findUnique({
      where: { id: settlementId },
      include: {
        groupBooking: {
          select: {
            id: true,
            status: true,
            organiserMemberId: true,
            organiserBookingId: true,
            organiserBooking: { select: { checkIn: true } },
          },
        },
      },
    });
    const queuedVoid =
      settlement?.groupBooking.status === GroupBookingStatus.CANCELLED &&
      settlement.xeroInvoiceId
        ? await enqueueXeroGroupSettlementInvoiceVoidOperation(settlement.id, {
            store: tx,
          })
        : null;
    // #3642: which attempt this row is, and whether a later one replaced it.
    const row = options?.syncOperation
      ? await tx.xeroSyncOperation.findUnique({
          where: { id: options.syncOperation.id },
          select: { correlationKey: true, responsePayload: true },
        })
      : null;
    const current = await currentGroupSettlementInvoiceAttempt(tx, settlementId);
    const attempt =
      parseGroupSettlementInvoiceAttempt(settlementId, row?.correlationKey) ??
      current ??
      0;
    return {
      // #4919: set while this row's email is owed from an earlier run.
      deferredEmail: readDeferredGroupInvoiceEmail(row?.responsePayload),
      settlement,
      queuedVoidOperationId: queuedVoid?.queueOperationId ?? null,
      attempt,
      superseded: current !== null && attempt < current,
    };
  }, LOCK1_HOLDER_TRANSACTION_BUDGET);
  const settlement = initialFence.settlement;
  const attempt = initialFence.attempt;

  if (!settlement) throw new Error(`Group settlement not found: ${settlementId}`);

  if (settlement.groupBooking.status === GroupBookingStatus.CANCELLED) {
    if (settlement.xeroInvoiceId) {
      try {
        await voidCancelledGroupSettlementInvoice({
          settlementId: settlement.id,
          invoiceId: settlement.xeroInvoiceId,
          invoiceNumber: settlement.xeroInvoiceNumber,
          syncOperation: options?.syncOperation,
        });
      } catch (error) {
        if (options?.syncOperation) {
          await failXeroSyncOperation(options.syncOperation, error);
        }
        throw error;
      }
    } else if (options?.syncOperation) {
      await completeXeroSyncOperation(options.syncOperation, {
        status: "SUCCEEDED",
        responsePayload: { cancelledBeforeInvoiceCreation: true },
      });
    }
    return null;
  }

  // #3642 (`INV-PAY-105`): a queued CREATE that outlived its settlement (released
  // by the reaper, taken over by a card attempt, or replaced by a later attempt
  // after the group changed) raises nothing.
  if (!isGroupSettlementBoundToInvoice(settlement) || initialFence.superseded) {
    if (options?.syncOperation) {
      await completeXeroSyncOperation(options.syncOperation, {
        status: "SUCCEEDED",
        responsePayload: initialFence.superseded
          ? { supersededByLaterAttempt: true }
          : { settlementNoLongerAwaitingInvoice: true },
      });
    }
    return null;
  }

  // #4919: raised and bound, but its email is owed. Ask again through the same
  // fence — every in-lock check re-run, the same idempotency key — and never
  // raise or re-bind the invoice. A failure keeps the marker, so an operator's
  // Retry of the FAILED row comes back here rather than closing it unemailed.
  if (settlement.xeroInvoiceId && initialFence.deferredEmail && options?.syncOperation) {
    const deferred = initialFence.deferredEmail;
    const createdInvoice = { invoiceID: settlement.xeroInvoiceId, invoiceNumber: settlement.xeroInvoiceNumber };
    try {
      const { xero, tenantId } = await getAuthenticatedXeroClient();
      return await finishGroupSettlementInvoiceEmail({
        settlementId,
        createdInvoice,
        response: { body: deferred.invoice },
        xero,
        tenantId,
        operationClaim: options.syncOperation,
        redrivable: true,
      });
    } catch (error) {
      if (!(error instanceof GroupSettlementInvoiceEmailDeferredError)) {
        await failXeroSyncOperation(options.syncOperation, error, deferredGroupInvoiceEmailPayload(deferred.invoice, error));
      }
      throw error;
    }
  }
  // Already raised: its link was written beside the pointer under the lock (#3642), and re-writing it here could
  // re-activate a retired invoice's link. #4710: a claimed row closes SUCCEEDED on the bound invoice, never left RUNNING.
  if (settlement.xeroInvoiceId) {
    if (options?.syncOperation) await completeXeroSyncOperation(options.syncOperation, boundGroupSettlementInvoiceCompletion({ id: settlement.xeroInvoiceId, number: settlement.xeroInvoiceNumber ?? null }));
    return settlement.xeroInvoiceId;
  }

  const organiserMemberId = settlement.groupBooking.organiserMemberId;

  // #3642 (`INV-SSOT-002`): built from exactly the committed children, and
  // never raised unless it totals the settlement.
  const lines = await buildGroupSettlementInvoiceLines(
    settlement.groupBooking.organiserBookingId
  );
  if (lines.childCount === 0) {
    throw new Error(
      `No settleable children found for group settlement: ${settlementId}`
    );
  }
  if (lines.childrenCents !== settlement.amountCents) {
    // The group moved since the settle: the next settle replaces the request.
    const format = await clubFormatValues();
    throw new Error(
      `Group settlement ${settlementId} is for ${formatCents(settlement.amountCents, format)}, but its committed children now total ${formatCents(lines.childrenCents, format)}; no invoice was raised. The organiser settles again for an invoice at the current total.`
    );
  }
  if (lines.lineCents !== lines.childrenCents) {
    // A joiner's stored night prices do not add up to their final price — a
    // stored-money defect the organiser cannot fix, and settling again would
    // fail the same way. The binding is released (the settlement FAILS, so a
    // card payment is no longer refused), the operators are alerted once, and
    // the page says the club will sort it out.
    await releaseUninvoiceableGroupSettlement(settlement.id, settlement.amountCents, {
      syncOperation: options?.syncOperation,
      childrenCents: lines.childrenCents,
      lineCents: lines.lineCents,
    });
    return null;
  }
  const lineItems = lines.lineItems;

  const { xero, tenantId } = await getAuthenticatedXeroClient();
  // #3036 review P1-12: reuse the client built above rather than rebuilding one.
  const contactId = await findOrCreateXeroContact(organiserMemberId, { ...options, xero, tenantId });

  // Two dates, two different kinds of value, so two different derivations. The
  // whole reasoning — and the #2834 defect that a "simplification" here brings
  // straight back — is the docblock on
  // `xeroDocumentDatesFromColumnAndInstant`.
  const { issueDate, dueDate } = xeroDocumentDatesFromColumnAndInstant(
    new Date(settlement.groupBooking.organiserBooking.checkIn),
    new Date(settlement.createdAt),
    await readClubTimeZoneOutsideRequest(),
  );

  const buildInvoice = (resolvedContactId: string): Invoice => ({
    type: Invoice.TypeEnum.ACCREC,
    contact: { contactID: resolvedContactId },
    lineItems,
    date: issueDate,
    dueDate,
    reference: `Group settlement ${settlement.groupBooking.id.slice(0, 8)}`,
    status: Invoice.StatusEnum.AUTHORISED,
    lineAmountTypes: LineAmountTypes.Inclusive,
  });

  // #3642: keyed by attempt, so a retry of this attempt is deduplicated by Xero
  // and a later attempt is never answered with this one's invoice.
  const invoiceIdempotencyKey = groupSettlementInvoiceCreateKey(settlementId, attempt);
  let operationClaim = options?.syncOperation ?? null;
  const requestPayload = { invoices: [buildInvoice(contactId)], ...lines.operationRecord };

  if (operationClaim) {
    await prisma.xeroSyncOperation.update({
      where: { id: operationClaim.id },
      data: { requestPayload: sanitizeForJson(requestPayload) },
    });
  } else {
    const operation = await startXeroSyncOperation({
      direction: "OUTBOUND",
      entityType: "INVOICE",
      operationType: "CREATE",
      localModel: "GroupBookingSettlement",
      localId: settlement.id,
      idempotencyKey: invoiceIdempotencyKey,
      correlationKey: invoiceIdempotencyKey,
      requestPayload,
      createdByMemberId: options?.createdByMemberId ?? null,
    });
    operationClaim = operation;
  }

  try {
    const response = await retryXeroWriteWithContactRepair({
      memberId: organiserMemberId,
      currentContactId: contactId,
      workflow: "createXeroInvoiceForGroupSettlement",
      operationId: operationClaim!.id,
      repairExistingLink: options?.repairExistingLink,
      createdByMemberId: options?.createdByMemberId,
      buildRequestPayload: (resolvedContactId) => ({
        invoices: [buildInvoice(resolvedContactId)],
        ...lines.operationRecord,
      }),
      run: ({ contactId: resolvedContactId }) =>
        callXeroApi(
          () =>
            xero.accountingApi.createInvoices(
              tenantId,
              { invoices: [buildInvoice(resolvedContactId)] },
              undefined,
              undefined,
              invoiceIdempotencyKey
            ),
          {
            operation: "createInvoices",
            resourceType: "INVOICE",
            workflow: "createXeroInvoiceForGroupSettlement",
            context: `createInvoices(group settlement ${settlementId})`,
          }
        ),
    });

    const createdInvoice = response.body.invoices?.[0];
    if (!createdInvoice?.invoiceID) {
      throw new Error("Failed to create Xero group settlement invoice");
    }

    // Persist the provider identity and resolve the create-vs-cancel race under
    // the same global fence as organiser cancellation. If cancellation acquired
    // the fence while createInvoices was in flight, its durable CANCELLED state
    // wins: retain the provider id for retryable compensation, void the invoice,
    // and never email it. If this transaction sees OPEN/CLOSED, issuance won the
    // serialization point and a later cancellation is a separate lifecycle.
    const cancellationResult = await prisma.$transaction((tx) =>
      bindCreatedGroupSettlementInvoice(tx, {
        settlementId: settlement.id,
        attempt,
        invoice: {
          id: createdInvoice.invoiceID!,
          number: createdInvoice.invoiceNumber ?? null,
          totalCents: providerAmountToCents(createdInvoice.total),
        },
      }), LOCK1_HOLDER_TRANSACTION_BUDGET
    );

    if (cancellationResult.abandoned) {
      if (cancellationResult.totalMismatch) {
        // Refused before the send by the line check above, so this is Xero
        // rounding the lines to a different total. A person has to look.
        await alertGroupSettlementInvoice(
          {
            kind: "raised_at_wrong_total",
            settlementId,
            invoiceId: createdInvoice.invoiceID,
            errorMessage: `Xero raised the group's combined invoice ${createdInvoice.invoiceID} at a total different from the settlement's, so it was voided and not sent. Check the invoice lines, then ask the organiser to settle again.`,
          },
          await clubFormatValues()
        );
      }
      await completeXeroSyncOperation(operationClaim!, {
        status: cancellationResult.totalMismatch ? "FAILED" : "SUCCEEDED",
        responsePayload: {
          abandonedAfterInvoiceCreation: true,
          invoiceTotalDiffersFromSettlement: cancellationResult.totalMismatch,
          createInvoice: response.body,
          invoiceEmailSuppressed: true,
        },
        xeroObjectType: "INVOICE",
        xeroObjectId: createdInvoice.invoiceID,
        xeroObjectNumber: createdInvoice.invoiceNumber ?? null,
        xeroObjectUrl: buildXeroInvoiceUrl(createdInvoice.invoiceID),
      });
      return null;
    }

    if (cancellationResult.cancellationWon) {
      await voidCancelledGroupSettlementInvoice({
        settlementId: settlement.id,
        invoiceId: createdInvoice.invoiceID,
        invoiceNumber: createdInvoice.invoiceNumber ?? null,
        syncOperation: operationClaim!,
        createResponse: response.body,
      });
      return null;
    }

    return await finishGroupSettlementInvoiceEmail({
      settlementId,
      createdInvoice: { ...createdInvoice, invoiceID: createdInvoice.invoiceID },
      response,
      xero,
      tenantId,
      operationClaim: operationClaim!,
      redrivable: Boolean(options?.syncOperation),
    });
  } catch (error) {
    // #4919: an owed email is not a failure; the outbox returns the row to PENDING.
    if (!(error instanceof GroupSettlementInvoiceEmailDeferredError)) {
      await failXeroSyncOperation(operationClaim!, error);
    }
    throw error;
  }
}
