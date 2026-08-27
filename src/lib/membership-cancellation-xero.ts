import { Contact, CreditNote, LineAmountTypes, type Contacts, type LineItem } from "xero-node";
import { getManagedGroupUniverse } from "@/lib/xero-member-grouping";
import { buildMembershipCancellationApprovalBlockedMessage } from "@/lib/membership-cancellation-blocker-messages";
import { loadMembershipCancellationInvoiceBlockersByMemberId } from "@/lib/membership-cancellation-invoice-blockers";
import {
  findOtherLiveMembersCoveredBySubscriptionInvoice,
  findSubscriptionInvoiceIdFromCoverage,
} from "@/lib/membership-cancellation-subscription-credit";
import {
  loadMembershipCancellationSettings,
  type MembershipCancellationXeroContactGroupSetting,
} from "@/lib/membership-cancellation-settings";
import { readClubTimeZoneOutsideRequest } from "@/lib/club-time-zone-runtime";
import { xeroDocumentDateForClubToday } from "@/lib/xero-provider-dates";
import { prisma } from "@/lib/prisma";
import {
  buildXeroIdempotencyKey,
  buildXeroPayloadHash,
  completeXeroSyncOperation,
  failXeroSyncOperation,
  sanitizeForJson,
  startXeroSyncOperation,
  upsertXeroObjectLink,
} from "@/lib/xero-sync";
import {
  buildXeroContactUrl,
  buildXeroCreditNoteUrl,
  buildXeroInvoiceUrl,
  stripXeroOrgShortCode,
} from "@/lib/xero-links";
import { sendAdminXeroSyncErrorAlert } from "@/lib/email";
import { requireContainedXeroContactForInvoiceOperation } from "@/lib/xero-contact-containment-proof";
import logger from "@/lib/logger";
import {
  callXeroApi,
  getAuthenticatedXeroClient,
  getResolvedAccountMapping,
  refreshXeroContactCachesFromContact,
} from "@/lib/xero";
import { XERO_OUTBOX_MEMBERSHIP_CANCELLATION_CREDIT_NOTE_TYPE } from "@/lib/xero-operation-outbox-payload";
import { providerAmountToCents } from "@/lib/money-provider-amount";

const MEMBERSHIP_CANCELLATION_CREDIT_ROLE = "MEMBERSHIP_CANCELLATION_CREDIT_NOTE";
const MEMBERSHIP_CANCELLATION_CREDIT_ALLOCATION_ROLE =
  "MEMBERSHIP_CANCELLATION_CREDIT_ALLOCATION";
const MEMBERSHIP_CANCELLATION_CONTACT_ROLE = "MEMBERSHIP_CANCELLATION_CONTACT";

/**
 * The per-INVOICE single-flight for the cancellation credit note (#2400 review,
 * F1). One row per subscription invoice, inserted by whichever cancellation is
 * about to credit that invoice's whole balance; the `XeroObjectLink` composite
 * unique key `(localModel, localId, xeroObjectType, xeroObjectId, role)` makes
 * the second inserter fail structurally.
 */
const MEMBERSHIP_CANCELLATION_CREDIT_INVOICE_CLAIM_ROLE =
  "MEMBERSHIP_CANCELLATION_CREDIT_INVOICE_CLAIM";
const MEMBERSHIP_CANCELLATION_CREDIT_CLAIM_LOCAL_MODEL =
  "MembershipCancellationSubscriptionInvoice";

type XeroGroupReference = {
  id: string;
  name: string | null;
};

function seasonLabel(seasonYear: number): string {
  return `${seasonYear}/${seasonYear + 1}`;
}

function centsFromAmount(value: unknown): number {
  const cents = providerAmountToCents(value);
  // An unreadable amount stays 0 and a negative one still clamps to 0: this
  // feeds an outstanding-balance figure, where "owes nothing" is the safe read.
  return cents === null ? 0 : Math.max(0, cents);
}

function getContactGroupId(group: unknown): string | null {
  if (!group || typeof group !== "object") return null;
  const record = group as Record<string, unknown>;
  const id = record.contactGroupID ?? record.contactGroupId ?? record.id;
  return typeof id === "string" && id.trim() ? id : null;
}

function getContactGroupName(group: unknown): string | null {
  if (!group || typeof group !== "object") return null;
  const record = group as Record<string, unknown>;
  const name = record.name;
  return typeof name === "string" && name.trim() ? name : null;
}

function extractActiveContactGroups(contact: Contact): XeroGroupReference[] {
  const groups = Array.isArray(contact.contactGroups) ? contact.contactGroups : [];
  return groups
    .map((group) => {
      const id = getContactGroupId(group);
      return id ? { id, name: getContactGroupName(group) } : null;
    })
    .filter((group): group is XeroGroupReference => Boolean(group));
}

function uniqueCancellationGroups(
  groups: MembershipCancellationXeroContactGroupSetting[],
): XeroGroupReference[] {
  const seen = new Set<string>();
  const result: XeroGroupReference[] = [];

  for (const group of groups) {
    if (seen.has(group.groupId)) continue;
    seen.add(group.groupId);
    result.push({ id: group.groupId, name: group.groupName });
  }

  return result;
}

function buildAllocationId(
  creditNoteId: string,
  invoiceId: string,
  amountCents: number,
) {
  return buildXeroIdempotencyKey(
    "allocation",
    creditNoteId,
    invoiceId,
    amountCents,
    "v1",
  );
}

function buildCancellationRecordLinks(params: {
  requestId: string;
  participantId: string;
  memberId: string;
  xeroObjectType: string;
  xeroObjectId: string;
  xeroObjectNumber?: string | null;
  xeroObjectUrl?: string | null;
  role: string;
  metadata?: Record<string, unknown>;
}) {
  const base = {
    xeroObjectType: params.xeroObjectType,
    xeroObjectId: params.xeroObjectId,
    xeroObjectNumber: params.xeroObjectNumber ?? null,
    xeroObjectUrl: params.xeroObjectUrl ?? null,
    role: params.role,
    metadata: params.metadata,
  };

  return [
    {
      ...base,
      localModel: "MembershipCancellationRequestParticipant",
      localId: params.participantId,
    },
    {
      ...base,
      localModel: "MembershipCancellationRequest",
      localId: params.requestId,
    },
    {
      ...base,
      localModel: "Member",
      localId: params.memberId,
    },
  ];
}

