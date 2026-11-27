/**
 * The outbox worker for a mid-season age-up CREDIT (#5190 PR 3, owner decision
 * 27 Nov 2026, `INV-MONEY-053`). The billing confirm writes the adjustment and
 * queues one `AGE_UP_CREDIT` operation; this settles it, through Xero only
 * (`INV-PAY-013/014`: no PaymentIntent, no Stripe refund):
 *
 *  1. It waits until the member's season invoice exists: the invoice of the
 *     charge whose active coverage claim covers their season row. A season paid
 *     with no invoice of this app's (closed as already paid, or marked paid by
 *     hand) has none to wait for, and goes straight to the lot.
 *  2. It reads that invoice's `amountDue` from Xero. When it is at least the
 *     credit, ONE credit note on the `membershipCancellationCredit` mapping is
 *     raised and allocated to it (`subscription-credit-note.ts`, the helper the
 *     cancellation credit shares), and the adjustment ends CREDITED_ON_INVOICE.
 *  3. Otherwise (the invoice is paid, or owes less) the credit becomes a
 *     positive member credit lot with its own Xero note queued
 *     (`postAgeUpCreditLot`), spent later through `applyCreditToBooking`, which
 *     already keeps Stripe and Xero settlement apart. The adjustment ends
 *     CREDITED_TO_ACCOUNT.
 *
 * Never twice. The operation's correlation key is the adjustment's own
 * (`ageUpCreditIdempotencyKey`), so one is active at a time; the note's Xero
 * idempotency key is the same key; the lot is written only after a
 * status-guarded claim of the PENDING adjustment, under
 * `lockMemberCreditLedger(memberId)` alone (`INV-LOCK-003` site; it moves no
 * booking or settlement money, so no global or season key, `INV-LOCK-001`).
 * The provider call is never inside that transaction.
 */
import type { AgeUpCreditPayload } from "@/lib/age-up-credit-payload";
import { AGE_UP_ADJUSTMENT_LOCAL_MODEL, buildAgeUpCreditPayload } from "@/lib/age-up-credit-payload";
import { clubFormatValues } from "@/lib/club-format-server";
import { readClubTimeZoneOutsideRequest } from "@/lib/club-time-zone-runtime";
import logger from "@/lib/logger";
import { lockMemberCreditLedger } from "@/lib/member-credit";
import { postAgeUpCreditLot } from "@/lib/member-credit-age-up";
import { providerAmountToCents } from "@/lib/money-provider-amount";
import { prisma } from "@/lib/prisma";
import { ageUpCreditIdempotencyKey } from "@/lib/subscription-age-up-billing";
import {
  allocateSubscriptionCreditNote,
  buildSubscriptionCreditNote,
  subscriptionCreditLineItem,
} from "@/lib/subscription-credit-note";
import { callXeroApi, getAuthenticatedXeroClient } from "@/lib/xero-api-client";
import { XeroAppliedCreditOperationBusyError } from "@/lib/xero-applied-credit-operation-serialization";
import { requireContainedXeroContactForInvoiceOperation } from "@/lib/xero-contact-containment-proof";
import { buildXeroCreditNoteUrl, buildXeroInvoiceUrl } from "@/lib/xero-links";
import { AGE_UP_CREDIT_AWAITING_SEASON_INVOICE_CODE } from "@/lib/xero-operation-error-codes";
import type { XeroOperationClaim } from "@/lib/xero-operation-outcome-guard";
import { xeroDocumentDateForClubToday } from "@/lib/xero-provider-dates";
import {
  buildXeroIdempotencyKey,
  completeXeroSyncOperation,
  failXeroSyncOperation,
  sanitizeForJson,
  upsertXeroObjectLink,
} from "@/lib/xero-sync";
import { resolveXeroTaxRendering } from "@/lib/xero-tax-anchors";
import { scanSpacesWaitCode } from "@/lib/xero-operation-wait-spacing";

/** `XeroObjectLink.role` of the credit note an adjustment raised. */
export const AGE_UP_CREDIT_NOTE_ROLE = "AGE_UP_CREDIT_NOTE";

/** How often a credit waiting for its season invoice is looked at again. */
export const AGE_UP_CREDIT_SEASON_INVOICE_RECHECK_MS = 15 * 60 * 1000;

