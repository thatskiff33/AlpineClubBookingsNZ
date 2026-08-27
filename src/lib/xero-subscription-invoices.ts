import {
  Invoice,
  LineAmountTypes,
  type XeroClient,
} from "xero-node";
import logger from "@/lib/logger";
import { prisma } from "@/lib/prisma";
import { callXeroApi, getAuthenticatedXeroClient } from "@/lib/xero-api-client";
import { findOrCreateXeroContact } from "@/lib/xero-contacts";
import {
  addDaysDateOnly,
  formatDateOnly,
  parseDateOnly,
} from "@/lib/date-only";
import { readClubTimeZoneOutsideRequest } from "@/lib/club-time-zone-runtime";
import {
  xeroCalendarDate,
  xeroDocumentDateForClubToday,
} from "@/lib/xero-provider-dates";
import { dateOnlyInstantOf } from "@/lib/club-time";
import { buildXeroInvoiceUrl, stripXeroOrgShortCode } from "@/lib/xero-links";
import {
  buildXeroIdempotencyKey,
  completeXeroSyncOperation,
  startXeroSyncOperation,
} from "@/lib/xero-sync";
import { XERO_OUTBOX_SUBSCRIPTION_INVOICE_TYPE } from "@/lib/xero-operation-outbox-payload";
import {
  resolveXeroInvoiceEmailPolicy,
  sendXeroInvoiceEmail,
} from "@/lib/xero-invoice-email";
import { providerAmountToCents } from "@/lib/money-provider-amount";
import { refreshFinancialYearConfig } from "@/lib/financial-year-server";
import { seasonYearsLabel } from "@/lib/season-label";

/**
 * A Xero invoice's total in integer cents, or `null` when it cannot be read.
 *
 * `null` IS THE POINT, and it replaced a `?? 0` (#2685 review). This figure only
 * ever feeds an ADOPTION comparison, so the answer to "I could not read this
 * invoice" has to be one that matches nothing. Zero is not that answer: a
 * snapshot line of `amountCents: 0` — a waived or fully-discounted component —
 * would have compared equal to an invoice whose amount was unreadable, and the
 * unreadable invoice would have been adopted as the charge's own. `null` is
 * never `===` a number, so every caller below refuses instead.
 *
 * The unreadable case needs the payload to carry a non-number where a number
 * belongs, which JSON from the Xero SDK does not produce — but a STRING
 * `lineAmount` used to coerce through `+` into the running sum and would now
 * make the sum a string, and a `NaN` used to stay `NaN` all the way to the
 * comparison. Failing closed costs nothing and removes the question.
 */
function invoiceCents(invoice: Invoice): number | null {
  const totalCents = providerAmountToCents(invoice.total);
  if (totalCents !== null) return totalCents;
  return providerAmountToCents(
    (invoice.lineItems ?? []).reduce(
      (sum, line) =>
        sum + (line.lineAmount ?? (line.quantity ?? 1) * (line.unitAmount ?? 0)),
      0,
    ),
  );
}

/**
 * How many days a Xero invoice allowed between its issue date and its due date.
 *
 * NO ZONE IS INVOLVED AND NONE MAY BE (#2834). This is not a clock read and not
 * a `DateTime` column: `invoice.date` / `invoice.dueDate` are plain calendar
 * dates on a document Xero already has, and whatever the SDK deserialised them
 * into — a `Date` at midnight, an ISO prefix, a `/Date(…)/` string — encodes
 * that day, so reading each back as a calendar day yields that day and zone
 * conversion would shift it. A shift here changes the interval, so
 * `subscriptionInvoiceMatchesSnapshot` stops matching, so a pre-existing invoice
 * stops being adopted: the charge goes to `CONFLICT`/`PROVIDER_MISMATCH` and the
 * member is left unbilled.
 *
 * IT USED TO CARRY ITS OWN COPY OF THE BOUNDARY — a private
 * `normalizeXeroDateOnly` that re-implemented the `Date`, ISO-prefix and
 * Microsoft-JSON branches by hand (#2869 review). The copy was correct, and
 * being correct is not the point: a second reader of the same wire shapes is a
 * second thing to fix when a fifth shape turns up, and it is exactly the
 * "clone one indirection away from the spelling any census was searching for"
 * pattern this epic removed elsewhere. `xeroCalendarDate` answers the same day
 * for every shape the clone handled, additionally accepts a space-separated
 * `"2019-03-11 00:00:00"`, and refuses an impossible day such as `2026-02-30`
 * instead of rolling it into March — where the clone would have returned a real
 * interval computed from a date Xero cannot have sent.
 */
