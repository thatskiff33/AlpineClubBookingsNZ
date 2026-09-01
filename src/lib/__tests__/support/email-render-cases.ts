/**
 * The rendered-output corpus for every email template function (#2689).
 *
 * WHY THIS EXISTS. `src/lib/email-templates.ts` was a 5,000-line monolith that
 * #2689 split into one module per message family. Email HTML is inline-CSS and
 * order-dependent, so moving a style block between modules can change the
 * cascade a mail client applies: a structural move that reads as mechanical in
 * the diff can still change what a member sees. The owner's rule for that split
 * is that rendered output stays byte-for-byte invariant, and that ANY diff is a
 * blocking finding rather than an acceptable side effect.
 *
 * WHAT IT IS. One entry per template function per argument shape, each one
 * rendering a COMPLETE body — never a fragment, never just a function name.
 * Two shapes are generated for every function that has optional parameters:
 *   `:minimal` — required parameters only, pinning the no-optional-branch body;
 *   `:full`    — every optional parameter supplied, pinning the optional blocks
 *                and their inline styles as well.
 * A function with no optional parameters carries only `:minimal`. Helpers that
 * return data rather than HTML (money rows, credit-netting outcomes) are pinned
 * through `JSON.stringify`, so the corpus covers the exported surface uniformly.
 *
 * Values are deterministic literals — never `new Date()`, `Math.random()` or an
 * environment read — so the same case always renders the same bytes.
 * `email-render-equivalence.test.ts` hashes each body and compares it with the
 * committed pins in `email-render-pins.txt`.
 *
 * ADDING A TEMPLATE. Add its case here; the test fails if any exported render
 * function, or any registry template key, has no case.
 *
 * PLACEHOLDER VALUES AND THE SECRET SCANNER. Most values here are `<field>-<n>`,
 * which reads well in a rendered body when a pin fails. `correlationKey` is the
 * exception: it carries `"correlation-1"`, because spelling it the usual way —
 * the field name in full, then the counter — was caught by gitleaks'
 * `generic-api-key` rule at entropy 3.625 against a 3.5 floor. The identifier
 * ends in "Key" and that particular letter distribution cleared the bar.
 *
 * Measured, this is NOT a class, so do not go renaming key-ish fields:
 * `token-1`, `pin-4`, `apiKeyReference-1`, `webhookSecretLabel-1`,
 * `authorisationToken-1`, `credentialName-1`, `privateNoteKey-1`,
 * `passwordHintLabel-1` and `xeroObjectKey-1` were all scanned with this
 * repository's own config and not one of them fires. The rule is simply "if the
 * scanner flags a placeholder, shorten it", and the scanner is the check, on
 * every pull request.
 *
 * Do not lengthen this one back, and do not reach for a `.gitleaks.toml`
 * allowlist entry for a value that costs nothing to change — see that file's
 * header for why its entries are exact literals only, and why a flagged value
 * is not written down anywhere it can be found again.
 */
import {
  accountDeletionApprovedTemplate,
  accountDeletionRejectedTemplate,
  adminPasswordResetTemplate,
  emailChangeNotificationTemplate,
  emailChangeVerificationTemplate,
  emailVerificationTemplate,
  magicLinkLoginTemplate,
  memberSetupInviteTemplate,
  passwordResetTemplate,
  twoFactorCodeTemplate,
} from "@/lib/email-templates/account";
import {
  adminBookingBumpedTemplate,
  adminBookingChangeRequestTemplate,
  adminBookingRequestHoldCancelledTemplate,
  adminBookingRequestHoldExpiredTemplate,
  adminBookingRequestPendingTemplate,
  adminCapacityWarningTemplate,
  adminMinorsReviewRequiredTemplate,
  adminNewBookingTemplate,
  adminOwnerSubstitutionTemplate,
  adminPartnerShareSweptTemplate,
  adminPendingDeadlineTemplate,
  adminSchoolManualInvoiceTemplate,
  adminSplitSettlementCancelledTemplate,
  adminSplitSettlementUnpaidTemplate,
  adminWaitlistOfferTemplate,
  adminWholeLodgeManualInvoiceTemplate,
} from "@/lib/email-templates/admin-booking";
import {
  adminDuplicateCaptureRefundTemplate,
  adminLateCaptureAutoRefundTemplate,
  adminLateCaptureHandBackConflictTemplate,
  adminManualRefundTaskTemplate,
  adminManualSettlementConflictTemplate,
  adminPaymentFailureTemplate,
  adminRefundRequestTemplate,
  adminXeroRepeatedFailureTemplate,
  adminXeroSyncErrorTemplate,
} from "@/lib/email-templates/admin-finance";
import {
  adminAccountDeletionRequestedTemplate,
  adminFamilyGroupRequestTemplate,
  adminMemberArchiveRequestedTemplate,
  adminMemberDeleteApprovedTemplate,
  adminMemberDeleteRejectedTemplate,
  adminMemberDeleteRequestedTemplate,
  adminMembershipApplicationPendingTemplate,
  adminMembershipCancellationRequestTemplate,
} from "@/lib/email-templates/admin-membership";
import {
  adminDailyDigestTemplate,
  adminEmailDeliveryFailedTemplate,
  adminEmailWithheldTemplate,
  adminIssueReportTemplate,
  adminMaintenanceReportTemplate,
  websiteContactTemplate,
} from "@/lib/email-templates/admin-ops";
import {
  adminCreditSyncDriftTemplate,
  adminXeroReconciliationReportTemplate,
  type CreditSyncDriftReportEmail,
  type XeroReconciliationReportEmail,
} from "@/lib/email-templates/admin-xero-reports";
import {
  arrivalInstructionsSection,
  bookingBumpedTemplate,
  bookingCancelledTemplate,
  bookingConfirmedTemplate,
  bookingGuestsCancelledTemplate,
  bookingModifiedTemplate,
  bookingPendingTemplate,
  setupIntentFailedTemplate,
  splitGuestPortionCancelledTemplate,
} from "@/lib/email-templates/booking";
import {
  bookingPolicyExceptionApprovedTemplate,
  bookingPolicyExceptionRefusedTemplate,
  bookingReviewApprovedTemplate,
  bookingReviewRejectedTemplate,
  hostingCoverageLostTemplate,
  policyExceptionRequestExpiredTemplate,
} from "@/lib/email-templates/booking-exceptions";
import {
  appliedCreditSummaryRows,
  bookingModificationSummaryRows,
  bookingModificationTypeLabel,
  promoAdjustmentSummaryRows,
  resolvePromoAdjustmentCents,
  resolveUnpaidCreditNetting,
  settledByPaymentCents,
  unpaidCreditNoteInput,
  unpaidMoneySummaryRows,
  wholeLodgeManualInvoiceAmountCents,
} from "@/lib/booking-money-lines";
import {
  additionalPaymentReminderTemplate,
  checkinReminderTemplate,
  preArrivalReminderTemplate,
  wholeLodgeGuestNamesReminderTemplate,
} from "@/lib/email-templates/booking-reminders";
import {
  bookingRequestApprovedTemplate,
  bookingRequestDeclinedTemplate,
  bookingRequestPaymentExpiredTemplate,
  bookingRequestQuoteTemplate,
  bookingRequestVerificationTemplate,
  schoolAttendeeConfirmationTemplate,
  splitGuestPaymentLinkTemplate,
} from "@/lib/email-templates/booking-requests";
import {
  choreRosterTemplate,
  formatChoreRosterDate,
  hutLeaderAssignmentTemplate,
} from "@/lib/email-templates/chores";
import {
  bulkCommunicationTemplate,
  noticePublishedTemplate,
} from "@/lib/email-templates/communications";
import { escapeHtml } from "@/lib/email-templates/escape";
import {
  childRequestApprovedTemplate,
  childRequestRejectedTemplate,
  childRequestSubmittedTemplate,
  familyGroupInvitationTemplate,
  familyGroupInviteAcceptedTemplate,
  groupCreateApprovedTemplate,
  groupCreateRejectedTemplate,
  groupCreateRequestConfirmationTemplate,
  joinRequestConfirmationTemplate,
  partnerInviteClaimedTemplate,
  partnerInviteTemplate,
  partnerLinkConfirmedTemplate,
  partnerLinkRemovedTemplate,
  partnerLinkRequestTemplate,
} from "@/lib/email-templates/family";
import {
  familyMemberBookingAddedTemplate,
} from "@/lib/email-templates/family-booking";
import {
  groupJoinCancelledTemplate,
  groupJoinReleasedTemplate,
  groupJoinSettledTemplate,
  groupSettlementExpiredTemplate,
  groupSettlementReceiptTemplate,
} from "@/lib/email-templates/groups";
import {
  alertBox,
  button,
  formatCents,
  heading,
  infoTable,
  layout,
  multilineBlock,
  muted,
  paragraph,
  plainTextEmailTemplate,
  supportContactMuted,
  supportContactSentence,
  supportEmailLink,
} from "@/lib/email-templates/layout";
import {
  memberGuestAddedTemplate,
  memberGuestConsentAnsweredTemplate,
  memberGuestConsentExpiredTemplate,
  memberGuestConsentOutcomeTemplate,
  memberGuestConsentRequestTemplate,
  memberGuestRequestWithdrawnTemplate,
} from "@/lib/email-templates/member-guest";
import {
  ageUpInvitationTemplate,
  ageUpParentEmailHandoffTemplate,
  inductionSignOffRequestTemplate,
  memberArchiveApprovedTemplate,
  memberArchiveRejectedTemplate,
  membershipApplicationApprovedTemplate,
  membershipApplicationRejectedTemplate,
  membershipCancellationApprovedTemplate,
  membershipCancellationConfirmationTemplate,
  membershipCancellationRejectedTemplate,
  membershipCancellationSubmittedTemplate,
  membershipPaymentRecordedTemplate,
  nominationRequestTemplate,
} from "@/lib/email-templates/membership";
import {
  refundRequestApprovedTemplate,
  refundRequestDeclinedTemplate,
} from "@/lib/email-templates/refunds";
import {
  waitlistConfirmationTemplate,
  waitlistOfferExpiredTemplate,
  waitlistOfferTemplate,
  waitlistPlaceRestoredTemplate,
} from "@/lib/email-templates/waitlist";

export interface EmailRenderCase {
  /** Stable identity: `<functionName>:<argument shape>`. */
  id: string;
  /** The exported function this case renders, for the coverage assertions. */
  fn: string;
  /** Renders the complete body. Must be pure and deterministic. */
  render: () => string;
}

const FIXED_DATE = (iso: string) => new Date(iso);

/**
 * Data helpers return values, not HTML. `JSON.stringify` yields `undefined`
 * (the value) for an undefined result, which is not a body to pin — spell that
 * outcome as text so it is pinned like any other.
 */
const json = (value: unknown) => JSON.stringify(value) ?? "__UNDEFINED__";

/**
 * The Xero reconciliation report with only the fields the template always
 * reads: no issue sections, no repeated failures, no unsupported partials.
 */
