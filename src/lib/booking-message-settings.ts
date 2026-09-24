import type { BookingMessageOverride } from "@prisma/client";
import {
  BOOKING_MESSAGE_DEFINITIONS,
  BOOKING_MESSAGE_DEFINITION_BY_KEY,
  getDefaultBookingMessages,
  type BookingMessageClubTokens,
  type BookingMessageKey,
  type BookingMessageMergeData,
} from "@/lib/booking-message-definitions";
import {
  buildEmailTemplateGlobalData,
  loadEmailMessageSettings,
} from "@/lib/email-message-settings";
import { loadInternetBankingPaymentSettings } from "@/lib/internet-banking-settings";
import { formatCents } from "@/lib/utils";
import { prisma } from "@/lib/prisma";
import { clubFormatValues } from "@/lib/club-format-server";

export interface EffectiveBookingMessage {
  key: BookingMessageKey;
  section: string;
  label: string;
  description: string;
  defaultBody: string;
  bodyText: string;
  tokens: readonly string[];
  override: {
    bodyText: string;
    updatedAt: string;
    updatedByMemberId: string | null;
  } | null;
}

export type EffectiveBookingMessageMap = Record<BookingMessageKey, string>;

function serializeOverride(override: BookingMessageOverride | null | undefined) {
  if (!override) return null;
  return {
    bodyText: override.bodyText,
    updatedAt: override.updatedAt.toISOString(),
    updatedByMemberId: override.updatedByMemberId,
  };
}

async function loadBookingMessageOverrides() {
  return prisma.bookingMessageOverride.findMany();
}

export async function loadEffectiveBookingMessages(): Promise<EffectiveBookingMessage[]> {
  const overrides = await loadBookingMessageOverrides();
  const overrideByKey = new Map(overrides.map((override) => [override.messageKey, override]));

  return BOOKING_MESSAGE_DEFINITIONS.map((definition) => {
    const override = overrideByKey.get(definition.key);
    return {
      ...definition,
      bodyText: override?.bodyText ?? definition.defaultBody,
      override: serializeOverride(override),
    };
  });
}

async function loadEffectiveBookingMessageMap(): Promise<EffectiveBookingMessageMap> {
  const defaults = getDefaultBookingMessages();
  const overrides = await loadBookingMessageOverrides();

  for (const override of overrides) {
    if (BOOKING_MESSAGE_DEFINITION_BY_KEY.has(override.messageKey as BookingMessageKey)) {
      defaults[override.messageKey as BookingMessageKey] = override.bodyText;
    }
  }

  return defaults;
}

export async function loadPublicBookingMessages(): Promise<EffectiveBookingMessageMap> {
  return loadEffectiveBookingMessageMap();
}

/**
 * The four club-level token values every booking message may insert.
 *
 * Exported for `/api/booking-messages` (#2919 review): the client surfaces that
 * fetch message bodies substitute their tokens from exactly this, so a member
 * reads what the admin preview showed instead of literal `{{braces}}`. Of the
 * four, only `CLUB_LODGE_NAME` varies by lodge — a surface that knows its own
 * lodge overrides that one value and needs no lodge-scoped resolve of its own.
 */
export async function buildBookingMessageGlobalData(): Promise<BookingMessageClubTokens> {
  const settings = await loadEmailMessageSettings();
  const emailData = buildEmailTemplateGlobalData(settings);

  return {
    CLUB_NAME: emailData.CLUB_NAME,
    CLUB_LODGE_NAME: emailData.CLUB_LODGE_NAME,
    BASE_URL: emailData.BASE_URL,
    SUPPORT_EMAIL: emailData.SUPPORT_EMAIL,
  };
}

export async function buildSampleBookingMessageData(): Promise<BookingMessageMergeData> {
  // The club's format (#3565), resolved once, before any transaction or
  // lock below — never per amount and never inside a transaction.
  const format = await clubFormatValues();
  const [globalData, internetBankingSettings] = await Promise.all([
    buildBookingMessageGlobalData(),
    loadInternetBankingPaymentSettings(),
  ]);

  return {
    ...globalData,
    bookerFirstName: "Sam",
    bookerFullName: "Sam Member",
    checkIn: "Friday 24 July 2026",
    checkOut: "Sunday 26 July 2026",
    guestCount: "3 guests",
    amountDue: formatCents(45000, format),
    amountPaid: formatCents(45000, format),
    refundAmount: formatCents(15000, format),
    creditAmount: formatCents(15000, format),
    creditRestored: formatCents(5000, format),
    retainedAmount: formatCents(30000, format),
    changeFee: formatCents(2500, format),
    paymentReference: "BOOK-ABC123",
    xeroInvoiceNumber: "INV-1234",
    holdUntil: "5:00 PM, 27 July 2026",
    holdDays: internetBankingSettings.holdDays,
    minimumDaysBeforeCheckIn: internetBankingSettings.minimumDaysBeforeCheckIn,
    bookingStatus: "Payment pending",
  };
}
