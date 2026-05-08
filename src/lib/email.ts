import nodemailer from "nodemailer";
import {
  welcomeTemplate,
  passwordResetTemplate,
  bookingConfirmedTemplate,
  bookingPendingTemplate,
  bookingBumpedTemplate,
  bookingCancelledTemplate,
  choreRosterTemplate,
  hutLeaderAssignmentTemplate,
  emailVerificationTemplate,
  emailChangeVerificationTemplate,
  emailChangeNotificationTemplate,
  nominationRequestTemplate,
  adminMembershipApplicationPendingTemplate,
  membershipApplicationApprovedTemplate,
  membershipApplicationRejectedTemplate,
  checkinReminderTemplate,
  adminNewBookingTemplate,
  adminPaymentFailureTemplate,
  adminPendingDeadlineTemplate,
  adminBookingBumpedTemplate,
  adminXeroSyncErrorTemplate,
  adminXeroRepeatedFailureTemplate,
  adminCapacityWarningTemplate,
  adminDailyDigestTemplate,
  adminXeroReconciliationReportTemplate,
  adminPasswordResetTemplate,
  memberSetupInviteTemplate,
  bookingModifiedTemplate,
  accountDeletionApprovedTemplate,
  accountDeletionRejectedTemplate,
  ageUpInvitationTemplate,
  familyGroupInvitationTemplate,
  familyGroupInviteAcceptedTemplate,
  childRequestSubmittedTemplate,
  childRequestApprovedTemplate,
  childRequestRejectedTemplate,
  setupIntentFailedTemplate,
  waitlistConfirmationTemplate,
  waitlistOfferTemplate,
  waitlistOfferExpiredTemplate,
  adminWaitlistOfferTemplate,
  adminFamilyGroupRequestTemplate,
  joinRequestConfirmationTemplate,
  adminRefundRequestTemplate,
  adminIssueReportTemplate,
} from "./email-templates";
import { MEMBER_SETUP_INVITE_TTL_DAYS } from "./member-setup-invite";
import {
  ADMIN_NOTIFICATION_PREFERENCE_SELECT,
  type AdminNotificationPreferenceKey,
  resolveAdminNotificationPreferences,
} from "./admin-notification-preferences";
import { EMAIL_FROM, formatEmailFromAddress } from "./email-sender";
import { htmlToPlainText } from "./email-text";
import logger from "@/lib/logger";
import { prisma } from "@/lib/prisma";
import {
  EMAIL_CHANGE_TTL_MS,
  EMAIL_VERIFICATION_TTL_MS,
} from "@/lib/verification-tokens";
import {
  getActiveEmailSuppression,
  normalizeEmailAddress,
  recordSesEmailFeedback,
  type SesEmailFeedbackEvent,
} from "@/lib/email-suppression";

type EmailAttachment = {
  filename: string;
  content: Buffer;
  contentType?: string;
};

const transporter = nodemailer.createTransport({
  host: process.env.SMTP_HOST || "email-smtp.ap-southeast-2.amazonaws.com",
  port: Number(process.env.SMTP_PORT) || 587,
  secure: false,
  auth: {
    user: process.env.AWS_SES_ACCESS_KEY_ID || "",
    pass: process.env.AWS_SES_SECRET_ACCESS_KEY || "",
  },
});

// Token-bearing emails should never persist their rendered HTML in logs or retry
// tables because that would retain live reset/verification links at rest.
const SENSITIVE_EMAIL_LOG_TEMPLATES = new Set([
  "password-reset",
  "admin-password-reset",
  "member-setup-invite",
  "email-verification",
  "email-change-verification",
  "age-up-invitation",
  "nomination-request",
  "membership-application-approved",
  "hut-leader-assignment",
]);

// Failure-alert emails should also skip HTML retention so a broken admin
// mailbox or SMTP path cannot recurse into retrying the retry-failure alert.
const NON_RETRYABLE_EMAIL_LOG_TEMPLATES = new Set([
  ...SENSITIVE_EMAIL_LOG_TEMPLATES,
  "admin-email-failure",
]);

function shouldPersistEmailHtml(templateName: string): boolean {
  return !NON_RETRYABLE_EMAIL_LOG_TEMPLATES.has(templateName);
}