/** The outbox scan's spacing for a credit waiting on its season invoice. */
export function scanSpacesAgeUpCreditsAwaitingSeasonInvoice(now: Date) {
  return scanSpacesWaitCode(AGE_UP_CREDIT_AWAITING_SEASON_INVOICE_CODE, AGE_UP_CREDIT_SEASON_INVOICE_RECHECK_MS, now);
}

/** What the worker found the adjustment's season to be. */
type SeasonInvoice =
  | { kind: "invoice"; invoiceId: string }
  | { kind: "paid-without-invoice" }
  | { kind: "wait" };

function seasonInvoiceOf(subscription: {
  status: string;
  chargeCoverage: Array<{ charge: { xeroInvoiceId: string | null; status: string } }>;
}): SeasonInvoice {
  const charge = subscription.chargeCoverage[0]?.charge;
  if (charge?.xeroInvoiceId && charge.status !== "VOIDED") {
    return { kind: "invoice", invoiceId: charge.xeroInvoiceId };
  }
  if (!charge && subscription.status === "PAID") return { kind: "paid-without-invoice" };
  return { kind: "wait" };
}

/**
 * The lot route: claim the PENDING adjustment, then write the lot, link it and
 * queue its note, in one transaction under the member's credit-ledger lock. A
 * lost claim writes nothing and returns null. Exported for the realdb race.
 */
export async function creditAgeUpAdjustmentToAccount(adjustmentId: string): Promise<{ memberCreditId: string } | null> {
  // Before the transaction and its lock (#3565, `INV-LOCK-004`).
  const format = await clubFormatValues();
  const adjustment = await prisma.memberSubscriptionAgeUpAdjustment.findUnique({
    where: { id: adjustmentId },
    select: { amountCents: true, description: true, memberSubscription: { select: { memberId: true } } },
  });
  if (!adjustment) return null;
  // The subscription's member, which follows a member merge; the adjustment's
  // own `memberId` is a snapshot.
  const memberId = adjustment.memberSubscription.memberId;
  return prisma.$transaction(async (tx) => {
    await lockMemberCreditLedger(memberId, tx);
    const claimed = await tx.memberSubscriptionAgeUpAdjustment.updateMany({
      where: { id: adjustmentId, kind: "CREDIT", status: "PENDING", memberCreditId: null, xeroCreditNoteId: null },
      data: { status: "CREDITED_TO_ACCOUNT" },
    });
    if (claimed.count === 0) return null;
    const credit = await postAgeUpCreditLot(tx, {
      adjustmentId,
      memberId,
      amountCents: adjustment.amountCents,
      description: adjustment.description,
      format,
    });
    await tx.memberSubscriptionAgeUpAdjustment.update({
      where: { id: adjustmentId },
      data: { memberCreditId: credit.id },
    });
    return { memberCreditId: credit.id };
  });
}

