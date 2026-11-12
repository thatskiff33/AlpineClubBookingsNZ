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
import { bookingOwner } from "@/lib/booking-owner";
import logger from "@/lib/logger";
import {
  recordWithheldBookingEmail,
  XERO_GROUP_SETTLEMENT_INVOICE_EMAIL_TEMPLATE,
} from "@/lib/booking-email-suppression";
import { buildXeroInvoiceUrl } from "@/lib/xero-links";
import {
  buildXeroIdempotencyKey,
  completeXeroSyncOperation,
  failXeroSyncOperation,
  sanitizeForJson,
  startXeroSyncOperation,
  upsertXeroObjectLink,
} from "@/lib/xero-sync";
import { callXeroApi, getAuthenticatedXeroClient } from "./xero-api-client";
import {
  isDeferrableInLockEmailError,
  reassertXeroInvoiceEmailPolicy,
  resolveXeroInvoiceEmailPolicy,
  sendXeroInvoiceEmail,
  XERO_EMAIL_FENCE_LATEST_SEND_MS,
  XERO_EMAIL_FENCE_TRANSACTION_OPTIONS,
  XERO_IN_LOCK_EMAIL_BUDGET,
} from "@/lib/xero-invoice-email";
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
  GROUP_SETTLEMENT_INVOICE_EMAIL_DEFERRED_CAUSE,
  groupSettlementInvoiceCreateKey,
  groupSettlementInvoiceLink,
  parseGroupSettlementInvoiceAttempt,
  readDeferredGroupInvoiceEmail,
} from "@/lib/xero-group-settlement-invoice-outbox";
import { alertGroupSettlementInvoice } from "@/lib/group-settlement-invoice-alerts";
import { clubFormatValues } from "@/lib/club-format-server";
import { providerAmountToCents } from "@/lib/money-provider-amount";
import { formatCents } from "@/lib/utils";
import { ownRunningClaim, type XeroOperationClaim } from "@/lib/xero-operation-outcome-guard";

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
  });
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
      })
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

/**
 * The email fence, for a bound invoice's first email and for a re-drive of one
 * that was owed (#4919). `redrivable` is true for an outbox claim: an owed
 * email then marks the row and returns it to PENDING. Without one, the row
 * completes PARTIAL with the deferred cause for an operator to retry.
 */