/**
 * Claim the right to credit ONE subscription invoice, exactly once, for the
 * whole app (#2400 review, F1).
 *
 * ## The race this closes
 *
 * A family of three on one $600 invoice, all leaving. The reviewer approves them
 * in a burst — which is exactly what the shared-invoice notice tells them to do
 * — and each approval fires an unawaited outbox kick, so two drains overlap. The
 * outbox's own claim is PER OPERATION, so drain A can be running the first
 * member's credit note while drain B runs the third member's. By then every
 * covered member carries `cancelledAt`, so BOTH read `sharedWith = []`, both
 * read `amountDue = 600` from Xero, and both create a $600 credit note. Xero
 * cannot dedupe them: the idempotency key is built from the SUBSCRIPTION, so the
 * two keys differ. One allocation lands and the other is rejected as an
 * over-allocation, leaving $600 of unallocated credit on the family's contact,
 * spendable against future invoices. The `amountDue <= 0` check only saves the
 * serialised interleaving, and the existing-credit-note lookup is keyed on this
 * subscription, so a racing sibling's link is invisible to it.
 *
 * ## Why a unique-key claim and not a lock
 *
 * `docs/CONCURRENCY_AND_LOCKING.md` prefers a database constraint wherever one
 * CAN carry the invariant, and points at credit restoration (#1636) as the
 * in-tree precedent: an exactly-once guarantee expressed as a unique key rather
 * than as everyone remembering to take the same advisory lock. That fits here
 * exactly, and an advisory lock does not: the side effect to serialise is a
 * sequence of Xero API calls, and `pg_advisory_xact_lock` is transaction-scoped,
 * so covering them would mean holding a transaction open across provider calls —
 * the one shape AGENTS.md's concurrency checklist forbids outright. No new lock
 * family is introduced and no existing key changes.
 *
 * `XeroObjectLink` already carries the composite unique key
 * `(localModel, localId, xeroObjectType, xeroObjectId, role)`, so a
 * `createMany({ skipDuplicates: true })` — `INSERT ... ON CONFLICT DO NOTHING` —
 * is an atomic first-writer-wins claim keyed on the invoice, with no schema
 * change and no new table. It commits BEFORE any Xero call, so nothing is held
 * open across the provider.
 *
 * ## What a lost claim does: nothing
 *
 * The loser runs no side effect at all — it completes SUCCEEDED with a skip
 * reason and returns, exactly as a lost status-guarded claim must. That is
 * conservative in the right direction: the invoice is credited once by the
 * winner, and if the winner ultimately FAILS the invoice simply keeps its
 * balance, which the #2392 archive re-check then refuses to archive over.
 *
 * A RETRY of the same subscription is not a loser: the claim records who holds
 * it, so a re-run of the same subscription's operation proceeds and Xero's own
 * idempotency key (identical across retries of one subscription) dedupes the
 * credit note itself.
 */
async function claimSubscriptionInvoiceForCancellationCredit(params: {
  invoiceId: string;
  subscriptionId: string;
  requestId: string;
  participantId: string;
  memberId: string;
}): Promise<{ held: boolean; holderSubscriptionId: string | null }> {
  const claimWhere = {
    localModel: MEMBERSHIP_CANCELLATION_CREDIT_CLAIM_LOCAL_MODEL,
    localId: params.invoiceId,
    xeroObjectType: "INVOICE",
    xeroObjectId: params.invoiceId,
    role: MEMBERSHIP_CANCELLATION_CREDIT_INVOICE_CLAIM_ROLE,
  };

  // #2314: this claim insert cannot go through `upsertXeroObjectLink` — the
  // whole point is `INSERT … ON CONFLICT DO NOTHING`, and an upsert would hand
  // the claim to the last writer instead of the first. So it carries the
  // organisation-agnostic invariant itself: `stripXeroOrgShortCode` here is
  // what `xero-object-url-write-guard.test.ts` requires of every direct writer.
  const inserted = await prisma.xeroObjectLink.createMany({
    data: [
      {
        ...claimWhere,
        xeroObjectUrl: stripXeroOrgShortCode(
          buildXeroInvoiceUrl(params.invoiceId),
        ),
        metadata: {
          subscriptionId: params.subscriptionId,
          requestId: params.requestId,
          participantId: params.participantId,
          memberId: params.memberId,
        },
      },
    ],
    skipDuplicates: true,
  });
  if (inserted.count > 0) {
    return { held: true, holderSubscriptionId: params.subscriptionId };
  }

  const existing = await prisma.xeroObjectLink.findFirst({
    where: claimWhere,
    select: { metadata: true },
  });
  const metadata =
    existing?.metadata && typeof existing.metadata === "object"
      ? (existing.metadata as Record<string, unknown>)
      : null;
  const holderSubscriptionId =
    typeof metadata?.subscriptionId === "string" ? metadata.subscriptionId : null;

  return {
    held: holderSubscriptionId === params.subscriptionId,
    holderSubscriptionId,
  };
}

/**
 * The subscription invoice a cancellation is walking away from when it credits
 * nothing AND nobody else covered by that invoice is left with the club (#2400
 * review, F3).
 *
 * The shape that motivates it: an invoice covering A, B and C where C's
 * subscription is PAID — either marked paid by hand, or already PAID when the
 * invoice was raised, in which case `createXeroMembershipSubscriptionInvoice`'s
 * `status: { not: "PAID" }` guard left C with no `xeroInvoiceId` at all and C is
 * covered only by the charge's coverage claim. A skips (C is live), B skips (C
 * is live), and C has no creditable subscription — so the invoice keeps its full
 * balance forever, having told the reviewer the last cancellation would credit
 * it in full. Nothing said so.
 *
 * Returns null when the invoice cannot be identified, or when somebody covered
 * by it is still with the club — their cancellation may yet credit it, so there
 * is nothing stranded to report.
 */
async function findStrandedSubscriptionInvoice(subscription: {
  id: string;
  memberId: string;
  xeroInvoiceId: string | null;
  xeroInvoiceNumber: string | null;
}): Promise<{ invoiceId: string; invoiceNumber: string | null } | null> {
  const invoiceId =
    subscription.xeroInvoiceId ??
    (await findSubscriptionInvoiceIdFromCoverage(subscription.id));
  if (!invoiceId) return null;

  const stillCovered = await findOtherLiveMembersCoveredBySubscriptionInvoice({
    invoiceId,
    leavingMemberId: subscription.memberId,
  });
  if (stillCovered.length > 0) return null;

  return {
    invoiceId,
    invoiceNumber: subscription.xeroInvoiceId
      ? subscription.xeroInvoiceNumber
      : null,
  };
}

