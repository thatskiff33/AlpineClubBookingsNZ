import { clubConfig } from "@/config/club";
import type { ClubIdentity } from "@/config/club-identity-types";

export const CLUB_NAME = clubConfig.name;
export const CLUB_SHORT_NAME = clubConfig.shortName ?? clubConfig.name;
export const CLUB_SUPPORT_EMAIL = clubConfig.supportEmail;
export const CLUB_CONTACT_EMAIL = clubConfig.contactEmail ?? clubConfig.supportEmail;
export const CLUB_PUBLIC_URL = clubConfig.publicUrl;
export const CLUB_EMAIL_FROM_NAME = clubConfig.emailFromName;
export const CLUB_BOOKINGS_NAME = `${clubConfig.name} - Bookings`;
export const CLUB_LODGE_NAME = `${clubConfig.name} Lodge`;
export const CLUB_PUBLIC_HOST = new URL(clubConfig.publicUrl).host;
export const CLUB_EMAIL_DOMAIN = CLUB_PUBLIC_HOST.replace(/^www\./, "");

export const clubIdentity: ClubIdentity = {
  name: CLUB_NAME,
  shortName: CLUB_SHORT_NAME,
  supportEmail: CLUB_SUPPORT_EMAIL,
  contactEmail: CLUB_CONTACT_EMAIL,
  publicUrl: CLUB_PUBLIC_URL,
  emailFromName: CLUB_EMAIL_FROM_NAME,
  bookingsName: CLUB_BOOKINGS_NAME,
  lodgeName: CLUB_LODGE_NAME,
  publicHost: CLUB_PUBLIC_HOST,
};

export function clubDomainEmail(localPart: string): string {
  return `${localPart}@${CLUB_EMAIL_DOMAIN}`;
}