const XERO_REPORT_MINIMAL: XeroReconciliationReportEmail = {
  generatedAt: FIXED_DATE("2026-03-02T21:30:00.000Z"),
  lookbackHours: 24,
  stalePendingMinutes: 45,
  summary: {
    missingMemberContactLinks: 1,
    missingPaymentInvoiceLinks: 2,
    missingPaymentRefundCreditNoteLinks: 3,
    missingSubscriptionInvoiceLinks: 4,
    mismatchedCanonicalLinks: 5,
    staleCanonicalLinks: 6,
    duplicateActiveCanonicalLinks: 7,
    overCoveredStripeRefundPayments: 2,
    stalePendingOperations: 8,
    recentFailedOperations: 9,
    recentPartialOperations: 10,
    unsupportedPartialOperations: 11,
    repeatedFailureCorrelations: 12,
    failedInboundEvents: 13,
    issueCategoryCount: 0,
    issueTotalCount: 0,
  },
  repeatedFailures: [],
  unsupportedPartials: [],
};

/**
 * The same report with every optional block populated, including one issue item
 * per severity so the severity styling is pinned as well.
 */
const XERO_REPORT_FULL: XeroReconciliationReportEmail = {
  ...XERO_REPORT_MINIMAL,
  summary: { ...XERO_REPORT_MINIMAL.summary, issueCategoryCount: 3, issueTotalCount: 3 },
  issueSections: (["critical", "warning", "info"] as const).map((severity, index) => ({
    id: `section-${severity}`,
    title: `Section ${severity}`,
    severity,
    count: index + 1,
    whatWentWrong: `What went wrong (${severity})`,
    howToFix: `How to fix (${severity})`,
    items: [
      {
        label: `Item ${severity}`,
        localModel: "Booking",
        localId: `booking-${index}`,
        localUrl: "/admin/bookings/booking-0",
        xeroObjectType: "Invoice",
        xeroObjectId: `xero-${index}`,
        xeroObjectNumber: `INV-000${index}`,
        xeroObjectUrl: "https://go.xero.example/invoice",
        operationId: `op-${index}`,
        operationStatus: "FAILED",
        operationType: "CREATE_INVOICE",
        correlationKey: `corr-${index}`,
        detail: `Detail line ${index}`,
        latestErrorMessage: `Latest error ${index}`,
        createdAt: FIXED_DATE("2026-03-01T02:15:00.000Z"),
      },
    ],
  })),
  repeatedFailures: [
    {
      correlationKey: "corr-repeat",
      failureCount: 4,
      entityType: "Payment",
      operationType: "CREATE_PAYMENT",
      localModel: "Payment",
      localId: "payment-1",
      localUrl: "/admin/payments/payment-1",
      latestErrorMessage: "Repeated failure message",
      latestOperationId: "op-repeat",
      latestOperationStatus: "FAILED",
      latestOperationCreatedAt: FIXED_DATE("2026-03-01T03:00:00.000Z"),
      xeroObjectType: "Invoice",
      xeroObjectId: "xero-repeat",
      xeroObjectNumber: "INV-9999",
      xeroObjectUrl: "https://go.xero.example/invoice-repeat",
    },
  ],
  unsupportedPartials: [
    {
      operationId: "op-partial",
      entityType: "CreditNote",
      operationType: "APPLY_CREDIT_NOTE",
      localModel: "Payment",
      localId: "payment-2",
      localUrl: "/admin/payments/payment-2",
      xeroObjectType: "CreditNote",
      xeroObjectId: "xero-partial",
      xeroObjectNumber: "CN-0001",
      xeroObjectUrl: "https://go.xero.example/credit-note",
      reason: "Partial application is not supported",
      createdAt: FIXED_DATE("2026-03-01T04:00:00.000Z"),
    },
  ],
};

/** A drift report with nothing to list — the clean-run body. */
const CREDIT_DRIFT_MINIMAL: CreditSyncDriftReportEmail = {
  generatedAt: FIXED_DATE("2026-03-02T21:30:00.000Z"),
  scannedBookings: 120,
  checkedBookings: 118,
  deferredBookings: 2,
  totalDriftCents: 0,
  drifts: [],
};

/** One drift of each kind, so every direction label is pinned. */
const CREDIT_DRIFT_FULL: CreditSyncDriftReportEmail = {
  ...CREDIT_DRIFT_MINIMAL,
  totalDriftCents: 4500,
  drifts: (["missing_in_xero", "excess_in_xero", "no_invoice"] as const).map(
    (kind, index) => ({
      kind,
      bookingId: `booking-${index}`,
      memberName: `Member ${index}`,
      invoiceId: kind === "no_invoice" ? null : `inv-${index}`,
      invoiceNumber: kind === "no_invoice" ? null : `INV-100${index}`,
      invoiceUrl: kind === "no_invoice" ? null : "https://go.xero.example/invoice",
      localCents: 5000 + index,
      xeroCents: 3000 + index,
      deltaCents: 2000,
      notes: [
        {
          creditNoteId: `cn-${index}`,
          creditNoteNumber: `CN-200${index}`,
          appliedCents: 1000 + index,
        },
      ],
    }),
  ),
};

/**
 * The four credit-netting outcomes, spelled out rather than generated: they are
 * the money shapes an unpaid confirmation can take, and each one renders
 * different rows (see `resolveUnpaidCreditNetting`).
 */
const NETTING_OUTCOMES = [
  { outcome: "none", creditCents: 0, toTransferCents: 30000 },
  { outcome: "netted", creditCents: 12000, toTransferCents: 18000 },
  { outcome: "covered", creditCents: 30000, toTransferCents: 0 },
  { outcome: "unreconciled", creditCents: 0, toTransferCents: 0 },
] as const;

const formatTestCents = (cents: number) => `$${(cents / 100).toFixed(2)}`;

/**
 * The shared primitives, pinned individually.
 *
 * Every email embeds these, so a cascade change inside one would otherwise show
 * up as 190 red templates with nothing saying which block moved. Pinned here,
 * the primitive names itself.
 */
const PRIMITIVE_CASES: EmailRenderCase[] = [
  { id: "layout:minimal", fn: "layout", render: () => layout("<p>Body</p>") },
  { id: "heading:minimal", fn: "heading", render: () => heading("A heading") },
  { id: "paragraph:minimal", fn: "paragraph", render: () => paragraph("A paragraph.") },
  {
    id: "multilineBlock:minimal",
    fn: "multilineBlock",
    render: () => multilineBlock("Line one\nLine two"),
  },
  { id: "muted:minimal", fn: "muted", render: () => muted("Muted note.") },
  {
    id: "supportEmailLink:minimal",
    fn: "supportEmailLink",
    render: () => supportEmailLink(),
  },
  {
    id: "supportContactMuted:minimal",
    fn: "supportContactMuted",
    render: () => supportContactMuted(),
  },
  {
    id: "supportContactSentence:minimal",
    fn: "supportContactSentence",
    render: () => supportContactSentence("If you have any questions, contact the club at "),
  },
  {
    id: "button:same-origin",
    fn: "button",
    render: () => button("View booking", "/bookings"),
  },
  {
    id: "button:external",
    fn: "button",
    render: () =>
      button("Open in Xero", "https://go.xero.example/invoice", { sameOrigin: false }),
  },
  {
    id: "infoTable:minimal",
    fn: "infoTable",
    render: () =>
      infoTable([
        { label: "Check-in", value: "Fri 3 Jul 2026" },
        { label: "Check-out", value: "Sun 5 Jul 2026" },
      ]),
  },
  // One case per tone: each carries its own background, border and ink.
  ...(["info", "warning", "success"] as const).map(
    (tone): EmailRenderCase => ({
      id: `alertBox:${tone}`,
      fn: "alertBox",
      render: () => alertBox(`A ${tone} message.`, tone),
    }),
  ),
  { id: "formatCents:minimal", fn: "formatCents", render: () => formatCents(123456) },
  {
    id: "arrivalInstructionsSection:minimal",
    fn: "arrivalInstructionsSection",
    render: () => arrivalInstructionsSection({ travelNote: "Turn left at the bridge." }),
  },
  {
    id: "arrivalInstructionsSection:full",
    fn: "arrivalInstructionsSection",
    render: () =>
      arrivalInstructionsSection({
        travelNote: "Turn left at the bridge.\nThen follow the track.",
        doorCode: "4821",
      }),
  },
];

/**
 * Money-branch cases the generated corpus cannot reach: every netting outcome
 * through both renderers, and the settlement methods that label the credit
 * lines on a paid confirmation.
 */
const MONEY_BRANCH_CASES: EmailRenderCase[] = [
  ...NETTING_OUTCOMES.flatMap((netting): EmailRenderCase[] => [
    {
      id: `unpaidMoneySummaryRows:outcome-${netting.outcome}`,
      fn: "unpaidMoneySummaryRows",
      render: () => json(unpaidMoneySummaryRows(30000, netting)),
    },
    {
      id: `unpaidCreditNoteInput:outcome-${netting.outcome}`,
      fn: "unpaidCreditNoteInput",
      render: () =>
        json(unpaidCreditNoteInput(30000, netting, formatTestCents)),
    },
  ]),
  ...(["card", "bank_transfer", "manual"] as const).map(
    (settlementMethod): EmailRenderCase => ({
      id: `appliedCreditSummaryRows:settled-${settlementMethod}`,
      fn: "appliedCreditSummaryRows",
      render: () =>
        json(appliedCreditSummaryRows(12000, 18000, settlementMethod)),
    }),
  ),
  {
    id: "appliedCreditSummaryRows:settled-zero",
    fn: "appliedCreditSummaryRows",
    render: () => json(appliedCreditSummaryRows(30000, 0, "card")),
  },
  {
    id: "bookingConfirmedTemplate:payment-due",
    fn: "bookingConfirmedTemplate",
    render: () =>
      bookingConfirmedTemplate(
        "Ada",
        FIXED_DATE("2026-07-04T00:00:00.000Z"),
        FIXED_DATE("2026-07-06T00:00:00.000Z"),
        3,
        30000,
        { paymentDue: { reference: "TKC-0001", invoiceEmailed: false } },
      ),
  },
  {
    id: "bookingConfirmedTemplate:outstanding-balance",
    fn: "bookingConfirmedTemplate",
    render: () =>
      bookingConfirmedTemplate(
        "Ada",
        FIXED_DATE("2026-07-04T00:00:00.000Z"),
        FIXED_DATE("2026-07-06T00:00:00.000Z"),
        3,
        30000,
        { outstandingBalance: { amountCents: 4500, payableOnline: false } },
      ),
  },
  {
    id: "bookingConfirmedTemplate:applied-credit-only",
    fn: "bookingConfirmedTemplate",
    render: () =>
      bookingConfirmedTemplate(
        "Ada",
        FIXED_DATE("2026-07-04T00:00:00.000Z"),
        FIXED_DATE("2026-07-06T00:00:00.000Z"),
        3,
        30000,
        { appliedCredit: { amountCents: 12000, settlementMethod: "manual" } },
      ),
  },
  {
    id: "bookingCancelledTemplate:refund-manual",
    fn: "bookingCancelledTemplate",
    render: () =>
      bookingCancelledTemplate(
        "Ada",
        FIXED_DATE("2026-07-04T00:00:00.000Z"),
        FIXED_DATE("2026-07-06T00:00:00.000Z"),
        12000,
        "manual",
        3000,
      ),
  },
];

