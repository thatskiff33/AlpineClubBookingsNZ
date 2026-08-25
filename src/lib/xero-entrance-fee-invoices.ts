/**
 * Membership entrance-fee invoices.
 *
 * Issues a one-off Xero invoice for the categorised entrance fee that
 * applies to a new member's age tier (`Adult`, `Family`, `Youth`,
 * `Child`). Resolves the per-category amount, account code, and item
 * code through the xero-mappings layer.
 */

import {
  Invoice,
  LineAmountTypes,
  LineItem,
  type XeroClient,
} from "xero-node";
import { prisma } from "./prisma";
import logger from "@/lib/logger";
import { notifyXeroSyncError } from "@/lib/xero-error-alert";
import { buildXeroInvoiceUrl } from "@/lib/xero-links";
import {
  completeXeroSyncOperation,
  failXeroSyncOperation,
  sanitizeForJson,
  startXeroSyncOperation,
} from "@/lib/xero-sync";
import {
  callXeroApi,
  getAuthenticatedXeroClient,
} from "./xero-api-client";
import {
  buildEntranceFeeInvoiceIdempotencyKey,
  buildEntranceFeeInvoiceMintIdempotencyKey,
  ENTRANCE_FEE_EXEMPT_MESSAGE,
  getEntranceFeeContext,
  getResolvedAccountMapping,
  type EntranceFeeContext,
} from "./xero-mappings";
import {
  findOrCreateXeroContact,
  retryXeroWriteWithContactRepair,
  type FindOrCreateXeroContactOptions,
} from "./xero-contacts";
import {
  addDaysDateOnly,
  formatDateOnly,
  formatDateOnlyForTimeZone,
  parseDateOnly,
} from "@/lib/date-only";
import { buildJoiningFeeNarration } from "./joining-fee-narration";
import { providerAmountToCents } from "@/lib/money-provider-amount";

export interface CreateXeroEntranceFeeInvoiceOptions
  extends FindOrCreateXeroContactOptions {
  syncOperationId?: string;
  precomputedEntranceFee?: EntranceFeeContext;
}

// F21 (#1886): look an entrance-fee invoice up in Xero by its stable reference
// so a replay can adopt a prior mint instead of creating a duplicate. Mirrors
// `findExistingByReference` in the subscription-invoice path.
async function findEntranceFeeInvoicesByReference(
  xero: XeroClient,
  tenantId: string,
  reference: string,
) {
  const response = await callXeroApi(
    () =>
      xero.accountingApi.getInvoices(
        tenantId,
        undefined,
        `Reference=="${reference}"`,
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
      workflow: "createXeroEntranceFeeInvoice",
      context: `find entrance fee invoice ${reference}`,
    },
  );
  return response.body.invoices ?? [];
}

// #1931 (E5) adopt-time dual-read: the joining-fee re-key deliberately flips
// the display category for two cohorts (composition-family adults FAMILY ->
// ADULT; Family-type dependents CHILD/YOUTH/INFANT -> FAMILY). The frozen Xero
// reference embeds that label, so a PRE-rename mint whose durable
// ENTRANCE_FEE_INVOICE link is missing/inactive would never be found under the
// NEW label's reference — and a replay would mint a SECOND invoice for an
// already-billed member. This recomputes the label the OLD (pre-#1931,
// age+composition-driven) classifier would have produced, byte-for-byte
// replicating the removed `determineEntranceFeeCategory`:
//   YOUTH tier -> Youth; CHILD/INFANT -> Child; ADULT -> Family when any of
//   the member's family groups has >=2 adults and >=1 dependent, else Adult.
// The caller looks the legacy-label reference up ONLY when it differs from the
// new label. New mints always carry the frozen NEW-label reference; this is a
// read-side adoption fallback, never a write-side format change.
async function deriveLegacyEntranceFeeCategoryLabel(
  memberId: string,
): Promise<string> {
  const member = await prisma.member.findUnique({
    where: { id: memberId },
    select: { ageTier: true },
  });
  if (!member) return "Adult";
  if (member.ageTier === "YOUTH") return "Youth";
  if (member.ageTier === "CHILD" || member.ageTier === "INFANT") return "Child";

  const familyMemberships = await prisma.familyGroupMember.findMany({
    where: { memberId },
    select: { familyGroupId: true },
  });
  for (const fm of familyMemberships) {
    const groupMembers = await prisma.familyGroupMember.findMany({
      where: { familyGroupId: fm.familyGroupId },
      // #2520: `select`, not `include` — an `include` projects every scalar of
      // FamilyGroupMember, which is how the retired `role` column stayed in this
      // SQL long after the last reader went (20260803030000 has since dropped
      // it). Only the member's age tier is read from these rows.
      select: { member: { select: { ageTier: true } } },
    });
    const adults = groupMembers.filter((gm) => gm.member.ageTier === "ADULT");
    const dependents = groupMembers.filter(
      (gm) =>
        gm.member.ageTier === "CHILD" ||
        gm.member.ageTier === "YOUTH" ||
        gm.member.ageTier === "INFANT",
    );
    if (adults.length >= 2 && dependents.length >= 1) return "Family";
  }
  return "Adult";
}