export async function sendEmail({
  to,
  subject,
  html,
  text,
  templateName = "unknown",
  attachments,
}: {
  to: string;
  subject: string;
  html: string;
  text?: string;
  templateName?: string;
  attachments?: EmailAttachment[];
}) {
  const persistHtmlBody = shouldPersistEmailHtml(templateName);
  const plainTextBody = text || htmlToPlainText(html);
  const normalizedRecipient = normalizeEmailAddress(to);

  // Create EmailLog record (fire-and-forget logging won't break email delivery)
  let emailLogId: string | null = null;
  try {
    const log = await prisma.emailLog.create({
      data: {
        to,
        subject,
        templateName,
        htmlBody: persistHtmlBody ? html : null,
        status: "QUEUED",
        lastAttemptAt: new Date(),
      },
    });
    emailLogId = log.id;
  } catch (err) {
    logger.error({ err }, "Failed to create EmailLog record");
  }

  const activeSuppression = await getActiveEmailSuppression(normalizedRecipient).catch(
    (err) => {
      logger.error(
        { err, to: normalizedRecipient, templateName },
        "Failed to check email suppression state"
      );
      return null;
    }
  );

  if (activeSuppression) {
    if (emailLogId) {
      try {
        await prisma.emailLog.update({
          where: { id: emailLogId },
          data: {
            status: "BOUNCED",
            htmlBody: null,
            errorMessage: `Email suppressed after SES ${activeSuppression.reason.toLowerCase()} feedback`,
          },
        });
      } catch (err) {
        logger.error({ err, to: normalizedRecipient }, "Failed to update suppressed email log");
      }
    }

    logger.warn(
      {
        to: normalizedRecipient,
        templateName,
        emailSuppressionId: activeSuppression.id,
        reason: activeSuppression.reason,
      },
      "Skipped email to suppressed recipient"
    );
    return;
  }

  if (process.env.NODE_ENV === "development") {
    logger.info({ to, subject, templateName }, "Email sent (dev mode)");
    if (persistHtmlBody) {
      logger.debug({ html }, "Email HTML content");
    } else {
      logger.debug({ templateName }, "Email HTML content redacted for sensitive template");
    }
    // Mark as SENT in dev mode
    if (emailLogId) {
      try {
        await prisma.emailLog.update({
          where: { id: emailLogId },
          data: { status: "SENT", sentAt: new Date() },
        });
      } catch (err) {
        logger.error({ err, to, templateName }, "Failed to update EmailLog");
      }
    }
    return;
  }

  try {
    const result = await transporter.sendMail({
      from: formatEmailFromAddress(EMAIL_FROM),
      to,
      subject,
      html,
      text: plainTextBody,
      attachments,
    });

    // Update EmailLog to SENT
    if (emailLogId) {
      try {
        await prisma.emailLog.update({
          where: { id: emailLogId },
          data: {
            status: "SENT",
            sentAt: new Date(),
            messageId: result.messageId || null,
          },
        });
      } catch (err) {
        logger.error({ err }, "Failed to update EmailLog to SENT");
      }
    }
  } catch (err) {
    // Update EmailLog to FAILED
    if (emailLogId) {
      try {
        await prisma.emailLog.update({
          where: { id: emailLogId },
          data: {
            status: "FAILED",
            errorMessage: err instanceof Error ? err.message : String(err),
          },
        });
      } catch (logErr) {
        logger.error({ err: logErr }, "Failed to update EmailLog to FAILED");
      }
    }
    if (!persistHtmlBody) {
      logger.warn(
        { templateName },
        "Sensitive email delivery failed and cannot be automatically retried because HTML retention is disabled"
      );
    }
    throw err;
  }
}

/** Get all active admin emails */
export async function getAdminEmails(): Promise<string[]> {
  const admins = await prisma.member.findMany({
    where: { role: "ADMIN", active: true },
    select: { email: true },
  });
  return admins.map((a) => a.email);
}

async function getAdminAlertEmails(
  preferenceKey: AdminNotificationPreferenceKey
): Promise<string[]> {
  const admins = await prisma.member.findMany({
    where: { role: "ADMIN", active: true },
    select: {
      email: true,
      notificationPreference: {
        select: ADMIN_NOTIFICATION_PREFERENCE_SELECT,
      },
    },
  });

  return admins
    .filter(
      (admin) =>
        resolveAdminNotificationPreferences(admin.notificationPreference)[
          preferenceKey
        ]
    )
    .map((admin) => admin.email);
}

/** Send an email to all active admins (fire-and-forget) */
async function sendToAdmins({
  subject,
  html,
  templateName,
  preferenceKey,
  attachments,
}: {
  subject: string;
  html: string;
  templateName: string;
  preferenceKey: AdminNotificationPreferenceKey;
  attachments?: EmailAttachment[];
}) {
  const emails = await getAdminAlertEmails(preferenceKey);
  for (const email of emails) {
    sendEmail({ to: email, subject, html, templateName, attachments }).catch((err) =>
      logger.error({ err, to: email, templateName }, "Failed to send admin alert")
    );
  }
}