export async function createXeroMembershipCancellationCreditNote(
  params: {
    subscriptionId: string;
    requestId: string;
    participantId: string;
    createdByMemberId?: string;
    syncOperationId?: string;
  },
): Promise<string | null> {
  const subscription = await prisma.memberSubscription.findUnique({
    where: { id: params.subscriptionId },
    include: {
      member: {
        select: {
          id: true,
          firstName: true,
          lastName: true,
          xeroContactId: true,
        },
      },
    },
  });

  if (!subscription) {
    throw new Error(`Member subscription not found: ${params.subscriptionId}`);
  }

  const operationId = params.syncOperationId ?? null;
  const shouldCredit =
    (subscription.status === "UNPAID" || subscription.status === "OVERDUE") &&
    Boolean(subscription.xeroInvoiceId);

  if (!shouldCredit) {
    // #2400 (review F3): this cancellation is raising nothing. If it is also the
    // LAST member the invoice covers, nobody else's cancellation will ever
    // credit it either — so the balance stands forever, and until now nothing
    // said so. Resolved before either branch below because both need it, and it
    // costs only local reads.
    const strandedInvoice = await findStrandedSubscriptionInvoice(subscription);
    const strandedInvoiceSentence = strandedInvoice
      ? ` The membership was billed on Xero invoice ${
          strandedInvoice.invoiceNumber ?? strandedInvoice.invoiceId
        }, and no other member that invoice covers is still with the club, so no cancellation will credit it automatically. Open it in Xero: if it still carries a balance, take the payment, credit it with an allocated credit note, or void it.`
      : "";
    const strandedInvoicePayload = strandedInvoice
      ? {
          sharedInvoiceLeftUncredited: {
            invoiceId: strandedInvoice.invoiceId,
            invoiceNumber: strandedInvoice.invoiceNumber,
            lastCoveredMember: true,
          },
        }
      : {};
    const strandedInvoiceLinks = strandedInvoice
      ? {
          xeroObjectType: "INVOICE",
          xeroObjectId: strandedInvoice.invoiceId,
          xeroObjectNumber: strandedInvoice.invoiceNumber,
          xeroObjectUrl: buildXeroInvoiceUrl(strandedInvoice.invoiceId),
        }
      : {};

    // Option B from the audit: paid subscriptions are not auto-refunded.
    // The booking-side refund pipeline is not yet wired into the
    // membership cancellation flow. Skipping silently for PAID would
    // leave the member's money in Stripe with no admin visibility, so
    // surface an explicit alert and a distinct skip reason whenever the
    // subscription is PAID and otherwise would have been creditable.
    if (
      subscription.status === "PAID" &&
      Boolean(subscription.xeroInvoiceId)
    ) {
      logger.warn(
        {
          subscriptionId: subscription.id,
          memberId: subscription.memberId,
          xeroInvoiceId: subscription.xeroInvoiceId,
          requestId: params.requestId,
          participantId: params.participantId,
          strandedInvoiceId: strandedInvoice?.invoiceId ?? null,
        },
        "Paid membership subscription cancelled without automatic refund",
      );
      await sendAdminXeroSyncErrorAlert({
        errorType: "membership_cancellation_paid_subscription_no_refund",
        operation: "createXeroMembershipCancellationCreditNote",
        errorMessage: `Member ${subscription.member.firstName} ${subscription.member.lastName} (${subscription.memberId}) had a PAID season subscription cancelled. No Stripe refund or Xero credit note was issued automatically; manual reconciliation required.${strandedInvoiceSentence}`,
        timestamp: new Date(),
      }).catch((err) =>
        logger.error(
          {
            err,
            subscriptionId: subscription.id,
            requestId: params.requestId,
          },
          "Failed to send admin alert for paid membership cancellation",
        ),
      );
      if (operationId) {
        await completeXeroSyncOperation(operationId, {
          responsePayload: {
            skipped: true,
            reason: "paid_subscription_no_refund",
            status: subscription.status,
            xeroInvoiceId: subscription.xeroInvoiceId,
            adminAlertSent: true,
            ...strandedInvoicePayload,
          },
          ...strandedInvoiceLinks,
        });
      }
      return null;
    }

    // Not creditable for any other reason — NOT_INVOICED, or PAID before the
    // family's invoice was even raised, which is the shape that leaves no
    // `xeroInvoiceId` behind at all. Silent until now; it is only reported when
    // an invoice is actually identified AND this member is the last one it
    // covers, so an ordinary uninvoiced cancellation still says nothing.
    if (strandedInvoice) {
      logger.warn(
        {
          subscriptionId: subscription.id,
          memberId: subscription.memberId,
          status: subscription.status,
          xeroInvoiceId: strandedInvoice.invoiceId,
          requestId: params.requestId,
          participantId: params.participantId,
        },
        "Membership cancellation credited nothing and left a shared subscription invoice with nobody covered by it",
      );
      await sendAdminXeroSyncErrorAlert({
        errorType: "membership_cancellation_shared_invoice_left_uncredited",
        operation: "createXeroMembershipCancellationCreditNote",
        errorMessage: `Member ${subscription.member.firstName} ${subscription.member.lastName} (${subscription.memberId}) was cancelled with a ${subscription.status} season subscription, so no Xero credit note was raised.${strandedInvoiceSentence}`,
        timestamp: new Date(),
      }).catch((err) =>
        logger.error(
          {
            err,
            subscriptionId: subscription.id,
            requestId: params.requestId,
          },
          "Failed to send admin alert for an uncredited shared subscription invoice",
        ),
      );
    }

    if (operationId) {
      await completeXeroSyncOperation(operationId, {
        responsePayload: {
          skipped: true,
          reason: "subscription_status_not_creditable",
          status: subscription.status,
          xeroInvoiceId: subscription.xeroInvoiceId,
          ...strandedInvoicePayload,
          ...(strandedInvoice ? { adminAlertSent: true } : {}),
        },
        ...strandedInvoiceLinks,
      });
    }
    return null;
  }

  const existingCreditLink = await prisma.xeroObjectLink.findFirst({
    where: {
      localModel: "MemberSubscription",
      localId: subscription.id,
      xeroObjectType: "CREDIT_NOTE",
      role: MEMBERSHIP_CANCELLATION_CREDIT_ROLE,
      active: true,
    },
    select: {
      xeroObjectId: true,
      xeroObjectNumber: true,
      xeroObjectUrl: true,
    },
  });

  const invoiceId = subscription.xeroInvoiceId!;

  // #2400: a family or billing group is billed with ONE invoice covering
  // everyone in it, and the credit raised below is for the invoice's WHOLE
  // remaining balance. Raising it while other covered members are staying wipes
  // their share of the bill too — revenue the club is still owed, gone silently.
  // The owner's decision is to credit in full only when the leaver is the last
  // covered member still with the club, and otherwise to raise nothing and leave
  // it to an admin to settle deliberately in Xero.
  //
  // Asked here rather than at approval, and asked again rather than trusted from
  // then: a family's composition can change between a cancellation being
  // requested, approved, and this operation draining off the outbox, and the
  // only answer safe to act on is the one true at the instant the credit note
  // would be raised. The approval gate asks the same question of the same module
  // at its own moment, which is what keeps the two in step.
  //
  // Deliberately BEFORE the Xero client is authenticated: the answer is entirely
  // local, so the skip costs no Xero call at all. It also sits AFTER the
  // existing-credit-note lookup above — once a credit note exists for this
  // cancellation the money is already credited in Xero, and finishing its
  // allocation is better than abandoning it half-done.
  //
  // Passing this gate is not on its own the right to credit: several siblings'
  // cancellations can pass it at the same moment, so the branch ends by taking a
  // durable per-invoice claim before anything is sent to Xero (#2400 review, F1).
  if (!existingCreditLink) {
    const sharedWith = await findOtherLiveMembersCoveredBySubscriptionInvoice({
      invoiceId,
      leavingMemberId: subscription.memberId,
    });
    if (sharedWith.length > 0) {
      logger.warn(
        {
          subscriptionId: subscription.id,
          memberId: subscription.memberId,
          xeroInvoiceId: invoiceId,
          requestId: params.requestId,
          participantId: params.participantId,
          sharedWithMemberIds: sharedWith.map((member) => member.memberId),
        },
        "Membership cancellation credit note skipped: the subscription invoice also covers members who are staying",
      );
      if (operationId) {
        await completeXeroSyncOperation(operationId, {
          responsePayload: {
            skipped: true,
            reason: "shared_invoice_covers_remaining_members",
            invoiceId,
            sharedWith,
          },
          xeroObjectType: "INVOICE",
          xeroObjectId: invoiceId,
          xeroObjectNumber: subscription.xeroInvoiceNumber ?? null,
          xeroObjectUrl: buildXeroInvoiceUrl(invoiceId),
        });
      }
      return null;
    }

    // Nobody else is covered, so this cancellation is about to credit the
    // invoice's WHOLE balance. Take the per-invoice claim before any Xero call:
    // a sibling's cancellation, drained concurrently, reads the same empty
    // covered set and the same amountDue and would raise a SECOND full-balance
    // credit note (#2400 review, F1 — see the helper for the full trace). A lost
    // claim runs no side effect.
    const invoiceClaim = await claimSubscriptionInvoiceForCancellationCredit({
      invoiceId,
      subscriptionId: subscription.id,
      requestId: params.requestId,
      participantId: params.participantId,
      memberId: subscription.memberId,
    });
    if (!invoiceClaim.held) {
      logger.warn(
        {
          subscriptionId: subscription.id,
          memberId: subscription.memberId,
          xeroInvoiceId: invoiceId,
          requestId: params.requestId,
          participantId: params.participantId,
          holderSubscriptionId: invoiceClaim.holderSubscriptionId,
        },
        "Membership cancellation credit note skipped: another cancellation already owns the credit for this subscription invoice",
      );
      if (operationId) {
        await completeXeroSyncOperation(operationId, {
          responsePayload: {
            skipped: true,
            reason: "invoice_credit_claimed_by_other_cancellation",
            invoiceId,
            holderSubscriptionId: invoiceClaim.holderSubscriptionId,
          },
          xeroObjectType: "INVOICE",
          xeroObjectId: invoiceId,
          xeroObjectNumber: subscription.xeroInvoiceNumber ?? null,
          xeroObjectUrl: buildXeroInvoiceUrl(invoiceId),
        });
      }
      return null;
    }
  }

  const { xero, tenantId } = await getAuthenticatedXeroClient();
  const invoiceResponse = await callXeroApi(
    () => xero.accountingApi.getInvoice(tenantId, invoiceId),
    {
      operation: "getInvoice",
      resourceType: "INVOICE",
      workflow: "createXeroMembershipCancellationCreditNote",
      context: `getInvoice(${invoiceId})`,
    },
  );
  const invoice = invoiceResponse.body.invoices?.[0];
  if (!invoice?.invoiceID) {
    throw new Error(`Xero subscription invoice not found: ${invoiceId}`);
  }

  const amountCents = centsFromAmount(invoice.amountDue ?? invoice.total);
  if (amountCents <= 0) {
    if (operationId) {
      await completeXeroSyncOperation(operationId, {
        responsePayload: {
          skipped: true,
          reason: "invoice_has_no_amount_due",
          invoiceId,
          amountDue: invoice.amountDue ?? null,
        },
        xeroObjectType: "INVOICE",
        xeroObjectId: invoiceId,
        xeroObjectNumber: invoice.invoiceNumber ?? null,
        xeroObjectUrl: buildXeroInvoiceUrl(invoiceId),
      });
    }
    return null;
  }

  const contactId = invoice.contact?.contactID ?? subscription.member.xeroContactId;
  if (!contactId) {
    throw new Error(`No Xero contact available for subscription invoice: ${invoiceId}`);
  }

  /*
    INV-CONFIG-005 (#3036 review P0-2): THE FIFTH CREDIT-NOTE CREATOR, and the
    one that does not go through `findOrCreateXeroContact`. It takes its contact
    from the invoice it is crediting, so on a copy restored from the club's live
    database the credit note below was raised against a contact nothing on this
    installation had ever proved contained — which is exactly what this issue's
    acceptance criteria forbid, and what the other four creators are safe from
    only because the funnel contains for them.

    NOT MERELY CONSISTENCY. The allocation is sized from Xero's `amountDue` read
    a moment ago; a concurrent partial payment, or an allocation that fails after
    the credit note exists, leaves the invoice still outstanding against that
    contact — and Xero then emails its reminders to whatever address the contact
    holds, from its own servers, with no API call from here.

    IT NAMES `contactId`, NOT THE MEMBER'S LINK, and the `??` twelve lines above
    is why that matters: the invoice's contact and the member's current link can
    differ, and when they do, containing the member's link proves nothing about
    the contact this credit note lands on. A member merge nulls the loser's link
    while the loser's invoices keep the loser's contact; the admin re-link route
    writes a new link while existing invoices keep the old one. Both are ordinary.
  */
  await requireContainedXeroContactForInvoiceOperation({
    resolveXeroContactId: async () => contactId,
    memberId: subscription.memberId,
    workflow: "createXeroMembershipCancellationCreditNote",
    xero,
    tenantId,
  });

  if (existingCreditLink?.xeroObjectId) {
    await allocateMembershipCancellationCreditNote({
      creditNoteId: existingCreditLink.xeroObjectId,
      invoiceId,
      amountCents,
      subscriptionId: subscription.id,
      requestId: params.requestId,
      participantId: params.participantId,
      memberId: subscription.memberId,
      createdByMemberId: params.createdByMemberId,
    });
    if (operationId) {
      await completeXeroSyncOperation(operationId, {
        responsePayload: {
          existingCreditNoteId: existingCreditLink.xeroObjectId,
          invoiceId,
          amountCents,
        },
        xeroObjectType: "CREDIT_NOTE",
        xeroObjectId: existingCreditLink.xeroObjectId,
        xeroObjectNumber: existingCreditLink.xeroObjectNumber ?? null,
        xeroObjectUrl: existingCreditLink.xeroObjectUrl ?? null,
        extraLinks: [
          {
            localModel: "MemberSubscription",
            localId: subscription.id,
            xeroObjectType: "CREDIT_NOTE",
            xeroObjectId: existingCreditLink.xeroObjectId,
            xeroObjectNumber: existingCreditLink.xeroObjectNumber ?? null,
            xeroObjectUrl: existingCreditLink.xeroObjectUrl ?? null,
            role: MEMBERSHIP_CANCELLATION_CREDIT_ROLE,
            metadata: {
              requestId: params.requestId,
              participantId: params.participantId,
              seasonYear: subscription.seasonYear,
              invoiceId,
              amountCents,
            },
          },
          ...buildCancellationRecordLinks({
            requestId: params.requestId,
            participantId: params.participantId,
            memberId: subscription.memberId,
            xeroObjectType: "CREDIT_NOTE",
            xeroObjectId: existingCreditLink.xeroObjectId,
            xeroObjectNumber: existingCreditLink.xeroObjectNumber ?? null,
            xeroObjectUrl: existingCreditLink.xeroObjectUrl ?? null,
            role: MEMBERSHIP_CANCELLATION_CREDIT_ROLE,
            metadata: {
              subscriptionId: subscription.id,
              seasonYear: subscription.seasonYear,
              invoiceId,
              amountCents,
            },
          }),
        ],
      });
    }
    return existingCreditLink.xeroObjectId;
  }

  const mapping = await getResolvedAccountMapping("membershipCancellationCredit");
  const accountCode = mapping.code ?? "203";
  const creditLineItem: LineItem = {
    description: `Membership cancellation credit for ${seasonLabel(subscription.seasonYear)} annual subscription`,
    quantity: 1,
    unitAmount: amountCents / 100,
    taxType: "OUTPUT2",
    accountCode,
  };
  if (mapping.itemCode) {
    creditLineItem.itemCode = mapping.itemCode;
  }

  // The credit note's date decides its GST period and financial year, so it is
  // the club's calendar day. This file used to truncate the clock to its UTC day
  // through a private `formatDate` helper of its own, which is still yesterday
  // for roughly the first half of every New Zealand day (INV-DATE-019, #2834).
  const cancellationCreditNoteDate = xeroDocumentDateForClubToday(await readClubTimeZoneOutsideRequest());

  const buildCreditNote = (): CreditNote => ({
    type: CreditNote.TypeEnum.ACCRECCREDIT,
    contact: { contactID: contactId },
    date: cancellationCreditNoteDate,
    lineAmountTypes: LineAmountTypes.Inclusive,
    lineItems: [creditLineItem],
    reference: `Membership Cancellation ${params.participantId.slice(0, 8)}`,
    status: CreditNote.StatusEnum.AUTHORISED,
  });

  const idempotencyKey = buildXeroIdempotencyKey(
    "member-subscription",
    subscription.id,
    "membership-cancellation-credit",
    params.participantId,
    amountCents,
    "v1",
  );
  let creditOperationId = operationId;
  const requestPayload = {
    queueType: XERO_OUTBOX_MEMBERSHIP_CANCELLATION_CREDIT_NOTE_TYPE,
    subscriptionId: subscription.id,
    creditNotes: [buildCreditNote()],
    allocation: {
      invoiceId,
      amountCents,
    },
    requestId: params.requestId,
    participantId: params.participantId,
  };

  if (creditOperationId) {
    await prisma.xeroSyncOperation.update({
      where: { id: creditOperationId },
      data: { requestPayload: sanitizeForJson(requestPayload) },
    });
  } else {
    const operation = await startXeroSyncOperation({
      direction: "OUTBOUND",
      entityType: "CREDIT_NOTE",
      operationType: "CREATE",
      localModel: "MemberSubscription",
      localId: subscription.id,
      idempotencyKey,
      correlationKey: idempotencyKey,
      requestPayload,
      createdByMemberId: params.createdByMemberId ?? null,
    });
    creditOperationId = operation.id;
  }

  try {
    const response = await callXeroApi(
      () =>
        xero.accountingApi.createCreditNotes(
          tenantId,
          { creditNotes: [buildCreditNote()] },
          undefined,
          undefined,
          idempotencyKey,
        ),
      {
        operation: "createCreditNotes",
        resourceType: "CREDIT_NOTE",
        workflow: "createXeroMembershipCancellationCreditNote",
        context: `createCreditNotes(membership cancellation ${subscription.id})`,
      },
    );
    const createdNote = response.body.creditNotes?.[0];
    if (!createdNote?.creditNoteID) {
      throw new Error("Failed to create membership cancellation Xero credit note");
    }

    const creditNoteUrl = buildXeroCreditNoteUrl(createdNote.creditNoteID);
    await upsertXeroObjectLink({
      localModel: "MemberSubscription",
      localId: subscription.id,
      xeroObjectType: "CREDIT_NOTE",
      xeroObjectId: createdNote.creditNoteID,
      xeroObjectNumber: createdNote.creditNoteNumber ?? null,
      xeroObjectUrl: creditNoteUrl,
      role: MEMBERSHIP_CANCELLATION_CREDIT_ROLE,
      metadata: {
        requestId: params.requestId,
        participantId: params.participantId,
        seasonYear: subscription.seasonYear,
        invoiceId,
        amountCents,
      },
    });

    let allocationError: unknown = null;
    try {
      await allocateMembershipCancellationCreditNote({
        creditNoteId: createdNote.creditNoteID,
        invoiceId,
        amountCents,
        subscriptionId: subscription.id,
        requestId: params.requestId,
        participantId: params.participantId,
        memberId: subscription.memberId,
        createdByMemberId: params.createdByMemberId,
      });
    } catch (error) {
      allocationError = error;
    }

    await completeXeroSyncOperation(creditOperationId!, {
      status: allocationError ? "PARTIAL" : "SUCCEEDED",
      responsePayload: {
        creditNote: response.body,
        allocationError,
        invoiceId,
        amountCents,
      },
      xeroObjectType: "CREDIT_NOTE",
      xeroObjectId: createdNote.creditNoteID,
      xeroObjectNumber: createdNote.creditNoteNumber ?? null,
      xeroObjectUrl: creditNoteUrl,
      extraLinks: [
        {
          localModel: "MemberSubscription",
          localId: subscription.id,
          xeroObjectType: "CREDIT_NOTE",
          xeroObjectId: createdNote.creditNoteID,
          xeroObjectNumber: createdNote.creditNoteNumber ?? null,
          xeroObjectUrl: creditNoteUrl,
          role: MEMBERSHIP_CANCELLATION_CREDIT_ROLE,
          metadata: {
            requestId: params.requestId,
            participantId: params.participantId,
            seasonYear: subscription.seasonYear,
            invoiceId,
            amountCents,
          },
        },
        ...buildCancellationRecordLinks({
          requestId: params.requestId,
          participantId: params.participantId,
          memberId: subscription.memberId,
          xeroObjectType: "CREDIT_NOTE",
          xeroObjectId: createdNote.creditNoteID,
          xeroObjectNumber: createdNote.creditNoteNumber ?? null,
          xeroObjectUrl: creditNoteUrl,
          role: MEMBERSHIP_CANCELLATION_CREDIT_ROLE,
          metadata: {
            subscriptionId: subscription.id,
            seasonYear: subscription.seasonYear,
            invoiceId,
            amountCents,
          },
        }),
      ],
    });

    return createdNote.creditNoteID;
  } catch (error) {
    await failXeroSyncOperation(creditOperationId!, error);
    throw error;
  }
}

