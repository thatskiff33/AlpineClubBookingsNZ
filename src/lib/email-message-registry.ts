import {
  EMAIL_AUDIT_DEFAULTS,
  type EmailAuditTemplateName,
} from "@/lib/email-message-audit-defaults";
import { FALLBACK_LODGE_CAPACITY } from "@/lib/lodge-capacity";

export type EmailTemplateAudience = "member" | "admin" | "system";
export type NotificationDeliveryModeValue = "always" | "content_only" | "disabled";

export interface EmailTemplateDefinition {
  key: EmailAuditTemplateName;
  label: string;
  audience: EmailTemplateAudience;
  defaultSubject: string;
  defaultBody: string;
  allowedTokens: string[];
  requiredTokens: string[];
  sampleData: Record<string, string>;
  triggerSummary: string;
  frequency: string;
  deliveryEditable: boolean;
  defaultDeliveryMode: NotificationDeliveryModeValue;
}

const ADMIN_SYSTEM_TEMPLATE_NAMES = new Set<EmailAuditTemplateName>([
  "admin-membership-application-pending",
  "admin-new-booking",
  "admin-payment-failure",
  "admin-pending-deadline",
  "admin-booking-bumped",
  "admin-capacity-warning",
  "admin-daily-digest",
  "admin-xero-sync-error",
  "admin-xero-repeated-failure",
  "admin-xero-reconciliation-report",
  "admin-refund-request",
  "admin-booking-change-request",
  "admin-issue-report",
  "admin-membership-cancellation-request",
  "admin-account-deletion-requested",
  "admin-member-archive-requested",
  "admin-member-delete-requested",
  "admin-member-delete-approved",
  "admin-member-delete-rejected",
  "admin-waitlist-offer",
  "admin-family-group-request",
  "admin-email-failure",
  "website-contact",
  "admin-booking-request-pending",
  "admin-booking-request-hold-expired",
]);

const LOCKED_DELIVERY_TEMPLATE_NAMES = new Set<EmailAuditTemplateName>([
  "admin-email-failure",
]);

const CONTENT_ONLY_DEFAULT_TEMPLATE_NAMES = new Set<EmailAuditTemplateName>([
  "admin-daily-digest",
  "admin-xero-reconciliation-report",
]);

const GLOBAL_EMAIL_TEMPLATE_TOKENS = [
  "BASE_URL",
  "CLUB_BOOKINGS_NAME",
  "CLUB_EMAIL_FROM_NAME",
  "CLUB_LODGE_NAME",
  "CLUB_LODGE_TRAVEL_NOTE",
  "CLUB_NAME",
  "CONTACT_EMAIL",
  "LODGE_CAPACITY",
  "SUPPORT_EMAIL",
] as const;

const EXTRA_TEMPLATE_TOKENS: Partial<Record<EmailAuditTemplateName, string[]>> = {
  "booking-modified": [
    "additionalPaymentMethod",
    "paymentReference",
    "xeroInvoiceNumber",
  ],
  "password-reset": ["resetUrl"],
  "admin-password-reset": ["resetUrl"],
  "member-setup-invite": ["resetUrl"],
  "email-verification": ["verifyUrl"],
  "email-change-verification": ["verifyUrl"],
  "nomination-request": ["reviewUrl"],
  "membership-application-approved": ["resetUrl"],
  "admin-membership-application-pending": ["reviewUrl"],
  "family-group-invitation": ["profileUrl"],
  "membership-cancellation-submitted": [
    "participantSummary",
    "reason",
    "reviewUrl",
  ],
  "membership-cancellation-confirmation": ["confirmationUrl"],
  "membership-cancellation-approved": [
    "adminNote",
    "participantName",
    "reason",
    "rejoinProcessText",
  ],
  "membership-cancellation-rejected": [
    "adminNote",
    "participantName",
    "reason",
  ],
  "admin-membership-cancellation-request": [
    "participantSummary",
    "reason",
    "reviewUrl",
  ],
  "admin-account-deletion-requested": ["reason", "requestId", "reviewUrl"],
  "admin-member-archive-requested": ["memberName", "reason", "reviewUrl"],
  "member-archive-approved": ["reason", "reviewNote"],
  "member-archive-rejected": ["reason", "reviewNote"],
  "admin-member-delete-requested": ["memberName", "reason", "reviewUrl"],
  "admin-member-delete-approved": ["memberName", "reason", "reviewNote"],
  "admin-member-delete-rejected": [
    "memberName",
    "reason",
    "reviewNote",
    "reviewUrl",
  ],
  "admin-xero-repeated-failure": ["localUrl", "xeroObjectUrl"],
  "refund-request-resolved": ["status"],
  "admin-issue-report": ["hasScreenshot"],
  "age-up-invitation": ["resetUrl", "targetAgeTier", "targetAgeTierMinAge"],
  "age-up-parent-email-handoff": ["targetAgeTier", "targetAgeTierMinAge"],
  "booking-request-verification": ["verifyUrl"],
  "booking-request-approved": ["payUrl"],
  "booking-request-quote": ["respondUrl"],
};

