/**
 * What the Support area's message officer actions return (ALP-724,
 * `INV-MCP-006`): booking message wording, email templates, the club's email
 * settings, delivery policies, an officer's alert choices, delivery
 * suppressions and failed emails. The catalogue entry and the route's
 * `connectionJson` both read these (`INV-SSOT`).
 *
 * Kept: what an officer's AI app needs to read and change the wording and
 * settings, and the address a suppression or failed email concerns (the
 * officer must know whose mail is stopped). Dropped: the ids of the officers
 * who last saved a setting, a template's sample data, a suppression's provider
 * message id, and a failed email's link to send a fresh copy (a website page).
 *
 * Types only from the lib modules: nothing here reaches the database.
 */
import type { BookingMessageOverride } from "@prisma/client";

import type { EffectiveBookingMessage } from "@/lib/booking-message-settings";
import {
  connectionShapeFor,
  eachEntry,
  type ConnectionShapeFor,
} from "@/lib/connection-projection";
import type { getExhaustedEmailFailureReviewQueue } from "@/lib/email-failure-review";
import type { EmailTemplateDefinition } from "@/lib/email-message-registry";
import type { renderEmailTemplatePreview } from "@/lib/email-message-renderer";
import type { EmailMessageSettings, PersistedEmailMessageSettings } from "@/lib/email-message-settings";
import type { getEmailDeliverabilityTelemetry } from "@/lib/email-suppression";
import type { NotificationDeliveryPolicyListPayload } from "@/lib/notification-delivery-policies";

// ---------------------------------------------------------------------------
// Booking message wording
// ---------------------------------------------------------------------------

export const BOOKING_MESSAGE_WORDING_LIST_CONNECTION_SHAPE = connectionShapeFor<{
  messages: EffectiveBookingMessage[];
}>({
  messages: {
    key: true,
    section: true,
    label: true,
    description: true,
    defaultBody: true,
    bodyText: true,
    tokens: true,
    override: { bodyText: true, updatedAt: true },
  },
});

export const BOOKING_MESSAGE_SAVED_CONNECTION_SHAPE = connectionShapeFor<{ override: BookingMessageOverride }>({
  override: { messageKey: true, bodyText: true, updatedAt: true },
});

/** The preview route's answer: the checked wording and how it reads with sample data. */
export interface BookingMessagePreviewAnswer {
  messageKey: string;
  bodyText: string;
  rendered: string;
}

export const BOOKING_MESSAGE_PREVIEW_CONNECTION_SHAPE = connectionShapeFor<BookingMessagePreviewAnswer>({
  messageKey: true,
  bodyText: true,
  rendered: true,
});

export const BOOKING_MESSAGE_RESET_CONNECTION_SHAPE = connectionShapeFor<{ reset: boolean }>({ reset: true });

// ---------------------------------------------------------------------------
// Email templates
// ---------------------------------------------------------------------------

/** A saved override as the templates route serialises it. */
export interface EmailTemplateOverrideAnswer {
  subject: string | null;
  bodyText: string | null;
  bodyHtml: string | null;
  updatedAt: string;
  updatedByMemberId: string | null;
}

/** Why a saved override no longer matches what the club can save or send (#2268, #2269, #2307). */
export interface EmailTemplateStaleContent {
  differsFromDefault: boolean;
  subjectDiffersFromDefault: boolean;
  bodyDiffersFromDefault: boolean;
  reasons: string[];
  missingRequiredTokens: string[];
  retiredTokens: string[];
  bracketAnnotations: string[];
  danglingLines: string[];
  strippedAnnotations: string[];
  unconditionalLines: string[];
}

/** One template as the templates route answers it. */
export type EmailTemplateAnswer = EmailTemplateDefinition & {
  override: EmailTemplateOverrideAnswer | null;
  staleContent: EmailTemplateStaleContent | null;
};

/** The whole list as the templates route answers it with no `templateName`. */
export interface EmailTemplateListAnswer {
  templates: EmailTemplateAnswer[];
  staleOverrideCount: number;
  staleOverrides: Array<{ templateName: string } & EmailTemplateOverrideAnswer>;
  bracketAnnotationOverrides: Array<{ templateName: string; annotations: string[] }>;
  strippedAnnotationOverrides: Array<{ templateName: string; annotations: string[]; lines: string[] }>;
  retiredTokenOverrides: Array<{ templateName: string; tokens: string[] }>;
  missingRequiredTokenOverrides: Array<{ templateName: string; tokens: string[] }>;
}