export async function sendPasswordResetEmail(
  email: string,
  token: string
) {
  const baseUrl = process.env.NEXTAUTH_URL || "http://localhost:3000";
  const resetUrl = `${baseUrl}/reset-password?token=${token}`;

  await sendEmail({
    to: email,
    subject: "Reset your Tokoroa Alpine Club password",
    html: passwordResetTemplate(resetUrl),
    templateName: "password-reset",
  });
}

export async function sendAdminPasswordResetEmail(
  email: string,
  token: string,
  expiryLabel = "1 hour"
) {
  const baseUrl = process.env.NEXTAUTH_URL || "http://localhost:3000";
  const resetUrl = `${baseUrl}/reset-password?token=${token}`;

  await sendEmail({
    to: email,
    subject: "Reset your Tokoroa Alpine Club password",
    html: adminPasswordResetTemplate(resetUrl, expiryLabel),
    templateName: "admin-password-reset",
  });
}

export async function sendMemberSetupInviteEmail(
  email: string,
  firstName: string,
  token: string
) {
  const baseUrl = process.env.NEXTAUTH_URL || "http://localhost:3000";
  const resetUrl = `${baseUrl}/reset-password?token=${token}`;

  await sendEmail({
    to: email,
    subject: `Set up your Tokoroa Alpine Club account (${MEMBER_SETUP_INVITE_TTL_DAYS}-day link)`,
    html: memberSetupInviteTemplate(firstName, resetUrl),
    templateName: "member-setup-invite",
  });
}

export async function sendBookingConfirmedEmail(
  email: string,
  firstName: string,
  checkIn: Date,
  checkOut: Date,
  guestCount: number,
  totalCents: number,
  options?: { discountCents?: number; promoCode?: string }
) {
  await sendEmail({
    to: email,
    subject: "Booking Confirmed - Tokoroa Alpine Club Lodge",
    html: bookingConfirmedTemplate(firstName, checkIn, checkOut, guestCount, totalCents, options),
    templateName: "booking-confirmed",
  });
}

export async function sendBookingPendingEmail(
  email: string,
  firstName: string,
  checkIn: Date,
  checkOut: Date,
  guestCount: number,
  holdUntil: Date
) {
  await sendEmail({
    to: email,
    subject: "Booking Pending - Tokoroa Alpine Club Lodge",
    html: bookingPendingTemplate(firstName, checkIn, checkOut, guestCount, holdUntil),
    templateName: "booking-pending",
  });
}

export async function sendBookingBumpedEmail(
  email: string,
  firstName: string,
  checkIn: Date,
  checkOut: Date,
  guestCount: number
) {
  await sendEmail({
    to: email,
    subject: "Booking Update - Tokoroa Alpine Club Lodge",
    html: bookingBumpedTemplate(firstName, checkIn, checkOut, guestCount),
    templateName: "booking-bumped",
  });
}

export async function sendBookingCancelledEmail(
  email: string,
  firstName: string,
  checkIn: Date,
  checkOut: Date,
  refundCents: number,
  refundMethod: "card" | "credit" = "card"
) {
  await sendEmail({
    to: email,
    subject: "Booking Cancelled - Tokoroa Alpine Club Lodge",
    html: bookingCancelledTemplate(firstName, checkIn, checkOut, refundCents, refundMethod),
    templateName: "booking-cancelled",
  });
}

export async function sendChoreRosterEmail(
  email: string,
  guestName: string,
  date: string,
  chores: Array<{ name: string; description: string | null }>,
  choreLink?: string
) {
  const formattedDate = new Date(date + "T00:00:00").toLocaleDateString("en-NZ", {
    weekday: "long",
    year: "numeric",
    month: "long",
    day: "numeric",
  });

  await sendEmail({
    to: email,
    subject: `Your chore roster for ${formattedDate} - Tokoroa Alpine Club Lodge`,
    html: choreRosterTemplate(guestName, date, chores, choreLink),
    templateName: "chore-roster",
  });
}

export async function sendHutLeaderAssignmentEmail(params: {
  email: string;
  firstName: string;
  startDate: Date;
  endDate: Date;
  pin: string;
}) {
  await sendEmail({
    to: params.email,
    subject: "Your Tokoroa Alpine Club hut leader assignment",
    html: hutLeaderAssignmentTemplate(params),
    templateName: "hut-leader-assignment",
  });
}

export async function sendWelcomeEmail(email: string, firstName: string) {
  await sendEmail({
    to: email,
    subject: "Welcome to Tokoroa Alpine Club - Bookings",
    html: welcomeTemplate(firstName),
    templateName: "welcome",
  });
}