function invoiceDueIntervalDays(invoice: Invoice): number | null {
  const issueDate = xeroCalendarDate(invoice.date);
  const dueDate = xeroCalendarDate(invoice.dueDate);
  if (!issueDate || !dueDate) return null;
  const issueMs = dateOnlyInstantOf(issueDate).getTime();
  const dueMs = dateOnlyInstantOf(dueDate).getTime();
  return (dueMs - issueMs) / (24 * 60 * 60 * 1000);
}

// One expected invoice line derived from a frozen charge-component snapshot.
export type SubscriptionInvoiceLine = {
  amountCents: number;
  accountCode: string;
  itemCode: string | null;
};

/** One invoice line in integer cents, or `null` — see `invoiceCents`. */
function lineCents(
  line: NonNullable<Invoice["lineItems"]>[number],
): number | null {
  const amount = line.lineAmount ?? ((line.quantity ?? 1) * (line.unitAmount ?? 0));
  // Refuses rather than defaulting, for the reason `invoiceCents` sets out: a
  // waived component snapshots as `amountCents: 0`, so a zero default made an
  // unreadable line adopt against it (#2685 review).
  return providerAmountToCents(amount);
}

// Adoption/idempotency guard (#1932, E6): the immutable charge now snapshots one
// component per invoice line, so the match compares the FULL line array in order
// (count, per-line amount + account + item + OUTPUT2 tax) plus the invoice-level
// total, reference, contact, due interval, type, line-amount type and status.
// A legacy single-line invoice adopts against a backfilled single-component
// charge because that charge reproduces exactly one line. Line description is
// deliberately NOT compared — it is derived at build time and must not make a
// pre-existing AUTHORISED invoice fail to adopt.
export function subscriptionInvoiceMatchesSnapshot(input: {
  invoice: Invoice;
  contactId: string;
  amountCents: number;
  lines: SubscriptionInvoiceLine[];
  dueDays: number;
  reference: string;
}) {
  const { invoice, contactId, amountCents, lines, dueDays, reference } = input;
  const invoiceLines = invoice.lineItems ?? [];
  return invoice.reference === reference
    && invoice.contact?.contactID === contactId
    && invoiceCents(invoice) === amountCents
    && invoiceLines.length === lines.length
    && lines.every((line, index) =>
      lineCents(invoiceLines[index]) === line.amountCents
      && invoiceLines[index]?.accountCode === line.accountCode
      && (invoiceLines[index]?.itemCode ?? null) === line.itemCode
      && invoiceLines[index]?.taxType === "OUTPUT2")
    && invoiceDueIntervalDays(invoice) === dueDays
    && invoice.type === Invoice.TypeEnum.ACCREC
    && invoice.lineAmountTypes === LineAmountTypes.Inclusive
    && invoice.status === Invoice.StatusEnum.AUTHORISED;
}

export async function enqueueMembershipSubscriptionChargeOperation(
  chargeId: string,
  options?: { createdByMemberId?: string },
) {
  const charge = await prisma.membershipSubscriptionCharge.findUnique({
    where: { id: chargeId },
    select: { id: true, status: true, billingBasis: true, xeroInvoiceId: true, emailSentAt: true },
  });
  if (!charge) throw new Error(`Membership subscription charge not found: ${chargeId}`);
  // #2147: a VOIDED charge (its Xero invoice was voided/deleted and its coverage
  // released) is terminal audit history — never re-enqueue it. This also fences
  // the RETRY_CHARGE admin action, which routes through here.
  if (
    charge.billingBasis === "NO_INVOICE" ||
    charge.status === "NOT_REQUIRED" ||
    charge.status === "VOIDED" ||
    charge.emailSentAt
  ) {
    return { queueOperationId: null, message: "No subscription invoice work is required." };
  }
  const correlationKey = buildXeroIdempotencyKey("membership-charge", chargeId, "invoice-and-email", "v1");
  const active = await prisma.xeroSyncOperation.findFirst({
    where: { correlationKey, status: { in: ["PENDING", "RUNNING", "WAITING_PAYMENT"] } },
    orderBy: { createdAt: "desc" },
    select: { id: true },
  });
  if (active) return { queueOperationId: active.id, message: "Subscription invoice is already queued." };
  const operation = await startXeroSyncOperation({
    direction: "OUTBOUND",
    entityType: "INVOICE",
    operationType: "CREATE",
    localModel: "MembershipSubscriptionCharge",
    localId: chargeId,
    status: "PENDING",
    idempotencyKey: correlationKey,
    correlationKey,
    requestPayload: { queueType: XERO_OUTBOX_SUBSCRIPTION_INVOICE_TYPE, chargeId },
    createdByMemberId: options?.createdByMemberId ?? null,
  });
  await prisma.membershipSubscriptionCharge.update({
    where: { id: chargeId },
    data: { status: charge.xeroInvoiceId ? "INVOICE_CREATED" : "QUEUED", lastErrorCode: null, lastErrorMessage: null },
  });
  return { queueOperationId: operation.id, message: "Subscription invoice queued." };
}

