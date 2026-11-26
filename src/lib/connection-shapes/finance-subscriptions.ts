/**
 * What each Finance officer action on member subscriptions and subscription
 * billing returns (ALP-721, `INV-MCP-006`): the one place a catalogue entry's
 * `returns` and its route's projection both read (`INV-SSOT`). Money is
 * integer cents. Contact details and Xero identifiers stay behind, as in
 * `finance-payments.ts`. Types only: nothing here reaches the database.
 */
import { connectionShapeFor } from "@/lib/connection-projection";
import type { SubscriptionBillingPreviewSummary } from "@/lib/subscription-billing-preview-summary";

/**
 * `GET /api/admin/subscriptions`: one page of the season's member
 * subscriptions and the status counts. Email addresses, the member's Xero
 * contact id, the Xero invoice id and the Xero contact group ids stay behind;
 * the invoice number and the group names are what an officer reads.
 */
export const ADMIN_SUBSCRIPTIONS_CONNECTION_SHAPE = connectionShapeFor<{
  data: Array<{
    id: string;
    memberId: string;
    seasonYear: number;
    status: string;
    xeroInvoiceNumber: string | null;
    paidAt: Date | null;
    manuallyMarkedPaidAt: Date | null;
    manualPaymentNote: string | null;
    xeroContactGroupsLoaded: boolean;
    xeroContactGroups: Array<{ id: string; name: string }>;
    member: { firstName: string; lastName: string; ageTier: string; role: string };
  }>;
  total: number;
  page: number;
  pageSize: number;
  summary: {
    total: number;
    paid: number;
    unpaid: number;
    overdue: number;
    notInvoiced: number;
    notRequired: number;
  };
  xeroContactGroupsLoaded: boolean;
}>({
  data: {
    id: true,
    memberId: true,
    seasonYear: true,
    status: true,
    xeroInvoiceNumber: true,
    paidAt: true,
    manuallyMarkedPaidAt: true,
    manualPaymentNote: true,
    xeroContactGroupsLoaded: true,
    xeroContactGroups: { name: true },
    member: { firstName: true, lastName: true, ageTier: true, role: true },
  },
  total: true,
  page: true,
  pageSize: true,
  summary: {
    total: true,
    paid: true,
    unpaid: true,
    overdue: true,
    notInvoiced: true,
    notRequired: true,
  },
  xeroContactGroupsLoaded: true,
});

type BillingPerson = { memberId: string; memberName: string };

/**
 * `GET /api/admin/subscription-billing`: the season's billing preview (what
 * confirming would invoice, and to whom), the charges already raised, the
 * open billing exceptions and the settings it ran with. Recipients' email
 * addresses, Xero invoice ids and links, idempotency keys and the exceptions'
 * raw context stay behind. `preview.confirmationToken` stays: confirming the
 * batch sends it back. `summary` comes first, so an answer cut at its length
 * limit still says what confirming would invoice in all
 * (`subscription-billing-preview-summary.ts`).
 */
const SUBSCRIPTION_BILLING_DATA_SHAPE = {
  summary: {
    entryCount: true,
    totalCents: true,
    coveredMemberCount: true,
    byMembership: { subscriptionCategoryName: true, membershipTypeName: true, entryCount: true, chargedCents: true },
    exemptCount: true,
    alreadyInvoicedCount: true,
    alreadyInvoicedFamilyCount: true,
    exceptionCount: true,
    withheldCount: true,
    warningCount: true,
    needsDecisionCount: true,
  },
  preview: {
    seasonYear: true,
    decisionDate: true,
    dueDays: true,
    totalCents: true,
    confirmationToken: true,
    entries: {
      key: true,
      membershipTypeName: true,
      subscriptionCategoryName: true,
      billingBasis: true,
      prorationRule: true,
      annualAmountCents: true,
      chargedAmountCents: true,
      coveredMonths: true,
      coverageStart: true,
      coverageEnd: true,
      familyGroupId: true,
      recipient: { id: true, name: true },
      coveredMembers: { id: true, name: true },
      components: { label: true, description: true, annualAmountCents: true, chargedAmountCents: true, prorated: true },
    },
    exceptions: { fingerprint: true, code: true, message: true, memberId: true, familyGroupId: true },
    exemptMembers: { memberId: true, memberName: true, ageTier: true, exemptBy: true, membershipTypeName: true },
    alreadyInvoiced: { memberId: true, memberName: true, xeroInvoiceNumber: true, status: true },
    alreadyInvoicedFamilies: {
      familyGroupId: true,
      holderName: true,
      xeroInvoiceNumber: true,
      status: true,
      membersCovered: true,
      holderBasisUnresolvable: true,
      operatorMarked: true,
      markerNote: true,
      markedByName: true,
      markedAt: true,
    },
    ungroupedCategoryMembers: { subscriptionCategoryName: true, members: { memberId: true, memberName: true } },
  },
  charges: {
    id: true,
    seasonYear: true,
    source: true,
    status: true,
    membershipTypeName: true,
    subscriptionCategoryName: true,
    billingBasis: true,
    annualAmountCents: true,
    chargedAmountCents: true,
    coverageStart: true,
    coverageEnd: true,
    recipientMemberId: true,
    recipientName: true,
    dueDays: true,
    xeroInvoiceNumber: true,
    emailSentAt: true,
    lastErrorCode: true,
    lastErrorMessage: true,
    confirmedAt: true,
    createdAt: true,
    coverage: { memberId: true, memberName: true, releasedAt: true, subscription: { status: true } },
  },
  exceptions: {
    id: true,
    fingerprint: true,
    seasonYear: true,
    source: true,
    status: true,
    code: true,
    message: true,
    memberId: true,
    familyGroupId: true,
    firstSeenAt: true,
    lastSeenAt: true,
  },
  xeroInvoicing: { enabled: true, awaitingXeroCount: true },
  settings: { invoiceDueDays: true, familyBillingMode: true },
} as const;

