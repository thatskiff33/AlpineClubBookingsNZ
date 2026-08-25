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

import {
  Invoice,
  LineAmountTypes,
  LineItem,
} from "xero-node";
import { BookingStatus, GroupBookingStatus } from "@prisma/client";
import { prisma } from "./prisma";
import logger from "@/lib/logger";
import { lodgeNullTolerantScope } from "@/lib/lodges";
import {
  recordWithheldBookingEmail,
  XERO_GROUP_SETTLEMENT_INVOICE_EMAIL_TEMPLATE,
} from "@/lib/booking-email-suppression";
import { getStayNights } from "./pricing";
import { buildXeroInvoiceUrl } from "@/lib/xero-links";
import {
  buildXeroIdempotencyKey,
  completeXeroSyncOperation,
  failXeroSyncOperation,
  sanitizeForJson,
  startXeroSyncOperation,
  upsertXeroObjectLink,
} from "@/lib/xero-sync";
import {
  callXeroApi,
  getAuthenticatedXeroClient,
} from "./xero-api-client";
import {
  reassertXeroInvoiceEmailPolicy,
  resolveXeroInvoiceEmailPolicy,
  sendXeroInvoiceEmail,
} from "@/lib/xero-invoice-email";
import {
  getHutFeeItemCodeMap,
  getResolvedAccountMapping,
} from "./xero-mappings";
import {
  findOrCreateXeroContact,
  retryXeroWriteWithContactRepair,
  type FindOrCreateXeroContactOptions,
} from "./xero-contacts";
import { buildInvoiceLineItems } from "./xero-booking-invoices";
import { formatDateOnly, formatDateOnlyForTimeZone } from "@/lib/date-only";
import { enqueueXeroGroupSettlementInvoiceVoidOperation } from "@/lib/xero-group-settlement-void-outbox";

export interface CreateXeroGroupSettlementInvoiceOptions
  extends FindOrCreateXeroContactOptions {
  syncOperationId?: string;
}

/** The Xero object-link role for a combined settlement invoice. */
const GROUP_SETTLEMENT_INVOICE_ROLE = "GROUP_SETTLEMENT_INVOICE";

async function voidCancelledGroupSettlementInvoice(params: {
  settlementId: string;
  invoiceId: string;
  invoiceNumber: string | null;
  syncOperationId?: string;
  createResponse?: unknown;
}): Promise<void> {
  const { xero, tenantId } = await getAuthenticatedXeroClient();
  const idempotencyKey = buildXeroIdempotencyKey(
    "group-settlement",
    params.settlementId,
    "invoice-void-after-cancel",
    params.invoiceId,
    "v1"
  );
  const response = await callXeroApi(
    () =>
      xero.accountingApi.updateInvoice(
        tenantId,
        params.invoiceId,
        {
          invoices: [
            {
              invoiceID: params.invoiceId,
              status: Invoice.StatusEnum.VOIDED,
            },
          ],
        },
        undefined,
        idempotencyKey
      ),
    {
      operation: "updateInvoice",
      resourceType: "INVOICE",
      workflow: "createXeroInvoiceForGroupSettlement",
      context: `voidInvoice(cancelled group settlement ${params.settlementId})`,
    }
  );

  const link = {
    localModel: "GroupBookingSettlement",
    localId: params.settlementId,
    xeroObjectType: "INVOICE",
    xeroObjectId: params.invoiceId,
    xeroObjectNumber: params.invoiceNumber,
    xeroObjectUrl: buildXeroInvoiceUrl(params.invoiceId),
    role: GROUP_SETTLEMENT_INVOICE_ROLE,
  } as const;

  if (params.syncOperationId) {
    await completeXeroSyncOperation(params.syncOperationId, {
      status: "SUCCEEDED",
      responsePayload: {
        cancelledAfterInvoiceCreation: true,
        createInvoice: params.createResponse ?? null,
        voidInvoice: response.body ?? null,
        invoiceEmailSuppressed: true,
      },
      xeroObjectType: "INVOICE",
      xeroObjectId: params.invoiceId,
      xeroObjectNumber: params.invoiceNumber,
      xeroObjectUrl: buildXeroInvoiceUrl(params.invoiceId),
      extraLinks: [link],
    });
  } else {
    await upsertXeroObjectLink(link);
  }
}