const REQUIRED_TEMPLATE_TOKENS: Partial<Record<EmailAuditTemplateName, string[]>> = {
  "booking-confirmed": ["CLUB_LODGE_TRAVEL_NOTE", "doorCode"],
  "pre-arrival-reminder": ["CLUB_LODGE_TRAVEL_NOTE", "doorCode"],
  "password-reset": ["token"],
  "admin-password-reset": ["token"],
  "member-setup-invite": ["token"],
  "email-verification": ["token"],
  "email-change-verification": ["newEmail", "token"],
  "email-change-notification": ["newEmail"],
  "nomination-request": ["applicantName", "token"],
  "membership-application-approved": ["token"],
  "membership-cancellation-confirmation": [
    "participantName",
    "requesterName",
    "token",
  ],
  "membership-cancellation-submitted": ["participantSummary", "reviewUrl"],
  "membership-cancellation-approved": ["participantName"],
  "membership-cancellation-rejected": ["participantName"],
  "admin-membership-cancellation-request": [
    "participantSummary",
    "requesterName",
    "reviewUrl",
  ],
  "admin-account-deletion-requested": [
    "memberEmail",
    "memberName",
    "reviewUrl",
  ],
  "admin-member-archive-requested": [
    "memberName",
    "requesterName",
    "reason",
    "reviewUrl",
  ],
  "member-archive-approved": ["firstName", "reason"],
  "member-archive-rejected": ["firstName", "reason"],
  "admin-member-delete-requested": [
    "memberName",
    "requesterName",
    "reason",
    "reviewUrl",
  ],
  "admin-member-delete-approved": ["memberName", "requesterName", "reason"],
  "admin-member-delete-rejected": [
    "memberName",
    "requesterName",
    "reason",
    "reviewUrl",
  ],
  "age-up-invitation": ["token"],
  "age-up-parent-email-handoff": ["memberName"],
  "website-contact": ["name", "email", "message"],
  "admin-email-failure": [
    "originalRecipient",
    "originalTemplateName",
    "attemptCount",
  ],
  "bulk-communication": ["adminEnteredBody"],
  "booking-request-verification": ["token"],
  "booking-request-approved": ["token"],
  "booking-request-quote": ["token"],
  "admin-booking-request-pending": ["requesterName", "reviewUrl"],
  "admin-booking-request-hold-expired": ["requesterName", "reviewUrl"],
};

const TEMPLATE_TRIGGER_METADATA: Partial<
  Record<EmailAuditTemplateName, { triggerSummary: string; frequency: string }>
