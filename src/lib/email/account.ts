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
  composeOptionalEmailLine,
} from "../email-message-notes";
import {
  CLUB_BOOKINGS_NAME,
  CLUB_NAME,
} from "@/config/club-identity";
import { MEMBER_SETUP_INVITE_TTL_DAYS } from "../member-setup-invite";
import {
  EMAIL_CHANGE_TTL_MS,
  EMAIL_VERIFICATION_TTL_MS,
} from "@/lib/verification-tokens";
import { sendEmail } from "./core";
import { renderEmailHtml } from "@/lib/email-theme";
import { emailClubDateTime } from "@/lib/email-templates-club-time";

export async function sendPasswordResetEmail(email: string, token: string) {
  const baseUrl = process.env.NEXTAUTH_URL || "http://localhost:3000";
  const resetUrl = `${baseUrl}/reset-password?token=${token}`;

  await sendEmail({
    to: email,
    subject: `Reset your ${CLUB_NAME} password`,
    html: await renderEmailHtml(() => passwordResetTemplate(resetUrl)),
    // Account/security mail is never booking-scoped, and must NEVER be
    // suppressible by a booking flag (#2258): withholding a two-factor code,
    // password reset, magic link or email-change notice is account lockout.
    bookingContext: "none",
    templateName: "password-reset",
    templateData: { token, resetUrl },
  });
}

export async function sendMagicLinkEmail(email: string, token: string) {
  const baseUrl = process.env.NEXTAUTH_URL || "http://localhost:3000";
  const loginUrl = `${baseUrl}/login/magic?token=${token}`;

  await sendEmail({
    to: email,
    subject: `Your ${CLUB_NAME} sign-in link`,
    html: await renderEmailHtml(() => magicLinkLoginTemplate(loginUrl)),
    // Account/security mail is never booking-scoped, and must NEVER be
    // suppressible by a booking flag (#2258): withholding a two-factor code,
    // password reset, magic link or email-change notice is account lockout.
    bookingContext: "none",
    templateName: "magic-link-login",
    templateData: { token, loginUrl },
  });
}

export async function sendAdminPasswordResetEmail(
  email: string,
  token: string,
  expiryLabel = "1 hour",
) {
  const baseUrl = process.env.NEXTAUTH_URL || "http://localhost:3000";
  const resetUrl = `${baseUrl}/reset-password?token=${token}`;

  await sendEmail({
    to: email,
    subject: `Reset your ${CLUB_NAME} password`,
    html: await renderEmailHtml(() => adminPasswordResetTemplate(resetUrl, expiryLabel)),
    // Account/security mail is never booking-scoped, and must NEVER be
    // suppressible by a booking flag (#2258): withholding a two-factor code,
    // password reset, magic link or email-change notice is account lockout.
    bookingContext: "none",
    templateName: "admin-password-reset",
    templateData: { token, resetUrl, expiryLabel },
  });
}

export async function sendMemberSetupInviteEmail(
  email: string,
  firstName: string,
  token: string,
) {
  const baseUrl = process.env.NEXTAUTH_URL || "http://localhost:3000";
  const resetUrl = `${baseUrl}/reset-password?token=${token}`;

  await sendEmail({
    to: email,
    subject: `Set up your ${CLUB_NAME} account (${MEMBER_SETUP_INVITE_TTL_DAYS}-day link)`,
    html: await renderEmailHtml(() => memberSetupInviteTemplate(firstName, resetUrl)),
    // Account/security mail is never booking-scoped, and must NEVER be
    // suppressible by a booking flag (#2258): withholding a two-factor code,
    // password reset, magic link or email-change notice is account lockout.
    bookingContext: "none",
    templateName: "member-setup-invite",
    templateData: {
      firstName,
      token,
      resetUrl,
      expiryLabel: `${MEMBER_SETUP_INVITE_TTL_DAYS} days`,
    },
  });
}

export async function sendTwoFactorCodeEmail(params: {
  email: string;
  firstName: string;
  code: string;
  expiresAt: Date;
}) {
  await sendEmail({
    to: params.email,
    subject: `Your ${CLUB_NAME} two-factor code`,
    html: await renderEmailHtml(() => twoFactorCodeTemplate(params)),
    // Account/security mail is never booking-scoped, and must NEVER be
    // suppressible by a booking flag (#2258): withholding a two-factor code,
    // password reset, magic link or email-change notice is account lockout.
    bookingContext: "none",
    templateName: "two-factor-code",
    templateData: {
      firstName: params.firstName,
      code: params.code,
      expiresAt: emailClubDateTime(params.expiresAt),
    },
  });
}

