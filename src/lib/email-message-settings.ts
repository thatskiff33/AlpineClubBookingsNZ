import { clubConfig } from "@/config/club";
import { escapeHtml } from "@/lib/email-templates";
import { prisma } from "@/lib/prisma";

export const EMAIL_MESSAGE_SETTINGS_ID = "default";
const FALLBACK_PUBLIC_URL = "http://localhost:3000";

export interface EmailMessageSettings {
  clubName: string;
  bookingsName: string;
  lodgeName: string;
  emailFromName: string;
  supportEmail: string;
  contactEmail: string;
  publicUrl: string;
  lodgeTravelNote: string;
  doorCode: string | null;
}

export interface PersistedEmailMessageSettings {
  clubName: string | null;
  bookingsName: string | null;
  lodgeName: string | null;
  emailFromName: string | null;
  supportEmail: string | null;
  contactEmail: string | null;
  publicUrl: string | null;
  lodgeTravelNote: string | null;
  doorCode: string | null;
  updatedAt?: Date | string | null;
  updatedByMemberId?: string | null;
}

function trimOptional(value: string | null | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}

export function normalizeEmailMessagePublicUrl(
  value: string | null | undefined,
): string | null {
  const trimmed = trimOptional(value);
  if (!trimmed) return null;

  try {
    const parsed = new URL(trimmed);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      return null;
    }
  } catch {
    return null;
  }

  return trimmed.replace(/\/+$/, "");
}

export function getDefaultEmailMessageSettings(): EmailMessageSettings {
  const clubName = clubConfig.name;
  const publicUrl =
    normalizeEmailMessagePublicUrl(process.env.NEXTAUTH_URL) ??
    normalizeEmailMessagePublicUrl(clubConfig.publicUrl) ??
    FALLBACK_PUBLIC_URL;
  return {
    clubName,
    bookingsName: `${clubName} - Bookings`,
    lodgeName: `${clubName} Lodge`,
    emailFromName: clubConfig.emailFromName,
    supportEmail: clubConfig.supportEmail,
    contactEmail: clubConfig.contactEmail ?? clubConfig.supportEmail,
    publicUrl,
    lodgeTravelNote:
      clubConfig.lodgeTravelNote ?? "Please allow adequate travel time.",
    doorCode: null,
  };
}

export function normalizeEmailMessageSettings(
  persisted?: Partial<PersistedEmailMessageSettings> | null,
): EmailMessageSettings {
  const defaults = getDefaultEmailMessageSettings();
  return {
    clubName: trimOptional(persisted?.clubName) ?? defaults.clubName,
    bookingsName: trimOptional(persisted?.bookingsName) ?? defaults.bookingsName,
    lodgeName: trimOptional(persisted?.lodgeName) ?? defaults.lodgeName,
    emailFromName:
      trimOptional(persisted?.emailFromName) ?? defaults.emailFromName,
    supportEmail: trimOptional(persisted?.supportEmail) ?? defaults.supportEmail,
    contactEmail: trimOptional(persisted?.contactEmail) ?? defaults.contactEmail,
    publicUrl:
      normalizeEmailMessagePublicUrl(persisted?.publicUrl) ?? defaults.publicUrl,
    lodgeTravelNote:
      trimOptional(persisted?.lodgeTravelNote) ?? defaults.lodgeTravelNote,
    doorCode: trimOptional(persisted?.doorCode) ?? null,
  };
}

export async function loadPersistedEmailMessageSettings(): Promise<
  PersistedEmailMessageSettings | null
> {
  const delegate = (prisma as unknown as {
    emailMessageSetting?: {
      findUnique: (args: unknown) => Promise<PersistedEmailMessageSettings | null>;
    };
  }).emailMessageSetting;

  if (!delegate) return null;

  try {
    return await delegate.findUnique({
      where: { id: EMAIL_MESSAGE_SETTINGS_ID },
    });
  } catch {
    return null;
  }
}

export async function loadEmailMessageSettings(): Promise<EmailMessageSettings> {
  return normalizeEmailMessageSettings(await loadPersistedEmailMessageSettings());
}

export function buildEmailTemplateGlobalData(settings: EmailMessageSettings) {
  return {
    CLUB_NAME: settings.clubName,
    CLUB_BOOKINGS_NAME: settings.bookingsName,
    CLUB_LODGE_NAME: settings.lodgeName,
    CLUB_EMAIL_FROM_NAME: settings.emailFromName,
    SUPPORT_EMAIL: settings.supportEmail,
    CONTACT_EMAIL: settings.contactEmail,
    BASE_URL: settings.publicUrl,
    CLUB_LODGE_TRAVEL_NOTE: settings.lodgeTravelNote,
  };
}

function replaceAll(value: string, search: string, replacement: string): string {
  if (!search || search === replacement) return value;
  return value.split(search).join(replacement);
}

export function applyEmailMessageSettingsToSubject(
  subject: string,
  settings: EmailMessageSettings,
): string {
  const defaults = getDefaultEmailMessageSettings();
  const replacements: Array<[string | undefined, string]> = [
    [defaults.clubName, settings.clubName],
    [defaults.bookingsName, settings.bookingsName],
    [defaults.lodgeName, settings.lodgeName],
    [defaults.emailFromName, settings.emailFromName],
    [process.env.EMAIL_FROM_NAME, settings.emailFromName],
    [defaults.supportEmail, settings.supportEmail],
    [process.env.SUPPORT_EMAIL, settings.supportEmail],
    [defaults.contactEmail, settings.contactEmail],
    [process.env.CONTACT_EMAIL, settings.contactEmail],
    [defaults.publicUrl, settings.publicUrl],
    [process.env.NEXTAUTH_URL?.replace(/\/+$/, ""), settings.publicUrl],
    [defaults.lodgeTravelNote, settings.lodgeTravelNote],
  ];

  return replacements.reduce(
    (current, [search, replacement]) =>
      replaceAll(current, search ?? "", replacement),
    subject,
  );
}

export function applyEmailMessageSettingsToHtml(
  html: string,
  settings: EmailMessageSettings,
): string {
  const defaults = getDefaultEmailMessageSettings();
  const replacements: Array<[string | undefined, string]> = [
    [defaults.clubName, settings.clubName],
    [defaults.bookingsName, settings.bookingsName],
    [defaults.lodgeName, settings.lodgeName],
    [defaults.emailFromName, settings.emailFromName],
    [process.env.EMAIL_FROM_NAME, settings.emailFromName],
    [defaults.supportEmail, settings.supportEmail],
    [process.env.SUPPORT_EMAIL, settings.supportEmail],
    [defaults.contactEmail, settings.contactEmail],
    [process.env.CONTACT_EMAIL, settings.contactEmail],
    [defaults.publicUrl, settings.publicUrl],
    [process.env.NEXTAUTH_URL?.replace(/\/+$/, ""), settings.publicUrl],
    [defaults.lodgeTravelNote, settings.lodgeTravelNote],
  ];

  return replacements.reduce(
    (current, [search, replacement]) =>
      replaceAll(current, escapeHtml(search ?? ""), escapeHtml(replacement)),
    html,
  );
}

export function formatEmailFromAddressWithSettings(
  settings: EmailMessageSettings,
  fromAddress?: string,
): string {
  const address = fromAddress || process.env.EMAIL_FROM || settings.supportEmail;
  const fromName = settings.emailFromName.replace(/[\r\n]+/g, " ").trim();
  return `"${fromName.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}" <${address}>`;
}