/** Generated from the exported signatures; see the module docblock. */
const GENERATED_CASES: EmailRenderCase[] = [
  { id: "escapeHtml:minimal", fn: "escapeHtml", render: () =>
    escapeHtml("str-1") },
  { id: "plainTextEmailTemplate:minimal", fn: "plainTextEmailTemplate", render: () =>
    plainTextEmailTemplate("bodyText-1") },
  { id: "passwordResetTemplate:minimal", fn: "passwordResetTemplate", render: () =>
    passwordResetTemplate("resetUrl-1") },
  { id: "magicLinkLoginTemplate:minimal", fn: "magicLinkLoginTemplate", render: () =>
    magicLinkLoginTemplate("loginUrl-1") },
  { id: "adminPasswordResetTemplate:minimal", fn: "adminPasswordResetTemplate", render: () =>
    adminPasswordResetTemplate("resetUrl-1") },
  { id: "adminPasswordResetTemplate:full", fn: "adminPasswordResetTemplate", render: () =>
    adminPasswordResetTemplate("resetUrl-1", "30 minutes") },
  { id: "memberSetupInviteTemplate:minimal", fn: "memberSetupInviteTemplate", render: () =>
    memberSetupInviteTemplate("firstName-1", "resetUrl-2") },
  { id: "twoFactorCodeTemplate:minimal", fn: "twoFactorCodeTemplate", render: () =>
    twoFactorCodeTemplate({ firstName: "firstName-1", code: "code-2", expiresAt: new Date("2026-03-04T00:00:00.000Z") }) },
  { id: "resolvePromoAdjustmentCents:minimal", fn: "resolvePromoAdjustmentCents", render: () =>
    json(resolvePromoAdjustmentCents()) },
  { id: "resolvePromoAdjustmentCents:full", fn: "resolvePromoAdjustmentCents", render: () =>
    json(resolvePromoAdjustmentCents({ discountCents: 101, promoAdjustmentCents: 102 })) },
  { id: "promoAdjustmentSummaryRows:minimal", fn: "promoAdjustmentSummaryRows", render: () =>
    json(promoAdjustmentSummaryRows(101, 102)) },
  { id: "promoAdjustmentSummaryRows:full", fn: "promoAdjustmentSummaryRows", render: () =>
    json(promoAdjustmentSummaryRows(101, 102, "promoCode-3")) },
  { id: "appliedCreditSummaryRows:minimal", fn: "appliedCreditSummaryRows", render: () =>
    json(appliedCreditSummaryRows(101, 102)) },
  { id: "appliedCreditSummaryRows:full", fn: "appliedCreditSummaryRows", render: () =>
    json(appliedCreditSummaryRows(101, 102, "manual" as const)) },
  { id: "settledByPaymentCents:minimal", fn: "settledByPaymentCents", render: () =>
    json(settledByPaymentCents({ totalCents: 101, appliedCreditCents: 102, unpaid: true, outstandingCents: 103 })) },
  { id: "resolveUnpaidCreditNetting:minimal", fn: "resolveUnpaidCreditNetting", render: () =>
    json(resolveUnpaidCreditNetting({ totalCents: 101, appliedCreditCents: 102 })) },
  { id: "unpaidCreditNoteInput:minimal", fn: "unpaidCreditNoteInput", render: () =>
    json(unpaidCreditNoteInput(101, { outcome: "netted" as const, creditCents: 2500, toTransferCents: 7500 }, (cents: number) => `$${(cents / 100).toFixed(2)}`)) },
  { id: "unpaidCreditNoteInput:full", fn: "unpaidCreditNoteInput", render: () =>
    json(unpaidCreditNoteInput(101, { outcome: "covered" as const, creditCents: 10000, toTransferCents: 0 }, (cents: number) => `$${(cents / 100).toFixed(2)}`)) },
  { id: "wholeLodgeManualInvoiceAmountCents:minimal", fn: "wholeLodgeManualInvoiceAmountCents", render: () =>
    json(wholeLodgeManualInvoiceAmountCents(101, 102)) },
  { id: "unpaidMoneySummaryRows:minimal", fn: "unpaidMoneySummaryRows", render: () =>
    json(unpaidMoneySummaryRows(101, { outcome: "netted" as const, creditCents: 2500, toTransferCents: 7500 })) },
  { id: "unpaidMoneySummaryRows:full", fn: "unpaidMoneySummaryRows", render: () =>
    json(unpaidMoneySummaryRows(101, { outcome: "covered" as const, creditCents: 10000, toTransferCents: 0 })) },
  { id: "bookingConfirmedTemplate:minimal", fn: "bookingConfirmedTemplate", render: () =>
    bookingConfirmedTemplate("firstName-1", new Date("2026-03-03T00:00:00.000Z"), new Date("2026-03-04T00:00:00.000Z"), 104, 105) },
  { id: "bookingConfirmedTemplate:full", fn: "bookingConfirmedTemplate", render: () =>
    bookingConfirmedTemplate("firstName-1", new Date("2026-03-03T00:00:00.000Z"), new Date("2026-03-04T00:00:00.000Z"), 104, 105, { discountCents: 106, promoAdjustmentCents: 107, promoCode: "promoCode-8", appliedCredit: { amountCents: 12345, settlementMethod: "bank_transfer" as const }, lodgeTravelNote: "lodgeTravelNote-9", doorCode: "doorCode-10", provisionalGuests: { guestCount: 111, holdUntil: new Date("2026-03-13T00:00:00.000Z") }, paymentDue: { reference: "reference-13", invoiceEmailed: true }, outstandingBalance: { amountCents: 114, payableOnline: true } }) },
  { id: "bookingPendingTemplate:minimal", fn: "bookingPendingTemplate", render: () =>
    bookingPendingTemplate("firstName-1", new Date("2026-03-03T00:00:00.000Z"), new Date("2026-03-04T00:00:00.000Z"), 104, new Date("2026-03-06T00:00:00.000Z")) },
  { id: "bookingPolicyExceptionApprovedTemplate:minimal", fn: "bookingPolicyExceptionApprovedTemplate", render: () =>
    bookingPolicyExceptionApprovedTemplate({ firstName: "firstName-1", checkIn: new Date("2026-03-03T00:00:00.000Z"), checkOut: new Date("2026-03-04T00:00:00.000Z"), guestCount: 104, paymentNote: "paymentNote-5", adminNotesLine: "adminNotesLine-6" }) },
  { id: "bookingPolicyExceptionRefusedTemplate:minimal", fn: "bookingPolicyExceptionRefusedTemplate", render: () =>
    bookingPolicyExceptionRefusedTemplate({ firstName: "firstName-1", lodgeName: "lodgeName-2", checkIn: new Date("2026-03-04T00:00:00.000Z"), checkOut: new Date("2026-03-05T00:00:00.000Z"), reasonLine: "reasonLine-5", askDescription: "askDescription-6" }) },
  { id: "bookingBumpedTemplate:minimal", fn: "bookingBumpedTemplate", render: () =>
    bookingBumpedTemplate("firstName-1", new Date("2026-03-03T00:00:00.000Z"), new Date("2026-03-04T00:00:00.000Z"), 104, true) },
  { id: "bookingCancelledTemplate:minimal", fn: "bookingCancelledTemplate", render: () =>
    bookingCancelledTemplate("firstName-1", new Date("2026-03-03T00:00:00.000Z"), new Date("2026-03-04T00:00:00.000Z"), 104) },
  { id: "bookingCancelledTemplate:full", fn: "bookingCancelledTemplate", render: () =>
    bookingCancelledTemplate("firstName-1", new Date("2026-03-03T00:00:00.000Z"), new Date("2026-03-04T00:00:00.000Z"), 104, "credit", 105) },
  { id: "bookingGuestsCancelledTemplate:minimal", fn: "bookingGuestsCancelledTemplate", render: () =>
    bookingGuestsCancelledTemplate("firstName-1", new Date("2026-03-03T00:00:00.000Z"), new Date("2026-03-04T00:00:00.000Z")) },
  { id: "bookingReviewApprovedTemplate:minimal", fn: "bookingReviewApprovedTemplate", render: () =>
    bookingReviewApprovedTemplate("firstName-1", new Date("2026-03-03T00:00:00.000Z"), new Date("2026-03-04T00:00:00.000Z"), "adminNotes-4", "bookingId-5") },
  { id: "bookingReviewRejectedTemplate:minimal", fn: "bookingReviewRejectedTemplate", render: () =>
    bookingReviewRejectedTemplate("firstName-1", new Date("2026-03-03T00:00:00.000Z"), new Date("2026-03-04T00:00:00.000Z"), "adminNotes-4") },
  { id: "emailVerificationTemplate:minimal", fn: "emailVerificationTemplate", render: () =>
    emailVerificationTemplate("firstName-1", "verifyUrl-2", new Date("2026-03-04T00:00:00.000Z")) },
  { id: "nominationRequestTemplate:minimal", fn: "nominationRequestTemplate", render: () =>
    nominationRequestTemplate({ nominatorName: "nominatorName-1", applicantName: "applicantName-2", reviewUrl: "reviewUrl-3", familyMemberCount: 104, expiresAt: new Date("2026-03-06T00:00:00.000Z") }) },
  { id: "inductionSignOffRequestTemplate:minimal", fn: "inductionSignOffRequestTemplate", render: () =>
    inductionSignOffRequestTemplate({ signerName: "signerName-1", inducteeName: "inducteeName-2", signerRoleLabel: "signerRoleLabel-3", inductionUrl: "inductionUrl-4" }) },
  { id: "emailChangeVerificationTemplate:minimal", fn: "emailChangeVerificationTemplate", render: () =>
    emailChangeVerificationTemplate("newEmail-1", "verifyUrl-2", new Date("2026-03-04T00:00:00.000Z")) },
  { id: "emailChangeNotificationTemplate:minimal", fn: "emailChangeNotificationTemplate", render: () =>
    emailChangeNotificationTemplate("newEmail-1") },
  { id: "formatChoreRosterDate:minimal", fn: "formatChoreRosterDate", render: () =>
    formatChoreRosterDate("2026-04-16") },
  { id: "choreRosterTemplate:minimal", fn: "choreRosterTemplate", render: () =>
    choreRosterTemplate("guestName-1", "2026-04-16", [{ name: "name-3", description: "description-4" }]) },
  { id: "choreRosterTemplate:full", fn: "choreRosterTemplate", render: () =>
    choreRosterTemplate("guestName-1", "2026-04-16", [{ name: "name-3", description: "description-4" }], "choreLink-5") },
  { id: "hutLeaderAssignmentTemplate:minimal", fn: "hutLeaderAssignmentTemplate", render: () =>
    hutLeaderAssignmentTemplate({ firstName: "firstName-1", startDate: new Date("2026-03-03T00:00:00.000Z"), endDate: new Date("2026-03-04T00:00:00.000Z"), pin: "pin-4", assignmentId: "assignmentId-5" }) },
  { id: "checkinReminderTemplate:minimal", fn: "checkinReminderTemplate", render: () =>
    checkinReminderTemplate("firstName-1", new Date("2026-03-03T00:00:00.000Z"), new Date("2026-03-04T00:00:00.000Z"), [{ firstName: "firstName-4", lastName: "lastName-5" }], [{ name: "name-6", description: "description-7" }]) },
  { id: "preArrivalReminderTemplate:minimal", fn: "preArrivalReminderTemplate", render: () =>
    preArrivalReminderTemplate({ firstName: "firstName-1", checkIn: new Date("2026-03-03T00:00:00.000Z"), checkOut: new Date("2026-03-04T00:00:00.000Z"), guestCount: 104, lodgeTravelNote: "lodgeTravelNote-5" }) },
  { id: "preArrivalReminderTemplate:full", fn: "preArrivalReminderTemplate", render: () =>
    preArrivalReminderTemplate({ firstName: "firstName-1", checkIn: new Date("2026-03-03T00:00:00.000Z"), checkOut: new Date("2026-03-04T00:00:00.000Z"), guestCount: 104, expectedArrivalTime: "expectedArrivalTime-5", lodgeTravelNote: "lodgeTravelNote-6", doorCode: "doorCode-7", outstandingAdditionalAmountCents: 108, checkoutChoreNote: "checkoutChoreNote-9" }) },
  { id: "additionalPaymentReminderTemplate:minimal", fn: "additionalPaymentReminderTemplate", render: () =>
    additionalPaymentReminderTemplate({ firstName: "firstName-1", additionalAmountCents: 102, checkIn: new Date("2026-03-04T00:00:00.000Z"), checkOut: new Date("2026-03-05T00:00:00.000Z"), requestedOn: new Date("2026-03-06T00:00:00.000Z") }) },
  { id: "adminNewBookingTemplate:minimal", fn: "adminNewBookingTemplate", render: () =>
    adminNewBookingTemplate({ memberName: "memberName-1", checkIn: new Date("2026-03-03T00:00:00.000Z"), checkOut: new Date("2026-03-04T00:00:00.000Z"), guestCount: 104, totalCents: 105, status: "status-6" }) },
  { id: "adminNewBookingTemplate:full", fn: "adminNewBookingTemplate", render: () =>
    adminNewBookingTemplate({ memberName: "memberName-1", checkIn: new Date("2026-03-03T00:00:00.000Z"), checkOut: new Date("2026-03-04T00:00:00.000Z"), guestCount: 104, totalCents: 105, status: "status-6", reviewReason: "reviewReason-7", memberJustification: "memberJustification-8" }) },
  { id: "adminMinorsReviewRequiredTemplate:minimal", fn: "adminMinorsReviewRequiredTemplate", render: () =>
    adminMinorsReviewRequiredTemplate({ memberName: "memberName-1", checkIn: new Date("2026-03-03T00:00:00.000Z"), checkOut: new Date("2026-03-04T00:00:00.000Z"), guestCount: 104, reviewReason: "reviewReason-5" }) },
  { id: "adminPartnerShareSweptTemplate:minimal", fn: "adminPartnerShareSweptTemplate", render: () =>
    adminPartnerShareSweptTemplate({ memberName: "memberName-1", partnerName: "partnerName-2", reason: "reason-3", nights: [new Date("2026-03-05T00:00:00.000Z")] }) },
  { id: "adminOwnerSubstitutionTemplate:minimal", fn: "adminOwnerSubstitutionTemplate", render: () =>
    adminOwnerSubstitutionTemplate({ requestId: "requestId-1", bookingId: "bookingId-2", intendedMemberId: "intendedMemberId-3", substituteMemberId: "substituteMemberId-4", reason: "reason-5", requesterName: "requesterName-6", requesterEmail: "requesterEmail-7", checkIn: new Date("2026-03-09T00:00:00.000Z"), checkOut: new Date("2026-03-10T00:00:00.000Z") }) },
  { id: "adminOwnerSubstitutionTemplate:full", fn: "adminOwnerSubstitutionTemplate", render: () =>
    adminOwnerSubstitutionTemplate({ requestId: "requestId-1", bookingId: "bookingId-2", intendedMemberId: "intendedMemberId-3", intendedMemberName: "intendedMemberName-4", substituteMemberId: "substituteMemberId-5", substituteMemberName: "substituteMemberName-6", reason: "reason-7", requesterName: "requesterName-8", requesterEmail: "requesterEmail-9", checkIn: new Date("2026-03-11T00:00:00.000Z"), checkOut: new Date("2026-03-12T00:00:00.000Z") }) },
  { id: "adminPaymentFailureTemplate:minimal", fn: "adminPaymentFailureTemplate", render: () =>
    adminPaymentFailureTemplate({ memberName: "memberName-1", checkIn: new Date("2026-03-03T00:00:00.000Z"), checkOut: new Date("2026-03-04T00:00:00.000Z"), amountCents: 104, errorMessage: "errorMessage-5", paymentIntentId: "paymentIntentId-6" }) },
  { id: "adminDuplicateCaptureRefundTemplate:minimal", fn: "adminDuplicateCaptureRefundTemplate", render: () =>
    adminDuplicateCaptureRefundTemplate({ memberName: "memberName-1", checkIn: new Date("2026-03-03T00:00:00.000Z"), checkOut: new Date("2026-03-04T00:00:00.000Z"), amountCents: 104, paymentIntentId: "paymentIntentId-5", settledPaymentIntentId: "settledPaymentIntentId-6", operationReference: "operationReference-7", reviewUrl: "reviewUrl-8", refundFailed: true }) },
  { id: "adminDuplicateCaptureRefundTemplate:full", fn: "adminDuplicateCaptureRefundTemplate", render: () =>
    adminDuplicateCaptureRefundTemplate({ memberName: "memberName-1", checkIn: new Date("2026-03-03T00:00:00.000Z"), checkOut: new Date("2026-03-04T00:00:00.000Z"), amountCents: 104, paymentIntentId: "paymentIntentId-5", settledPaymentIntentId: "settledPaymentIntentId-6", operationReference: "operationReference-7", errorMessage: "errorMessage-8", reviewUrl: "reviewUrl-9", refundFailed: true }) },
  { id: "adminLateCaptureAutoRefundTemplate:minimal", fn: "adminLateCaptureAutoRefundTemplate", render: () =>
    adminLateCaptureAutoRefundTemplate({ memberName: "memberName-1", checkIn: new Date("2026-03-03T00:00:00.000Z"), checkOut: new Date("2026-03-04T00:00:00.000Z"), amountCents: 104, paymentIntentId: "paymentIntentId-5", bookingId: "bookingId-6", bookingDeleted: true, captureKind: "modification", reviewUrl: "reviewUrl-7" }) },
  { id: "adminLateCaptureAutoRefundTemplate:full", fn: "adminLateCaptureAutoRefundTemplate", render: () =>
    adminLateCaptureAutoRefundTemplate({ memberName: "memberName-1", checkIn: new Date("2026-03-03T00:00:00.000Z"), checkOut: new Date("2026-03-04T00:00:00.000Z"), amountCents: 104, paymentIntentId: "paymentIntentId-5", bookingId: "bookingId-6", bookingDeleted: true, captureKind: "primary", reviewUrl: "reviewUrl-7" }) },
  { id: "adminLateCaptureHandBackConflictTemplate:minimal", fn: "adminLateCaptureHandBackConflictTemplate", render: () =>
    adminLateCaptureHandBackConflictTemplate({ memberName: "memberName-1", checkIn: new Date("2026-03-03T00:00:00.000Z"), checkOut: new Date("2026-03-04T00:00:00.000Z"), amountCents: 104, paymentIntentId: "paymentIntentId-5", bookingId: "bookingId-6", bookingDeleted: true, captureKind: "modification", handBackAmountCents: 107, refundSent: true, reviewUrl: "reviewUrl-8" }) },
  { id: "adminLateCaptureHandBackConflictTemplate:full", fn: "adminLateCaptureHandBackConflictTemplate", render: () =>
    adminLateCaptureHandBackConflictTemplate({ memberName: "memberName-1", checkIn: new Date("2026-03-03T00:00:00.000Z"), checkOut: new Date("2026-03-04T00:00:00.000Z"), amountCents: 104, paymentIntentId: "paymentIntentId-5", bookingId: "bookingId-6", bookingDeleted: true, captureKind: "primary", handBackAmountCents: 107, refundSent: true, reviewUrl: "reviewUrl-8" }) },
  { id: "adminManualSettlementConflictTemplate:minimal", fn: "adminManualSettlementConflictTemplate", render: () =>
    adminManualSettlementConflictTemplate({ memberName: "memberName-1", checkIn: new Date("2026-03-03T00:00:00.000Z"), checkOut: new Date("2026-03-04T00:00:00.000Z"), amountCents: 104, bookingId: "bookingId-5", bookingStatus: "bookingStatus-6", xeroInvoiceNumber: "xeroInvoiceNumber-7", xeroInvoiceUrl: "xeroInvoiceUrl-8", reviewUrl: "reviewUrl-9" }) },
  { id: "adminManualRefundTaskTemplate:minimal", fn: "adminManualRefundTaskTemplate", render: () =>
    adminManualRefundTaskTemplate({ memberName: "memberName-1", checkIn: new Date("2026-03-03T00:00:00.000Z"), checkOut: new Date("2026-03-04T00:00:00.000Z"), refundAmountCents: 104, bookingId: "bookingId-5", reason: "reason-6", reviewUrl: "reviewUrl-7" }) },
  { id: "adminPendingDeadlineTemplate:minimal", fn: "adminPendingDeadlineTemplate", render: () =>
    adminPendingDeadlineTemplate([{ memberName: "memberName-1", checkIn: new Date("2026-03-03T00:00:00.000Z"), checkOut: new Date("2026-03-04T00:00:00.000Z"), guestCount: 104, deadline: new Date("2026-03-06T00:00:00.000Z"), hoursRemaining: 106 }]) },
  { id: "adminBookingBumpedTemplate:minimal", fn: "adminBookingBumpedTemplate", render: () =>
    adminBookingBumpedTemplate({ bumpedMemberName: "bumpedMemberName-1", checkIn: new Date("2026-03-03T00:00:00.000Z"), checkOut: new Date("2026-03-04T00:00:00.000Z"), guestCount: 104, triggeringMemberName: "triggeringMemberName-5" }) },
  { id: "adminXeroSyncErrorTemplate:minimal", fn: "adminXeroSyncErrorTemplate", render: () =>
    adminXeroSyncErrorTemplate({ errorType: "errorType-1", operation: "operation-2", errorMessage: "errorMessage-3", timestamp: new Date("2026-03-05T00:00:00.000Z") }) },
  { id: "adminXeroRepeatedFailureTemplate:minimal", fn: "adminXeroRepeatedFailureTemplate", render: () =>
    adminXeroRepeatedFailureTemplate({ correlationKey: "correlation-1", failureCount: 102, windowHours: 103, entityType: "entityType-4", operationType: "operationType-5", localModel: "localModel-6", localId: "localId-7", localUrl: "localUrl-8", xeroObjectUrl: "xeroObjectUrl-9", latestErrorMessage: "latestErrorMessage-10", timestamp: new Date("2026-03-12T00:00:00.000Z") }) },
  { id: "adminCapacityWarningTemplate:minimal", fn: "adminCapacityWarningTemplate", render: () =>
    adminCapacityWarningTemplate([{ date: new Date("2026-03-02T00:00:00.000Z"), occupiedBeds: 102, availableBeds: 103 }]) },
  { id: "adminCapacityWarningTemplate:full", fn: "adminCapacityWarningTemplate", render: () =>
    adminCapacityWarningTemplate([{ date: new Date("2026-03-02T00:00:00.000Z"), occupiedBeds: 102, availableBeds: 103 }], 12, "lodgeName-4") },
  { id: "bulkCommunicationTemplate:minimal", fn: "bulkCommunicationTemplate", render: () =>
    bulkCommunicationTemplate("subject-1", "body-2") },
  { id: "noticePublishedTemplate:minimal", fn: "noticePublishedTemplate", render: () =>
    noticePublishedTemplate("firstName-1", "noticeTitle-2", "noticeUrl-3") },
  { id: "adminDailyDigestTemplate:minimal", fn: "adminDailyDigestTemplate", render: () =>
    adminDailyDigestTemplate({ newBookings: 101, paymentFailures: 102, capacityWarnings: 103, bookingsBumped: 104, pendingDeadlines: 105, xeroErrors: 106, totalAlerts: 107 }) },
  { id: "adminXeroReconciliationReportTemplate:minimal", fn: "adminXeroReconciliationReportTemplate", render: () =>
    adminXeroReconciliationReportTemplate(XERO_REPORT_MINIMAL) },
  { id: "adminXeroReconciliationReportTemplate:full", fn: "adminXeroReconciliationReportTemplate", render: () =>
    adminXeroReconciliationReportTemplate(XERO_REPORT_FULL) },
  { id: "adminCreditSyncDriftTemplate:minimal", fn: "adminCreditSyncDriftTemplate", render: () =>
    adminCreditSyncDriftTemplate(CREDIT_DRIFT_MINIMAL) },
  { id: "adminCreditSyncDriftTemplate:full", fn: "adminCreditSyncDriftTemplate", render: () =>
    adminCreditSyncDriftTemplate(CREDIT_DRIFT_FULL) },
  { id: "bookingModificationSummaryRows:minimal", fn: "bookingModificationSummaryRows", render: () =>
    json(bookingModificationSummaryRows({ oldCheckIn: new Date("2026-03-02T00:00:00.000Z"), oldCheckOut: new Date("2026-03-03T00:00:00.000Z"), newCheckIn: new Date("2026-03-04T00:00:00.000Z"), newCheckOut: new Date("2026-03-05T00:00:00.000Z"), oldGuestCount: 105, newGuestCount: 106, oldFinalPriceCents: 107, newFinalPriceCents: 108, changeFeeCents: 109 })) },
  { id: "bookingModificationSummaryRows:full", fn: "bookingModificationSummaryRows", render: () =>
    json(bookingModificationSummaryRows({ oldCheckIn: new Date("2026-03-02T00:00:00.000Z"), oldCheckOut: new Date("2026-03-03T00:00:00.000Z"), newCheckIn: new Date("2026-03-04T00:00:00.000Z"), newCheckOut: new Date("2026-03-05T00:00:00.000Z"), oldGuestCount: 105, newGuestCount: 106, oldFinalPriceCents: 107, newFinalPriceCents: 108, changeFeeCents: 109, promoCoverageNote: "promoCoverageNote-10" })) },
  { id: "bookingModificationTypeLabel:minimal", fn: "bookingModificationTypeLabel", render: () =>
    bookingModificationTypeLabel("modificationType-1") },
  { id: "bookingModifiedTemplate:minimal", fn: "bookingModifiedTemplate", render: () =>
    bookingModifiedTemplate({ firstName: "firstName-1", modificationType: "modificationType-2", oldCheckIn: new Date("2026-03-04T00:00:00.000Z"), oldCheckOut: new Date("2026-03-05T00:00:00.000Z"), newCheckIn: new Date("2026-03-06T00:00:00.000Z"), newCheckOut: new Date("2026-03-07T00:00:00.000Z"), oldGuestCount: 107, newGuestCount: 108, oldFinalPriceCents: 109, newFinalPriceCents: 110, changeFeeCents: 111, refundAmountCents: 112, additionalAmountCents: 113, financialReviewPending: false }) },
  { id: "bookingModifiedTemplate:full", fn: "bookingModifiedTemplate", render: () =>
    bookingModifiedTemplate({ firstName: "firstName-1", modificationType: "modificationType-2", oldCheckIn: new Date("2026-03-04T00:00:00.000Z"), oldCheckOut: new Date("2026-03-05T00:00:00.000Z"), newCheckIn: new Date("2026-03-06T00:00:00.000Z"), newCheckOut: new Date("2026-03-07T00:00:00.000Z"), oldGuestCount: 107, newGuestCount: 108, oldFinalPriceCents: 109, newFinalPriceCents: 110, changeFeeCents: 111, refundAmountCents: 112, accountCreditAmountCents: 113, additionalAmountCents: 114, additionalPaymentMethod: "INTERNET_BANKING", paymentReference: "paymentReference-15", xeroInvoiceNumber: "xeroInvoiceNumber-16", promoCoverageNote: "promoCoverageNote-17", financialReviewPending: false }) },
  /*
    #3032: the review note is a rendered shape of its own, so it gets its own
    pin rather than riding on `:full`. Deliberately COMPOSED - review pending
    AND a positive internet-banking amount with its invoice and reference -
    because that is the combination #3033's review found the email getting
    wrong, and the one a member pays for if it silently regresses. `:minimal`
    and `:full` keep `false`, so their pins are byte-identical to before.
  */
  { id: "bookingModifiedTemplate:financialReviewPendingWithPayment", fn: "bookingModifiedTemplate", render: () =>
    bookingModifiedTemplate({ firstName: "firstName-1", modificationType: "modificationType-2", oldCheckIn: new Date("2026-03-04T00:00:00.000Z"), oldCheckOut: new Date("2026-03-05T00:00:00.000Z"), newCheckIn: new Date("2026-03-06T00:00:00.000Z"), newCheckOut: new Date("2026-03-07T00:00:00.000Z"), oldGuestCount: 107, newGuestCount: 108, oldFinalPriceCents: 109, newFinalPriceCents: 110, changeFeeCents: 111, refundAmountCents: 0, accountCreditAmountCents: 0, additionalAmountCents: 114, additionalPaymentMethod: "INTERNET_BANKING", paymentReference: "paymentReference-15", xeroInvoiceNumber: "xeroInvoiceNumber-16", promoCoverageNote: "promoCoverageNote-17", financialReviewPending: true }) },
  { id: "accountDeletionApprovedTemplate:minimal", fn: "accountDeletionApprovedTemplate", render: () =>
    accountDeletionApprovedTemplate("firstName-1") },
  { id: "familyGroupInvitationTemplate:minimal", fn: "familyGroupInvitationTemplate", render: () =>
    familyGroupInvitationTemplate("inviterName-1", "groupName-2", "profileUrl-3") },
  { id: "familyGroupInviteAcceptedTemplate:minimal", fn: "familyGroupInviteAcceptedTemplate", render: () =>
    familyGroupInviteAcceptedTemplate("inviteeName-1", "groupName-2") },
  { id: "childRequestSubmittedTemplate:minimal", fn: "childRequestSubmittedTemplate", render: () =>
    childRequestSubmittedTemplate("parentName-1", "childName-2", "groupName-3") },
  { id: "childRequestApprovedTemplate:minimal", fn: "childRequestApprovedTemplate", render: () =>
    childRequestApprovedTemplate("parentName-1", "childName-2", "groupName-3") },
  { id: "childRequestRejectedTemplate:minimal", fn: "childRequestRejectedTemplate", render: () =>
    childRequestRejectedTemplate("parentName-1", "childName-2") },
  { id: "childRequestRejectedTemplate:full", fn: "childRequestRejectedTemplate", render: () =>
    childRequestRejectedTemplate("parentName-1", "childName-2", "reason-3") },
  { id: "adminFamilyGroupRequestTemplate:minimal", fn: "adminFamilyGroupRequestTemplate", render: () =>
    adminFamilyGroupRequestTemplate({ requestType: "requestType-1", requesterName: "requesterName-2", groupName: "groupName-3", details: "details-4" }) },
  { id: "joinRequestConfirmationTemplate:minimal", fn: "joinRequestConfirmationTemplate", render: () =>
    joinRequestConfirmationTemplate("requesterName-1", "groupName-2") },
  { id: "groupCreateRequestConfirmationTemplate:minimal", fn: "groupCreateRequestConfirmationTemplate", render: () =>
    groupCreateRequestConfirmationTemplate("requesterName-1", "groupName-2") },
  { id: "groupCreateApprovedTemplate:minimal", fn: "groupCreateApprovedTemplate", render: () =>
    groupCreateApprovedTemplate("requesterName-1", "groupName-2") },
  { id: "groupCreateRejectedTemplate:minimal", fn: "groupCreateRejectedTemplate", render: () =>
    groupCreateRejectedTemplate("requesterName-1", "groupName-2") },
  { id: "groupCreateRejectedTemplate:full", fn: "groupCreateRejectedTemplate", render: () =>
    groupCreateRejectedTemplate("requesterName-1", "groupName-2", "reason-3") },
  { id: "partnerInviteTemplate:minimal", fn: "partnerInviteTemplate", render: () =>
    partnerInviteTemplate({ inviterName: "inviterName-1", groupName: "groupName-2", claimUrl: "claimUrl-3", expiresAt: new Date("2026-03-05T00:00:00.000Z") }) },
  { id: "partnerInviteClaimedTemplate:minimal", fn: "partnerInviteClaimedTemplate", render: () =>
    partnerInviteClaimedTemplate("firstName-1", "groupName-2") },
  { id: "partnerLinkRequestTemplate:minimal", fn: "partnerLinkRequestTemplate", render: () =>
    partnerLinkRequestTemplate("requesterName-1", "profileUrl-2") },
  { id: "partnerLinkConfirmedTemplate:minimal", fn: "partnerLinkConfirmedTemplate", render: () =>
    partnerLinkConfirmedTemplate("partnerName-1") },
  { id: "partnerLinkRemovedTemplate:minimal", fn: "partnerLinkRemovedTemplate", render: () =>
    partnerLinkRemovedTemplate("partnerName-1") },
  { id: "membershipCancellationSubmittedTemplate:minimal", fn: "membershipCancellationSubmittedTemplate", render: () =>
    membershipCancellationSubmittedTemplate({ firstName: "firstName-1", participantSummary: "participantSummary-2", reviewUrl: "reviewUrl-3" }) },
  { id: "membershipCancellationSubmittedTemplate:full", fn: "membershipCancellationSubmittedTemplate", render: () =>
    membershipCancellationSubmittedTemplate({ firstName: "firstName-1", participantSummary: "participantSummary-2", reason: "reason-3", reviewUrl: "reviewUrl-4" }) },
  { id: "membershipCancellationConfirmationTemplate:minimal", fn: "membershipCancellationConfirmationTemplate", render: () =>
    membershipCancellationConfirmationTemplate({ firstName: "firstName-1", requesterName: "requesterName-2", participantName: "participantName-3", confirmationUrl: "confirmationUrl-4", expiresAt: new Date("2026-03-06T00:00:00.000Z") }) },
  { id: "adminMembershipCancellationRequestTemplate:minimal", fn: "adminMembershipCancellationRequestTemplate", render: () =>
    adminMembershipCancellationRequestTemplate({ requesterName: "requesterName-1", participantSummary: "participantSummary-2", reviewUrl: "reviewUrl-3" }) },
  { id: "adminMembershipCancellationRequestTemplate:full", fn: "adminMembershipCancellationRequestTemplate", render: () =>
    adminMembershipCancellationRequestTemplate({ requesterName: "requesterName-1", participantSummary: "participantSummary-2", reason: "reason-3", reviewUrl: "reviewUrl-4" }) },
  { id: "adminMemberArchiveRequestedTemplate:minimal", fn: "adminMemberArchiveRequestedTemplate", render: () =>
    adminMemberArchiveRequestedTemplate({ requesterName: "requesterName-1", memberName: "memberName-2", reason: "reason-3", reviewUrl: "reviewUrl-4" }) },
  { id: "memberArchiveApprovedTemplate:minimal", fn: "memberArchiveApprovedTemplate", render: () =>
    memberArchiveApprovedTemplate({ firstName: "firstName-1", reason: "reason-2" }) },
  { id: "memberArchiveApprovedTemplate:full", fn: "memberArchiveApprovedTemplate", render: () =>
    memberArchiveApprovedTemplate({ firstName: "firstName-1", reason: "reason-2", reviewNote: "reviewNote-3" }) },
  { id: "memberArchiveRejectedTemplate:minimal", fn: "memberArchiveRejectedTemplate", render: () =>
    memberArchiveRejectedTemplate({ firstName: "firstName-1", reason: "reason-2" }) },
  { id: "memberArchiveRejectedTemplate:full", fn: "memberArchiveRejectedTemplate", render: () =>
    memberArchiveRejectedTemplate({ firstName: "firstName-1", reason: "reason-2", reviewNote: "reviewNote-3" }) },
  { id: "adminMemberDeleteRequestedTemplate:minimal", fn: "adminMemberDeleteRequestedTemplate", render: () =>
    adminMemberDeleteRequestedTemplate({ requesterName: "requesterName-1", memberName: "memberName-2", reason: "reason-3", reviewUrl: "reviewUrl-4" }) },
  { id: "adminMemberDeleteApprovedTemplate:minimal", fn: "adminMemberDeleteApprovedTemplate", render: () =>
    adminMemberDeleteApprovedTemplate({ requesterName: "requesterName-1", memberName: "memberName-2", reason: "reason-3" }) },
  { id: "adminMemberDeleteApprovedTemplate:full", fn: "adminMemberDeleteApprovedTemplate", render: () =>
    adminMemberDeleteApprovedTemplate({ requesterName: "requesterName-1", memberName: "memberName-2", reason: "reason-3", reviewNote: "reviewNote-4" }) },
  { id: "adminMemberDeleteRejectedTemplate:minimal", fn: "adminMemberDeleteRejectedTemplate", render: () =>
    adminMemberDeleteRejectedTemplate({ requesterName: "requesterName-1", memberName: "memberName-2", reason: "reason-3", reviewUrl: "reviewUrl-4" }) },
  { id: "adminMemberDeleteRejectedTemplate:full", fn: "adminMemberDeleteRejectedTemplate", render: () =>
    adminMemberDeleteRejectedTemplate({ requesterName: "requesterName-1", memberName: "memberName-2", reason: "reason-3", reviewNote: "reviewNote-4", reviewUrl: "reviewUrl-5" }) },
  { id: "membershipCancellationApprovedTemplate:minimal", fn: "membershipCancellationApprovedTemplate", render: () =>
    membershipCancellationApprovedTemplate({ firstName: "firstName-1", participantName: "participantName-2" }) },
  { id: "membershipCancellationApprovedTemplate:full", fn: "membershipCancellationApprovedTemplate", render: () =>
    membershipCancellationApprovedTemplate({ firstName: "firstName-1", participantName: "participantName-2", reason: "reason-3", adminNote: "adminNote-4", rejoinProcessText: "rejoinProcessText-5" }) },
  { id: "membershipCancellationRejectedTemplate:minimal", fn: "membershipCancellationRejectedTemplate", render: () =>
    membershipCancellationRejectedTemplate({ firstName: "firstName-1", participantName: "participantName-2" }) },
  { id: "membershipCancellationRejectedTemplate:full", fn: "membershipCancellationRejectedTemplate", render: () =>
    membershipCancellationRejectedTemplate({ firstName: "firstName-1", participantName: "participantName-2", reason: "reason-3", adminNote: "adminNote-4" }) },
  { id: "adminMembershipApplicationPendingTemplate:minimal", fn: "adminMembershipApplicationPendingTemplate", render: () =>
    adminMembershipApplicationPendingTemplate({ applicantName: "applicantName-1", applicantEmail: "applicantEmail-2", familyMemberCount: 103, reviewUrl: "reviewUrl-4" }) },
  { id: "adminAccountDeletionRequestedTemplate:minimal", fn: "adminAccountDeletionRequestedTemplate", render: () =>
    adminAccountDeletionRequestedTemplate({ memberName: "memberName-1", memberEmail: "memberEmail-2", reviewUrl: "reviewUrl-3" }) },
  { id: "adminAccountDeletionRequestedTemplate:full", fn: "adminAccountDeletionRequestedTemplate", render: () =>
    adminAccountDeletionRequestedTemplate({ memberName: "memberName-1", memberEmail: "memberEmail-2", reason: "reason-3", reviewUrl: "reviewUrl-4" }) },
  { id: "membershipApplicationApprovedTemplate:minimal", fn: "membershipApplicationApprovedTemplate", render: () =>
    membershipApplicationApprovedTemplate("firstName-1", "resetUrl-2") },
  { id: "membershipApplicationApprovedTemplate:full", fn: "membershipApplicationApprovedTemplate", render: () =>
    membershipApplicationApprovedTemplate("firstName-1", "resetUrl-2", "adminNotes-3") },
  { id: "membershipApplicationRejectedTemplate:minimal", fn: "membershipApplicationRejectedTemplate", render: () =>
    membershipApplicationRejectedTemplate("firstName-1") },
  { id: "membershipApplicationRejectedTemplate:full", fn: "membershipApplicationRejectedTemplate", render: () =>
    membershipApplicationRejectedTemplate("firstName-1", "adminNotes-2") },
  { id: "ageUpInvitationTemplate:minimal", fn: "ageUpInvitationTemplate", render: () =>
    ageUpInvitationTemplate("firstName-1", "resetUrl-2") },
  { id: "ageUpInvitationTemplate:full", fn: "ageUpInvitationTemplate", render: () =>
    ageUpInvitationTemplate("firstName-1", "resetUrl-2", { targetAgeTierLabel: "Senior (65+)" }) },
  { id: "ageUpParentEmailHandoffTemplate:minimal", fn: "ageUpParentEmailHandoffTemplate", render: () =>
    ageUpParentEmailHandoffTemplate({ recipientName: "Pat Parent", memberFirstName: "Sam", memberLastName: "Youth" }) },
  { id: "ageUpParentEmailHandoffTemplate:full", fn: "ageUpParentEmailHandoffTemplate", render: () =>
    ageUpParentEmailHandoffTemplate({ recipientName: "Pat Parent", memberFirstName: "Sam", memberLastName: "Youth", targetAgeTierLabel: "Senior (65+)" }) },
  { id: "accountDeletionRejectedTemplate:minimal", fn: "accountDeletionRejectedTemplate", render: () =>
    accountDeletionRejectedTemplate("firstName-1", "adminNote-2") },
  { id: "waitlistConfirmationTemplate:minimal", fn: "waitlistConfirmationTemplate", render: () =>
    waitlistConfirmationTemplate("firstName-1", new Date("2026-03-03T00:00:00.000Z"), new Date("2026-03-04T00:00:00.000Z"), 104, 105) },
  { id: "waitlistOfferTemplate:minimal", fn: "waitlistOfferTemplate", render: () =>
    waitlistOfferTemplate("firstName-1", new Date("2026-03-03T00:00:00.000Z"), new Date("2026-03-04T00:00:00.000Z"), 104, new Date("2026-03-06T00:00:00.000Z"), "bookingId-6", 107) },
  { id: "waitlistOfferTemplate:full", fn: "waitlistOfferTemplate", render: () =>
    waitlistOfferTemplate("firstName-1", new Date("2026-03-03T00:00:00.000Z"), new Date("2026-03-04T00:00:00.000Z"), 104, new Date("2026-03-06T00:00:00.000Z"), "bookingId-6", 107, { lodgeName: "lodgeName-8" }, "subscriptionMemberRateNotice-9") },
  { id: "waitlistOfferExpiredTemplate:minimal", fn: "waitlistOfferExpiredTemplate", render: () =>
    waitlistOfferExpiredTemplate("firstName-1", new Date("2026-03-03T00:00:00.000Z"), new Date("2026-03-04T00:00:00.000Z"), 104) },
  { id: "waitlistPlaceRestoredTemplate:minimal", fn: "waitlistPlaceRestoredTemplate", render: () =>
    waitlistPlaceRestoredTemplate("firstName-1", new Date("2026-03-03T00:00:00.000Z"), new Date("2026-03-04T00:00:00.000Z"), 104) },
  { id: "adminWaitlistOfferTemplate:minimal", fn: "adminWaitlistOfferTemplate", render: () =>
    adminWaitlistOfferTemplate({ memberName: "memberName-1", checkIn: new Date("2026-03-03T00:00:00.000Z"), checkOut: new Date("2026-03-04T00:00:00.000Z"), guestCount: 104, position: 105 }) },
  { id: "setupIntentFailedTemplate:minimal", fn: "setupIntentFailedTemplate", render: () =>
    setupIntentFailedTemplate({ firstName: "firstName-1", checkIn: new Date("2026-03-03T00:00:00.000Z"), checkOut: new Date("2026-03-04T00:00:00.000Z") }) },
  { id: "adminRefundRequestTemplate:minimal", fn: "adminRefundRequestTemplate", render: () =>
    adminRefundRequestTemplate({ memberName: "memberName-1", bookingId: "bookingId-2", checkIn: new Date("2026-03-04T00:00:00.000Z"), checkOut: new Date("2026-03-05T00:00:00.000Z"), reason: "reason-5", requestedAmountCents: 106, paidAmountCents: 107, refundedAmountCents: 108 }) },
  { id: "adminBookingChangeRequestTemplate:minimal", fn: "adminBookingChangeRequestTemplate", render: () =>
    adminBookingChangeRequestTemplate({ memberName: "memberName-1", memberEmail: "memberEmail-2", bookingId: "bookingId-3", checkIn: new Date("2026-03-05T00:00:00.000Z"), checkOut: new Date("2026-03-06T00:00:00.000Z"), requestedSummary: "requestedSummary-6", reason: "reason-7", reviewUrl: "reviewUrl-8" }) },
  { id: "adminIssueReportTemplate:minimal", fn: "adminIssueReportTemplate", render: () =>
    adminIssueReportTemplate({ memberName: "memberName-1", memberEmail: "memberEmail-2", pageUrl: "pageUrl-3", description: "description-4", issueReportUrl: "issueReportUrl-5", hasScreenshot: true }) },
  { id: "adminIssueReportTemplate:full", fn: "adminIssueReportTemplate", render: () =>
    adminIssueReportTemplate({ memberName: "memberName-1", memberEmail: "memberEmail-2", pageUrl: "pageUrl-3", pageTitle: "pageTitle-4", description: "description-5", issueReportUrl: "issueReportUrl-6", hasScreenshot: true }) },
  { id: "adminMaintenanceReportTemplate:minimal", fn: "adminMaintenanceReportTemplate", render: () =>
    adminMaintenanceReportTemplate({ lodgeName: "lodgeName-1", reportedBy: "reportedBy-2", sourceLabel: "sourceLabel-3", photoLabel: "photoLabel-4", summary: "summary-5", answers: [], maintenanceReportUrl: "maintenanceReportUrl-6" }) },
  { id: "adminMaintenanceReportTemplate:full", fn: "adminMaintenanceReportTemplate", render: () =>
    adminMaintenanceReportTemplate({ lodgeName: "lodgeName-1", reportedBy: "reportedBy-2", sourceLabel: "sourceLabel-3", photoLabel: "photoLabel-4", summary: "summary-5", answers: [{ label: "label-6", value: "value-7" }, { label: "label-8", value: "value-9" }], maintenanceReportUrl: "maintenanceReportUrl-10" }) },
  { id: "refundRequestApprovedTemplate:minimal", fn: "refundRequestApprovedTemplate", render: () =>
    refundRequestApprovedTemplate({ firstName: "firstName-1", amountCents: 102, adminNotes: "adminNotes-3", checkIn: new Date("2026-03-05T00:00:00.000Z"), checkOut: new Date("2026-03-06T00:00:00.000Z") }) },
  { id: "refundRequestDeclinedTemplate:minimal", fn: "refundRequestDeclinedTemplate", render: () =>
    refundRequestDeclinedTemplate({ firstName: "firstName-1", adminNotes: "adminNotes-2", checkIn: new Date("2026-03-04T00:00:00.000Z"), checkOut: new Date("2026-03-05T00:00:00.000Z") }) },
  { id: "bookingRequestVerificationTemplate:minimal", fn: "bookingRequestVerificationTemplate", render: () =>
    bookingRequestVerificationTemplate({ firstName: "firstName-1", verifyUrl: "verifyUrl-2", checkIn: new Date("2026-03-04T00:00:00.000Z"), checkOut: new Date("2026-03-05T00:00:00.000Z"), guestCount: 105, expiresAt: new Date("2026-03-07T00:00:00.000Z") }) },
  { id: "groupSettlementReceiptTemplate:minimal", fn: "groupSettlementReceiptTemplate", render: () =>
    groupSettlementReceiptTemplate({ firstName: "firstName-1", checkIn: new Date("2026-03-03T00:00:00.000Z"), checkOut: new Date("2026-03-04T00:00:00.000Z"), joinerCount: 104, totalCents: 105 }) },
  { id: "groupJoinSettledTemplate:minimal", fn: "groupJoinSettledTemplate", render: () =>
    groupJoinSettledTemplate({ firstName: "firstName-1", organiserName: "organiserName-2", checkIn: new Date("2026-03-04T00:00:00.000Z"), checkOut: new Date("2026-03-05T00:00:00.000Z"), guestCount: 105 }) },
  { id: "groupSettlementExpiredTemplate:minimal", fn: "groupSettlementExpiredTemplate", render: () =>
    groupSettlementExpiredTemplate({ firstName: "firstName-1", checkIn: new Date("2026-03-03T00:00:00.000Z"), checkOut: new Date("2026-03-04T00:00:00.000Z"), joinerCount: 104, totalCents: 105 }) },
  { id: "groupJoinReleasedTemplate:minimal", fn: "groupJoinReleasedTemplate", render: () =>
    groupJoinReleasedTemplate({ firstName: "firstName-1", organiserName: "organiserName-2", checkIn: new Date("2026-03-04T00:00:00.000Z"), checkOut: new Date("2026-03-05T00:00:00.000Z") }) },
  { id: "groupJoinCancelledTemplate:minimal", fn: "groupJoinCancelledTemplate", render: () =>
    groupJoinCancelledTemplate({ firstName: "firstName-1", organiserName: "organiserName-2", checkIn: new Date("2026-03-04T00:00:00.000Z"), checkOut: new Date("2026-03-05T00:00:00.000Z") }) },
  { id: "bookingRequestApprovedTemplate:minimal", fn: "bookingRequestApprovedTemplate", render: () =>
    bookingRequestApprovedTemplate({ firstName: "firstName-1", payUrl: "payUrl-2", checkIn: new Date("2026-03-04T00:00:00.000Z"), checkOut: new Date("2026-03-05T00:00:00.000Z"), guestCount: 105, priceCents: 106, expiresAt: new Date("2026-03-08T00:00:00.000Z") }) },
  { id: "splitGuestPaymentLinkTemplate:minimal", fn: "splitGuestPaymentLinkTemplate", render: () =>
    splitGuestPaymentLinkTemplate({ firstName: "firstName-1", payUrl: "payUrl-2", checkIn: new Date("2026-03-04T00:00:00.000Z"), checkOut: new Date("2026-03-05T00:00:00.000Z"), guestCount: 105, priceCents: 106, expiresAt: new Date("2026-03-08T00:00:00.000Z") }) },
  { id: "bookingRequestQuoteTemplate:minimal", fn: "bookingRequestQuoteTemplate", render: () =>
    bookingRequestQuoteTemplate({ firstName: "firstName-1", respondUrl: "respondUrl-2", checkIn: new Date("2026-03-04T00:00:00.000Z"), checkOut: new Date("2026-03-05T00:00:00.000Z"), guestCount: 105, options: [{ label: "label-6", totalCents: 107 }], expiresAt: new Date("2026-03-09T00:00:00.000Z") }) },
  { id: "bookingRequestQuoteTemplate:full", fn: "bookingRequestQuoteTemplate", render: () =>
    bookingRequestQuoteTemplate({ firstName: "firstName-1", respondUrl: "respondUrl-2", checkIn: new Date("2026-03-04T00:00:00.000Z"), checkOut: new Date("2026-03-05T00:00:00.000Z"), guestCount: 105, options: [{ label: "label-6", totalCents: 107 }], message: "message-8", expiresAt: new Date("2026-03-10T00:00:00.000Z"), schoolName: "schoolName-10", isReminder: true }) },
  { id: "bookingRequestDeclinedTemplate:minimal", fn: "bookingRequestDeclinedTemplate", render: () =>
    bookingRequestDeclinedTemplate({ firstName: "firstName-1", checkIn: new Date("2026-03-03T00:00:00.000Z"), checkOut: new Date("2026-03-04T00:00:00.000Z") }) },
  { id: "bookingRequestDeclinedTemplate:full", fn: "bookingRequestDeclinedTemplate", render: () =>
    bookingRequestDeclinedTemplate({ firstName: "firstName-1", checkIn: new Date("2026-03-03T00:00:00.000Z"), checkOut: new Date("2026-03-04T00:00:00.000Z"), reason: "reason-4" }) },
  { id: "bookingRequestPaymentExpiredTemplate:minimal", fn: "bookingRequestPaymentExpiredTemplate", render: () =>
    bookingRequestPaymentExpiredTemplate({ firstName: "firstName-1", checkIn: new Date("2026-03-03T00:00:00.000Z"), checkOut: new Date("2026-03-04T00:00:00.000Z") }) },
  { id: "adminBookingRequestPendingTemplate:minimal", fn: "adminBookingRequestPendingTemplate", render: () =>
    adminBookingRequestPendingTemplate({ requesterName: "requesterName-1", checkIn: new Date("2026-03-03T00:00:00.000Z"), checkOut: new Date("2026-03-04T00:00:00.000Z"), guestCount: 104, reviewUrl: "reviewUrl-5" }) },
  { id: "adminSchoolManualInvoiceTemplate:minimal", fn: "adminSchoolManualInvoiceTemplate", render: () =>
    adminSchoolManualInvoiceTemplate({ schoolName: "schoolName-1", contactEmail: "contactEmail-2", checkIn: new Date("2026-03-04T00:00:00.000Z"), checkOut: new Date("2026-03-05T00:00:00.000Z"), guestCount: 105, totalCents: 106, reviewUrl: "reviewUrl-7" }) },
  { id: "adminWholeLodgeManualInvoiceTemplate:minimal", fn: "adminWholeLodgeManualInvoiceTemplate", render: () =>
    adminWholeLodgeManualInvoiceTemplate({ memberName: "memberName-1", contactEmail: "contactEmail-2", checkIn: new Date("2026-03-04T00:00:00.000Z"), checkOut: new Date("2026-03-05T00:00:00.000Z"), guestCount: 105, totalCents: 106, paymentReference: "paymentReference-7", reviewUrl: "reviewUrl-8" }) },
  { id: "adminWholeLodgeManualInvoiceTemplate:full", fn: "adminWholeLodgeManualInvoiceTemplate", render: () =>
    adminWholeLodgeManualInvoiceTemplate({ memberName: "memberName-1", contactEmail: "contactEmail-2", checkIn: new Date("2026-03-04T00:00:00.000Z"), checkOut: new Date("2026-03-05T00:00:00.000Z"), guestCount: 105, totalCents: 106, appliedCreditCents: 107, paymentReference: "paymentReference-8", reviewUrl: "reviewUrl-9" }) },
  { id: "adminBookingRequestHoldExpiredTemplate:minimal", fn: "adminBookingRequestHoldExpiredTemplate", render: () =>
    adminBookingRequestHoldExpiredTemplate({ requesterName: "requesterName-1", checkIn: new Date("2026-03-03T00:00:00.000Z"), checkOut: new Date("2026-03-04T00:00:00.000Z"), guestCount: 104, totalCents: 105, holdUntil: new Date("2026-03-07T00:00:00.000Z"), reviewUrl: "reviewUrl-7" }) },
  { id: "adminBookingRequestHoldCancelledTemplate:minimal", fn: "adminBookingRequestHoldCancelledTemplate", render: () =>
    adminBookingRequestHoldCancelledTemplate({ requesterName: "requesterName-1", checkIn: new Date("2026-03-03T00:00:00.000Z"), checkOut: new Date("2026-03-04T00:00:00.000Z"), guestCount: 104, totalCents: 105, reviewUrl: "reviewUrl-6" }) },
  { id: "adminSplitSettlementUnpaidTemplate:minimal", fn: "adminSplitSettlementUnpaidTemplate", render: () =>
    adminSplitSettlementUnpaidTemplate({ memberName: "memberName-1", checkIn: new Date("2026-03-03T00:00:00.000Z"), checkOut: new Date("2026-03-04T00:00:00.000Z"), guestCount: 104, totalCents: 105, holdUntil: new Date("2026-03-07T00:00:00.000Z"), reviewUrl: "reviewUrl-7", parentUnpaid: true }) },
  { id: "adminSplitSettlementCancelledTemplate:minimal", fn: "adminSplitSettlementCancelledTemplate", render: () =>
    adminSplitSettlementCancelledTemplate({ memberName: "memberName-1", checkIn: new Date("2026-03-03T00:00:00.000Z"), checkOut: new Date("2026-03-04T00:00:00.000Z"), guestCount: 104, totalCents: 105, reviewUrl: "reviewUrl-6", parentUnpaid: true }) },
  { id: "splitGuestPortionCancelledTemplate:minimal", fn: "splitGuestPortionCancelledTemplate", render: () =>
    splitGuestPortionCancelledTemplate({ firstName: "firstName-1", checkIn: new Date("2026-03-03T00:00:00.000Z"), checkOut: new Date("2026-03-04T00:00:00.000Z"), parentConfirmed: true }) },
  { id: "splitGuestPortionCancelledTemplate:full", fn: "splitGuestPortionCancelledTemplate", render: () =>
    splitGuestPortionCancelledTemplate({ firstName: "firstName-1", checkIn: new Date("2026-03-03T00:00:00.000Z"), checkOut: new Date("2026-03-04T00:00:00.000Z"), parentConfirmed: true, parentBookingReference: "parentBookingReference-4" }) },
  { id: "schoolAttendeeConfirmationTemplate:minimal", fn: "schoolAttendeeConfirmationTemplate", render: () =>
    schoolAttendeeConfirmationTemplate({ firstName: "firstName-1", schoolName: "schoolName-2", confirmUrl: "confirmUrl-3", checkIn: new Date("2026-03-05T00:00:00.000Z"), checkOut: new Date("2026-03-06T00:00:00.000Z"), guestCount: 106, isReminder: true }) },
  { id: "wholeLodgeGuestNamesReminderTemplate:minimal", fn: "wholeLodgeGuestNamesReminderTemplate", render: () =>
    wholeLodgeGuestNamesReminderTemplate({ firstName: "firstName-1", checkIn: new Date("2026-03-03T00:00:00.000Z"), checkOut: new Date("2026-03-04T00:00:00.000Z"), guestCount: 104, unnamedGuestCount: 105, isFinal: true, urgencyNote: "urgencyNote-6" }) },
  { id: "membershipPaymentRecordedTemplate:minimal", fn: "membershipPaymentRecordedTemplate", render: () =>
    membershipPaymentRecordedTemplate({ firstName: "firstName-1", seasonYear: 102, amountCents: 103, recordedAt: new Date("2026-03-05T00:00:00.000Z") }) },
  { id: "memberGuestConsentRequestTemplate:minimal", fn: "memberGuestConsentRequestTemplate", render: () =>
    memberGuestConsentRequestTemplate({ firstName: "firstName-1", bookerName: "bookerName-2", askHeading: "askHeading-3", askContextNote: "askContextNote-4", lodgeName: "lodgeName-5", checkIn: new Date("2026-03-07T00:00:00.000Z"), checkOut: new Date("2026-03-08T00:00:00.000Z"), guestNightsLabel: "guestNightsLabel-8", consentExpiresAt: new Date("2026-03-10T00:00:00.000Z"), consentUrl: "consentUrl-10", partyList: { text: "Everyone on this booking\n- Ada Guest", html: "<p>Everyone on this booking</p><ul><li>Ada Guest</li></ul>", names: ["Ada Guest"] } }) },
  { id: "memberGuestConsentRequestTemplate:full", fn: "memberGuestConsentRequestTemplate", render: () =>
    memberGuestConsentRequestTemplate({ firstName: "firstName-1", bookerName: "bookerName-2", askHeading: "askHeading-3", askContextNote: "askContextNote-4", lodgeName: "lodgeName-5", checkIn: new Date("2026-03-07T00:00:00.000Z"), checkOut: new Date("2026-03-08T00:00:00.000Z"), guestNightsLabel: "guestNightsLabel-8", consentExpiresAt: new Date("2026-03-10T00:00:00.000Z"), consentUrl: "consentUrl-10", partyList: { text: "Everyone on this booking\n- Ada Guest\n- Bo Member", html: "<p>Everyone on this booking</p><ul><li>Ada Guest</li><li>Bo Member</li></ul>", names: ["Ada Guest", "Bo Member"] } }) },
  { id: "memberGuestAddedTemplate:minimal", fn: "memberGuestAddedTemplate", render: () =>
    memberGuestAddedTemplate({ firstName: "firstName-1", addedHeading: "addedHeading-2", addedContextNote: "addedContextNote-3", lodgeName: "lodgeName-4", checkIn: new Date("2026-03-06T00:00:00.000Z"), checkOut: new Date("2026-03-07T00:00:00.000Z"), guestNightsLabel: "guestNightsLabel-7", nightsLabel: "nightsLabel-8", partyList: { text: "Everyone on this booking\n- Ada Guest", html: "<p>Everyone on this booking</p><ul><li>Ada Guest</li></ul>", names: ["Ada Guest"] }, removalNote: "removalNote-9" }) },
  { id: "memberGuestAddedTemplate:full", fn: "memberGuestAddedTemplate", render: () =>
    memberGuestAddedTemplate({ firstName: "firstName-1", addedHeading: "addedHeading-2", addedContextNote: "addedContextNote-3", lodgeName: "lodgeName-4", checkIn: new Date("2026-03-06T00:00:00.000Z"), checkOut: new Date("2026-03-07T00:00:00.000Z"), guestNightsLabel: "guestNightsLabel-7", nightsLabel: "nightsLabel-8", partyList: { text: "Everyone on this booking\n- Ada Guest\n- Bo Member", html: "<p>Everyone on this booking</p><ul><li>Ada Guest</li><li>Bo Member</li></ul>", names: ["Ada Guest", "Bo Member"] }, removalNote: "removalNote-9" }) },
  { id: "familyMemberBookingAddedTemplate:minimal", fn: "familyMemberBookingAddedTemplate", render: () =>
    familyMemberBookingAddedTemplate({ firstName: "firstName-1", addedHeading: "addedHeading-2", addedContextNote: "addedContextNote-3", lodgeName: "lodgeName-4", checkIn: new Date("2026-03-06T00:00:00.000Z"), checkOut: new Date("2026-03-07T00:00:00.000Z"), removalNote: "removalNote-7" }) },
  { id: "memberGuestConsentOutcomeTemplate:minimal", fn: "memberGuestConsentOutcomeTemplate", render: () =>
    memberGuestConsentOutcomeTemplate({ firstName: "firstName-1", outcomeHeading: "outcomeHeading-2", outcomeSentence: "outcomeSentence-3", consequenceNote: "consequenceNote-4", bookingId: "bookingId-5" }) },
  { id: "memberGuestConsentExpiredTemplate:minimal", fn: "memberGuestConsentExpiredTemplate", render: () =>
    memberGuestConsentExpiredTemplate({ firstName: "firstName-1", bookerName: "bookerName-2", lodgeName: "lodgeName-3", checkIn: new Date("2026-03-05T00:00:00.000Z"), checkOut: new Date("2026-03-06T00:00:00.000Z") }) },
  { id: "memberGuestRequestWithdrawnTemplate:minimal", fn: "memberGuestRequestWithdrawnTemplate", render: () =>
    memberGuestRequestWithdrawnTemplate({ firstName: "firstName-1", withdrawnHeading: "withdrawnHeading-2", withdrawnContextNote: "withdrawnContextNote-3", lodgeName: "lodgeName-4", checkIn: new Date("2026-03-06T00:00:00.000Z"), checkOut: new Date("2026-03-07T00:00:00.000Z") }) },
  { id: "memberGuestConsentAnsweredTemplate:minimal", fn: "memberGuestConsentAnsweredTemplate", render: () =>
    memberGuestConsentAnsweredTemplate({ firstName: "firstName-1", answeredHeading: "answeredHeading-2", answeredSentence: "answeredSentence-3", answeredNote: "answeredNote-4" }) },
  { id: "hostingCoverageLostTemplate:minimal", fn: "hostingCoverageLostTemplate", render: () =>
    hostingCoverageLostTemplate({ firstName: "firstName-1", lodgeName: "lodgeName-2", checkIn: new Date("2026-03-04T00:00:00.000Z"), checkOut: new Date("2026-03-05T00:00:00.000Z"), uncoveredNights: "uncoveredNights-5" }) },
  { id: "policyExceptionRequestExpiredTemplate:minimal", fn: "policyExceptionRequestExpiredTemplate", render: () =>
    policyExceptionRequestExpiredTemplate({ firstName: "firstName-1", lodgeName: "lodgeName-2", checkIn: new Date("2026-03-04T00:00:00.000Z"), checkOut: new Date("2026-03-05T00:00:00.000Z"), expiresAt: new Date("2026-03-06T00:00:00.000Z") }) },
];

