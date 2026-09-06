/**
 * What the rendered-email gate must cover, and the taxonomy it covers it by
 * (#2689).
 *
 * TAXONOMY. `REGISTRY_KEY_RENDERERS` maps every registry template key to the
 * function that renders it. It is NOT a new grouping scheme: each key/function
 * pair was read off the `sendEmail({ html: <fn>(...), templateName: "<key>" })`
 * call in the sender module that owns it, and the comment headings below name
 * that sender module.
 *
 * `src/lib/email/<family>.ts` is the repository's own message-family boundary,
 * and the split follows it — but NOT one-to-one. Fourteen modules mirror a
 * sender module directly; `communications` and `refunds` cover the two families
 * sent from a route or a lib module rather than a sender; and three more are
 * sub-modules of families that would otherwise exceed the 700-line budget:
 * `booking-reminders` and `booking-exceptions` split the booking family, while
 * `admin-xero-reports` splits the finance/Xero alerts. That makes nineteen
 * family/content modules across fourteen families, plus the shared `layout`
 * shell and `escape` leaf: twenty-one files in the directory altogether. Each
 * sub-module's own docblock names the family it belongs to.
 *
 * COVERAGE. `readEmailTemplateModuleExports()` reads the module DIRECTORY at
 * run time and imports whatever is in it. It is deliberately not a hand-written
 * list: a list is a second place to forget, and a whole new module added
 * without a line here would have been invisible to the gate — which is the
 * failure the contextual-help side already guards against the same way.
 */
import { readdirSync } from "node:fs";
import { join } from "node:path";

/** The one directory every email-template module lives in. */
export const EMAIL_TEMPLATE_MODULE_DIR = "src/lib/email-templates";

/**
 * A render case currently identifies its renderer by the exported function's
 * bare name. Refuse two modules that export the same name: otherwise one case
 * would appear to cover both module-qualified functions and a newly added
 * renderer could evade the directory census.
 */
export function assertUniqueEmailTemplateExportNames(
  byModule: Readonly<Record<string, readonly string[]>>,
): void {
  const ownerByExportName = new Map<string, string>();
  for (const [moduleName, exportNames] of Object.entries(byModule)) {
    for (const exportName of exportNames) {
      const existingOwner = ownerByExportName.get(exportName);
      if (existingOwner) {
        throw new Error(
          `Duplicate email-template function export "${exportName}" in ` +
            `modules "${existingOwner}" and "${moduleName}". Render cases use ` +
            "bare function names, so this would create false coverage.",
        );
      }
      ownerByExportName.set(exportName, moduleName);
    }
  }
}

/**
 * Every template module, and the render functions it exports, read from disk so
 * a new module cannot arrive uncovered.
 */
export async function readEmailTemplateModuleExports(): Promise<
  Record<string, string[]>
> {
  const files = readdirSync(join(process.cwd(), EMAIL_TEMPLATE_MODULE_DIR))
    .filter((file) => file.endsWith(".ts"))
    .sort();
  const byModule: Record<string, string[]> = {};
  for (const file of files) {
    const moduleName = file.replace(/\.ts$/, "");
    // The `.ts` stays in the static part of the specifier: Vite's
    // dynamic-import-vars plugin needs an extension there to build the glob.
    const loaded: Record<string, unknown> = await import(
      `@/lib/email-templates/${moduleName}.ts`
    );
    byModule[moduleName] = Object.entries(loaded)
      .filter(([, value]) => typeof value === "function")
      .map(([name]) => name)
      .sort();
  }
  assertUniqueEmailTemplateExportNames(byModule);
  return byModule;
}

/**
 * Registry template keys explicitly allowed to have no template function.
 * This set is currently empty: #2689 moved three former send-site bodies under
 * two registry keys into `email-templates/admin-ops.ts`, corrected their
 * layout/escaping deliberately, and pinned the resulting output. A future
 * exception needs a stated reason.
 */
export const REGISTRY_KEYS_WITHOUT_A_TEMPLATE_FUNCTION = new Set<string>([
  // EMPTY, and it should stay that way. The two former registry keys covered
  // three HTML bodies built at their send sites, which put those bodies outside
  // the render gate: a refactor could change what an operator receives with
  // nothing going red. #2689 moved all three into `email-templates/admin-ops.ts`;
  // their deliberate standard-layout and escaping correction is pinned with the
  // rest of the corpus.
  //
  // A key added here needs a stated reason, not just a line.
]);

/**
 * Registry template key -> the exported function that renders it, grouped by
 * the sender module (`src/lib/email/<family>.ts`) the pair was read from.
 *
 * `admin-email-failure` maps to `adminEmailDeliveryFailedTemplate`, the retry
 * cron's wording, because that is the shape the registry's default body
 * describes. The same key also carries `adminEmailWithheldTemplate` on the
 * fail-closed path — one key, two bodies, which predates #2689. This map holds
 * one renderer per key, so the second is covered by the module-export sweep
 * instead, which walks every exported function whether a key names it or not.
 *
 * `two-factor-code` is listed because a sender uses it as a `templateName`,
 * even though `email-message-audit-defaults.ts` carries no entry for it; the
 * gate iterates registry definitions, so the extra row is inert here.
 */