export async function createAgeUpCredit(input: {
  syncOperation: XeroOperationClaim;
  payload: AgeUpCreditPayload;
  createdByMemberId?: string;
}): Promise<void> {
  const { syncOperation, payload } = input;
  const adjustment = await prisma.memberSubscriptionAgeUpAdjustment.findUnique({
    where: { id: payload.adjustmentId },
    select: {
      id: true,
      kind: true,
      status: true,
      amountCents: true,
      description: true,
      seasonYear: true,
      memberSubscription: {
        select: {
          id: true,
          memberId: true,
          status: true,
          member: { select: { xeroContactId: true } },
          chargeCoverage: {
            where: { releasedAt: null },
            take: 1,
            select: { charge: { select: { xeroInvoiceId: true, status: true } } },
          },
        },
      },
    },
  });
  if (!adjustment || adjustment.kind !== "CREDIT") {
    await failXeroSyncOperation(syncOperation, new Error(`Age-up credit ${payload.adjustmentId} does not name a credit adjustment.`));
    return;
  }
  if (adjustment.status !== "PENDING") {
    await completeXeroSyncOperation(syncOperation, { responsePayload: { skipped: true, reason: adjustment.status } });
    return;
  }
  const subscription = adjustment.memberSubscription;
  const season = seasonInvoiceOf(subscription);
  if (season.kind === "wait") {
    // Returned to PENDING by the outbox and looked at again later; nothing was sent.
    throw new XeroAppliedCreditOperationBusyError(
      "This age-group change credit waits until the member's season invoice is raised in Xero.",
      null,
      AGE_UP_CREDIT_AWAITING_SEASON_INVOICE_CODE,
    );
  }

  try {
    if (season.kind === "invoice") {
      const credited = await creditOnSeasonInvoice({
        adjustment: { ...adjustment, memberId: subscription.memberId, subscriptionId: subscription.id },
        invoiceId: season.invoiceId,
        memberXeroContactId: subscription.member.xeroContactId,
        syncOperation,
      });
      if (credited) return;
    }
    const lot = await creditAgeUpAdjustmentToAccount(adjustment.id);
    await completeXeroSyncOperation(syncOperation, {
      responsePayload: lot
        ? { route: "credit-lot", memberCreditId: lot.memberCreditId, amountCents: adjustment.amountCents }
        : { skipped: true, reason: "claimed-by-another-worker" },
    });
    if (lot) {
      void import("@/lib/xero-operation-outbox")
        .then(({ kickQueuedXeroOutboxOperationsIfConnected }) => kickQueuedXeroOutboxOperationsIfConnected())
        .catch((error: unknown) => logger.error({ err: error, adjustmentId: adjustment.id }, "Failed to kick the Xero outbox after an age-up credit lot"));
    }
  } catch (error) {
    await failXeroSyncOperation(syncOperation, error);
    throw error;
  }
}

/**
 * The allocate route. True when the credit note was raised (or found) and
 * allocated; false when the invoice owes less than the credit, so the caller
 * takes the lot route instead. Nothing has been raised when it returns false.
 */
