import nodemailer from "nodemailer";
import {
  welcomeTemplate,
  passwordResetTemplate,
  bookingConfirmedTemplate,
  bookingPendingTemplate,
  bookingBumpedTemplate,
  bookingCancelledTemplate,
  choreRosterTemplate,
  emailVerificationTemplate,
  emailChangeVerificationTemplate,
  emailChangeNotificationTemplate,
  checkinReminderTemplate,
  adminNewBookingTemplate,
  adminPaymentFailureTemplate,
  adminPendingDeadlineTemplate,
  adminBookingBumpedTemplate,
  adminXeroSyncErrorTemplate,
  adminCapacityWarningTemplate,
  adminDailyDigestTemplate,
  postStayFeedbackTemplate,
  bulkCommunicationTemplate,
  adminPasswordResetTemplate,
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
} from "./email-templates";
import logger from "@/lib/logger";
import { prisma } from "@/lib/prisma";

const transporter = nodemailer.createTransport({
  host: process.env.SMTP_HOST || "email-smtp.ap-southeast-2.amazonaws.com",
  port: Number(process.env.SMTP_PORT) || 587,
  secure: false,
  auth: {
    user: process.env.AWS_SES_ACCESS_KEY_ID || "",
    pass: process.env.AWS_SES_SECRET_ACCESS_KEY || "",
  },
});

const FROM = process.env.EMAIL_FROM || "support@tokoroa.org.nz";

export async function sendEmail({
  to,
  subject,
  html,
  templateName = "unknown",
}: {
  to: string;
  subject: string;
  html: string;
  templateName?: string;
}) {
  // Create EmailLog record (fire-and-forget logging won't break email delivery)
  let emailLogId: string | null = null;
  try {
    const log = await prisma.emailLog.create({
      data: {
        to,
        subject,
        templateName,
        htmlBody: html,
        status: "QUEUED",
        lastAttemptAt: new Date(),
      },
    });
    emailLogId = log.id;
  } catch (err) {
    logger.error({ err }, "Failed to create EmailLog record");
  }

  if (process.env.NODE_ENV === "development") {
    logger.info({ to, subject, templateName }, "Email sent (dev mode)");
    logger.debug({ html }, "Email HTML content");
    // Mark as SENT in dev mode
    if (emailLogId) {
      prisma.emailLog.update({
        where: { id: emailLogId },
        data: { status: "SENT", sentAt: new Date() },
      }).catch((err) => logger.error({ err, to, templateName }, "Failed to update EmailLog"));
    }
    return;
  }

  try {
    const result = await transporter.sendMail({
      from: `"TAC Bookings" <${FROM}>`,
      to,
      subject,
      html,
    });

    // Update EmailLog to SENT
    if (emailLogId) {
      prisma.emailLog.update({
        where: { id: emailLogId },
        data: {
          status: "SENT",
          sentAt: new Date(),
          messageId: result.messageId || null,
        },
      }).catch((err) => {
        logger.error({ err }, "Failed to update EmailLog to SENT");
      });
    }
  } catch (err) {
    // Update EmailLog to FAILED
    if (emailLogId) {
      prisma.emailLog.update({
        where: { id: emailLogId },
        data: {
          status: "FAILED",
          errorMessage: err instanceof Error ? err.message : String(err),
        },
      }).catch((logErr) => {
        logger.error({ err: logErr }, "Failed to update EmailLog to FAILED");
      });
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

/** Send an email to all active admins (fire-and-forget) */
async function sendToAdmins({
  subject,
  html,
  templateName,
}: {
  subject: string;
  html: string;
  templateName: string;
}) {
  const emails = await getAdminEmails();
  for (const email of emails) {
    sendEmail({ to: email, subject, html, templateName }).catch((err) =>
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
    subject: "Reset your TAC Bookings password",
    html: passwordResetTemplate(resetUrl),
    templateName: "password-reset",
  });
}

export async function sendAdminPasswordResetEmail(
  email: string,
  token: string
) {
  const baseUrl = process.env.NEXTAUTH_URL || "http://localhost:3000";
  const resetUrl = `${baseUrl}/reset-password?token=${token}`;

  await sendEmail({
    to: email,
    subject: "Reset your TAC Bookings password",
    html: adminPasswordResetTemplate(resetUrl),
    templateName: "admin-password-reset",
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
    subject: "Booking Confirmed - TAC Lodge",
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
    subject: "Booking Pending - TAC Lodge",
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
    subject: "Booking Update - TAC Lodge",
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
    subject: "Booking Cancelled - TAC Lodge",
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
    subject: `Your chore roster for ${formattedDate} - TAC Lodge`,
    html: choreRosterTemplate(guestName, date, chores, choreLink),
    templateName: "chore-roster",
  });
}

export async function sendWelcomeEmail(email: string, firstName: string) {
  await sendEmail({
    to: email,
    subject: "Welcome to TAC Bookings",
    html: welcomeTemplate(firstName),
    templateName: "welcome",
  });
}

export async function sendVerificationEmail(email: string, firstName: string, token: string) {
  const baseUrl = process.env.NEXTAUTH_URL || "http://localhost:3000";
  const verifyUrl = `${baseUrl}/verify-email?token=${token}`;

  await sendEmail({
    to: email,
    subject: "Verify your email — TAC Bookings",
    html: emailVerificationTemplate(firstName, verifyUrl),
    templateName: "email-verification",
  });
}

export async function sendEmailChangeVerification(newEmail: string, token: string) {
  const baseUrl = process.env.NEXTAUTH_URL || "http://localhost:3000";
  const verifyUrl = `${baseUrl}/confirm-email-change?token=${token}`;

  await sendEmail({
    to: newEmail,
    subject: "Confirm your new email — TAC Bookings",
    html: emailChangeVerificationTemplate(newEmail, verifyUrl),
    templateName: "email-change-verification",
  });
}

export async function sendEmailChangeNotification(oldEmail: string, newEmail: string) {
  await sendEmail({
    to: oldEmail,
    subject: "Email change requested — TAC Bookings",
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
    subject: "Check-in Reminder - TAC Lodge",
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
}) {
  await sendToAdmins({
    subject: `New Booking: ${data.memberName} (${data.status})`,
    html: adminNewBookingTemplate(data),
    templateName: "admin-new-booking",
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
    subject: "Payment Failed - TAC Bookings",
    html: adminPaymentFailureTemplate(data),
    templateName: "admin-payment-failure",
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
    subject: "Xero Sync Error - TAC Bookings",
    html: adminXeroSyncErrorTemplate(data),
    templateName: "admin-xero-sync-error",
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
    subject: `${inviterName} invited you to join ${groupName} — TAC Bookings`,
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
    subject: `${inviteeName} has joined ${groupName} — TAC Bookings`,
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
    subject: "Child/Youth request submitted — TAC Bookings",
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
    subject: `${childName} has been added to ${groupName} — TAC Bookings`,
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
    subject: "Child/Youth request update — TAC Bookings",
    html: childRequestRejectedTemplate(parentName, childName, reason),
    templateName: "child-request-rejected",
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
    subject: "You're 18! Set up your TAC Bookings account",
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
    subject: "Booking Modified - TAC Lodge",
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
    subject: "Card Setup Failed - TAC Lodge Booking",
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
    subject: "Waitlist Confirmation - TAC Lodge",
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
    subject: "Spot Available! - TAC Lodge",
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
    subject: "Waitlist Offer Expired - TAC Lodge",
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
  });
}