export const REGISTRY_KEY_RENDERERS: Record<string, string> = {
  // (admin API routes and notices)
  "admin-email-failure": "adminEmailDeliveryFailedTemplate",
  "bulk-communication": "bulkCommunicationTemplate",
  "notice-published": "noticePublishedTemplate",
  "refund-request-approved": "refundRequestApprovedTemplate",
  "refund-request-declined": "refundRequestDeclinedTemplate",
  "website-contact": "websiteContactTemplate",
  // account
  "account-deletion-approved": "accountDeletionApprovedTemplate",
  "account-deletion-rejected": "accountDeletionRejectedTemplate",
  "admin-password-reset": "adminPasswordResetTemplate",
  "email-change-notification": "emailChangeNotificationTemplate",
  "email-change-verification": "emailChangeVerificationTemplate",
  "email-verification": "emailVerificationTemplate",
  "magic-link-login": "magicLinkLoginTemplate",
  "member-setup-invite": "memberSetupInviteTemplate",
  "password-reset": "passwordResetTemplate",
  "two-factor-code": "twoFactorCodeTemplate",
  // admin-alerts-booking
  "admin-booking-bumped": "adminBookingBumpedTemplate",
  "admin-booking-change-request": "adminBookingChangeRequestTemplate",
  "admin-booking-request-hold-cancelled": "adminBookingRequestHoldCancelledTemplate",
  "admin-booking-request-hold-expired": "adminBookingRequestHoldExpiredTemplate",
  "admin-booking-request-pending": "adminBookingRequestPendingTemplate",
  "admin-capacity-warning": "adminCapacityWarningTemplate",
  "admin-minors-review": "adminMinorsReviewRequiredTemplate",
  "admin-new-booking": "adminNewBookingTemplate",
  "admin-owner-substitution": "adminOwnerSubstitutionTemplate",
  "admin-partner-share-swept": "adminPartnerShareSweptTemplate",
  "admin-pending-deadline": "adminPendingDeadlineTemplate",
  "admin-school-manual-invoice": "adminSchoolManualInvoiceTemplate",
  "admin-split-settlement-cancelled": "adminSplitSettlementCancelledTemplate",
  "admin-split-settlement-unpaid": "adminSplitSettlementUnpaidTemplate",
  "admin-waitlist-offer": "adminWaitlistOfferTemplate",
  "admin-whole-lodge-manual-invoice": "adminWholeLodgeManualInvoiceTemplate",
  // admin-alerts-finance
  "admin-credit-sync-drift": "adminCreditSyncDriftTemplate",
  "admin-duplicate-capture-refund": "adminDuplicateCaptureRefundTemplate",
  "admin-late-capture-auto-refund": "adminLateCaptureAutoRefundTemplate",
  "admin-late-capture-hand-back-conflict": "adminLateCaptureHandBackConflictTemplate",
  "admin-manual-refund-task": "adminManualRefundTaskTemplate",
  "admin-manual-settlement-conflict": "adminManualSettlementConflictTemplate",
  "admin-payment-failure": "adminPaymentFailureTemplate",
  "admin-refund-request": "adminRefundRequestTemplate",
  "admin-xero-reconciliation-report": "adminXeroReconciliationReportTemplate",
  "admin-xero-repeated-failure": "adminXeroRepeatedFailureTemplate",
  "admin-xero-sync-error": "adminXeroSyncErrorTemplate",
  // admin-alerts-membership
  "admin-account-deletion-requested": "adminAccountDeletionRequestedTemplate",
  "admin-family-group-request": "adminFamilyGroupRequestTemplate",
  "admin-member-archive-requested": "adminMemberArchiveRequestedTemplate",
  "admin-member-delete-approved": "adminMemberDeleteApprovedTemplate",
  "admin-member-delete-rejected": "adminMemberDeleteRejectedTemplate",
  "admin-member-delete-requested": "adminMemberDeleteRequestedTemplate",
  "admin-membership-application-pending": "adminMembershipApplicationPendingTemplate",
  "admin-membership-cancellation-request": "adminMembershipCancellationRequestTemplate",
  // admin-alerts-ops
  "admin-daily-digest": "adminDailyDigestTemplate",
  "admin-issue-report": "adminIssueReportTemplate",
  "admin-maintenance-report": "adminMaintenanceReportTemplate",
  // booking
  "additional-payment-reminder": "additionalPaymentReminderTemplate",
  "booking-bumped": "bookingBumpedTemplate",
  "booking-cancelled": "bookingCancelledTemplate",
  "booking-confirmed": "bookingConfirmedTemplate",
  "booking-guests-cancelled": "bookingGuestsCancelledTemplate",
  "booking-modified": "bookingModifiedTemplate",
  "booking-pending": "bookingPendingTemplate",
  "booking-policy-exception-approved": "bookingPolicyExceptionApprovedTemplate",
  "booking-policy-exception-refused": "bookingPolicyExceptionRefusedTemplate",
  "booking-review-approved": "bookingReviewApprovedTemplate",
  "booking-review-rejected": "bookingReviewRejectedTemplate",
  "checkin-reminder": "checkinReminderTemplate",
  "hosting-coverage-lost": "hostingCoverageLostTemplate",
  "policy-exception-request-expired": "policyExceptionRequestExpiredTemplate",
  "pre-arrival-reminder": "preArrivalReminderTemplate",
  "setup-intent-failed": "setupIntentFailedTemplate",
  "saved-card-charge-failed": "savedCardChargeFailedTemplate",
  "split-guest-portion-cancelled": "splitGuestPortionCancelledTemplate",
  "whole-lodge-guest-names-reminder": "wholeLodgeGuestNamesReminderTemplate",
  // booking-requests
  "booking-request-approved": "bookingRequestApprovedTemplate",
  "booking-request-declined": "bookingRequestDeclinedTemplate",
  "booking-request-payment-expired": "bookingRequestPaymentExpiredTemplate",
  "booking-request-quote": "bookingRequestQuoteTemplate",
  "booking-request-verification": "bookingRequestVerificationTemplate",
  "school-attendee-confirmation": "schoolAttendeeConfirmationTemplate",
  "split-guest-payment-link": "splitGuestPaymentLinkTemplate",
  // chores
  "chore-roster": "choreRosterTemplate",
  "hut-leader-assignment": "hutLeaderAssignmentTemplate",
  // family
  "child-request-approved": "childRequestApprovedTemplate",
  "child-request-rejected": "childRequestRejectedTemplate",
  "child-request-submitted": "childRequestSubmittedTemplate",
  "family-group-create-approved": "groupCreateApprovedTemplate",
  "family-group-create-rejected": "groupCreateRejectedTemplate",
  "family-group-create-request-confirmation": "groupCreateRequestConfirmationTemplate",
  "family-group-invitation": "familyGroupInvitationTemplate",
  "family-group-invite-accepted": "familyGroupInviteAcceptedTemplate",
  "join-request-confirmation": "joinRequestConfirmationTemplate",
  "partner-invite": "partnerInviteTemplate",
  "partner-invite-claimed": "partnerInviteClaimedTemplate",
  "partner-link-confirmed": "partnerLinkConfirmedTemplate",
  "partner-link-removed": "partnerLinkRemovedTemplate",
  "partner-link-request": "partnerLinkRequestTemplate",
  // family-booking
  "family-member-added": "familyMemberBookingAddedTemplate",
  // groups
  "group-booking-join-verification": "bookingRequestVerificationTemplate",
  "group-join-cancelled": "groupJoinCancelledTemplate",
  "group-join-released": "groupJoinReleasedTemplate",
  "group-join-settled": "groupJoinSettledTemplate",
  "group-settlement-expired": "groupSettlementExpiredTemplate",
  "group-settlement-receipt": "groupSettlementReceiptTemplate",
  // member-guest
  "member-guest-added": "memberGuestAddedTemplate",
  "member-guest-consent-answered": "memberGuestConsentAnsweredTemplate",
  "member-guest-consent-expired": "memberGuestConsentExpiredTemplate",
  "member-guest-consent-outcome": "memberGuestConsentOutcomeTemplate",
  "member-guest-consent-request": "memberGuestConsentRequestTemplate",
  "member-guest-request-withdrawn": "memberGuestRequestWithdrawnTemplate",
  // membership
  "age-up-invitation": "ageUpInvitationTemplate",
  "age-up-parent-email-handoff": "ageUpParentEmailHandoffTemplate",
  "induction-sign-off-request": "inductionSignOffRequestTemplate",
  "member-archive-approved": "memberArchiveApprovedTemplate",
  "member-archive-rejected": "memberArchiveRejectedTemplate",
  "membership-application-approved": "membershipApplicationApprovedTemplate",
  "membership-application-rejected": "membershipApplicationRejectedTemplate",
  "membership-cancellation-approved": "membershipCancellationApprovedTemplate",
  "membership-cancellation-confirmation": "membershipCancellationConfirmationTemplate",
  "membership-cancellation-rejected": "membershipCancellationRejectedTemplate",
  "membership-cancellation-submitted": "membershipCancellationSubmittedTemplate",
  "membership-payment-recorded": "membershipPaymentRecordedTemplate",
  "nomination-request": "nominationRequestTemplate",
  // waitlist
  "waitlist-confirmation": "waitlistConfirmationTemplate",
  "waitlist-offer": "waitlistOfferTemplate",
  "waitlist-offer-expired": "waitlistOfferExpiredTemplate",
  "waitlist-place-restored": "waitlistPlaceRestoredTemplate",
};