// Total of a Xero invoice in integer cents, or `null` when it cannot be read.
// Prefers the provider-computed `total`; falls back to summing line amounts for
// summary payloads. Mirrors the subscription path's `invoiceCents`, including
// its refusal: this figure only feeds adoption and conflict comparisons, so an
// unreadable invoice must match NOTHING. A `?? 0` default made it compare equal
// to a zero expected fee, which would have adopted an invoice nobody could read
// (#2685 review).
function entranceFeeInvoiceCents(invoice: Invoice): number | null {
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

// F21 (#1886): an invoice found by reference is adoptable only if it is this
// member's own AUTHORISED entrance-fee invoice for the expected amount. This
// closes three defects the adopt-by-reference path had:
//   - cross-member adoption: the Reference field alone is not proof of
//     ownership, so we require the invoice's contact to resolve to THIS
//     member's contact (guards against any residual reference collision);
//   - voided/deleted/draft adoption: only AUTHORISED invoices are adoptable,
//     so a VOIDED invoice never suppresses a legitimate re-issue;
//   - wrong-amount adoption: the amount must match the expected fee.
// Mirrors `subscriptionInvoiceMatchesSnapshot`.
function entranceFeeInvoiceIsAdoptable(
  invoice: Invoice,
  expected: { contactId: string; amountCents: number },
): boolean {
  return (
    invoice.status === Invoice.StatusEnum.AUTHORISED &&
    invoice.type === Invoice.TypeEnum.ACCREC &&
    invoice.contact?.contactID === expected.contactId &&
    entranceFeeInvoiceCents(invoice) === expected.amountCents
  );
}

// test seam
export function buildEntranceFeeLineItem(
  categoryLabel: string,
  amountCents: number,
  accountCode: string = "200",
  itemCode?: string | null,
  accountCodeExplicitlyConfigured: boolean = false,
  descriptionOverride?: string | null,
): LineItem {
  const lineItem: LineItem = {
    quantity: 1,
    unitAmount: amountCents / 100,
    taxType: "OUTPUT2",
  };

  const description = descriptionOverride?.trim();
  if (itemCode) {
    lineItem.itemCode = itemCode;
    if (description) {
      lineItem.description = description;
    }
  } else {
    lineItem.description = description || buildJoiningFeeNarration(categoryLabel);
  }

  if (!itemCode || accountCode !== "200" || accountCodeExplicitlyConfigured) {
    lineItem.accountCode = accountCode;
  }

  return lineItem;
}

export async function createXeroEntranceFeeInvoice(
  memberId: string,
  options?: CreateXeroEntranceFeeInvoiceOptions
): Promise<string | null> {
  const entranceFee = options?.precomputedEntranceFee ?? (await getEntranceFeeContext(memberId));
  const { category, feeMapping } = entranceFee;
  const queuedOperationId = options?.syncOperationId ?? null;

  // Organisations/schools are exempt from joining fees (owner decision,
  // 2026-07-07). The fresh tier read also covers replayed operations that
  // were queued (with a precomputed context or amount override) before the
  // member was reclassified as an organisation.
  const exemptByCurrentTier =
    (
      await prisma.member.findUnique({
        where: { id: memberId },
        select: { ageTier: true },
      })
    )?.ageTier === "NOT_APPLICABLE";
  if (entranceFee.exempt || exemptByCurrentTier) {
    if (queuedOperationId) {
      await completeXeroSyncOperation(queuedOperationId, {
        status: "SUCCEEDED",
        responsePayload: {
          skipped: true,
          reason: ENTRANCE_FEE_EXEMPT_MESSAGE,
          category,
        },
      });
    }

    return null;
  }

  if (!feeMapping.amountCents || feeMapping.amountCents <= 0) {
    if (queuedOperationId) {
      await completeXeroSyncOperation(queuedOperationId, {
        status: "SUCCEEDED",
        responsePayload: {
          skipped: true,
          reason: "No joining fee is configured for this membership type.",
          category,
        },
      });
    }

    return null;
  }

  // Narrowed non-null fee amount (the guard above returned on null/<=0). Held
  // in a local so it survives the intervening `await`s (which reset TS's
  // property narrowing) and is reused by the adopt-by-reference checks below.
  const feeAmountCents: number = feeMapping.amountCents;

  // F21 (#1886): re-check the durable ENTRANCE_FEE_INVOICE link before minting.
  // The enqueue-time guard only blocks when a link ALREADY exists, and the
  // PENDING/RUNNING correlation-key dedupe is keyed on amount + category — so a
  // second enqueue carrying a different amount override (or a reclassified
  // category) produces a fresh correlation key and a fresh Xero idempotency
  // key, slipping past both, and two operations can reach this worker before
  // either writes the link. Adopting the already-linked invoice here stops the
  // second one minting a duplicate. Mirrors the subscription/supplementary
  // guards.
  const existingLink = await prisma.xeroObjectLink.findFirst({
    where: {
      localModel: "Member",
      localId: memberId,
      xeroObjectType: "INVOICE",
      role: "ENTRANCE_FEE_INVOICE",
      active: true,
    },
    select: { xeroObjectId: true, xeroObjectNumber: true, xeroObjectUrl: true },
  });
  if (existingLink) {
    if (queuedOperationId) {
      await completeXeroSyncOperation(queuedOperationId, {
        responsePayload: {
          adopted: true,
          reason: "Joining fee invoice already linked for this member.",
          category,
        },
        xeroObjectType: "INVOICE",
        xeroObjectId: existingLink.xeroObjectId,
        xeroObjectNumber: existingLink.xeroObjectNumber,
        xeroObjectUrl: existingLink.xeroObjectUrl,
      });
    }
    return existingLink.xeroObjectId;
  }

  // Check Xero connectivity
  let xero: XeroClient | null = null;
  let tenantId: string | null = null;
  if (!queuedOperationId) {
    try {
      ({ xero, tenantId } = await getAuthenticatedXeroClient());
    } catch {
      // Xero not connected — skip silently on direct write paths.
      return null;
    }
  }

  const categoryLabel = category === "FAMILY" ? "Family" : category === "YOUTH" ? "Youth" : category === "CHILD" ? "Child" : "Adult";
  // F21 (#1886): the reference embeds the FULL member id, not a truncated
  // prefix. cuid prefixes collide for members created close in time, and an
  // 8-char slice let guard 2 adopt a DIFFERENT member's invoice by reference
  // (victim left unbilled, link cross-wired). Xero's Reference field tolerates
  // the full length, so the full id makes the reference member-unique.
  const reference = `Entrance fee (${categoryLabel}) - ${memberId}`;
  // Outbox correlation/dedupe key (amount + category scoped) — unchanged.
  const idempotencyKey = buildEntranceFeeInvoiceIdempotencyKey(
    memberId,
    category,
    feeMapping.amountCents
  );
  // Xero mint idempotency key (member scoped) — converges concurrent mints for
  // one member onto a single invoice regardless of amount/category. See
  // buildEntranceFeeInvoiceMintIdempotencyKey for the full rationale.
  const mintIdempotencyKey = buildEntranceFeeInvoiceMintIdempotencyKey(memberId);
  let operationId = queuedOperationId;

  try {
    if (!xero || !tenantId) {
      ({ xero, tenantId } = await getAuthenticatedXeroClient());
    }
    const authenticatedXero = xero;
    const authenticatedTenantId = tenantId;

    // #3036 review P1-12: reuse the client built above.
    const contactId = await findOrCreateXeroContact(memberId, {
      ...options,
      xero,
      tenantId,
    });
    const incomeMapping = await getResolvedAccountMapping("hutFeesIncome");
    const incomeCode = incomeMapping.code ?? "200";

    const lineItem = buildEntranceFeeLineItem(
      categoryLabel,
      feeMapping.amountCents,
      incomeCode,
      feeMapping.itemCode,
      incomeMapping.codeExplicitlyConfigured,
      entranceFee.description,
    );

    // The invoice's issue date decides its GST period and financial year, so it
    // is the CLUB's calendar day, never the UTC one — which is still yesterday
    // for roughly the first half of every New Zealand day (INV-DATE-019, #2834).
    //
    // The due date is then thirty CALENDAR days after that, stepped with
    // date-only arithmetic. Adding 30 x 24h to the instant instead would slip an
    // hour across a daylight-saving transition, which moves the day whenever the
    // instant sits within an hour of club midnight. Read once, outside the
    // closure: `buildInvoice` runs for the recorded `requestPayload` and again
    // per contact-repair attempt, and both must carry the same date.
    const issueDate = formatDateOnlyForTimeZone(new Date());
    const dueDate = formatDateOnly(addDaysDateOnly(parseDateOnly(issueDate), 30));

    const buildInvoice = (resolvedContactId: string): Invoice => ({
      type: Invoice.TypeEnum.ACCREC,
      contact: { contactID: resolvedContactId },
      lineItems: [lineItem],
      date: issueDate,
      dueDate,
      reference,
      status: Invoice.StatusEnum.AUTHORISED,
      lineAmountTypes: LineAmountTypes.Inclusive,
    });

    const requestPayload = { invoices: [buildInvoice(contactId)] };

    if (operationId) {
      await prisma.xeroSyncOperation.update({
        where: { id: operationId },
        data: {
          requestPayload: sanitizeForJson(requestPayload),
        },
      });
    } else {
      const operation = await startXeroSyncOperation({
        direction: "OUTBOUND",
        entityType: "INVOICE",
        operationType: "CREATE",
        localModel: "Member",
        localId: memberId,
        idempotencyKey,
        correlationKey: idempotencyKey,
        requestPayload,
        createdByMemberId: options?.createdByMemberId ?? null,
      });
      operationId = operation.id;
    }

    // F21 adopt-by-reference: a crash (or a provider-side idempotency replay)
    // between createInvoices succeeding and the completion/link write below can
    // leave a minted invoice with no durable link, so a replay would mint
    // again. Look the reference up in Xero first and adopt a prior mint instead
    // of creating a second. Mirrors the subscription-invoice path: only THIS
    // member's own AUTHORISED invoice for the expected amount is adoptable, and
    // a genuine duplicate surfaces a conflict for a human rather than being
    // silently adopted-first.
    const existingByNewReference = await findEntranceFeeInvoicesByReference(
      authenticatedXero,
      authenticatedTenantId,
      reference,
    );
    // #1931 (E5) dual-read: also look up the reference the OLD classifier
    // would have produced when its label differs (label-flipped cohorts), so a
    // pre-rename mint with a missing/inactive link is ADOPTED, not re-minted.
    // An invoice carries exactly one Reference, so the two lookups can never
    // return the same invoice twice.
    const legacyCategoryLabel =
      await deriveLegacyEntranceFeeCategoryLabel(memberId);
    const legacyReference =
      legacyCategoryLabel !== categoryLabel
        ? `Entrance fee (${legacyCategoryLabel}) - ${memberId}`
        : null;
    const existingByLegacyReference = legacyReference
      ? await findEntranceFeeInvoicesByReference(
          authenticatedXero,
          authenticatedTenantId,
          legacyReference,
        )
      : [];
    const existingByReference = [
      ...existingByNewReference,
      ...existingByLegacyReference,
    ];
    // Only this member's AUTHORISED invoices are adoption candidates. A VOIDED/
    // DELETED/DRAFT invoice is ignored (so it can never suppress a legitimate
    // re-issue), and an invoice on a different contact (a residual reference
    // collision) is never adopted.
    const adoptableCandidates = existingByReference.filter((invoice) =>
      entranceFeeInvoiceIsAdoptable(invoice, {
        contactId,
        amountCents: feeAmountCents,
      }),
    );

    // >1 adoptable invoice on this member's reference is a real duplicate that
    // needs human reconciliation. Surface a conflict and mint nothing (mirrors
    // the subscription DUPLICATE_REFERENCE path) rather than adopt-first.
    if (adoptableCandidates.length > 1) {
      // The op completes as SUCCEEDED (it genuinely succeeded at "don't
      // double-mint"), so the unbilled member is otherwise discoverable only by
      // querying responsePayload.conflict. Emit a structured ERROR log naming
      // the member/reference/conflict/invoice ids, and raise the existing
      // money-anomaly alert primitive (deduped one-per-hour, self-contained) so
      // an operator can find and reconcile the member. There is no per-member
      // charge row to flag CONFLICT (unlike the subscription path), so the log +
      // alert are the signal.
      const conflictInvoiceIds = adoptableCandidates.map(
        (invoice) => invoice.invoiceID ?? null,
      );
      logger.error(
        {
          memberId,
          category,
          reference,
          legacyReference,
          conflict: "DUPLICATE_REFERENCE",
          invoiceIds: conflictInvoiceIds,
          invoiceCount: adoptableCandidates.length,
        },
        "Multiple AUTHORISED Xero invoices share this entrance fee reference; member left unbilled, no invoice minted, manual reconciliation required",
      );
      await notifyXeroSyncError({
        errorType: "entrance-fee-duplicate-reference",
        operation: `createXeroEntranceFeeInvoice:${memberId}`,
        errorMessage: `Entrance fee for member ${memberId} was NOT billed: ${adoptableCandidates.length} AUTHORISED Xero invoices share reference "${reference}" (invoice ids ${conflictInvoiceIds.join(", ")}). No invoice was minted; manual reconciliation required.`,
      });
      await completeXeroSyncOperation(operationId!, {
        status: "SUCCEEDED",
        responsePayload: {
          conflict: "DUPLICATE_REFERENCE",
          reference,
          invoiceCount: adoptableCandidates.length,
        },
      });
      return null;
    }

    // A same-member AUTHORISED invoice whose reference matches but whose amount
    // does NOT is ambiguous (which figure is correct?). Surface a conflict
    // rather than silently adopting a wrong-amount invoice or minting a second
    // (mirrors the subscription PROVIDER_MISMATCH path). Any AUTHORISED
    // same-member same-reference invoice that failed the amount check appears
    // here; a different-contact or non-AUTHORISED match falls through to mint.
    const referenceMatchesWrongAmount = existingByReference.find(
      (invoice) =>
        invoice.status === Invoice.StatusEnum.AUTHORISED &&
        invoice.contact?.contactID === contactId &&
        entranceFeeInvoiceCents(invoice) !== feeAmountCents,
    );
    if (adoptableCandidates.length === 0 && referenceMatchesWrongAmount) {
      // Same operator-visibility rationale as the DUPLICATE_REFERENCE branch:
      // the op completes green with nothing minted, so surface the unbilled
      // member via an ERROR log and the shared money-anomaly alert primitive.
      const providerAmountCents = entranceFeeInvoiceCents(
        referenceMatchesWrongAmount,
      );
      const conflictInvoiceId = referenceMatchesWrongAmount.invoiceID ?? null;
      // `null` here means the invoice's amount could not be read at all, which
      // is a different operator story from "it says a different number" — and
      // an alert that reads "is nullc" tells nobody anything (#2685 review).
      const providerAmountLabel =
        providerAmountCents === null
          ? "an amount that could not be read"
          : `${providerAmountCents}c`;
      logger.error(
        {
          memberId,
          category,
          reference,
          legacyReference,
          conflict: "PROVIDER_MISMATCH",
          invoiceId: conflictInvoiceId,
          expectedAmountCents: feeAmountCents,
          providerAmountCents,
        },
        "Existing Xero entrance fee invoice does not match the expected amount; member left unbilled, no invoice minted, manual reconciliation required",
      );
      await notifyXeroSyncError({
        errorType: "entrance-fee-provider-mismatch",
        operation: `createXeroEntranceFeeInvoice:${memberId}`,
        errorMessage: `Entrance fee for member ${memberId} was NOT billed: existing AUTHORISED Xero invoice ${conflictInvoiceId} on reference "${reference}" is ${providerAmountLabel} but the expected fee is ${feeAmountCents}c. No invoice was minted; manual reconciliation required.`,
      });
      await completeXeroSyncOperation(operationId!, {
        status: "SUCCEEDED",
        responsePayload: {
          conflict: "PROVIDER_MISMATCH",
          reference,
          expectedAmountCents: feeAmountCents,
          invoice: referenceMatchesWrongAmount,
        },
      });
      return null;
    }

    const adoptable = adoptableCandidates[0];
    if (adoptable?.invoiceID) {
      await completeXeroSyncOperation(operationId!, {
        responsePayload: { adopted: true, invoice: adoptable },
        xeroObjectType: "INVOICE",
        xeroObjectId: adoptable.invoiceID,
        xeroObjectNumber: adoptable.invoiceNumber ?? null,
        xeroObjectUrl: buildXeroInvoiceUrl(adoptable.invoiceID),
        extraLinks: [
          {
            localModel: "Member",
            localId: memberId,
            xeroObjectType: "INVOICE",
            xeroObjectId: adoptable.invoiceID,
            xeroObjectNumber: adoptable.invoiceNumber ?? null,
            xeroObjectUrl: buildXeroInvoiceUrl(adoptable.invoiceID),
            role: "ENTRANCE_FEE_INVOICE",
            metadata: {
              category,
              feeAmountCents: feeMapping.amountCents,
              description: entranceFee.description ?? null,
              adopted: true,
            },
          },
        ],
      });

      logger.info(
        { memberId, category, invoiceId: adoptable.invoiceID },
        "Adopted existing Xero entrance fee invoice by reference",
      );

      return adoptable.invoiceID;
    }

    const response = await retryXeroWriteWithContactRepair({
      memberId,
      currentContactId: contactId,
      workflow: "createXeroEntranceFeeInvoice",
      operationId: operationId!,
      repairExistingLink: options?.repairExistingLink,
      createdByMemberId: options?.createdByMemberId,
      buildRequestPayload: (resolvedContactId) => ({
        invoices: [buildInvoice(resolvedContactId)],
      }),
      run: ({ contactId: resolvedContactId }) =>
        callXeroApi(
          () =>
            authenticatedXero.accountingApi.createInvoices(
              authenticatedTenantId,
              { invoices: [buildInvoice(resolvedContactId)] },
              undefined,
              undefined,
              mintIdempotencyKey
            ),
          {
            operation: "createInvoices",
            resourceType: "INVOICE",
            workflow: "createXeroEntranceFeeInvoice",
            context: `createInvoices(entranceFee ${memberId})`,
          }
        ),
    });

    const created = response.body.invoices?.[0];
    if (!created?.invoiceID) {
      throw new Error("Failed to create Xero entrance fee invoice");
    }

    await completeXeroSyncOperation(operationId!, {
      responsePayload: response.body,
      xeroObjectType: "INVOICE",
      xeroObjectId: created.invoiceID,
      xeroObjectNumber: created.invoiceNumber ?? null,
      xeroObjectUrl: buildXeroInvoiceUrl(created.invoiceID),
      extraLinks: [
        {
          localModel: "Member",
          localId: memberId,
          xeroObjectType: "INVOICE",
          xeroObjectId: created.invoiceID,
          xeroObjectNumber: created.invoiceNumber ?? null,
          xeroObjectUrl: buildXeroInvoiceUrl(created.invoiceID),
          role: "ENTRANCE_FEE_INVOICE",
          metadata: {
            category,
            feeAmountCents: feeMapping.amountCents,
            description: entranceFee.description ?? null,
          },
        },
      ],
    });

    logger.info(
      { memberId, category, invoiceId: created.invoiceID, feeAmountCents: feeMapping.amountCents },
      "Created Xero entrance fee invoice"
    );

    return created.invoiceID;
  } catch (error) {
    if (operationId) {
      await failXeroSyncOperation(operationId, error);
    }
    throw error;
  }
}