> = {
  "admin-daily-digest": {
    triggerSummary: "Scheduled admin alert summary",
    frequency: "Daily at the configured cron time",
  },
  "admin-xero-reconciliation-report": {
    triggerSummary: "Scheduled Xero reconciliation report",
    frequency: "When the Xero reconciliation cron runs",
  },
  "admin-email-failure": {
    triggerSummary: "Exhausted retry alert",
    frequency: "When a retryable email permanently fails",
  },
  "admin-booking-change-request": {
    triggerSummary: "Locked booking change request submitted",
    frequency: "Per member/admin request submission",
  },
  "membership-cancellation-submitted": {
    triggerSummary: "Membership cancellation request submitted",
    frequency: "Per requester submission",
  },
  "admin-membership-cancellation-request": {
    triggerSummary: "Membership cancellation ready for admin review",
    frequency: "Per request when at least one participant is reviewable",
  },
  "admin-member-archive-requested": {
    triggerSummary: "Member archive request submitted",
    frequency: "Per archive request",
  },
  "member-archive-approved": {
    triggerSummary: "Member archive request approved",
    frequency: "Per archive approval",
  },
  "member-archive-rejected": {
    triggerSummary: "Member archive request rejected",
    frequency: "Per archive rejection",
  },
  "admin-member-delete-requested": {
    triggerSummary: "Member hard-delete request submitted",
    frequency: "Per delete request",
  },
  "admin-account-deletion-requested": {
    triggerSummary: "Self-service account deletion request submitted",
    frequency: "Per member deletion request",
  },
  "admin-member-delete-approved": {
    triggerSummary: "Member hard-delete request approved",
    frequency: "Per delete approval",
  },
  "admin-member-delete-rejected": {
    triggerSummary: "Member hard-delete request rejected",
    frequency: "Per delete rejection",
  },
  "bulk-communication": {
    triggerSummary: "Admin bulk communication send",
    frequency: "Per admin send action",
  },
  "website-contact": {
    triggerSummary: "Website contact form submission",
    frequency: "Per contact form submission",
  },
  "pre-arrival-reminder": {
    triggerSummary: "Pre-arrival reminder with current lodge access details",
    frequency: "Once per confirmed or paid booking in the reminder window",
  },
  "booking-request-verification": {
    triggerSummary: "Public booking request submitted",
    frequency: "Per booking request submission (and resend requests)",
  },
  "booking-request-approved": {
    triggerSummary: "Public booking request approved and priced by admin",
    frequency: "Per booking request approval",
  },
  "booking-request-quote": {
    triggerSummary: "Public booking request quote sent by admin",
    frequency: "Per booking request quote version sent",
  },
  "booking-request-declined": {
    triggerSummary: "Public booking request declined by admin",
    frequency: "Per booking request decline",
  },
  "admin-booking-request-pending": {
    triggerSummary: "Public booking request verified and ready for pricing",
    frequency: "Per verified booking request",
  },
  "admin-booking-request-hold-expired": {
    triggerSummary: "Request-origin booking unpaid at hold expiry",
    frequency: "Per hold-expiry check on an unpaid request booking",
  },
};