async function allocateMembershipCancellationCreditNote(params: {
  creditNoteId: string;
  invoiceId: string;
  amountCents: number;
  subscriptionId: string;
  requestId: string;
  participantId: string;
  memberId: string;
  createdByMemberId?: string;
}) {
  const allocationId = buildAllocationId(
    params.creditNoteId,
    params.invoiceId,
    params.amountCents,
  );
  const existingAllocation = await prisma.xeroObjectLink.findFirst({
    where: {
      localModel: "MemberSubscription",
      localId: params.subscriptionId,
      xeroObjectType: "ALLOCATION",
      xeroObjectId: allocationId,
      role: MEMBERSHIP_CANCELLATION_CREDIT_ALLOCATION_ROLE,
      active: true,
    },
    select: { id: true },
  });
  if (existingAllocation) return;

  const { xero, tenantId } = await getAuthenticatedXeroClient();
  const idempotencyKey = buildXeroIdempotencyKey(
    "credit-note",
    params.creditNoteId,
    "membership-cancellation",
    "invoice",
    params.invoiceId,
    params.amountCents,
    "v1",
  );
  const operation = await startXeroSyncOperation({
    direction: "OUTBOUND",
    entityType: "ALLOCATION",
    operationType: "ALLOCATE",
    localModel: "MemberSubscription",
    localId: params.subscriptionId,
    idempotencyKey,
    correlationKey: idempotencyKey,
    requestPayload: {
      creditNoteId: params.creditNoteId,
      invoiceId: params.invoiceId,
      amountCents: params.amountCents,
      requestId: params.requestId,
      participantId: params.participantId,
    },
    createdByMemberId: params.createdByMemberId ?? null,
  });

  // Club calendar day, as for the credit note it settles (INV-DATE-019, #2834),
  // read ONCE outside the closure: `callXeroApi` re-invokes its callback on
  // every retry attempt, so a read inside it would send a different date on a
  // retry that crossed club midnight, under the same idempotency key.
  const allocationDate = xeroDocumentDateForClubToday(await readClubTimeZoneOutsideRequest());

  try {
    const response = await callXeroApi(
      () =>
        xero.accountingApi.createCreditNoteAllocation(
          tenantId,
          params.creditNoteId,
          {
            allocations: [
              {
                invoice: { invoiceID: params.invoiceId },
                amount: params.amountCents / 100,
                date: allocationDate,
              },
            ],
          },
          undefined,
          idempotencyKey,
        ),
      {
        operation: "createCreditNoteAllocation",
        resourceType: "ALLOCATION",
        workflow: "allocateMembershipCancellationCreditNote",
        context: `createCreditNoteAllocation(${params.creditNoteId} -> ${params.invoiceId})`,
      },
    );

    const allocationUrl = buildXeroInvoiceUrl(params.invoiceId);
    await completeXeroSyncOperation(operation.id, {
      responsePayload: response.body,
      xeroObjectType: "ALLOCATION",
      xeroObjectId: allocationId,
      xeroObjectUrl: allocationUrl,
      extraLinks: [
        {
          localModel: "MemberSubscription",
          localId: params.subscriptionId,
          xeroObjectType: "ALLOCATION",
          xeroObjectId: allocationId,
          xeroObjectUrl: allocationUrl,
          role: MEMBERSHIP_CANCELLATION_CREDIT_ALLOCATION_ROLE,
          metadata: {
            creditNoteId: params.creditNoteId,
            invoiceId: params.invoiceId,
            amountCents: params.amountCents,
            requestId: params.requestId,
            participantId: params.participantId,
          },
        },
        ...buildCancellationRecordLinks({
          requestId: params.requestId,
          participantId: params.participantId,
          memberId: params.memberId,
          xeroObjectType: "ALLOCATION",
          xeroObjectId: allocationId,
          xeroObjectUrl: allocationUrl,
          role: MEMBERSHIP_CANCELLATION_CREDIT_ALLOCATION_ROLE,
          metadata: {
            subscriptionId: params.subscriptionId,
            creditNoteId: params.creditNoteId,
            invoiceId: params.invoiceId,
            amountCents: params.amountCents,
          },
        }),
      ],
    });
  } catch (error) {
    await failXeroSyncOperation(operation.id, error);
    throw error;
  }
}