type SubscriptionBillingData = {
  summary: SubscriptionBillingPreviewSummary;
  preview: {
    seasonYear: number;
    decisionDate: string;
    dueDays: number;
    totalCents: number;
    confirmationToken: string;
    entries: Array<{
      key: string;
      membershipTypeName: string | null;
      subscriptionCategoryName?: string | null;
      billingBasis: string;
      prorationRule: string;
      annualAmountCents: number;
      chargedAmountCents: number;
      coveredMonths: number;
      coverageStart: string;
      coverageEnd: string;
      familyGroupId: string | null;
      recipient: { id: string; name: string };
      coveredMembers: Array<{ id: string; name: string }>;
      components: Array<{
        label: string;
        description: string;
        annualAmountCents: number;
        chargedAmountCents: number;
        prorated: boolean;
      }>;
    }>;
    exceptions: Array<{
      fingerprint: string;
      code: string;
      message: string;
      memberId: string | null;
      familyGroupId: string | null;
    }>;
    exemptMembers: Array<BillingPerson & { ageTier: string | null; exemptBy: string; membershipTypeName?: string }>;
    alreadyInvoiced: Array<BillingPerson & { xeroInvoiceNumber: string | null; status: string }>;
    alreadyInvoicedFamilies: Array<{
      familyGroupId: string;
      holderName: string | null;
      xeroInvoiceNumber: string | null;
      status: string | null;
      membersCovered: number;
      holderBasisUnresolvable: boolean;
      operatorMarked: boolean;
      markerNote: string | null;
      markedByName: string | null;
      markedAt: Date | null;
    }>;
    ungroupedCategoryMembers: Array<{ subscriptionCategoryName: string; members: BillingPerson[] }>;
  };
  charges: Array<{
    id: string;
    seasonYear: number;
    source: string;
    status: string;
    membershipTypeName: string | null;
    subscriptionCategoryName: string | null;
    billingBasis: string;
    annualAmountCents: number;
    chargedAmountCents: number;
    coverageStart: Date;
    coverageEnd: Date;
    recipientMemberId: string;
    recipientName: string;
    dueDays: number;
    xeroInvoiceNumber: string | null;
    emailSentAt: Date | null;
    lastErrorCode: string | null;
    lastErrorMessage: string | null;
    confirmedAt: Date | null;
    createdAt: Date;
    coverage: Array<BillingPerson & { releasedAt: Date | null; subscription: { status: string } }>;
  }>;
  exceptions: Array<{
    id: string;
    fingerprint: string;
    seasonYear: number;
    source: string;
    status: string;
    code: string;
    message: string;
    memberId: string | null;
    familyGroupId: string | null;
    firstSeenAt: Date;
    lastSeenAt: Date;
  }>;
  xeroInvoicing: { enabled: boolean; awaitingXeroCount: number };
  settings: { invoiceDueDays: number; familyBillingMode: string };
};

export const SUBSCRIPTION_BILLING_CONNECTION_SHAPE = connectionShapeFor<SubscriptionBillingData>(
  SUBSCRIPTION_BILLING_DATA_SHAPE,
);

/** `POST /api/admin/subscription-billing`, `REFRESH_PREVIEW`: the refreshed panel and how many stale exceptions closed. */
export const SUBSCRIPTION_BILLING_REFRESHED_CONNECTION_SHAPE = connectionShapeFor<
  SubscriptionBillingData & { success: boolean; message: string; reconciledCount: number }
>({
  success: true,
  message: true,
  reconciledCount: true,
  ...SUBSCRIPTION_BILLING_DATA_SHAPE,
});

/**
 * `POST /api/admin/subscription-billing`, `CONFIRM_ANNUAL_BATCH`: the charges
 * raised and the invoice work queued for each. When Xero was switched off
 * mid-confirm, `queued` is empty and `message` says so.
 */
export const SUBSCRIPTION_BILLING_ANNUAL_BATCH_CONFIRMED_CONNECTION_SHAPE = connectionShapeFor<{
  success: boolean;
  message: string;
  chargeIds: string[];
  exceptionCount: number;
  queued: Array<{ queueOperationId: string | null; message: string }>;
}>({
  success: true,
  message: true,
  chargeIds: true,
  exceptionCount: true,
  queued: { queueOperationId: true, message: true },
});

/** `POST /api/admin/subscription-billing`, `RETRY_CHARGE`: the invoice work queued, if any. */
export const SUBSCRIPTION_BILLING_CHARGE_RETRIED_CONNECTION_SHAPE = connectionShapeFor<{
  success: boolean;
  queueOperationId: string | null;
  message: string;
}>({
  success: true,
  queueOperationId: true,
  message: true,
});

/** `POST /api/admin/subscription-billing`, `CLOSE_ALREADY_PAID`: whether this call closed the charge. */
export const SUBSCRIPTION_BILLING_CHARGE_CLOSED_CONNECTION_SHAPE = connectionShapeFor<{
  success: boolean;
  closed: boolean;
  message: string;
}>({
  success: true,
  closed: true,
  message: true,
});

/** `POST /api/admin/subscription-billing`, `MARK_FAMILY_INVOICED` / `UNMARK_FAMILY_INVOICED`. */
export const SUBSCRIPTION_BILLING_FAMILY_MARKER_CONNECTION_SHAPE = connectionShapeFor<{
  success: boolean;
  message: string;
}>({
  success: true,
  message: true,
});
