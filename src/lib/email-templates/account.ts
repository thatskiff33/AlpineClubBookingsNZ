/**
 * Account and sign-in emails: passwords, magic links, email verification and
 * account-deletion outcomes.
 *
 * The family boundary is `src/lib/email/account.ts`, the sender module that
 * ships every message in here.
 */
import { escapeHtml } from "./escape";
import {
  alertBox,
  button,
  heading,
  layout,
  muted,
  paragraph,
  supportContactMuted,
} from "./layout";
import { CLUB_NAME } from "@/config/club-identity";
import { MEMBER_SETUP_INVITE_TTL_DAYS } from "@/lib/member-setup-invite";
import { emailClubDateTime } from "@/lib/email-templates-club-time";

export function passwordResetTemplate(resetUrl: string): string {
  return layout(`
    ${heading("Password Reset")}
    ${paragraph(`You requested a password reset for your ${escapeHtml(CLUB_NAME)} booking account.`)}
    ${paragraph("Click the button below to set a new password. This link expires in <strong>1 hour</strong>.")}
    ${button("Reset Password", resetUrl)}
    ${muted("If you didn't request this, you can safely ignore this email. Your password will remain unchanged.")}
  `);
}

export function magicLinkLoginTemplate(loginUrl: string): string {
  return layout(`
    ${heading("Sign In")}
    ${paragraph(`You asked to sign in to your ${escapeHtml(CLUB_NAME)} booking account with an email link.`)}
    ${paragraph("Click the button below to sign in. This link can be used once and expires shortly.")}
    ${button("Sign In", loginUrl)}
    ${muted("If you didn't request this, you can safely ignore this email — your account stays secure and you can still sign in with your password.")}
  `);
}

export function adminPasswordResetTemplate(
  resetUrl: string,
  expiryLabel = "1 hour"
): string {
  return layout(`
    ${heading("Password Reset")}
    ${paragraph(`An administrator has requested a password reset for your ${escapeHtml(CLUB_NAME)} booking account.`)}
    ${paragraph("Click the button below to set a new password. This link expires in <strong>" + escapeHtml(expiryLabel) + "</strong>.")}
    ${button("Reset Password", resetUrl)}
    ${muted("If you believe this was sent in error, please contact the club administrator.")}
  `);
}

export function memberSetupInviteTemplate(
  firstName: string,
  resetUrl: string
): string {
  return layout(`
    ${heading("Set Up Your Account")}
    ${paragraph("Hi " + escapeHtml(firstName) + ",")}
    ${paragraph(`An administrator has created your ${escapeHtml(CLUB_NAME)} booking account.`)}
    ${paragraph(
      "Use the button below to set your password and activate your login. This link expires in <strong>" +
        String(MEMBER_SETUP_INVITE_TTL_DAYS) +
        " days</strong>."
    )}
    ${button("Set Up My Password", resetUrl)}
    ${muted("If you were not expecting this invite, you can safely ignore it or contact the club.")}
  `);
}

export function twoFactorCodeTemplate(params: {
  firstName: string;
  code: string;
  expiresAt: Date;
}): string {
  return layout(`
    ${heading("Two-factor code")}
    ${paragraph("Hi " + escapeHtml(params.firstName) + ",")}
    ${paragraph(`Use this code to finish signing in to your ${escapeHtml(CLUB_NAME)} booking account:`)}
    ${paragraph(
      `<strong style="display: inline-block; font-size: 28px; letter-spacing: 0.16em; padding: 8px 0;">${escapeHtml(params.code)}</strong>`,
    )}
    ${muted("This code expires on " + escapeHtml(emailClubDateTime(params.expiresAt)) + ". If you did not try to sign in, change your password and contact the club.")}
  `);
}

export function emailVerificationTemplate(
  firstName: string,
  verifyUrl: string,
  expiresAt: Date
): string {
  const name = escapeHtml(firstName);
  return layout(`
    ${heading("Verify Your Email")}
    ${paragraph(`Hi ${name}, thanks for creating your ${escapeHtml(CLUB_NAME)} booking account!`)}
    ${paragraph("Please verify your email address by clicking the button below.")}
    ${button("Verify Email", verifyUrl)}
    ${muted("This link expires on " + escapeHtml(emailClubDateTime(expiresAt)) + ". If you did not create this account, please ignore this email.")}
  `);
}

export function emailChangeVerificationTemplate(
  newEmail: string,
  verifyUrl: string,
  expiresAt: Date
): string {
  return layout(`
    ${heading("Confirm Your New Email")}
    ${paragraph(`You requested to change the email address on your ${escapeHtml(CLUB_NAME)} account to <strong>${escapeHtml(newEmail)}</strong>.`)}
    ${paragraph("Click the button below to confirm this change.")}
    ${button("Confirm Email Change", verifyUrl)}
    ${muted("This link expires on " + escapeHtml(emailClubDateTime(expiresAt)) + ". If you did not request this change, please ignore this email.")}
  `);
}

export function emailChangeNotificationTemplate(newEmail: string): string {
  return layout(`
    ${heading("Email Change Requested")}
    ${paragraph(`Someone requested to change the email address on your ${escapeHtml(CLUB_NAME)} account to <strong>${escapeHtml(newEmail)}</strong>.`)}
    ${alertBox("If this wasn't you, please contact the club immediately.", "warning")}
    ${muted("If you made this request, you can safely ignore this email. The change will only take effect after verification.")}
  `);
}

/** F-COMP-04: Account deletion approved — sent before anonymisation */
export function accountDeletionApprovedTemplate(firstName: string): string {
  return layout(`
    ${heading("Account Deletion Confirmed")}
    ${paragraph("Hi " + escapeHtml(firstName) + ",")}
    ${paragraph("We have processed your account deletion request. Your personal data has been anonymised in accordance with our Privacy Policy.")}
    ${alertBox("Your account is now deactivated and you will no longer be able to log in. Booking history has been retained for financial and audit purposes with your personal details removed.", "info")}
    ${paragraph("If you have any questions, please contact the club.")}
    ${supportContactMuted()}
  `);
}

/** F-COMP-04: Account deletion rejected — sent to member with admin note */
export function accountDeletionRejectedTemplate(
  firstName: string,
  adminNote: string
): string {
  const noteHtml = adminNote
    ? `${alertBox("Admin note: " + escapeHtml(adminNote), "warning")}`
    : "";
  return layout(`
    ${heading("Account Deletion Request Update")}
    ${paragraph("Hi " + escapeHtml(firstName) + ",")}
    ${paragraph("Your account deletion request has been reviewed and was not approved at this time.")}
    ${noteHtml}
    ${paragraph("If you have questions about this decision, please contact the club directly.")}
    ${supportContactMuted()}
  `);
}