function titleCaseTemplateKey(key: string): string {
  return key
    .split("-")
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

function audienceForTemplate(key: EmailAuditTemplateName): EmailTemplateAudience {
  if (key === "admin-email-failure") return "system";
  if (ADMIN_SYSTEM_TEMPLATE_NAMES.has(key)) return "admin";
  return "member";
}

function extractTokensFromDefaults(...values: string[]): string[] {
  return values.flatMap((value) =>
    Array.from(value.matchAll(/\{\{([^{}]+)\}\}/g), (match) =>
      match[1].trim(),
    ).filter(Boolean),
  );
}

function uniqueSortedTokens(values: string[]): string[] {
  return Array.from(new Set(values)).sort((a, b) => a.localeCompare(b));
}

function sampleValue(token: string): string {
  if (token === "BASE_URL") return "https://bookings.example.org";
  if (token === "CLUB_NAME") return "Example Mountain Club";
  if (token === "CLUB_BOOKINGS_NAME") return "Example Mountain Club - Bookings";
  if (token === "CLUB_LODGE_NAME") return "Example Mountain Club Lodge";
  if (token === "CLUB_EMAIL_FROM_NAME") {
    return "Example Mountain Club - Online Booking System";
  }
  if (token === "CLUB_LODGE_TRAVEL_NOTE") {
    return "Please allow adequate travel time.";
  }
  if (token === "SUPPORT_EMAIL" || token === "CONTACT_EMAIL") {
    return "support@example.org";
  }
  if (token === "LODGE_CAPACITY") return String(FALLBACK_LODGE_CAPACITY);
  if (token === "doorCode") return "1234";
  if (token === "expectedArrivalTime") return "16:30";
  if (token.endsWith("Email") || token === "email") return "member@example.org";
  if (token.endsWith("Url") || token.endsWith("URL")) {
    return "https://bookings.example.org/admin";
  }
  if (token.toLowerCase().includes("amount") || token.includes("total")) {
    return "$123.45";
  }
  if (token.toLowerCase().includes("count")) return "2";
  if (token.toLowerCase().includes("date") || token.endsWith("At")) {
    return "1 July 2026";
  }
  if (token === "s") return "s";
  if (token === "token") return "sample-token";
  if (token === "recipientName") return "Sam Parent";
  if (token === "targetAgeTier") return "ADULT";
  if (token === "targetAgeTierLabel") return "Adult (18+)";
  if (token === "targetAgeTierMinAge") return "18";
  return token.replace(/[|]/g, " ");
}

export const EMAIL_TEMPLATE_DEFINITIONS: EmailTemplateDefinition[] = (
  Object.entries(EMAIL_AUDIT_DEFAULTS) as Array<
    [
      EmailAuditTemplateName,
      { defaultSubject: string; defaultBody: string },
    ]
  >
).map(([key, defaults]) => {
  const allowedTokens = uniqueSortedTokens([
    ...GLOBAL_EMAIL_TEMPLATE_TOKENS,
    ...extractTokensFromDefaults(defaults.defaultSubject, defaults.defaultBody),
    ...(EXTRA_TEMPLATE_TOKENS[key] ?? []),
  ]);
  const metadata = TEMPLATE_TRIGGER_METADATA[key] ?? {
    triggerSummary: "Audited application email",
    frequency: "Per trigger",
  };

  return {
    key,
    label: titleCaseTemplateKey(key),
    audience: audienceForTemplate(key),
    defaultSubject: defaults.defaultSubject,
    defaultBody: defaults.defaultBody,
    allowedTokens,
    requiredTokens: REQUIRED_TEMPLATE_TOKENS[key] ?? [],
    sampleData: Object.fromEntries(
      allowedTokens.map((token) => [token, sampleValue(token)]),
    ),
    triggerSummary: metadata.triggerSummary,
    frequency: metadata.frequency,
    deliveryEditable:
      ADMIN_SYSTEM_TEMPLATE_NAMES.has(key) &&
      !LOCKED_DELIVERY_TEMPLATE_NAMES.has(key),
    defaultDeliveryMode: CONTENT_ONLY_DEFAULT_TEMPLATE_NAMES.has(key)
      ? "content_only"
      : "always",
  };
});

export const EMAIL_TEMPLATE_KEYS = EMAIL_TEMPLATE_DEFINITIONS.map(
  (definition) => definition.key,
);

export const EMAIL_TEMPLATE_KEY_SET = new Set<string>(EMAIL_TEMPLATE_KEYS);

export const APPROVED_EMAIL_TEMPLATE_TOKENS = [
  "BASE_URL",
  "CLUB_BOOKINGS_NAME",
  "CLUB_EMAIL_FROM_NAME",
  "CLUB_LODGE_NAME",
  "CLUB_LODGE_TRAVEL_NOTE",
  "CLUB_NAME",
  "CONTACT_EMAIL",
  "LODGE_CAPACITY",
  "SUPPORT_EMAIL",
  "additionalAmount",
  "additionalPaymentMethod",
  "adminEnteredBody",
  "adminEnteredSubject",
  "adminNote",
  "adminNotes",
  "amount",
  "applicantEmail",
  "applicantName",
  "attemptCount",
  "availableBeds",
  "bookingId",
  "bookingReference",
  "bumpedMemberName",
  "changeFee",
  "checkIn",
  "checkOut",
  "childName",
  "confirmationUrl",
  "choreDescription",
  "choreLink",
  "choreName",
  "correlationKey",
  "count",
  "creditRestored",
  "creditRestoredMessage",
  "creditUsed",
  "date",
  "deadline",
  "description",
  "details",
  "discount",
  "doorCode",
  "email",
  "endDate",
  "entityType",
  "errorMessage",
  "errorType",
  "expectedArrivalTime",
  "expiresAt",
  "expiryLabel",
  "failureCount",
  "familyMemberCount",
  "firstName",
  "formattedDate",
  "generatedAt",
  "groupName",
  "guestCount",
  "guestFirstName",
  "guestLastName",
  "guestName",
  "holdUntil",
  "hoursRemaining",
  "inviteeName",
  "inviterName",
  "issueCategoryCount",
  "issueReportUrl",
  "issueTotalCount",
  "latestErrorMessage",
  "localId",
  "localModel",
  "lookbackHours",
  "memberEmail",
  "memberName",
  "message",
  "modificationTypeLabel",
  "name",
  "newCheckIn",
  "newCheckOut",
  "newEmail",
  "newGuestCount",
  "newTotal",
  "nominatorName",
  "occupiedBeds",
  "oldCheckIn",
  "oldCheckOut",
  "oldGuestCount",
  "oldTotal",
  "operation",
  "operationType",
  "originalRecipient",
  "originalTemplateName",
  "pageTitle",
  "pageUrl",
  "paidAmount",
  "parentName",
  "payUrl",
  "paymentIntentId",
  "paymentReference",
  "paymentNote",
  "price",
  "percent",
  "participantName",
  "participantSummary",
  "pin",
  "position",
  "promoCode",
  "quoteOptions",
  "reason",
  "recipientLabel",
  "refundAmount",
  "refundMessage",
  "refundedAmount",
  "remainingAmount",
  "remainingCredit",
  "recipientName",
  "profileUrl",
  "requestType",
  "requestedSummary",
  "requestedAmount",
  "requesterName",
  "rejoinProcessText",
  "resetUrl",
  "reviewNote",
  "reviewReason",
  "reviewUrl",
  "localUrl",
  "s",
  "severityLabel",
  "stalePendingMinutes",
  "startDate",
  "status",
  "subtotal",
  "targetAgeTier",
  "targetAgeTierLabel",
  "targetAgeTierMinAge",
  "timestamp",
  "token",
  "total",
  "totalAlerts",
  "totalPaid",
  "triggeringMemberName",
  "verifyUrl",
  "windowHours",
  "xeroObjectUrl",
  "xeroInvoiceNumber",
  "y|ies",
] as const;

export const APPROVED_EMAIL_TEMPLATE_TOKEN_SET = new Set<string>(
  APPROVED_EMAIL_TEMPLATE_TOKENS,
);

// Tokens whose rendered values must never appear in an email subject line.
// Subjects are persisted in EmailLog for every template (including the
// sensitive ones whose HTML bodies are deliberately not retained) and travel
// in clear mail headers, so secret values are restricted to message bodies.
export const SENSITIVE_EMAIL_SUBJECT_TOKENS = [
  "confirmationUrl",
  "doorCode",
  "payUrl",
  "pin",
  "resetUrl",
  "token",
  "verifyUrl",
] as const;

export const SENSITIVE_EMAIL_SUBJECT_TOKEN_SET = new Set<string>(
  SENSITIVE_EMAIL_SUBJECT_TOKENS,
);

export function getEmailTemplateDefinition(templateName: string) {
  return EMAIL_TEMPLATE_DEFINITIONS.find(
    (definition) => definition.key === templateName,
  );
}

export function isAdminSystemTemplate(templateName: string): boolean {
  return ADMIN_SYSTEM_TEMPLATE_NAMES.has(templateName as EmailAuditTemplateName);
}

export function getDefaultDeliveryMode(
  templateName: string,
): NotificationDeliveryModeValue {
  return getEmailTemplateDefinition(templateName)?.defaultDeliveryMode ?? "always";
}