/**
 * HTML ESCAPING. `escapeHtml` is the one primitive here whose failure is a
 * security bug rather than a cosmetic one, and the generated corpus could not
 * see it at all: every generated value is `<field>-<n>`, so not one of the
 * bodies contained a single escaped entity and `escapeHtml` could be reduced to
 * `return str` with the whole gate still green.
 *
 * These cases carry all five characters the escaper maps — `&`, `<`, `>`, `"`
 * and `'` — through both of the contexts the output lands in: element text, and
 * the `href` attribute `button()` builds. A partial mutation matters as much as
 * a total one: dropping only `&` or only `'` still breaks `Fish & chips` and
 * `O'Brien`, and nothing else in the repository asserts either.
 */
const ESCAPING_CASES: EmailRenderCase[] = [
  {
    id: "escapeHtml:entities",
    fn: "escapeHtml",
    render: () => escapeHtml(`<a href="x?a=1&b=2">R&D 'q' </a>`),
  },
  {
    // Escaped output inside an attribute: `button()` escapes the sanitised href.
    id: "button:ampersand-in-href",
    fn: "button",
    render: () => button("View & confirm", "/bookings?from=a&to=b"),
  },
  {
    // A complete member-facing body whose name, title and link all carry the
    // five characters, so the escaping is exercised through a real template
    // rather than only through the primitive.
    id: "noticePublishedTemplate:escaping",
    fn: "noticePublishedTemplate",
    render: () =>
      noticePublishedTemplate(
        `O'Brien & Sons`,
        `Fish & chips <b>"today"</b> — O'Brien's note`,
        "/notices?id=1&ref=2",
      ),
  },
];

