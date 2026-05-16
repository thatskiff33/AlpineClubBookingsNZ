import {
  CLUB_EMAIL_FROM_NAME,
  CLUB_SUPPORT_EMAIL,
} from "@/config/club-identity";

export const EMAIL_FROM = process.env.EMAIL_FROM || CLUB_SUPPORT_EMAIL;
export const SUPPORT_EMAIL = process.env.SUPPORT_EMAIL || CLUB_SUPPORT_EMAIL;
export const EMAIL_FROM_NAME =
  process.env.EMAIL_FROM_NAME || CLUB_EMAIL_FROM_NAME;

export function formatEmailFromAddress(fromAddress = EMAIL_FROM): string {
  return `"${EMAIL_FROM_NAME}" <${fromAddress}>`;
}