export async function sendVerificationEmail(email: string, firstName: string, token: string) {
  const baseUrl = process.env.NEXTAUTH_URL || "http://localhost:3000";
  const verifyUrl = `${baseUrl}/verify-email?token=${token}`;
  const expiresAt = new Date(Date.now() + EMAIL_VERIFICATION_TTL_MS);

  await sendEmail({
    to: email,
    subject: "Verify your email — Tokoroa Alpine Club - Bookings",
    html: emailVerificationTemplate(firstName, verifyUrl, expiresAt),
    templateName: "email-verification",
  });
}

export async function sendNominationRequestEmail(params: {
  email: string;
  nominatorName: string;
  applicantName: string;
  token: string;
  familyMemberCount: number;
  expiresAt: Date;
}) {
  const baseUrl = process.env.NEXTAUTH_URL || "http://localhost:3000";
  const reviewUrl = `${baseUrl}/nominations/${params.token}`;

  await sendEmail({
    to: params.email,
    subject: `Nomination request for ${params.applicantName} — Tokoroa Alpine Club`,
    html: nominationRequestTemplate({
      nominatorName: params.nominatorName,
      applicantName: params.applicantName,
      reviewUrl,
      familyMemberCount: params.familyMemberCount,
      expiresAt: params.expiresAt,
    }),
    templateName: "nomination-request",
  });
}

export async function sendMembershipApplicationApprovedEmail(params: {
  email: string;
  firstName: string;
  token: string;
  adminNotes?: string | null;
}) {
  const baseUrl = process.env.NEXTAUTH_URL || "http://localhost:3000";
  const resetUrl = `${baseUrl}/reset-password?token=${params.token}`;

  await sendEmail({
    to: params.email,
    subject: "Your Tokoroa Alpine Club membership has been approved",
    html: membershipApplicationApprovedTemplate(
      params.firstName,
      resetUrl,
      params.adminNotes
    ),
    templateName: "membership-application-approved",
  });
}

export async function sendMembershipApplicationRejectedEmail(params: {
  email: string;
  firstName: string;
  adminNotes?: string | null;
}) {
  await sendEmail({
    to: params.email,
    subject: "Update on your Tokoroa Alpine Club membership application",
    html: membershipApplicationRejectedTemplate(
      params.firstName,
      params.adminNotes
    ),
    templateName: "membership-application-rejected",
  });
}

export async function sendAdminMembershipApplicationPendingEmail(data: {
  applicationId: string;
  applicantName: string;
  applicantEmail: string;
  familyMemberCount: number;
}) {
  const baseUrl = process.env.NEXTAUTH_URL || "http://localhost:3000";
  const reviewUrl = `${baseUrl}/admin/member-applications`;

  await sendToAdmins({
    subject: `Membership application ready: ${data.applicantName}`,
    html: adminMembershipApplicationPendingTemplate({
      applicantName: data.applicantName,
      applicantEmail: data.applicantEmail,
      familyMemberCount: data.familyMemberCount,
      reviewUrl,
    }),
    templateName: "admin-membership-application-pending",
    // Shared request-alert category: membership applications + family-group requests.
    preferenceKey: "adminFamilyGroupRequest",
  });
}

export async function sendEmailChangeVerification(newEmail: string, token: string) {
  const baseUrl = process.env.NEXTAUTH_URL || "http://localhost:3000";
  const verifyUrl = `${baseUrl}/confirm-email-change?token=${token}`;
  const expiresAt = new Date(Date.now() + EMAIL_CHANGE_TTL_MS);

  await sendEmail({
    to: newEmail,
    subject: "Confirm your new email — Tokoroa Alpine Club - Bookings",
    html: emailChangeVerificationTemplate(newEmail, verifyUrl, expiresAt),
    templateName: "email-change-verification",
  });
}

type SesSnsNotification = {
  Type?: string;
  Message?: string;
  notificationType?: string;
  bounce?: {
    bounceType?: string;
    bounceSubType?: string;
    bouncedRecipients?: Array<{ emailAddress?: string }>;
  };
  complaint?: {
    complaintFeedbackType?: string;
    complainedRecipients?: Array<{ emailAddress?: string }>;
  };
  mail?: {
    destination?: string[];
    messageId?: string;
  };
};

function parseSesSnsNotification(payload: unknown): SesSnsNotification | null {
  if (!payload || typeof payload !== "object") {
    return null;
  }

  const envelope = payload as SesSnsNotification;
  if (typeof envelope.Message === "string") {
    try {
      return parseSesSnsNotification(JSON.parse(envelope.Message));
    } catch {
      return null;
    }
  }

  return envelope;
}

function getSesFeedbackRecipients(
  notification: SesSnsNotification,
  kind: "bounce" | "complaint"
) {
  const recipients =
    kind === "bounce"
      ? notification.bounce?.bouncedRecipients?.map(
          (entry) => entry.emailAddress
        )
      : notification.complaint?.complainedRecipients?.map(
          (entry) => entry.emailAddress
        );

  return (recipients ?? notification.mail?.destination ?? []).filter(
    (email): email is string => Boolean(email)
  );
}