/**
 * The three bodies #2689 moved out of their send sites. They are pinned for the
 * reason the move was made: while the HTML lived in a route or a cron, nothing
 * compared it to anything, so a refactor could change what an operator receives
 * with nothing going red.
 *
 * The contact form carries all five escaped characters, because its three
 * fields are the most attacker-reachable free text in the system — anyone on
 * the public website can put anything in them.
 */
const MOVED_SEND_SITE_CASES: EmailRenderCase[] = [
  {
    id: "websiteContactTemplate:minimal",
    fn: "websiteContactTemplate",
    render: () =>
      websiteContactTemplate({
        name: "Ada Lovelace",
        email: "ada@example.org",
        message: "Hello, I have a question about the lodge.",
      }),
  },
  {
    id: "websiteContactTemplate:escaping",
    fn: "websiteContactTemplate",
    render: () =>
      websiteContactTemplate({
        name: `O'Brien & <b>Sons</b>`,
        email: `a"b&c@example.org`,
        message: `<script>alert(1)</script> R&D 'quoted' "double"`,
      }),
  },
  {
    id: "adminEmailDeliveryFailedTemplate:minimal",
    fn: "adminEmailDeliveryFailedTemplate",
    render: () =>
      adminEmailDeliveryFailedTemplate({
        recipient: "member@example.org",
        templateName: "booking-confirmed",
        attemptCount: 3,
      }),
  },
  {
    id: "adminEmailDeliveryFailedTemplate:escaping",
    fn: "adminEmailDeliveryFailedTemplate",
    render: () =>
      adminEmailDeliveryFailedTemplate({
        recipient: `<member&"'@example.org>`,
        templateName: `booking<&"'confirmed`,
        attemptCount: 3,
      }),
  },
  {
    id: "adminEmailWithheldTemplate:minimal",
    fn: "adminEmailWithheldTemplate",
    render: () =>
      adminEmailWithheldTemplate({
        templateName: "booking-confirmed",
        bookingId: "bkg_example",
      }),
  },
  {
    id: "adminEmailWithheldTemplate:escaping",
    fn: "adminEmailWithheldTemplate",
    render: () =>
      adminEmailWithheldTemplate({
        templateName: `booking<&"'confirmed`,
        bookingId: `bkg_<&"'example`,
      }),
  },
];

export const EMAIL_RENDER_CASES: EmailRenderCase[] = [
  ...GENERATED_CASES,
  ...PRIMITIVE_CASES,
  ...ESCAPING_CASES,
  ...MOVED_SEND_SITE_CASES,
  ...MONEY_BRANCH_CASES,
];