/**
 * The membership cancellation credit note must reach Xero before the member's
 * contact is archived: Xero rejects credit notes raised against an archived
 * contact. Returns true once the credit note's outbox operation has settled,
 * i.e. SUCCEEDED (note created, or deliberately skipped) or PARTIAL (note
 * created, only the allocation still outstanding), and true when no credit note
 * operation exists for the cancellation (nothing is owed).
 */
async function isMembershipCancellationCreditNoteSettled(
  participantId: string,
): Promise<boolean> {
  const creditOperation = await prisma.xeroSyncOperation.findFirst({
    where: {
      direction: "OUTBOUND",
      entityType: "CREDIT_NOTE",
      operationType: "CREATE",
      AND: [
        {
          requestPayload: {
            path: ["queueType"],
            equals: XERO_OUTBOX_MEMBERSHIP_CANCELLATION_CREDIT_NOTE_TYPE,
          },
        },
        {
          requestPayload: {
            path: ["participantId"],
            equals: participantId,
          },
        },
      ],
    },
    orderBy: { createdAt: "desc" },
    select: { status: true },
  });

  if (!creditOperation) return true;
  return (
    creditOperation.status === "SUCCEEDED" ||
    creditOperation.status === "PARTIAL"
  );
}

export async function syncXeroMembershipCancellationContact(params: {
  memberId: string;
  requestId: string;
  participantId: string;
  createdByMemberId?: string;
  syncOperationId?: string;
}) {
  const member = await prisma.member.findUnique({
    where: { id: params.memberId },
    select: {
      id: true,
      firstName: true,
      lastName: true,
      ageTier: true,
      xeroContactId: true,
    },
  });
  if (!member) {
    throw new Error(`Member not found: ${params.memberId}`);
  }

  const operationId = params.syncOperationId ?? null;
  if (!member.xeroContactId) {
    if (operationId) {
      await completeXeroSyncOperation(operationId, {
        responsePayload: {
          skipped: true,
          reason: "member_has_no_xero_contact",
          memberId: params.memberId,
        },
      });
    }
    return {
      memberId: params.memberId,
      xeroContactId: null,
      addedGroupIds: [] as string[],
      removedGroupIds: [] as string[],
      archived: false,
      skippedReason: "member_has_no_xero_contact",
    };
  }

  // Managed universe now derives from active grouping rules under the current
  // mode (E8, #1934): NONE ⇒ empty ⇒ no managed removals. The cancellation-group
  // ADDS from MembershipCancellationSettings are mode-independent and unchanged.
  const [settings, managedGroupIds] = await Promise.all([
    loadMembershipCancellationSettings(),
    getManagedGroupUniverse(),
  ]);
  const cancelledGroups = uniqueCancellationGroups(settings.xeroContactGroups);
  const { xero, tenantId } = await getAuthenticatedXeroClient();
  const contactId = member.xeroContactId;

  const contactResponse = await callXeroApi(
    () => xero.accountingApi.getContact(tenantId, contactId),
    {
      operation: "getContact",
      resourceType: "CONTACT",
      workflow: "syncXeroMembershipCancellationContact",
      context: `getContact(${contactId})`,
    },
  );
  const contact = contactResponse.body.contacts?.[0];
  if (!contact?.contactID) {
    throw new Error(`Xero contact ${contactId} was not found`);
  }

  const currentGroups = extractActiveContactGroups(contact);
  const currentGroupIds = new Set(currentGroups.map((group) => group.id));
  const removedGroupIds = currentGroups
    .filter((group) => managedGroupIds.includes(group.id))
    .map((group) => group.id);
  const groupsAfterRemoval = new Set(
    [...currentGroupIds].filter((groupId) => !removedGroupIds.includes(groupId)),
  );
  const groupsToAdd = cancelledGroups.filter(
    (group) => !groupsAfterRemoval.has(group.id) || removedGroupIds.includes(group.id),
  );
  // Decided once, from the settings read above, and re-used by the unpaid-
  // invoice re-check and the archive call below. An admin who switches archiving
  // OFF in the sub-second window between that read and those two steps does not
  // stop this run: it proceeds under the setting that was in force when it was
  // read. Accepted deliberately — the operation is idempotent, the same click a
  // moment earlier would have archived anyway, and un-archiving a contact in
  // Xero is a one-click undo — but stated rather than left to be rediscovered
  // (#2392 review).
  const shouldArchive =
    settings.xeroArchiveContactsOnCancellation &&
    contact.contactStatus !== Contact.ContactStatusEnum.ARCHIVED;
  const requestPayload = {
    memberId: member.id,
    memberName: `${member.firstName} ${member.lastName}`,
    requestId: params.requestId,
    participantId: params.participantId,
    xeroContactId: contactId,
    managedGroupIds,
    cancelledGroups,
    currentGroups,
    archiveContact: settings.xeroArchiveContactsOnCancellation,
  };
  const idempotencyKey = buildXeroIdempotencyKey(
    "membership-cancellation",
    params.participantId,
    "contact",
    buildXeroPayloadHash(requestPayload),
    "v2",
  );
  let contactOperationId = operationId;
  if (contactOperationId) {
    await prisma.xeroSyncOperation.update({
      where: { id: contactOperationId },
      data: { requestPayload: sanitizeForJson(requestPayload) },
    });
  } else {
    const operation = await startXeroSyncOperation({
      direction: "OUTBOUND",
      entityType: "CONTACT",
      operationType: "UPDATE",
      localModel: "MembershipCancellationRequestParticipant",
      localId: params.participantId,
      idempotencyKey,
      correlationKey: idempotencyKey,
      requestPayload,
      createdByMemberId: params.createdByMemberId ?? null,
    });
    contactOperationId = operation.id;
  }

  const addedGroupIds: string[] = [];
  try {
    // Do not archive the contact until the cancellation credit note has reached
    // Xero. Archiving first makes Xero reject the credit note (you cannot raise
    // a credit note against an archived contact). If the credit note has not
    // settled, fail this operation so it is retried after the credit note
    // succeeds rather than archiving prematurely.
    if (
      shouldArchive &&
      !(await isMembershipCancellationCreditNoteSettled(params.participantId))
    ) {
      throw new Error(
        `Deferring Xero contact archive for cancellation participant ${params.participantId}: the membership cancellation credit note has not been pushed to Xero yet. Archiving the contact first would block the credit note.`,
      );
    }

    // #2392 (review NEW-1): the approval-time unpaid-invoice gate is not the
    // last word, because THIS operation runs later — off the outbox, possibly
    // days later, and possibly under settings that have changed since. A
    // cancellation approved while archiving was off (no check ran) archives
    // here the moment an admin switches archiving on. So the same question is
    // asked again, live, immediately before the archive call: an archive that
    // takes a contact the accounts still need out of Xero's pickers is the
    // harm this whole feature exists to prevent, and the check is worth one
    // more Xero read at the only moment that actually matters.
    //
    // Deferring rather than skipping is deliberate, and mirrors the credit-note
    // guard above: the operation fails and is retried, so the archive happens
    // by itself once the money is settled or voided, and until then it is
    // visible as a stuck operation rather than silently abandoned.
    if (shouldArchive) {
      const invoiceBlockers =
        (
          await loadMembershipCancellationInvoiceBlockersByMemberId(
            [params.memberId],
            { fresh: true },
          )
        ).get(params.memberId) ?? [];
      if (invoiceBlockers.length > 0) {
        throw new Error(
          `Deferring Xero contact archive for cancellation participant ${params.participantId}: ${buildMembershipCancellationApprovalBlockedMessage(
            invoiceBlockers,
          )}`,
        );
      }
    }

    for (const groupId of removedGroupIds) {
      await callXeroApi(
        () => xero.accountingApi.deleteContactGroupContact(tenantId, groupId, contactId),
        {
          operation: "deleteContactGroupContact",
          resourceType: "CONTACT_GROUP",
          workflow: "syncXeroMembershipCancellationContact",
          context: `deleteContactGroupContact(${groupId}, ${contactId})`,
        },
      );
    }

    for (const group of groupsToAdd) {
      const contacts: Contacts = { contacts: [{ contactID: contactId }] };
      const addIdempotencyKey = buildXeroIdempotencyKey(
        "contact",
        contactId,
        "cancelled-contact-group-add",
        group.id,
        "v1",
      );
      await callXeroApi(
        () =>
          xero.accountingApi.createContactGroupContacts(
            tenantId,
            group.id,
            contacts,
            addIdempotencyKey,
          ),
        {
          operation: "createContactGroupContacts",
          resourceType: "CONTACT_GROUP",
          workflow: "syncXeroMembershipCancellationContact",
          context: `createContactGroupContacts(${group.id}, ${contactId})`,
        },
      );
      addedGroupIds.push(group.id);
    }

    let archived = false;
    let archiveResponseBody: unknown = null;
    if (shouldArchive) {
      const archivePayload = {
        contacts: [
          {
            contactID: contactId,
            contactStatus: Contact.ContactStatusEnum.ARCHIVED,
          },
        ],
      };
      const archiveIdempotencyKey = buildXeroIdempotencyKey(
        "contact",
        contactId,
        "membership-cancellation-archive",
        params.participantId,
        "v1",
      );
      const archiveResponse = await callXeroApi(
        () =>
          xero.accountingApi.updateContact(
            tenantId,
            contactId,
            archivePayload,
            archiveIdempotencyKey,
          ),
        {
          operation: "updateContact",
          resourceType: "CONTACT",
          workflow: "syncXeroMembershipCancellationContact",
          context: `archiveContact(${contactId})`,
        },
      );
      archiveResponseBody = archiveResponse.body;
      archived = true;
    }

    try {
      const refreshedResponse = await callXeroApi(
        () => xero.accountingApi.getContact(tenantId, contactId),
        {
          operation: "getContact",
          resourceType: "CONTACT",
          workflow: "syncXeroMembershipCancellationContact",
          context: `refreshContact(${contactId})`,
        },
      );
      const refreshedContact = refreshedResponse.body.contacts?.[0];
      if (refreshedContact) {
        await refreshXeroContactCachesFromContact(refreshedContact);
      }
    } catch {
      await refreshXeroContactCachesFromContact(contact);
    }

    await completeXeroSyncOperation(contactOperationId!, {
      responsePayload: {
        addedGroupIds,
        removedGroupIds,
        archived,
        archiveResponse: archiveResponseBody,
      },
      xeroObjectType: "CONTACT",
      xeroObjectId: contactId,
      xeroObjectUrl: buildXeroContactUrl(contactId),
      extraLinks: buildCancellationRecordLinks({
        requestId: params.requestId,
        participantId: params.participantId,
        memberId: params.memberId,
        xeroObjectType: "CONTACT",
        xeroObjectId: contactId,
        xeroObjectUrl: buildXeroContactUrl(contactId),
        role: MEMBERSHIP_CANCELLATION_CONTACT_ROLE,
        metadata: {
          addedGroupIds,
          removedGroupIds,
          archived,
        },
      }),
    });

    return {
      memberId: params.memberId,
      xeroContactId: contactId,
      addedGroupIds,
      removedGroupIds,
      archived,
      skippedReason: null,
    };
  } catch (error) {
    await failXeroSyncOperation(contactOperationId!, error);
    throw error;
  }
}