export async function ingestSesSnsEmailFeedback(payload: unknown) {
  const notification = parseSesSnsNotification(payload);
  if (!notification) {
    return { handled: false as const };
  }
  const notificationType = notification.notificationType?.toLowerCase();
  if (notificationType !== "bounce" && notificationType !== "complaint") {
    return { handled: false as const };
  }

  const recipients = getSesFeedbackRecipients(notification, notificationType);
  if (recipients.length === 0) {
    return { handled: false as const };
  }
  const normalizedRecipients = recipients.map(normalizeEmailAddress);
  const logRecipients = Array.from(new Set([...recipients, ...normalizedRecipients]));

  await prisma.emailLog.updateMany({
    where: {
      to: { in: logRecipients },
      status: { in: ["QUEUED", "SENT", "FAILED"] },
    },
    data: {
      status: "BOUNCED",
      errorMessage: `SES ${notificationType} received via SNS`,
    },
  });

  const suppressionResult = await recordSesEmailFeedback(
    normalizedRecipients.map(
      (email): SesEmailFeedbackEvent => ({
        email,
        reason: notificationType === "complaint" ? "COMPLAINT" : "BOUNCE",
        eventType: notificationType,
        sesMessageId: notification.mail?.messageId ?? null,
        bounceType: notification.bounce?.bounceType ?? null,
        bounceSubType: notification.bounce?.bounceSubType ?? null,
        complaintFeedbackType:
          notification.complaint?.complaintFeedbackType ?? null,
      })
    )
  );

  logger.warn(
    {
      sesNotificationType: notificationType,
      sesMessageId: notification.mail?.messageId ?? null,
      recipients: normalizedRecipients,
      suppressionsProcessed: suppressionResult.processed,
      suppressionsActive: suppressionResult.suppressed,
    },
    "Processed SES/SNS email delivery feedback"
  );

  return {
    handled: true as const,
    notificationType,
    recipients: normalizedRecipients,
    suppressionsProcessed: suppressionResult.processed,
    suppressionsActive: suppressionResult.suppressed,
  };
}

export async function sendEmailChangeNotification(oldEmail: string, newEmail: string) {
  await sendEmail({
    to: oldEmail,
    subject: "Email change requested — Tokoroa Alpine Club - Bookings",
    html: emailChangeNotificationTemplate(newEmail),
    templateName: "email-change-notification",
  });
}

// N-01: Check-in reminder
export async function sendCheckinReminderEmail(
  email: string,
  firstName: string,
  checkIn: Date,
  checkOut: Date,
  guests: Array<{ firstName: string; lastName: string }>,
  chores: Array<{ name: string; description: string | null }>
) {
  await sendEmail({
    to: email,
    subject: "Check-in Reminder - Tokoroa Alpine Club Lodge",
    html: checkinReminderTemplate(firstName, checkIn, checkOut, guests, chores),
    templateName: "checkin-reminder",
  });
}

// N-02: Admin alert - new booking
export async function sendAdminNewBookingAlert(data: {
  memberName: string;
  checkIn: Date;
  checkOut: Date;
  guestCount: number;
  totalCents: number;
  status: string;
  reviewReason?: string | null;
}) {
  await sendToAdmins({
    subject: data.reviewReason
      ? `Booking Review Required: ${data.memberName}`
      : `New Booking: ${data.memberName} (${data.status})`,
    html: adminNewBookingTemplate(data),
    templateName: "admin-new-booking",
    preferenceKey: "adminNewBooking",
  });
}

// N-04: Admin alert - payment failure
export async function sendAdminPaymentFailureAlert(data: {
  memberName: string;
  checkIn: Date;
  checkOut: Date;
  amountCents: number;
  errorMessage: string;
  paymentIntentId: string;
}) {
  await sendToAdmins({
    subject: "Payment Failed — Tokoroa Alpine Club - Bookings",
    html: adminPaymentFailureTemplate(data),
    templateName: "admin-payment-failure",
    preferenceKey: "adminPaymentFailure",
  });
}

// N-06: Admin alert - pending approaching deadline (digest)
export async function sendAdminPendingDeadlineAlert(bookings: Array<{
  memberName: string;
  checkIn: Date;
  checkOut: Date;
  guestCount: number;
  deadline: Date;
  hoursRemaining: number;
}>) {
  await sendToAdmins({
    subject: `${bookings.length} Pending Booking${bookings.length > 1 ? "s" : ""} Approaching Deadline`,
    html: adminPendingDeadlineTemplate(bookings),
    templateName: "admin-pending-deadline",
    preferenceKey: "adminPendingDeadline",
  });
}