async function finishGroupSettlementInvoiceEmail(params: {
  settlementId: string;
  createdInvoice: { invoiceID: string; invoiceNumber?: string | null };
  response: { body: unknown };
  xero: Awaited<ReturnType<typeof getAuthenticatedXeroClient>>["xero"];
  tenantId: string;
  operationClaim: XeroOperationClaim;
  redrivable: boolean;
}): Promise<string | null> {
  const { settlementId, createdInvoice, response, xero, tenantId, operationClaim } = params;
  // Email the invoice so the organiser can pay it by bank transfer. This is the
  // one deliberately provider-spanning lifecycle fence in this workflow, and
  // its bound is enforced, not assumed (#4919, `INV-INT-003`): ONE emailInvoice
  // attempt, zero in-lock retries (so no rate-limit sleep inside the lock), a
  // 3 s client deadline, and an explicit 10 s transaction timeout that counts
  // the wait for lock(1). The send starts only while the deadline plus a 2 s
  // commit margin still fits inside that timeout, so lock(1) is held for the
  // in-lock reads plus at most 3 s and is released by this transaction's own
  // commit, never by Prisma expiring it. Without the fence, cancellation could
  // commit after the last DB check but before Xero accepted the email,
  // producing a payable email after a durable CANCELLED state. If cancellation
  // won first, the replayable VOID is queued in the same tx and the email is
  // suppressed. If the email won first, cancellation waits and then commits its
  // own durable VOID debt; no HTTP attempt can start after a cancellation
  // commits. A deadline, rate limit or transient error leaves the email OWED:
  // the outbox asks again later through this same fence, with the same
  // idempotency key, so a request Xero did receive is not sent twice.
  let invoiceEmailResponseBody: unknown = null;
  let invoiceEmailError: unknown = null;
  let invoiceEmailAccepted = false;
  // #4919: why the email is owed, set inside the fence, so a commit that fails
  // afterwards still records the debt (nothing was written that must persist).
  let invoiceEmailDeferredError: unknown = null;
  // Usage rows are written on the global client; held until the fence ends.
  const usageTasks: Array<() => Promise<void>> = [];
  // #2258: set when the organiser's "No emails" switch withheld the invoice
  // email. Recorded on the sync operation so the skip is never silent.
  let invoiceEmailWithheld = false;
  const invoiceEmailIdempotencyKey = buildXeroIdempotencyKey(
    "group-settlement",
    settlementId,
    "invoice-email",
    createdInvoice.invoiceID,
    "v1"
  );
  // Environment-safety boundary (#3035; INV-CONFIG-004), resolved OUT HERE so a
  // copy does nothing further and no lock is taken on its behalf. #3071: it is
  // RE-PROVED inside the lock before the send — `reassertXeroInvoiceEmailPolicy`.
  const invoiceEmailPolicy = await resolveXeroInvoiceEmailPolicy();
  // Recorded from what the GATE did, never from the policy alone (#3035
  // review) — see `resolveXeroInvoiceEmailPolicy` on why two withhold reasons
  // must never both claim one event.
  let invoiceEmailWithheldForEnvironment = false;
  try {
    const emailGate = await prisma.$transaction(async (tx) => {
      const fenceStartedAt = performance.now();
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(1)`;
      const fresh = await tx.groupBookingSettlement.findUnique({
        where: { id: settlementId },
        select: {
          source: true,
          status: true,
          xeroInvoiceId: true,
          groupBooking: {
            select: {
              status: true,
              organiserBookingId: true,
              // #2258: the "No emails" switch on the ORGANISER'S booking.
              organiserBooking: {
                select: {
                  noEmails: true,
                  member: { select: { email: true } },
                  // #3369: the owner may be an Organisation; bookingOwner() reads both.
                  organisation: { select: { name: true, email: true } },
                },
              },
            },
          },
        },
      });
      if (!fresh) {
        throw new Error(`Group settlement not found: ${settlementId}`);
      }
      if (fresh.groupBooking.status === GroupBookingStatus.CANCELLED) {
        await enqueueXeroGroupSettlementInvoiceVoidOperation(settlementId, {
          store: tx,
        });
        return {
          cancelled: true,
          abandoned: false,
          responseBody: null,
          withheld: false,
          environmentPolicy: null,
          organiserBookingId: null as string | null,
          organiserEmail: null as string | null,
        };
      }
      // #3642: released meanwhile. The reaper already retired this invoice
      // (pointer cleared, VOID queued in the same commit): just don't email.
      if (
        !isGroupSettlementBoundToInvoice(fresh) ||
        fresh.xeroInvoiceId !== createdInvoice.invoiceID
      ) {
        return {
          cancelled: false,
          abandoned: true,
          responseBody: null,
          withheld: false,
          environmentPolicy: null,
          organiserBookingId: null as string | null,
          organiserEmail: null as string | null,
        };
      }
      // #2258 (owner decision D10). SEMANTICS, because a settlement invoice is
      // not attributable to one booking: this ONE combined invoice covers the
      // organiser plus every joiner, and it is addressed to and paid by the
      // ORGANISER. It is therefore gated on the organiser's own booking —
      // `groupBooking.organiserBookingId` — and on nothing else. A joiner who
      // has "No emails" set on their child booking does NOT suppress the
      // organiser's invoice (it is not their message, and suppressing it would
      // stop the organiser being billed); conversely, when the organiser's
      // booking has it set, the invoice is not emailed to anyone. The joiner's
      // own group emails (join settled / released / cancelled) are separately
      // gated on each joiner's child booking.
      //
      // The read happens inside this advisory-locked transaction, immediately
      // before the provider call, so a switch flipped concurrently cannot
      // interleave. If the read throws, the surrounding try/catch records an
      // invoiceEmailError and NO email is sent — fail closed by construction.
      // Only the EMAILING is withheld: the invoice is already raised in Xero.
      if (fresh.groupBooking.organiserBooking.noEmails) {
        return {
          cancelled: false,
          abandoned: false,
          responseBody: null,
          withheld: true,
          environmentPolicy: null,
          organiserBookingId: fresh.groupBooking
            .organiserBookingId as string | null,
          organiserEmail: bookingOwner(fresh.groupBooking.organiserBooking).member
            .email as string | null,
        };
      }
      // #3035: the club's own switch above is checked FIRST, so it stays
      // recorded as the club's decision on a copy. No withheld-email audit row
      // for this branch — that row asserts an administrator set the switch.
      const freshPolicy =
        await reassertXeroInvoiceEmailPolicy(invoiceEmailPolicy, tx);
      if (freshPolicy.kind !== "allow") {
        // Record from THIS answer, not the outer one (the helper says why).
        return {
          cancelled: false,
          abandoned: false,
          responseBody: null,
          withheld: false,
          environmentPolicy: freshPolicy,
          organiserBookingId: null as string | null,
          organiserEmail: null as string | null,
        };
      }
      const notSent = {
        cancelled: false,
        abandoned: false,
        responseBody: null,
        withheld: false,
        environmentPolicy: null,
        organiserBookingId: null as string | null,
        organiserEmail: null as string | null,
      };
      // #4919: too much of the timeout went on waiting for the lock, so the
      // deadline and the commit might not fit. Owed, not attempted.
      if (performance.now() - fenceStartedAt > XERO_EMAIL_FENCE_LATEST_SEND_MS) {
        invoiceEmailDeferredError = new Error(
          "The wait for the booking lock left too little time to ask Xero to email the invoice; it was not asked"
        );
        return notSent;
      }
      let emailResponse;
      try {
        emailResponse = await sendXeroInvoiceEmail({
          ...XERO_IN_LOCK_EMAIL_BUDGET,
          usageTasks,
          clearance: freshPolicy.clearance,
          xero,
          tenantId,
          invoiceId: createdInvoice.invoiceID,
          idempotencyKey: invoiceEmailIdempotencyKey,
          workflow: "createXeroInvoiceForGroupSettlement",
          context: `emailInvoice(group settlement ${settlementId})`,
        });
      } catch (error) {
        // Returned, not thrown: the fence wrote nothing, and its own commit
        // releases lock(1) at once. No sleep and no retry happen in here.
        if (isDeferrableInLockEmailError(error)) invoiceEmailDeferredError = error;
        else invoiceEmailError = error;
        return notSent;
      }
      invoiceEmailAccepted = true;
      invoiceEmailResponseBody = emailResponse.body;
      return { ...notSent, responseBody: emailResponse.body };
    }, XERO_EMAIL_FENCE_TRANSACTION_OPTIONS);
    invoiceEmailWithheld = emailGate.withheld;
    // Mutually exclusive by construction, and narrowed to the confirmed-copy
    // case exactly as the booking path is: an UNKNOWN role is an ERROR below.
    invoiceEmailWithheldForEnvironment =
      emailGate.environmentPolicy?.kind === "withhold" &&
      emailGate.environmentPolicy.suppressedForNonProduction;
    if (
      emailGate.withheld &&
      emailGate.organiserBookingId &&
      emailGate.organiserEmail
    ) {
      // Audit row outside the advisory-locked transaction so the lock is held
      // for the provider fence only (the same reason the emailInvoice call is
      // the sole non-DB work inside it).
      await recordWithheldBookingEmail({
        bookingId: emailGate.organiserBookingId,
        templateName: XERO_GROUP_SETTLEMENT_INVOICE_EMAIL_TEMPLATE,
        subject: `Xero group settlement invoice ${
          createdInvoice.invoiceNumber ?? createdInvoice.invoiceID ?? "(unnumbered)"
        } for your group booking`,
        to: emailGate.organiserEmail,
        detail:
          "Withheld: the organiser's booking has the \"No emails\" switch turned on. The combined group settlement invoice exists in Xero but was not emailed.",
      });
      logger.warn(
        {
          settlementId,
          invoiceId: createdInvoice.invoiceID,
          organiserBookingId: emailGate.organiserBookingId,
        },
        'Skipped the Xero group settlement invoice email for an organiser booking with "No emails" turned on'
      );
    }
    if (emailGate.environmentPolicy?.kind === "withhold") {
      const withheld = emailGate.environmentPolicy;
      const context = { settlementId, invoiceId: createdInvoice.invoiceID };
      if (withheld.error) {
        invoiceEmailError = withheld.error;
        logger.error(context, withheld.logMessage);
      } else {
        logger.info(context, withheld.logMessage);
      }
    }
    if (emailGate.abandoned) {
      // #3642: never emailed. Whoever retired it (the reaper, or a
      // replacement) queued its VOID and deactivated the link written above.
      await completeXeroSyncOperation(operationClaim, {
        status: "SUCCEEDED",
        responsePayload: {
          invoice: response.body,
          abandonedBeforeInvoiceEmail: true,
          invoiceEmailSuppressed: true,
        },
        xeroObjectType: "INVOICE",
        xeroObjectId: createdInvoice.invoiceID,
        xeroObjectNumber: createdInvoice.invoiceNumber ?? null,
        xeroObjectUrl: buildXeroInvoiceUrl(createdInvoice.invoiceID),
      });
      return null;
    }
    if (emailGate.cancelled) {
      await voidCancelledGroupSettlementInvoice({
        settlementId: settlementId,
        invoiceId: createdInvoice.invoiceID,
        invoiceNumber: createdInvoice.invoiceNumber ?? null,
        syncOperation: operationClaim,
        createResponse: response.body,
      });
      return null;
    }
    invoiceEmailResponseBody = emailGate.responseBody;
  } catch (error) {
    // #4919: a commit that fails after Xero accepted the email cannot turn it
    // into a failed send, and one after a deferral leaves the email owed.
    if (!invoiceEmailAccepted && !invoiceEmailDeferredError) invoiceEmailError = error;
    logger.warn(
      { err: error, settlementId, invoiceId: createdInvoice.invoiceID },
      invoiceEmailAccepted
        ? "Xero accepted the group settlement invoice email, but the fence's commit failed afterwards"
        : "Created Xero group settlement invoice but failed to email it to the organiser"
    );
  }

  // Usage writes run only after the fence releases its connection and lock.
  const usageResults = await Promise.allSettled(usageTasks.map((persist) => persist()));
  for (const result of usageResults) {
    if (result.status === "rejected") {
      logger.warn({ err: result.reason, settlementId }, "Failed to record Xero API usage for the group settlement invoice email");
    }
  }

  if (invoiceEmailDeferredError) {
    logger.warn(
      { err: invoiceEmailDeferredError, settlementId, invoiceId: createdInvoice.invoiceID },
      "Did not get the group settlement invoice emailed inside the booking lock; the email is owed"
    );
    if (params.redrivable) {
      // The marker survives the return to PENDING and the next claim, and is
      // what sends the re-drive into the email fence rather than closing it.
      await prisma.xeroSyncOperation.updateMany({
        where: { id: operationClaim.id, ...ownRunningClaim(operationClaim) },
        data: {
          responsePayload: sanitizeForJson(
            deferredGroupInvoiceEmailPayload(response.body, invoiceEmailDeferredError)
          ),
        },
      });
      throw new GroupSettlementInvoiceEmailDeferredError(settlementId, createdInvoice.invoiceID);
    }
  }

  await completeXeroSyncOperation(operationClaim, {
    status: invoiceEmailError || invoiceEmailDeferredError ? "PARTIAL" : "SUCCEEDED",
    responsePayload: {
      invoice: response.body,
      invoiceEmail: invoiceEmailResponseBody,
      // #4919: no "email" in either key, or the stored row reads [REDACTED].
      invoiceSendAccepted: invoiceEmailAccepted,
      deferredInvoiceSend: invoiceEmailDeferredError
        ? GROUP_SETTLEMENT_INVOICE_EMAIL_DEFERRED_CAUSE
        : null,
      invoiceEmailError: invoiceEmailError ?? invoiceEmailDeferredError,
      invoiceEmailWithheldByNoEmails: invoiceEmailWithheld,
      // #3035: a THIRD, distinct reason nothing was emailed — a confirmed
      // copy. Never conflated with the switch above or a provider failure.
      invoiceEmailWithheldForEnvironment,
    },
    xeroObjectType: "INVOICE",
    xeroObjectId: createdInvoice.invoiceID,
    xeroObjectNumber: createdInvoice.invoiceNumber ?? null,
    xeroObjectUrl: buildXeroInvoiceUrl(createdInvoice.invoiceID),
  });

  return createdInvoice.invoiceID;
}
