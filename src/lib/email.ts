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
  ageUpParentEmailHandoffTemplate,
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
  membershipCancellationSubmittedTemplate,
  membershipCancellationConfirmationTemplate,
  membershipCancellationApprovedTemplate,
  membershipCancellationRejectedTemplate,
  adminMembershipCancellationRequestTemplate,
  adminMemberArchiveRequestedTemplate,
  memberArchiveApprovedTemplate,
  memberArchiveRejectedTemplate,
  adminMemberDeleteRequestedTemplate,
  adminMemberDeleteApprovedTemplate,
  adminMemberDeleteRejectedTemplate,
  adminRefundRequestTemplate,
  adminBookingChangeRequestTemplate,
  adminIssueReportTemplate,
  type XeroReconciliationReportEmail,
} from "./email-templates";
import {
  CLUB_BOOKINGS_NAME,
  CLUB_LODGE_NAME,
  CLUB_NAME,
} from "@/config/club-identity";
import { MEMBER_SETUP_INVITE_TTL_DAYS } from "./member-setup-invite";
import {
  ADMIN_NOTIFICATION_PREFERENCE_SELECT,
  type AdminNotificationPreferenceKey,
  resolveAdminNotificationPreferences,
} from "./admin-notification-preferences";
import { EMAIL_FROM } from "./email-sender";
import { htmlToPlainText } from "./email-text";
import { formatNZDate, formatNZDateTime } from "./nzst-date";
import logger from "@/lib/logger";
import { prisma } from "@/lib/prisma";
import { formatCents as formatMoneyCents } from "@/lib/utils";
import {
  formatEmailFromAddressWithSettings,
} from "@/lib/email-message-settings";
import {
  prepareEmailMessage,
  type EmailTemplateData,
} from "@/lib/email-message-renderer";
import { shouldSendAdminSystemEmail } from "@/lib/notification-delivery-policies";
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
  "membership-cancellation-confirmation",
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

function assertNoCrlf(value: string, field: string) {
  if (/[\r\n]/.test(value)) {
    throw new Error(`Email header field ${field} contains CR/LF`);
  }
}

// Defense-in-depth: subject lines interpolate user-controlled member names
// (issue #323). Schema-level sanitization at API boundaries is the first line
// of defense, but a contaminated row from before the fix would still trip the
// CRLF guard on `from`/`to`. Strip CRLF from the subject before send so the
// email never silently fails — `from`/`to` keep the throw because CRLF there
// indicates a configuration/normalizer bug, not user input.
function sanitizeEmailSubject(subject: string) {
  return subject.replace(/[\r\n]+/g, " ").trim();
}