export async function sendVerificationEmail(
  email: string,
  firstName: string,
  token: string,
) {
  const baseUrl = process.env.NEXTAUTH_URL || "http://localhost:3000";
  const verifyUrl = `${baseUrl}/verify-email?token=${token}`;
  const expiresAt = new Date(Date.now() + EMAIL_VERIFICATION_TTL_MS);

  await sendEmail({
    to: email,
    subject: `Verify your email — ${CLUB_BOOKINGS_NAME}`,
    html: await renderEmailHtml(() => emailVerificationTemplate(firstName, verifyUrl, expiresAt)),
    // Account/security mail is never booking-scoped, and must NEVER be
    // suppressible by a booking flag (#2258): withholding a two-factor code,
    // password reset, magic link or email-change notice is account lockout.
    bookingContext: "none",
    templateName: "email-verification",
    templateData: {
      firstName,
      token,
      verifyUrl,
      expiresAt: emailClubDateTime(expiresAt),
    },
  });
}

export async function sendEmailChangeVerification(
  newEmail: string,
  token: string,
) {
  const baseUrl = process.env.NEXTAUTH_URL || "http://localhost:3000";
  const verifyUrl = `${baseUrl}/confirm-email-change?token=${token}`;
  const expiresAt = new Date(Date.now() + EMAIL_CHANGE_TTL_MS);

  await sendEmail({
    to: newEmail,
    subject: `Confirm your new email — ${CLUB_BOOKINGS_NAME}`,
    html: await renderEmailHtml(() => emailChangeVerificationTemplate(newEmail, verifyUrl, expiresAt)),
    // Account/security mail is never booking-scoped, and must NEVER be
    // suppressible by a booking flag (#2258): withholding a two-factor code,
    // password reset, magic link or email-change notice is account lockout.
    bookingContext: "none",
    templateName: "email-change-verification",
    templateData: {
      newEmail,
      token,
      verifyUrl,
      expiresAt: emailClubDateTime(expiresAt),
    },
  });
}

export async function sendEmailChangeNotification(
  oldEmail: string,
  newEmail: string,
) {
  await sendEmail({
    to: oldEmail,
    subject: `Email change requested — ${CLUB_BOOKINGS_NAME}`,
    html: await renderEmailHtml(() => emailChangeNotificationTemplate(newEmail)),
    // Account/security mail is never booking-scoped, and must NEVER be
    // suppressible by a booking flag (#2258): withholding a two-factor code,
    // password reset, magic link or email-change notice is account lockout.
    bookingContext: "none",
    templateName: "email-change-notification",
    templateData: { newEmail },
  });
}

// F-COMP-04: Account deletion approved
export async function sendAccountDeletionApprovedEmail(
  email: string,
  firstName: string,
) {
  await sendEmail({
    to: email,
    subject: "Your Account Deletion Request Has Been Processed",
    html: await renderEmailHtml(() => accountDeletionApprovedTemplate(firstName)),
    // Account/security mail is never booking-scoped, and must NEVER be
    // suppressible by a booking flag (#2258): withholding a two-factor code,
    // password reset, magic link or email-change notice is account lockout.
    bookingContext: "none",
    templateName: "account-deletion-approved",
    templateData: { firstName },
  });
}

// F-COMP-04: Account deletion rejected
export async function sendAccountDeletionRejectedEmail(
  email: string,
  firstName: string,
  adminNote: string,
) {
  await sendEmail({
    to: email,
    subject: "Update on Your Account Deletion Request",
    html: await renderEmailHtml(() => accountDeletionRejectedTemplate(firstName, adminNote)),
    // Account/security mail is never booking-scoped, and must NEVER be
    // suppressible by a booking flag (#2258): withholding a two-factor code,
    // password reset, magic link or email-change notice is account lockout.
    bookingContext: "none",
    templateName: "account-deletion-rejected",
    templateData: {
      firstName,
      adminNote,
      // #2268: pre-composed optional line — an empty note must not leave a
      // dangling "Admin note:" in the flat body.
      adminNoteLine: composeOptionalEmailLine("Admin note", adminNote),
    },
  });
}