const TEMPLATE_TOKEN_LIST_SHAPE = { templateName: true, tokens: true } as const;

/**
 * The list carries no wording: a hundred templates' bodies would not fit in an
 * answer, so `get_email_template` reads one template whole.
 */
export const EMAIL_TEMPLATE_LIST_CONNECTION_SHAPE = connectionShapeFor<EmailTemplateListAnswer>({
  templates: {
    key: true,
    label: true,
    audience: true,
    triggerSummary: true,
    frequency: true,
    deliveryEditable: true,
    defaultDeliveryMode: true,
    override: { subject: true, updatedAt: true },
    staleContent: { differsFromDefault: true, reasons: true },
  },
  staleOverrideCount: true,
  retiredTokenOverrides: TEMPLATE_TOKEN_LIST_SHAPE,
  missingRequiredTokenOverrides: TEMPLATE_TOKEN_LIST_SHAPE,
});

/** One template, its default and saved wording whole, as the route answers `?templateName=`. */
export const EMAIL_TEMPLATE_CONNECTION_SHAPE = connectionShapeFor<{ template: EmailTemplateAnswer }>({
  template: {
    key: true,
    label: true,
    audience: true,
    defaultSubject: true,
    defaultBody: true,
    allowedTokens: true,
    requiredTokens: true,
    requiredSubjectTokens: true,
    forbiddenSubjectPhrases: true,
    requiredTokenAlternatives: eachEntry(true),
    triggerSummary: true,
    frequency: true,
    deliveryEditable: true,
    defaultDeliveryMode: true,
    override: { subject: true, bodyText: true, bodyHtml: true, updatedAt: true },
    staleContent: {
      differsFromDefault: true,
      subjectDiffersFromDefault: true,
      bodyDiffersFromDefault: true,
      reasons: true,
      missingRequiredTokens: true,
      retiredTokens: true,
      bracketAnnotations: true,
      danglingLines: true,
      strippedAnnotations: true,
      unconditionalLines: true,
    },
  },
});

/** The saved override row the update route answers with. */
export interface EmailTemplateSavedRow {
  templateName: string;
  subject: string | null;
  bodyText: string | null;
  bodyHtml: string | null;
  updatedAt: Date;
  updatedByMemberId: string | null;
}

export const EMAIL_TEMPLATE_SAVED_CONNECTION_SHAPE = connectionShapeFor<{ override: EmailTemplateSavedRow }>({
  override: { templateName: true, subject: true, bodyText: true, bodyHtml: true, updatedAt: true },
});

type EmailTemplatePreview = Awaited<ReturnType<typeof renderEmailTemplatePreview>>;

export const EMAIL_TEMPLATE_PREVIEW_CONNECTION_SHAPE = connectionShapeFor<EmailTemplatePreview>({
  subject: true,
  html: true,
});

/** The reset route's answer. */
export interface EmailTemplateResetAnswer {
  reset: boolean;
}

export const EMAIL_TEMPLATE_RESET_CONNECTION_SHAPE = connectionShapeFor<EmailTemplateResetAnswer>({ reset: true });

// ---------------------------------------------------------------------------
// The club's email settings
// ---------------------------------------------------------------------------

const EMAIL_SETTINGS_FIELDS = {
  clubName: true,
  bookingsName: true,
  emailFromName: true,
  supportEmail: true,
  contactEmail: true,
  publicUrl: true,
} as const satisfies ConnectionShapeFor<PersistedEmailMessageSettings>;

/**
 * The settings in force (`settings`, the default lodge's identity included)
 * and what the club saved itself (`persisted`). Never the lodge's door code,
 * which the settings in force carry for the emails that print it.
 */
export const EMAIL_SETTINGS_CONNECTION_SHAPE = connectionShapeFor<{
  settings: EmailMessageSettings;
  persisted: PersistedEmailMessageSettings | null;
}>({
  settings: { ...EMAIL_SETTINGS_FIELDS, lodgeName: true, lodgeTravelNote: true },
  persisted: { ...EMAIL_SETTINGS_FIELDS, updatedAt: true },
});