// N-07: Admin alert - booking bumped
export async function sendAdminBookingBumpedAlert(data: {
  bumpedMemberName: string;
  checkIn: Date;
  checkOut: Date;
  guestCount: number;
  triggeringMemberName: string;
}) {
  await sendToAdmins({
    subject: `Booking Bumped: ${data.bumpedMemberName}`,
    html: adminBookingBumpedTemplate(data),
    templateName: "admin-booking-bumped",
    preferenceKey: "adminBookingBumped",
  });
}

// N-05: Admin alert - Xero sync error
export async function sendAdminXeroSyncErrorAlert(data: {
  errorType: string;
  operation: string;
  errorMessage: string;
  timestamp: Date;
}) {
  await sendToAdmins({
    subject: "Xero Sync Error — Tokoroa Alpine Club - Bookings",
    html: adminXeroSyncErrorTemplate(data),
    templateName: "admin-xero-sync-error",
    preferenceKey: "adminXeroSyncError",
  });
}

export async function sendAdminXeroRepeatedFailureAlert(data: {
  subject: string;
  correlationKey: string;
  failureCount: number;
  windowHours: number;
  entityType: string;
  operationType: string;
  localModel: string | null;
  localId: string | null;
  localUrl: string | null;
  xeroObjectUrl: string | null;
  latestErrorMessage: string | null;
  timestamp: Date;
}) {
  await sendToAdmins({
    subject: data.subject,
    html: adminXeroRepeatedFailureTemplate(data),
    templateName: "admin-xero-repeated-failure",
    preferenceKey: "adminXeroSyncError",
  });
}

// N-03: Admin alert - capacity warning
export async function sendAdminCapacityWarningAlert(days: Array<{
  date: Date;
  occupiedBeds: number;
  availableBeds: number;
}>) {
  await sendToAdmins({
    subject: `Capacity Warning: ${days.length} high-occupancy day${days.length > 1 ? "s" : ""} ahead`,
    html: adminCapacityWarningTemplate(days),
    templateName: "admin-capacity-warning",
    preferenceKey: "adminCapacityWarning",
  });
}

// N-13: Admin daily digest
export async function sendAdminDailyDigestAlert(sections: {
  newBookings: number;
  paymentFailures: number;
  capacityWarnings: number;
  bookingsBumped: number;
  pendingDeadlines: number;
  xeroErrors: number;
  totalAlerts: number;
}) {
  await sendToAdmins({
    subject: `Admin Daily Digest - ${sections.totalAlerts} alert${sections.totalAlerts !== 1 ? "s" : ""} in past 24h`,
    html: adminDailyDigestTemplate(sections),
    templateName: "admin-daily-digest",
    preferenceKey: "adminDailyDigest",
  });
}

export async function sendAdminXeroReconciliationReportAlert(report: {
  generatedAt: Date;
  lookbackHours: number;
  stalePendingMinutes: number;
  summary: {
    missingMemberContactLinks: number;
    missingPaymentInvoiceLinks: number;
    missingPaymentRefundCreditNoteLinks: number;
    missingSubscriptionInvoiceLinks: number;
    mismatchedCanonicalLinks: number;
    staleCanonicalLinks: number;
    duplicateActiveCanonicalLinks: number;
    stalePendingOperations: number;
    recentFailedOperations: number;
    recentPartialOperations: number;
    unsupportedPartialOperations: number;
    repeatedFailureCorrelations: number;
    issueCategoryCount: number;
    issueTotalCount: number;
  };
  repeatedFailures: Array<{
    correlationKey: string;
    failureCount: number;
    entityType: string;
    operationType: string;
    localModel: string | null;
    localId: string | null;
    localUrl: string | null;
    latestErrorMessage: string | null;
  }>;
  unsupportedPartials: Array<{
    operationId: string;
    entityType: string;
    operationType: string;
    localModel: string | null;
    localId: string | null;
    localUrl: string | null;
    reason: string;
    createdAt: Date;
  }>;
}) {
  const subject =
    report.summary.issueCategoryCount === 0
      ? "Xero Reconciliation Report - clean"
      : `Xero Reconciliation Report - ${report.summary.issueCategoryCount} issue categor${report.summary.issueCategoryCount === 1 ? "y" : "ies"}, ${report.summary.issueTotalCount} item${report.summary.issueTotalCount === 1 ? "" : "s"}`;

  await sendToAdmins({
    subject,
    html: adminXeroReconciliationReportTemplate(report),
    templateName: "admin-xero-reconciliation-report",
    preferenceKey: "adminXeroSyncError",
  });
}

/**
 * N-08: Check notification preferences before sending a member email.
 * Maps template categories to preference fields.
 * Admin alerts bypass preferences entirely.
 */