export async function sendEmail({
  to,
  subject,
  html,
  text,
  templateName = "unknown",
  templateData,
  attachments,
}: {
  to: string;
  subject: string;
  html: string;
  text?: string;
  templateName?: string;
  templateData?: EmailTemplateData;
  attachments?: EmailAttachment[];
}) {
  const prepared = await prepareEmailMessage({
    templateName,
    subject,
    html,
    templateData,
  });
  const from = formatEmailFromAddressWithSettings(prepared.settings, EMAIL_FROM);
  const persistHtmlBody = shouldPersistEmailHtml(templateName);
  const plainTextBody = text || htmlToPlainText(prepared.html);
  const normalizedRecipient = normalizeEmailAddress(to);
  const sanitizedSubject = sanitizeEmailSubject(prepared.subject);

  assertNoCrlf(from, "from");
  assertNoCrlf(to, "to");
  assertNoCrlf(normalizedRecipient, "to");

  // Create EmailLog record (fire-and-forget logging won't break email delivery)
  let emailLogId: string | null = null;
  try {
    const log = await prisma.emailLog.create({
      data: {
        to,
        subject: sanitizedSubject,
        templateName,
        htmlBody: persistHtmlBody ? prepared.html : null,
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
    logger.info({ to, subject: sanitizedSubject, templateName }, "Email sent (dev mode)");
    if (persistHtmlBody) {
      logger.debug({ html: prepared.html }, "Email HTML content");
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
      from,
      to,
      subject: sanitizedSubject,
      html: prepared.html,
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

/** Send an email to all active admins who opted into the alert category. */
async function sendToAdmins({
  subject,
  html,
  templateName,
  preferenceKey,
  templateData,
  attachments,
}: {
  subject: string;
  html: string;
  templateName: string;
  preferenceKey: AdminNotificationPreferenceKey;
  templateData?: EmailTemplateData;
  attachments?: EmailAttachment[];
}) {
  const delivery = await shouldSendAdminSystemEmail({ templateName });
  if (!delivery.send) {
    logger.info(
      { templateName, deliveryMode: delivery.mode, reason: delivery.reason },
      "Skipped admin email by delivery policy"
    );
    return;
  }

  const emails = await getAdminAlertEmails(preferenceKey);
  await Promise.all(
    emails.map((email) =>
      sendEmail({
        to: email,
        subject,
        html,
        templateName,
        templateData,
        attachments,
      }).catch((err) =>
        logger.error({ err, to: email, templateName }, "Failed to send admin alert")
      ),
    ),
  );
}

async function shouldSendDirectAdminSystemEmail(templateName: string) {
  const delivery = await shouldSendAdminSystemEmail({ templateName });
  if (!delivery.send) {
    logger.info(
      { templateName, deliveryMode: delivery.mode, reason: delivery.reason },
      "Skipped direct admin email by delivery policy"
    );
    return false;
  }
  return true;
}

export async function sendPasswordResetEmail(
  email: string,
  token: string
) {
  const baseUrl = process.env.NEXTAUTH_URL || "http://localhost:3000";
  const resetUrl = `${baseUrl}/reset-password?token=${token}`;

  await sendEmail({
    to: email,
    subject: `Reset your ${CLUB_NAME} password`,
    html: passwordResetTemplate(resetUrl),
    templateName: "password-reset",
    templateData: { token, resetUrl },
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
    subject: `Reset your ${CLUB_NAME} password`,
    html: adminPasswordResetTemplate(resetUrl, expiryLabel),
    templateName: "admin-password-reset",
    templateData: { token, resetUrl, expiryLabel },
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
    subject: `Set up your ${CLUB_NAME} account (${MEMBER_SETUP_INVITE_TTL_DAYS}-day link)`,
    html: memberSetupInviteTemplate(firstName, resetUrl),
    templateName: "member-setup-invite",
    templateData: {
      firstName,
      token,
      resetUrl,
      expiryLabel: `${MEMBER_SETUP_INVITE_TTL_DAYS} days`,
    },
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
    subject: `Booking Confirmed - ${CLUB_LODGE_NAME}`,
    html: bookingConfirmedTemplate(firstName, checkIn, checkOut, guestCount, totalCents, options),
    templateName: "booking-confirmed",
    templateData: {
      firstName,
      checkIn: formatNZDate(checkIn),
      checkOut: formatNZDate(checkOut),
      guestCount,
      subtotal: options?.discountCents
        ? formatMoneyCents(totalCents + options.discountCents)
        : "",
      promoCode: options?.promoCode ?? "",
      discount: options?.discountCents ? formatMoneyCents(options.discountCents) : "",
      totalPaid: formatMoneyCents(totalCents),
      total: formatMoneyCents(totalCents),
    },
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
    subject: `Booking Pending - ${CLUB_LODGE_NAME}`,
    html: bookingPendingTemplate(firstName, checkIn, checkOut, guestCount, holdUntil),
    templateName: "booking-pending",
    templateData: {
      firstName,
      checkIn: formatNZDate(checkIn),
      checkOut: formatNZDate(checkOut),
      guestCount,
      holdUntil: formatNZDateTime(holdUntil),
    },
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
    subject: `Booking Update - ${CLUB_LODGE_NAME}`,
    html: bookingBumpedTemplate(firstName, checkIn, checkOut, guestCount),
    templateName: "booking-bumped",
    templateData: {
      firstName,
      checkIn: formatNZDate(checkIn),
      checkOut: formatNZDate(checkOut),
      guestCount,
    },
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
    subject: `Booking Cancelled - ${CLUB_LODGE_NAME}`,
    html: bookingCancelledTemplate(firstName, checkIn, checkOut, refundCents, refundMethod),
    templateName: "booking-cancelled",
    templateData: {
      firstName,
      checkIn: formatNZDate(checkIn),
      checkOut: formatNZDate(checkOut),
      refundAmount: formatMoneyCents(refundCents),
      refundMessage:
        refundCents > 0 && refundMethod === "credit"
          ? `A credit of ${formatMoneyCents(refundCents)} has been added to your account for future bookings.`
          : refundCents > 0
            ? `A refund of ${formatMoneyCents(refundCents)} has been processed to your original payment method.`
            : "No refund was applicable based on the cancellation policy.",
    },
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
    subject: `Your chore roster for ${formattedDate} - ${CLUB_LODGE_NAME}`,
    html: choreRosterTemplate(guestName, date, chores, choreLink),
    templateName: "chore-roster",
    templateData: {
      guestName,
      formattedDate,
      choreName: chores.map((chore) => chore.name).join(", "),
      choreDescription: chores
        .map((chore) => chore.description ?? "")
        .filter(Boolean)
        .join(", "),
      choreLink: choreLink ?? "",
    },
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
    subject: `Your ${CLUB_NAME} hut leader assignment`,
    html: hutLeaderAssignmentTemplate(params),
    templateName: "hut-leader-assignment",
    templateData: {
      firstName: params.firstName,
      startDate: formatNZDate(params.startDate),
      endDate: formatNZDate(params.endDate),
      pin: params.pin,
    },
  });
}

export async function sendWelcomeEmail(email: string, firstName: string) {
  await sendEmail({
    to: email,
    subject: `Welcome to ${CLUB_BOOKINGS_NAME}`,
    html: welcomeTemplate(firstName),
    templateName: "welcome",
    templateData: { firstName },
  });
}

export async function sendVerificationEmail(email: string, firstName: string, token: string) {
  const baseUrl = process.env.NEXTAUTH_URL || "http://localhost:3000";
  const verifyUrl = `${baseUrl}/verify-email?token=${token}`;
  const expiresAt = new Date(Date.now() + EMAIL_VERIFICATION_TTL_MS);

  await sendEmail({
    to: email,
    subject: `Verify your email — ${CLUB_BOOKINGS_NAME}`,
    html: emailVerificationTemplate(firstName, verifyUrl, expiresAt),
    templateName: "email-verification",
    templateData: {
      firstName,
      token,
      verifyUrl,
      expiresAt: formatNZDateTime(expiresAt),
    },
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
    subject: `Nomination request for ${params.applicantName} — ${CLUB_NAME}`,
    html: nominationRequestTemplate({
      nominatorName: params.nominatorName,
      applicantName: params.applicantName,
      reviewUrl,
      familyMemberCount: params.familyMemberCount,
      expiresAt: params.expiresAt,
    }),
    templateName: "nomination-request",
    templateData: {
      nominatorName: params.nominatorName,
      applicantName: params.applicantName,
      token: params.token,
      reviewUrl,
      familyMemberCount: params.familyMemberCount,
      expiresAt: formatNZDateTime(params.expiresAt),
    },
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
    subject: `Your ${CLUB_NAME} membership has been approved`,
    html: membershipApplicationApprovedTemplate(
      params.firstName,
      resetUrl,
      params.adminNotes
    ),
    templateName: "membership-application-approved",
    templateData: {
      firstName: params.firstName,
      token: params.token,
      resetUrl,
      adminNotes: params.adminNotes ?? "",
    },
  });
}

export async function sendMembershipApplicationRejectedEmail(params: {
  email: string;
  firstName: string;
  adminNotes?: string | null;
}) {
  await sendEmail({
    to: params.email,
    subject: `Update on your ${CLUB_NAME} membership application`,
    html: membershipApplicationRejectedTemplate(
      params.firstName,
      params.adminNotes
    ),
    templateName: "membership-application-rejected",
    templateData: {
      firstName: params.firstName,
      adminNotes: params.adminNotes ?? "",
    },
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
    templateData: {
      applicantName: data.applicantName,
      applicantEmail: data.applicantEmail,
      familyMemberCount: data.familyMemberCount,
      reviewUrl,
    },
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
    subject: `Confirm your new email — ${CLUB_BOOKINGS_NAME}`,
    html: emailChangeVerificationTemplate(newEmail, verifyUrl, expiresAt),
    templateName: "email-change-verification",
    templateData: {
      newEmail,
      token,
      verifyUrl,
      expiresAt: formatNZDateTime(expiresAt),
    },
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
    subject: `Email change requested — ${CLUB_BOOKINGS_NAME}`,
    html: emailChangeNotificationTemplate(newEmail),
    templateName: "email-change-notification",
    templateData: { newEmail },
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
    subject: `Check-in Reminder - ${CLUB_LODGE_NAME}`,
    html: checkinReminderTemplate(firstName, checkIn, checkOut, guests, chores),
    templateName: "checkin-reminder",
    templateData: {
      firstName,
      checkIn: formatNZDate(checkIn),
      checkOut: formatNZDate(checkOut),
      guestCount: guests.length,
      guestFirstName: guests.map((guest) => guest.firstName).join(", "),
      guestLastName: guests.map((guest) => guest.lastName).join(", "),
      choreName: chores.map((chore) => chore.name).join(", "),
      choreDescription: chores
        .map((chore) => chore.description ?? "")
        .filter(Boolean)
        .join(", "),
    },
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
    templateData: {
      ...data,
      checkIn: formatNZDate(data.checkIn),
      checkOut: formatNZDate(data.checkOut),
      total: formatMoneyCents(data.totalCents),
      reviewReason: data.reviewReason ?? "",
    },
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
    subject: `Payment Failed — ${CLUB_BOOKINGS_NAME}`,
    html: adminPaymentFailureTemplate(data),
    templateName: "admin-payment-failure",
    templateData: {
      ...data,
      checkIn: formatNZDate(data.checkIn),
      checkOut: formatNZDate(data.checkOut),
      amount: formatMoneyCents(data.amountCents),
    },
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
    templateData: {
      count: bookings.length,
      s: bookings.length === 1 ? "" : "s",
      memberName: bookings.map((booking) => booking.memberName).join(", "),
      checkIn: bookings.map((booking) => formatNZDate(booking.checkIn)).join(", "),
      checkOut: bookings.map((booking) => formatNZDate(booking.checkOut)).join(", "),
      guestCount: bookings.map((booking) => booking.guestCount).join(", "),
      deadline: bookings.map((booking) => formatNZDateTime(booking.deadline)).join(", "),
      hoursRemaining: bookings.map((booking) => Math.round(booking.hoursRemaining)).join(", "),
    },
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
    templateData: {
      ...data,
      checkIn: formatNZDate(data.checkIn),
      checkOut: formatNZDate(data.checkOut),
    },
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
    subject: `Xero Sync Error — ${CLUB_BOOKINGS_NAME}`,
    html: adminXeroSyncErrorTemplate(data),
    templateName: "admin-xero-sync-error",
    templateData: {
      ...data,
      timestamp: data.timestamp.toISOString(),
    },
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
    templateData: {
      ...data,
      localModel: data.localModel ?? "",
      localId: data.localId ?? "",
      latestErrorMessage: data.latestErrorMessage ?? "",
      timestamp: data.timestamp.toISOString(),
    },
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
    templateData: {
      count: days.length,
      s: days.length === 1 ? "" : "s",
      date: days.map((day) => formatNZDate(day.date)).join(", "),
      occupiedBeds: days.map((day) => day.occupiedBeds).join(", "),
      availableBeds: days.map((day) => day.availableBeds).join(", "),
      percent: days.map((day) => String(day.occupiedBeds)).join(", "),
    },
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
    templateData: {
      ...sections,
      count: sections.totalAlerts,
      s: sections.totalAlerts === 1 ? "" : "s",
    },
    preferenceKey: "adminDailyDigest",
  });
}

export async function sendAdminXeroReconciliationReportAlert(
  report: XeroReconciliationReportEmail
) {
  const subject =
    report.summary.issueCategoryCount === 0
      ? "Xero Reconciliation Report - clean"
      : `Xero Reconciliation Report - action needed: ${report.summary.issueCategoryCount} categor${report.summary.issueCategoryCount === 1 ? "y" : "ies"}, ${report.summary.issueTotalCount} item${report.summary.issueTotalCount === 1 ? "" : "s"}`;

  await sendToAdmins({
    subject,
    html: adminXeroReconciliationReportTemplate(report),
    templateName: "admin-xero-reconciliation-report",
    templateData: {
      generatedAt: report.generatedAt.toISOString(),
      lookbackHours: report.lookbackHours,
      stalePendingMinutes: report.stalePendingMinutes,
      issueCategoryCount: report.summary.issueCategoryCount,
      issueTotalCount: report.summary.issueTotalCount,
      count: report.summary.issueTotalCount,
    },
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
    templateData: { firstName },
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
    templateData: { firstName, adminNote },
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
    subject: `${inviterName} invited you to join ${groupName} — ${CLUB_BOOKINGS_NAME}`,
    html: familyGroupInvitationTemplate(inviterName, groupName, profileUrl),
    templateName: "family-group-invitation",
    templateData: { inviterName, groupName, profileUrl },
  });
}

export async function sendFamilyGroupInviteAcceptedEmail(
  email: string,
  inviteeName: string,
  groupName: string
) {
  await sendEmail({
    to: email,
    subject: `${inviteeName} has joined ${groupName} — ${CLUB_BOOKINGS_NAME}`,
    html: familyGroupInviteAcceptedTemplate(inviteeName, groupName),
    templateName: "family-group-invite-accepted",
    templateData: { inviteeName, groupName },
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
    subject: `Infant/Child/Youth request submitted — ${CLUB_BOOKINGS_NAME}`,
    html: childRequestSubmittedTemplate(parentName, childName, groupName),
    templateName: "child-request-submitted",
    templateData: { parentName, childName, groupName },
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
    subject: `${childName} has been added to ${groupName} — ${CLUB_BOOKINGS_NAME}`,
    html: childRequestApprovedTemplate(parentName, childName, groupName),
    templateName: "child-request-approved",
    templateData: { parentName, childName, groupName },
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
    subject: `Infant/Child/Youth request update — ${CLUB_BOOKINGS_NAME}`,
    html: childRequestRejectedTemplate(parentName, childName, reason),
    templateName: "child-request-rejected",
    templateData: { parentName, childName, reason: reason ?? "" },
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
    templateData: data,
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
    subject: `Join request submitted — ${CLUB_BOOKINGS_NAME}`,
    html: joinRequestConfirmationTemplate(requesterName, groupName),
    templateName: "join-request-confirmation",
    templateData: { requesterName, groupName },
  });
}

export async function sendMembershipCancellationSubmittedEmail(params: {
  email: string;
  firstName: string;
  participantSummary: string;
  reason?: string | null;
}) {
  const baseUrl = process.env.NEXTAUTH_URL || "http://localhost:3000";
  const reviewUrl = `${baseUrl}/profile`;

  await sendEmail({
    to: params.email,
    subject: `Membership cancellation request submitted — ${CLUB_BOOKINGS_NAME}`,
    html: membershipCancellationSubmittedTemplate({
      firstName: params.firstName,
      participantSummary: params.participantSummary,
      reason: params.reason,
      reviewUrl,
    }),
    templateName: "membership-cancellation-submitted",
    templateData: {
      firstName: params.firstName,
      participantSummary: params.participantSummary,
      reason: params.reason ?? "",
      reviewUrl,
    },
  });
}

export async function sendMembershipCancellationConfirmationEmail(params: {
  email: string;
  firstName: string;
  requesterName: string;
  participantName: string;
  token: string;
  expiresAt: Date;
}) {
  const baseUrl = process.env.NEXTAUTH_URL || "http://localhost:3000";
  const confirmationUrl = `${baseUrl}/membership-cancellation/${params.token}`;

  await sendEmail({
    to: params.email,
    subject: `Confirm membership cancellation request — ${CLUB_BOOKINGS_NAME}`,
    html: membershipCancellationConfirmationTemplate({
      firstName: params.firstName,
      requesterName: params.requesterName,
      participantName: params.participantName,
      confirmationUrl,
      expiresAt: params.expiresAt,
    }),
    templateName: "membership-cancellation-confirmation",
    templateData: {
      firstName: params.firstName,
      requesterName: params.requesterName,
      participantName: params.participantName,
      token: params.token,
      confirmationUrl,
      expiresAt: formatNZDateTime(params.expiresAt),
    },
  });
}

export async function sendAdminMembershipCancellationRequestAlert(params: {
  requesterName: string;
  participantSummary: string;
  reason?: string | null;
}) {
  const baseUrl = process.env.NEXTAUTH_URL || "http://localhost:3000";
  const reviewUrl = `${baseUrl}/admin/membership-cancellations`;

  await sendToAdmins({
    subject: `Membership cancellation ready: ${params.requesterName}`,
    html: adminMembershipCancellationRequestTemplate({
      requesterName: params.requesterName,
      participantSummary: params.participantSummary,
      reason: params.reason,
      reviewUrl,
    }),
    templateName: "admin-membership-cancellation-request",
    templateData: {
      requesterName: params.requesterName,
      participantSummary: params.participantSummary,
      reason: params.reason ?? "",
      reviewUrl,
    },
    preferenceKey: "adminFamilyGroupRequest",
  });
}

export async function sendMembershipCancellationApprovedEmail(params: {
  email: string;
  firstName: string;
  participantName: string;
  reason?: string | null;
  adminNote?: string | null;
  rejoinProcessText?: string | null;
}) {
  await sendEmail({
    to: params.email,
    subject: `Membership cancellation approved — ${CLUB_BOOKINGS_NAME}`,
    html: membershipCancellationApprovedTemplate(params),
    templateName: "membership-cancellation-approved",
    templateData: {
      firstName: params.firstName,
      participantName: params.participantName,
      reason: params.reason ?? "",
      adminNote: params.adminNote ?? "",
      rejoinProcessText: params.rejoinProcessText ?? "",
    },
  });
}

export async function sendAdminMemberArchiveRequestedAlert(params: {
  requesterName: string;
  memberId: string;
  memberName: string;
  reason: string;
}) {
  const baseUrl = process.env.NEXTAUTH_URL || "http://localhost:3000";
  const reviewUrl = `${baseUrl}/admin/members/${encodeURIComponent(params.memberId)}`;

  await sendToAdmins({
    subject: `Member archive requested: ${params.memberName}`,
    html: adminMemberArchiveRequestedTemplate({
      requesterName: params.requesterName,
      memberName: params.memberName,
      reason: params.reason,
      reviewUrl,
    }),
    templateName: "admin-member-archive-requested",
    templateData: {
      requesterName: params.requesterName,
      memberName: params.memberName,
      reason: params.reason,
      reviewUrl,
    },
    preferenceKey: "adminFamilyGroupRequest",
  });
}

export async function sendMemberArchiveApprovedEmail(params: {
  email: string;
  firstName: string;
  reason: string;
  reviewNote?: string | null;
}) {
  await sendEmail({
    to: params.email,
    subject: `Membership archive completed — ${CLUB_BOOKINGS_NAME}`,
    html: memberArchiveApprovedTemplate(params),
    templateName: "member-archive-approved",
    templateData: {
      firstName: params.firstName,
      reason: params.reason,
      reviewNote: params.reviewNote ?? "",
    },
  });
}

export async function sendMemberArchiveRejectedEmail(params: {
  email: string;
  firstName: string;
  reason: string;
  reviewNote?: string | null;
}) {
  await sendEmail({
    to: params.email,
    subject: `Membership archive request update — ${CLUB_BOOKINGS_NAME}`,
    html: memberArchiveRejectedTemplate(params),
    templateName: "member-archive-rejected",
    templateData: {
      firstName: params.firstName,
      reason: params.reason,
      reviewNote: params.reviewNote ?? "",
    },
  });
}

export async function sendAdminMemberDeleteRequestedAlert(params: {
  requesterName: string;
  memberId: string;
  memberName: string;
  reason: string;
}) {
  const baseUrl = process.env.NEXTAUTH_URL || "http://localhost:3000";
  const reviewUrl = `${baseUrl}/admin/members/${encodeURIComponent(params.memberId)}`;

  await sendToAdmins({
    subject: `Member delete requested: ${params.memberName}`,
    html: adminMemberDeleteRequestedTemplate({
      requesterName: params.requesterName,
      memberName: params.memberName,
      reason: params.reason,
      reviewUrl,
    }),
    templateName: "admin-member-delete-requested",
    templateData: {
      requesterName: params.requesterName,
      memberName: params.memberName,
      reason: params.reason,
      reviewUrl,
    },
    preferenceKey: "adminFamilyGroupRequest",
  });
}

export async function sendAdminMemberDeleteApprovedEmail(params: {
  email: string;
  requesterName: string;
  memberName: string;
  reason: string;
  reviewNote?: string | null;
}) {
  if (!(await shouldSendDirectAdminSystemEmail("admin-member-delete-approved"))) {
    return;
  }

  await sendEmail({
    to: params.email,
    subject: `Member delete approved: ${params.memberName}`,
    html: adminMemberDeleteApprovedTemplate(params),
    templateName: "admin-member-delete-approved",
    templateData: {
      requesterName: params.requesterName,
      memberName: params.memberName,
      reason: params.reason,
      reviewNote: params.reviewNote ?? "",
    },
  });
}

export async function sendAdminMemberDeleteRejectedEmail(params: {
  email: string;
  requesterName: string;
  memberId: string;
  memberName: string;
  reason: string;
  reviewNote?: string | null;
}) {
  const baseUrl = process.env.NEXTAUTH_URL || "http://localhost:3000";
  const reviewUrl = `${baseUrl}/admin/members/${encodeURIComponent(params.memberId)}`;

  if (!(await shouldSendDirectAdminSystemEmail("admin-member-delete-rejected"))) {
    return;
  }

  await sendEmail({
    to: params.email,
    subject: `Member delete rejected: ${params.memberName}`,
    html: adminMemberDeleteRejectedTemplate({
      requesterName: params.requesterName,
      memberName: params.memberName,
      reason: params.reason,
      reviewNote: params.reviewNote,
      reviewUrl,
    }),
    templateName: "admin-member-delete-rejected",
    templateData: {
      requesterName: params.requesterName,
      memberName: params.memberName,
      reason: params.reason,
      reviewNote: params.reviewNote ?? "",
      reviewUrl,
    },
  });
}

export async function sendMembershipCancellationRejectedEmail(params: {
  email: string;
  firstName: string;
  participantName: string;
  reason?: string | null;
  adminNote?: string | null;
}) {
  await sendEmail({
    to: params.email,
    subject: `Membership cancellation update — ${CLUB_BOOKINGS_NAME}`,
    html: membershipCancellationRejectedTemplate(params),
    templateName: "membership-cancellation-rejected",
    templateData: {
      firstName: params.firstName,
      participantName: params.participantName,
      reason: params.reason ?? "",
      adminNote: params.adminNote ?? "",
    },
  });
}

export interface AgeUpInvitationEmailContext {
  targetAgeTier?: string;
  targetAgeTierLabel?: string;
  targetAgeTierMinAge?: number;
}

// Age-up invitation email (sent when youth reaches the ADULT age tier)
export async function sendAgeUpInvitationEmail(
  email: string,
  firstName: string,
  token: string,
  context: AgeUpInvitationEmailContext = {}
) {
  const baseUrl = process.env.NEXTAUTH_URL || "http://localhost:3000";
  const resetUrl = `${baseUrl}/reset-password?token=${token}`;
  const targetAgeTier = context.targetAgeTier ?? "ADULT";
  const targetAgeTierLabel = context.targetAgeTierLabel?.trim() || "Adult (18+)";
  const targetAgeTierMinAge = context.targetAgeTierMinAge ?? 18;

  await sendEmail({
    to: email,
    subject: `You're now ${targetAgeTierLabel} — set up your ${CLUB_NAME} account`,
    html: ageUpInvitationTemplate(firstName, resetUrl, {
      targetAgeTierLabel,
    }),
    templateName: "age-up-invitation",
    templateData: {
      firstName,
      token,
      resetUrl,
      targetAgeTier,
      targetAgeTierLabel,
      targetAgeTierMinAge,
    },
  });
}

export interface AgeUpParentEmailHandoffEmailContext {
  recipientName: string;
  memberFirstName: string;
  memberLastName: string;
  targetAgeTier?: string;
  targetAgeTierLabel?: string;
  targetAgeTierMinAge?: number;
}

// Age-up parent handoff email (sent when the ageing-up member still shares a login email)
export async function sendAgeUpParentEmailHandoffEmail(
  email: string,
  context: AgeUpParentEmailHandoffEmailContext
) {
  const targetAgeTier = context.targetAgeTier ?? "ADULT";
  const targetAgeTierLabel = context.targetAgeTierLabel?.trim() || "Adult (18+)";
  const targetAgeTierMinAge = context.targetAgeTierMinAge ?? 18;
  const memberName = [context.memberFirstName, context.memberLastName]
    .filter(Boolean)
    .join(" ")
    .trim();

  await sendEmail({
    to: email,
    subject: `Email address needed for ${memberName}'s ${CLUB_NAME} login`,
    html: ageUpParentEmailHandoffTemplate({
      recipientName: context.recipientName,
      memberFirstName: context.memberFirstName,
      memberLastName: context.memberLastName,
      targetAgeTierLabel,
    }),
    templateName: "age-up-parent-email-handoff",
    templateData: {
      recipientName: context.recipientName,
      memberName,
      firstName: context.memberFirstName,
      targetAgeTier,
      targetAgeTierLabel,
      targetAgeTierMinAge,
    },
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
    subject: `Booking Modified - ${CLUB_LODGE_NAME}`,
    html: bookingModifiedTemplate(params),
    templateName: "booking-modified",
    templateData: {
      firstName: params.firstName,
      modificationTypeLabel: params.modificationType,
      oldCheckIn: formatNZDate(params.oldCheckIn),
      oldCheckOut: formatNZDate(params.oldCheckOut),
      newCheckIn: formatNZDate(params.newCheckIn),
      newCheckOut: formatNZDate(params.newCheckOut),
      oldGuestCount: params.oldGuestCount,
      newGuestCount: params.newGuestCount,
      oldTotal: formatMoneyCents(params.oldFinalPriceCents),
      newTotal: formatMoneyCents(params.newFinalPriceCents),
      changeFee: formatMoneyCents(params.changeFeeCents),
      refundAmount: formatMoneyCents(params.refundAmountCents),
      additionalAmount: formatMoneyCents(params.additionalAmountCents),
      paymentNote:
        params.refundAmountCents > 0
          ? `A refund of ${formatMoneyCents(params.refundAmountCents)} has been processed to your original payment method.`
          : params.additionalAmountCents > 0
            ? `An additional payment of ${formatMoneyCents(params.additionalAmountCents)} is required.`
            : "",
    },
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
    subject: `Card Setup Failed - ${CLUB_LODGE_NAME}`,
    html: setupIntentFailedTemplate(params),
    templateName: "setup-intent-failed",
    templateData: {
      firstName: params.firstName,
      checkIn: formatNZDate(params.checkIn),
      checkOut: formatNZDate(params.checkOut),
    },
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
    subject: `Waitlist Confirmation - ${CLUB_LODGE_NAME}`,
    html: waitlistConfirmationTemplate(firstName, checkIn, checkOut, guestCount, position),
    templateName: "waitlist-confirmation",
    templateData: {
      firstName,
      checkIn: formatNZDate(checkIn),
      checkOut: formatNZDate(checkOut),
      guestCount,
      position,
    },
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
    subject: `Spot Available! - ${CLUB_LODGE_NAME}`,
    html: waitlistOfferTemplate(firstName, checkIn, checkOut, guestCount, expiresAt, bookingId),
    templateName: "waitlist-offer",
    templateData: {
      firstName,
      checkIn: formatNZDate(checkIn),
      checkOut: formatNZDate(checkOut),
      guestCount,
      expiresAt: formatNZDateTime(expiresAt),
      bookingId,
    },
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
    subject: `Waitlist Offer Expired - ${CLUB_LODGE_NAME}`,
    html: waitlistOfferExpiredTemplate(firstName, checkIn, checkOut, position),
    templateName: "waitlist-offer-expired",
    templateData: {
      firstName,
      checkIn: formatNZDate(checkIn),
      checkOut: formatNZDate(checkOut),
      position,
    },
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
    templateData: {
      ...data,
      checkIn: formatNZDate(data.checkIn),
      checkOut: formatNZDate(data.checkOut),
    },
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
    templateData: {
      ...data,
      checkIn: formatNZDate(data.checkIn),
      checkOut: formatNZDate(data.checkOut),
      paidAmount: formatMoneyCents(data.paidAmountCents),
      refundedAmount: formatMoneyCents(data.refundedAmountCents),
      remainingAmount: formatMoneyCents(data.paidAmountCents - data.refundedAmountCents),
      requestedAmount:
        data.requestedAmountCents === null
          ? ""
          : formatMoneyCents(data.requestedAmountCents),
    },
    preferenceKey: "adminRefundRequest",
  });
}

export async function sendAdminBookingChangeRequestAlert(data: {
  memberName: string;
  memberEmail: string;
  bookingId: string;
  checkIn: Date;
  checkOut: Date;
  requestedSummary: string;
  reason: string | null;
  requestId: string;
}) {
  const reviewUrl = `${process.env.NEXTAUTH_URL || "http://localhost:3000"}/admin/booking-change-requests?requestId=${encodeURIComponent(data.requestId)}`;

  await sendToAdmins({
    subject: `Booking Change Request: ${data.memberName}`,
    html: adminBookingChangeRequestTemplate({
      memberName: data.memberName,
      memberEmail: data.memberEmail,
      bookingId: data.bookingId,
      checkIn: data.checkIn,
      checkOut: data.checkOut,
      requestedSummary: data.requestedSummary,
      reason: data.reason,
      reviewUrl,
    }),
    templateName: "admin-booking-change-request",
    templateData: {
      ...data,
      checkIn: formatNZDate(data.checkIn),
      checkOut: formatNZDate(data.checkOut),
      reason: data.reason ?? "",
      reviewUrl,
    },
    preferenceKey: "adminBookingChangeRequest",
  });
}

export async function sendAdminIssueReportAlert(data: {
  memberName: string;
  memberEmail: string;
  pageUrl: string;
  pageTitle?: string | null;
  description: string;
  issueReportUrl: string;
  hasScreenshot: boolean;
}) {
  await sendToAdmins({
    subject: `Issue Report: ${data.memberName}`,
    html: adminIssueReportTemplate({
      memberName: data.memberName,
      memberEmail: data.memberEmail,
      pageUrl: data.pageUrl,
      pageTitle: data.pageTitle,
      description: data.description,
      issueReportUrl: data.issueReportUrl,
      hasScreenshot: data.hasScreenshot,
    }),
    templateName: "admin-issue-report",
    templateData: {
      ...data,
      pageTitle: data.pageTitle ?? data.pageUrl,
    },
    preferenceKey: "adminIssueReport",
  });
}