async function findExistingByReference(
  xero: XeroClient,
  tenantId: string,
  reference: string,
) {
  const response = await callXeroApi(
    () => xero.accountingApi.getInvoices(
      tenantId,
      undefined,
      `Reference==\"${reference}\"`,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      1,
      false,
    ),
    {
      operation: "getInvoices",
      resourceType: "INVOICE",
      workflow: "createXeroMembershipSubscriptionInvoice",
      context: `find subscription invoice ${reference}`,
    },
  );
  return response.body.invoices ?? [];
}

export async function createXeroMembershipSubscriptionInvoice(input: {
  chargeId: string;
  syncOperationId: string;
  createdByMemberId?: string;
}) {
  const charge = await prisma.membershipSubscriptionCharge.findUnique({
    where: { id: input.chargeId },
    include: {
      coverage: {
        include: {
          subscription: {
            select: { id: true, status: true, manuallyMarkedPaidAt: true },
          },
        },
      },
      components: { orderBy: [{ sortOrder: "asc" }, { id: "asc" }] },
    },
  });
  if (!charge) throw new Error(`Membership subscription charge not found: ${input.chargeId}`);
  if (charge.billingBasis === "NO_INVOICE") {
    await completeXeroSyncOperation(input.syncOperationId, { responsePayload: { skipped: true, reason: "NO_INVOICE" } });
    return null;
  }
  // #2147: skip a VOIDED charge if a stale queued op is drained after the void.
  if (charge.status === "VOIDED") {
    await completeXeroSyncOperation(input.syncOperationId, { responsePayload: { skipped: true, reason: "VOIDED" } });
    return null;
  }

  // #1944 non-clobber guard: a charge can sit QUEUED (or retry for days) while
  // a treasurer manually marks the covered subscription paid (cash outside
  // Xero). Minting an invoice then would double-bill and the coverage write
  // below would downgrade the PAID row to UNPAID. If any covered subscription
  // is already PAID before an invoice exists, stop and surface a billing
  // exception instead (same CONFLICT pattern as the adoption guards). Once an
  // invoice has been minted (charge.xeroInvoiceId set) the resume path
  // continues as before; the status-fenced updateMany below still refuses to
  // downgrade a PAID row.
  if (!charge.xeroInvoiceId) {
    const alreadyPaid = charge.coverage.filter((row) => row.subscription.status === "PAID");
    if (alreadyPaid.length > 0) {
      await prisma.membershipSubscriptionCharge.update({
        where: { id: charge.id },
        data: {
          status: "CONFLICT",
          lastErrorCode: "SUBSCRIPTION_ALREADY_PAID",
          lastErrorMessage: `Covered subscription${alreadyPaid.length === 1 ? " is" : "s are"} already PAID (${alreadyPaid.map((row) => row.memberName).join(", ")}); no Xero invoice was created. Reverse the manual payment or resolve the charge.`,
        },
      });
      await completeXeroSyncOperation(input.syncOperationId, {
        status: "SUCCEEDED",
        responsePayload: {
          conflict: "SUBSCRIPTION_ALREADY_PAID",
          subscriptionIds: alreadyPaid.map((row) => row.subscription.id),
          manuallyMarkedPaid: alreadyPaid.some((row) => Boolean(row.subscription.manuallyMarkedPaidAt)),
        },
      });
      return null;
    }
  }

  const { xero, tenantId } = await getAuthenticatedXeroClient();
  const contactId = await findOrCreateXeroContact(charge.recipientMemberId, {
    createdByMemberId: input.createdByMemberId,
  });
  const accountCode = charge.xeroAccountCode;
  if (!accountCode) {
    await prisma.membershipSubscriptionCharge.update({
      where: { id: charge.id },
      data: {
        status: "CONFLICT",
        lastErrorCode: "MISSING_MAPPING_SNAPSHOT",
        lastErrorMessage: "This charge has no immutable subscriptionIncome account mapping snapshot.",
      },
    });
    await completeXeroSyncOperation(input.syncOperationId, {
      status: "SUCCEEDED",
      responsePayload: { conflict: "MISSING_MAPPING_SNAPSHOT" },
    });
    return null;
  }

  // One invoice line per frozen component snapshot (#1932, E6), in stable order.
  //
  // THE FALLBACK IS THE ONE PLACE IN THIS FLOW THAT DERIVES TEXT AT SEND TIME.
  // Every other line reads `component.description`, a persisted column written at
  // plan time, so those stay byte-identical to what Xero holds whatever the
  // deriving code now says. This branch is taken only by a pre-backfill charge
  // carrying no component rows.
  //
  // The season follows the club's own year-end, resolved and passed because this
  // runs on the outbox worker where the cache is never seeded (#3116;
  // `season-label.ts` has the reasoning). Nothing matches on this text:
  // reconciliation finds the invoice by its immutable `Reference` and
  // `subscriptionInvoiceMatchesSnapshot` compares amount, account and item code.
  const componentLines = charge.components.length > 0
    ? charge.components.map((component) => ({
        amountCents: component.chargedAmountCents,
        accountCode: component.xeroAccountCode,
        itemCode: component.xeroItemCode,
        description: component.description,
      }))
    : [{
        amountCents: charge.chargedAmountCents,
        accountCode,
        itemCode: charge.xeroItemCode,
        description: `${charge.membershipTypeName} membership ${seasonYearsLabel(charge.seasonYear, await refreshFinancialYearConfig())} (${charge.coveredMonths} month${charge.coveredMonths === 1 ? "" : "s"})`,
      }];

  let invoiceId = charge.xeroInvoiceId;
  let invoiceNumber = charge.xeroInvoiceNumber;
  let adopted = charge.xeroInvoiceAdopted;
  let providerInvoice: Invoice | null = null;
  if (!invoiceId) {
    const existing = await findExistingByReference(xero, tenantId, charge.invoiceReference);
    if (existing.length > 1) {
      await prisma.membershipSubscriptionCharge.update({
        where: { id: charge.id },
        data: { status: "CONFLICT", lastErrorCode: "DUPLICATE_REFERENCE", lastErrorMessage: "More than one Xero invoice has this immutable subscription reference." },
      });
      await completeXeroSyncOperation(input.syncOperationId, { status: "SUCCEEDED", responsePayload: { conflict: "DUPLICATE_REFERENCE", invoiceCount: existing.length } });
      return null;
    }
    if (existing[0]) {
      if (!subscriptionInvoiceMatchesSnapshot({
        invoice: existing[0], contactId, amountCents: charge.chargedAmountCents,
        lines: componentLines.map(({ amountCents, accountCode: code, itemCode }) => ({ amountCents, accountCode: code, itemCode })),
        dueDays: charge.dueDays, reference: charge.invoiceReference,
      })) {
        await prisma.membershipSubscriptionCharge.update({
          where: { id: charge.id },
          data: { status: "CONFLICT", lastErrorCode: "PROVIDER_MISMATCH", lastErrorMessage: "The existing Xero invoice does not match the immutable charge snapshot. It was not changed." },
        });
        await completeXeroSyncOperation(input.syncOperationId, { status: "SUCCEEDED", responsePayload: { conflict: "PROVIDER_MISMATCH", invoice: existing[0] } });
        return null;
      }
      providerInvoice = existing[0];
      invoiceId = existing[0].invoiceID ?? null;
      invoiceNumber = existing[0].invoiceNumber ?? null;
      adopted = true;
    } else {
      // The subscription invoice's issue date decides its GST period and
      // financial year, so it is the CLUB's calendar day — the UTC day is still
      // yesterday for roughly the first half of every New Zealand day
      // (INV-DATE-019, #2834).
      //
      // The due date is then `dueDays` CALENDAR days later, stepped with
      // date-only arithmetic. That also keeps the interval exactly `dueDays`,
      // which `subscriptionInvoiceMatchesSnapshot` compares when it decides
      // whether a pre-existing Xero invoice may be adopted against this
      // immutable charge; adding `dueDays x 24h` to the instant instead would
      // slip an hour across a daylight-saving transition and could move the day.
      const issueDate = xeroDocumentDateForClubToday(await readClubTimeZoneOutsideRequest());
      const dueDate = formatDateOnly(
        addDaysDateOnly(parseDateOnly(issueDate), charge.dueDays),
      );
      const built: Invoice = {
        type: Invoice.TypeEnum.ACCREC,
        contact: { contactID: contactId },
        lineItems: componentLines.map((line) => ({
          quantity: 1,
          unitAmount: line.amountCents / 100,
          accountCode: line.accountCode,
          ...(line.itemCode ? { itemCode: line.itemCode } : {}),
          description: line.description,
          taxType: "OUTPUT2",
        })),
        date: issueDate,
        dueDate,
        reference: charge.invoiceReference,
        status: Invoice.StatusEnum.AUTHORISED,
        lineAmountTypes: LineAmountTypes.Inclusive,
      };
      const idempotencyKey = buildXeroIdempotencyKey("membership-charge", charge.id, "invoice", "v1");
      const response = await callXeroApi(
        () => xero.accountingApi.createInvoices(tenantId, { invoices: [built] }, undefined, undefined, idempotencyKey),
        {
          operation: "createInvoices", resourceType: "INVOICE",
          workflow: "createXeroMembershipSubscriptionInvoice",
          context: `create subscription invoice ${charge.id}`,
        },
      );
      providerInvoice = response.body.invoices?.[0] ?? null;
      invoiceId = providerInvoice?.invoiceID ?? null;
      invoiceNumber = providerInvoice?.invoiceNumber ?? null;
    }
  }
  if (!invoiceId) throw new Error("Xero did not return an invoice identifier for the subscription charge.");

  // Durably record creation/adoption before attempting Xero email. A crash or
  // email failure now resumes from this identifier and cannot mint a duplicate.
  await prisma.$transaction(async (tx) => {
    await tx.membershipSubscriptionCharge.update({
      where: { id: charge.id },
      data: {
        status: "INVOICE_CREATED",
        xeroInvoiceId: invoiceId,
        xeroInvoiceNumber: invoiceNumber,
        xeroInvoiceUrl: buildXeroInvoiceUrl(invoiceId),
        xeroInvoiceAdopted: adopted,
        invoicePersistedAt: charge.invoicePersistedAt ?? new Date(),
        lastErrorCode: null,
        lastErrorMessage: null,
      },
    });
    // #1944: never blind-downgrade a PAID subscription (e.g. manually marked
    // paid between the guard above and this transaction). Skipped rows keep
    // their PAID status and manual provenance; the invoice link is still
    // recorded on the charge and object links for the admin to reconcile.
    const downgraded = await tx.memberSubscription.updateMany({
      where: {
        id: { in: charge.coverage.map((row) => row.subscription.id) },
        status: { not: "PAID" },
      },
      data: { status: "UNPAID", xeroInvoiceId: invoiceId, xeroInvoiceNumber: invoiceNumber },
    });
    if (downgraded.count < charge.coverage.length) {
      logger.warn(
        { chargeId: charge.id, invoiceId, updated: downgraded.count, covered: charge.coverage.length },
        "Subscription invoice created but one or more covered subscriptions were already PAID and were not downgraded",
      );
    }
    // #2314: both link rows below are written inside this transaction, so they
    // cannot go through `upsertXeroObjectLink` (which runs its own canonical
    // de-duplication and would change what this transaction does). They carry
    // the organisation-agnostic invariant themselves instead — one stripped
    // value, used by every branch, as `xero-object-url-write-guard.test.ts`
    // requires of every direct writer.
    const linkUrl = stripXeroOrgShortCode(buildXeroInvoiceUrl(invoiceId));
    for (const covered of charge.coverage) {
      await tx.xeroObjectLink.upsert({
        where: {
          localModel_localId_xeroObjectType_xeroObjectId_role: {
            localModel: "MemberSubscription", localId: covered.subscription.id,
            xeroObjectType: "SUBSCRIPTION", xeroObjectId: invoiceId, role: "SUBSCRIPTION_INVOICE",
          },
        },
        update: { active: true, xeroObjectNumber: invoiceNumber, xeroObjectUrl: linkUrl, metadata: { seasonYear: charge.seasonYear } },
        create: {
          localModel: "MemberSubscription", localId: covered.subscription.id,
          xeroObjectType: "SUBSCRIPTION", xeroObjectId: invoiceId,
          xeroObjectNumber: invoiceNumber, xeroObjectUrl: linkUrl,
          role: "SUBSCRIPTION_INVOICE", metadata: { seasonYear: charge.seasonYear },
        },
      });
    }
    await tx.xeroObjectLink.upsert({
      where: {
        localModel_localId_xeroObjectType_xeroObjectId_role: {
          localModel: "MembershipSubscriptionCharge", localId: charge.id,
          xeroObjectType: "INVOICE", xeroObjectId: invoiceId, role: "SUBSCRIPTION_INVOICE",
        },
      },
      update: { active: true, xeroObjectNumber: invoiceNumber, xeroObjectUrl: linkUrl, metadata: { adopted } },
      create: {
        localModel: "MembershipSubscriptionCharge", localId: charge.id,
        xeroObjectType: "INVOICE", xeroObjectId: invoiceId, xeroObjectNumber: invoiceNumber,
        xeroObjectUrl: linkUrl, role: "SUBSCRIPTION_INVOICE", metadata: { adopted },
      },
    });
  });

  const emailIdempotencyKey = buildXeroIdempotencyKey("membership-charge", charge.id, "invoice-email", invoiceId, "v1");
  /*
    Environment-safety boundary (#3035, ENV-SAFETY 2; epic #2986).
    INV-CONFIG-004.

    THE CHARGE IS DELIBERATELY LEFT AT `INVOICE_CREATED` and its
    `emailAttemptCount` is not touched. `EMAIL_FAILED` would be a lie in both
    non-allow cases — nothing was attempted, so nothing failed — and this issue
    forbids moving business state as though a provider call had failed. It is also
    the more useful state: the admin subscription-billing panel already offers
    Retry on an `INVOICE_CREATED` charge, so once the role is declared an operator
    can re-drive it, and the per-invoice idempotency key makes that a no-op rather
    than a second email if Xero has in fact already sent it.
  */
  const emailPolicy = await resolveXeroInvoiceEmailPolicy();
  if (emailPolicy.kind === "withhold") {
    const context = { chargeId: charge.id, invoiceId };
    if (emailPolicy.error) {
      logger.error(context, emailPolicy.logMessage);
    } else {
      logger.info(context, emailPolicy.logMessage);
    }
    await completeXeroSyncOperation(input.syncOperationId, {
      status: emailPolicy.error ? "PARTIAL" : "SUCCEEDED",
      responsePayload: {
        invoice: providerInvoice, adopted, email: null,
        emailError: emailPolicy.error ? emailPolicy.error.message : null,
        // A THIRD reason distinct from a provider failure and from the club's own
        // choice: this installation is a confirmed copy.
        invoiceEmailWithheldForEnvironment: emailPolicy.suppressedForNonProduction,
      },
      xeroObjectType: "INVOICE", xeroObjectId: invoiceId, xeroObjectNumber: invoiceNumber,
      xeroObjectUrl: buildXeroInvoiceUrl(invoiceId),
    });
    return invoiceId;
  }
  try {
    const response = await sendXeroInvoiceEmail({
      clearance: emailPolicy.clearance,
      xero,
      tenantId,
      invoiceId: invoiceId!,
      idempotencyKey: emailIdempotencyKey,
      workflow: "createXeroMembershipSubscriptionInvoice",
      context: `email subscription invoice ${charge.id}`,
    });
    await prisma.membershipSubscriptionCharge.update({
      where: { id: charge.id },
      data: { status: "EMAILED", emailAttemptCount: { increment: 1 }, emailLastAttemptAt: new Date(), emailSentAt: new Date(), lastErrorCode: null, lastErrorMessage: null },
    });
    await completeXeroSyncOperation(input.syncOperationId, {
      responsePayload: { invoice: providerInvoice, adopted, email: response.body },
      xeroObjectType: "INVOICE", xeroObjectId: invoiceId, xeroObjectNumber: invoiceNumber,
      xeroObjectUrl: buildXeroInvoiceUrl(invoiceId),
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger.warn({ err: error, chargeId: charge.id, invoiceId }, "Subscription invoice persisted but Xero email failed");
    await prisma.membershipSubscriptionCharge.update({
      where: { id: charge.id },
      data: { status: "EMAIL_FAILED", emailAttemptCount: { increment: 1 }, emailLastAttemptAt: new Date(), lastErrorCode: "EMAIL_FAILED", lastErrorMessage: message },
    });
    await completeXeroSyncOperation(input.syncOperationId, {
      status: "PARTIAL", responsePayload: { invoice: providerInvoice, adopted, emailError: message },
      xeroObjectType: "INVOICE", xeroObjectId: invoiceId, xeroObjectNumber: invoiceNumber,
      xeroObjectUrl: buildXeroInvoiceUrl(invoiceId),
    });
  }
  return invoiceId;
}