const CATEGORY_TO_PREFERENCE: Record<string, keyof Omit<
  import("@prisma/client").NotificationPreference,
  "id" | "memberId" | "createdAt" | "updatedAt"
>> = {
  bookingConfirmation: "bookingConfirmation",
  bookingReminder: "bookingReminder",
  bookingBumped: "bookingBumped",
  bookingCancelled: "bookingCancelled",
  choreRoster: "choreRoster",
  bookingWaitlist: "bookingWaitlist",
  marketingEmails: "marketingEmails",
};

export async function shouldSendEmail(
  memberId: string,
  category: string
): Promise<boolean> {
  const prefField = CATEGORY_TO_PREFERENCE[category];
  if (!prefField) {
    // Unknown category — default to sending
    return true;
  }

  const pref = await prisma.notificationPreference.findUnique({
    where: { memberId },
  });

  if (!pref) {
    // No preference record = defaults (all true except marketingEmails)
    return category !== "marketingEmails";
  }

  return Boolean(pref[prefField]);
}

// F-COMP-04: Account deletion approved
export async function sendAccountDeletionApprovedEmail(
  email: string,
  firstName: string
) {
  await sendEmail({
    to: email,
    subject: "Your Account Deletion Request Has Been Processed",
    html: accountDeletionApprovedTemplate(firstName),
    templateName: "account-deletion-approved",
  });
}

// F-COMP-04: Account deletion rejected
export async function sendAccountDeletionRejectedEmail(
  email: string,
  firstName: string,
  adminNote: string
) {
  await sendEmail({
    to: email,
    subject: "Update on Your Account Deletion Request",
    html: accountDeletionRejectedTemplate(firstName, adminNote),
    templateName: "account-deletion-rejected",
  });
}

// ---- Family group emails ----

export async function sendFamilyGroupInvitationEmail(
  email: string,
  inviterName: string,
  groupName: string
) {
  const baseUrl = process.env.NEXTAUTH_URL || "http://localhost:3000";
  const profileUrl = `${baseUrl}/profile`;

  await sendEmail({
    to: email,
    subject: `${inviterName} invited you to join ${groupName} — Tokoroa Alpine Club - Bookings`,
    html: familyGroupInvitationTemplate(inviterName, groupName, profileUrl),
    templateName: "family-group-invitation",
  });
}

export async function sendFamilyGroupInviteAcceptedEmail(
  email: string,
  inviteeName: string,
  groupName: string
) {
  await sendEmail({
    to: email,
    subject: `${inviteeName} has joined ${groupName} — Tokoroa Alpine Club - Bookings`,
    html: familyGroupInviteAcceptedTemplate(inviteeName, groupName),
    templateName: "family-group-invite-accepted",
  });
}

export async function sendChildRequestSubmittedEmail(
  email: string,
  parentName: string,
  childName: string,
  groupName: string
) {
  await sendEmail({
    to: email,
    subject: "Child/Youth request submitted — Tokoroa Alpine Club - Bookings",
    html: childRequestSubmittedTemplate(parentName, childName, groupName),
    templateName: "child-request-submitted",
  });
}

export async function sendChildRequestApprovedEmail(
  email: string,
  parentName: string,
  childName: string,
  groupName: string
) {
  await sendEmail({
    to: email,
    subject: `${childName} has been added to ${groupName} — Tokoroa Alpine Club - Bookings`,
    html: childRequestApprovedTemplate(parentName, childName, groupName),
    templateName: "child-request-approved",
  });
}

export async function sendChildRequestRejectedEmail(
  email: string,
  parentName: string,
  childName: string,
  reason?: string
) {
  await sendEmail({
    to: email,
    subject: "Child/Youth request update — Tokoroa Alpine Club - Bookings",
    html: childRequestRejectedTemplate(parentName, childName, reason),
    templateName: "child-request-rejected",
  });
}

// Shared request-alert category for family-group requests and membership applications.
export async function sendAdminFamilyGroupRequestAlert(data: {
  requestType: string;
  requesterName: string;
  groupName: string;
  details: string;
}) {
  await sendToAdmins({
    subject: `Family Group Request: ${data.requesterName} (${data.requestType})`,
    html: adminFamilyGroupRequestTemplate(data),
    templateName: "admin-family-group-request",
    preferenceKey: "adminFamilyGroupRequest",
  });
}

// P3.4: Confirmation email to requester on join request
export async function sendJoinRequestConfirmationEmail(
  email: string,
  requesterName: string,
  groupName: string
) {
  await sendEmail({
    to: email,
    subject: "Join request submitted — Tokoroa Alpine Club - Bookings",
    html: joinRequestConfirmationTemplate(requesterName, groupName),
    templateName: "join-request-confirmation",
  });
}