// ---------------------------------------------------------------------------
// Delivery policies and officers' alerts
// ---------------------------------------------------------------------------

export const NOTIFICATION_DELIVERY_POLICY_LIST_CONNECTION_SHAPE =
  connectionShapeFor<NotificationDeliveryPolicyListPayload>({
    policies: {
      templateName: true,
      label: true,
      mode: true,
      defaultMode: true,
      deliveryEditable: true,
      updatedAt: true,
    },
    stalePolicyCount: true,
  });

/** The saved policy row the update route answers with. */
export interface NotificationDeliveryPolicySavedRow {
  templateName: string;
  mode: string;
  updatedAt: Date;
  updatedByMemberId: string | null;
}

export const NOTIFICATION_DELIVERY_POLICY_SAVED_CONNECTION_SHAPE = connectionShapeFor<{
  policy: NotificationDeliveryPolicySavedRow;
}>({
  policy: { templateName: true, mode: true, updatedAt: true },
});

/** The officer's alerts as they will actually be sent, after the area mask. */
export interface AdminNotificationPreferencesAnswer {
  memberId: string;
  preferences: Record<string, boolean>;
}

export const ADMIN_NOTIFICATION_PREFERENCES_CONNECTION_SHAPE = connectionShapeFor<AdminNotificationPreferencesAnswer>({
  memberId: true,
  preferences: eachEntry(true),
});

// ---------------------------------------------------------------------------
// Delivery suppressions and failed emails
// ---------------------------------------------------------------------------

type EmailDeliverability = Awaited<ReturnType<typeof getEmailDeliverabilityTelemetry>>;

const EMAIL_SUPPRESSION_SHAPE = {
  id: true,
  email: true,
  reason: true,
  eventCount: true,
  suppressedAt: true,
  lastEventAt: true,
  lastEventType: true,
  lastBounceType: true,
  lastBounceSubType: true,
  lastComplaintFeedbackType: true,
} as const satisfies ConnectionShapeFor<EmailDeliverability["suppressions"][number]>;

export const EMAIL_SUPPRESSION_LIST_CONNECTION_SHAPE = connectionShapeFor<EmailDeliverability>({
  summary: { activeCount: true, bounceCount: true, complaintCount: true, eventsLast24h: true },
  suppressions: EMAIL_SUPPRESSION_SHAPE,
});

/** The clear route's answer. */
export interface EmailSuppressionClearedAnswer {
  success: boolean;
  suppression: { id: string; email: string; clearedAt: string | null };
}

export const EMAIL_SUPPRESSION_CLEARED_CONNECTION_SHAPE = connectionShapeFor<EmailSuppressionClearedAnswer>({
  success: true,
  suppression: { id: true, email: true, clearedAt: true },
});

type EmailFailureQueue = Awaited<ReturnType<typeof getExhaustedEmailFailureReviewQueue>>;

/** A failed email as the health report lists it, for the retry and dismiss actions. */
export const EMAIL_FAILURE_SHAPE = {
  id: true,
  to: true,
  subject: true,
  templateName: true,
  attempts: true,
  lastAttemptAt: true,
  errorMessage: true,
  createdAt: true,
  bookingId: true,
  bookingExists: true,
  recovery: true,
  reviewedAt: true,
  reviewNote: true,
} as const satisfies ConnectionShapeFor<EmailFailureQueue["failures"][number]>;

/** The answer to retrying a failed email: handed back to the retry job. */
export interface EmailFailureRequeuedAnswer {
  id: string;
  requeued: boolean;
}

export const EMAIL_FAILURE_REQUEUED_CONNECTION_SHAPE = connectionShapeFor<EmailFailureRequeuedAnswer>({
  id: true,
  requeued: true,
});

/** The answer to dismissing a failed email. */
export interface EmailFailureReviewedAnswer {
  id: string;
  reviewed: boolean;
  reason: string;
}

export const EMAIL_FAILURE_REVIEWED_CONNECTION_SHAPE = connectionShapeFor<EmailFailureReviewedAnswer>({
  id: true,
  reviewed: true,
  reason: true,
});