async function creditOnSeasonInvoice(input: {
  adjustment: {
    id: string;
    amountCents: number;
    description: string;
    seasonYear: number;
    memberId: string;
    subscriptionId: string;
  };
  invoiceId: string;
  memberXeroContactId: string | null;
  syncOperation: XeroOperationClaim;
}): Promise<boolean> {
  const { adjustment, invoiceId } = input;
  const existingNote = await prisma.xeroObjectLink.findFirst({
    where: {
      localModel: AGE_UP_ADJUSTMENT_LOCAL_MODEL,
      localId: adjustment.id,
      xeroObjectType: "CREDIT_NOTE",
      role: AGE_UP_CREDIT_NOTE_ROLE,
      active: true,
    },
    select: { xeroObjectId: true, xeroObjectNumber: true },
  });
  const { xero, tenantId } = await getAuthenticatedXeroClient();
  const invoiceResponse = await callXeroApi(() => xero.accountingApi.getInvoice(tenantId, invoiceId), {
    operation: "getInvoice",
    resourceType: "INVOICE",
    workflow: "createAgeUpCredit",
    context: `getInvoice(${invoiceId})`,
  });
  const invoice = invoiceResponse.body.invoices?.[0];
  if (!invoice?.invoiceID) throw new Error(`Xero season invoice not found: ${invoiceId}`);
  const amountDueCents = Math.max(0, providerAmountToCents(invoice.amountDue) ?? 0);
  // A note already raised for this adjustment is allocated whatever is owed
  // now: a second note, or a lot beside it, would credit twice.
  if (!existingNote && amountDueCents < adjustment.amountCents) return false;

  const contactId = invoice.contact?.contactID ?? input.memberXeroContactId;
  if (!contactId) throw new Error(`No Xero contact for season invoice ${invoiceId}.`);
  // The note lands on the invoice's contact; prove that contact is contained
  // on a restored copy, as the cancellation credit does (`INV-CONFIG-005`).
  await requireContainedXeroContactForInvoiceOperation({
    resolveXeroContactId: async () => contactId,
    memberId: adjustment.memberId,
    workflow: "createAgeUpCredit",
    xero,
    tenantId,
  });

  const documentDate = xeroDocumentDateForClubToday(await readClubTimeZoneOutsideRequest());
  let creditNoteId = existingNote?.xeroObjectId ?? null;
  let creditNoteNumber = existingNote?.xeroObjectNumber ?? null;
  if (!creditNoteId) {
    const taxRendering = await resolveXeroTaxRendering({
      kind: "subscription-invoice",
      invoiceId,
      subscriptionId: adjustment.subscriptionId,
    });
    const creditNote = buildSubscriptionCreditNote({
      contactId,
      date: documentDate,
      taxRendering,
      lineItem: await subscriptionCreditLineItem({
        description: adjustment.description,
        amountCents: adjustment.amountCents,
        taxRendering,
      }),
      reference: `MEMSUB-AGEUP-${adjustment.id.slice(0, 8)}`,
    });
    await prisma.xeroSyncOperation.update({
      where: { id: input.syncOperation.id },
      // The queued request rides on the execution request, so a retry still claims the row (#5228).
      data: { requestPayload: sanitizeForJson({ ...buildAgeUpCreditPayload(adjustment.id), creditNotes: [creditNote], allocation: { invoiceId, amountCents: adjustment.amountCents } }) },
    });
    const response = await callXeroApi(
      () => xero.accountingApi.createCreditNotes(tenantId, { creditNotes: [creditNote] }, undefined, undefined, ageUpCreditIdempotencyKey(adjustment.id)),
      {
        operation: "createCreditNotes",
        resourceType: "CREDIT_NOTE",
        workflow: "createAgeUpCredit",
        context: `createCreditNotes(age-up adjustment ${adjustment.id})`,
      },
    );
    const created = response.body.creditNotes?.[0];
    if (!created?.creditNoteID) throw new Error("Xero did not return a credit note for this age-group change credit.");
    creditNoteId = created.creditNoteID;
    creditNoteNumber = created.creditNoteNumber ?? null;
    await upsertXeroObjectLink({
      localModel: AGE_UP_ADJUSTMENT_LOCAL_MODEL,
      localId: adjustment.id,
      xeroObjectType: "CREDIT_NOTE",
      xeroObjectId: creditNoteId,
      xeroObjectNumber: creditNoteNumber,
      xeroObjectUrl: buildXeroCreditNoteUrl(creditNoteId),
      role: AGE_UP_CREDIT_NOTE_ROLE,
      metadata: { invoiceId, amountCents: adjustment.amountCents, seasonYear: adjustment.seasonYear },
    });
  }

  await allocateSubscriptionCreditNote({
    xero,
    tenantId,
    creditNoteId,
    invoiceId,
    amountCents: adjustment.amountCents,
    date: documentDate,
    idempotencyKey: buildXeroIdempotencyKey("credit-note", creditNoteId, "age-up", "invoice", invoiceId, adjustment.amountCents, "v1"),
    workflow: "createAgeUpCredit",
  });
  const settled = await prisma.memberSubscriptionAgeUpAdjustment.updateMany({
    where: { id: adjustment.id, status: "PENDING", memberCreditId: null },
    data: { status: "CREDITED_ON_INVOICE", xeroCreditNoteId: creditNoteId },
  });
  if (settled.count === 0) {
    // Only reachable if a second operation for this adjustment raced this one
    // into the lot route: say so loudly rather than finish quietly.
    logger.error({ adjustmentId: adjustment.id, creditNoteId }, "Age-up credit note allocated after the adjustment was already settled");
  }
  await completeXeroSyncOperation(input.syncOperation, {
    status: settled.count === 0 ? "PARTIAL" : "SUCCEEDED",
    responsePayload: { route: "credit-note", invoiceId, amountCents: adjustment.amountCents, amountDueCents },
    xeroObjectType: "CREDIT_NOTE",
    xeroObjectId: creditNoteId,
    xeroObjectNumber: creditNoteNumber,
    xeroObjectUrl: buildXeroCreditNoteUrl(creditNoteId),
    extraLinks: [
      {
        localModel: AGE_UP_ADJUSTMENT_LOCAL_MODEL,
        localId: adjustment.id,
        xeroObjectType: "INVOICE",
        xeroObjectId: invoiceId,
        xeroObjectUrl: buildXeroInvoiceUrl(invoiceId),
        role: "AGE_UP_CREDITED_INVOICE",
      },
    ],
  });
  return true;
}