// Age-up invitation email (sent when youth turns 18)
export async function sendAgeUpInvitationEmail(
  email: string,
  firstName: string,
  token: string
) {
  const baseUrl = process.env.NEXTAUTH_URL || "http://localhost:3000";
  const resetUrl = `${baseUrl}/reset-password?token=${token}`;

  await sendEmail({
    to: email,
    subject: "You're 18! Set up your Tokoroa Alpine Club account",
    html: ageUpInvitationTemplate(firstName, resetUrl),
    templateName: "age-up-invitation",
  });
}

// EML-01: Booking modified email
export async function sendBookingModifiedEmail(params: {
  email: string;
  firstName: string;
  modificationType: string;
  oldCheckIn: Date;
  oldCheckOut: Date;
  newCheckIn: Date;
  newCheckOut: Date;
  oldGuestCount: number;
  newGuestCount: number;
  oldFinalPriceCents: number;
  newFinalPriceCents: number;
  changeFeeCents: number;
  refundAmountCents: number;
  additionalAmountCents: number;
}) {
  await sendEmail({
    to: params.email,
    subject: "Booking Modified - Tokoroa Alpine Club Lodge",
    html: bookingModifiedTemplate(params),
    templateName: "booking-modified",
  });
}

export async function sendSetupIntentFailedEmail(params: {
  email: string;
  firstName: string;
  checkIn: Date;
  checkOut: Date;
}) {
  await sendEmail({
    to: params.email,
    subject: "Card Setup Failed - Tokoroa Alpine Club Lodge",
    html: setupIntentFailedTemplate(params),
    templateName: "setup-intent-failed",
  });
}

// ---- Waitlist emails ----

export async function sendWaitlistConfirmationEmail(
  email: string,
  firstName: string,
  checkIn: Date,
  checkOut: Date,
  guestCount: number,
  position: number
) {
  await sendEmail({
    to: email,
    subject: "Waitlist Confirmation - Tokoroa Alpine Club Lodge",
    html: waitlistConfirmationTemplate(firstName, checkIn, checkOut, guestCount, position),
    templateName: "waitlist-confirmation",
  });
}

export async function sendWaitlistOfferEmail(
  email: string,
  firstName: string,
  checkIn: Date,
  checkOut: Date,
  guestCount: number,
  expiresAt: Date,
  bookingId: string
) {
  await sendEmail({
    to: email,
    subject: "Spot Available! - Tokoroa Alpine Club Lodge",
    html: waitlistOfferTemplate(firstName, checkIn, checkOut, guestCount, expiresAt, bookingId),
    templateName: "waitlist-offer",
  });
}

export async function sendWaitlistOfferExpiredEmail(
  email: string,
  firstName: string,
  checkIn: Date,
  checkOut: Date,
  position: number
) {
  await sendEmail({
    to: email,
    subject: "Waitlist Offer Expired - Tokoroa Alpine Club Lodge",
    html: waitlistOfferExpiredTemplate(firstName, checkIn, checkOut, position),
    templateName: "waitlist-offer-expired",
  });
}

export async function sendAdminWaitlistOfferAlert(data: {
  memberName: string;
  checkIn: Date;
  checkOut: Date;
  guestCount: number;
  position: number;
}) {
  await sendToAdmins({
    subject: `Waitlist Offer: ${data.memberName}`,
    html: adminWaitlistOfferTemplate(data),
    templateName: "admin-waitlist-offer",
    preferenceKey: "adminWaitlistOffer",
  });
}

export async function sendAdminRefundRequestAlert(data: {
  memberName: string;
  bookingId: string;
  checkIn: Date;
  checkOut: Date;
  reason: string;
  requestedAmountCents: number | null;
  paidAmountCents: number;
  refundedAmountCents: number;
}) {
  await sendToAdmins({
    subject: `Refund Appeal: ${data.memberName}`,
    html: adminRefundRequestTemplate(data),
    templateName: "admin-refund-request",
    preferenceKey: "adminRefundRequest",
  });
}

export async function sendAdminIssueReportAlert(data: {
  memberName: string;
  memberEmail: string;
  pageUrl: string;
  pageTitle?: string | null;
  description: string;
  screenshot?: EmailAttachment | null;
}) {
  await sendToAdmins({
    subject: `Issue Report: ${data.memberName}`,
    html: adminIssueReportTemplate({
      memberName: data.memberName,
      memberEmail: data.memberEmail,
      pageUrl: data.pageUrl,
      pageTitle: data.pageTitle,
      description: data.description,
      hasScreenshot: Boolean(data.screenshot),
    }),
    templateName: "admin-issue-report",
    preferenceKey: "adminIssueReport",
    attachments: data.screenshot ? [data.screenshot] : undefined,
  });
}