/** Replayable outbox handler for the compensating VOID after group cancel. */
export async function voidXeroInvoiceForCancelledGroupSettlement(
  settlementId: string,
  options: { syncOperationId: string }
): Promise<void> {
  const settlement = await prisma.groupBookingSettlement.findUnique({
    where: { id: settlementId },
    select: {
      id: true,
      xeroInvoiceId: true,
      xeroInvoiceNumber: true,
      groupBooking: { select: { status: true } },
    },
  });
  if (!settlement) {
    throw new Error(`Group settlement not found: ${settlementId}`);
  }
  if (settlement.groupBooking.status !== GroupBookingStatus.CANCELLED) {
    throw new Error(`Cannot VOID an active group settlement: ${settlementId}`);
  }
  if (!settlement.xeroInvoiceId) {
    throw new Error(`Cancelled group settlement has no Xero invoice: ${settlementId}`);
  }
  await voidCancelledGroupSettlementInvoice({
    settlementId: settlement.id,
    invoiceId: settlement.xeroInvoiceId,
    invoiceNumber: settlement.xeroInvoiceNumber,
    syncOperationId: options.syncOperationId,
  });
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
    return {
      settlement,
      queuedVoidOperationId: queuedVoid?.queueOperationId ?? null,
    };
  });
  const settlement = initialFence.settlement;

  if (!settlement) throw new Error(`Group settlement not found: ${settlementId}`);

  if (settlement.groupBooking.status === GroupBookingStatus.CANCELLED) {
    if (settlement.xeroInvoiceId) {
      try {
        await voidCancelledGroupSettlementInvoice({
          settlementId: settlement.id,
          invoiceId: settlement.xeroInvoiceId,
          invoiceNumber: settlement.xeroInvoiceNumber,
          syncOperationId: options?.syncOperationId,
        });
      } catch (error) {
        if (options?.syncOperationId) {
          await failXeroSyncOperation(options.syncOperationId, error);
        }
        throw error;
      }
    } else if (options?.syncOperationId) {
      await completeXeroSyncOperation(options.syncOperationId, {
        status: "SUCCEEDED",
        responsePayload: { cancelledBeforeInvoiceCreation: true },
      });
    }
    return null;
  }

  // Already raised on a prior attempt: re-assert the link and return it.
  if (settlement.xeroInvoiceId) {
    await upsertXeroObjectLink({
      localModel: "GroupBookingSettlement",
      localId: settlement.id,
      xeroObjectType: "INVOICE",
      xeroObjectId: settlement.xeroInvoiceId,
      xeroObjectNumber: settlement.xeroInvoiceNumber ?? null,
      xeroObjectUrl: buildXeroInvoiceUrl(settlement.xeroInvoiceId),
      role: GROUP_SETTLEMENT_INVOICE_ROLE,
    });
    return settlement.xeroInvoiceId;
  }

  const organiserMemberId = settlement.groupBooking.organiserMemberId;

  // The joiner children covered by this settlement: organiser-settled, committed
  // to CONFIRMED (capacity held) and not yet PAID. Their guests/nights become the
  // combined invoice's line items.
  const children = await prisma.booking.findMany({
    where: {
      parentBookingId: settlement.groupBooking.organiserBookingId,
      organiserSettled: true,
      deletedAt: null,
      status: { in: [BookingStatus.CONFIRMED, BookingStatus.PAID] },
    },
    include: { guests: { include: { nights: true } } },
  });

  if (children.length === 0) {
    throw new Error(
      `No settleable children found for group settlement: ${settlementId}`
    );
  }

  const { xero, tenantId } = await getAuthenticatedXeroClient();
  // #3036 review P1-12: reuse the client built above rather than rebuilding one.
  const contactId = await findOrCreateXeroContact(organiserMemberId, { ...options, xero, tenantId });

  const [hutFeeMapping, hutFeeItemCodeMap] = await Promise.all([
    getResolvedAccountMapping("hutFeesIncome"),
    getHutFeeItemCodeMap(),
  ]);
  const incomeCode = hutFeeMapping.code ?? "200";

  // Build line items per child (each child has its own date range and season),
  // then aggregate across the whole group into one invoice.
  const lineItems: LineItem[] = [];
  for (const child of children) {
    const checkIn = new Date(child.checkIn);
    const checkOut = new Date(child.checkOut);
    const nights = getStayNights(checkIn, checkOut).length;

    // Scoped to the CHILD booking's own lodge, for the same reason as the
    // per-booking invoice paths: lodges may run different season windows, so an
    // unscoped read can take another lodge's season and its item code.
    let seasonType: string | null = null;
    const season = await prisma.season.findFirst({
      where: {
        startDate: { lte: checkIn },
        endDate: { gte: checkIn },
        active: true,
        ...lodgeNullTolerantScope(child.lodgeId),
      },
      select: { type: true },
    });
    if (season) {
      seasonType = season.type;
    }

    lineItems.push(
      ...buildInvoiceLineItems(
        child.guests.map((g) => ({
          firstName: g.firstName,
          lastName: g.lastName,
          ageTier: g.ageTier,
          isMember: g.isMember,
          rateMembershipTypeId: g.rateMembershipTypeId,
          priceCents: g.priceCents,
          nights: (g.nights ?? []).map((n) => ({
            stayDate: n.stayDate,
            priceCents: n.priceCents,
          })),
        })),
        checkIn,
        checkOut,
        nights,
        incomeCode,
        hutFeeMapping.itemCode,
        hutFeeMapping.codeExplicitlyConfigured,
        hutFeeItemCodeMap,
        seasonType
      )
    );
  }

  // Two dates, two different kinds of value, so two different derivations.
  //
  // The ISSUE date is the organiser booking's check-in — a `@db.Date` lodge
  // night, an abstract calendar day already pinned to UTC midnight, so
  // truncating it reads back the day it encodes (INV-DATE-010).
  //
  // The DUE date is `GroupBookingSettlement.createdAt`, a `DateTime` — a real
  // instant. Truncating an instant to its UTC day is the pattern INV-DATE-019
  // forbids: New Zealand runs 12-13 hours ahead of UTC, so for roughly the first
  // half of every club day the UTC day is still yesterday, and a settlement
  // invoice raised at 09:00 NZ on 1 July carried a due date of 30 June (#2834).
  const issueDate = formatDateOnly(
    new Date(settlement.groupBooking.organiserBooking.checkIn)
  );
  const dueDate = formatDateOnlyForTimeZone(new Date(settlement.createdAt));

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

  const invoiceIdempotencyKey = buildXeroIdempotencyKey(
    "group-settlement",
    settlementId,
    "invoice",
    "v1"
  );
  let operationId = options?.syncOperationId ?? null;
  const requestPayload = { invoices: [buildInvoice(contactId)] };

  if (operationId) {
    await prisma.xeroSyncOperation.update({
      where: { id: operationId },
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
    operationId = operation.id;
  }

  try {
    const response = await retryXeroWriteWithContactRepair({
      memberId: organiserMemberId,
      currentContactId: contactId,
      workflow: "createXeroInvoiceForGroupSettlement",
      operationId: operationId!,
      repairExistingLink: options?.repairExistingLink,
      createdByMemberId: options?.createdByMemberId,
      buildRequestPayload: (resolvedContactId) => ({
        invoices: [buildInvoice(resolvedContactId)],
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
    const cancellationResult = await prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(1)`;
      const fresh = await tx.groupBookingSettlement.findUnique({
        where: { id: settlement.id },
        select: { groupBooking: { select: { status: true } } },
      });
      if (!fresh) {
        throw new Error(`Group settlement not found: ${settlementId}`);
      }
      await tx.groupBookingSettlement.update({
        where: { id: settlement.id },
        data: {
          xeroInvoiceId: createdInvoice.invoiceID,
          xeroInvoiceNumber: createdInvoice.invoiceNumber ?? null,
        },
      });
      const cancellationWon =
        fresh.groupBooking.status === GroupBookingStatus.CANCELLED;
      const queuedVoid = cancellationWon
        ? await enqueueXeroGroupSettlementInvoiceVoidOperation(settlement.id, {
            store: tx,
          })
        : null;
      return {
        cancellationWon,
        queuedVoidOperationId: queuedVoid?.queueOperationId ?? null,
      };
    });

    if (cancellationResult.cancellationWon) {
      await voidCancelledGroupSettlementInvoice({
        settlementId: settlement.id,
        invoiceId: createdInvoice.invoiceID,
        invoiceNumber: createdInvoice.invoiceNumber ?? null,
        syncOperationId: operationId!,
        createResponse: response.body,
      });
      return null;
    }

    // Email the invoice so the organiser can pay it by bank transfer.  This is
    // the one deliberately provider-spanning lifecycle fence in this workflow:
    // the single bounded emailInvoice call runs while lock(1) is held.  Without
    // that serialization, cancellation could commit after the last DB check but
    // before the provider accepted the email, producing a payable email after a
    // durable CANCELLED state.  No other DB work or provider call is included.
    // If cancellation won first, enqueue the replayable VOID in the same tx and
    // suppress email.  If email won first, cancellation waits and subsequently
    // commits its own durable VOID debt; email therefore never occurs AFTER a
    // cancellation commit.
    let invoiceEmailResponseBody: unknown = null;
    let invoiceEmailError: unknown = null;
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
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(1)`;
        const fresh = await tx.groupBookingSettlement.findUnique({
          where: { id: settlement.id },
          select: {
            groupBooking: {
              select: {
                status: true,
                organiserBookingId: true,
                // #2258: the "No emails" switch on the ORGANISER'S booking.
                organiserBooking: {
                  select: {
                    noEmails: true,
                    member: { select: { email: true } },
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
          await enqueueXeroGroupSettlementInvoiceVoidOperation(settlement.id, {
            store: tx,
          });
          return {
            cancelled: true,
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
            responseBody: null,
            withheld: true,
            environmentPolicy: null,
            organiserBookingId: fresh.groupBooking
              .organiserBookingId as string | null,
            organiserEmail: fresh.groupBooking.organiserBooking.member
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
            responseBody: null,
            withheld: false,
            environmentPolicy: freshPolicy,
            organiserBookingId: null as string | null,
            organiserEmail: null as string | null,
          };
        }
        const emailResponse = await sendXeroInvoiceEmail({
          clearance: freshPolicy.clearance,
          xero,
          tenantId,
          invoiceId: createdInvoice.invoiceID!,
          idempotencyKey: invoiceEmailIdempotencyKey,
          workflow: "createXeroInvoiceForGroupSettlement",
          context: `emailInvoice(group settlement ${settlementId})`,
        });
        return {
          cancelled: false,
          responseBody: emailResponse.body,
          withheld: false,
          environmentPolicy: null,
          organiserBookingId: null as string | null,
          organiserEmail: null as string | null,
        };
      });
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
      if (emailGate.cancelled) {
        await voidCancelledGroupSettlementInvoice({
          settlementId: settlement.id,
          invoiceId: createdInvoice.invoiceID,
          invoiceNumber: createdInvoice.invoiceNumber ?? null,
          syncOperationId: operationId!,
          createResponse: response.body,
        });
        return null;
      }
      invoiceEmailResponseBody = emailGate.responseBody;
    } catch (error) {
      invoiceEmailError = error;
      logger.warn(
        { err: error, settlementId, invoiceId: createdInvoice.invoiceID },
        "Created Xero group settlement invoice but failed to email it to the organiser"
      );
    }

    await completeXeroSyncOperation(operationId!, {
      status: invoiceEmailError ? "PARTIAL" : "SUCCEEDED",
      responsePayload: {
        invoice: response.body,
        invoiceEmail: invoiceEmailResponseBody,
        invoiceEmailError,
        invoiceEmailWithheldByNoEmails: invoiceEmailWithheld,
        // #3035: a THIRD, distinct reason nothing was emailed — a confirmed
        // copy. Never conflated with the switch above or a provider failure.
        invoiceEmailWithheldForEnvironment,
      },
      xeroObjectType: "INVOICE",
      xeroObjectId: createdInvoice.invoiceID,
      xeroObjectNumber: createdInvoice.invoiceNumber ?? null,
      xeroObjectUrl: buildXeroInvoiceUrl(createdInvoice.invoiceID),
      extraLinks: [
        {
          localModel: "GroupBookingSettlement",
          localId: settlement.id,
          xeroObjectType: "INVOICE",
          xeroObjectId: createdInvoice.invoiceID,
          xeroObjectNumber: createdInvoice.invoiceNumber ?? null,
          xeroObjectUrl: buildXeroInvoiceUrl(createdInvoice.invoiceID),
          role: GROUP_SETTLEMENT_INVOICE_ROLE,
        },
      ],
    });

    return createdInvoice.invoiceID;
  } catch (error) {
    await failXeroSyncOperation(operationId!, error);
    throw error;
  }
}
